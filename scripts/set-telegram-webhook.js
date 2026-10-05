// Реєструє вебхук Telegram для кнопок "Взято в роботу" / "Спам".
// Запуск: node --env-file=.env scripts/set-telegram-webhook.js
import { createTelegram } from '../server/telegram.js';

const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TELEGRAM_WEBHOOK_SECRET, PUBLIC_URL } = process.env;
for (const [key, value] of Object.entries({ TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TELEGRAM_WEBHOOK_SECRET, PUBLIC_URL })) {
  if (!value) throw new Error(`Не задано ${key}`);
}
const telegram = createTelegram({ token: TELEGRAM_BOT_TOKEN, chatId: TELEGRAM_CHAT_ID, fetchFn: fetch });
await telegram.setWebhook(`${PUBLIC_URL.replace(/\/+$/, '')}/telegram/webhook`, TELEGRAM_WEBHOOK_SECRET);
console.log('Вебхук Telegram встановлено');
