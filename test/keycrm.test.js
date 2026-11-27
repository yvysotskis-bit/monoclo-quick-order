import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCrmOrder } from '../server/keycrm.js';
import { call, goodBody, makeApp, submit } from './helpers.js';

const crmCfg = { keycrmToken: 'CRMTOKEN', keycrmSourceId: 216, keycrmStatusMap: { cancelled: 19, spam: 13 } };

test('замовлення в KeyCRM: джерело, покупець, товар, розмір, UTM, місто', async () => {
  const { app, fetchFn, store } = makeApp({ cfg: crmCfg });
  await submit(app, goodBody({
    city: 'Київ', comment: 'Подзвоніть після 18',
    utm: { source: 'facebook', medium: 'cpc', campaign: 'autumn' },
  }));
  const [create] = fetchFn.crm();
  assert.equal(create.method, 'POST');
  assert.ok(create.url.endsWith('/v1/order'));
  assert.equal(create.headers.authorization, 'Bearer CRMTOKEN');
  const b = create.body;
  assert.equal(b.source_id, 216);
  assert.equal(b.source_uuid, 'quick-20251005-150000');
  assert.deepEqual(b.buyer, { full_name: 'Іван', phone: '+380671234567' });
  assert.equal(b.buyer_comment, 'Подзвоніть після 18');
  assert.equal(b.products[0].price, 890);
  assert.equal(b.products[0].quantity, 2);
  assert.equal(b.products[0].sku, 'TEE-BLK-S');
  assert.equal(b.products[0].picture, 'https://cdn.test/tee.jpg');
  assert.deepEqual(b.products[0].properties, [{ name: 'Колір', value: 'Чорний' }, { name: 'Розмір', value: 'S' }]);
  assert.deepEqual(b.shipping, { shipping_address_city: 'Київ' });
  assert.deepEqual(b.marketing, { utm_source: 'facebook', utm_medium: 'cpc', utm_campaign: 'autumn' });
  assert.equal(store.getOrder(1).crm_state, 'sent');
  assert.equal(store.getOrder(1).crm_order_id, 777);
});

test('без ключа KeyCRM замовлення йдуть лише в Telegram', async () => {
  const { app, fetchFn, store } = makeApp();
  await submit(app);
  assert.equal(fetchFn.crm().length, 0);
  assert.equal(store.getOrder(1).crm_state, 'skipped');
});

test('збій KeyCRM не зупиняє Telegram; черга повторює; після вичерпання спроб є попередження', async () => {
  const { app, fetchFn, store, now } = makeApp({ cfg: crmCfg });
  fetchFn.fail.keycrm = true;
  const r = await submit(app);
  assert.equal(r.json.ok, true);
  assert.equal(store.getOrder(1).tg_state, 'sent');
  assert.equal(store.getOrder(1).crm_state, 'pending');
  assert.doesNotMatch(String(store.getOrder(1).crm_error), /CRMTOKEN/);

  fetchFn.fail.keycrm = false;
  now.advance(60_000);
  await app.tick();
  assert.equal(store.getOrder(1).crm_state, 'sent');

  // Постійний збій: після 10 спроб замовлення позначається failed і менеджери отримують попередження
  const failing = makeApp({ cfg: crmCfg });
  failing.fetchFn.fail.keycrm = true;
  await submit(failing.app);
  for (let i = 0; i < 12; i += 1) {
    failing.now.advance(16 * 60_000);
    await failing.app.tick();
  }
  assert.equal(failing.store.getOrder(1).crm_state, 'failed');
  const warnings = failing.fetchFn.tg('sendMessage').filter((c) => /Не вдалося передати замовлення/.test(c.body.text));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].body.text, /Причина: KeyCRM відповів 500: boom/);
});

test('попередження називає причину: недійсний ключ і поля, які KeyCRM не прийняв', async () => {
  const run = async (status, body) => {
    const t = makeApp({ cfg: crmCfg });
    t.fetchFn.fail.keycrm = true;
    t.fetchFn.fail.keycrmStatus = status;
    t.fetchFn.fail.keycrmBody = body;
    await submit(t.app);
    for (let i = 0; i < 12; i += 1) {
      t.now.advance(16 * 60_000);
      await t.app.tick();
    }
    return t.fetchFn.tg('sendMessage').find((c) => /Не вдалося передати замовлення/.test(c.body.text)).body.text;
  };
  const unauth = await run(401, '{"message":"Unauthenticated."}');
  assert.match(unauth, /Причина: KeyCRM не прийняв ключ API \(401\)\. Оновіть KEYCRM_API_KEY у Render/);
  const invalid = await run(422, '{"message":"The given data was invalid.","errors":{"buyer.phone":["Невірний <номер>"]}}');
  assert.match(invalid, /Причина: KeyCRM відповів 422: The given data was invalid\.; buyer\.phone: Невірний &lt;номер&gt;/);
});

test('статус з Telegram оновлює замовлення в KeyCRM (лише для налаштованих статусів)', async () => {
  const { app, fetchFn } = makeApp({ cfg: crmCfg });
  await submit(app);
  const headers = { 'x-telegram-bot-api-secret-token': 'hook-secret' };
  const press = (data) => call(app, {
    url: '/telegram/webhook',
    headers,
    body: { callback_query: { id: 'c', data, from: { first_name: 'Оля' }, message: { message_id: 101, chat: { id: -100500 }, text: 'T', entities: [] } } },
  });

  await press('st:cancelled');
  const put = fetchFn.crm().find((c) => c.method === 'PUT');
  assert.ok(put.url.endsWith('/v1/order/777'));
  assert.deepEqual(put.body, { status_id: 19 });

  const before = fetchFn.crm().length;
  await press('st:taken'); // для «В роботі» відповідника в CRM немає
  assert.equal(fetchFn.crm().length, before);
});

test('buildCrmOrder: порожні поля не потрапляють у запит', () => {
  const order = {
    order_number: '1',
    data: { name: 'А', phone: '+1', comment: '', city: '', utm: {}, productTitle: 'T', productUrl: 'https://x', unitCents: 100, quantity: 1, options: [], afterHours: true },
  };
  const payload = buildCrmOrder(order, { sourceId: 5 });
  assert.equal(payload.shipping, undefined);
  assert.equal(payload.marketing, undefined);
  assert.equal(payload.buyer_comment, undefined);
  assert.match(payload.manager_comment, /поза робочим часом/);
});
