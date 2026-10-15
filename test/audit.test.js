// Перевірки, знайдені під час аудиту: гонки, повторні запуски, часткові збої, порядок вебхуків.
import test from 'node:test';
import assert from 'node:assert/strict';
import { call, goodBody, makeApp, signMono, signedUrl, submit } from './helpers.js';

const headers = { 'x-telegram-bot-api-secret-token': 'hook-secret' };
const payCfg = { monobankToken: 'M', keycrmToken: 'crm', keycrmPaymentMethodId: 9 };
let updateId = 1000;
const press = (app, data, messageId = 101, extra = {}) => call(app, {
  url: '/telegram/webhook',
  headers,
  body: { update_id: extra.updateId ?? ++updateId, callback_query: { id: 'cb', data, from: { id: 55, first_name: 'Оля' }, message: { message_id: messageId, chat: { id: -100500 }, text: 'T', entities: [] } } },
});
const hook = (app, payload) => {
  const raw = JSON.stringify(payload);
  return call(app, { url: '/mono/webhook', rawBody: raw, headers: { 'x-sign': signMono(raw) } });
};
const crmPayments = (fetchFn) => fetchFn.crm().filter((c) => /\/order\/\d+\/payment$/.test(c.url));

test('одночасні однакові замовлення (подвійний клік): створюється одне', async () => {
  const { app, store } = makeApp();
  const results = await Promise.all([submit(app), submit(app), submit(app)]);
  assert.ok(results.every((r) => r.status === 200));
  assert.equal(store.ordersSince(0).length, 1);
  assert.equal(new Set(results.map((r) => r.json.order_number)).size, 1);
});

test('одночасні замовлення з тим самим клієнтом, але без client_id: теж одне (за відбитком)', async () => {
  const { app, store } = makeApp();
  await Promise.all([submit(app, goodBody({ client_id: undefined })), submit(app, goodBody({ client_id: undefined }))]);
  assert.equal(store.ordersSince(0).length, 1);
});

test('ліміт за номером не «з\'їдається» відхиленими спробами (товар закінчився)', async () => {
  const { app, store } = makeApp();
  for (let i = 0; i < 5; i += 1) {
    const r = await submit(app, goodBody({ variant_id: 222, client_id: `client-id-000${i}` }));
    assert.equal(r.status, 409);
  }
  const ok = await submit(app, goodBody({ client_id: 'client-id-9999' }));
  assert.equal(ok.status, 200, 'після відхилених спроб нормальне замовлення проходить');
  assert.equal(store.ordersSince(0).length, 1);
});

test('KeyCRM: якщо замовлення вже створено (відповідь загубилась), повторна спроба не робить дубль', async () => {
  const { app, fetchFn, store, now } = makeApp({ cfg: payCfg });
  fetchFn.fail.keycrmLostResponse = true;
  await submit(app);
  assert.equal(store.getOrder(1).crm_state, 'pending');
  fetchFn.fail.keycrmLostResponse = false;
  now.advance(20 * 60_000);
  await app.tick();
  const posts = fetchFn.crm().filter((c) => c.method === 'POST' && c.url.endsWith('/v1/order'));
  assert.equal(posts.length, 1, 'замовлення в KeyCRM створено один раз');
  assert.equal(store.getOrder(1).crm_state, 'sent');
  assert.equal(store.getOrder(1).crm_order_id, 777);
});

test('KeyCRM: після вичерпання спроб замовлення не забувається, раз на кілька годин спроба повторюється', async () => {
  const { app, fetchFn, store, now } = makeApp({ cfg: payCfg });
  fetchFn.fail.keycrm = true;
  await submit(app);
  for (let i = 0; i < 12; i += 1) { now.advance(20 * 60_000); await app.tick(); }
  assert.equal(store.getOrder(1).crm_state, 'failed');
  fetchFn.fail.keycrm = false;
  now.advance(7 * 3600_000);
  await app.tick();
  assert.equal(store.getOrder(1).crm_state, 'sent', 'замовлення передалось, коли KeyCRM знову доступний');
});

test('оплата в KeyCRM: вебхук і фонова черга одночасно не дублюють платіж', async () => {
  // (перевіряємо стан «сервера KeyCRM», а не кількість спроб)
  const { app, fetchFn } = makeApp({ cfg: payCfg });
  await submit(app);
  await press(app, 'pay:link');
  fetchFn.paymentDelayMs = 30;
  await Promise.all([hook(app, { invoiceId: 'inv-1', status: 'success', amount: 20000, modifiedDate: '2025-10-05T12:00:05Z' }), app.tick()]);
  await app.tick();
  assert.equal(fetchFn.crmState.payments.length, 1);
});

test('оплата в KeyCRM: якщо платіж уже є в замовленні (відповідь загубилась), другий не додається', async () => {
  const { app, fetchFn, now, store } = makeApp({ cfg: payCfg });
  await submit(app);
  await press(app, 'pay:link');
  fetchFn.fail.keycrmPayment = true;
  await hook(app, { invoiceId: 'inv-1', status: 'success', amount: 20000, modifiedDate: '2025-10-05T12:00:05Z' });
  // «сервер KeyCRM» зберіг платіж, але відповів помилкою
  fetchFn.crmState.payments.push({ id: 1, order_id: 777, description: 'Передоплата Monobank, рахунок inv-1', amount: 200 });
  fetchFn.fail.keycrmPayment = false;
  now.advance(60_000);
  await app.tick();
  assert.equal(fetchFn.crmState.payments.length, 1, 'у KeyCRM лишився один платіж, дубль не створено');
  assert.equal(store.paymentsForOrder(1)[0].crm_synced, 1, 'платіж позначено синхронізованим');
});

test('одночасні натискання «Передоплата»: створюється один рахунок', async () => {
  const { app, fetchFn } = makeApp({ cfg: payCfg });
  await submit(app);
  await Promise.all([press(app, 'pay:link'), press(app, 'pay:link'), press(app, 'pay:link')]);
  assert.equal(fetchFn.mono().length, 1);
});

test('вебхук банку: запізніле (старіше) повідомлення не перекриває новіший статус', async () => {
  const { app, store } = makeApp({ cfg: payCfg });
  await submit(app);
  await press(app, 'pay:link');
  await hook(app, { invoiceId: 'inv-1', status: 'success', amount: 20000, modifiedDate: '2025-10-05T12:00:05Z' });
  await hook(app, { invoiceId: 'inv-1', status: 'reversed', amount: 20000, modifiedDate: '2025-10-05T12:10:00Z' });
  assert.equal(store.paymentsForOrder(1)[0].status, 'reversed');
  // Запізніле повторне «success» зі старою датою не повертає гроші в облік
  await hook(app, { invoiceId: 'inv-1', status: 'success', amount: 20000, modifiedDate: '2025-10-05T12:00:05Z' });
  assert.equal(store.paymentsForOrder(1)[0].status, 'reversed');
  assert.equal(store.paidTotal(1), 0);
});

test('повернення коштів: менеджер бачить «повернено», а не «оплата не пройшла»', async () => {
  const { app, fetchFn } = makeApp({ cfg: payCfg });
  await submit(app);
  await press(app, 'pay:link');
  await hook(app, { invoiceId: 'inv-1', status: 'success', amount: 20000, modifiedDate: '2025-10-05T12:00:05Z' });
  await hook(app, { invoiceId: 'inv-1', status: 'reversed', amount: 20000, modifiedDate: '2025-10-05T12:10:00Z' });
  const text = fetchFn.tg('sendMessage').at(-1).body.text;
  assert.match(text, /повернен/i);
  assert.doesNotMatch(text, /не пройшла/);
});

test('переплата не мовчить: у повідомленні про оплату є попередження', async () => {
  const { buildPaidMessage } = await import('../server/message.js');
  const text = buildPaidMessage({ orderNumber: '1', amountCents: 20000, kind: 'custom', totalCents: 100000, paidCents: 120000 });
  assert.match(text, /більше за суму замовлення на 200/);
  assert.doesNotMatch(buildPaidMessage({ orderNumber: '1', amountCents: 20000, kind: 'prepay', totalCents: 100000, paidCents: 100000 }), /більше/);
});

test('після повної оплати нова «передоплата» відхиляється', async () => {
  const { app, fetchFn } = makeApp({ cfg: payCfg });
  await submit(app);
  await press(app, 'pay:full');
  await hook(app, { invoiceId: 'inv-1', status: 'success', amount: 178000, modifiedDate: '2025-10-05T12:00:05Z' });
  await press(app, 'pay:link');
  assert.match(fetchFn.tg('answerCallbackQuery').at(-1).body.text, /вже/i);
  assert.equal(fetchFn.mono().length, 1);
});

test('вебхук: сума оплати відрізняється від рахунку, менеджер отримує попередження', async () => {
  const { app, fetchFn } = makeApp({ cfg: payCfg });
  await submit(app);
  await press(app, 'pay:link');
  await hook(app, { invoiceId: 'inv-1', status: 'success', amount: 20000, finalAmount: 15000, modifiedDate: '2025-10-05T12:00:05Z' });
  assert.match(fetchFn.tg('sendMessage').map((c) => c.body.text).join('\n'), /сума відрізняється/i);
});

test('Telegram повторно доставляє той самий апдейт: дії не виконуються двічі', async () => {
  const { app, fetchFn } = makeApp({ cfg: payCfg });
  await submit(app);
  await press(app, 'pay:link', 101, { updateId: 4242 });
  await press(app, 'pay:link', 101, { updateId: 4242 });
  assert.equal(fetchFn.mono().length, 1);
  assert.equal(fetchFn.tg('sendMessage').filter((c) => /Посилання на/.test(c.body.text)).length, 1);
});

test('Telegram: збій усередині обробки не повертає 500 (інакше Telegram повторює апдейт безкінечно)', async () => {
  const { app, store } = makeApp();
  await submit(app);
  store.findByMessageId = () => { throw new Error('db down'); };
  const r = await press(app, 'st:taken');
  assert.equal(r.status, 200);
});

test('статус у KeyCRM не губиться, якщо перше оновлення не вдалось', async () => {
  const { app, fetchFn, now, store } = makeApp({ cfg: { ...payCfg, keycrmStatusMap: { taken: 55 } } });
  await submit(app);
  fetchFn.fail.keycrm = true;
  await press(app, 'st:taken');
  assert.equal(store.getOrder(1).status, 'taken');
  fetchFn.fail.keycrm = false;
  now.advance(60_000);
  await app.tick();
  assert.ok(fetchFn.crmState.puts.some((b) => b.status_id === 55), 'статус дійшов у KeyCRM (успішний запит)');
});

test('замовлення: фоновий збій Telegram не втрачає замовлення і не дублює його при відновленні', async () => {
  const { app, fetchFn, now, store } = makeApp();
  fetchFn.fail.telegram = true;
  await submit(app);
  fetchFn.fail.telegram = false;
  now.advance(60_000);
  await Promise.all([app.tick(), app.tick()]);
  assert.equal(fetchFn.sentMessages.filter((m) => /Швидке замовлення/.test(m.text)).length, 1, 'повідомлення про замовлення доставлено один раз');
  assert.equal(store.getOrder(1).tg_state, 'sent');
});

test('початок робочого дня: правильний і в дні переходу на зимовий/літній час (Київ)', async () => {
  const { nextWorkStart, effectiveStart } = await import('../server/hours.js');
  const cfg = { workStart: 10, workEnd: 20, timezone: 'Europe/Kyiv' };
  // Звичайний день: 22:00 за Києвом (літо, UTC+3) → наступного дня 10:00 = 07:00Z
  assert.equal(new Date(nextWorkStart(new Date('2026-10-20T19:00:00Z'), cfg)).toISOString(), '2026-10-21T07:00:00.000Z');
  // Ніч перед переходом на зимовий час (25.10.2026): 10:00 того ж дня вже UTC+2 = 08:00Z
  assert.equal(new Date(nextWorkStart(new Date('2026-10-24T19:00:00Z'), cfg)).toISOString(), '2026-10-25T08:00:00.000Z');
  // Перехід на літній час (29.03.2026): 10:00 вже UTC+3 = 07:00Z
  assert.equal(new Date(nextWorkStart(new Date('2026-03-28T19:00:00Z'), cfg)).toISOString(), '2026-03-29T07:00:00.000Z');
  // Рання ніч: «сьогодні» о 10:00
  assert.equal(new Date(nextWorkStart(new Date('2026-10-20T01:30:00Z'), cfg)).toISOString(), '2026-10-20T07:00:00.000Z');
  // Робочий час: годинник іде одразу
  const during = Date.parse('2026-10-20T09:00:00Z');
  assert.equal(effectiveStart(during, cfg), during);
});

test('ТТН: об\'єм місця передається в м³, а не в см³ чи «об\'ємній вазі»', async () => {
  const { app, fetchFn } = makeApp({ cfg: { monobankToken: 'M', novaPoshtaApiKey: 'npkey', keycrmToken: 'crm' } });
  const city = { ref: 'e71a0b8e-9b3d-4a39-8a1f-111111111111', name: 'Чернівці', present: 'м. Чернівці', area: 'Чернівецька' };
  const point = { ref: 'd1a8e3e2-1111-4a39-8a1f-222222222222', number: '3', name: 'Відділення №3' };
  await submit(app, goodBody({ surname: 'Петренко', delivery: { method: 'warehouse', city, point } }));
  await press(app, 'pay:link');
  await hook(app, { invoiceId: 'inv-1', status: 'success', amount: 20000, modifiedDate: '2025-10-05T12:00:05Z' });
  await press(app, 'ttn:1');
  const save = fetchFn.calls.find((c) => c.body?.modelName === 'InternetDocument');
  const seat = save.body.methodProperties.OptionsSeat[0];
  assert.equal(seat.volumetricVolume, '0.00375');
  assert.equal(seat.volumetricLength, '30');
  assert.equal(seat.weight, '1');
});

test('конфіг: некоректне число в змінній оточення дає зрозумілу помилку, а не NaN', async () => {
  const { loadConfig } = await import('../server/config.js');
  const base = { SHOPIFY_SHOP: 'a.myshopify.com', SHOPIFY_API_SECRET: 's', TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: '1', TELEGRAM_WEBHOOK_SECRET: 'w' };
  assert.throws(() => loadConfig({ ...base, WORK_HOURS_START: '10 год' }), /WORK_HOURS_START/);
  assert.equal(loadConfig({ ...base, PREPAY_AMOUNT_UAH: '150,5' }).prepayAmountUah, 150.5);
  assert.equal(loadConfig({ ...base }).workStart, 10);
});

test('ТТН: після зміни API-ключа відправник визначається заново (кеш не «прилипає» до старого акаунта)', async () => {
  const { app: app1, fetchFn: f1, store } = makeApp({ cfg: { monobankToken: 'M', novaPoshtaApiKey: 'key-A' } });
  const { createTtnService } = await import('../server/ttn.js');
  const { createNovaPoshta } = await import('../server/novaposhta.js');
  const { config } = await import('./helpers.js');
  const mk = (key) => createTtnService({ np: createNovaPoshta({ apiKey: key, fetchFn: f1, sleep: async () => {} }), config: { ...config, novaPoshtaApiKey: key }, store });
  const order = (id) => ({ id, order_number: '1', data: { delivery: { method: 'warehouse', city: { ref: 'e71a0b8e-9b3d-4a39-8a1f-111111111111' }, point: { ref: 'd1a8e3e2-1111-4a39-8a1f-222222222222' } }, name: 'Іван', surname: 'П', phone: '+380671234567', totalCents: 100000, options: [], quantity: 1, productTitle: 'T' } });
  await mk('key-A').create({ order: order(1), paidCents: 0 });
  const senderCalls = () => f1.calls.filter((c) => c.body?.calledMethod === 'getCounterparties').length;
  assert.equal(senderCalls(), 1);
  await mk('key-A').create({ order: order(2), paidCents: 0 });
  assert.equal(senderCalls(), 1, 'з тим самим ключем відправник береться з кешу');
  await mk('key-B').create({ order: order(3), paidCents: 0 });
  assert.equal(senderCalls(), 2, 'з новим ключем відправник знаходиться заново');
  assert.ok(app1);
});

test('звіт: спам і скасовані не входять у суму; нічні замовлення не псують середній час відповіді', async () => {
  const { buildWeeklyReport } = await import('../server/report.js');
  const mk = (status, total, createdAt, firstResponse) => ({
    status, created_at: createdAt, first_response_at: firstResponse,
    data: { totalCents: total, quantity: 1, productTitle: 'T', afterHours: false, utm: {} },
  });
  const t0 = Date.parse('2026-10-20T00:00:00Z');
  const orders = [
    mk('confirmed', 100000, t0, t0 + 10 * 60_000),
    mk('spam', 900000, t0, t0 + 60_000),
    mk('cancelled', 500000, t0, t0 + 60_000),
    // Нічне замовлення (створене о 01:00), відповідь о 10:05 при початку дня о 10:00: чекало 5 хв, а не 9 годин
    mk('taken', 50000, t0 + 3600_000, t0 + 10 * 3600_000 + 5 * 60_000),
  ];
  const text = buildWeeklyReport(orders, {
    from: t0, to: t0 + 7 * 86400_000, timezone: 'Europe/Kyiv', payments: [],
    startOf: (o) => (o.created_at === t0 + 3600_000 ? t0 + 10 * 3600_000 : o.created_at),
  });
  assert.match(text, /Сума \(без спаму й скасованих\): <b>1\s?500\s₴/);
  assert.match(text, /Середній час до першої відповіді: 4 хв/);
});

test('ТТН: якщо KeyCRM не прийняв трекінг-код, він дописується фоновою чергою; збій повідомлення не видається за невдалу ТТН', async () => {
  const { app, fetchFn, store, now } = makeApp({ cfg: { monobankToken: 'M', novaPoshtaApiKey: 'npkey', keycrmToken: 'crm' } });
  const city = { ref: 'e71a0b8e-9b3d-4a39-8a1f-111111111111', name: 'Чернівці', present: 'м. Чернівці', area: 'Чернівецька' };
  const point = { ref: 'd1a8e3e2-1111-4a39-8a1f-222222222222', number: '3', name: 'Відділення №3' };
  await submit(app, goodBody({ surname: 'Петренко', delivery: { method: 'warehouse', city, point } }));
  await press(app, 'pay:link');
  await hook(app, { invoiceId: 'inv-1', status: 'success', amount: 20000, modifiedDate: '2025-10-05T12:00:05Z' });
  fetchFn.fail.keycrm = true;
  await press(app, 'ttn:1');
  assert.equal(store.getOrder(1).ttn_number, '20451234567890');
  assert.equal(store.getOrder(1).ttn_crm_synced, 0);
  assert.doesNotMatch(fetchFn.sentMessages.at(-1).text, /Не вдалося створити ТТН/);
  assert.match(fetchFn.sentMessages.at(-1).text, /не вдалося записати в KeyCRM/);
  fetchFn.fail.keycrm = false;
  now.advance(60_000);
  await app.tick();
  assert.equal(store.getOrder(1).ttn_crm_synced, 1);
  assert.ok(fetchFn.crmState.puts.some((b) => b.shipping?.tracking_code === '20451234567890'));
});

test('пошук відділень у великому місті: номер за межами першої сторінки (500) знаходиться', async () => {
  const { createNovaPoshta } = await import('../server/novaposhta.js');
  const all = Array.from({ length: 1200 }, (_, i) => ({
    Ref: `ref-${i + 1}`, Number: String(i + 1), Description: `Відділення №${i + 1}: вул. Тестова, ${i + 1}`,
    ShortAddress: `вул. Тестова, ${i + 1}`, CategoryOfWarehouse: 'Branch',
  }));
  const fetchFn = async (_url, init) => {
    const p = JSON.parse(init.body).methodProperties;
    // «Нова пошта» не знаходить номер через FindByString (як у реальному житті), лише віддає сторінки
    if (p.FindByString) return Response.json({ success: true, data: [] });
    const page = Number(p.Page);
    return Response.json({ success: true, data: all.slice((page - 1) * 500, page * 500) });
  };
  const np = createNovaPoshta({ apiKey: 'k', fetchFn });
  const found = await np.searchPoints({ settlement: 'x', query: '1111', kind: 'warehouse' });
  assert.deepEqual(found.map((p) => p.number), ['1111']);
});

test('ТТН: двозначний відправник (кілька міст з такою назвою) відхиляється з поясненням, а не вгадується', async () => {
  const { createTtnService } = await import('../server/ttn.js');
  const { createNovaPoshta } = await import('../server/novaposhta.js');
  const { config } = await import('./helpers.js');
  const { openStore } = await import('../server/store.js');
  const fetchFn = async (_u, init) => {
    const b = JSON.parse(init.body);
    if (b.calledMethod === 'getCounterparties') return Response.json({ success: true, data: [{ Ref: 'cp' }] });
    if (b.calledMethod === 'getCounterpartyContactPersons') return Response.json({ success: true, data: [{ Ref: 'c', Phones: '380501112233' }] });
    return Response.json({ success: true, data: [
      { Ref: 'w1', Number: '31', CityRef: 'city-A', CategoryOfWarehouse: 'Branch' },
      { Ref: 'w2', Number: '31', CityRef: 'city-B', CategoryOfWarehouse: 'Branch' },
    ] });
  };
  const svc = createTtnService({ np: createNovaPoshta({ apiKey: 'k', fetchFn }), config: { ...config, novaPoshtaApiKey: 'k' }, store: openStore(':memory:') });
  const order = { id: 1, order_number: '1', data: { delivery: { method: 'warehouse', city: { ref: 'e71a0b8e-9b3d-4a39-8a1f-111111111111' }, point: { ref: 'd1a8e3e2-1111-4a39-8a1f-222222222222' } }, name: 'Іван', surname: 'П', phone: '+380671234567', totalCents: 1000, options: [], quantity: 1, productTitle: 'T' } };
  await assert.rejects(svc.create({ order, paidCents: 0 }), /кількох населених пунктах/);
});

test('оновлення бази: у вже існуючих замовлень статус KeyCRM і ТТН вважаються синхронізованими (нічого не перезаписується)', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { DatabaseSync } = await import('node:sqlite');
  const { openStore } = await import('../server/store.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qo-migrate-'));
  const file = path.join(dir, 'old.db');

  // «Стара» база: ті ж таблиці, але без колонок, які з'явились пізніше
  const first = openStore(file);
  first.insertOrder({ orderNumber: 'OLD-1', clientId: 'c1', fingerprint: 'f1', createdAt: 1, data: { totalCents: 1000 } });
  first.insertOrder({ orderNumber: 'OLD-2', clientId: 'c2', fingerprint: 'f2', createdAt: 2, data: { totalCents: 1000 } });
  first.markCrmSent(1, 501);
  first.markCrmSent(2, 502);
  first.setStatus(1, 'taken', 'Оля', 10);
  first.setTtn(2, '20450000000001', 'ref');
  first.close();
  const raw = new DatabaseSync(file);
  raw.exec('ALTER TABLE orders DROP COLUMN crm_status');
  raw.exec('ALTER TABLE orders DROP COLUMN ttn_crm_synced');
  raw.exec('ALTER TABLE payments DROP COLUMN modified_at');
  raw.close();

  const upgraded = openStore(file);
  assert.deepEqual(upgraded.statusDrift(), [], 'старі статуси не відправляються в KeyCRM повторно (інакше перезапишуться зміни менеджерів)');
  assert.deepEqual(upgraded.ttnNotInCrm(), [], 'старі ТТН не дописуються в KeyCRM повторно');
  // Нові зміни після оновлення синхронізуються як звичайно
  upgraded.setStatus(1, 'confirmed', 'Оля', 20);
  assert.equal(upgraded.statusDrift().length, 1);
  upgraded.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('фонова черга: збій одного етапу не зупиняє інші (нагадування, звіт, доставка)', async () => {
  const { app, fetchFn, store, now } = makeApp({ cfg: payCfg });
  fetchFn.fail.telegram = true;
  await submit(app);
  fetchFn.fail.telegram = false;
  store.crmDue = () => { throw new Error('db glitch'); };
  now.advance(60_000);
  await app.tick();
  assert.equal(store.getOrder(1).tg_state, 'sent', 'доставка в Telegram відбулась, хоча етап KeyCRM зламаний');
});

test('фаззінг: сміттєві й дивні вхідні дані ніколи не дають 500 і не створюють замовлень із порожніми полями', async () => {
  const { app, store } = makeApp();
  const weird = [
    null, undefined, 0, -1, 1e21, NaN, '', ' ', '\u0000', '<script>alert(1)</script>', 'a'.repeat(5000), [], {}, [[]],
    { a: 1 }, true, '🔥'.repeat(100), '１２３', '+', '++380', '%00', '../../etc/passwd', { toString: 'x' }, ['x'], 9007199254740993,
  ];
  const fields = ['product_handle', 'variant_id', 'quantity', 'name', 'surname', 'phone', 'comment', 'city', 'delivery', 'utm', 'referrer', 'click', 'page_url', 'client_id', 'website', 'body'];
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  let accepted = 0;
  for (let i = 0; i < 300; i += 1) {
    const body = goodBody({ client_id: `fuzz-client-${i}-xxxx`, phone: `+38067${String(1000000 + i).slice(-7)}` });
    for (let k = 0; k < 1 + rnd(4); k += 1) body[fields[rnd(fields.length)]] = weird[rnd(weird.length)];
    const r = await submit(app, body);
    assert.ok(r.status < 500, `статус ${r.status} для ${JSON.stringify(body).slice(0, 200)}`);
    if (r.status === 200 && !body.website) accepted += 1;
  }
  for (const order of store.ordersSince(0)) {
    assert.ok(order.data.name.length >= 2 && /^\+\d{8,15}$/.test(order.data.phone), 'у базу потрапили лише валідні імʼя й телефон');
    assert.ok(order.data.quantity >= 1 && order.data.quantity <= 10);
  }
  assert.ok(accepted > 0);
  // Сирі тіла: не JSON, масив, надто великий
  for (const raw of ['not json', '[]', 'null', '"str"', '{"product_handle":', 'x'.repeat(20_000)]) {
    const r = await call(app, { url: signedUrl(), rawBody: raw });
    assert.ok(r.status >= 400 && r.status < 500, `сире тіло «${raw.slice(0, 20)}» → ${r.status}`);
  }
});

test('фаззінг вебхуків: сміттєві апдейти Telegram і підписані кривi повідомлення банку не дають 5xx', async () => {
  const { app } = makeApp({ cfg: { monobankToken: 'M', novaPoshtaApiKey: 'k', keycrmToken: 'crm' } });
  await submit(app);
  const datas = ['', 'st:', 'st:nope', 'pay:', 'pay:link:extra', 'ttn:', 'ttn:abc', 'ttn:999999', 'ttn0:-1', 'ttn:1e3', 'x'.repeat(100), 'st:taken\u0000'];
  for (const data of datas) {
    const r = await call(app, { url: '/telegram/webhook', headers, body: { update_id: ++updateId, callback_query: { id: 'x', data, from: {}, message: { message_id: 101, chat: { id: -100500 } } } } });
    assert.equal(r.status, 200, `callback «${data.slice(0, 12)}»`);
  }
  const updates = [{}, { message: null }, { message: { chat: { id: -100500 } } }, { message: { chat: { id: -100500 }, reply_to_message: {}, text: 5 } },
    { callback_query: {} }, { callback_query: { message: {} } }, { update_id: 'x', callback_query: { data: 'st:taken', message: { message_id: 'z', chat: { id: -100500 } } } }];
  for (const u of updates) {
    const r = await call(app, { url: '/telegram/webhook', headers, body: u });
    assert.equal(r.status, 200, JSON.stringify(u));
  }
  for (const payload of [{}, { invoiceId: 5 }, { invoiceId: 'inv-1', status: null }, { invoiceId: 'inv-1', status: 'success', modifiedDate: 'garbage', finalAmount: 'x' }, []]) {
    const r = await hook(app, payload);
    assert.ok(r.status < 500, `вебхук банку ${JSON.stringify(payload)} → ${r.status}`);
  }
});

test('фаззінг підказок Нової пошти: некоректні параметри дають 4xx, а не 500', async () => {
  const { app } = makeApp({ cfg: { novaPoshtaApiKey: 'k' } });
  const qs = ['', 'q=', 'q=%00', `q=${'я'.repeat(500)}`, 'settlement=not-a-uuid', 'settlement=&kind=postomat', 'kind=%27%3B--', 'settlement=e71a0b8e-9b3d-4a39-8a1f-111111111111&q=%25&kind=warehouse'];
  for (const path of ['cities', 'points', 'streets']) {
    for (const extra of qs) {
      const r = await call(app, { method: 'GET', url: signedUrl(`/proxy/np/${path}`).replace('?', `?${extra}&`) });
      // Додані параметри входять у підпис, тому без перепідпису запит відхиляється: головне, що це не 500
      assert.ok(r.status < 500, `${path}?${extra} → ${r.status}`);
    }
  }
  for (const path of ['cities', 'points', 'streets']) {
    for (const extra of qs.slice(1)) {
      const params = new URLSearchParams(extra);
      const r = await call(app, { method: 'GET', url: signedUrl(`/proxy/np/${path}`, Object.fromEntries(params)) });
      assert.ok(r.status < 500, `підписаний ${path}?${extra} → ${r.status}`);
    }
  }
});

test('пропущений вебхук банку: фонова звірка за invoice/status підхоплює оплату рівно один раз', async () => {
  const { app, fetchFn, store, now } = makeApp({ cfg: payCfg });
  await submit(app);
  await press(app, 'pay:link');
  // Клієнт заплатив, але вебхуки не дійшли (наприклад, сервер перезапускався)
  fetchFn.monoStatus['inv-1'] = { status: 'success', amount: 20000, finalAmount: 20000, modifiedDate: '2025-10-05T12:03:00Z' };
  now.advance(6 * 60_000);
  await app.tick();
  assert.equal(store.paymentsForOrder(1)[0].status, 'success');
  assert.equal(store.paidTotal(1), 20000);
  assert.equal(fetchFn.sentMessages.filter((m) => /Передоплата 200\s₴ отримана/.test(m.text)).length, 1);
  assert.equal(fetchFn.crmState.payments.length, 1, 'платіж записано в KeyCRM');
  // Запізніла копія вебхука й наступні звірки нічого не дублюють
  await hook(app, { invoiceId: 'inv-1', status: 'success', amount: 20000, modifiedDate: '2025-10-05T12:03:00Z' });
  now.advance(60 * 60_000);
  await app.tick();
  assert.equal(fetchFn.sentMessages.filter((m) => /отримана/.test(m.text)).length, 1);
  assert.equal(fetchFn.crmState.payments.length, 1);
});

test('звірка оплат: не частіше за заданий інтервал і лише для рахунків, що ще можуть бути оплачені', async () => {
  const { app, fetchFn, now, store } = makeApp({ cfg: payCfg });
  await submit(app);
  await press(app, 'pay:link');
  now.advance(6 * 60_000);
  await app.tick();
  await app.tick();
  assert.equal(fetchFn.monoPolls, 1, 'повторний тік одразу не опитує банк знову');
  fetchFn.monoStatus['inv-1'] = { status: 'expired', amount: 20000, modifiedDate: '2025-10-06T12:00:00Z' };
  now.advance(10 * 60_000);
  await app.tick();
  assert.equal(store.paymentsForOrder(1)[0].status, 'expired');
  const polls = fetchFn.monoPolls;
  now.advance(10 * 3600_000);
  await app.tick();
  assert.equal(fetchFn.monoPolls, polls, 'завершені рахунки більше не опитуються');
});

test('звірка оплат: помилка банку (429) не ламає чергу і не втрачає оплату при наступній спробі', async () => {
  const { app, fetchFn, store, now } = makeApp({ cfg: payCfg });
  await submit(app);
  await press(app, 'pay:link');
  fetchFn.monoStatus['inv-1'] = { status: 'success', amount: 20000, modifiedDate: '2025-10-05T12:03:00Z' };
  fetchFn.fail.monoStatus = true;
  now.advance(6 * 60_000);
  await app.tick();
  assert.equal(store.paymentsForOrder(1)[0].status, 'created');
  fetchFn.fail.monoStatus = false;
  now.advance(6 * 60_000);
  await app.tick();
  assert.equal(store.paymentsForOrder(1)[0].status, 'success');
});

test('відкритий ключ банку: підроблені вебхуки не змушують нас безперервно запитувати ключ', async () => {
  const { createMonobank } = await import('../server/monobank.js');
  const calls = [];
  const { signMono } = await import('./helpers.js');
  const crypto = await import('node:crypto');
  const keys = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pem = keys.publicKey.export({ type: 'spki', format: 'pem' });
  let t = 1_000_000;
  const fetchFn = async (url) => {
    calls.push(String(url));
    return Response.json({ key: Buffer.from(pem).toString('base64') });
  };
  const mono = createMonobank({ token: 't', fetchFn, clock: () => t });
  for (let i = 0; i < 20; i += 1) assert.equal(await mono.verifyWebhook('{"a":1}', 'AAAA'), false);
  assert.equal(calls.length, 1, 'ключ запитано один раз, а не 20');
  t += 11 * 60_000; // минуло 10+ хвилин: оновлення дозволене (раптом ключ змінився)
  assert.equal(await mono.verifyWebhook('{"a":1}', 'AAAA'), false);
  assert.equal(calls.length, 2);
  // Справжній підпис проходить без додаткових запитів
  const raw = '{"invoiceId":"x"}';
  const sig = crypto.sign('sha256', Buffer.from(raw), keys.privateKey).toString('base64');
  assert.equal(await mono.verifyWebhook(raw, sig), true);
  assert.equal(calls.length, 2);
  assert.ok(signMono);
});

test('часткове повернення коштів у банку: облік оплат зменшується, менеджер отримує повідомлення, повтор не дублює', async () => {
  const { app, fetchFn, store } = makeApp({ cfg: payCfg });
  await submit(app);
  await press(app, 'pay:full');
  await hook(app, { invoiceId: 'inv-1', status: 'success', amount: 178000, finalAmount: 178000, modifiedDate: '2025-10-05T12:00:05Z' });
  assert.equal(store.paidTotal(1), 178000);
  await hook(app, { invoiceId: 'inv-1', status: 'success', amount: 178000, finalAmount: 138000, modifiedDate: '2025-10-05T13:00:00Z' });
  assert.equal(store.paidTotal(1), 138000, 'сплачено рахується за сумою після повернення');
  assert.equal(store.paymentsForOrder(1)[0].status, 'success');
  const notices = fetchFn.sentMessages.filter((m) => /частково повернено/.test(m.text));
  assert.equal(notices.length, 1);
  assert.match(notices[0].text, /400/);
  await hook(app, { invoiceId: 'inv-1', status: 'success', amount: 178000, finalAmount: 138000, modifiedDate: '2025-10-05T13:00:00Z' });
  assert.equal(fetchFn.sentMessages.filter((m) => /частково повернено/.test(m.text)).length, 1);
  // Старе повідомлення (до повернення) не «повертає» гроші в облік
  await hook(app, { invoiceId: 'inv-1', status: 'success', amount: 178000, finalAmount: 178000, modifiedDate: '2025-10-05T12:00:05Z' });
  assert.equal(store.paidTotal(1), 138000);
});
