const CONTROL_CHARS = /[\u0000-\u001f\u007f<>]/g;

// Повертає +380XXXXXXXXX (UA) або +<цифри> для міжнародних номерів, інакше null
export function normalizePhone(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return null;

  if (trimmed.startsWith('+') && !digits.startsWith('380')) {
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  }
  let national = digits;
  if (national.startsWith('380')) national = national.slice(3);
  else if (national.startsWith('0')) national = national.slice(1);
  return /^\d{9}$/.test(national) ? `+380${national}` : null;
}

export function normalizeName(raw) {
  if (typeof raw !== 'string') return null;
  const name = raw.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
  return name.length >= 2 && name.length <= 60 ? name : null;
}

function cleanText(raw, max) {
  if (typeof raw !== 'string') return '';
  return raw.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

const fail = (code, message, field) => ({ ok: false, code, message, field });

// UTM-мітки й джерело: короткі рядки без розмітки
function cleanUtm(raw) {
  const utm = {};
  for (const key of ['source', 'medium', 'campaign', 'content', 'term']) {
    const value = cleanText(raw?.[key], 100);
    if (value) utm[key] = value;
  }
  return utm;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const METHODS = ['warehouse', 'postomat', 'courier'];

// Доставка Новою поштою: усе необовʼязкове й очищується від розмітки. Ідентифікатори (ref) беремо лише у форматі UUID.
export function cleanDelivery(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const ref = (value) => (typeof value === 'string' && UUID.test(value) ? value : '');
  const method = METHODS.includes(raw.method) ? raw.method : '';

  const city = {
    ref: ref(raw.city?.ref),
    name: cleanText(raw.city?.name, 80),
    present: cleanText(raw.city?.present, 120),
    area: cleanText(raw.city?.area, 80),
  };
  const point = {
    ref: ref(raw.point?.ref),
    number: cleanText(raw.point?.number, 20),
    name: cleanText(raw.point?.name, 200),
  };
  const street = { ref: ref(raw.street?.ref), name: cleanText(raw.street?.name, 120) };
  const house = cleanText(raw.house, 20);
  const apartment = cleanText(raw.apartment, 20);

  const hasAnything = city.name || point.name || street.name || house || apartment;
  if (!hasAnything) return null;
  return { method, city, point, street, house, apartment };
}

// Зріст і вага з підбору розміру: необовʼязково, поза межами відкидаємо
export function cleanBody(raw) {
  const height = Math.round(Number(raw?.height));
  const weight = Math.round(Number(raw?.weight));
  if (!(height >= 120 && height <= 220 && weight >= 30 && weight <= 200)) return null;
  return { height, weight };
}

export function validateSubmission(body, { maxQty }) {
  if (!body || typeof body !== 'object') return fail('bad_request', 'Некоректний запит');

  const handle = typeof body.product_handle === 'string' ? body.product_handle : '';
  if (!/^[\p{L}\p{N}_-]{1,255}$/u.test(handle)) return fail('bad_request', 'Некоректний товар');

  const variantId = String(body.variant_id ?? '');
  if (!/^\d{1,18}$/.test(variantId)) return fail('variant', 'Оберіть варіант товару', 'variant');

  const quantity = Number(body.quantity);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > maxQty) {
    return fail('quantity', `Кількість має бути від 1 до ${maxQty}`, 'quantity');
  }

  const name = normalizeName(body.name);
  if (!name) return fail('name', 'Вкажіть імʼя', 'name');

  const phone = normalizePhone(body.phone);
  if (!phone) return fail('phone', 'Вкажіть правильний номер телефону', 'phone');

  const pageUrl = typeof body.page_url === 'string' && /^https:\/\//.test(body.page_url)
    ? body.page_url.slice(0, 500)
    : '';
  const clientId = typeof body.client_id === 'string' && /^[\w-]{8,64}$/.test(body.client_id)
    ? body.client_id
    : '';

  const delivery = cleanDelivery(body.delivery);
  // Місто: обране зі списку Нової пошти або введене вручну
  const city = delivery?.city.name || cleanText(body.city, 60);
  const click = ['fbclid', 'gclid', 'ttclid'].includes(body.click) ? body.click : '';

  return {
    ok: true,
    value: {
      handle,
      city,
      delivery,
      utm: cleanUtm(body.utm),
      referrer: cleanText(body.referrer, 100),
      click,
      variantId,
      quantity,
      name,
      surname: cleanText(body.surname, 60),
      body: cleanBody(body.body),
      phone,
      comment: cleanText(body.comment, 300),
      pageUrl,
      clientId,
      honeypot: typeof body.website === 'string' && body.website.trim() !== '',
    },
  };
}
