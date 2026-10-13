function parts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hourCycle: 'h23',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const out = {};
  for (const { type, value } of formatter.formatToParts(date)) out[type] = value;
  return out;
}

export function isWorkingTime(date, { workStart, workEnd, timezone }) {
  const hour = Number(parts(date, timezone).hour);
  return hour >= workStart && hour < workEnd;
}

// Зсув часової зони від UTC у мілісекундах на момент `ts`
function offsetAt(ts, timeZone) {
  const p = parts(new Date(ts), timeZone);
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return asUtc - Math.floor(ts / 1000) * 1000;
}

// UTC-момент, коли в зоні `timeZone` настає локальна дата й година (враховує перехід на літній/зимовий час)
function zonedTime(year, month, day, hour, timeZone) {
  const guess = Date.UTC(year, month - 1, day, hour);
  let result = guess - offsetAt(guess, timeZone);
  const second = guess - offsetAt(result, timeZone);
  if (second !== result) result = second;
  return result;
}

// Мілісекунди початку найближчого робочого дня, що настане після `date` (якщо зараз ще до початку, то сьогодні).
// Рахуємо за календарною датою зони, а не додаванням 24 годин, тому в дні переходу часу похибки немає.
export function nextWorkStart(date, { workStart, timezone }) {
  const p = parts(date, timezone);
  const today = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day));
  const day = new Date(Number(p.hour) < workStart ? today : today + 24 * 3600e3);
  return zonedTime(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), workStart, timezone);
}

// Коли «годинник очікування» менеджера почав іти: одразу, а для нічних замовлень з початку робочого дня
export function effectiveStart(createdMs, cfg) {
  const date = new Date(createdMs);
  return isWorkingTime(date, cfg) ? createdMs : nextWorkStart(date, cfg);
}

// 1 = понеділок … 7 = неділя
export function isoWeekday(date, timezone) {
  return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(parts(date, timezone).weekday) + 1;
}

export function hourOf(date, timezone) {
  return Number(parts(date, timezone).hour);
}

// 2025-10-06
export function dateKey(date, timezone) {
  const p = parts(date, timezone);
  return `${p.year}-${p.month}-${p.day}`;
}

// 20251005-213405, у часовій зоні магазину
export function orderNumber(date, timezone) {
  const p = parts(date, timezone);
  return `${p.year}${p.month}${p.day}-${p.hour}${p.minute}${p.second}`;
}

// 05.10.2025 21:34
export function formatDateTime(date, timezone) {
  const p = parts(date, timezone);
  return `${p.day}.${p.month}.${p.year} ${p.hour}:${p.minute}`;
}

// 05.10
export function formatDayMonth(date, timezone) {
  const p = parts(date, timezone);
  return `${p.day}.${p.month}`;
}

export function formatTime(date, timezone) {
  const p = parts(date, timezone);
  return `${p.hour}:${p.minute}`;
}
