import test from 'node:test';
import assert from 'node:assert/strict';
import { call, goodBody, makeApp, submit } from './helpers.js';

const reminders = (fetchFn) => fetchFn.tg('sendMessage').filter((c) => /без відповіді менеджера/.test(c.body.text));

test('нагадування: через 15 хв без відповіді, повтор кожні 30 хв, максимум 3', async () => {
  const { app, fetchFn, now } = makeApp({ at: '2025-10-06T08:00:00Z' }); // 11:00 Київ
  await submit(app);

  now.advance(10 * 60_000);
  await app.tick();
  assert.equal(reminders(fetchFn).length, 0);

  now.advance(5 * 60_000); // 15 хв
  await app.tick();
  assert.equal(reminders(fetchFn).length, 1);
  assert.equal(reminders(fetchFn)[0].body.reply_parameters.message_id, 101);

  await app.tick(); // одразу вдруге: повтору ще немає
  assert.equal(reminders(fetchFn).length, 1);

  now.advance(30 * 60_000);
  await app.tick();
  now.advance(30 * 60_000);
  await app.tick();
  now.advance(30 * 60_000);
  await app.tick();
  assert.equal(reminders(fetchFn).length, 3);
});

test('нагадування не приходять, якщо замовлення взято в роботу', async () => {
  const { app, fetchFn, now, store } = makeApp({ at: '2025-10-06T08:00:00Z' });
  await submit(app);
  store.setStatus(1, 'taken', 'Оля', now().getTime());
  now.advance(60 * 60_000);
  await app.tick();
  assert.equal(reminders(fetchFn).length, 0);
});

test('нічне замовлення: відлік нагадування від початку робочого дня', async () => {
  const { app, fetchFn, now } = makeApp({ at: '2025-10-05T21:00:00Z' }); // 00:00 Київ
  await submit(app);

  now.set('2025-10-06T06:00:00Z'); // 09:00 Київ: ще нічого
  await app.tick();
  assert.equal(reminders(fetchFn).length, 0);

  now.set('2025-10-06T07:10:00Z'); // 10:10 Київ: ще не минуло 15 хв від 10:00
  await app.tick();
  assert.equal(reminders(fetchFn).length, 0);

  now.set('2025-10-06T07:20:00Z'); // 10:20: пора
  await app.tick();
  assert.equal(reminders(fetchFn).length, 1);
});

test('нагадування не відправляються поза робочим часом', async () => {
  const { app, fetchFn, now } = makeApp({ at: '2025-10-06T16:30:00Z' }); // 19:30 Київ
  await submit(app);
  now.set('2025-10-06T18:00:00Z'); // 21:00 Київ
  await app.tick();
  assert.equal(reminders(fetchFn).length, 0);
});

test('тижневий звіт: приходить у понеділок після 9:00 один раз', async () => {
  const { app, fetchFn, now, store } = makeApp({ at: '2025-10-01T09:00:00Z' }); // середа
  await submit(app);
  store.setStatus(1, 'confirmed', 'Оля', now().getTime() + 12 * 60_000);

  const reports = () => fetchFn.tg('sendMessage').filter((c) => /Звіт за тиждень/.test(c.body.text));

  now.set('2025-10-05T20:00:00Z'); // неділя ввечері
  await app.tick();
  assert.equal(reports().length, 0);

  now.set('2025-10-06T05:30:00Z'); // понеділок 08:30 Київ
  await app.tick();
  assert.equal(reports().length, 0);

  now.set('2025-10-06T06:30:00Z'); // 09:30 Київ
  await app.tick();
  await app.tick();
  assert.equal(reports().length, 1);
  const text = reports()[0].body.text;
  assert.match(text, /Замовлень: <b>1<\/b>/);
  assert.match(text, /👍 Підтверджено: 1/);
  assert.match(text, /Середній час до першої відповіді/);
  assert.match(text, /Футболка &lt;Volvo&gt; FH16: 2 шт\./);
});

test('база переживає перезапуск: дублі та ліміти беруться з неї', async () => {
  const { app, store, fetchFn } = makeApp();
  await submit(app);
  // «Новий» екземпляр додатка з тією самою базою
  const { createApp } = await import('../server/app.js');
  const { config, silentLog } = await import('./helpers.js');
  const second = createApp({ config, store, fetchFn, log: silentLog, now: () => new Date('2025-10-05T12:00:30Z') });
  const again = await call(second, { url: (await import('./helpers.js')).signedUrl(), body: (await import('./helpers.js')).goodBody() });
  assert.equal(again.json.order_number, '20251005-150000');
  assert.equal(fetchFn.tg('sendMessage').length, 1);
});

test('нагадування лише про замовлення, створені після REMINDERS_FROM', async () => {
  const from = new Date('2025-10-06T08:30:00Z').getTime(); // 11:30 Київ
  const { app, fetchFn, now } = makeApp({ at: '2025-10-06T08:00:00Z', cfg: { remindersFrom: from } });

  await submit(app); // старе замовлення (11:00)
  now.set('2025-10-06T08:40:00Z');
  await submit(app, goodBody({ quantity: 3, client_id: 'client-id-0002' })); // нове (11:40)

  now.set('2025-10-06T08:50:00Z'); // старому минуло 50 хв, новому 10
  await app.tick();
  assert.equal(reminders(fetchFn).length, 0);

  now.set('2025-10-06T08:56:00Z'); // новому 16 хв
  await app.tick();
  const sent = reminders(fetchFn);
  assert.equal(sent.length, 1);
  assert.match(sent[0].body.text, /#20251006-114000/);
  assert.doesNotMatch(sent[0].body.text, /#20251006-110000/);
});

test('REMINDERS_FROM у конфігурації: ISO-дата, помилка при сміттєвому значенні', async () => {
  const { loadConfig } = await import('../server/config.js');
  const base = {
    SHOPIFY_SHOP: 's.myshopify.com', SHOPIFY_API_SECRET: 'x', TELEGRAM_BOT_TOKEN: 't',
    TELEGRAM_CHAT_ID: '-1', TELEGRAM_WEBHOOK_SECRET: 'w',
  };
  assert.equal(loadConfig(base).remindersFrom, 0);
  assert.equal(loadConfig({ ...base, REMINDERS_FROM: '2026-10-06T07:00:00Z' }).remindersFrom, Date.parse('2026-10-06T07:00:00Z'));
  assert.throws(() => loadConfig({ ...base, REMINDERS_FROM: 'вчора' }), /REMINDERS_FROM/);
});
