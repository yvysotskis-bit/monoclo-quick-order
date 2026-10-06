import fs from 'node:fs';

function parseJson(raw, name) {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${name} має бути коректним JSON`);
  }
}

// ISO-дата (наприклад, 2026-10-06T07:00:00Z) у мілісекунди; порожньо = 0
function parseDate(raw, name) {
  if (!raw) return 0;
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) throw new Error(`${name} має бути датою, наприклад 2026-10-06T07:00:00Z`);
  return ms;
}

export function loadConfig(env = process.env) {
  const required = (key) => {
    // Зайві пробіли й переноси рядків при копіюванні в Render ламають секрети
    const value = env[key]?.trim();
    if (!value) throw new Error(`Не задано змінну оточення ${key}`);
    return value;
  };
  const optional = (key) => env[key]?.trim() || '';
  const number = (key, fallback) => {
    const raw = optional(key);
    return raw === '' ? fallback : Number(raw);
  };

  const shop = required('SHOPIFY_SHOP');
  return {
    port: number('PORT', 3000),
    shop,
    apiSecret: required('SHOPIFY_API_SECRET'),
    storeOrigin: (optional('STORE_ORIGIN') || `https://${shop}`).replace(/\/+$/, ''),
    telegramToken: required('TELEGRAM_BOT_TOKEN'),
    telegramChatId: required('TELEGRAM_CHAT_ID'),
    telegramWebhookSecret: required('TELEGRAM_WEBHOOK_SECRET'),
    timezone: optional('TIMEZONE') || 'Europe/Kyiv',
    workStart: number('WORK_HOURS_START', 10),
    workEnd: number('WORK_HOURS_END', 20),
    maxQty: number('MAX_QTY', 10),
    currency: optional('CURRENCY') || 'UAH',
    // Публічна адреса цього сервера (на Render підставляється автоматично як RENDER_EXTERNAL_URL)
    publicUrl: (optional('PUBLIC_URL') || optional('RENDER_EXTERNAL_URL')).replace(/\/+$/, ''),

    // База: на Render підключіть Disk з Mount Path /data, інакше дані губляться при перезапуску
    dbPath: optional('DB_PATH') || (fs.existsSync('/data') ? '/data/quick-order.db' : './data/quick-order.db'),
    workerIntervalMs: number('WORKER_INTERVAL_SECONDS', 30) * 1000,

    // KeyCRM (необовʼязково: без ключа замовлення йдуть лише в Telegram)
    keycrmToken: optional('KEYCRM_API_KEY'),
    keycrmSourceId: number('KEYCRM_SOURCE_ID', 216),
    keycrmStatusMap: parseJson(optional('KEYCRM_STATUS_MAP'), 'KEYCRM_STATUS_MAP'),

    // Передоплата через Monobank (Plata by mono): без токена кнопка «Передоплата» не показується
    monobankToken: optional('MONOBANK_TOKEN'),
    prepayAmountUah: number('PREPAY_AMOUNT_UAH', 200),
    payValiditySeconds: number('PAY_VALIDITY_HOURS', 24) * 3600,
    keycrmPaymentMethodId: number('KEYCRM_PAYMENT_METHOD_ID', 0),

    // Нагадування про замовлення без відповіді
    reminderMinutes: number('REMINDER_MINUTES', 15),
    reminderRepeatMinutes: number('REMINDER_REPEAT_MINUTES', 30),
    reminderMax: number('REMINDER_MAX', 3),
    // Нагадувати лише про замовлення, створені не раніше цієї дати (старі, наприклад тестові, ігноруються)
    remindersFrom: parseDate(optional('REMINDERS_FROM'), 'REMINDERS_FROM'),

    // Тижневий звіт: день тижня (1 = понеділок) і година за київським часом
    reportDay: number('REPORT_DAY', 1),
    reportHour: number('REPORT_HOUR', 9),
  };
}
