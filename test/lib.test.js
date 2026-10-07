import test from 'node:test';
import assert from 'node:assert/strict';
import { signParams, verifyProxySignature } from '../server/proxy-signature.js';
import { formatDateTime, isWorkingTime, orderNumber } from '../server/hours.js';
import { applyStatus, buildOrderMessage, escapeHtml, statusKeyboard } from '../server/message.js';

test('підпис App Proxy: еталонний приклад з документації Shopify', () => {
  const params = new URLSearchParams(
    'extra=1&extra=2&shop=shop-name.myshopify.com&path_prefix=%2Fapps%2Fawesome_reviews&timestamp=1317327555',
  );
  // повідомлення: extra=1,2path_prefix=/apps/awesome_reviewsshop=shop-name.myshopify.comtimestamp=1317327555
  params.set('signature', signParams(params, 'hush'));
  assert.equal(verifyProxySignature(params, 'hush'), true);
  assert.equal(verifyProxySignature(params, 'other'), false);
  params.set('shop', 'evil.myshopify.com');
  assert.equal(verifyProxySignature(params, 'hush'), false);
  assert.equal(verifyProxySignature(new URLSearchParams('shop=x'), 'hush'), false);
});

test('робочі години Києва (літній і зимовий час)', () => {
  const cfg = { workStart: 10, workEnd: 20, timezone: 'Europe/Kyiv' };
  // 2025-07-01 06:59Z = 09:59 Київ (UTC+3)
  assert.equal(isWorkingTime(new Date('2025-07-01T06:59:00Z'), cfg), false);
  assert.equal(isWorkingTime(new Date('2025-07-01T07:00:00Z'), cfg), true);
  assert.equal(isWorkingTime(new Date('2025-07-01T16:59:00Z'), cfg), true);
  assert.equal(isWorkingTime(new Date('2025-07-01T17:00:00Z'), cfg), false);
  // зима UTC+2: 2025-01-15 08:00Z = 10:00
  assert.equal(isWorkingTime(new Date('2025-01-15T08:00:00Z'), cfg), true);
});

test('номер і дата замовлення', () => {
  const d = new Date('2025-10-05T18:34:05Z'); // 21:34:05 Київ
  assert.equal(orderNumber(d, 'Europe/Kyiv'), '20251005-213405');
  assert.equal(formatDateTime(d, 'Europe/Kyiv'), '05.10.2025 21:34');
});

test('повідомлення: екранує HTML і містить ключові поля', () => {
  const text = buildOrderMessage({
    orderNumber: '1', when: '05.10.2025 21:34', afterHours: true,
    productTitle: 'Футболка <b>X</b>', options: [{ name: 'Розмір', value: 'S' }],
    quantity: 2, totalCents: 178000, currency: 'UAH', name: 'A & B', phone: '+380671234567',
  });
  assert.match(text, /Футболка &lt;b&gt;X&lt;\/b&gt;/);
  assert.match(text, /A &amp; B/);
  assert.match(text, /поза робочим часом/);
  assert.match(text, /Розмір: S/);
  assert.equal(escapeHtml('<&>'), '&lt;&amp;&gt;');
});

test('статус: додається, замінюється і скидається; entities не ламаються', () => {
  const original = { text: 'Заголовок\nТовар', entities: [{ type: 'bold', offset: 0, length: 9 }] };
  const taken = applyStatus(original, 'taken', 'Оля', '12:30');
  assert.match(taken.text, /\n\nСтатус: ✅ В роботі — Оля, 12:30$/);
  assert.deepEqual(taken.entities, original.entities);

  const spam = applyStatus(taken, 'spam', 'Ігор', '12:31');
  assert.equal(spam.text.match(/Статус:/g).length, 1);
  assert.match(spam.text, /❌ Спам/);

  assert.equal(applyStatus(spam, 'reset', 'x', 'y').text, original.text);
});

test('клавіатура статусу зберігає кнопки товару та чатів', () => {
  const existing = { inline_keyboard: [
    [{ text: '🔗 Товар', url: 'https://x.test' }],
    [{ text: 'TG', url: 'https://t.me/+1' }, { text: 'VB', url: 'https://qo.test/viber/1' }],
    [{ text: 'a', callback_data: 'st:taken' }],
  ] };
  const kb = statusKeyboard('taken', existing);
  assert.equal(kb.inline_keyboard[0][0].url, 'https://x.test');
  assert.equal(kb.inline_keyboard[1].length, 2);
  const callbacks = kb.inline_keyboard.slice(2).flat().map((b) => b.callback_data);
  assert.deepEqual(callbacks, ['st:no_answer', 'st:confirmed', 'st:shipped', 'st:cancelled', 'st:spam', 'st:reset']);
  const fresh = statusKeyboard('reset', existing).inline_keyboard.slice(2).flat().map((b) => b.callback_data);
  assert.deepEqual(fresh, ['st:taken', 'st:spam']);
});

import { loadConfig } from '../server/config.js';

test('конфіг обрізає пробіли й переноси рядків у змінних', () => {
  const cfg = loadConfig({
    SHOPIFY_SHOP: ' shop.myshopify.com\n',
    SHOPIFY_API_SECRET: ' shpss_abc \n',
    TELEGRAM_BOT_TOKEN: 'tok ',
    TELEGRAM_CHAT_ID: '-1',
    TELEGRAM_WEBHOOK_SECRET: 's',
  });
  assert.equal(cfg.apiSecret, 'shpss_abc');
  assert.equal(cfg.shop, 'shop.myshopify.com');
  assert.equal(cfg.telegramToken, 'tok');
});

test('зріст і вага з підбору розміру: валідуються, показуються менеджеру', async () => {
  const { cleanBody } = await import('../server/validate.js');
  const { buildOrderMessage } = await import('../server/message.js');
  assert.deepEqual(cleanBody({ height: '180', weight: 75.4 }), { height: 180, weight: 75 });
  for (const bad of [null, {}, { height: 80, weight: 70 }, { height: 180, weight: 500 }, { height: 'x', weight: 70 }]) assert.equal(cleanBody(bad), null);
  const text = buildOrderMessage({ orderNumber: '1', when: 'x', productTitle: 'T', options: [], quantity: 1, totalCents: 100, name: 'Іван', surname: 'Петренко', phone: '+380', body: { height: 180, weight: 75 }, utm: {} });
  assert.match(text, /📏 Зріст 180 см, вага 75 кг/);
  assert.match(text, /Іван Петренко/);
});
