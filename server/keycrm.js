// KeyCRM: https://docs.keycrm.app/
const BASE_URL = 'https://openapi.keycrm.app/v1';

const absoluteUrl = (url) => (url && url.startsWith('//') ? `https:${url}` : url || undefined);

export function buildCrmOrder(order, { sourceId }) {
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
    manager_comment: `Швидке замовлення #${order.order_number}${d.afterHours ? ' (поза робочим часом)' : ''}. Сторінка: ${d.productUrl}`,
    buyer: { full_name: d.name, phone: d.phone },
    products: [{
      sku: d.sku || undefined,
      name: d.productTitle,
      price: d.unitCents / 100,
      quantity: d.quantity,
      picture: absoluteUrl(d.picture),
      properties: d.options.map((o) => ({ name: o.name, value: o.value })),
    }],
  };
  if (d.city) payload.shipping = { shipping_address_city: d.city };
  if (Object.keys(marketing).length) payload.marketing = marketing;
  return payload;
}

export function createKeycrm({ token, sourceId, statusMap = {}, fetchFn }) {
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
      throw new Error(`KeyCRM ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
    }
    return data;
  }

  return {
    sourceId,
    statusMap,
    async createOrder(order) {
      const data = await call('POST', '/order', buildCrmOrder(order, { sourceId }));
      if (!data.id) throw new Error('KeyCRM не повернув id замовлення');
      return data.id;
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
