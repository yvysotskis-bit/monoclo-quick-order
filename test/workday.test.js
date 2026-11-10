import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOrderMessage, buildShippedText, buildTtnMessage } from '../server/message.js';
import { buildAbReport, buildDailyDigest, buildFunnelReport } from '../server/report.js';
import { buildDigestWidget } from '../server/widget.js';
import { NP, call, goodBody, makeApp, signMono, signedUrl, submit } from './helpers.js';

const headers = { 'x-telegram-bot-api-secret-token': 'hook-secret' };
const say = (app, text) => call(app, {
  url: '/telegram/webhook', headers,
  body: { message: { message_id: 7, chat: { id: -100500 }, from: { id: 55, first_name: 'Оля' }, text } },
});
const texts = (fetchFn) => fetchFn.tg('sendMessage').map((c) => c.body.text);
const card = { orderNumber: '1', when: 'now', productTitle: 'Худі', options: [{ name: 'Розмір', value: 'L' }], quantity: 1, totalCents: 189900, currency: 'UAH', name: 'А', phone: '+380661234567' };

test('привітання: нічне замовлення і постійний клієнт мають свої слова', () => {
  assert.doesNotMatch(buildOrderMessage(card), /Раді бачити|поза робочим часом\./);
  assert.match(buildOrderMessage({ ...card, afterHours: true }), /<code>[^<]*надійшло поза робочим часом/);
  const repeat = buildOrderMessage({ ...card, repeat: { count: 2, lastSize: 'M' } });
  assert.match(repeat, /🔁 Постійний клієнт: замовлення №3 · минулого разу розмір M/);
  assert.match(repeat, /<code>[^<]*Раді бачити вас знову/);
});

test('друге замовлення з того самого номера позначається в картці; спам не рахується', async () => {
  const { app, fetchFn, store, now } = makeApp();
  await submit(app, goodBody());
  now.advance(11 * 60_000);
  await submit(app, goodBody({ client_id: 'c-2' }));
  const cards = texts(fetchFn).filter((t) => /Швидке замовлення/.test(t));
  assert.equal(cards.length, 2);
  assert.doesNotMatch(cards[0], /Постійний клієнт/);
  assert.match(cards[1], /Постійний клієнт: замовлення №2/);
  store.setStatus(1, 'spam', 'x', 1);
  store.setStatus(2, 'spam', 'x', 1);
  assert.equal(store.customerHistory(store.getOrder(2).data.phone, 99).length, 0);
});

test('після створення ТТН є готовий текст клієнту з номером і сумою до сплати', () => {
  const text = buildTtnMessage({ orderNumber: '1', number: '20450000000001', codUah: 1699, costUah: 1899, tracked: true });
  assert.match(text, /<code>[^<]*20450000000001[^<]*До сплати при отриманні: 1\s?699/);
  assert.doesNotMatch(buildShippedText({ number: '1', codUah: 0 }), /До сплати/);
  // ТТН без післяплати з неоплаченим залишком: суму в тексті клієнту не називаємо
  assert.doesNotMatch(buildTtnMessage({ orderNumber: '1', number: '2', codUah: 500, costUah: 1899, tracked: true, unpaidUah: 500 }).split('<code>')[2], /До сплати/);
});

test('посилку отримано: одне повідомлення з проханням про відгук', async () => {
  const cfg = { monobankToken: 'M', novaPoshtaApiKey: 'npkey', keycrmToken: 'crm', publicUrl: 'https://qo.test' };
  const city = { ref: NP.city, name: 'Чернівці', present: 'м. Чернівці', area: 'Чернівецька' };
  const { app, fetchFn, now, store } = makeApp({ cfg });
  await submit(app, goodBody({ surname: 'Петренко', delivery: { method: 'warehouse', city, point: { ref: NP.branch, number: '3', name: 'Відділення №3' } } }));
  const press = (data) => call(app, { url: '/telegram/webhook', headers, body: { callback_query: { id: 'cb', data, from: { id: 55, first_name: 'Оля' }, message: { message_id: 101, chat: { id: -100500 }, text: 'T', entities: [] } } } });
  await press('pay:full');
  const raw = JSON.stringify({ invoiceId: 'inv-1', status: 'success', amount: 178000 });
  await call(app, { url: '/mono/webhook', rawBody: raw, headers: { 'x-sign': signMono(raw) } });
  await press('ttn:1');
  const ttn = store.getOrder(1).ttn_number;
  const asks = () => texts(fetchFn).filter((t) => /Прохання про відгук/.test(t));
  now.advance(31 * 60_000);
  fetchFn.npTrack[ttn] = { StatusCode: '7' };
  await app.tick();
  assert.equal(asks().length, 0);
  now.advance(31 * 60_000);
  fetchFn.npTrack[ttn] = { StatusCode: '9' };
  await app.tick();
  now.advance(31 * 60_000);
  await app.tick();
  assert.equal(asks().length, 1);
  assert.match(asks()[0], /отримано \(Олена Петренко\)|отримано/);
});

test('ранкове зведення: раз на день у своєму вікні, не ввечері', async () => {
  // 05.10.2025 12:00Z = 15:00 Київ: вікно 9-13 уже минуло
  const { app, fetchFn, now } = makeApp({ at: '2025-10-05T12:00:00Z' });
  await submit(app, goodBody());
  await app.tick();
  const digests = () => texts(fetchFn).filter((t) => /Зведення на/.test(t));
  assert.equal(digests().length, 0);
  now.advance(19 * 3600e3); // 10:00 наступного дня
  await app.tick();
  await app.tick();
  assert.equal(digests().length, 1);
  assert.match(digests()[0], /За останню добу: <b>1<\/b> замовлення/);
  assert.match(digests()[0], /Без відповіді: <b>1<\/b>/);
  now.advance(24 * 3600e3);
  await app.tick();
  assert.equal(digests().length, 2);
});

test('зведення вимикається DIGEST_ENABLED=false; порожній день', async () => {
  const { app, fetchFn } = makeApp({ at: '2025-10-06T07:00:00Z', cfg: { digestEnabled: false } });
  await app.tick();
  assert.equal(texts(fetchFn).filter((t) => /Зведення на/.test(t)).length, 0);
  assert.match(buildDailyDigest({ orders: [], counts: { unanswered: 0, awaitingPayment: 0, paidNoTtn: 0, atBranch: 0, storageSoon: 0 }, dayLabel: '06.10' }), /Усе опрацьовано/);
});

test('команди менеджера: /digest, /ab, /funnel; чужий чат і звичайний текст ігноруються', async () => {
  const { app, fetchFn } = makeApp();
  await say(app, '/digest');
  await say(app, '/ab@quick_orderino_bot');
  await say(app, '/funnel 30');
  const out = texts(fetchFn);
  assert.equal(out.length, 3);
  assert.match(out[0], /Зведення на/);
  assert.match(out[1], /Текст кнопки/);
  assert.match(out[2], /Воронка форми за 30 днів/);
  await say(app, 'просто текст');
  await call(app, { url: '/telegram/webhook', headers, body: { message: { message_id: 8, chat: { id: 999 }, from: { id: 1 }, text: '/digest' } } });
  assert.equal(texts(fetchFn).length, 3);
});

test('воронка: /proxy/event рахує лише відомі події, потрібен підпис проксі', async () => {
  const { app, store } = makeApp();
  const hit = (event, url = signedUrl('/proxy/event')) => call(app, { url, body: { event } });
  for (const e of ['open', 'open', 'step2', 'close_contacts', 'hack<script>', '']) assert.equal((await hit(e)).status, 200);
  const rows = Object.fromEntries(store.funnelSince('2000-01-01').map((r) => [r.event, r.n]));
  assert.deepEqual(rows, { open: 2, step2: 1, close_contacts: 1 });
  assert.equal((await hit('open', '/proxy/event?shop=x')).status >= 400, true);
  const report = buildFunnelReport(store.funnelSince('2000-01-01'), 7);
  assert.match(report, /Відкрили форму: <b>2<\/b> \(100%\)/);
  assert.match(report, /не заповнили імʼя чи телефон: 1 \(50%\)/);
  assert.match(buildFunnelReport([], 7), /Даних ще немає/);
});

test('звіт A/B показує варіанти з назвами', () => {
  const text = buildAbReport([{ id: 'cta', title: 'Кнопка', labels: { A: 'Замовити', B: 'Підтвердити' }, winner: 'B', variants: { A: { views: 10, conversions: 1, rate: 10 }, B: { views: 10, conversions: 3, rate: 30 } } }]);
  assert.match(text, /переможець: «Підтвердити»/);
  assert.match(text, /Замовити: 10% \(1 із 10\)/);
});

test('пробний віджет: у межах лімітів Telegram; /widget при відмові пояснює текстом', async () => {
  const zlib = await import('node:zlib');
  const html = buildDigestWidget('☀️ <b>Зведення на 06.10</b>\n\nЗа останню добу: <b>3</b> замовлення на 5 697 ₴ &amp; "лапки"');
  assert.ok(Buffer.byteLength(html) < 32768 && zlib.deflateSync(html, { level: 9 }).length < 4096);
  assert.match(html, /data-text="[^"]*&quot;лапки&quot;"/);
  const { app, fetchFn } = makeApp();
  await say(app, '/widget');
  assert.equal(fetchFn.tg('sendWidget').length, 1);
});
