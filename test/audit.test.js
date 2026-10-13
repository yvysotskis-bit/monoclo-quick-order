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
