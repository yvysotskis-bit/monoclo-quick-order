import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '../server/store.js';
import { parseAmountKopecks } from '../server/message.js';
import { call, makeApp, signMono, submit } from './helpers.js';

const payCfg = { monobankToken: 'MONOTOKEN', prepayAmountUah: 200 };
const headers = { 'x-telegram-bot-api-secret-token': 'hook-secret' };

const press = (app, data = 'pay:link', messageId = 101) => call(app, {
  url: '/telegram/webhook',
  headers,
  body: { callback_query: { id: 'cb', data, from: { id: 55, first_name: 'Оля' }, message: { message_id: messageId, chat: { id: -100500 }, text: 'T', entities: [] } } },
});

// Відповідь менеджера на повідомлення бота з проханням ввести суму
const reply = (app, text, replyToId, from = { id: 55, first_name: 'Оля' }) => call(app, {
  url: '/telegram/webhook',
  headers,
  body: { message: { message_id: 900, chat: { id: -100500 }, from, text, reply_to_message: { message_id: replyToId } } },
});

const monoHook = (app, payload, { sign = true, tamper = false } = {}) => {
  const raw = JSON.stringify(payload);
  return call(app, {
    url: '/mono/webhook',
    rawBody: tamper ? raw.replace('success', 'success ') : raw,
    headers: sign ? { 'x-sign': signMono(raw) } : {},
  });
};

// id останнього повідомлення-запиту суми (мок Telegram нумерує кожен виклик, тож рахувати наперед не можна)
const lastPromptId = (store) => store.db.prepare('SELECT message_id FROM pay_prompts ORDER BY rowid DESC LIMIT 1').get()?.message_id;

const texts = (fetchFn) => fetchFn.tg('sendMessage').map((c) => c.body.text);
const callbacks = (kb) => kb.inline_keyboard.flat().map((b) => b.callback_data).filter(Boolean);

test('розбір суми: різні формати, сміття відхиляється', () => {
  assert.equal(parseAmountKopecks('1500'), 150000);
  assert.equal(parseAmountKopecks('1 500,50 грн'), 150050);
  assert.equal(parseAmountKopecks('1499.5'), 149950);
  for (const bad of ['', 'abc', '0', '-5', '12.345', '1,5,5', null]) assert.equal(parseAmountKopecks(bad), null, String(bad));
});

test('без токена Monobank кнопок оплати немає і вони не працюють', async () => {
  const { app, fetchFn } = makeApp();
  await submit(app);
  const kb = fetchFn.tg('sendMessage')[0].body.reply_markup;
  assert.deepEqual(callbacks(kb).filter((c) => c.startsWith('pay:')), []);
  await press(app);
  await press(app, 'pay:custom');
  assert.equal(fetchFn.mono().length, 0);
  assert.equal(fetchFn.tg('answerCallbackQuery').at(-1).body.text, 'Оплата не налаштована');
});

test('кнопки оплати: передоплата, повна сума, інша сума; зберігаються після зміни статусу', async () => {
  const { app, fetchFn } = makeApp({ cfg: payCfg });
  await submit(app);
  const kb = fetchFn.tg('sendMessage')[0].body.reply_markup;
  assert.deepEqual(callbacks(kb).filter((c) => c.startsWith('pay:')), ['pay:link', 'pay:full', 'pay:custom']);
  const labels = kb.inline_keyboard.flat().map((b) => b.text);
  assert.ok(labels.includes('💳 Передоплата 200 ₴'));
  assert.ok(labels.some((t) => /Повна сума 1[\s ]780/.test(t)));
  assert.ok(labels.includes('✏️ Інша сума'));

  await press(app, 'st:taken');
  assert.deepEqual(callbacks(fetchFn.tg('editMessageText')[0].body.reply_markup).filter((c) => c.startsWith('pay:')),
    ['pay:link', 'pay:full', 'pay:custom']);
});

test('передоплата: рахунок на 200 ₴, готовий текст, повторне натискання не створює новий', async () => {
  const { app, fetchFn, store } = makeApp({ cfg: payCfg });
  await submit(app);
  await press(app);

  const [invoice] = fetchFn.mono();
  assert.equal(invoice.headers['X-Token'], 'MONOTOKEN');
  assert.equal(invoice.body.amount, 20000);
  assert.equal(invoice.body.ccy, 980);
  assert.equal(invoice.body.merchantPaymInfo.reference, '20251005-150000');
  assert.match(invoice.body.merchantPaymInfo.destination, /^Передоплата за замовлення/);
  assert.equal(invoice.body.webHookUrl, 'https://qo.test/mono/webhook');
  assert.equal(invoice.body.validity, 86400);

  const message = fetchFn.tg('sendMessage').at(-1);
  assert.match(message.body.text, /<code>Вітаємо! Щоб підтвердити замовлення №20251005-150000.*передоплату 200\s₴: https:\/\/pay\.mono\.bank\/inv-1<\/code>/);
  assert.match(message.body.text, /Створив\(ла\): Оля/);
  assert.equal(message.body.reply_parameters.message_id, 101);
  assert.equal(store.paymentsForOrder(1)[0].kind, 'prepay');

  await press(app);
  assert.equal(fetchFn.mono().length, 1, 'посилання перевикористано');
  assert.match(texts(fetchFn).at(-1), /inv-1/);
});

test('повна сума: рахунок на всю суму замовлення', async () => {
  const { app, fetchFn, store } = makeApp({ cfg: payCfg });
  await submit(app);
  await press(app, 'pay:full');
  assert.equal(fetchFn.mono()[0].body.amount, 178000);
  assert.match(fetchFn.mono()[0].body.merchantPaymInfo.destination, /^Оплата замовлення/);
  assert.match(texts(fetchFn).at(-1), /Для оплати замовлення №20251005-150000 на суму 1[\s ]780[\s ]₴/);
  assert.equal(store.paymentsForOrder(1)[0].kind, 'full');
});

test('«Залишок» після передоплати: рахунок на різницю, оплачене враховано', async () => {
  const { app, fetchFn } = makeApp({ cfg: payCfg });
  await submit(app);
  await press(app);
  await monoHook(app, { invoiceId: 'inv-1', status: 'success', amount: 20000 });
  await press(app, 'pay:full');
  assert.equal(fetchFn.mono()[1].body.amount, 158000);
  assert.match(texts(fetchFn).at(-1), /Уже сплачено: 200\s₴/);
  assert.equal(fetchFn.mono()[1].body.merchantPaymInfo.reference, '20251005-150000-2');
});

test('інша сума: бот просить відповісти, менеджер вводить число, створюється рахунок', async () => {
  const { app, fetchFn, store } = makeApp({ cfg: payCfg });
  await submit(app);
  await press(app, 'pay:custom');

  const prompt = fetchFn.tg('sendMessage').at(-1);
  assert.match(prompt.body.text, /<a href="tg:\/\/user\?id=55">Оля<\/a>, введіть суму в гривнях для замовлення #20251005-150000/);
  assert.deepEqual(prompt.body.reply_markup, { force_reply: true, selective: true, input_field_placeholder: 'Сума в гривнях, наприклад 1500' });
  const promptId = lastPromptId(store);
  assert.ok(store.findPrompt(promptId));

  await reply(app, 'не знаю', promptId);
  assert.match(texts(fetchFn).at(-1), /Не вдалося розпізнати суму/);
  assert.ok(store.findPrompt(promptId), 'прохання лишається після помилки');
  assert.equal(fetchFn.mono().length, 0);

  await reply(app, '1 500,50', promptId);
  assert.equal(fetchFn.mono()[0].body.amount, 150050);
  const link = fetchFn.tg('sendMessage').at(-1);
  assert.match(link.body.text, /Посилання на оплату 1[\s ]500,50[\s ]₴/);
  assert.equal(link.body.reply_parameters.message_id, 101);
  assert.equal(store.paymentsForOrder(1)[0].kind, 'custom');
  assert.equal(store.findPrompt(promptId), null, 'прохання використано');

  // Ту саму відповідь повторно оброблено не буде
  const before = fetchFn.mono().length;
  await reply(app, '1500', promptId);
  assert.equal(fetchFn.mono().length, before);
});

test('інша сума: ліміт, чужі відповіді, застарілий запит, перевищення суми замовлення', async () => {
  const { app, fetchFn, store, now } = makeApp({ cfg: payCfg });
  await submit(app);
  await press(app, 'pay:custom');
  const promptId = lastPromptId(store);

  await reply(app, '99999', promptId);
  assert.match(texts(fetchFn).at(-1), /Максимум 50000 ₴/);
  assert.equal(fetchFn.mono().length, 0);

  // Відповідь на інше повідомлення ігнорується
  const calls = fetchFn.calls.length;
  await reply(app, '1500', 12345);
  assert.equal(fetchFn.calls.length, calls);

  // Сума більша за замовлення: рахунок створюється, але з попередженням
  await reply(app, '2500', promptId);
  assert.equal(fetchFn.mono()[0].body.amount, 250000);
  assert.match(texts(fetchFn).at(-1), /перевищує суму замовлення/);

  // Через 30 хвилин запит застарів
  await press(app, 'pay:custom');
  const staleId = lastPromptId(store);
  now.advance(31 * 60_000);
  await reply(app, '1000', staleId);
  assert.match(texts(fetchFn).at(-1), /Запит застарів/);
  assert.equal(store.findPrompt(staleId), null);
});

test('інша сума закриває старий неоплачений рахунок з іншою сумою', async () => {
  const { app, fetchFn, store } = makeApp({ cfg: payCfg });
  await submit(app);
  await press(app); // передоплата 200
  await press(app, 'pay:custom');
  await reply(app, '1500', lastPromptId(store));

  assert.equal(fetchFn.monoRemoved().length, 1);
  assert.deepEqual(fetchFn.monoRemoved()[0].body, { invoiceId: 'inv-1' });
  assert.deepEqual(store.paymentsForOrder(1).map((p) => p.status), ['removed', 'created']);

  // Але якщо клієнт все ж оплатив старе посилання, оплата не губиться
  await monoHook(app, { invoiceId: 'inv-1', status: 'success', amount: 20000 });
  assert.equal(store.paidTotal(1), 20000);
});

test('збій банку: менеджер бачить помилку, замовлення не страждає', async () => {
  const { app, fetchFn, store } = makeApp({ cfg: payCfg });
  await submit(app);
  fetchFn.fail.monobank = true;
  await press(app);
  assert.match(fetchFn.tg('answerCallbackQuery').at(-1).body.text, /Не вдалося створити посилання/);
  assert.equal(store.paymentsForOrder(1).length, 0);
});

test('вебхук банку: оплата відмічається один раз, показано залишок, іде в KeyCRM', async () => {
  const { app, fetchFn, store } = makeApp({
    cfg: { ...payCfg, keycrmToken: 'CRMTOKEN', keycrmPaymentMethodId: 9 },
  });
  await submit(app);
  await press(app);

  const payload = { invoiceId: 'inv-1', status: 'success', amount: 20000, finalAmount: 20000 };
  assert.equal((await monoHook(app, payload)).status, 200);
  assert.equal(store.paymentsForOrder(1)[0].status, 'success');
  assert.ok(store.paymentsForOrder(1)[0].paid_at);
  const notice = texts(fetchFn).at(-1);
  assert.match(notice, /Передоплата 200\s₴ отримана за замовленням #20251005-150000/);
  assert.match(notice, /Сплачено 200\s₴ з 1[\s ]780\s₴, залишок 1[\s ]580\s₴/);

  const payment = fetchFn.crm().find((c) => c.url.endsWith('/order/777/payment'));
  assert.deepEqual(payment.body, {
    payment_method_id: 9, amount: 200, status: 'paid', description: 'передоплата Monobank, рахунок inv-1',
  });
  assert.equal(store.paymentsForOrder(1)[0].crm_synced, 1);

  // Повторний вебхук та запізніле «processing»: без дублів
  const before = fetchFn.calls.length;
  await monoHook(app, payload);
  await monoHook(app, { ...payload, status: 'processing' });
  assert.equal(fetchFn.calls.length, before);

  // Передоплата вдруге не створюється
  await press(app);
  assert.equal(fetchFn.mono().length, 1);
  assert.equal(fetchFn.tg('answerCallbackQuery').at(-1).body.text, 'Передоплата вже отримана');
});

test('повна оплата: повідомлення «оплачено повністю», нова оплата не створюється', async () => {
  const { app, fetchFn } = makeApp({ cfg: payCfg });
  await submit(app);
  await press(app, 'pay:full');
  await monoHook(app, { invoiceId: 'inv-1', status: 'success', amount: 178000 });
  assert.match(texts(fetchFn).at(-1), /Замовлення оплачено повністю/);
  await press(app, 'pay:full');
  assert.equal(fetchFn.mono().length, 1);
  assert.equal(fetchFn.tg('answerCallbackQuery').at(-1).body.text, 'Замовлення вже оплачено повністю');
});

test('вебхук банку без дійсного підпису відхиляється, статус не змінюється', async () => {
  const { app, store } = makeApp({ cfg: payCfg });
  await submit(app);
  await press(app);
  const payload = { invoiceId: 'inv-1', status: 'success', amount: 20000 };

  assert.equal((await monoHook(app, payload, { sign: false })).status, 401);
  assert.equal((await monoHook(app, payload, { tamper: true })).status, 401);
  const forged = await call(app, { url: '/mono/webhook', rawBody: JSON.stringify(payload), headers: { 'x-sign': 'AAAA' } });
  assert.equal(forged.status, 401);
  assert.equal(store.paymentsForOrder(1)[0].status, 'created');
  // Невідомий рахунок з валідним підписом просто ігнорується
  assert.equal((await monoHook(app, { invoiceId: 'nope', status: 'success', amount: 1 })).status, 200);
});

test('невдала оплата: попередження менеджеру й можна створити нове посилання', async () => {
  const { app, fetchFn, store } = makeApp({ cfg: payCfg });
  await submit(app);
  await press(app);
  await monoHook(app, { invoiceId: 'inv-1', status: 'failure', failureReason: 'Недостатньо коштів', amount: 20000 });
  assert.equal(store.paymentsForOrder(1)[0].status, 'failure');
  assert.match(texts(fetchFn).at(-1), /Оплата за замовленням #20251005-150000 не пройшла \(Недостатньо коштів\)/);

  await press(app);
  assert.equal(fetchFn.mono().length, 2);
  assert.match(texts(fetchFn).at(-1), /inv-2/);
});

test('оплата, що надійшла до створення замовлення в KeyCRM, фіксується там, коли воно зʼявиться', async () => {
  const { app, fetchFn, store, now } = makeApp({
    cfg: { ...payCfg, keycrmToken: 'CRMTOKEN', keycrmPaymentMethodId: 9 },
  });
  fetchFn.fail.keycrm = true;
  await submit(app);
  await press(app);
  await monoHook(app, { invoiceId: 'inv-1', status: 'success', amount: 20000 });
  assert.equal(fetchFn.crm().filter((c) => c.url.endsWith('/payment')).length, 0);

  fetchFn.fail.keycrm = false;
  now.advance(60_000);
  await app.tick();
  assert.equal(store.getOrder(1).crm_state, 'sent');
  assert.equal(fetchFn.crm().filter((c) => c.url.endsWith('/order/777/payment')).length, 1);
  assert.equal(store.paymentsForOrder(1)[0].crm_synced, 1);
});

test('у звіті зʼявляється кількість і сума отриманих оплат', async () => {
  const { app, fetchFn, now } = makeApp({ cfg: payCfg, at: '2025-10-01T09:00:00Z' });
  await submit(app);
  await press(app);
  await monoHook(app, { invoiceId: 'inv-1', status: 'success', amount: 20000 });
  now.set('2025-10-06T06:30:00Z');
  await app.tick();
  const report = fetchFn.tg('sendMessage').find((c) => /Звіт за тиждень/.test(c.body.text));
  assert.match(report.body.text, /Оплат отримано: 1 на 200\s₴/);
});

test('міграція: стара база без таблиці платежів переносить існуючі рахунки й не губить замовлення', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qo-')), 'old.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE orders (id INTEGER PRIMARY KEY AUTOINCREMENT, order_number TEXT NOT NULL, client_id TEXT,
    fingerprint TEXT NOT NULL, created_at INTEGER NOT NULL, data TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'new',
    status_by TEXT, status_at INTEGER, first_response_at INTEGER, tg_state TEXT NOT NULL DEFAULT 'pending',
    tg_message_id INTEGER, tg_attempts INTEGER NOT NULL DEFAULT 0, tg_next_at INTEGER, tg_error TEXT,
    crm_state TEXT NOT NULL DEFAULT 'pending', crm_order_id INTEGER, crm_attempts INTEGER NOT NULL DEFAULT 0,
    crm_next_at INTEGER, crm_error TEXT, reminders INTEGER NOT NULL DEFAULT 0, last_reminder_at INTEGER,
    pay_invoice_id TEXT, pay_url TEXT, pay_status TEXT, pay_amount INTEGER, pay_created_at INTEGER, pay_paid_at INTEGER)`);
  old.prepare('INSERT INTO orders (order_number, fingerprint, created_at, data, pay_invoice_id, pay_url, pay_status, pay_amount, pay_created_at, pay_paid_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('old-1', 'f', 1, '{"productTitle":"Старе"}', 'inv-old', 'https://pay/old', 'success', 20000, 2, 3);
  old.close();

  const store = openStore(file);
  assert.equal(store.getOrder(1).data.productTitle, 'Старе');
  const migrated = store.findPaymentByInvoice('inv-old');
  assert.equal(migrated.amount, 20000);
  assert.equal(migrated.status, 'success');
  assert.equal(migrated.crm_synced, 1, 'старі оплати вже були в CRM, повторно не відправляємо');
  assert.equal(store.paidTotal(1), 20000);
  store.close();
  assert.doesNotThrow(() => openStore(file).close(), 'повторне відкриття не дублює записи');
  const again = openStore(file);
  assert.equal(again.paymentsForOrder(1).length, 1);
  again.close();
});
