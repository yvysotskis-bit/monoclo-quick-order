import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanDelivery } from '../server/validate.js';
import { NP, call, goodBody, makeApp, signedUrl, submit } from './helpers.js';

const npCfg = { novaPoshtaApiKey: 'NPKEY' };
const get = (app, path, extra) => call(app, { method: 'GET', url: signedUrl(path, extra) });

test('без ключа Нової пошти підказки недоступні (форма працює з ручним введенням)', async () => {
  const { app, fetchFn } = makeApp();
  const r = await get(app, '/proxy/np/cities', { q: 'Черн' });
  assert.equal(r.status, 503);
  assert.equal(r.json.code, 'np_disabled');
  assert.equal(fetchFn.np, 0);
});

test('підказки Нової пошти вимагають підпису App Proxy і свого магазину', async () => {
  const { app, fetchFn } = makeApp({ cfg: npCfg });
  assert.equal((await call(app, { method: 'GET', url: '/proxy/np/cities?q=Черн' })).status, 401);
  assert.equal((await get(app, '/proxy/np/cities', { q: 'Черн', shop: 'evil.myshopify.com' })).status, 401);
  assert.equal(fetchFn.np, 0);
});

test('міста: нормалізація, короткий запит порожній, повторний запит береться з кешу', async () => {
  const { app, fetchFn } = makeApp({ cfg: npCfg });
  const r = await get(app, '/proxy/np/cities', { q: 'Черн' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.items[0], {
    ref: NP.city, name: 'Чернівці', present: 'м. Чернівці, Чернівецька обл.', area: 'Чернівецька', region: '', warehouses: 58,
  });
  assert.equal(r.json.items.length, 2);
  assert.equal(fetchFn.calls.find((c) => c.url.includes('novaposhta')).body.apiKey, 'NPKEY');

  await get(app, '/proxy/np/cities', { q: 'черн' }); // той самий запит, інший регістр
  assert.equal(fetchFn.np, 1, 'кеш');

  const short = await get(app, '/proxy/np/cities', { q: 'Ч' });
  assert.deepEqual(short.json.items, []);
  assert.equal(fetchFn.np, 1);
});

test('відділення: лише відділення, пошук за рядком, поштомати окремо', async () => {
  const { app } = makeApp({ cfg: npCfg });
  const branches = await get(app, '/proxy/np/points', { settlement: NP.city, kind: 'warehouse' });
  assert.deepEqual(branches.json.items.map((p) => p.number), ['3', '12']);
  assert.ok(branches.json.items.every((p) => p.kind === 'branch'));
  assert.ok(!branches.json.items.some((p) => p.ref === NP.leak), 'поштомат не потрапляє у відділення');

  const filtered = await get(app, '/proxy/np/points', { settlement: NP.city, kind: 'warehouse', q: 'Незалежності' });
  assert.deepEqual(filtered.json.items.map((p) => p.number), ['12']);

  const postomats = await get(app, '/proxy/np/points', { settlement: NP.city, kind: 'postomat' });
  assert.equal(postomats.json.items.length, 1);
  assert.equal(postomats.json.items[0].kind, 'postomat');
  assert.match(postomats.json.items[0].name, /Поштомат/);

  const bad = await get(app, '/proxy/np/points', { settlement: 'not-a-uuid' });
  assert.equal(bad.status, 422);
});

test('вулиці для адресної доставки', async () => {
  const { app } = makeApp({ cfg: npCfg });
  const r = await get(app, '/proxy/np/streets', { settlement: NP.city, q: 'Гол' });
  assert.deepEqual(r.json.items, [{ ref: NP.street, name: 'вул. Головна' }]);
  assert.deepEqual((await get(app, '/proxy/np/streets', { settlement: NP.city, q: 'Г' })).json.items, []);
});

test('збій Нової пошти → 502 без витоку ключа; ліміт запитів → 429', async () => {
  const { app, fetchFn } = makeApp({ cfg: npCfg });
  fetchFn.fail.novaposhta = true;
  const r = await get(app, '/proxy/np/cities', { q: 'Київ' });
  assert.equal(r.status, 502);
  assert.equal(r.json.code, 'upstream');
  assert.doesNotMatch(JSON.stringify(r.json), /NPKEY/);

  fetchFn.fail.novaposhta = false;
  let last;
  for (let i = 0; i < 125; i += 1) last = await get(app, '/proxy/np/cities', { q: `Місто${i}` });
  assert.equal(last.status, 429);
});

test('очищення доставки: сміттєві ідентифікатори відкидаються, розмітка прибирається, порожнє дає null', () => {
  assert.equal(cleanDelivery(null), null);
  assert.equal(cleanDelivery({ method: 'warehouse', city: {}, point: {} }), null);
  const d = cleanDelivery({
    method: 'hack',
    city: { ref: 'not-a-uuid', name: '<b>Київ</b>' },
    point: { ref: NP.branch, name: 'Відділення №1' },
    street: { name: 'вул. Головна' },
    house: '5<script>',
  });
  assert.equal(d.method, '');
  assert.equal(d.city.ref, '');
  assert.equal(d.city.name, 'b Київ /b');
  assert.equal(d.point.ref, NP.branch);
  assert.equal(d.house, '5 script');
});

const warehouseDelivery = {
  method: 'warehouse',
  city: { ref: NP.city, name: 'Чернівці', present: 'м. Чернівці, Чернівецька обл.', area: 'Чернівецька' },
  point: { ref: NP.branch, number: '3', name: 'Відділення №3: вул. Ольги Кобилянської, 1' },
};

test('замовлення з відділенням: Telegram, KeyCRM (поля доставки + коментар)', async () => {
  const { app, fetchFn, store } = makeApp({
    cfg: { keycrmToken: 'CRMTOKEN', keycrmNovaPoshtaServiceId: 2 },
  });
  await submit(app, goodBody({ delivery: warehouseDelivery }));

  const text = fetchFn.tg('sendMessage')[0].body.text;
  assert.match(text, /📍 м\. Чернівці, Чернівецька обл\./);
  assert.match(text, /🚚 Нова пошта: Відділення №3: вул\. Ольги Кобилянської, 1/);
  assert.equal(store.getOrder(1).data.city, 'Чернівці');

  const shipping = fetchFn.crm()[0].body.shipping;
  assert.deepEqual(shipping, {
    shipping_address_city: 'Чернівці',
    shipping_address_region: 'Чернівецька',
    shipping_service: 'Нова пошта',
    delivery_service_id: 2,
    recipient_full_name: 'Іван',
    recipient_phone: '+380671234567',
    shipping_receive_point: 'Відділення №3: вул. Ольги Кобилянської, 1',
    warehouse_ref: NP.branch,
  });
  assert.match(fetchFn.crm()[0].body.manager_comment, /🚚 Нова пошта: Відділення №3/);
});

test('замовлення з поштоматом і з адресною доставкою', async () => {
  const post = makeApp({ cfg: { keycrmToken: 'T' } });
  await submit(post.app, goodBody({
    delivery: { ...warehouseDelivery, method: 'postomat', point: { ref: NP.postomat, number: '4101', name: 'Поштомат "Нова Пошта" №4101: вул. Головна, 12' } },
  }));
  assert.match(post.fetchFn.tg('sendMessage')[0].body.text, /🚚 Нова пошта: Поштомат/);
  assert.equal(post.fetchFn.crm()[0].body.shipping.warehouse_ref, NP.postomat);

  const courier = makeApp({ cfg: { keycrmToken: 'T' } });
  await submit(courier.app, goodBody({
    delivery: { method: 'courier', city: warehouseDelivery.city, street: { ref: NP.street, name: 'вул. Головна' }, house: '5', apartment: '12' },
  }));
  assert.match(courier.fetchFn.tg('sendMessage')[0].body.text, /🚚 Нова пошта, адресна доставка: вул\. Головна, буд\. 5, кв\. 12/);
  const shipping = courier.fetchFn.crm()[0].body.shipping;
  assert.equal(shipping.shipping_secondary_line, 'вул. Головна, буд. 5, кв. 12');
  assert.equal(shipping.shipping_receive_point, undefined);
});

test('місто, введене вручну (без вибору зі списку), все одно доходить', async () => {
  const { app, fetchFn } = makeApp();
  await submit(app, goodBody({ city: 'Хмельницький' }));
  assert.match(fetchFn.tg('sendMessage')[0].body.text, /📍 Хмельницький/);
});

test('KeyCRM відхилив поля доставки (422): замовлення створюється без них, доставка лишається в коментарі', async () => {
  const { app, fetchFn, store } = makeApp({ cfg: { keycrmToken: 'T' } });
  fetchFn.fail.keycrmShipping = true;
  await submit(app, goodBody({ delivery: warehouseDelivery }));

  assert.equal(store.getOrder(1).crm_state, 'sent');
  const attempts = fetchFn.crm().filter((c) => c.method === 'POST' && c.url.endsWith('/v1/order'));
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[1].body.shipping, { shipping_address_city: 'Чернівці' });
  assert.match(attempts[1].body.manager_comment, /Відділення №3/);
});

test('поштомати: якщо фільтр за типом нічого не дав, добираємо з усіх точок міста і шукаємо за номером', async () => {
  const { createNovaPoshta } = await import('../server/novaposhta.js');
  const calls = [];
  const fetchFn = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body.methodProperties);
    const rows = body.methodProperties.TypeOfWarehouseRef
      ? []
      : [
        { Ref: 'r1', Number: '65634', Description: 'Поштомат "Нова Пошта" №65634: вул. Головна, 1', ShortAddress: 'вул. Головна, 1', CategoryOfWarehouse: 'Postomat' },
        { Ref: 'r2', Number: '5', Description: 'Відділення №5', ShortAddress: 'x', CategoryOfWarehouse: 'Branch' },
      ];
    return Response.json({ success: true, data: rows });
  };
  const np = createNovaPoshta({ apiKey: 'k', fetchFn });
  const found = await np.searchPoints({ settlement: 'ref', query: '65634', kind: 'postomat' });
  assert.equal(found.length, 1);
  assert.equal(found[0].number, '65634');
  assert.equal(calls.length, 2);
});

test('графік відділення: стислий запис, вихідні пропускаються', async () => {
  const { formatSchedule } = await import('../server/novaposhta.js');
  const day = (v) => v;
  assert.equal(formatSchedule({ Monday: '09:00-20:00', Tuesday: '09:00-20:00', Wednesday: '09:00-20:00', Thursday: '09:00-20:00', Friday: '09:00-20:00', Saturday: '09:00-18:00', Sunday: '09:00-18:00' }),
    'Пн–Пт 09:00–20:00, Сб–Нд 09:00–18:00');
  assert.equal(formatSchedule({ Monday: '08:00-21:00', Tuesday: '08:00-21:00', Wednesday: '08:00-21:00', Thursday: '08:00-21:00', Friday: '08:00-21:00', Saturday: '09:00-15:00', Sunday: '-' }),
    'Пн–Пт 08:00–21:00, Сб 09:00–15:00');
  assert.equal(formatSchedule(null), '');
  assert.equal(day('x'), 'x');
});
