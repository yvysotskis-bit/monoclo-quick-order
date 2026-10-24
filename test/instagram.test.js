import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIgPurchaseEvent, findInstagramUsername, keyPaths, normUsername } from '../server/instagram.js';
import { call, makeApp } from './helpers.js';

const IG_ACCOUNT = '17840000000000001';

const conv = (over = {}) => ({
  enabled: true,
  dryRun: false,
  from: 1,
  lookbackDays: 30,
  checksPerTick: 3,
  excludeStatusIds: [13],
  excludeStatusGroupIds: [6],
  crmSourceIds: [198],
  crmManualQuick: false,
  metaDatasetId: '1258409115455825',
  metaToken: 'META-TOKEN',
  metaTestEventCode: '',
  metaApiVersion: 'v24.0',
  metaContentId: '{variant_id}',
  gadsFeedUser: 'googleads',
  gadsFeedPassword: 'feed-pass',
  igEnabled: true,
  igPageId: '100000000000001',
  igAccountId: IG_ACCOUNT,
  igPageToken: 'IG-PAGE-TOKEN',
  igSourceIds: [198],
  igResolveHours: 24,
  igLookbackDays: 60,
  igMaxPages: 40,
  ...over,
});

const igOrder = (over = {}) => ({
  id: 5001,
  source_id: 198,
  status_id: 44,
  status_group_id: 3,
  grand_total: 1899,
  created_at: '2025-10-05 12:30:00',
  buyer: { id: 66601, full_name: 'Олена Коваль', phone: '+380501112233' },
  shipping: { tracking_code: '20450000000999', shipping_address_city: 'м. Львів' },
  payments: [{ status: 'paid', amount: 1899 }],
  products: [{ quantity: 1 }],
  tags: [],
  ...over,
});

const conversation = (username, igSid, updated = '2025-10-05T11:00:00+0000') => ({
  updated_time: updated,
  participants: { data: [{ username: 'shop.account', id: IG_ACCOUNT }, { username, id: igSid }] },
});

function setup({ list = [igOrder()], buyers = { 66601: { id: 66601, social: [{ type: 'instagram', value: 'olena.koval' }] } }, pages, cfg = {} } = {}) {
  const ctx = makeApp({ cfg: { keycrmToken: 'CRMTOKEN', conversions: conv(cfg) } });
  ctx.fetchFn.crmState.list = list;
  ctx.fetchFn.crmState.buyers = buyers;
  ctx.fetchFn.igConversations = pages ?? [[conversation('olena.koval', '1000000000000042')]];
  return ctx;
}

const igEvents = (fetchFn) => fetchFn.meta().flatMap((m) => m.body.data).filter((e) => e.action_source === 'business_messaging');
const systemEvents = (fetchFn) => fetchFn.meta().flatMap((m) => m.body.data).filter((e) => e.action_source === 'system_generated');

/* ---------- нік Instagram із KeyCRM ---------- */

test('нік Instagram: посилання, @нік, пара type/value; телефони й сміття ніком не вважаються', () => {
  assert.equal(normUsername('@AlbinaZhura'), 'albinazhura');
  assert.equal(normUsername('https://www.instagram.com/vl_lapa/?hl=uk'), 'vl_lapa');
  assert.equal(normUsername('380933781358'), '', 'номер телефону (Viber/Telegram) не нік');
  assert.equal(normUsername('Олена Коваль'), '');
  assert.equal(findInstagramUsername({ social: [{ type: 'telegram', value: '6208162983' }, { type: 'instagram', value: 'lrisha_aa' }] }), 'lrisha_aa');
  assert.equal(findInstagramUsername({ links: ['https://instagram.com/tayacurin'] }), 'tayacurin');
  assert.equal(findInstagramUsername({ contacts: { instagram: 'da.sha796' } }), 'da.sha796');
  assert.equal(findInstagramUsername({ full_name: 'Олена', phone: '+380501112233' }), '');
  assert.deepEqual(keyPaths({ id: 1, social: [{ type: 'x', value: 'y' }], phone: '1' }), ['id', 'social[].type', 'social[].value', 'phone']);
});

test('подія business_messaging: ig_sid і Instagram-акаунт, без телефону й імені, сума в гривнях', () => {
  const e = buildIgPurchaseEvent({ igSid: '1000000000000042', igAccountId: IG_ACCOUNT, valueCents: 189900, eventTimeMs: 1759667400000, crmOrderId: 5001 });
  assert.deepEqual(e, {
    event_name: 'Purchase',
    event_time: 1759667400,
    event_id: 'keycrm-5001',
    action_source: 'business_messaging',
    messaging_channel: 'instagram',
    user_data: { instagram_business_account_id: IG_ACCOUNT, ig_sid: '1000000000000042' },
    custom_data: { currency: 'UAH', value: 1899 },
  });
});

/* ---------- повний цикл ---------- */

test('Direct-покупка з ніком у KeyCRM іде як business_messaging, стара подія не дублюється', async () => {
  const { app, fetchFn, store, now } = setup();
  await app.tick();
  const [ig] = igEvents(fetchFn);
  assert.ok(ig, 'подія business_messaging відправлена');
  assert.equal(ig.user_data.ig_sid, '1000000000000042');
  assert.equal(ig.custom_data.value, 1899);
  const req = fetchFn.meta().find((m) => m.body.data[0].action_source === 'business_messaging');
  assert.match(req.url, /\/1258409115455825\/events$/, 'той самий датасет, що прив\'язаний до Instagram');
  assert.equal(req.body.access_token, 'IG-PAGE-TOKEN');
  assert.equal(systemEvents(fetchFn).length, 0, 'system_generated для цієї покупки не йде');
  assert.equal(fetchFn.igReads[0].platform, 'instagram');
  assert.deepEqual(fetchFn.crmBuyerReads, [66601], 'нік узято з картки покупця');

  now.advance(20 * 60_000);
  await app.tick();
  assert.equal(igEvents(fetchFn).length, 1, 'один раз');
  assert.equal(systemEvents(fetchFn).length, 0);
  assert.deepEqual(store.igCounts(), { sent: 1 });
});

test('без ніка в KeyCRM — одразу стара подія system_generated, як раніше; структура картки в діагностиці', async () => {
  const { app, fetchFn, store } = setup({ buyers: { 66601: { id: 66601, full_name: 'Олена', phone: '+380501112233', custom_fields: [] } } });
  await app.tick();
  assert.equal(igEvents(fetchFn).length, 0);
  assert.equal(systemEvents(fetchFn).length, 1);
  assert.deepEqual(store.igCounts(), { no_username: 1 });
  const res = await call(app, { method: 'GET', url: '/status' });
  const d = res.json.conversions.instagram;
  assert.deepEqual(d.usernames, { found: 0, missing: 1 });
  assert.ok(d.buyer_fields_when_no_username.includes('full_name'));
  assert.ok(!JSON.stringify(d).includes('380501112233'), 'у діагностиці лише назви полів');
});

test('нік є, але розмову ще не знайдено: чекаємо, повторюємо пошук; через 24 год — стара подія', async () => {
  const { app, fetchFn, store, now } = setup({ pages: [[conversation('someone.else', '111')]] });
  await app.tick();
  assert.equal(fetchFn.meta().length, 0, 'поки шукаємо — нічого не шлемо');
  const reads = fetchFn.igReads.length;
  now.advance(5 * 60_000);
  await app.tick();
  assert.equal(fetchFn.igReads.length, reads, 'розмови не перечитуємо частіше ніж раз на 15 хв');

  // Розмова з'явилась у наступній синхронізації
  fetchFn.igConversations = [[conversation('olena.koval', '1000000000000042', '2025-10-05T12:40:00+0000')]];
  now.advance(15 * 60_000);
  await app.tick();
  assert.equal(igEvents(fetchFn).length, 1);
  assert.equal(systemEvents(fetchFn).length, 0);

  // Інша покупка, нік якої так і не знайшовся
  const other = setup({ pages: [[]] });
  await other.app.tick();
  other.now.advance(25 * 3600e3);
  await other.app.tick();
  assert.equal(igEvents(other.fetchFn).length, 0);
  assert.equal(systemEvents(other.fetchFn).length, 1, 'резерв: стара подія, щоб покупка не загубилась');
  assert.deepEqual(other.store.igCounts(), { not_found: 1 });
  void store;
});

test('синхронізація гортає сторінки розмов і зупиняється на вже переглянутих', async () => {
  const pages = [
    [conversation('a.one', '1', '2025-10-05T11:50:00+0000')],
    [conversation('b.two', '2', '2025-10-05T10:00:00+0000')],
    [conversation('olena.koval', '1000000000000042', '2025-10-04T09:00:00+0000')],
  ];
  const { app, fetchFn } = setup({ pages });
  await app.tick();
  assert.equal(fetchFn.igReads.length, 3, 'перший прохід — назад до знайденої розмови');
  assert.equal(igEvents(fetchFn).length, 1);
});

test('тестовий режим: business_messaging не відправляється, після вимкнення тестового режиму — йде', async () => {
  const ctx = setup({ cfg: { dryRun: true } });
  await ctx.app.tick();
  assert.equal(ctx.fetchFn.meta().length, 0);
  assert.deepEqual(ctx.store.igCounts(), { dry: 1 });
  ctx.config.conversions.dryRun = false;
  ctx.now.advance(20 * 60_000);
  await ctx.app.tick();
  assert.equal(igEvents(ctx.fetchFn).length, 1);
  assert.equal(systemEvents(ctx.fetchFn).length, 0);
});

test('інтеграція вимкнена (IG_MESSAGING_ENABLED не 1): поведінка як раніше, розмови не читаються', async () => {
  const { app, fetchFn } = setup({ cfg: { igEnabled: false } });
  await app.tick();
  assert.equal(systemEvents(fetchFn).length, 1);
  assert.equal(fetchFn.igReads.length, 0);
  assert.equal(fetchFn.crmBuyerReads.length, 0);
});

test('збій Meta для business_messaging: повтор, без старої події поки повторюємо', async () => {
  const { app, fetchFn, store, now } = setup();
  fetchFn.fail.meta = true;
  await app.tick();
  assert.equal(igEvents(fetchFn).length, 1, 'спроба була');
  assert.deepEqual(store.igCounts(), { pending: 1 });
  fetchFn.fail.meta = false;
  now.advance(2 * 60_000);
  await app.tick();
  assert.deepEqual(store.igCounts(), { sent: 1 });
  assert.equal(systemEvents(fetchFn).length, 0);
});
