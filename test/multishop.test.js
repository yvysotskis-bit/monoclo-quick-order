import test from 'node:test';
import assert from 'node:assert/strict';
import { signParams } from '../server/proxy-signature.js';
import { loadConfig } from '../server/config.js';
import { call, config, goodBody, makeApp, submit } from './helpers.js';

// Другий магазин (Morning Star): свій секрет, своє джерело KeyCRM, без оплат і ТТН
const ms = {
  key: 'ms', shop: 'morning-star.myshopify.com', apiSecret: 'ms-secret', storeOrigin: 'https://ms.test',
  keycrmSourceId: 215, tag: '#MorningStar', name: 'Morning Star', full: false,
};
const main = {
  key: 'main', shop: config.shop, apiSecret: config.apiSecret, storeOrigin: config.storeOrigin,
  keycrmSourceId: 216, tag: '#Monoclo', name: '', full: true,
};
const cfg = { shops: [main, ms], keycrmToken: 'crm', monobankToken: 'M', novaPoshtaApiKey: 'npkey' };

function msUrl(path = '/proxy/submit', { secret = ms.apiSecret, shop = ms.shop, extra = {} } = {}) {
  const params = new URLSearchParams({ shop, path_prefix: '/apps/quick-order', timestamp: String(Math.floor(Date.now() / 1000)), ...extra });
  params.set('signature', signParams(params, secret));
  return `${path}?${params}`;
}

test('замовлення Morning Star: той самий бот, позначка магазину, джерело 215, без кнопок оплати', async () => {
  const { app, fetchFn, store } = makeApp({ cfg });
  const r = await call(app, { url: msUrl(), body: goodBody() });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);

  assert.ok(fetchFn.calls.some((c) => c.url.startsWith('https://ms.test/products/tee')), 'ціна з магазину Morning Star');
  const [msg] = fetchFn.tg('sendMessage');
  assert.equal(msg.body.chat_id, '-100500');
  assert.match(msg.body.text, /Швидке замовлення #\S+<\/b> · <b>Morning Star<\/b>/);
  assert.match(msg.body.text, /#MorningStar$/);
  assert.doesNotMatch(msg.body.text, /#Monoclo/);
  const buttons = msg.body.reply_markup.inline_keyboard.flat();
  assert.ok(buttons.some((b) => b.callback_data === 'st:taken'), 'кнопки статусів є');
  assert.ok(!buttons.some((b) => String(b.callback_data || '').startsWith('pay:')), 'кнопок оплати немає');
  assert.ok(buttons.some((b) => String(b.url || '').startsWith('https://ms.test/') || String(b.url || '').startsWith('https://')), 'посилання на товар');

  const crmPost = fetchFn.crm().find((c) => c.url.endsWith('/v1/order'));
  assert.equal(crmPost.body.source_id, 215);
  assert.equal(store.getOrder(1).data.shop, 'ms');
});

test('замовлення Monoclo не змінились: #Monoclo, джерело 216, кнопки оплати, без позначки магазину', async () => {
  const { app, fetchFn, store } = makeApp({ cfg });
  const r = await submit(app, goodBody());
  assert.equal(r.status, 200);
  const [msg] = fetchFn.tg('sendMessage');
  assert.match(msg.body.text, /#Monoclo$/);
  assert.doesNotMatch(msg.body.text, /Morning Star/);
  assert.ok(msg.body.reply_markup.inline_keyboard.flat().some((b) => String(b.callback_data || '').startsWith('pay:')));
  assert.equal(fetchFn.crm().find((c) => c.url.endsWith('/v1/order')).body.source_id, 216);
  assert.equal(store.getOrder(1).data.shop, undefined);
});

test('підпис чужим секретом, невідомий магазин: відмова', async () => {
  const { app, fetchFn } = makeApp({ cfg });
  // Запит від Morning Star, підписаний секретом Monoclo
  assert.equal((await call(app, { url: msUrl('/proxy/submit', { secret: config.apiSecret }), body: goodBody() })).status, 401);
  // Невідомий магазин з дійсним підписом основного магазину
  assert.equal((await call(app, { url: msUrl('/proxy/submit', { secret: config.apiSecret, shop: 'evil.myshopify.com' }), body: goodBody() })).status, 403);
  assert.equal(fetchFn.calls.length, 0);
});

test('Нова пошта працює і через проксі Morning Star', async () => {
  const { app } = makeApp({ cfg });
  const r = await call(app, { method: 'GET', url: msUrl('/proxy/np/cities', { extra: { q: 'Чернів' } }) });
  assert.equal(r.status, 200);
  assert.ok(r.json.items.length > 0);
  const bad = await call(app, { method: 'GET', url: msUrl('/proxy/np/cities', { secret: 'wrong', extra: { q: 'Чернів' } }) });
  assert.equal(bad.status, 401);
});

test('кнопки оплати й ТТН під замовленням Morning Star не спрацьовують', async () => {
  const { app, fetchFn } = makeApp({ cfg });
  await call(app, { url: msUrl(), body: goodBody() });
  const messageId = 101;
  const press = (data) => call(app, {
    url: '/telegram/webhook',
    headers: { 'x-telegram-bot-api-secret-token': config.telegramWebhookSecret },
    body: { update_id: Math.floor(Math.random() * 1e9), callback_query: { id: 'q', data, from: { first_name: 'Оля' }, message: { message_id: messageId, chat: { id: -100500 }, text: 'x' } } },
  });
  await press('pay:link');
  await press('ttn:1');
  assert.equal(fetchFn.mono().length, 0, 'рахунок не створюється');
  assert.ok(!fetchFn.calls.some((c) => c.url.startsWith('https://api.novaposhta.ua/') && c.body?.modelName === 'InternetDocument'), 'ТТН не створюється');
});

test('конфіг: другий магазин вмикається змінними MS_*', () => {
  const base = {
    SHOPIFY_SHOP: 'monoclo.myshopify.com', SHOPIFY_API_SECRET: 's', TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: '1', TELEGRAM_WEBHOOK_SECRET: 'w', DB_PATH: ':memory:',
  };
  assert.equal(loadConfig(base).shops.length, 1);
  const c = loadConfig({ ...base, MS_SHOP: 'morning-star-1883.myshopify.com', MS_API_SECRET: 'x', MS_STORE_ORIGIN: 'https://morningstar.com.ua/' });
  assert.equal(c.shops.length, 2);
  assert.deepEqual(
    { key: c.shops[1].key, origin: c.shops[1].storeOrigin, source: c.shops[1].keycrmSourceId, tag: c.shops[1].tag, full: c.shops[1].full },
    { key: 'ms', origin: 'https://morningstar.com.ua', source: 215, tag: '#MorningStar', full: false },
  );
  assert.throws(() => loadConfig({ ...base, MS_SHOP: 'morning-star-1883.myshopify.com' }), /MS_API_SECRET/);
});

test('перехід в оформлення через /proxy/go: редирект лише на get-checkout.com цього магазину', async () => {
  const { app } = makeApp({ cfg });
  const ok = await call(app, { method: 'GET', url: msUrl('/proxy/go', { extra: { cart: 'hWNHLyau2uvTlJpz?key=cd5b24afa566', locale: 'uk', country: 'UA', utm_source: 'fb' } }) });
  assert.equal(ok.status, 200);
  const loc = new URL(JSON.parse(/location\.replace\((".*?")\)/.exec(ok.text)[1]));
  assert.equal(loc.origin, 'https://get-checkout.com');
  assert.equal(loc.pathname, `/${ms.shop}/`);
  assert.equal(loc.searchParams.get('cart'), 'hWNHLyau2uvTlJpz?key=cd5b24afa566');
  assert.equal(loc.searchParams.get('utm_source'), 'fb');
  for (const p of ['shop', 'signature', 'timestamp', 'path_prefix']) assert.equal(loc.searchParams.has(p), false, p);

  const badCart = await call(app, { method: 'GET', url: msUrl('/proxy/go', { extra: { cart: 'https://evil.example' } }) });
  assert.equal(badCart.status, 302);
  assert.equal(badCart.headers.location, '/cart');
  const unknownShop = await call(app, { method: 'GET', url: msUrl('/proxy/go', { shop: 'evil.myshopify.com', extra: { cart: 'abcdefgh12' } }) });
  assert.equal(unknownShop.status, 302);
});

test('/proxy/go/<домен>: лише домен магазину або myshopify, інакше назад у кошик', async () => {
  const { app } = makeApp({ cfg });
  const host = new URL(config.storeOrigin).host;
  const mainUrl = (path, extra) => {
    const params = new URLSearchParams({ shop: config.shop, path_prefix: '/apps/quick-order', timestamp: String(Math.floor(Date.now() / 1000)), ...extra });
    params.set('signature', signParams(params, config.apiSecret));
    return `${path}?${params}`;
  };
  const ok = await call(app, { method: 'GET', url: mainUrl(`/proxy/go/${host}`, { cart: 'abcdefgh12?key=abcdefgh12' }) });
  assert.equal(ok.status, 200);
  const loc = new URL(JSON.parse(/location\.replace\((".*?")\)/.exec(ok.text)[1]));
  assert.equal(loc.href.startsWith(`https://get-checkout.com/${host}/?`), true);
  const evil = await call(app, { method: 'GET', url: mainUrl('/proxy/go/evil.example', { cart: 'abcdefgh12' }) });
  assert.equal(evil.status, 302);
  assert.equal(evil.headers.location, '/cart');
});

test('/proxy/go: токен кошика з «_» і «-» та довшими значеннями проходить, небезпечні символи ні; відмова лишає слід у логах', async () => {
  const logs = [];
  const { app } = makeApp({ cfg, log: { log() {}, error: (...a) => logs.push(a.join(' ')) } });
  const host = new URL(config.storeOrigin).host;
  const mainUrl = (path, extra) => {
    const params = new URLSearchParams({ shop: config.shop, path_prefix: '/apps/quick-order', timestamp: String(Math.floor(Date.now() / 1000)), ...extra });
    params.set('signature', signParams(params, config.apiSecret));
    return `${path}?${params}`;
  };
  for (const cart of ['ab_cd-EF12gh', 'A'.repeat(100), 'abcdefgh12?key=ab_cd-ef34']) {
    const r = await call(app, { method: 'GET', url: mainUrl(`/proxy/go/${host}`, { cart }) });
    assert.equal(r.status, 200, cart);
  }
  for (const cart of ['a/../b12345', 'abc def123', 'https://evil.example', 'abcdefgh12?key=x/y', 'short', 'a'.repeat(200)]) {
    const r = await call(app, { method: 'GET', url: mainUrl(`/proxy/go/${host}`, { cart }) });
    assert.equal(r.status, 302, cart);
    assert.equal(r.headers.location, '/cart');
  }
  assert.ok(logs.some((l) => /checkout redirect rejected cart format/.test(l)));
  assert.ok(!logs.some((l) => l.includes('evil.example')), 'токен кошика в логи не потрапляє');
});
