// KeyCRM: https://docs.keycrm.app/
import { describeDelivery } from './message.js';

const BASE_URL = 'https://openapi.keycrm.app/v1';

const absoluteUrl = (url) => (url && url.startsWith('//') ? `https:${url}` : url || undefined);

// Доставка Новою поштою для замовлення KeyCRM: службу, місто, відділення/поштомат або адресу кур'єра
function buildShipping(d, deliveryServiceId) {
  const dl = d.delivery;
  const shipping = {};
  if (d.city) shipping.shipping_address_city = d.city;
  if (!dl) return Object.keys(shipping).length ? shipping : undefined;

  if (dl.city?.area) shipping.shipping_address_region = dl.city.area;
  if (dl.method) {
    shipping.shipping_service = 'Нова пошта';
    if (deliveryServiceId) shipping.delivery_service_id = deliveryServiceId;
    shipping.recipient_full_name = d.name;
    shipping.recipient_phone = d.phone;
  }
  if ((dl.method === 'warehouse' || dl.method === 'postomat') && dl.point?.name) {
    shipping.shipping_receive_point = dl.point.name;
    if (dl.point.ref) shipping.warehouse_ref = dl.point.ref;
  }
  if (dl.method === 'courier') {
    const address = [dl.street?.name, dl.house && `буд. ${dl.house}`, dl.apartment && `кв. ${dl.apartment}`]
      .filter(Boolean).join(', ');
    if (address) shipping.shipping_secondary_line = address;
  }
  return Object.keys(shipping).length ? shipping : undefined;
}

export function buildCrmOrder(order, { sourceId, deliveryServiceId = 0 }) {
  const d = order.data;
  const marketing = {};
  if (d.utm?.source) marketing.utm_source = d.utm.source;
  if (d.utm?.medium) marketing.utm_medium = d.utm.medium;
  if (d.utm?.campaign) marketing.utm_campaign = d.utm.campaign;
  if (d.utm?.content) marketing.utm_content = d.utm.content;
  if (d.utm?.term) marketing.utm_term = d.utm.term;

  const payload = {
    source_id: sourceId,
    source_uuid: `quick-${order.order_number}`,
    buyer_comment: d.comment || undefined,
    manager_comment: [
      `${d.kind === 'custom' ? 'Заявка «Свій принт»' : 'Швидке замовлення'} #${order.order_number}${d.afterHours ? ' (поза робочим часом)' : ''}. Сторінка: ${d.productUrl}`,
      // Доставку дублюємо текстом: вона лишається видимою, навіть якщо KeyCRM не прийме поля доставки
      ...describeDelivery(d.delivery),
      ...(d.body ? [`Зріст ${d.body.height} см, вага ${d.body.weight} кг (підбір розміру)`] : []),
    ].join('\n'),
    buyer: { full_name: [d.name, d.surname].filter(Boolean).join(' '), phone: d.phone },
    products: [{
      sku: d.sku || undefined,
      name: d.productTitle,
      price: d.unitCents / 100,
      quantity: d.quantity,
      picture: absoluteUrl(d.picture),
      properties: d.options.map((o) => ({ name: o.name, value: o.value })),
    }],
  };
  const shipping = buildShipping(d, deliveryServiceId);
  if (shipping) payload.shipping = shipping;
  if (Object.keys(marketing).length) payload.marketing = marketing;
  return payload;
}

export function createKeycrm({ token, sourceId, statusMap = {}, deliveryServiceId = 0, fetchFn }) {
  async function call(method, path, body) {
    const res = await fetchFn(`${BASE_URL}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { /* не JSON */ }
    if (!res.ok) {
      // У помилку потрапляє відповідь KeyCRM (корисна для діагностики), а не токен
      const error = new Error(`KeyCRM ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
      error.status = res.status;
      throw error;
    }
    return data;
  }

  return {
    sourceId,
    statusMap,
    // Замовлення вже могло бути створене (відповідь загубилась, перезапуск посеред відправки): шукаємо за source_uuid
    async findOrderId(sourceUuid) {
      const query = new URLSearchParams({ 'filter[source_uuid]': sourceUuid, limit: '1' });
      const data = await call('GET', `/order?${query}`);
      return data?.data?.[0]?.id ?? null;
    },
    // Чи є вже в замовленні платіж із такою ознакою в описі (захист від подвійного платежу)
    async hasPayment(crmOrderId, marker) {
      const data = await call('GET', `/order/${crmOrderId}?include=payments`);
      return (data?.payments || []).some((p) => String(p.description || '').includes(marker));
    },
    // sourceId: джерело магазину, з якого прийшло замовлення (за замовчуванням — основне)
    async createOrder(order, { sourceId: orderSourceId } = {}) {
      const existing = await this.findOrderId(`quick-${order.order_number}`);
      if (existing) return existing;
      const payload = buildCrmOrder(order, { sourceId: orderSourceId || sourceId, deliveryServiceId });
      let data;
      try {
        data = await call('POST', '/order', payload);
      } catch (err) {
        // Якщо KeyCRM не прийняв поля доставки (422), створюємо замовлення без них:
        // доставка все одно лишається у коментарі менеджера, і замовлення не загубиться
        if (err.status !== 422 || !payload.shipping) throw err;
        const { shipping, ...withoutShipping } = payload;
        data = await call('POST', '/order', {
          ...withoutShipping,
          shipping: shipping.shipping_address_city ? { shipping_address_city: shipping.shipping_address_city } : undefined,
        });
      }
      if (!data.id) throw new Error('KeyCRM не повернув id замовлення');
      return data.id;
    },
    // Фіксує оплату в замовленні (наприклад, передоплату через Monobank)
    async addPayment(crmOrderId, { methodId, amountUah, description }) {
      await call('POST', `/order/${crmOrderId}/payment`, {
        payment_method_id: methodId,
        amount: amountUah,
        status: 'paid',
        description,
      });
    },
    // Стан замовлення для зарахування покупки: статус, сума, отримані оплати, ТТН.
    // Менеджер міг додати оплату чи ТТН вручну в KeyCRM, тому сервер дивиться й туди.
    async getOrderState(crmOrderId) {
      const data = await call('GET', `/order/${crmOrderId}?include=payments,shipping`);
      const payments = Array.isArray(data?.payments) ? data.payments : [];
      const paidUah = payments
        .filter((p) => String(p.status || '').toLowerCase() === 'paid')
        .reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
      return {
        statusId: Number(data?.status_id) || 0,
        statusGroupId: Number(data?.status_group_id) || 0,
        grandTotalUah: Number(data?.grand_total) || 0,
        // Якщо список оплат не прийшов, спираємось на загальну суму оплат замовлення
        paidUah: paidUah || (payments.length ? 0 : Number(data?.payments_total) || 0),
        trackingCode: String(data?.shipping?.tracking_code || '').trim(),
      };
    },
    // Сторінка замовлень за період створення: одного джерела (покупки з Instagram Direct тощо) або всіх, якщо sourceId не задано
    async listOrders({ sourceId, from, to, page = 1 }) {
      const query = new URLSearchParams({
        ...(sourceId ? { 'filter[source_id]': String(sourceId) } : {}),
        'filter[created_between]': `${from}, ${to}`,
        include: 'payments,shipping,buyer,tags,products',
        limit: '50',
        page: String(page),
      });
      const data = await call('GET', `/order?${query}`);
      return {
        orders: Array.isArray(data?.data) ? data.data : [],
        hasMore: Boolean(data?.next_page_url) || (Number(data?.current_page) < Number(data?.last_page)),
      };
    },
    // Записує номер ТТН у замовлення KeyCRM
    async setTrackingCode(crmOrderId, code) {
      await call('PUT', `/order/${crmOrderId}`, { shipping: { tracking_code: code } });
    },
    // Переводить замовлення в статус KeyCRM за його id
    async setStatusId(crmOrderId, statusId) {
      await call('PUT', `/order/${crmOrderId}`, { status_id: statusId });
    },
    // Повертає false, якщо для цього статусу не налаштовано відповідника в KeyCRM
    async updateStatus(crmOrderId, status) {
      const statusId = statusMap[status];
      if (!statusId) return false;
      await call('PUT', `/order/${crmOrderId}`, { status_id: statusId });
      return true;
    },
  };
}
