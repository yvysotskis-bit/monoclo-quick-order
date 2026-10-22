import test from 'node:test';
import assert from 'node:assert/strict';
import { call, makeApp, signedUrl } from './helpers.js';
import { extractCertificates, normalizeCode, findCode, generateCode } from '../server/certificates.js';

const crmOrder = (over = {}) => ({
  id: 5001,
  source_id: 3,
  source_uuid: 'M-CL6500',
  created_at: '2025-10-05 11:30:00',
  grand_total: 2600,
  buyer: { full_name: 'Олена Коваль', phone: '+380671112233' },
  payments: [{ status: 'paid', amount: 200 }],
  products: [
    { name: 'Подарунковий сертифікат «Свій принт»', price: 2600, quantity: 1, properties: [{ name: 'Виріб', value: 'Худі' }, { name: 'Формат', value: 'Друкований (+150 ₴)' }] },
    { name: 'Худі MONOCLO Ferrari', price: 2200, quantity: 1, properties: [{ name: 'Розмір', value: 'L' }] },
  ],
  ...over,
});

const setup = (list) => {
  const ctx = makeApp({ cfg: { keycrmToken: 'k', certEnabled: true } });
  ctx.fetchFn.crmState.list = list;
  return ctx;
};

const tgUpdate = (body, id) => ({ url: '/telegram/webhook', headers: { 'x-telegram-bot-api-secret-token': 'hook-secret' }, body: { update_id: id, ...body } });

test('сертифікат: виріб і формат з варіанта, сума виробу без доплати за друк, кількість', () => {
  const [hoodie] = extractCertificates(crmOrder());
  assert.deepEqual({ ...hoodie }, { lineKey: '0:1', itemKey: 'hoodie', itemLabel: 'Худі', amountUah: 2450, printed: true });
  const kids = extractCertificates(crmOrder({ products: [{ name: 'Подарунковий сертифікат «Свій принт» - Футболка дитяча / Електронний', price: 950, quantity: 2 }] }));
  assert.equal(kids.length, 2);
  assert.equal(kids[0].itemKey, 'kids');
  assert.equal(kids[0].printed, false);
  assert.equal(kids[1].lineKey, '0:2');
  // Невідомий виріб: сума з ціни рядка мінус 150 ₴ за друк
  const unknown = extractCertificates(crmOrder({ products: [{ name: 'Подарунковий сертифікат', price: 1150, quantity: 1, properties: [{ name: 'Формат', value: 'Друкований' }] }] }));
  assert.equal(unknown[0].amountUah, 1000);
  assert.equal(extractCertificates(crmOrder({ products: [{ name: 'Худі', price: 2000 }] })).length, 0);
});

test('код: генерація, нормалізація, пошук у тексті', () => {
  assert.match(generateCode(), /^SP-[A-HJ-NP-Z2-9]{6}$/);
  assert.equal(normalizeCode(' sp 7k3f2q '), 'SP-7K3F2Q');
  assert.equal(normalizeCode('SP-7K3F'), '');
  assert.equal(findCode('клієнт каже код sp-7k3f2q, перевір'), 'SP-7K3F2Q');
});

test('сертифікат: код видається один раз на рядок і картка йде в групу', async () => {
  const { app, fetchFn, store, now } = setup([crmOrder()]);
  await app.tick();
  const cards = fetchFn.sentMessages.filter((m) => m.text.includes('Подарунковий сертифікат ·'));
  assert.equal(cards.length, 1);
  const code = /SP-[A-Z0-9]{6}/.exec(cards[0].text)[0];
  assert.match(cards[0].text, /Худі<\/b> · 2[\s ]450/);
  assert.match(cards[0].text, /друкований/);
  assert.match(cards[0].text, new RegExp(`svii-prynt\\?cert=${code}#brif`));
  assert.equal(cards[0].reply_markup.inline_keyboard[0][0].callback_data, `cert:use:${code}`);
  const cert = store.getCertificate(code);
  assert.equal(cert.amount_uah, 2450);
  assert.equal(cert.crm_order_id, 5001);

  // Наступні перегляди не створюють нових кодів
  now.advance(11 * 60_000);
  await app.tick();
  assert.equal(fetchFn.sentMessages.filter((m) => m.text.includes('Подарунковий сертифікат ·')).length, 1);
  assert.ok(fetchFn.crmLists.length >= 2);
  assert.ok(!('filter[source_id]' in fetchFn.crmLists[0]), 'без CERT_SOURCE_IDS дивимось усі джерела');
});

test('сертифікат: старі замовлення (до запуску функції) не отримують кодів', async () => {
  const { app, fetchFn } = setup([crmOrder({ created_at: '2025-10-01 09:00:00' })]);
  await app.tick();
  assert.equal(fetchFn.sentMessages.filter((m) => m.text.includes('Подарунковий сертифікат ·')).length, 0);
});

test('сертифікат: погашення кнопкою, повтор не погашає вдруге, скасування', async () => {
  const { app, fetchFn, store } = setup([crmOrder()]);
  await app.tick();
  const card = fetchFn.sentMessages.find((m) => m.text.includes('Подарунковий сертифікат ·'));
  const code = /SP-[A-Z0-9]{6}/.exec(card.text)[0];
  const messageId = store.getCertificate(code).tg_message_id;
  const press = (data, id) => call(app, tgUpdate({ callback_query: { id: `q${id}`, data, from: { first_name: 'Аня' }, message: { message_id: messageId, chat: { id: -100500 } } } }, id));

  await press(`cert:use:${code}`, 1);
  assert.equal(store.getCertificate(code).status, 'used');
  assert.equal(store.getCertificate(code).used_by, 'Аня');
  const edit = fetchFn.tg('editMessageText').at(-1).body;
  assert.match(edit.text, /Погашено<\/b>: Аня/);
  assert.equal(edit.reply_markup.inline_keyboard[0][0].callback_data, `cert:undo:${code}`);

  await press(`cert:use:${code}`, 2);
  assert.match(fetchFn.tg('answerCallbackQuery').at(-1).body.text, /Вже погашено/);

  await press(`cert:undo:${code}`, 3);
  assert.equal(store.getCertificate(code).status, 'issued');
});

test('сертифікат: менеджер пише код у групі - бот відповідає станом і кнопкою', async () => {
  const { app, fetchFn } = setup([crmOrder()]);
  await app.tick();
  const code = /SP-[A-Z0-9]{6}/.exec(fetchFn.sentMessages.find((m) => m.text.includes('Подарунковий сертифікат ·')).text)[0];
  await call(app, tgUpdate({ message: { message_id: 900, chat: { id: -100500 }, from: { first_name: 'Аня' }, text: `хто перевірить ${code.toLowerCase()}?` } }, 10));
  const reply = fetchFn.sentMessages.at(-1);
  assert.match(reply.text, /Худі · 2[\s ]450.*дійсний/);
  assert.equal(reply.reply_parameters.message_id, 900);

  await call(app, tgUpdate({ message: { message_id: 901, chat: { id: -100500 }, from: { first_name: 'Аня' }, text: 'SP-AAAAAA' } }, 11));
  assert.match(fetchFn.sentMessages.at(-1).text, /не знайдено/);
});

test('бриф «Свій принт» з кодом сертифіката: стан у картці й кнопка погашення під нею', async () => {
  const { app, fetchFn } = setup([crmOrder()]);
  await app.tick();
  const code = /SP-[A-Z0-9]{6}/.exec(fetchFn.sentMessages.find((m) => m.text.includes('Подарунковий сертифікат ·')).text)[0];
  const brief = {
    item: 'hoodie', quantity: 1, color: 'Чорний', size: 'L', placement: 'back', idea: 'Моя BMW', name: 'Іван',
    phone: '067 123 45 67', client_id: 'client-id-cert-1', certificate: code.replace('-', ' ').toLowerCase(),
  };
  const r = await call(app, { url: signedUrl('/proxy/custom'), body: brief });
  assert.equal(r.status, 200);
  const card = fetchFn.sentMessages.find((m) => m.text.includes('🎨 Свій принт'));
  assert.match(card.text, new RegExp(`${code}: Худі · 2\\s450\\s₴ · ✅ дійсний`));
  assert.match(card.text, /Оплачено сертифікатом/);
  const reply = fetchFn.sentMessages.at(-1);
  assert.equal(reply.reply_markup.inline_keyboard[0][0].callback_data, `cert:use:${code}`);

  const bad = await call(app, { url: signedUrl('/proxy/custom'), body: { ...brief, client_id: 'client-id-cert-2', phone: '067 000 11 22', certificate: 'abc' } });
  assert.equal(bad.status, 422);
  assert.equal(bad.json.field, 'certificate');
});

test('менеджер змінив склад замовлення в KeyCRM: сертифікат не отримує другий код', async () => {
  const cert = { id: 777, name: 'Подарунковий сертифікат «Свій принт»', price: 2600, quantity: 1, properties: [{ name: 'Виріб', value: 'Худі' }] };
  const first = crmOrder({ products: [cert, { id: 778, name: 'Худі MONOCLO Ferrari', price: 2200, quantity: 1 }] });
  const { app, fetchFn, store, now } = setup([first]);
  await app.tick();
  assert.equal(fetchFn.sentMessages.filter((m) => m.text.includes('Подарунковий сертифікат ·')).length, 1);

  // Менеджер додав товар на початок і прибрав інший: сертифікат тепер на іншій позиції списку
  fetchFn.crmState.list = [crmOrder({ products: [{ id: 900, name: 'Стікерпак', price: 100, quantity: 1 }, cert] })];
  now.advance(11 * 60_000);
  await app.tick();
  assert.equal(fetchFn.sentMessages.filter((m) => m.text.includes('Подарунковий сертифікат ·')).length, 1, 'нового коду немає');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM certificates').get().n, 1);
});

test('сертифікат, виданий до переходу на id позиції (ключ за номером), не дублюється', async () => {
  const cert = { id: 777, name: 'Подарунковий сертифікат «Свій принт»', price: 2600, quantity: 1 };
  const { app, fetchFn, store } = setup([crmOrder({ products: [cert] })]);
  store.insertCertificate({ code: 'SP-AAAAAA', crmOrderId: 5001, lineKey: '0:1', itemLabel: 'Худі', amountUah: 2450, createdAt: 1 });
  await app.tick();
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM certificates').get().n, 1);
  assert.equal(fetchFn.sentMessages.filter((m) => /Подарунковий сертифікат ·/.test(m.text) && !m.text.includes('SP-AAAAAA')).length, 0);
});

test('невідомий код у довгому повідомленні (на кшталт слова SPRINTER) не викликає відповіді бота', async () => {
  const { app, fetchFn } = setup([]);
  const say = (text, id) => call(app, tgUpdate({ message: { message_id: id, text, chat: { id: -100500 }, from: { id: 5, first_name: 'Оля' } } }, id));
  const before = fetchFn.sentMessages.length;
  await say('Клієнт замовив SPRINTER у синьому кольорі, надішліть йому завтра', 9101);
  assert.equal(fetchFn.sentMessages.length, before, 'довге повідомлення зі словом ігнорується');
  await say('SP-ABCDEF', 9102);
  assert.match(fetchFn.sentMessages.at(-1).text, /не знайдено/);
});

test('одночасне погашення сертифіката двома менеджерами: спрацьовує один', async () => {
  const { app, fetchFn, store } = setup([crmOrder()]);
  await app.tick();
  const code = /SP-[A-Z0-9]{6}/.exec(fetchFn.sentMessages.find((m) => m.text.includes('Подарунковий сертифікат ·')).text)[0];
  const press = (from, id) => call(app, tgUpdate({ callback_query: { id: `cb${id}`, data: `cert:use:${code}`, from, message: { message_id: 55, chat: { id: -100500 }, text: 'T' } } }, id));
  await Promise.all([press({ id: 1, first_name: 'Оля' }, 8001), press({ id: 2, first_name: 'Іван' }, 8002), press({ id: 3, first_name: 'Марія' }, 8003)]);
  const answers = fetchFn.tg('answerCallbackQuery').map((c) => c.body.text);
  assert.equal(answers.filter((t) => /^Погашено/.test(t)).length, 1, answers.join(' | '));
  assert.equal(answers.filter((t) => /Вже погашено/.test(t)).length, 2);
  assert.equal(store.getCertificate(code).status, 'used');
});
