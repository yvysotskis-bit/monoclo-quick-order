export const escapeHtml = (value) => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

export function formatMoney(cents, currency = 'UAH') {
  const n = new Intl.NumberFormat('uk-UA', { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(cents / 100);
  return `${n} ${currency === 'UAH' ? '₴' : currency}`;
}

// Джерело трафіку людською мовою: «facebook / cpc / campaign»
export function describeSource({ utm = {}, referrer = '', click = '' } = {}) {
  const inferred = { fbclid: 'facebook', gclid: 'google', ttclid: 'tiktok' }[click] || '';
  const source = utm.source || inferred;
  const parts = [source, utm.medium, utm.campaign].filter(Boolean);
  if (parts.length) return parts.join(' / ');
  return referrer || '';
}

export function buildOrderMessage(o) {
  const lines = [
    `<b>🛍 Швидке замовлення #${escapeHtml(o.orderNumber)}</b>`,
    `🕒 ${escapeHtml(o.when)}${o.afterHours ? ' · ⏳ <b>поза робочим часом</b>' : ''}`,
  ];
  if (o.delayed) lines.push('⚠️ Повідомлення надійшло із затримкою через збій звʼязку');
  lines.push(
    '',
    `<b>${escapeHtml(o.productTitle)}</b>`,
    ...o.options.map((p) => `${escapeHtml(p.name)}: ${escapeHtml(p.value)}`),
    `Кількість: ${o.quantity}`,
    `Сума: <b>${escapeHtml(formatMoney(o.totalCents, o.currency))}</b>`,
    '',
    `👤 ${escapeHtml(o.name)}`,
    `📞 ${escapeHtml(o.phone)}`,
  );
  if (o.city) lines.push(`📍 ${escapeHtml(o.city)}`);
  if (o.comment) lines.push(`💬 ${escapeHtml(o.comment)}`);
  const source = describeSource(o);
  lines.push('', `📈 ${source ? escapeHtml(source) : 'прямий візит'}`, '#Monoclo');
  return lines.join('\n');
}

// Номер у міжнародному форматі без «+»: 380951234567
const phoneDigits = (phone) => String(phone).replace(/\D/g, '');

export const STATUSES = {
  taken: { label: '✅ В роботі', button: '✅ Взято в роботу' },
  no_answer: { label: '📵 Не відповів', button: '📵 Не відповів' },
  confirmed: { label: '👍 Підтверджено', button: '👍 Підтверджено' },
  shipped: { label: '📦 Відправлено', button: '📦 Відправлено' },
  cancelled: { label: '🚫 Скасовано', button: '🚫 Скасовано' },
  spam: { label: '❌ Спам', button: '❌ Спам' },
};
export const STATUS_KEYS = Object.keys(STATUSES);

const chunk = (items, size) => {
  const rows = [];
  for (let i = 0; i < items.length; i += size) rows.push(items.slice(i, i + size));
  return rows;
};

const statusButton = (key) => ({ text: STATUSES[key].button, callback_data: `st:${key}` });

// Telegram не приймає в кнопках посилання viber://, тому кнопка веде на сторінку нашого сервера,
// яка відкриває Viber (див. viberPage у app.js)
export const viberLink = (digits) => `viber://chat?number=%2B${digits}`;

// pay: { amountUah } або null, якщо оплата не налаштована
const payRow = (pay) => (pay ? [[{ text: `💳 Передоплата ${pay.amountUah} ₴`, callback_data: 'pay:link' }]] : []);

export function newOrderKeyboard(productUrl, phone, publicUrl = '', pay = null) {
  const digits = phoneDigits(phone);
  const chats = [{ text: '💬 Telegram', url: `https://t.me/+${digits}` }];
  if (publicUrl) chats.push({ text: '💬 Viber', url: `${publicUrl}/viber/${digits}` });
  return {
    inline_keyboard: [
      [{ text: '🔗 Товар', url: productUrl }],
      chats,
      ...payRow(pay),
      [statusButton('taken'), statusButton('spam')],
    ],
  };
}

const STATUS_MARK = 'Статус:';

// Додає (або замінює) рядок статусу в кінці повідомлення; entities лишаються валідними,
// бо змінюється лише хвіст тексту.
export function applyStatus({ text, entities = [] }, status, actor, time) {
  const cut = text.lastIndexOf(`\n\n${STATUS_MARK}`);
  const base = cut >= 0 ? text.slice(0, cut) : text;
  const kept = entities.filter((e) => e.offset + e.length <= base.length);
  if (status === 'reset') return { text: base, entities: kept };
  return {
    text: `${base}\n\n${STATUS_MARK} ${STATUSES[status].label} — ${actor}, ${time}`,
    entities: kept,
  };
}

// Усі рядки з посиланнями (товар, чати) лишаються, змінюються тільки кнопки статусу
export function statusKeyboard(status, existing, pay = null) {
  const rows = (existing?.inline_keyboard || []).filter((row) => row.every((b) => b.url));
  rows.push(...payRow(pay));
  if (status === 'reset') {
    rows.push([statusButton('taken'), statusButton('spam')]);
  } else {
    rows.push(...chunk(STATUS_KEYS.filter((key) => key !== status).map(statusButton), 2));
    rows.push([{ text: '↩️ Повернути в нові', callback_data: 'st:reset' }]);
  }
  return { inline_keyboard: rows };
}

// Повідомлення менеджеру з готовим текстом для клієнта (його можна скопіювати одним дотиком)
export function buildPaymentMessage({ orderNumber, amountUah, url, hours }) {
  const amount = formatMoney(amountUah * 100);
  const forClient = `Вітаємо! Щоб підтвердити замовлення №${orderNumber}, будь ласка, внесіть передоплату ${amount}: ${url}`;
  return [
    `💳 <b>Посилання на передоплату ${escapeHtml(amount)}</b> · замовлення #${escapeHtml(orderNumber)}`,
    `Діє ${hours} год. Скопіюйте текст нижче й надішліть клієнту:`,
    '',
    `<code>${escapeHtml(forClient)}</code>`,
  ].join('\n');
}

export function buildPaidMessage(orderNumber, amountUah) {
  return `✅ Передоплата ${formatMoney(amountUah * 100)} отримана за замовленням #${orderNumber}.`;
}

export function buildPayFailedMessage(orderNumber, reason) {
  return `⚠️ Передоплата за замовленням #${orderNumber} не пройшла${reason ? ` (${reason})` : ''}. Створіть нове посилання кнопкою «💳 Передоплата».`;
}

export function buildReminder(orderNumber, minutes) {
  return `⏰ Замовлення #${orderNumber} уже ${minutes} хв без відповіді менеджера.\nНатисніть «✅ Взято в роботу», коли почнете його опрацьовувати.`;
}
