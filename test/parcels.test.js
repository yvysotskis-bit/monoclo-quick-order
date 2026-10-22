import test from 'node:test';
import assert from 'node:assert/strict';
import { npDateKey } from '../server/novaposhta.js';
import { buildStorageReminder } from '../server/message.js';
import { NP, call, goodBody, makeApp, signMono, submit } from './helpers.js';

const cfg = { monobankToken: 'M', novaPoshtaApiKey: 'npkey', keycrmToken: 'crm', publicUrl: 'https://qo.test' };
const headers = { 'x-telegram-bot-api-secret-token': 'hook-secret' };
const city = { ref: NP.city, name: 'Чернівці', present: 'м. Чернівці', area: 'Чернівецька' };
const warehouse = { method: 'warehouse', city, point: { ref: NP.branch, number: '3', name: 'Відділення №3' } };
const press = (app, data) => call(app, {
  url: '/telegram/webhook', headers,
  body: { callback_query: { id: 'cb', data, from: { id: 55, first_name: 'Оля' }, message: { message_id: 101, chat: { id: -100500 }, text: 'T', entities: [] } } },
});
const pay = (app, invoiceId, amount) => {
  const raw = JSON.stringify({ invoiceId, status: 'success', amount });
  return call(app, { url: '/mono/webhook', rawBody: raw, headers: { 'x-sign': signMono(raw) } });
};

async function orderWithTtn() {
  const ctx = makeApp({ cfg, at: '2025-10-05T12:00:00Z' });
  await submit(ctx.app, goodBody({ surname: 'Петренко', delivery: warehouse }));
  await press(ctx.app, 'pay:full');
  await pay(ctx.app, 'inv-1', 178000);
  await press(ctx.app, 'ttn:1');
  const ttn = ctx.store.getOrder(1).ttn_number;
  assert.ok(ttn);
  return { ...ctx, ttn };
}

const storageMessages = (fetchFn) => fetchFn.tg('sendMessage').filter((c) => /чекає у відділенні/.test(c.body.text));

test('npDateKey: формати дат Нової пошти', () => {
  assert.equal(npDateKey('2026-10-02 08:50:08'), '2026-10-02');
  assert.equal(npDateKey('02.10.2026 18:04:37'), '2026-10-02');
  assert.equal(npDateKey('02-10-2026 18:04:37'), '2026-10-02');
  assert.equal(npDateKey(''), '');
  assert.equal(npDateKey('0001-01-01 00:00:00'), '', 'порожня дата Нової пошти не є датою');
  assert.equal(npDateKey('01.01.0001 00:00:00'), '');
  assert.equal(npDateKey(null), '');
});

test('повідомлення про зберігання: до початку, у день початку, після', () => {
  const base = { orderNumber: '20251005-1', ttn: '2045', name: 'Іван', phone: '+380671234567', todayKey: '2025-10-10' };
  assert.match(buildStorageReminder({ ...base, paidFromKey: '2025-10-11' }), /почнеться <b>11\.10\.2025<\/b>/);
  assert.match(buildStorageReminder({ ...base, paidFromKey: '2025-10-10' }), /сьогодні/);
  assert.match(buildStorageReminder({ ...base, paidFromKey: '2025-10-08' }), /вже триває з <b>08\.10\.2025<\/b>/);
});

test('посилка у відділенні, платне зберігання завтра: одне нагадування менеджеру', async () => {
  const { app, fetchFn, now, ttn, store } = await orderWithTtn();
  now.advance(31 * 60_000);
  fetchFn.npTrack[ttn] = { StatusCode: '7', DatePayedKeeping: '2025-10-06 00:00:00' };
  await app.tick();
  const msgs = storageMessages(fetchFn);
  assert.equal(msgs.length, 1);
  assert.match(msgs[0].body.text, new RegExp(ttn));
  assert.equal(store.getOrder(1).np_storage_notified, 1);
  assert.equal(store.getOrder(1).np_status_code, '7');

  now.advance(31 * 60_000);
  await app.tick();
  assert.equal(storageMessages(fetchFn).length, 1, 'повторного нагадування немає');
});

test('ще в дорозі або зберігання не скоро: нагадування немає', async () => {
  const { app, fetchFn, now, ttn } = await orderWithTtn();
  now.advance(31 * 60_000);
  fetchFn.npTrack[ttn] = { StatusCode: '5', DatePayedKeeping: '2025-10-06' };
  await app.tick();
  fetchFn.npTrack[ttn] = { StatusCode: '7', DatePayedKeeping: '2025-10-20' };
  now.advance(31 * 60_000);
  await app.tick();
  assert.equal(storageMessages(fetchFn).length, 0);
});

test('отримана посилка більше не опитується; опитування не частіше за 30 хв', async () => {
  const { app, fetchFn, now, ttn } = await orderWithTtn();
  now.advance(31 * 60_000);
  fetchFn.npTrack[ttn] = { StatusCode: '9', DatePayedKeeping: '' };
  await app.tick();
  const polls = fetchFn.npTracked.length;
  assert.equal(polls, 1);
  now.advance(5 * 60_000);
  await app.tick();
  assert.equal(fetchFn.npTracked.length, polls, 'інтервал 30 хв');
  now.advance(31 * 60_000);
  await app.tick();
  assert.equal(fetchFn.npTracked.length, polls, 'статус 9 — кінцевий');
});

test('збій Нової пошти під час опитування не ламає tick', async () => {
  const { app, fetchFn, now } = await orderWithTtn();
  now.advance(31 * 60_000);
  fetchFn.fail.novaposhta = true;
  await app.tick();
  assert.equal(storageMessages(fetchFn).length, 0);
});

test('порожня дата платного зберігання (0001-01-01) не породжує нагадування про «зберігання з 01.01.0001»', async () => {
  const { app, fetchFn, now, ttn } = await orderWithTtn();
  now.advance(31 * 60_000);
  fetchFn.npTrack[ttn] = { StatusCode: '7', DatePayedKeeping: '0001-01-01 00:00:00' };
  await app.tick();
  assert.equal(storageMessages(fetchFn).length, 0);
});

test('«номер не знайдено» (код 3) відразу після створення не робить накладну кінцевою: опитування триває', async () => {
  const { app, fetchFn, now, ttn, store } = await orderWithTtn();
  now.advance(31 * 60_000);
  fetchFn.npTrack[ttn] = { StatusCode: '3', DatePayedKeeping: '' };
  await app.tick();
  assert.equal(fetchFn.npTracked.length, 1);
  now.advance(31 * 60_000);
  fetchFn.npTrack[ttn] = { StatusCode: '7', DatePayedKeeping: '2025-10-06' };
  await app.tick();
  assert.equal(fetchFn.npTracked.length, 2, 'накладну опитали ще раз');
  assert.equal(storageMessages(fetchFn).length, 1);
  assert.equal(store.getOrder(1).np_status_code, '7');
});

test('накладних більше, ніж влізає в один запит: опитування йде по черзі, жодна не залишається без уваги', async () => {
  const ctx = makeApp({ cfg: { ...cfg, npTrackBatch: 1 }, at: '2025-10-05T12:00:00Z' });
  for (const [i, phone] of [[1, '+380671000001'], [2, '+380671000002']]) {
    await submit(ctx.app, goodBody({ phone, surname: 'Петренко', client_id: `client-rot-${i}-0000`, delivery: warehouse }));
    ctx.store.db.prepare('UPDATE orders SET ttn_number = ? WHERE id = ?').run(`2045000000000${i}`, i);
  }
  for (let round = 0; round < 2; round += 1) {
    ctx.now.advance(31 * 60_000);
    await ctx.app.tick();
  }
  const asked = ctx.fetchFn.npTracked.flat().map((d) => d.DocumentNumber);
  assert.deepEqual([...new Set(asked)].sort(), ['20450000000001', '20450000000002']);
});

test('накладні старші за 60 днів більше не опитуються', async () => {
  const { app, fetchFn, now, store } = await orderWithTtn();
  store.db.prepare('UPDATE orders SET created_at = ? WHERE id = 1').run(now().getTime() - 61 * 24 * 3600e3);
  now.advance(31 * 60_000);
  await app.tick();
  assert.equal(fetchFn.npTracked.length, 0);
});
