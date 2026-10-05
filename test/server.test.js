import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';
import { call, config, goodBody, mockFetch, silentLog, signedUrl } from './helpers.js';

const make = (fetchOpts) => {
  const fetchFn = mockFetch(fetchOpts);
  const app = createApp({ config, fetchFn, log: silentLog, now: () => new Date('2025-10-05T12:00:00Z') });
  return { app, fetchFn };
};
const telegramCalls = (fetchFn) => fetchFn.calls.filter((c) => c.url.includes('api.telegram.org'));

test('healthz', async () => {
  const { app } = make();
  const r = await call(app, { method: 'GET', url: '/healthz' });
  assert.equal(r.status, 200);
});

test('успішне замовлення: ціна береться з магазину, в Telegram іде одне повідомлення', async () => {
  const { app, fetchFn } = make();
  const r = await call(app, { url: signedUrl(), body: goodBody({ price: 1 }) });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.order_number, '20251005-150000');
  assert.equal(r.json.after_hours, false);

  const [msg] = telegramCalls(fetchFn);
  assert.match(msg.url, /botTOKEN123\/sendMessage/);
  assert.equal(msg.body.chat_id, '-100500');
  assert.match(msg.body.text, /1[\s ]780/); // 2 × 890 ₴
  assert.match(msg.body.text, /\+380671234567/);
  assert.match(msg.body.text, /Футболка &lt;Volvo&gt; FH16/);
  assert.match(msg.body.text, /Колір: Чорний/);
  assert.equal(msg.body.reply_markup.inline_keyboard[1][0].callback_data, 'st:taken');
});

test('поза робочим часом позначається', async () => {
  const fetchFn = mockFetch();
  const app = createApp({ config, fetchFn, log: silentLog, now: () => new Date('2025-10-05T21:30:00Z') });
  const r = await call(app, { url: signedUrl(), body: goodBody() });
  assert.equal(r.json.after_hours, true);
  assert.match(telegramCalls(fetchFn)[0].body.text, /поза робочим часом/);
});

test('без підпису / з чужим магазином / з простроченим timestamp — відмова', async () => {
  const { app, fetchFn } = make();
  assert.equal((await call(app, { url: '/proxy/submit', body: goodBody() })).status, 401);
  assert.equal((await call(app, { url: signedUrl('/proxy/submit', { shop: 'evil.myshopify.com' }), body: goodBody() })).status, 403);
  assert.equal((await call(app, { url: signedUrl('/proxy/submit', { timestamp: '1000' }), body: goodBody() })).status, 401);
  assert.equal(telegramCalls(fetchFn).length, 0);
});

test('валідація повертає поле', async () => {
  const { app } = make();
  const r = await call(app, { url: signedUrl(), body: goodBody({ phone: '12' }) });
  assert.equal(r.status, 422);
  assert.equal(r.json.field, 'phone');
});

test('варіант, якого немає / розпродано', async () => {
  const { app } = make();
  assert.equal((await call(app, { url: signedUrl(), body: goodBody({ variant_id: 999 }) })).status, 422);
  const sold = await call(app, { url: signedUrl(), body: goodBody({ variant_id: 222, client_id: 'client-id-0002' }) });
  assert.equal(sold.status, 409);
  assert.equal(sold.json.code, 'sold_out');
});

test('товар не знайдено', async () => {
  const { app } = make({ productResponse: 404 });
  assert.equal((await call(app, { url: signedUrl(), body: goodBody() })).status, 404);
});

test('повторна відправка того самого замовлення не дублює повідомлення', async () => {
  const { app, fetchFn } = make();
  const a = await call(app, { url: signedUrl(), body: goodBody() });
  const b = await call(app, { url: signedUrl(), body: goodBody() });
  assert.deepEqual(a.json, b.json);
  assert.equal(telegramCalls(fetchFn).length, 1);
});

test('honeypot: успіх для бота, але нічого не відправляється', async () => {
  const { app, fetchFn } = make();
  const r = await call(app, { url: signedUrl(), body: goodBody({ website: 'http://spam' }) });
  assert.equal(r.status, 200);
  assert.equal(fetchFn.calls.length, 0);
});

test('збій Telegram → 502, а токен не витікає у відповідь', async () => {
  const { app } = make({ telegramOk: false });
  const r = await call(app, { url: signedUrl(), body: goodBody() });
  assert.equal(r.status, 502);
  assert.doesNotMatch(JSON.stringify(r.json), /TOKEN123/);
});

test('ліміт за номером телефону', async () => {
  const { app } = make();
  let last;
  for (let i = 0; i < 4; i++) {
    last = await call(app, { url: signedUrl(), body: goodBody({ quantity: i + 1, client_id: `client-id-100${i}` }) });
  }
  assert.equal(last.status, 429);
});

test('вебхук Telegram: потрібен секрет; статус оновлює повідомлення', async () => {
  const { app, fetchFn } = make();
  const update = {
    callback_query: {
      id: 'cb1',
      data: 'st:taken',
      from: { first_name: 'Оля' },
      message: {
        message_id: 7,
        chat: { id: -100500 },
        text: 'Замовлення',
        entities: [],
        reply_markup: { inline_keyboard: [[{ text: 'Товар', url: 'https://x.test' }]] },
      },
    },
  };
  assert.equal((await call(app, { url: '/telegram/webhook', body: update })).status, 401);

  const ok = await call(app, {
    url: '/telegram/webhook',
    body: update,
    headers: { 'x-telegram-bot-api-secret-token': 'hook-secret' },
  });
  assert.equal(ok.status, 200);
  const edit = telegramCalls(fetchFn).find((c) => c.url.endsWith('/editMessageText'));
  assert.match(edit.body.text, /Статус: ✅ В роботі — Оля, 15:00/);
  assert.equal(edit.body.reply_markup.inline_keyboard[1][0].callback_data, 'st:reset');
});

test('вебхук Telegram: чужий чат ігнорується', async () => {
  const { app, fetchFn } = make();
  await call(app, {
    url: '/telegram/webhook',
    headers: { 'x-telegram-bot-api-secret-token': 'hook-secret' },
    body: { callback_query: { id: 'x', data: 'st:spam', message: { message_id: 1, chat: { id: 42 }, text: 't' } } },
  });
  assert.equal(fetchFn.calls.length, 0);
});
