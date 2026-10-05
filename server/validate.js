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

  const city = cleanText(body.city, 60);
  const click = ['fbclid', 'gclid', 'ttclid'].includes(body.click) ? body.click : '';

  return {
    ok: true,
    value: {
      handle,
      city,
      utm: cleanUtm(body.utm),
      referrer: cleanText(body.referrer, 100),
      click,
      variantId,
      quantity,
      name,
      phone,
      comment: cleanText(body.comment, 300),
      pageUrl,
      clientId,
      honeypot: typeof body.website === 'string' && body.website.trim() !== '',
    },
  };
}
