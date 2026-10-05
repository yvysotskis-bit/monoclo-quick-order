export const escapeHtml = (value) => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

export function formatMoney(cents, currency = 'UAH') {
  const n = new Intl.NumberFormat('uk-UA', { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(cents / 100);
  return `${n}\u00a0${currency === 'UAH' ? '₴' : currency}`;
}

export function buildOrderMessage(o) {
  const lines = [
    `<b>🛍 Швидке замовлення #${escapeHtml(o.orderNumber)}</b>`,
    `🕒 ${escapeHtml(o.when)}${o.afterHours ? ' · ⏳ <b>поза робочим часом</b>' : ''}`,
    '',
    `<b>${escapeHtml(o.productTitle)}</b>`,
    ...o.options.map((p) => `${escapeHtml(p.name)}: ${escapeHtml(p.value)}`),
    `Кількість: ${o.quantity}`,
    `Сума: <b>${escapeHtml(formatMoney(o.totalCents, o.currency))}</b>`,
    '',
    `👤 ${escapeHtml(o.name)}`,
    `📞 ${escapeHtml(o.phone)}`,
  ];
  if (o.comment) lines.push(`💬 ${escapeHtml(o.comment)}`);
  lines.push('', '#Monoclo');
  return lines.join('\n');
}

// Номер у міжнародному форматі без «+»: 380951234567
const phoneDigits = (phone) => String(phone).replace(/\D/g, '');

export function newOrderKeyboard(productUrl, phone) {
  const digits = phoneDigits(phone);
  return {
    inline_keyboard: [
      [{ text: '🔗 Товар', url: productUrl }],
      [
        { text: '💬 Telegram', url: `https://t.me/+${digits}` },
        { text: '💬 WhatsApp', url: `https://wa.me/${digits}` },
      ],
      [
        { text: '✅ Взято в роботу', callback_data: 'st:taken' },
        { text: '❌ Спам', callback_data: 'st:spam' },
      ],
    ],
  };
}

const STATUS_MARK = 'Статус:';
const STATUS_TEXT = {
  taken: '✅ В роботі',
  spam: '❌ Спам',
};

// Додає (або замінює) рядок статусу в кінці повідомлення; entities лишаються валідними,
// бо змінюється лише хвіст тексту.
export function applyStatus({ text, entities = [] }, status, actor, time) {
  const cut = text.lastIndexOf(`\n\n${STATUS_MARK}`);
  const base = cut >= 0 ? text.slice(0, cut) : text;
  const kept = entities.filter((e) => e.offset + e.length <= base.length);
  if (status === 'reset') return { text: base, entities: kept };
  return {
    text: `${base}\n\n${STATUS_MARK} ${STATUS_TEXT[status]} — ${actor}, ${time}`,
    entities: kept,
  };
}

export function statusKeyboard(status, existing) {
  // Усі рядки з посиланнями (товар, чати) лишаються, змінюються тільки кнопки статусу
  const rows = (existing?.inline_keyboard || []).filter((row) => row.every((b) => b.url));
  if (status === 'reset') {
    rows.push([
      { text: '✅ Взято в роботу', callback_data: 'st:taken' },
      { text: '❌ Спам', callback_data: 'st:spam' },
    ]);
  } else {
    rows.push([{ text: '↩️ Повернути в нові', callback_data: 'st:reset' }]);
  }
  return { inline_keyboard: rows };
}
