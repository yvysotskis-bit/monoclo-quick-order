export function loadConfig(env = process.env) {
  const required = (key) => {
    const value = env[key];
    if (!value) throw new Error(`Не задано змінну оточення ${key}`);
    return value;
  };
  const shop = required('SHOPIFY_SHOP');
  return {
    port: Number(env.PORT || 3000),
    shop,
    apiSecret: required('SHOPIFY_API_SECRET'),
    storeOrigin: (env.STORE_ORIGIN || `https://${shop}`).replace(/\/+$/, ''),
    telegramToken: required('TELEGRAM_BOT_TOKEN'),
    telegramChatId: required('TELEGRAM_CHAT_ID'),
    telegramWebhookSecret: required('TELEGRAM_WEBHOOK_SECRET'),
    timezone: env.TIMEZONE || 'Europe/Kyiv',
    workStart: Number(env.WORK_HOURS_START ?? 10),
    workEnd: Number(env.WORK_HOURS_END ?? 20),
    maxQty: Number(env.MAX_QTY || 10),
    currency: env.CURRENCY || 'UAH',
  };
}
