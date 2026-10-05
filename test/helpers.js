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
  dbPath: ':memory:',
  workerIntervalMs: 30000,
  keycrmToken: '',
  keycrmSourceId: 216,
  keycrmStatusMap: {},
  reminderMinutes: 15,
  reminderRepeatMinutes: 30,
  reminderMax: 3,
  reportDay: 1,
  reportHour: 9,
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
    if (u.startsWith('https://openapi.keycrm.app/')) {
      if (fn.fail.keycrm) return new Response('{"message":"boom"}', { status: 500 });
      return Response.json({ id: 777 });
    }
    throw new Error(`unexpected fetch ${u}`);
  };
  fn.calls = calls;
  fn.fail = { telegram: false, keycrm: false };
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
export async function call(app, { method = 'POST', url, body, headers = {} }) {
  const { Readable } = await import('node:stream');
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  Object.assign(req, { method, url, headers, socket: { remoteAddress: '1.2.3.4' } });
  const res = {
    status: 0,
    headers: {},
    writeHead(status, h) { this.status = status; this.headers = h; },
    end(payload) { this.payload = payload; },
  };
  await app.handle(req, res);
  return { status: res.status, json: JSON.parse(res.payload) };
}

export const submit = (app, body = goodBody()) => call(app, { url: signedUrl(), body });
