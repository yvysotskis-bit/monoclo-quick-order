import test from 'node:test';
import assert from 'node:assert/strict';
import { NP, call, goodBody, makeApp, signMono, submit } from './helpers.js';
import { recipientNames } from '../server/ttn.js';

const cfg = { monobankToken: 'M', novaPoshtaApiKey: 'npkey', keycrmToken: 'crm', publicUrl: 'https://qo.test' };
const headers = { 'x-telegram-bot-api-secret-token': 'hook-secret' };
const city = { ref: NP.city, name: 'Чернівці', present: 'м. Чернівці', area: 'Чернівецька' };
const warehouse = { method: 'warehouse', city, point: { ref: NP.branch, number: '3', name: 'Відділення №3' } };

const press = (app, data, messageId = 101) => call(app, {
  url: '/telegram/webhook',
  headers,
  body: { callback_query: { id: 'cb', data, from: { id: 55, first_name: 'Оля' }, message: { message_id: messageId, chat: { id: -100500 }, text: 'T', entities: [] } } },
});
const pay = (app, invoiceId, amount) => {
  const raw = JSON.stringify({ invoiceId, status: 'success', amount });
  return call(app, { url: '/mono/webhook', rawBody: raw, headers: { 'x-sign': signMono(raw) } });
};
const docCalls = (fetchFn) => fetchFn.calls.filter((c) => c.url.includes('novaposhta') && c.body.modelName === 'InternetDocument');

async function paidOrder(body, amountKop = 20000, button = 'pay:link') {
  const ctx = makeApp({ cfg });
  await submit(ctx.app, goodBody(body));
  await press(ctx.app, button);
  await pay(ctx.app, 'inv-1', amountKop);
  return ctx;
}

test('розбір прізвища: окреме поле або «Імʼя Прізвище»', () => {
  assert.deepEqual(recipientNames({ name: 'Іван', surname: 'Петренко' }), { first: 'Іван', last: 'Петренко' });
  assert.deepEqual(recipientNames({ name: 'Іван Петренко', surname: '' }), { first: 'Іван', last: 'Петренко' });
  assert.equal(recipientNames({ name: 'Іван', surname: '' }), null);
});

test('після оплати зʼявляється кнопка ТТН, ТТН створюється з післяплатою і пишеться в KeyCRM', async () => {
  const { app, fetchFn, store } = await paidOrder({ surname: 'Петренко', delivery: warehouse });
  const paidMsg = fetchFn.tg('sendMessage').at(-1);
  assert.match(paidMsg.body.text, /отримана/);
  assert.equal(paidMsg.body.reply_markup.inline_keyboard[0][0].callback_data, 'ttn:1');

  await press(app, 'ttn:1', paidMsg.body.reply_parameters.message_id);
  const [doc] = docCalls(fetchFn);
  const p = doc.body.methodProperties;
  assert.equal(p.PayerType, 'Recipient');
  assert.equal(p.ServiceType, 'WarehouseWarehouse');
  assert.equal(p.Cost, '1780');
  assert.deepEqual(p.BackwardDeliveryData, [{ PayerType: 'Recipient', CargoType: 'Money', RedeliveryString: '1580' }]);
  assert.equal(p.SenderAddress, 'sender-wh');
  assert.equal(p.RecipientAddress, NP.branch);
  assert.equal(p.CityRecipient, 'city-ref');
  assert.equal(p.OptionsSeat[0].weight, '1');
  assert.equal(p.Description, 'Monoclo');
  assert.match(p.AdditionalInformation, /- 2шт$/);

  assert.equal(store.getOrder(1).ttn_number, '20451234567890');
  assert.ok(fetchFn.crm().some((c) => c.method === 'PUT' && c.body.shipping?.tracking_code === '20451234567890'));
  assert.match(fetchFn.tg('sendMessage').at(-1).body.text, /20451234567890/);

  await press(app, 'ttn:1');
  assert.equal(docCalls(fetchFn).length, 1, 'другий клік не створює дубль');
  assert.match(fetchFn.tg('answerCallbackQuery').at(-1).body.text, /уже створено/);
});

test('повна оплата: післяплати немає', async () => {
  const { app, fetchFn } = await paidOrder({ surname: 'Петренко', delivery: warehouse }, 178000, 'pay:full');
  await press(app, 'ttn:1');
  assert.equal(docCalls(fetchFn)[0].body.methodProperties.BackwardDeliveryData, undefined);
});

test('адресна доставка: створюється адреса одержувача', async () => {
  const delivery = { method: 'courier', city, street: { ref: NP.street, name: 'вул. Головна' }, house: '5', apartment: '7' };
  const { app, fetchFn } = await paidOrder({ surname: 'Петренко', delivery });
  await press(app, 'ttn:1');
  const p = docCalls(fetchFn)[0].body.methodProperties;
  assert.equal(p.ServiceType, 'WarehouseDoors');
  assert.equal(p.RecipientAddress, 'address-ref');
});

test('без прізвища ТТН не створюється: менеджер бачить причину і може повторити', async () => {
  const { app, fetchFn, store } = await paidOrder({ delivery: warehouse });
  await press(app, 'ttn:1');
  assert.equal(docCalls(fetchFn).length, 0);
  assert.match(fetchFn.tg('sendMessage').at(-1).body.text, /немає прізвища/);
  assert.equal(store.getOrder(1).ttn_number, null);
});

test('помилка Нової пошти повертається менеджеру, ТТН не фіксується', async () => {
  const { app, fetchFn, store } = await paidOrder({ surname: 'Петренко', delivery: warehouse });
  fetchFn.fail.npTtn = true;
  await press(app, 'ttn:1');
  assert.match(fetchFn.tg('sendMessage').at(-1).body.text, /Recipient invalid/);
  assert.equal(store.getOrder(1).ttn_number, null);
});

test('без ключа Нової пошти кнопки ТТН немає', async () => {
  const ctx = makeApp({ cfg: { monobankToken: 'M' } });
  await submit(ctx.app, goodBody({ surname: 'П', delivery: warehouse }));
  await press(ctx.app, 'pay:link');
  await pay(ctx.app, 'inv-1', 20000);
  assert.equal(ctx.fetchFn.tg('sendMessage').at(-1).body.reply_markup, undefined);
});

test('«To many requests» від Нової пошти: ТТН повторює запит і створюється', async () => {
  const { createNovaPoshta } = await import('../server/novaposhta.js');
  let n = 0;
  const fetchFn = async () => {
    n += 1;
    return Response.json(n < 3 ? { success: false, errors: ['To many requests'] } : { success: true, data: [{ ok: 1 }] });
  };
  const np = createNovaPoshta({ apiKey: 'k', fetchFn, sleep: async () => {} });
  assert.deepEqual(await np.call('A', 'b', {}, { retries: 3 }), [{ ok: 1 }]);
  n = 0;
  await assert.rejects(np.call('A', 'b', {}), /many requests/i);
});
