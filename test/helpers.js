import crypto from 'node:crypto';
import { signParams } from '../server/proxy-signature.js';
import { createApp } from '../server/app.js';
import { openStore } from '../server/store.js';

export const config = {
  port: 0,
  shop: 'test-shop.myshopify.com',
  apiSecret: 'shhh',
  storeOrigin: 'https://store.test',
  telegramToken: 'TOKEN123',
  telegramChatId: '-100500',
  telegramWebhookSecret: 'hook-secret',
  timezone: 'Europe/Kyiv',
  workStart: 10,
  workEnd: 20,
  maxQty: 10,
  currency: 'UAH',
  publicUrl: 'https://qo.test',
  dbPath: ':memory:',
  workerIntervalMs: 30000,
  keycrmToken: '',
  keycrmSourceId: 216,
  keycrmStatusMap: {},
  keycrmPaymentMethodId: 0,
  monobankToken: '',
  novaPoshtaApiKey: '',
  keycrmNovaPoshtaServiceId: 0,
  npSenderCity: 'Чернівці',
  npSenderWarehouse: '31',
  npSenderPhone: '',
  npParcel: { weightKg: 1, length: 30, width: 25, height: 5 },
  npDescription: 'Monoclo',
  npCodMode: 'control',
  prepayAmountUah: 200,
  payMaxAmountUah: 50000,
  payValiditySeconds: 86400,
  reminderMinutes: 15,
  reminderRepeatMinutes: 30,
  reminderMax: 3,
  remindersFrom: 0,
  reportDay: 1,
  reportHour: 9,
};

// Пара ключів, якою «банк» підписує вебхуки в тестах
const monoKeys = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const monoPublicPem = monoKeys.publicKey.export({ type: 'spki', format: 'pem' });
export const signMono = (raw) => crypto.sign('sha256', Buffer.from(raw), monoKeys.privateKey).toString('base64');

// Ідентифікатори з довідника Нової пошти для тестів
export const NP = {
  city: 'e71a0b8e-9b3d-4a39-8a1f-111111111111',
  branch: 'd1a8e3e2-1111-4a39-8a1f-222222222222',
  branch2: 'd1a8e3e2-1111-4a39-8a1f-333333333333',
  postomat: 'd1a8e3e2-1111-4a39-8a1f-444444444444',
  leak: 'd1a8e3e2-1111-4a39-8a1f-555555555555',
  street: 'a1a8e3e2-1111-4a39-8a1f-666666666666',
};

export const product = {
  handle: 'tee',
  title: 'Футболка <Volvo> FH16',
  featured_image: '//cdn.test/tee.jpg',
  options: [{ name: 'Колір' }, { name: 'Розмір' }],
  variants: [
    { id: 111, sku: 'TEE-BLK-S', available: true, price: 89000, options: ['Чорний', 'S'] },
    { id: 222, sku: 'TEE-BLK-M', available: false, price: 89000, options: ['Чорний', 'M'] },
  ],
};

export function signedUrl(path = '/proxy/submit', extra = {}) {
  const params = new URLSearchParams({
    shop: config.shop,
    path_prefix: '/apps/quick-order',
    timestamp: String(Math.floor(Date.now() / 1000)),
    ...extra,
  });
  params.set('signature', signParams(params, config.apiSecret));
  return `${path}?${params}`;
}

export const goodBody = (over = {}) => ({
  product_handle: 'tee',
  variant_id: 111,
  quantity: 2,
  name: 'Іван',
  phone: '+380 (67) 123 45 67',
  client_id: 'client-id-0001',
  ...over,
});

// Підміна fetch: магазин, Telegram, KeyCRM. Режими збоїв перемикаються на льоту через fn.fail.
export function mockFetch({ productResponse } = {}) {
  const calls = [];
  let messageId = 100;
  const fn = async (url, init = {}) => {
    const u = String(url);
    const call = { url: u, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null, headers: init.headers };
    calls.push(call);
    if (u.startsWith('https://store.test/products/')) {
      if (productResponse === 404) return new Response('{}', { status: 404 });
      return Response.json(productResponse || product);
    }
    if (u.startsWith('https://api.telegram.org/')) {
      if (fn.fail.telegram) return Response.json({ ok: false, description: 'Bad Gateway' }, { status: 502 });
      return Response.json({ ok: true, result: { message_id: ++messageId } });
    }
    if (u.startsWith('https://api.monobank.ua/')) {
      if (fn.fail.monobank) return new Response('{"errText":"boom"}', { status: 500 });
      if (u.endsWith('/invoice/remove')) return Response.json({});
      if (u.endsWith('/pubkey')) return Response.json({ key: Buffer.from(monoPublicPem).toString('base64') });
      if (u.endsWith('/invoice/create')) {
        fn.invoices += 1;
        return Response.json({ invoiceId: `inv-${fn.invoices}`, pageUrl: `https://pay.mono.bank/inv-${fn.invoices}` });
      }
    }
    if (u.startsWith('https://api.novaposhta.ua/')) {
      fn.np += 1;
      if (fn.fail.novaposhta) return new Response('{"success":false,"errors":["boom"]}', { status: 200 });
      const { calledMethod, methodProperties: p } = call.body;
      if (calledMethod === 'searchSettlements') {
        return Response.json({ success: true, data: [{ TotalCount: '2', Addresses: [
          { Ref: NP.city, MainDescription: 'Чернівці', Present: 'м. Чернівці, Чернівецька обл.', Area: 'Чернівецька', Region: '', Warehouses: '58' },
          { Ref: 'ffffffff-0000-0000-0000-000000000001', MainDescription: 'Чернівці', Present: 'с. Чернівці, Вінницька обл.', Area: 'Вінницька', Region: 'Могилів-Подільський', Warehouses: '1' },
        ] }] });
      }
      if (calledMethod === 'getCounterparties') return Response.json({ success: true, data: [{ Ref: 'sender-cp' }] });
      if (calledMethod === 'getCounterpartyContactPersons') return Response.json({ success: true, data: [{ Ref: 'sender-contact', Phones: '380501112233' }] });
      if (calledMethod === 'getWarehouses' && p.CityName) {
        return Response.json({ success: true, data: [
          { Ref: 'sender-wh', Number: '31', CityRef: 'sender-city', CategoryOfWarehouse: 'Branch' },
          { Ref: 'other-wh', Number: '5', CityRef: 'sender-city', CategoryOfWarehouse: 'Branch' },
        ] });
      }
      if (calledMethod === 'save' && call.body.modelName === 'Counterparty') {
        if (fn.fail.npTtn) return Response.json({ success: false, errors: ['Recipient invalid'], data: [] });
        return Response.json({ success: true, data: [{ Ref: 'recipient-cp', ContactPerson: { data: [{ Ref: 'recipient-contact' }] } }] });
      }
      if (calledMethod === 'getStreet') return Response.json({ success: true, data: [{ Ref: 'street-ref' }] });
      if (calledMethod === 'save' && call.body.modelName === 'Address') return Response.json({ success: true, data: [{ Ref: 'address-ref' }] });
      if (calledMethod === 'save' && call.body.modelName === 'InternetDocument') {
        if (fn.fail.npCod && (p.BackwardDeliveryData || p.AfterpaymentOnGoodsCost)) return Response.json({ success: false, errors: ['Передана послуга Післяплата недоступна'], data: [] });
        return Response.json({ success: true, data: [{ Ref: 'doc-ref', IntDocNumber: '20451234567890' }] });
      }
      if (calledMethod === 'getWarehouses') {
        const postomat = p.TypeOfWarehouseRef === 'f9316480-5f2d-425d-bc2c-ac7cd29decf0';
        const rows = postomat
          ? [{ Ref: NP.postomat, CityRef: 'city-ref', Number: '4101', Description: 'Поштомат "Нова Пошта" №4101: вул. Головна, 12', ShortAddress: 'вул. Головна, 12', CategoryOfWarehouse: 'Postomat' }]
          : [
            { Ref: NP.branch, CityRef: 'city-ref', Number: '3', Description: 'Відділення №3: вул. Ольги Кобилянської, 1', ShortAddress: 'вул. Ольги Кобилянської, 1', CategoryOfWarehouse: 'Branch' },
            { Ref: NP.branch2, Number: '12', Description: 'Відділення №12: просп. Незалежності, 5', ShortAddress: 'просп. Незалежності, 5', CategoryOfWarehouse: 'Branch' },
            { Ref: NP.leak, Number: '9999', Description: 'Поштомат, що не має бути серед відділень', CategoryOfWarehouse: 'Postomat' },
          ];
        return Response.json({ success: true, data: rows.filter((r) => !p.FindByString || r.Description.includes(p.FindByString)) });
      }
      if (calledMethod === 'searchSettlementStreets') {
        return Response.json({ success: true, data: [{ Addresses: [{ SettlementStreetRef: NP.street, Present: 'вул. Головна', SettlementStreetDescription: 'Головна' }] }] });
      }
    }
    if (u.startsWith('https://openapi.keycrm.app/')) {
      if (fn.fail.keycrm) return new Response('{"message":"boom"}', { status: 500 });
      if (fn.fail.keycrmShipping && call.body?.shipping?.shipping_service) {
        return new Response('{"message":"shipping invalid"}', { status: 422 });
      }
      return Response.json({ id: 777 });
    }
    throw new Error(`unexpected fetch ${u}`);
  };
  fn.calls = calls;
  fn.fail = { telegram: false, keycrm: false, monobank: false, novaposhta: false, keycrmShipping: false };
  fn.invoices = 0;
  fn.np = 0;
  fn.mono = () => calls.filter((c) => c.url.includes('api.monobank.ua') && c.url.endsWith('/invoice/create'));
  fn.monoRemoved = () => calls.filter((c) => c.url.endsWith('/invoice/remove'));
  fn.tg = (method) => calls.filter((c) => c.url.includes('api.telegram.org') && c.url.endsWith(`/${method}`));
  fn.crm = () => calls.filter((c) => c.url.includes('keycrm.app'));
  return fn;
}

export const silentLog = { log() {}, error() {} };

// Годинник, яким можна керувати
export function clock(iso = '2025-10-05T12:00:00Z') {
  let t = new Date(iso).getTime();
  const now = () => new Date(t);
  now.advance = (ms) => { t += ms; };
  now.set = (value) => { t = new Date(value).getTime(); };
  return now;
}

export function makeApp({ cfg = {}, fetchOpts, at = '2025-10-05T12:00:00Z' } = {}) {
  const fetchFn = mockFetch(fetchOpts);
  const now = clock(at);
  const store = openStore(':memory:');
  const merged = { ...config, ...cfg };
  const app = createApp({ config: merged, store, fetchFn, log: silentLog, now });
  return { app, fetchFn, now, store, config: merged };
}

// Виклик handle() без реального сокета
export async function call(app, { method = 'POST', url, body, rawBody, headers = {} }) {
  const { Readable } = await import('node:stream');
  const payload = rawBody ?? (body === undefined ? null : JSON.stringify(body));
  const req = Readable.from(payload === null ? [] : [Buffer.from(payload)]);
  Object.assign(req, { method, url, headers, socket: { remoteAddress: '1.2.3.4' } });
  const res = {
    status: 0,
    headers: {},
    writeHead(status, h) { this.status = status; this.headers = h; },
    end(payload) { this.payload = payload; },
  };
  await app.handle(req, res);
  const isJson = String(res.headers['content-type']).includes('json');
  return { status: res.status, headers: res.headers, text: res.payload, json: isJson ? JSON.parse(res.payload) : null };
}

export const submit = (app, body = goodBody()) => call(app, { url: signedUrl(), body });
