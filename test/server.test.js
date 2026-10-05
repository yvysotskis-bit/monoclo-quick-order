import test from 'node:test';
import assert from 'node:assert/strict';
import { call, goodBody, makeApp, signedUrl, submit } from './helpers.js';

test('healthz і status', async () => {
  const { app } = makeApp();
  assert.equal((await call(app, { method: 'GET', url: '/healthz' })).status, 200);
  const st = await call(app, { method: 'GET', url: '/status' });
  assert.equal(st.status, 200);
  assert.equal(st.json.pendingTelegram, 0);
});

test('успішне замовлення: ціна з магазину, одне повідомлення, кнопки чатів і статусів', async () => {
  const { app, fetchFn, store } = makeApp();
  const r = await submit(app, goodBody({ price: 1 }));
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.order_number, '20251005-150000');
  assert.equal(r.json.after_hours, false);

  const [msg] = fetchFn.tg('sendMessage');
  assert.equal(msg.body.chat_id, '-100500');
  assert.match(msg.body.text, /1[\s ]780/); // 2 × 890 ₴, а не 1
  assert.match(msg.body.text, /\+380671234567/);
  assert.match(msg.body.text, /Футболка &lt;Volvo&gt; FH16/);
  assert.match(msg.body.text, /Колір: Чорний/);
  assert.match(msg.body.text, /прямий візит/);
  const rows = msg.body.reply_markup.inline_keyboard;
  assert.equal(rows[1][0].url, 'https://t.me/+380671234567');
  assert.equal(rows[1][1].text, '💬 Viber');
  assert.equal(rows[1][1].url, 'https://qo.test/viber/380671234567');
  assert.ok(rows.flat().every((b) => !b.url || b.url.startsWith('https://')), 'Telegram приймає лише https-посилання');
  assert.equal(rows[2][0].callback_data, 'st:taken');

  const saved = store.getOrder(1);
  assert.equal(saved.tg_state, 'sent');
  assert.equal(saved.tg_message_id, 101);
  assert.equal(saved.crm_state, 'skipped');
});

test('місто, джерело трафіку і UTM у повідомленні', async () => {
  const { app, fetchFn } = makeApp();
  await submit(app, goodBody({
    city: 'Львів',
    utm: { source: 'facebook', medium: 'cpc', campaign: 'autumn' },
    referrer: 'instagram.com',
  }));
  const text = fetchFn.tg('sendMessage')[0].body.text;
  assert.match(text, /📍 Львів/);
  assert.match(text, /📈 facebook \/ cpc \/ autumn/);
});

test('поза робочим часом позначається', async () => {
  const { app, fetchFn } = makeApp({ at: '2025-10-05T21:30:00Z' });
  const r = await submit(app);
  assert.equal(r.json.after_hours, true);
  assert.match(fetchFn.tg('sendMessage')[0].body.text, /поза робочим часом/);
});

test('без підпису / з чужим магазином / з простроченим timestamp: відмова', async () => {
  const { app, fetchFn } = makeApp();
  assert.equal((await call(app, { url: '/proxy/submit', body: goodBody() })).status, 401);
  assert.equal((await call(app, { url: signedUrl('/proxy/submit', { shop: 'evil.myshopify.com' }), body: goodBody() })).status, 403);
  assert.equal((await call(app, { url: signedUrl('/proxy/submit', { timestamp: '1000' }), body: goodBody() })).status, 401);
  assert.equal(fetchFn.calls.length, 0);
});

test('валідація повертає поле', async () => {
  const { app } = makeApp();
  const r = await submit(app, goodBody({ phone: '12' }));
  assert.equal(r.status, 422);
  assert.equal(r.json.field, 'phone');
});

test('варіант, якого немає / розпродано / товар не знайдено', async () => {
  const { app } = makeApp();
  assert.equal((await submit(app, goodBody({ variant_id: 999 }))).status, 422);
  const sold = await submit(app, goodBody({ variant_id: 222, client_id: 'client-id-0002' }));
  assert.equal(sold.status, 409);
  assert.equal(sold.json.code, 'sold_out');
  const missing = makeApp({ fetchOpts: { productResponse: 404 } });
  assert.equal((await submit(missing.app)).status, 404);
});

test('повторна відправка не дублює повідомлення', async () => {
  const { app, fetchFn } = makeApp();
  const a = await submit(app);
  const b = await submit(app);
  assert.deepEqual(a.json, b.json);
  assert.equal(fetchFn.tg('sendMessage').length, 1);
});

test('honeypot: успіх для бота, але нічого не відправляється й не зберігається', async () => {
  const { app, fetchFn, store } = makeApp();
  const r = await submit(app, goodBody({ website: 'http://spam' }));
  assert.equal(r.status, 200);
  assert.equal(fetchFn.calls.length, 0);
  assert.equal(store.counts().pendingTelegram, 0);
});

test('ліміт за номером телефону', async () => {
  const { app } = makeApp();
  let last;
  for (let i = 0; i < 4; i += 1) {
    last = await submit(app, goodBody({ quantity: i + 1, client_id: `client-id-100${i}` }));
  }
  assert.equal(last.status, 429);
});

test('вебхук Telegram: секрет, зміна статусу в базі й повідомленні, чужий чат ігнорується', async () => {
  const { app, fetchFn, store } = makeApp();
  await submit(app);
  const update = (data, chat = -100500) => ({
    callback_query: {
      id: 'cb1', data, from: { first_name: 'Оля' },
      message: {
        message_id: 101, chat: { id: chat }, text: 'Замовлення', entities: [],
        reply_markup: { inline_keyboard: [[{ text: 'Товар', url: 'https://x.test' }]] },
      },
    },
  });
  assert.equal((await call(app, { url: '/telegram/webhook', body: update('st:taken') })).status, 401);

  const headers = { 'x-telegram-bot-api-secret-token': 'hook-secret' };
  const ok = await call(app, { url: '/telegram/webhook', body: update('st:taken'), headers });
  assert.equal(ok.status, 200);
  const edit = fetchFn.tg('editMessageText')[0];
  assert.match(edit.body.text, /Статус: ✅ В роботі — Оля, 15:00/);
  const callbacks = edit.body.reply_markup.inline_keyboard.flat().map((b) => b.callback_data).filter(Boolean);
  assert.ok(callbacks.includes('st:confirmed') && callbacks.includes('st:reset'));
  const order = store.getOrder(1);
  assert.equal(order.status, 'taken');
  assert.equal(order.status_by, 'Оля');
  assert.ok(order.first_response_at);

  const before = fetchFn.calls.length;
  await call(app, { url: '/telegram/webhook', body: update('st:spam', 42), headers });
  assert.equal(fetchFn.calls.length, before);
});

test('збій Telegram: замовлення збережено, клієнт отримує успіх, фонова черга доставляє пізніше', async () => {
  const { app, fetchFn, store, now } = makeApp();
  fetchFn.fail.telegram = true;
  const r = await submit(app);
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(store.getOrder(1).tg_state, 'pending');
  assert.equal(store.getOrder(1).tg_attempts, 1);
  assert.doesNotMatch(String(store.getOrder(1).tg_error), /TOKEN123/);

  // Рано: повторна спроба ще не настала
  await app.tick();
  assert.equal(store.getOrder(1).tg_attempts, 1);

  fetchFn.fail.telegram = false;
  now.advance(3 * 60_000);
  await app.tick();
  const order = store.getOrder(1);
  assert.equal(order.tg_state, 'sent');
  const sent = fetchFn.tg('sendMessage').at(-1).body.text;
  assert.match(sent, /надійшло із затримкою/);
});

test('/status повертає 503, якщо замовлення застрягло в черзі Telegram', async () => {
  const { app, fetchFn, now } = makeApp();
  fetchFn.fail.telegram = true;
  await submit(app);
  assert.equal((await call(app, { method: 'GET', url: '/status' })).status, 200);
  now.advance(11 * 60_000);
  const st = await call(app, { method: 'GET', url: '/status' });
  assert.equal(st.status, 503);
  assert.equal(st.json.ok, false);
});

test('/viber/<номер> віддає сторінку, що відкриває Viber; сміття відхиляється', async () => {
  const { app } = makeApp();
  const ok = await call(app, { method: 'GET', url: '/viber/380671234567' });
  assert.equal(ok.status, 200);
  assert.match(ok.headers['content-type'], /text\/html/);
  assert.match(ok.text, /viber:\/\/chat\?number=%2B380671234567/);
  for (const bad of ['/viber/abc', '/viber/12', '/viber/380671234567%22%3E%3Cscript%3E', '/viber/']) {
    assert.equal((await call(app, { method: 'GET', url: bad })).status, 404, bad);
  }
});
