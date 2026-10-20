import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { cleanAds } from '../server/validate.js';
import { buildGoogleAdsCsv, contentId, evaluatePurchase } from '../server/conversions.js';
import { call, goodBody, makeApp, submit } from './helpers.js';

const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');

const conv = (over = {}) => ({
  enabled: true,
  dryRun: false,
  from: 1, // у тестах рахуємо всі замовлення; захист від «старих» перевіряється окремо
  lookbackDays: 30,
  checksPerTick: 3,
  excludeStatusIds: [13],
  excludeStatusGroupIds: [6],
  metaDatasetId: '1258409115455825',
  metaToken: 'META-TOKEN',
  metaTestEventCode: '',
  metaApiVersion: 'v24.0',
  metaContentId: 'shopify_UA_{product_id}',
  gaMeasurementId: 'G-D1XLRTFN7Q',
  gaApiSecret: 'GA-SECRET',
  gadsConversionName: 'Quick order purchase',
  gadsFeedUser: 'googleads',
  gadsFeedPassword: 'feed-pass',
  ...over,
});

const ads = {
  gclid: 'Cj0KCQjwgclid123',
  fbc: 'fb.1.1728000000000.IwAR123fbclid',
  fbp: 'fb.1.1728000000000.1234567890',
  ga_client_id: '123456789.1728000000',
  ga_sessions: { D1XLRTFN7Q: '1728000123', '6PM2GEBQ25': '1728000999' },
  ua: 'Mozilla/5.0 (iPhone)',
};

async function setup({ cfg = {}, body = goodBody({ ads, surname: 'Петренко' }), crmOrder } = {}) {
  const ctx = makeApp({ cfg: { keycrmToken: 'CRMTOKEN', conversions: conv(), ...cfg } });
  ctx.fetchFn.crmState.order = crmOrder ?? { status_id: 1, status_group_id: 1, grand_total: 1780, shipping: { tracking_code: '' } };
  const res = await submit(ctx.app, body);
  assert.equal(res.status, 200);
  return ctx;
}

const pay = (store, now, cents = 20000) => {
  const id = store.insertPayment({ orderId: 1, invoiceId: `inv-${cents}`, amount: cents, kind: 'prepay', url: 'u', createdAt: now().getTime() });
  store.setPaymentStatus(id, 'success', now().getTime());
};

test('лише заявка (без оплати й ТТН) не стає покупкою: у рекламу нічого не йде', async () => {
  const { app, fetchFn, store, now } = await setup();
  await app.tick();
  pay(store, now);
  now.advance(25 * 60_000);
  await app.tick(); // оплата є, ТТН немає
  assert.equal(fetchFn.meta().length, 0);
  assert.equal(fetchFn.ga().length, 0);
  assert.equal(store.getOrder(1).conv_at, null);
});

test('оплата + ТТН → одна покупка в Meta (у гривнях) і GA4, повтори не дублюють', async () => {
  const { app, fetchFn, store, now } = await setup();
  pay(store, now);
  store.setTtn(1, '20451234567890', 'ref');
  await app.tick();

  const [meta] = fetchFn.meta();
  assert.ok(meta, 'Meta отримала подію');
  assert.match(meta.url, /\/v24\.0\/1258409115455825\/events$/);
  assert.equal(meta.body.access_token, 'META-TOKEN');
  const event = meta.body.data[0];
  assert.equal(event.event_name, 'Purchase');
  assert.equal(event.event_id, 'quick-20251005-150000');
  assert.equal(event.action_source, 'website');
  assert.equal(event.custom_data.currency, 'UAH');
  assert.equal(event.custom_data.value, 1780);
  assert.deepEqual(event.custom_data.content_ids, ['shopify_UA_9001']);
  assert.deepEqual(event.custom_data.contents, [{ id: 'shopify_UA_9001', quantity: 2, item_price: 890 }]);
  assert.deepEqual(event.user_data.ph, [sha('380671234567')]);
  assert.deepEqual(event.user_data.fn, [sha('іван')]);
  assert.deepEqual(event.user_data.ln, [sha('петренко')]);
  assert.equal(event.user_data.fbc, ads.fbc);
  assert.equal(event.user_data.fbp, ads.fbp);
  assert.equal(event.user_data.client_user_agent, ads.ua);
  assert.ok(!JSON.stringify(event).includes('380671234567'), 'телефон лише в хеші');

  const [ga] = fetchFn.ga();
  assert.match(ga.url, /measurement_id=G-D1XLRTFN7Q&api_secret=GA-SECRET/);
  assert.equal(ga.body.client_id, ads.ga_client_id);
  const params = ga.body.events[0].params;
  assert.equal(ga.body.events[0].name, 'purchase');
  assert.equal(params.session_id, '1728000123', 'сесія саме потоку G-D1XLRTFN7Q');
  assert.equal(params.currency, 'UAH');
  assert.equal(params.value, 1780);
  assert.equal(params.transaction_id, 'quick-20251005-150000');

  const order = store.getOrder(1);
  assert.equal(order.meta_state, 'sent');
  assert.equal(order.ga_state, 'sent');

  now.advance(3 * 3600e3);
  await app.tick();
  await app.tick();
  assert.equal(fetchFn.meta().length, 1);
  assert.equal(fetchFn.ga().length, 1);
});

test('оплата й ТТН, додані вручну в KeyCRM, теж зараховуються; сума береться з KeyCRM', async () => {
  const { app, fetchFn, store } = await setup({
    crmOrder: { status_id: 4, status_group_id: 4, grand_total: 1599, shipping: { tracking_code: '20450000000001' } },
  });
  fetchFn.crmState.payments.push({ id: 1, order_id: 777, status: 'paid', amount: 1599, description: 'Карта' });
  await app.tick();
  assert.equal(store.getOrder(1).conv_value_cents, 159900);
  assert.equal(fetchFn.meta()[0].body.data[0].custom_data.value, 1599);
});

test('спам, скасовані й статуси-виключення (тест, «некоректні дані») не йдуть у рекламу', async () => {
  for (const crmOrder of [
    { status_id: 21, status_group_id: 6, grand_total: 999, shipping: { tracking_code: '204' } },
    { status_id: 13, status_group_id: 1, grand_total: 999, shipping: { tracking_code: '204' } },
  ]) {
    const { app, fetchFn, store, now } = await setup({ crmOrder });
    pay(store, now);
    store.setTtn(1, '20451234567890', 'ref');
    await app.tick();
    assert.equal(fetchFn.meta().length, 0);
    assert.equal(store.getOrder(1).conv_at, null);
  }
  const { app, fetchFn, store, now } = await setup();
  store.setStatus(1, 'spam', 'Оля', now().getTime());
  pay(store, now);
  store.setTtn(1, '20451234567890', 'ref');
  await app.tick();
  assert.equal(fetchFn.meta().length, 0);
});

test('KeyCRM недоступний: без перевірки статусу покупку не зараховуємо, пізніше зараховуємо', async () => {
  const { app, fetchFn, store, now } = await setup();
  pay(store, now);
  store.setTtn(1, '20451234567890', 'ref');
  fetchFn.fail.keycrm = true;
  await app.tick();
  assert.equal(store.getOrder(1).conv_at, null);
  fetchFn.fail.keycrm = false;
  now.advance(21 * 60_000);
  await app.tick();
  assert.ok(store.getOrder(1).conv_at);
  assert.equal(fetchFn.meta().length, 1);
});

test('тестовий режим: нічого не відправляє; після вимкнення покупки йдуть по-справжньому', async () => {
  const ctx = await setup({ cfg: { conversions: conv({ dryRun: true }) } });
  pay(ctx.store, ctx.now);
  ctx.store.setTtn(1, '20451234567890', 'ref');
  await ctx.app.tick();
  await ctx.app.tick();
  assert.equal(ctx.fetchFn.meta().length, 0);
  assert.equal(ctx.fetchFn.ga().length, 0);
  assert.equal(ctx.store.getOrder(1).meta_state, 'dry');

  ctx.config.conversions.dryRun = false;
  await ctx.app.tick();
  assert.equal(ctx.fetchFn.meta().length, 1);
  assert.equal(ctx.fetchFn.ga().length, 1);
});

test('збій Meta не блокує GA4 і повторюється пізніше', async () => {
  const { app, fetchFn, store, now } = await setup();
  pay(store, now);
  store.setTtn(1, '20451234567890', 'ref');
  fetchFn.fail.meta = true;
  await app.tick();
  assert.equal(store.getOrder(1).ga_state, 'sent');
  assert.equal(store.getOrder(1).meta_state, null);
  assert.match(store.getOrder(1).meta_error, /Invalid OAuth/);
  fetchFn.fail.meta = false;
  now.advance(60_000);
  await app.tick();
  assert.equal(store.getOrder(1).meta_state, 'sent');
});

test('покупка, старша за 7 днів, у Meta не відправляється (Meta її відхилила б)', async () => {
  const ctx = await setup({ cfg: { conversions: conv({ metaToken: '' }) } });
  const { app, fetchFn, store, now } = ctx;
  pay(store, now);
  store.setTtn(1, '20451234567890', 'ref');
  await app.tick();
  assert.equal(store.getOrder(1).meta_state, null, 'канал не налаштований: покупка чекає');
  now.advance(8 * 24 * 3600e3);
  ctx.config.conversions.metaToken = 'META-TOKEN';
  await app.tick();
  assert.equal(fetchFn.meta().length, 0);
  assert.equal(store.getOrder(1).meta_state, 'expired');
});

test('вимкнено (CONVERSIONS_ENABLED не 1): нічого не перевіряється й не відправляється', async () => {
  const { app, fetchFn, store, now } = await setup({ cfg: { conversions: conv({ enabled: false }) } });
  pay(store, now);
  store.setTtn(1, '20451234567890', 'ref');
  const reads = fetchFn.crmReads().length;
  await app.tick();
  assert.equal(fetchFn.meta().length, 0);
  assert.equal(fetchFn.crmReads().length, reads);
});

test('CSV для Google Ads: лише з паролем, лише покупки з gclid, час у UTC', async () => {
  const { app, store, now } = await setup();
  pay(store, now);
  store.setTtn(1, '20451234567890', 'ref');
  await app.tick();

  const url = '/conversions/google-ads.csv';
  assert.equal((await call(app, { method: 'GET', url })).status, 401);
  const bad = Buffer.from('googleads:nope').toString('base64');
  assert.equal((await call(app, { method: 'GET', url, headers: { authorization: `Basic ${bad}` } })).status, 401);

  const good = Buffer.from('googleads:feed-pass').toString('base64');
  const res = await call(app, { method: 'GET', url, headers: { authorization: `Basic ${good}` } });
  assert.equal(res.status, 200);
  const lines = res.text.trim().split('\n');
  // Менеджер даних: перший рядок — заголовок з назвами колонок, без службового рядка Parameters
  assert.equal(lines[0], 'gclid,gbraid,wbraid,conversion_time,conversion_value,currency_code,order_id,conversion_name');
  assert.equal(lines[1], 'Cj0KCQjwgclid123,,,2025-10-05T12:00:00+00:00,1780.00,UAH,quick-20251005-150000,Quick order purchase');

  // Старий формат «Завантаження → Розклади» лишається за ?format=legacy
  const legacy = await call(app, { method: 'GET', url: `${url}?format=legacy`, headers: { authorization: `Basic ${good}` } });
  const old = legacy.text.trim().split('\n');
  assert.equal(old[0], 'Parameters:TimeZone=+0000');
  assert.equal(old[1], 'Google Click ID,Conversion Name,Conversion Time,Conversion Value,Conversion Currency');
  assert.equal(old[2], 'Cj0KCQjwgclid123,Quick order purchase,2025-10-05 12:00:00,1780.00,UAH');
});

test('CSV: кліки з iOS без gclid ідуть через gbraid/wbraid, без кліку рядка немає', () => {
  const row = (ads, n) => ({ order_number: n, conv_at: 0, conv_value_cents: 100, data: { ads } });
  const csv = buildGoogleAdsCsv([row({ gbraid: 'GB123456' }, 'a'), row({ wbraid: 'WB123456' }, 'b'), row({}, 'c'), row({ gclid: 'G1', gbraid: 'GB2' }, 'd')], { conversionName: 'Q' });
  const lines = csv.trim().split('\n');
  assert.equal(lines.length, 4);
  assert.equal(lines[1], ',GB123456,,1970-01-01T00:00:00+00:00,1.00,UAH,quick-a,Q');
  assert.equal(lines[2], ',,WB123456,1970-01-01T00:00:00+00:00,1.00,UAH,quick-b,Q');
  assert.equal(lines[3], 'G1,,,1970-01-01T00:00:00+00:00,1.00,UAH,quick-d,Q');
});

test('CSV доступний і за другою адресою (для нового підключення в Google Ads)', async () => {
  const { app } = await setup();
  const url = '/conversions/quick-order-purchases.csv';
  assert.equal((await call(app, { method: 'GET', url })).status, 401);
  const good = Buffer.from('googleads:feed-pass').toString('base64');
  const res = await call(app, { method: 'GET', url, headers: { authorization: `Basic ${good}` } });
  assert.equal(res.status, 200);
  assert.match(res.text, /^gclid,gbraid,wbraid,conversion_time/);
});

test('CSV вимкнений, якщо не задано пароль', async () => {
  const { app } = await setup({ cfg: { conversions: conv({ gadsFeedPassword: '' }) } });
  assert.equal((await call(app, { method: 'GET', url: '/conversions/google-ads.csv' })).status, 404);
});

test('у /status видно лічильники покупок', async () => {
  const { app, store, now } = await setup();
  pay(store, now);
  store.setTtn(1, '20451234567890', 'ref');
  await app.tick();
  const res = await call(app, { method: 'GET', url: '/status' });
  assert.deepEqual(res.json.purchases, {
    qualified: 1, meta_sent: 1, meta_retrying: 0, ga_sent: 1, ga_retrying: 0, crm_qualified: 0, crm_meta_sent: 0, crm_meta_retrying: 0,
  });
});

test('у /status є діагностика: звідки рахуємо, причини відмов, останні помилки (без секретів)', async () => {
  const { app, fetchFn, store, now } = await setup();
  fetchFn.fail.keycrm = true;
  pay(store, now);
  store.setTtn(1, '20451234567890', 'ref');
  await app.tick();
  let d = (await call(app, { method: 'GET', url: '/status' })).json.conversions;
  assert.equal(d.dry_run, false);
  assert.equal(d.meta, true);
  assert.equal(d.last_qualify.reasons.keycrm_error, 1);
  assert.match(d.last_errors.keycrm_read.message, /KeyCRM GET/);
  assert.ok(!JSON.stringify(d).includes('META-TOKEN') && !JSON.stringify(d).includes('feed-pass'));
  fetchFn.fail.keycrm = false;
  now.advance(21 * 60_000);
  await app.tick();
  d = (await call(app, { method: 'GET', url: '/status' })).json.conversions;
  assert.equal(d.last_qualify.reasons.qualified, 1);
});

test('рекламні ідентифікатори з форми чистяться, сміття відкидається', () => {
  assert.deepEqual(cleanAds(null), {});
  assert.deepEqual(cleanAds({
    gclid: 'Cj0KCQjw-ok_123', gbraid: '<script>', fbc: 'fb.1.1728000000000.abcdefgh', fbp: 'nonsense',
    ga_client_id: '123456789.1728000000', ga_sessions: { D1XLRTFN7Q: '1728000123', 'bad key': '1', X1Y2: 'abc' },
    ua: 'Mozilla<b>',
  }), {
    gclid: 'Cj0KCQjw-ok_123',
    fbc: 'fb.1.1728000000000.abcdefgh',
    gaClientId: '123456789.1728000000',
    gaSessions: { D1XLRTFN7Q: '1728000123' },
    ua: 'Mozilla b',
  });
});

test('формат ID товару для каталогу Meta налаштовується', () => {
  const d = { productId: '8123', variantId: '4555', sku: 'TEE-1' };
  assert.equal(contentId('{product_id}', d), '8123');
  assert.equal(contentId('shopify_UA_{product_id}_{variant_id}', d), 'shopify_UA_8123_4555');
  assert.equal(contentId('{sku}', d), 'TEE-1');
  assert.equal(contentId('shopify_UA_{product_id}', { variantId: '1' }), '', 'неповний ID не передається');
});

test('правило покупки: потрібні і оплата, і ТТН', () => {
  const order = { status: 'confirmed', ttn_number: null, data: { totalCents: 99900 } };
  assert.equal(evaluatePurchase({ order, localPaidCents: 99900 }).reason, 'no_ttn');
  assert.equal(evaluatePurchase({ order: { ...order, ttn_number: '204' }, localPaidCents: 0 }).reason, 'not_paid');
  assert.deepEqual(evaluatePurchase({ order: { ...order, ttn_number: '204' }, localPaidCents: 20000 }), { ok: true, valueCents: 99900 });
});

test('CSV: значення з комою чи лапками екрануються', () => {
  const csv = buildGoogleAdsCsv([{ order_number: 'x', conv_at: 0, conv_value_cents: 100, data: { ads: { gclid: 'abc' } } }], { conversionName: 'Buy, "quick"' });
  assert.match(csv, /abc,,,1970-01-01T00:00:00\+00:00,1\.00,UAH,quick-x,"Buy, ""quick"""/);
  const legacy = buildGoogleAdsCsv([{ conv_at: 0, conv_value_cents: 100, data: { ads: { gclid: 'abc' } } }], { conversionName: 'Buy, "quick"', format: 'legacy' });
  assert.match(legacy, /abc,"Buy, ""quick""",1970-01-01 00:00:00,1\.00,UAH/);
});

test('без CONVERSIONS_FROM старі оплачені замовлення не йдуть у рекламу як нові покупки', async () => {
  const { app, fetchFn, store, now } = await setup({ cfg: { conversions: conv({ from: 0 }) } });
  pay(store, now);
  store.setTtn(1, '20451234567890', 'ref');
  now.advance(60_000);
  await app.tick(); // перше ввімкнення: замовлення створене раніше
  now.advance(25 * 60_000);
  await app.tick();
  assert.equal(store.getOrder(1).conv_at, null);
  assert.equal(fetchFn.meta().length, 0);

  // А нове замовлення після ввімкнення зараховується
  const res = await submit(app, goodBody({ phone: '+380 (50) 765 43 21', client_id: 'client-id-0002' }));
  assert.equal(res.status, 200);
  const id = store.ordersSince(0).at(-1).id;
  const pid = store.insertPayment({ orderId: id, invoiceId: 'inv-new', amount: 20000, kind: 'prepay', url: 'u', createdAt: now().getTime() });
  store.setPaymentStatus(pid, 'success', now().getTime());
  store.setTtn(id, '20450000000002', 'ref2');
  await app.tick(); // KeyCRM-замовлення для нового створюється в цьому ж циклі
  now.advance(21 * 60_000);
  await app.tick();
  assert.ok(store.getOrder(id).conv_at);
  assert.equal(fetchFn.meta().length, 1);
});

test('замовлення ще не потрапило в KeyCRM: статус не перевірено, покупку не зараховуємо', async () => {
  const { app, fetchFn, store, now } = await setup();
  store.run('UPDATE orders SET crm_order_id = NULL, crm_state = ? WHERE id = 1', 'failed');
  store.run('UPDATE orders SET crm_next_at = ? WHERE id = 1', now().getTime() + 3600e3);
  pay(store, now);
  store.setTtn(1, '20451234567890', 'ref');
  await app.tick();
  assert.equal(store.getOrder(1).conv_at, null);
  assert.equal(fetchFn.meta().length, 0);
});

test('CSV: у тестовому режимі порожній, спам після зарахування прибирається', async () => {
  const ctx = await setup({ cfg: { conversions: conv({ dryRun: true }) } });
  pay(ctx.store, ctx.now);
  ctx.store.setTtn(1, '20451234567890', 'ref');
  await ctx.app.tick();
  const auth = { authorization: `Basic ${Buffer.from('googleads:feed-pass').toString('base64')}` };
  const csv = async () => (await call(ctx.app, { method: 'GET', url: '/conversions/google-ads.csv', headers: auth })).text.trim().split('\n');
  // Без справжніх покупок — заголовок і рядок-заглушка, який Google відхилить (Менеджер даних не приймає порожній файл)
  const empty = await csv();
  assert.equal(empty.length, 2);
  assert.match(empty[1], /^PLACEHOLDER-NO-PURCHASES-YET,,,2020-01-01T00:00:00\+00:00,0\.00,UAH,placeholder,/);
  ctx.config.conversions.dryRun = false;
  const real = await csv();
  assert.equal(real.length, 2);
  assert.match(real[1], /^Cj0KCQjwgclid123,/, 'зі справжньою покупкою заглушки немає');
  ctx.store.setStatus(1, 'spam', 'Оля', ctx.now().getTime());
  assert.match((await csv())[1], /^PLACEHOLDER/);
});

test('тестовий режим не застрягає на перших 10 покупках', async () => {
  const ctx = await setup({ cfg: { conversions: conv({ dryRun: true }) } });
  for (let i = 0; i < 11; i += 1) {
    const id = ctx.store.insertOrder({ orderNumber: `T-${i}`, fingerprint: `f${i}`, createdAt: ctx.now().getTime(), data: ctx.store.getOrder(1).data }).id;
    ctx.store.markConversion(id, ctx.now().getTime(), 100);
  }
  await ctx.app.tick();
  await ctx.app.tick();
  const dry = ctx.store.ordersSince(0).filter((o) => o.meta_state === 'dry').length;
  assert.equal(dry, 11);
});

test('тривалий збій Meta не губить покупку: повтори тривають, менеджерів попереджено один раз', async () => {
  const { app, fetchFn, store, now } = await setup();
  pay(store, now);
  store.setTtn(1, '20451234567890', 'ref');
  fetchFn.fail.meta = true;
  for (let i = 0; i < 20; i += 1) {
    await app.tick();
    now.advance(3600e3);
  }
  assert.equal(store.getOrder(1).meta_state, null, 'ще не здалися');
  const warnings = fetchFn.tg('sendMessage').filter((c) => /не вдається передати в Meta/.test(c.body.text));
  assert.equal(warnings.length, 1);
  fetchFn.fail.meta = false;
  await app.tick();
  assert.equal(store.getOrder(1).meta_state, 'sent');
});

/* ---------- Instagram Direct та інші джерела KeyCRM ---------- */

const igOrder = (over = {}) => ({
  id: 5001,
  source_id: 198,
  status_id: 44,
  status_group_id: 3,
  grand_total: 1899,
  created_at: '2025-10-05 12:30:00',
  buyer: { full_name: 'Олена Коваль', phone: '+380501112233' },
  shipping: { tracking_code: '20450000000999', shipping_address_city: 'м. Львів' },
  payments: [{ status: 'paid', amount: 1899 }],
  products: [{ quantity: 1 }],
  tags: [],
  ...over,
});

async function igSetup({ list = [igOrder()], cfg = {} } = {}) {
  const ctx = makeApp({ cfg: { keycrmToken: 'CRMTOKEN', conversions: conv({ crmSourceIds: [198, 216], ...cfg }) } });
  ctx.fetchFn.crmState.list = list;
  return ctx;
}

test('Instagram Direct: оплачене замовлення з ТТН іде в Meta як покупка в гривнях, один раз', async () => {
  const { app, fetchFn, store, now } = await igSetup();
  await app.tick();
  const [meta] = fetchFn.meta();
  assert.ok(meta);
  const event = meta.body.data[0];
  assert.equal(event.event_id, 'keycrm-5001');
  assert.equal(event.action_source, 'system_generated');
  assert.equal(event.custom_data.currency, 'UAH');
  assert.equal(event.custom_data.value, 1899);
  assert.deepEqual(event.user_data.ph, [sha('380501112233')]);
  assert.deepEqual(event.user_data.ct, [sha('львів')]);
  assert.ok(!JSON.stringify(meta.body).includes('380501112233'));
  assert.ok(fetchFn.crmLists.every((q) => q['filter[source_id]'] === '198'), 'джерело швидких замовлень не опитується');

  now.advance(20 * 60_000);
  await app.tick();
  assert.equal(fetchFn.meta().length, 1);
  assert.equal(store.conversionCounts().crm_meta_sent, 1);
});

test('Instagram Direct: без оплати, без ТТН, скасовані й уже відправлені старою інтеграцією (тег CAPI) не йдуть', async () => {
  const { app, fetchFn } = await igSetup({ list: [
    igOrder({ id: 1, payments: [] }),
    igOrder({ id: 2, payments: [{ status: 'not_paid', amount: 1899 }] }),
    igOrder({ id: 3, shipping: { tracking_code: '' } }),
    igOrder({ id: 4, status_id: 13, status_group_id: 6 }),
    igOrder({ id: 5, tags: [{ id: 17, alias: 'capi', name: 'CAPI' }] }),
    igOrder({ id: 6, created_at: '2025-09-01 10:00:00' }),
  ] });
  await app.tick();
  assert.equal(fetchFn.meta().length, 0);
});

test('Instagram Direct: KeyCRM опитується не частіше ніж раз на 15 хвилин', async () => {
  const { app, fetchFn, now } = await igSetup({ list: [] });
  await app.tick();
  await app.tick();
  assert.equal(fetchFn.crmLists.length, 1);
  now.advance(16 * 60_000);
  await app.tick();
  assert.equal(fetchFn.crmLists.length, 2);
});

test('разова повторна відправка в Meta: ті самі event_id, лише без тест-коду, не повторюється після перезапуску', async () => {
  const { app, fetchFn, store, now, config } = await igSetup();
  const quick = await submit(app, goodBody({ ads, phone: '+380 (67) 555 44 33', client_id: 'client-id-0009' }));
  assert.equal(quick.status, 200);
  config.conversions.metaTestEventCode = 'TEST20833';
  const quickId = 1;
  store.markConversion(quickId, now().getTime(), 99900);
  await app.tick();
  const firstRound = fetchFn.meta();
  assert.equal(firstRound.length, 2);
  assert.ok(firstRound.every((m) => m.body.test_event_code === 'TEST20833'));

  // Поки тест-код стоїть, повтор не запускається
  config.conversions.metaResendBefore = now().getTime() + 1000;
  now.advance(60_000);
  await app.tick();
  assert.equal(fetchFn.meta().length, 2);

  config.conversions.metaTestEventCode = '';
  await app.tick();
  const resent = fetchFn.meta().slice(2);
  assert.equal(resent.length, 2);
  assert.ok(resent.every((m) => !('test_event_code' in m.body)));
  assert.deepEqual(resent.map((m) => m.body.data[0].event_id).sort(), firstRound.map((m) => m.body.data[0].event_id).sort());
  const result = JSON.parse(store.getMeta('meta_resend_result'));
  assert.deepEqual([result.orders, result.crm], [1, 1]);
  const status = JSON.parse((await call(app, { method: 'GET', url: '/status' })).text);
  assert.equal(status.conversions.meta_test_mode, false);
  assert.equal(status.conversions.meta_resend.crm, 1);

  now.advance(20 * 60_000);
  await app.tick();
  await app.tick();
  assert.equal(fetchFn.meta().length, 4, 'повтор разовий');
});

test('GA4: ID товару — ID варіанта Shopify, як у Merchant Center', async () => {
  const { app, fetchFn, store, now } = await setup();
  pay(store, now);
  store.setTtn(1, '20451234567890', 'ref');
  await app.tick();
  const [ga] = fetchFn.ga();
  const item = ga.body.events[0].params.items[0];
  assert.equal(item.item_id, String(goodBody().variant_id));
});

/* ---------- Таблиця покупок для звірки з Meta ---------- */

test('CSV покупок для Meta: лише з паролем; швидкі замовлення й Direct, як їх отримала Meta, без персональних даних', async () => {
  const ctx = makeApp({ cfg: { keycrmToken: 'CRMTOKEN', conversions: conv({ crmSourceIds: [198, 216] }) } });
  ctx.fetchFn.crmState.order = { status_id: 1, status_group_id: 1, grand_total: 1780, shipping: { tracking_code: '' } };
  ctx.fetchFn.crmState.list = [igOrder()];
  assert.equal((await submit(ctx.app, goodBody({ ads, surname: 'Петренко' }))).status, 200);
  pay(ctx.store, ctx.now);
  ctx.store.setTtn(1, '20451234567890', 'ref');
  await ctx.app.tick();
  const sent = ctx.fetchFn.meta().flatMap((m) => m.body.data);
  assert.equal(sent.length, 2);

  const url = '/conversions/meta-purchases.csv';
  assert.equal((await call(ctx.app, { method: 'GET', url })).status, 401);
  const good = Buffer.from('googleads:feed-pass').toString('base64');
  const res = await call(ctx.app, { method: 'GET', url, headers: { authorization: `Basic ${good}` } });
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/csv/);
  const lines = res.text.replace(/^﻿/, '').trim().split('\n');
  assert.equal(lines[0], 'джерело,номер_швидкого_замовлення,id_замовлення_keycrm,event_id,час_події_київ,сума,валюта,content_ids,товар,варіант,sku,кількість,стан_відправки_в_meta');
  assert.equal(lines.length, 3);

  const quick = lines.find((l) => l.startsWith('Швидке замовлення'));
  const quickEvent = sent.find((e) => e.event_id.startsWith('quick-'));
  assert.ok(quick.includes(`,${quickEvent.event_id},`));
  assert.ok(quick.includes(',1780.00,UAH,shopify_UA_9001,'), 'сума й content_ids як у відправленій події');
  assert.ok(quick.endsWith(',2,відправлено'));

  const direct = lines.find((l) => l.startsWith('Instagram Direct'));
  assert.ok(direct.includes(',5001,keycrm-5001,'));
  assert.ok(direct.includes(',1899.00,UAH,'));
  assert.ok(direct.endsWith(',відправлено'));

  assert.ok(!/380671234567|380501112233|Петренко|Коваль/.test(res.text), 'ні телефонів, ні імен');

  const later = await call(ctx.app, { method: 'GET', url: `${url}?from=2099-01-01`, headers: { authorization: `Basic ${good}` } });
  assert.equal(later.text.replace(/^﻿/, '').trim().split('\n').length, 1, 'фільтр за датою');
});

test('CSV покупок для Meta вимкнений без пароля', async () => {
  const { app } = await setup({ cfg: { conversions: conv({ gadsFeedPassword: '' }) } });
  assert.equal((await call(app, { method: 'GET', url: '/conversions/meta-purchases.csv' })).status, 404);
});
