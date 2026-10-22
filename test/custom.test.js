import test from 'node:test';
import assert from 'node:assert/strict';
import { call, makeApp, signedUrl } from './helpers.js';
import { validateCustomBrief, customItems } from '../server/custom-print.js';

const brief = (over = {}) => ({
  item: 'hoodie',
  quantity: 1,
  color: 'Чорний',
  size: 'L',
  placement: 'back',
  idea: 'Моя BMW M5 F90 у стилі креслення <script>',
  name: 'Іван',
  phone: '067 123 45 67',
  client_id: 'client-id-custom-1',
  page_url: 'https://monoclo.com.ua/pages/svii-prynt',
  utm: { source: 'instagram', medium: 'bio' },
  ...over,
});
const send = (app, body) => call(app, { url: signedUrl('/proxy/custom'), body });

test('заявка «Свій принт»: картка в Telegram з ціною з сервера, без запиту товару в магазин', async () => {
  const { app, fetchFn, store } = makeApp();
  const r = await send(app, brief({ price: 1 }));
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.value, 2450);
  assert.equal(fetchFn.calls.filter((c) => c.url.includes('/products/')).length, 0);

  const [msg] = fetchFn.tg('sendMessage');
  assert.match(msg.body.text, /🎨 Свій принт · заявка #/);
  assert.match(msg.body.text, /Свій принт · Худі/);
  assert.match(msg.body.text, /Розмір: L/);
  assert.match(msg.body.text, /Принт: Спина/);
  assert.match(msg.body.text, /2[\s ]450/);
  assert.match(msg.body.text, /💬 Моя BMW M5 F90/);
  assert.doesNotMatch(msg.body.text, /<script>/);
  assert.match(msg.body.text, /instagram \/ bio/);
  const saved = store.getOrder(1);
  assert.equal(saved.data.kind, 'custom');
  assert.equal(saved.data.variantId, '68257292583133');
});

test('заявка «Свій принт»: постер без розміру й кольору, тираж 10+ позначається як гурт', async () => {
  const { app, fetchFn } = makeApp();
  const r = await send(app, brief({ item: 'a2', quantity: 10, size: 'L', color: 'Чорний' }));
  assert.equal(r.status, 200);
  const text = fetchFn.tg('sendMessage')[0].body.text;
  assert.match(text, /Постер A2/);
  assert.doesNotMatch(text, /Розмір:/);
  assert.match(text, /10\+ шт \(гурт/);
});

test('заявка «Свій принт»: валідація, підпис, honeypot, дубль', async () => {
  const { app, fetchFn } = makeApp();
  assert.equal((await call(app, { url: '/proxy/custom', body: brief() })).status, 401);
  const badItem = await send(app, brief({ item: 'mug' }));
  assert.equal(badItem.status, 422);
  assert.equal(badItem.json.field, 'item');
  assert.equal((await send(app, brief({ idea: '' }))).json.field, 'idea');
  assert.equal((await send(app, brief({ phone: '123' }))).json.field, 'phone');
  const spam = await send(app, brief({ website: 'http://spam' }));
  assert.equal(spam.json.ok, true);
  assert.equal(fetchFn.tg('sendMessage').length, 0);

  const first = await send(app, brief());
  const again = await send(app, brief());
  assert.equal(first.json.order_number, again.json.order_number);
  assert.equal(fetchFn.tg('sendMessage').length, 1);
});

test('заявка «Свій принт» у KeyCRM: назва, ціна, коментар', async () => {
  const { app, fetchFn } = makeApp({ cfg: { keycrmToken: 'k' } });
  await send(app, brief({ item: 'tee' }));
  const created = fetchFn.crm().find((c) => c.url.endsWith('/order'));
  assert.ok(created);
  assert.equal(created.body.products[0].name, 'Свій принт · Футболка');
  assert.equal(created.body.products[0].price, 1450);
  assert.match(created.body.manager_comment, /Заявка «Свій принт»/);
  assert.match(created.body.buyer_comment, /BMW M5/);
});

test('ціни з оточення перекривають таблицю', () => {
  const items = customItems({ tee: 1500, hoodie: 'x' });
  assert.equal(items.tee.priceUah, 1500);
  assert.equal(items.hoodie.priceUah, 2450);
  const r = validateCustomBrief(brief({ item: 'tee' }), { maxQty: 10, items });
  assert.equal(r.ok, true);
  assert.equal(r.value.item.priceUah, 1500);
});

const jpeg = (size = 2000) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(size, 7)]).toString('base64');
const sendPhoto = (app, body) => call(app, { url: signedUrl('/proxy/custom/photo'), body });

test('фото до заявки «Свій принт»: відповіддю на картку, лише свій браузер і лише фото', async () => {
  const { app, fetchFn } = makeApp();
  const r = await send(app, brief({ photos: 2 }));
  const number = r.json.order_number;
  assert.match(fetchFn.tg('sendMessage')[0].body.text, /Фото від клієнта: 2 шт/);

  const ok = await sendPhoto(app, { order_number: number, client_id: 'client-id-custom-1', image: `data:image/jpeg;base64,${jpeg()}`, index: 1, total: 2 });
  assert.equal(ok.status, 200);
  const photo = fetchFn.calls.find((c) => c.url.endsWith('/sendPhoto'));
  assert.ok(photo, 'фото пішло в Telegram');
  assert.equal(photo.body.get('caption'), `📎 Фото до заявки #${number} (1/2)`);
  assert.equal(JSON.parse(photo.body.get('reply_parameters')).message_id, 101);
  assert.equal(photo.body.get('photo').type, 'image/jpeg');

  assert.equal((await sendPhoto(app, { order_number: number, client_id: 'someone-else-01', image: jpeg() })).status, 404);
  assert.equal((await sendPhoto(app, { order_number: number, client_id: 'client-id-custom-1', image: Buffer.from('<svg>').toString('base64') })).status, 415);
  assert.equal((await call(app, { url: '/proxy/custom/photo', body: { order_number: number } })).status, 401);
});

test('фото до звичайного швидкого замовлення не приймаються, і не більше 5 на заявку', async () => {
  const { app } = makeApp();
  const quick = await call(app, { url: signedUrl(), body: { product_handle: 'tee', variant_id: 111, quantity: 1, name: 'Іван', phone: '0671234567', client_id: 'client-id-quick-1' } });
  assert.equal((await sendPhoto(app, { order_number: quick.json.order_number, client_id: 'client-id-quick-1', image: jpeg() })).status, 404);

  const r = await send(app, brief({ client_id: 'client-id-custom-9', phone: '0501112233' }));
  const body = { order_number: r.json.order_number, client_id: 'client-id-custom-9', image: jpeg() };
  for (let i = 0; i < 5; i += 1) assert.equal((await sendPhoto(app, body)).status, 200);
  assert.equal((await sendPhoto(app, body)).status, 429);
});
