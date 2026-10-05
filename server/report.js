import { STATUSES, describeSource, escapeHtml, formatMoney } from './message.js';
import { formatDayMonth } from './hours.js';

const plural = (n, one, few, many) => {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
};

export function buildWeeklyReport(orders, { from, to, timezone, currency = 'UAH' }) {
  const title = `📊 <b>Звіт за тиждень ${formatDayMonth(new Date(from), timezone)}–${formatDayMonth(new Date(to), timezone)}</b>`;
  if (!orders.length) return `${title}\n\nЗамовлень за цей період не було.`;

  const counts = {};
  const products = new Map();
  const sources = new Map();
  let sum = 0;
  let afterHours = 0;
  let paid = 0;
  let paidSum = 0;
  const responseTimes = [];

  for (const o of orders) {
    counts[o.status] = (counts[o.status] || 0) + 1;
    sum += o.data.totalCents;
    if (o.data.afterHours) afterHours += 1;
    if (o.pay_status === 'success') {
      paid += 1;
      paidSum += o.pay_amount || 0;
    }
    products.set(o.data.productTitle, (products.get(o.data.productTitle) || 0) + o.data.quantity);
    const source = describeSource(o.data) || 'прямий візит';
    sources.set(source, (sources.get(source) || 0) + 1);
    if (o.first_response_at) responseTimes.push(o.first_response_at - o.created_at);
  }

  const top = (map, limit) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
  const lines = [
    title,
    '',
    `Замовлень: <b>${orders.length}</b> (поза робочим часом: ${afterHours})`,
    `Сума: <b>${escapeHtml(formatMoney(sum, currency))}</b>`,
    '',
    '<b>Статуси</b>',
    `🆕 Без відповіді: ${counts.new || 0}`,
    ...Object.entries(STATUSES)
      .filter(([key]) => counts[key])
      .map(([key, s]) => `${s.label}: ${counts[key]}`),
  ];

  if (paid) {
    lines.push('', `💳 Передоплат отримано: ${paid} на ${escapeHtml(formatMoney(paidSum, currency))}`);
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
