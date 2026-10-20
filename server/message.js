export const escapeHtml = (value) => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

export function formatMoney(cents, currency = 'UAH') {
  // Копійки показуємо завжди двома цифрами (1 500,50), а цілі суми без них (1 500)
  const digits = cents % 100 === 0 ? 0 : 2;
  const n = new Intl.NumberFormat('uk-UA', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(cents / 100);
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

// Доставка Новою поштою людською мовою; повертає масив рядків (порожній, якщо нічого не вказано)
export function describeDelivery(delivery) {
  if (!delivery) return [];
  const { method, city, point, street, house, apartment } = delivery;
  const lines = [];
  const place = city?.present || city?.name;
  if (place) lines.push(`📍 ${place}`);
  if (method === 'warehouse' || method === 'postomat') {
    if (point?.name) lines.push(`🚚 Нова пошта: ${point.name}`);
  } else if (method === 'courier') {
    const address = [street?.name, house && `буд. ${house}`, apartment && `кв. ${apartment}`].filter(Boolean).join(', ');
    lines.push(`🚚 Нова пошта, адресна доставка${address ? `: ${address}` : ''}`);
  }
  return lines;
}

export function buildOrderMessage(o) {
  const lines = [
    `<b>🛍 Швидке замовлення #${escapeHtml(o.orderNumber)}</b>${o.brandName ? ` · <b>${escapeHtml(o.brandName)}</b>` : ''}`,
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
    `👤 ${escapeHtml([o.name, o.surname].filter(Boolean).join(' '))}`,
    `📞 ${escapeHtml(o.phone)}`,
  );
  const delivery = describeDelivery(o.delivery);
  if (delivery.length) lines.push(...delivery.map(escapeHtml));
  else if (o.city) lines.push(`📍 ${escapeHtml(o.city)}`);
  if (o.body) lines.push(`📏 Зріст ${o.body.height} см, вага ${o.body.weight} кг`);
  if (o.comment) lines.push(`💬 ${escapeHtml(o.comment)}`);
  const source = describeSource(o);
  lines.push('', `📈 ${source ? escapeHtml(source) : 'прямий візит'}`, o.brandTag || '#Monoclo');
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

// pay: { prepayUah, paidCents, remainingCents } або null, якщо оплата не налаштована
const payRows = (pay) => (pay
  ? [
    [
      { text: `💳 Передоплата ${pay.prepayUah} ₴`, callback_data: 'pay:link' },
      {
        text: `💳 ${pay.paidCents > 0 ? 'Залишок' : 'Повна сума'} ${formatMoney(pay.remainingCents)}`,
        callback_data: 'pay:full',
      },
    ],
    [{ text: '✏️ Інша сума', callback_data: 'pay:custom' }],
  ]
  : []);

export function newOrderKeyboard(productUrl, phone, publicUrl = '', pay = null) {
  const digits = phoneDigits(phone);
  const chats = [{ text: '💬 Telegram', url: `https://t.me/+${digits}` }];
  if (publicUrl) chats.push({ text: '💬 Viber', url: `${publicUrl}/viber/${digits}` });
  return {
    inline_keyboard: [
      [{ text: '🔗 Товар', url: productUrl }],
      chats,
      ...payRows(pay),
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
  rows.push(...payRows(pay));
  if (status === 'reset') {
    rows.push([statusButton('taken'), statusButton('spam')]);
  } else {
    rows.push(...chunk(STATUS_KEYS.filter((key) => key !== status).map(statusButton), 2));
    rows.push([{ text: '↩️ Повернути в нові', callback_data: 'st:reset' }]);
  }
  return { inline_keyboard: rows };
}

// Розбір суми, яку ввів менеджер: «1500», «1 500», «1499,50», «1500 грн». Повертає копійки або null
export function parseAmountKopecks(text) {
  const cleaned = String(text ?? '')
    .toLowerCase()
    .replace(/(грн|гривень|гривні|uah|₴)/g, '')
    .replace(/[\s\u00a0]/g, '')
    .replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const kopecks = Math.round(Number(cleaned) * 100);
  return kopecks > 0 ? kopecks : null;
}

// Назви оплати: називний відмінок («Передоплата … отримана») і знахідний («посилання на передоплату»)
export const PAYMENT_KIND = {
  prepay: 'передоплата',
  full: 'повна оплата',
  custom: 'оплата',
};
const PAYMENT_KIND_ACC = {
  prepay: 'передоплату',
  full: 'повну оплату',
  custom: 'оплату',
};

// Повідомлення менеджеру з готовим текстом для клієнта (його можна скопіювати одним дотиком)
export function buildPaymentMessage({ orderNumber, amountCents, kind, url, hours, createdBy, totalCents, paidCents = 0 }) {
  const amount = formatMoney(amountCents);
  const client = kind === 'prepay'
    ? `Вітаємо! Щоб підтвердити замовлення №${orderNumber}, будь ласка, внесіть передоплату ${amount}: ${url}`
    : `Вітаємо! Для оплати замовлення №${orderNumber} на суму ${amount} перейдіть за посиланням: ${url}`;
  const lines = [
    `💳 <b>Посилання на ${PAYMENT_KIND_ACC[kind] || 'оплату'} ${escapeHtml(amount)}</b> · замовлення #${escapeHtml(orderNumber)}`,
  ];
  if (createdBy) lines.push(`Створив(ла): ${escapeHtml(createdBy)}`);
  if (paidCents > 0) lines.push(`Уже сплачено: ${escapeHtml(formatMoney(paidCents))}`);
  if (amountCents + paidCents > totalCents) {
    lines.push(`⚠️ Разом з уже сплаченим сума перевищує суму замовлення (${escapeHtml(formatMoney(totalCents))}). Перевірте, чи це правильно.`);
  }
  lines.push(`Діє ${hours} год. Скопіюйте текст нижче й надішліть клієнту:`, '', `<code>${escapeHtml(client)}</code>`);
  return lines.join('\n');
}

export function buildPaidMessage({ orderNumber, amountCents, kind, totalCents, paidCents, method = '' }) {
  const lines = [`✅ ${PAYMENT_KIND[kind] ? PAYMENT_KIND[kind][0].toUpperCase() + PAYMENT_KIND[kind].slice(1) : 'Оплата'} ${formatMoney(amountCents)} отримана за замовленням #${orderNumber}.`];
  const rest = totalCents - paidCents;
  lines.push(rest > 0
    ? `Сплачено ${formatMoney(paidCents)} з ${formatMoney(totalCents)}, залишок ${formatMoney(rest)}.`
    : 'Замовлення оплачено повністю.');
  // Правила Нової пошти заздалегідь: щоб менеджер не дізнавався про обмеження вже під час створення ТТН
  if (method === 'postomat') {
    lines.push(rest > 0
      ? 'ℹ️ Поштомат: післяплата недоступна, а доставку оплачує відправник. Для ТТН клієнт має оплатити повну суму.'
      : 'ℹ️ Поштомат: доставку оплачує відправник (правила Нової пошти).');
  } else if (method === 'courier' && rest > 0) {
    lines.push('ℹ️ Адресна доставка: Контроль оплати недоступний, для ТТН потрібна повна оплата.');
  }
  if (rest < 0) lines.push(`⚠️ Сплачено більше за суму замовлення на ${formatMoney(-rest)}. Перевірте й за потреби поверніть різницю клієнту.`);
  return lines.join('\n');
}

export function buildReversedMessage(orderNumber, amountCents, inCrm) {
  return `↩️ Оплату ${formatMoney(amountCents)} за замовленням #${orderNumber} повернено клієнту (повернення коштів у Monobank).${inCrm ? ' У KeyCRM цей платіж лишився, виправте його вручну.' : ''}`;
}

export function buildPartialRefundMessage(orderNumber, amountCents, finalCents, inCrm) {
  return `↩️ Замовлення #${orderNumber}: частково повернено ${formatMoney(Math.max(amountCents - finalCents, 0))} (було сплачено ${formatMoney(amountCents)}, залишилось ${formatMoney(finalCents)}).${inCrm ? ' У KeyCRM платіж не змінився, виправте його вручну.' : ''}`;
}

export function buildAmountMismatchMessage(orderNumber, expectedCents, actualCents) {
  return `⚠️ Замовлення #${orderNumber}: сума відрізняється від рахунку. Очікували ${formatMoney(expectedCents)}, банк повідомив ${formatMoney(actualCents)} (за документацією це сума після повернень). Перевірте оплату в кабінеті Monobank.`;
}

export function buildPayFailedMessage(orderNumber, reason) {
  return `⚠️ Оплата за замовленням #${orderNumber} не пройшла${reason ? ` (${reason})` : ''}. Створіть нове посилання кнопкою «💳».`;
}

// Прохання ввести суму; згадка менеджера змушує Telegram показати йому поле відповіді
export function buildAmountPrompt({ orderNumber, userId, userName, maxUah }) {
  const who = userId ? `<a href="tg://user?id=${userId}">${escapeHtml(userName)}</a>` : escapeHtml(userName);
  return `✏️ ${who}, введіть суму в гривнях для замовлення #${escapeHtml(orderNumber)}.\nВідповідайте саме на це повідомлення. Наприклад: 1500 або 1499.50 (до ${maxUah} ₴).`;
}

export function buildReminder(orderNumber, minutes) {
  return `⏰ Замовлення #${orderNumber} уже ${minutes} хв без відповіді менеджера.\nНатисніть «✅ Взято в роботу», коли почнете його опрацьовувати.`;
}

// Кнопка під повідомленням про оплату: менеджер сам запускає створення ТТН
export const ttnKeyboard = (orderId) => ({
  inline_keyboard: [[{ text: '📦 Створити ТТН', callback_data: `ttn:${orderId}` }]],
});

export function buildTtnMessage({ orderNumber, number, codUah, costUah, address, tracked, unpaidUah = 0, statusFailed = false, deliveryUah = 0, warnings = [], senderPays = false }) {
  const lines = [`📦 <b>ТТН Нової пошти створено: <code>${escapeHtml(number)}</code></b> · замовлення #${escapeHtml(orderNumber)}`];
  if (address) lines.push(escapeHtml(address));
  lines.push(`Оголошена вартість: ${escapeHtml(formatMoney(Math.round(costUah * 100)))}`);
  if (deliveryUah > 0) lines.push(`Вартість доставки (оплачує ${senderPays ? 'відправник' : 'одержувач'}): ${escapeHtml(formatMoney(Math.round(deliveryUah * 100)))}`);
  for (const w of warnings) lines.push(`⚠️ Нова пошта: ${escapeHtml(w)}`);
  if (unpaidUah > 0) {
    lines.push(`⚠️ ТТН створено БЕЗ післяплати. Неоплачений залишок ${escapeHtml(formatMoney(Math.round(unpaidUah * 100)))}: надішліть клієнту посилання кнопкою «💳 Залишок» під замовленням.`);
  } else {
    lines.push(codUah > 0
      ? `Післяплата при отриманні: ${escapeHtml(formatMoney(Math.round(codUah * 100)))}`
      : 'Замовлення оплачено повністю, післяплати немає.');
  }
  lines.push(tracked ? '✅ Номер записано в KeyCRM.' : '⚠️ Номер не вдалося записати в KeyCRM, додайте його вручну.');
  if (statusFailed) lines.push('⚠️ Не вдалося змінити статус у KeyCRM, змініть його вручну.');
  return lines.join('\n');
}

// Формат кнопки: ttn:<id> | ttn0:<id> (без післяплати) з необовʼязковим суфіксом :s (доставку оплачує відправник)
export const ttnCallback = (orderId, { noCod = false, senderPays = false } = {}) => `${noCod ? 'ttn0' : 'ttn'}:${orderId}${senderPays ? ':s' : ''}`;

export const ttnNoCodKeyboard = (orderId, flags = {}) => ({
  inline_keyboard: [
    [{ text: '📦 Створити ТТН без післяплати', callback_data: ttnCallback(orderId, { ...flags, noCod: true }) }],
    [{ text: '🔁 Спробувати ще раз', callback_data: ttnCallback(orderId, flags) }],
  ],
});

export const ttnSenderPaysKeyboard = (orderId, flags = {}) => ({
  inline_keyboard: [
    [{ text: '📦 Створити ТТН: доставку оплачує відправник', callback_data: ttnCallback(orderId, { ...flags, senderPays: true }) }],
  ],
});

export const buildTtnFailedMessage = (orderNumber, reason) =>
  `⚠️ Не вдалося створити ТТН за замовленням #${escapeHtml(orderNumber)}: ${escapeHtml(reason)}\nВиправте дані й натисніть «📦 Створити ТТН» ще раз або створіть ТТН у кабінеті вручну.`;
