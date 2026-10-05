function parts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hourCycle: 'h23',
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

export function formatTime(date, timezone) {
  const p = parts(date, timezone);
  return `${p.hour}:${p.minute}`;
}
