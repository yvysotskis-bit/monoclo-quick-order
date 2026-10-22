import test from 'node:test';
import assert from 'node:assert/strict';
import { call, goodBody, makeApp, signedUrl, submit } from './helpers.js';

const body = { height: 180, weight: 80 };

// Створює замовлення через форму й виставляє розмір та «куплено» напряму в базі
async function seed(ctx, i, { size = 'L', paid = true, np = null, phone = `+38067100${String(1000 + i)}`, title = null, b = body } = {}) {
  const res = await submit(ctx.app, goodBody({ phone, client_id: `client-size-${String(i).padStart(4, '0')}`, quantity: (i % 9) + 1, body: b }));
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const id = ctx.store.db.prepare('SELECT MAX(id) AS id FROM orders').get().id;
  const order = ctx.store.getOrder(id);
  const data = { ...order.data, options: [{ name: 'Колір', value: 'Чорний' }, { name: 'Розмір', value: size }], ...(title ? { productTitle: title } : {}) };
  ctx.store.db.prepare('UPDATE orders SET data = ?, pay_paid_at = ?, np_status_code = ? WHERE id = ?').run(JSON.stringify(data), paid ? 1 : null, np, id);
  return id;
}

const ask = (app, params) => call(app, { method: 'GET', url: signedUrl('/proxy/size', params) });
const last = (app, phone) => call(app, { url: signedUrl('/proxy/lastsize'), body: { phone } });

test('підбір розміру: більшість схожих покупців і частка', async () => {
  const ctx = makeApp();
  for (let i = 0; i < 6; i += 1) await seed(ctx, i, { size: 'L', b: { height: 179 + (i % 2), weight: 79 + (i % 3) } });
  for (let i = 6; i < 8; i += 1) await seed(ctx, i, { size: 'M', b: { height: 181, weight: 78 } });
  const r = await ask(ctx.app, { height: '180', weight: '80', handle: 'tee', title: 'Футболка', sizes: 'S,M,L,XL' });
  assert.equal(r.json.size, 'L');
  assert.equal(r.json.share, 75);
  assert.equal(r.json.n, 8);
});

test('підбір розміру: замало даних, повернення, неоплачені й розмиті розподіли не враховуються', async () => {
  const ctx = makeApp();
  for (let i = 0; i < 4; i += 1) await seed(ctx, i, { size: 'L' });
  assert.equal((await ask(ctx.app, { height: '180', weight: '80', handle: 'tee', title: 'Футболка' })).json.size, null, 'лише 4 покупки');

  await seed(ctx, 4, { size: 'L', np: '102' });
  await seed(ctx, 5, { size: 'L', paid: false });
  assert.equal((await ask(ctx.app, { height: '180', weight: '80', handle: 'tee', title: 'Футболка' })).json.size, null, 'повернення й неоплачені не рахуються');

  await seed(ctx, 6, { size: 'L' });
  assert.equal((await ask(ctx.app, { height: '180', weight: '80', handle: 'tee', title: 'Футболка' })).json.size, null, 'вибірка кешується на хвилину');
  ctx.now.advance(61_000);
  assert.equal((await ask(ctx.app, { height: '180', weight: '80', handle: 'tee', title: 'Футболка' })).json.size, 'L');

  const mixed = makeApp();
  const sizes = ['S', 'M', 'L', 'XL', 'XXL', 'S', 'M', 'L', 'XL', 'XXL'];
  for (let i = 0; i < sizes.length; i += 1) await seed(mixed, i, { size: sizes[i] });
  assert.equal((await ask(mixed.app, { height: '180', weight: '80', handle: 'tee', title: 'Футболка' })).json.size, null, 'жоден розмір не переважає');
});

test('підбір розміру: розмір, якого немає в товару, пропускається; поза межами зросту нічого', async () => {
  const ctx = makeApp();
  for (let i = 0; i < 6; i += 1) await seed(ctx, i, { size: 'XL' });
  for (let i = 6; i < 12; i += 1) await seed(ctx, i, { size: 'L' });
  const r = await ask(ctx.app, { height: '180', weight: '80', handle: 'tee', title: 'Футболка', sizes: 'S,M,L' });
  assert.equal(r.json.size, 'L');
  assert.equal((await ask(ctx.app, { height: '90', weight: '80', handle: 'tee', title: 'Футболка' })).json.size, null);
});

test('підбір розміру: без підпису App Proxy — 401', async () => {
  const { app } = makeApp();
  const r = await call(app, { method: 'GET', url: '/proxy/size?height=180&weight=80' });
  assert.equal(r.status, 401);
});

test('розмір як минулого разу: окремо для футболок і худі, лише куплене й не повернуте (XL повернули — береться попередній M)', async () => {
  const ctx = makeApp();
  const phone = '+380671234567';
  await seed(ctx, 1, { size: 'M', phone });
  await seed(ctx, 2, { size: 'L', phone, title: 'Худі Volvo' });
  await seed(ctx, 3, { size: 'XL', phone, np: '103' });
  const r = await last(ctx.app, '+38 (067) 123 45 67');
  assert.deepEqual(r.json.sizes, { tee: 'M', hoodie: 'L' });
  assert.deepEqual((await last(ctx.app, '+380991112233')).json.sizes, {});
  assert.deepEqual((await last(ctx.app, 'abc')).json.sizes, {});
});

test('розмір як минулого разу: суворий ліміт запитів і підпис', async () => {
  const ctx = makeApp();
  for (let i = 0; i < 10; i += 1) assert.equal((await last(ctx.app, '+380671234567')).status, 200);
  assert.equal((await last(ctx.app, '+380671234567')).status, 429);
  assert.equal((await call(ctx.app, { url: '/proxy/lastsize', body: { phone: '+380671234567' } })).status, 401);
});

test('розмір як минулого разу: загальна стеля запитів на всіх адресах', async () => {
  const ctx = makeApp();
  let ok = 0;
  let limited = 0;
  for (let i = 0; i < 320; i += 1) {
    const res = await call(ctx.app, { url: signedUrl('/proxy/lastsize'), body: { phone: '+380671234567' }, ip: `10.0.${Math.floor(i / 250)}.${i % 250}` });
    if (res.status === 200) ok += 1; else if (res.status === 429) limited += 1;
  }
  assert.equal(ok, 300);
  assert.equal(limited, 20);
});
