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
      `Швидке замовлення #${order.order_number}${d.afterHours ? ' (поза робочим часом)' : ''}. Сторінка: ${d.productUrl}`,
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
      body: JSON.stringify(body),
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
    async createOrder(order) {
      const payload = buildCrmOrder(order, { sourceId, deliveryServiceId });
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
    // Записує номер ТТН у замовлення KeyCRM
    async setTrackingCode(crmOrderId, code) {
      await call('PUT', `/order/${crmOrderId}`, { shipping: { tracking_code: code } });
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
