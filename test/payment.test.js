import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '../server/store.js';
import { call, goodBody, makeApp, signMono, submit } from './helpers.js';

const payCfg = { monobankToken: 'MONOTOKEN', prepayAmountUah: 200 };
const headers = { 'x-telegram-bot-api-secret-token': 'hook-secret' };

const press = (app, data = 'pay:link', messageId = 101) => call(app, {
  url: '/telegram/webhook',
  headers,
  body: { callback_query: { id: 'cb', data, from: { first_name: 'Оля' }, message: { message_id: messageId, chat: { id: -100500 }, text: 'T', entities: [] } } },
});

const monoHook = (app, payload, { sign = true, tamper = false } = {}) => {
  const raw = JSON.stringify(payload);
  const sig = sign ? signMono(raw) : undefined;
  return call(app, {
    url: '/mono/webhook',
    rawBody: tamper ? raw.replace('success', 'success ') : raw,
    headers: sig ? { 'x-sign': sig } : {},
  });
};

const texts = (fetchFn) => fetchFn.tg('sendMessage').map((c) => c.body.text);
const callbacks = (kb) => kb.inline_keyboard.flat().map((b) => b.callback_data).filter(Boolean);

test('без токена Monobank кнопки передоплати немає', async () => {
  const { app, fetchFn } = makeApp();
  await submit(app);
  assert.ok(!callbacks(fetchFn.tg('sendMessage')[0].body.reply_markup).includes('pay:link'));
  await press(app);
  assert.equal(fetchFn.mono().length, 0);
  assert.equal(fetchFn.tg('answerCallbackQuery').at(-1).body.text, 'Оплата не налаштована');
});

test('кнопка передоплати є в повідомленні й після зміни статусу', async () => {
  const { app, fetchFn } = makeApp({ cfg: payCfg });
  await submit(app);
  const kb = fetchFn.tg('sendMessage')[0].body.reply_markup;
  assert.ok(callbacks(kb).includes('pay:link'));
  assert.ok(kb.inline_keyboard.flat().some((b) => b.text === '💳 Передоплата 200 ₴'));

  await press(app, 'st:taken');
  assert.ok(callbacks(fetchFn.tg('editMessageText')[0].body.reply_markup).includes('pay:link'));
});

test('створення посилання: рахунок на 200 ₴, готовий текст для клієнта, повторне натискання не створює новий', async () => {
  const { app, fetchFn, store } = makeApp({ cfg: payCfg });
  await submit(app);
  await press(app);

  const [invoice] = fetchFn.mono();
  assert.equal(invoice.headers['X-Token'], 'MONOTOKEN');
  assert.equal(invoice.body.amount, 20000);
  assert.equal(invoice.body.ccy, 980);
  assert.equal(invoice.body.merchantPaymInfo.reference, '20251005-150000');
  assert.equal(invoice.body.webHookUrl, 'https://qo.test/mono/webhook');
  assert.equal(invoice.body.validity, 86400);

  const message = fetchFn.tg('sendMessage').at(-1);
  assert.match(message.body.text, /<code>Вітаємо! Щоб підтвердити замовлення №20251005-150000.*200\s₴: https:\/\/pay\.mono\.bank\/inv-1<\/code>/);
  assert.equal(message.body.reply_parameters.message_id, 101);
  assert.equal(store.getOrder(1).pay_status, 'created');
  assert.equal(store.getOrder(1).pay_amount, 20000);

  await press(app);
  assert.equal(fetchFn.mono().length, 1, 'посилання перевикористано');
  assert.match(texts(fetchFn).at(-1), /inv-1/);
});

test('якщо замовлення дешевше за передоплату, береться сума замовлення', async () => {
  const { app, fetchFn } = makeApp({ cfg: { ...payCfg, prepayAmountUah: 5000 } });
  await submit(app);
  await press(app);
  assert.equal(fetchFn.mono()[0].body.amount, 178000);
});

test('збій банку: менеджер бачить помилку, замовлення не страждає', async () => {
  const { app, fetchFn, store } = makeApp({ cfg: payCfg });
  await submit(app);
  fetchFn.fail.monobank = true;
  await press(app);
  assert.match(fetchFn.tg('answerCallbackQuery').at(-1).body.text, /Не вдалося створити посилання/);
  assert.equal(store.getOrder(1).pay_status, null);
});

test('вебхук банку: успішна оплата відмічається один раз і йде в KeyCRM', async () => {
  const { app, fetchFn, store } = makeApp({
    cfg: { ...payCfg, keycrmToken: 'CRMTOKEN', keycrmPaymentMethodId: 9 },
  });
  await submit(app);
  await press(app);

  const payload = { invoiceId: 'inv-1', status: 'success', amount: 20000, finalAmount: 20000 };
  assert.equal((await monoHook(app, payload)).status, 200);
  assert.equal(store.getOrder(1).pay_status, 'success');
  assert.ok(store.getOrder(1).pay_paid_at);
  assert.match(texts(fetchFn).at(-1), /Передоплата 200\s₴ отримана за замовленням #20251005-150000/);

  const payment = fetchFn.crm().find((c) => c.url.endsWith('/order/777/payment'));
  assert.deepEqual(payment.body, {
    payment_method_id: 9, amount: 200, status: 'paid', description: 'Передоплата Monobank, рахунок inv-1',
  });

  // Повторний вебхук та запізніле «processing»: без дублів
  const before = fetchFn.calls.length;
  await monoHook(app, payload);
  await monoHook(app, { ...payload, status: 'processing' });
  assert.equal(fetchFn.calls.length, before);
  assert.equal(store.getOrder(1).pay_status, 'success');

  // Кнопка після оплати нового рахунку не створює
  await press(app);
  assert.equal(fetchFn.mono().length, 1);
  assert.equal(fetchFn.tg('answerCallbackQuery').at(-1).body.text, 'Передоплата вже отримана');
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
  assert.equal(store.getOrder(1).pay_status, 'created');
});

test('невдала оплата: попередження менеджеру й можна створити нове посилання', async () => {
  const { app, fetchFn, store } = makeApp({ cfg: payCfg });
  await submit(app);
  await press(app);
  await monoHook(app, { invoiceId: 'inv-1', status: 'failure', failureReason: 'Недостатньо коштів', amount: 20000 });
  assert.equal(store.getOrder(1).pay_status, 'failure');
  assert.match(texts(fetchFn).at(-1), /Передоплата за замовленням #20251005-150000 не пройшла \(Недостатньо коштів\)/);

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
  assert.ok(fetchFn.crm().some((c) => c.url.endsWith('/order/777/payment')));
});

test('у звіті зʼявляється кількість отриманих передоплат', async () => {
  const { app, fetchFn, now } = makeApp({ cfg: payCfg, at: '2025-10-01T09:00:00Z' });
  await submit(app);
  await press(app);
  await monoHook(app, { invoiceId: 'inv-1', status: 'success', amount: 20000 });
  now.set('2025-10-06T06:30:00Z');
  await app.tick();
  const report = fetchFn.tg('sendMessage').find((c) => /Звіт за тиждень/.test(c.body.text));
  assert.match(report.body.text, /Передоплат отримано: 1 на 200\s₴/);
});

test('міграція: стара база без колонок оплати відкривається без втрати замовлень', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qo-')), 'old.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE orders (id INTEGER PRIMARY KEY AUTOINCREMENT, order_number TEXT NOT NULL, client_id TEXT,
    fingerprint TEXT NOT NULL, created_at INTEGER NOT NULL, data TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'new',
    status_by TEXT, status_at INTEGER, first_response_at INTEGER, tg_state TEXT NOT NULL DEFAULT 'pending',
    tg_message_id INTEGER, tg_attempts INTEGER NOT NULL DEFAULT 0, tg_next_at INTEGER, tg_error TEXT,
    crm_state TEXT NOT NULL DEFAULT 'pending', crm_order_id INTEGER, crm_attempts INTEGER NOT NULL DEFAULT 0,
    crm_next_at INTEGER, crm_error TEXT, reminders INTEGER NOT NULL DEFAULT 0, last_reminder_at INTEGER)`);
  old.prepare('INSERT INTO orders (order_number, fingerprint, created_at, data) VALUES (?, ?, ?, ?)')
    .run('old-1', 'f', 1, '{"productTitle":"Старе"}');
  old.close();

  const store = openStore(file);
  assert.equal(store.getOrder(1).data.productTitle, 'Старе');
  store.setPayment(1, { invoiceId: 'i', url: 'u', status: 'created', amount: 100, createdAt: 5 });
  assert.equal(store.findByInvoiceId('i').pay_status, 'created');
  store.close();
  assert.doesNotThrow(() => openStore(file).close(), 'повторне відкриття не ламається');
});

test('goodBody доступний (захист від зміни хелперів)', () => {
  assert.equal(goodBody().quantity, 2);
});
