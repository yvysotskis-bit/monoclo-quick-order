import { signParams } from '../server/proxy-signature.js';

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
};

export const product = {
  handle: 'tee',
  title: 'Футболка <Volvo> FH16',
  options: [{ name: 'Колір' }, { name: 'Розмір' }],
  variants: [
    { id: 111, available: true, price: 89000, options: ['Чорний', 'S'] },
    { id: 222, available: false, price: 89000, options: ['Чорний', 'M'] },
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

// Підміна fetch: магазин + Telegram
export function mockFetch({ productResponse, telegramOk = true } = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
    if (String(url).startsWith('https://store.test/products/')) {
      if (productResponse === 404) return new Response('{}', { status: 404 });
      return Response.json(productResponse || product);
    }
    if (String(url).startsWith('https://api.telegram.org/')) {
      return telegramOk
        ? Response.json({ ok: true, result: {} })
        : Response.json({ ok: false, description: 'Bad Request' }, { status: 400 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  fn.calls = calls;
  return fn;
}

export const silentLog = { log() {}, error() {} };

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
