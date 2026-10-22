import test from 'node:test';
import assert from 'node:assert/strict';
import { levelFor, parseLevels } from '../server/loyalty.js';
import { NP, call, goodBody, makeApp, signMono, signedUrl, submit } from './helpers.js';

const cfg = { monobankToken: 'M', novaPoshtaApiKey: 'npkey', keycrmToken: 'crm', publicUrl: 'https://qo.test', loyaltyLevels: parseLevels('2:Пілот,4:Чемпіон'), communityMinCity: 3 };
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

// Замовлення, яке вважається купленим (оплачено)
async function purchase(ctx, i, over = {}) {
  const res = await submit(ctx.app, goodBody({ phone: '+380671000000'.slice(0, -String(i).length) + i, client_id: `client-comm-${String(i).padStart(4, '0')}`, delivery: warehouse, quantity: (i % 9) + 1, ...over }));
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const id = ctx.store.db.prepare('SELECT MAX(id) AS id FROM orders').get().id;
  ctx.store.db.prepare('UPDATE orders SET pay_paid_at = 1 WHERE id = ?').run(id);
  return id;
}

const get = (app, path) => call(app, { method: 'GET', url: signedUrl(path) });

test('parseLevels і levelFor', () => {
  assert.deepEqual(parseLevels('2:Пілот, 4:Чемпіон,1:Новачок,сміття'), [{ min: 2, name: 'Пілот' }, { min: 4, name: 'Чемпіон' }]);
  const levels = parseLevels('2:Пілот,4:Чемпіон');
  assert.equal(levelFor(levels, 1), null);
  assert.equal(levelFor(levels, 3).name, 'Пілот');
  assert.equal(levelFor(levels, 9).name, 'Чемпіон');
});

test('мапа: місто з достатньою кількістю покупців малюється, а дрібні міста лише рахуються; без підпису 401', async () => {
  const ctx = makeApp({ cfg });
  for (let i = 1; i <= 3; i += 1) await purchase(ctx, i);
  await ctx.app.tick();
  const owners = (await get(ctx.app, '/proxy/owners')).json;
  assert.equal(owners.owners, 3);
  assert.equal(owners.points.length, 1);
  assert.equal(owners.points[0].name, 'Чернівці');
  assert.equal(owners.points[0].n, 3);
  assert.ok(owners.points[0].lat > 48 && owners.points[0].lon > 25);
  const page = await get(ctx.app, '/proxy/map');
  assert.equal(page.status, 200);
  assert.match(page.text, /Де носять Monoclo/);
  assert.match(page.text, /<circle/);
  assert.match(page.text, /Чернівці/);
  assert.equal((await call(ctx.app, { method: 'GET', url: '/proxy/map' })).status, 401);

  const small = makeApp({ cfg });
  for (let i = 1; i <= 2; i += 1) await purchase(small, i);
  await small.app.tick();
  const hiddenOwners = (await get(small.app, '/proxy/owners')).json;
  assert.equal(hiddenOwners.points.length, 0);
  assert.equal(hiddenOwners.hidden, 1);
  const smallPage = (await get(small.app, '/proxy/map')).text;
  assert.doesNotMatch(smallPage, /Чернівці/, 'мале місто не називаємо');
  assert.match(smallPage, /Мапа наповнюється/);
});

test('постійний клієнт: у картці нового замовлення видно номер замовлення й рівень', async () => {
  const ctx = makeApp({ cfg });
  const phone = '+380671234567';
  await purchase(ctx, 1, { phone });
  await submit(ctx.app, goodBody({ phone, client_id: 'client-comm-repeat', quantity: 4, delivery: warehouse }));
  const card = ctx.fetchFn.sentMessages.at(-1).text;
  assert.match(card, /🏁 Постійний клієнт: це 2-те замовлення · рівень «Пілот»/);
  const first = ctx.fetchFn.sentMessages[0].text;
  assert.doesNotMatch(first, /Постійний клієнт/);
});

test('ТТН на замовленні, що підняло рівень: нагадування покласти нашивку, а на звичайному ні', async () => {
  const ctx = makeApp({ cfg });
  const phone = '+380671234567';
  await purchase(ctx, 1, { phone });
  await submit(ctx.app, goodBody({ phone, surname: 'Петренко', client_id: 'client-comm-patch', quantity: 3, delivery: warehouse }));
  await press(ctx.app, 'pay:full');
  await pay(ctx.app, 'inv-2', 267000);
  const second = ctx.store.db.prepare('SELECT MAX(id) AS id FROM orders').get().id;
  await press(ctx.app, `ttn:${second}`);
  const ttnText = ctx.fetchFn.sentMessages.map((m) => m.text).find((t) => /ТТН Нової пошти створено/.test(t) && /Пілот/.test(t));
  assert.ok(ttnText, 'нашивка «Пілот» на другому замовленні');
  assert.match(ttnText, /2-те замовлення клієнта/);

  // Третє замовлення того ж клієнта лишається на тому ж рівні: нашивки немає
  await submit(ctx.app, goodBody({ phone, surname: 'Петренко', client_id: 'client-comm-patch3', quantity: 5, delivery: warehouse }));
  const third = ctx.store.db.prepare('SELECT MAX(id) AS id FROM orders').get().id;
  ctx.store.db.prepare('UPDATE orders SET pay_paid_at = 1 WHERE id = ?').run(third);
  await press(ctx.app, `ttn:${third}`);
  const lastTtn = ctx.fetchFn.sentMessages.map((m) => m.text).filter((t) => /ТТН Нової пошти створено/.test(t)).at(-1);
  assert.doesNotMatch(lastTtn, /нашивку/);
});
