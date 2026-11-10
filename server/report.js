import { STATUSES, describeSource, escapeHtml, formatMoney } from './message.js';
import { formatDayMonth } from './hours.js';

const plural = (n, one, few, many) => {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
};

export function buildWeeklyReport(orders, { from, to, timezone, currency = 'UAH', payments = [], startOf = (o) => o.created_at }) {
  const title = `📊 <b>Звіт за тиждень ${formatDayMonth(new Date(from), timezone)}–${formatDayMonth(new Date(to), timezone)}</b>`;
  if (!orders.length) return `${title}\n\nЗамовлень за цей період не було.`;

  const counts = {};
  const products = new Map();
  const sources = new Map();
  let sum = 0;
  let afterHours = 0;
  const paid = payments.length;
  const paidSum = payments.reduce((sum, p) => sum + p.amount, 0);
  const responseTimes = [];

  for (const o of orders) {
    counts[o.status] = (counts[o.status] || 0) + 1;
    // У суму не входять спам і скасовані замовлення
    if (o.status !== 'spam' && o.status !== 'cancelled') sum += o.data.totalCents;
    if (o.data.afterHours) afterHours += 1;
    products.set(o.data.productTitle, (products.get(o.data.productTitle) || 0) + o.data.quantity);
    const source = describeSource(o.data) || 'прямий візит';
    sources.set(source, (sources.get(source) || 0) + 1);
    // Нічні замовлення чекають не з моменту створення, а з початку робочого дня
    if (o.first_response_at) responseTimes.push(Math.max(o.first_response_at - startOf(o), 0));
  }

  const top = (map, limit) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
  const lines = [
    title,
    '',
    `Замовлень: <b>${orders.length}</b> (поза робочим часом: ${afterHours})`,
    `Сума (без спаму й скасованих): <b>${escapeHtml(formatMoney(sum, currency))}</b>`,
    '',
    '<b>Статуси</b>',
    `🆕 Без відповіді: ${counts.new || 0}`,
    ...Object.entries(STATUSES)
      .filter(([key]) => counts[key])
      .map(([key, s]) => `${s.label}: ${counts[key]}`),
  ];

  if (paid) {
    lines.push('', `💳 Оплат отримано: ${paid} на ${escapeHtml(formatMoney(paidSum, currency))}`);
  }

  if (responseTimes.length) {
    const avg = Math.round(responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length / 60_000);
    lines.push('', `⏱ Середній час до першої відповіді: ${avg} хв`);
  }

  lines.push('', '<b>Топ товарів</b>');
  top(products, 5).forEach(([title2, qty], i) => {
    lines.push(`${i + 1}. ${escapeHtml(title2)}: ${qty} ${plural(qty, 'шт.', 'шт.', 'шт.')}`);
  });
  lines.push('', '<b>Джерела</b>');
  top(sources, 5).forEach(([name, n]) => {
    lines.push(`${escapeHtml(name)}: ${n} ${plural(n, 'замовлення', 'замовлення', 'замовлень')}`);
  });
  return lines.join('\n');
}

// Ранкове зведення: що сталося за добу і що зараз чекає на менеджера
export function buildDailyDigest({ orders, payments = [], counts, currency = 'UAH', dayLabel }) {
  const real = orders.filter((o) => o.status !== 'spam' && o.status !== 'cancelled');
  const sum = real.reduce((acc, o) => acc + o.data.totalCents, 0);
  const paidSum = payments.reduce((acc, p) => acc + p.amount, 0);
  const lines = [
    `☀️ <b>Зведення на ${escapeHtml(dayLabel)}</b>`,
    '',
    `За останню добу: <b>${real.length}</b> ${plural(real.length, 'замовлення', 'замовлення', 'замовлень')} на ${escapeHtml(formatMoney(sum, currency))}`
      + (payments.length ? `, оплат ${payments.length} на ${escapeHtml(formatMoney(paidSum, currency))}` : ''),
    '',
    '<b>Зараз чекає на вас</b>',
  ];
  const todo = [
    [counts.unanswered, '🆕 Без відповіді'],
    [counts.awaitingPayment, '💳 Надіслано посилання, чекаємо оплату'],
    [counts.paidNoTtn, '📦 Оплачено, ще без ТТН'],
    [counts.atBranch, '📮 Посилок у відділенні'],
    [counts.storageSoon, '⚠️ З них скоро платне зберігання'],
  ].filter(([n]) => n > 0);
  if (todo.length) lines.push(...todo.map(([n, label]) => `${label}: <b>${n}</b>`));
  else lines.push('Усе опрацьовано 👌');
  return lines.join('\n');
}

const FUNNEL_LABELS = [
  ['open', 'Відкрили форму'],
  ['step2', 'Дійшли до контактів'],
  ['submit', 'Оформили замовлення'],
];
const CLOSE_LABELS = [
  ['close_options', 'не обрали розмір чи колір'],
  ['close_contacts', 'не заповнили імʼя чи телефон'],
  ['close_delivery', 'не обрали місто чи відділення'],
  ['close_ready', 'усе заповнили, але не натиснули'],
];

// Воронка форми за період: де саме люди закривають попап
export function buildFunnelReport(rows, days) {
  const by = Object.fromEntries(rows.map((r) => [r.event, r.n]));
  const opened = by.open || 0;
  const title = `🔎 <b>Воронка форми за ${days} ${plural(days, 'день', 'дні', 'днів')}</b>`;
  if (!opened) return `${title}\n\nДаних ще немає: вони зʼявляться після оновлення розширення в Shopify і перших відкриттів форми.`;
  const share = (n) => `${Math.round((n / opened) * 100)}%`;
  const lines = [title, '', ...FUNNEL_LABELS.map(([key, label]) => `${label}: <b>${by[key] || 0}</b> (${share(by[key] || 0)})`)];
  const closes = CLOSE_LABELS.filter(([key]) => by[key]);
  if (closes.length) lines.push('', '<b>Закрили без замовлення</b>', ...closes.map(([key, label]) => `${label}: ${by[key]} (${share(by[key])})`));
  return lines.join('\n');
}

export function buildAbReport(summary) {
  if (!summary.length) return '🧪 A/B-тестів зараз немає.';
  return summary.map((e) => [
    `🧪 <b>${escapeHtml(e.title)}</b>${e.winner ? ` · переможець: «${escapeHtml(e.labels?.[e.winner] || e.winner)}»` : ' · триває'}`,
    ...Object.entries(e.variants).map(([v, s]) => `${escapeHtml(e.labels?.[v] || v)}: ${s.rate}% (${s.conversions} із ${s.views})`),
  ].join('\n')).join('\n\n');
}
