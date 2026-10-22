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
  assert.equal(p.AfterpaymentOnGoodsCost, '1580');
  assert.equal(p.BackwardDeliveryData, undefined);
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
  assert.equal(docCalls(fetchFn)[0].body.methodProperties.AfterpaymentOnGoodsCost, undefined);
});

test('адресна доставка: створюється адреса одержувача', async () => {
  const delivery = { method: 'courier', city, street: { ref: NP.street, name: 'вул. Головна' }, house: '5', apartment: '7' };
  // Контроль оплати на адресну доставку недоступний, тому клієнт оплачує повну суму
  const { app, fetchFn } = await paidOrder({ surname: 'Петренко', delivery }, 178000, 'pay:full');
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
  assert.deepEqual([...await np.call('A', 'b', {}, { retries: 3 })], [{ ok: 1 }]);
  n = 0;
  await assert.rejects(np.call('A', 'b', {}), /many requests/i);
});

test('післяплата недоступна: пропонується ТТН без післяплати, і вона створюється', async () => {
  const { app, fetchFn, store } = await paidOrder({ surname: 'Петренко', delivery: warehouse });
  fetchFn.fail.npCod = true;
  await press(app, 'ttn:1');
  const failed = fetchFn.tg('sendMessage').at(-1);
  assert.match(failed.body.text, /Післяплата недоступна/);
  assert.equal(failed.body.reply_markup.inline_keyboard[0][0].callback_data, 'ttn0:1');
  assert.equal(store.getOrder(1).ttn_number, null);

  await press(app, 'ttn0:1');
  const p = docCalls(fetchFn).at(-1).body.methodProperties;
  assert.equal(p.AfterpaymentOnGoodsCost, undefined);
  assert.match(fetchFn.tg('sendMessage').at(-1).body.text, /БЕЗ післяплати/);
  assert.equal(store.getOrder(1).ttn_number, '20451234567890');
});

test('після ТТН замовлення в KeyCRM переводиться в налаштований статус', async () => {
  const ctx = makeApp({ cfg: { ...cfg, keycrmTtnStatusId: 42 } });
  await submit(ctx.app, goodBody({ surname: 'Петренко', delivery: warehouse }));
  await press(ctx.app, 'pay:link');
  await pay(ctx.app, 'inv-1', 20000);
  await press(ctx.app, 'ttn:1');
  assert.ok(ctx.fetchFn.crm().some((c) => c.method === 'PUT' && c.body.status_id === 42));
});

test('без KEYCRM_TTN_STATUS_ID статус у KeyCRM після ТТН не чіпаємо', async () => {
  const { app, fetchFn } = await paidOrder({ surname: 'Петренко', delivery: warehouse });
  await press(app, 'ttn:1');
  assert.ok(!fetchFn.crm().some((c) => c.method === 'PUT' && c.body.status_id));
});

test('адресна доставка: CityRecipient із DeliveryCity, вулиця за SettlementStreetRef без getStreet', async () => {
  const delivery = { method: 'courier', city: { ...city, deliveryCity: 'cccccccc-0000-0000-0000-000000000009' }, street: { ref: NP.street, name: 'вул. Головна' }, house: '5', apartment: '7' };
  const { app, fetchFn } = await paidOrder({ surname: 'Петренко', delivery }, 178000, 'pay:full');
  await press(app, 'ttn:1');
  const p = docCalls(fetchFn)[0].body.methodProperties;
  assert.equal(p.CityRecipient, 'cccccccc-0000-0000-0000-000000000009');
  const npCalls = fetchFn.calls.filter((c) => c.url.includes('novaposhta'));
  assert.equal(npCalls.some((c) => c.body.calledMethod === 'getStreet'), false);
  assert.equal(npCalls.some((c) => c.body.calledMethod === 'getWarehouses' && c.body.methodProperties.SettlementRef), false, 'додатковий запит за CityRef не потрібен');
  const save = npCalls.find((c) => c.body.modelName === 'Address' && c.body.calledMethod === 'save');
  assert.equal(save.body.methodProperties.StreetRef, NP.street);
});

test('тайм-аут Нової пошти на створенні ТТН: повтор лише після підтвердження менеджера (захист від дубля накладної)', async () => {
  const ctx = await paidOrder({ surname: 'Петренко', delivery: warehouse }, 178000, 'pay:full');
  const { app, fetchFn, store } = ctx;
  fetchFn.npTimeoutOnce = true;
  await press(app, 'ttn:1');
  const failed = fetchFn.tg('sendMessage').at(-1).body;
  assert.match(failed.text, /невідомо, чи накладну створено/);
  assert.equal(failed.reply_markup.inline_keyboard[0][0].callback_data, 'ttnok:1');
  assert.equal(store.getOrder(1).ttn_number, null);
  assert.equal(docCalls(fetchFn).length, 1);

  // Звичайна друга спроба нову накладну не створює, лише нагадує перевірити кабінет
  await press(app, 'ttn:1');
  assert.equal(docCalls(fetchFn).length, 1, 'нового запиту на створення не було');
  assert.match(fetchFn.tg('sendMessage').at(-1).body.text, /Перевірте кабінет Нової пошти/);

  // Підтвердження менеджера: накладна створюється
  await press(app, 'ttnok:1');
  assert.equal(docCalls(fetchFn).length, 2);
  assert.ok(store.getOrder(1).ttn_number);
  assert.equal(store.getMeta('ttn_ambiguous:1'), null);
});

test('звичайна помилка Нової пошти (відмова валідації) не блокує повтор: накладної точно немає', async () => {
  const ctx = await paidOrder({ surname: 'Петренко', delivery: warehouse }, 178000, 'pay:full');
  ctx.fetchFn.fail.npTtn = true;
  await press(ctx.app, 'ttn:1');
  assert.equal(ctx.store.getMeta('ttn_ambiguous:1'), null);
  ctx.fetchFn.fail.npTtn = false;
  await press(ctx.app, 'ttn:1');
  assert.ok(ctx.store.getOrder(1).ttn_number);
});

test('одночасні натискання «Створити ТТН» (подвійний клік, два менеджери): одна накладна', async () => {
  const { app, fetchFn, store } = await paidOrder({ surname: 'Петренко', delivery: warehouse }, 178000, 'pay:full');
  await Promise.all([press(app, 'ttn:1'), press(app, 'ttn:1'), press(app, 'ttn:1', 102), press(app, 'ttn:1', 103)]);
  assert.equal(docCalls(fetchFn).length, 1);
  assert.ok(store.getOrder(1).ttn_number);
  // Також у суміші з фоновим циклом
  await Promise.all([app.tick(), press(app, 'ttn:1')]);
  assert.equal(docCalls(fetchFn).length, 1);
});

test('KeyCRM відхиляє запис ТТН, бо трек-номер там уже є: цикл не довбе KeyCRM щоразу', async () => {
  // Менеджер уже вписав той самий номер вручну: повторний запис 422, але в замовленні номер збігається
  const ctx2 = makeApp({ cfg });
  ctx2.fetchFn.crmState.trackingLocked = true;
  ctx2.fetchFn.crmState.order = { shipping: { tracking_code: '20451234567890' } };
  await submit(ctx2.app, goodBody({ surname: 'Петренко', delivery: warehouse }));
  await press(ctx2.app, 'pay:full');
  await pay(ctx2.app, 'inv-1', 178000);
  await press(ctx2.app, 'ttn:1');
  assert.equal(ctx2.store.getOrder(1).ttn_crm_synced, 1, 'номер збігається: вважаємо записаним');
  const putsBefore = ctx2.fetchFn.crm().length;
  await ctx2.app.tick();
  await ctx2.app.tick();
  assert.equal(ctx2.fetchFn.crm().length, putsBefore, 'нових запитів на запис немає');
  assert.match(ctx2.fetchFn.tg('sendMessage').at(-1).body.text, /Номер записано в KeyCRM/);

  // У замовленні вже інший номер: зупиняємо повтори й не кажемо, що записано
  const ctx3 = makeApp({ cfg });
  ctx3.fetchFn.crmState.trackingLocked = true;
  ctx3.fetchFn.crmState.order = { shipping: { tracking_code: '20400000000001' } };
  await submit(ctx3.app, goodBody({ surname: 'Петренко', delivery: warehouse }));
  await press(ctx3.app, 'pay:full');
  await pay(ctx3.app, 'inv-1', 178000);
  await press(ctx3.app, 'ttn:1');
  assert.equal(ctx3.store.getOrder(1).ttn_crm_synced, 1, 'повтори зупинено');
  assert.match(ctx3.fetchFn.tg('sendMessage').at(-1).body.text, /Номер не вдалося записати в KeyCRM/);
  await ctx3.app.tick();
  assert.equal(ctx3.fetchFn.crm().filter((c) => c.body?.shipping?.tracking_code).length, 1, 'лише одна спроба запису');
});
