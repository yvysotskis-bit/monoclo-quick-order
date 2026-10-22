// Заявка «Свій принт» з лендингу /pages/svii-prynt (форма-бриф).
// Товару в магазині для неї немає (виріб друкується під замовлення), тому ціна береться з цієї таблиці на сервері,
// а не з форми. Змінити ціни без деплою: змінна CUSTOM_PRINT_PRICES (JSON у гривнях, напр. {"tee":1450,"hoodie":2450}).
// variantId/productId - товар «Власний принт MONOCLO» (vlasnyi-print-zamovlennia), щоб у звітах і рекламі покупка
// мала стабільний ідентифікатор.
import { cleanAds, normalizeName, normalizePhone } from './validate.js';

export const CUSTOM_PRODUCT_ID = '15443984875741';

export const CUSTOM_ITEMS = {
  tee: { label: 'Футболка', priceUah: 1450, variantId: '68257292550365', sized: true },
  hoodie: { label: 'Худі', priceUah: 2450, variantId: '68257292583133', sized: true },
  kids: { label: 'Футболка дитяча', priceUah: 950, variantId: '68257292615901', sized: true },
  a3: { label: 'Постер A3 (30×40 см)', priceUah: 1350, variantId: '68257292648669', sized: false },
  a2: { label: 'Постер A2 (42×59,5 см)', priceUah: 1550, variantId: '68257292681437', sized: false },
};

const PLACEMENTS = { back: 'Спина', front: 'Груди', both: 'Спина і груди' };
const CONTROL_CHARS = /[\u0000-\u001f\u007f<>]/g;

function cleanText(raw, max) {
  if (typeof raw !== 'string') return '';
  return raw.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

// Ціни з оточення поверх таблиці; некоректні значення ігноруються
export function customItems(overrides = {}) {
  const items = {};
  for (const [key, item] of Object.entries(CUSTOM_ITEMS)) {
    const price = Number(overrides?.[key]);
    items[key] = { ...item, priceUah: Number.isFinite(price) && price > 0 ? Math.round(price) : item.priceUah };
  }
  return items;
}

const fail = (code, message, field) => ({ ok: false, code, message, field });

function cleanUtm(raw) {
  const utm = {};
  for (const key of ['source', 'medium', 'campaign', 'content', 'term']) {
    const value = cleanText(raw?.[key], 100);
    if (value) utm[key] = value;
  }
  return utm;
}

// quantity: 1..maxQty; maxQty (за замовчуванням 10) означає «10 і більше» - гуртова партія, ціну рахує менеджер
export function validateCustomBrief(body, { maxQty, items = CUSTOM_ITEMS }) {
  if (!body || typeof body !== 'object') return fail('bad_request', 'Некоректний запит');

  const itemKey = typeof body.item === 'string' ? body.item : '';
  const item = items[itemKey];
  if (!item) return fail('item', 'Оберіть виріб', 'item');

  const quantity = Number(body.quantity ?? 1);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > maxQty) {
    return fail('quantity', `Кількість має бути від 1 до ${maxQty}`, 'quantity');
  }

  const idea = cleanText(body.idea, 280);
  if (idea.length < 3) return fail('idea', 'Опишіть ідею принта кількома словами', 'idea');

  const name = normalizeName(body.name);
  if (!name) return fail('name', 'Вкажіть імʼя', 'name');

  const phone = normalizePhone(body.phone);
  if (!phone) return fail('phone', 'Вкажіть правильний номер телефону', 'phone');

  const color = item.sized ? cleanText(body.color, 30) : '';
  const size = item.sized ? cleanText(body.size, 12) : '';
  const placement = item.sized ? (PLACEMENTS[body.placement] || '') : '';

  const pageUrl = typeof body.page_url === 'string' && /^https:\/\//.test(body.page_url) ? body.page_url.slice(0, 500) : '';
  const clientId = typeof body.client_id === 'string' && /^[\w-]{8,64}$/.test(body.client_id) ? body.client_id : '';
  const click = ['fbclid', 'gclid', 'ttclid'].includes(body.click) ? body.click : '';

  return {
    ok: true,
    value: {
      itemKey,
      item,
      quantity,
      bulk: quantity >= maxQty,
      color,
      size,
      placement,
      idea,
      name,
      phone,
      city: cleanText(body.city, 60),
      utm: cleanUtm(body.utm),
      referrer: cleanText(body.referrer, 100),
      click,
      ads: cleanAds(body.ads),
      pageUrl,
      clientId,
      honeypot: typeof body.website === 'string' && body.website.trim() !== '',
    },
  };
}

// Параметри для картки в Telegram і товару в KeyCRM
export function customOptions(input, maxQty) {
  return [
    { name: 'Виріб', value: input.item.label },
    input.color && { name: 'Колір', value: input.color },
    input.size && { name: 'Розмір', value: input.size },
    input.placement && { name: 'Принт', value: input.placement },
    input.bulk && { name: 'Тираж', value: `${maxQty}+ шт (гурт, ціну рахує менеджер)` },
  ].filter(Boolean);
}
