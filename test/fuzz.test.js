import test from 'node:test';
import assert from 'node:assert/strict';
import { call, goodBody, makeApp, signMono, signedUrl } from './helpers.js';
import { validateSubmission } from '../server/validate.js';
import { validateCustomBrief } from '../server/custom-print.js';

// Детермінований генератор: однакові «випадкові» дані при кожному запуску, тож збій відтворюється
function rng(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const JUNK = [null, undefined, '', ' ', 'x', '0', '-1', 1, 0, -1, 1e21, NaN, Infinity, true, false, [], {}, [1, 2], { a: 1 }, 'a'.repeat(5000),
  '\u0000', '<script>alert(1)</script>', '😀', '__proto__', { __proto__: { x: 1 } }, '9'.repeat(40), '+380671234567', '2025-13-45', '../../etc/passwd'];

function mutate(obj, rand) {
  const out = JSON.parse(JSON.stringify(obj));
  const keys = Object.keys(out);
  for (let i = 0; i < 1 + Math.floor(rand() * 4); i += 1) {
    const key = rand() < 0.15 ? `extra${i}` : keys[Math.floor(rand() * keys.length)];
    const roll = rand();
    if (roll < 0.15) delete out[key];
    else out[key] = JUNK[Math.floor(rand() * JUNK.length)];
  }
  return out;
}

test('валідатори замовлень не падають на сміттєвих даних і завжди повертають ok або помилку', () => {
  const rand = rng(12345);
  const full = goodBody({
    surname: 'Петренко', comment: 'тест', click: 'fbclid',
    utm: { source: 'a', medium: 'b' }, ads: { fbc: 'x' }, body: { height: 180, weight: 80 },
    delivery: { method: 'warehouse', city: { ref: '11111111-1111-4111-8111-111111111111', name: 'Київ', present: 'м. Київ', area: 'Київська' }, point: { ref: '22222222-2222-4222-8222-222222222222', number: '3', name: 'Відділення №3' } },
    ab: { vid: 'visitor-0001', cta: 'B' },
  });
  const brief = { item: 'tee', quantity: 1, idea: 'ідея', name: 'Олена', phone: '+380671234567', color: 'Чорний', size: 'M', placement: 'back', certificate: 'SP-ABCDEF' };
  for (let i = 0; i < 4000; i += 1) {
    const a = validateSubmission(mutate(full, rand), { maxQty: 10 });
    assert.equal(typeof a.ok, 'boolean');
    if (a.ok) {
      assert.ok(Number.isInteger(a.value.quantity) && a.value.quantity >= 1 && a.value.quantity <= 10);
      assert.match(a.value.phone, /^\+\d{8,15}$/);
    }
    const b = validateCustomBrief(mutate(brief, rand), { maxQty: 10 });
    assert.equal(typeof b.ok, 'boolean');
  }
  assert.equal(validateSubmission(null, { maxQty: 10 }).ok, false);
  assert.equal(validateSubmission('рядок', { maxQty: 10 }).ok, false);
  assert.equal(validateSubmission([], { maxQty: 10 }).ok, false);
});

test('HTTP: сміттєві тіла й параметри на відкритих адресах дають 2xx/4xx, ніколи 500', async () => {
  const rand = rng(777);
  const ctx = makeApp({ cfg: { novaPoshtaApiKey: 'npkey' } });
  const posts = ['/proxy/submit', '/proxy/custom', '/proxy/custom/photo', '/proxy/lastsize'];
  const bodies = [...JUNK.map((j) => String(JSON.stringify(j))), '{', '', '[]', 'null', '{"phone":{"a":1}}', '{"image":"!!!","order_number":"20250101-000000","client_id":"x"}'];
  let calls = 0;
  const statuses = new Set();
  for (let i = 0; i < 600; i += 1) {
    const path = posts[Math.floor(rand() * posts.length)];
    const raw = rand() < 0.5 ? bodies[Math.floor(rand() * bodies.length)] : JSON.stringify(mutate(goodBody(), rand));
    ctx.now.advance(61_000); // обходимо ліміти, щоб перевіряти саму обробку
    const res = await call(ctx.app, { url: signedUrl(path), rawBody: raw, ip: `10.1.${i % 250}.${Math.floor(i / 250)}` });
    statuses.add(res.status);
    assert.ok(res.status < 500, `${path} ${raw.slice(0, 80)} → ${res.status} ${res.text}`);
    calls += 1;
  }
  const gets = ['/proxy/size', '/proxy/ab', '/proxy/np/cities', '/proxy/np/points', '/proxy/np/streets'];
  const params = [{}, { height: 'abc', weight: '-5' }, { vid: 'x'.repeat(500) }, { q: '%', settlement: 'zzz' }, { settlement: '11111111-1111-4111-8111-111111111111', lat: 'NaN', lon: '1e999' },
    { sizes: ',,,'.repeat(100), height: '180', weight: '80', title: '\u0000' }];
  for (let i = 0; i < 300; i += 1) {
    const path = gets[Math.floor(rand() * gets.length)];
    const extra = params[Math.floor(rand() * params.length)];
    ctx.now.advance(61_000);
    const res = await call(ctx.app, { method: 'GET', url: signedUrl(path, extra), ip: `10.2.${i % 250}.${Math.floor(i / 250)}` });
    statuses.add(res.status);
    assert.ok(res.status < 500, `${path} ${JSON.stringify(extra).slice(0, 80)} → ${res.status} ${res.text}`);
    calls += 1;
  }
  assert.ok(calls === 900 && statuses.has(200) && statuses.has(422), `статуси: ${[...statuses]}`);
});

test('Telegram-вебхук: сміттєві оновлення не дають 5xx і не ламають обробку', async () => {
  const rand = rng(4242);
  const ctx = makeApp();
  const headers = { 'x-telegram-bot-api-secret-token': 'hook-secret' };
  const updates = [{}, { callback_query: null }, { callback_query: { data: 'ttn:abc', message: { chat: { id: -100500 } } } }, { callback_query: { data: 'st:\u0000', message: null } },
    { message: { text: null, chat: { id: -100500 } } }, { message: { text: 'SP-ABCDEF', chat: { id: -100500 }, from: null } }, { update_id: 'x', callback_query: { id: 1, data: 'pay:custom', from: {}, message: { message_id: 'z', chat: { id: -100500 } } } },
    { callback_query: { id: 2, data: 'ttnok:99999', message: { message_id: 1, chat: { id: -100500 } } } }, { callback_query: { id: 3, data: 'cert:use:SP-AAAAAA', message: { message_id: 1, chat: { id: -100500 } } } }];
  for (let i = 0; i < 200; i += 1) {
    const body = mutate(updates[Math.floor(rand() * updates.length)], rand);
    const res = await call(ctx.app, { url: '/telegram/webhook', headers, rawBody: JSON.stringify(body) });
    assert.ok(res.status < 500, `${JSON.stringify(body).slice(0, 120)} → ${res.status} ${res.text}`);
  }
});

test('вебхук Monobank: коректно підписані сміттєві тіла не дають 5xx, непідписані відхиляються', async () => {
  const rand = rng(99);
  const ctx = makeApp({ cfg: { monobankToken: 'M', publicUrl: 'https://qo.test' } });
  const raws = ['{}', '[]', 'null', '"x"', '{"invoiceId":null,"status":"success"}', '{"invoiceId":"nope","status":"success","amount":"abc"}',
    '{"invoiceId":"inv-1","status":{"a":1},"amount":-5}', '{"invoiceId":"inv-1","status":"success","amount":1e30,"modifiedDate":"не дата"}', '{"invoiceId":"inv-1","status":"reversed","finalAmount":null}', 'не json'];
  for (let i = 0; i < 120; i += 1) {
    const raw = raws[Math.floor(rand() * raws.length)];
    const signed = await call(ctx.app, { url: '/mono/webhook', rawBody: raw, headers: { 'x-sign': signMono(raw) } });
    assert.ok(signed.status < 500, `${raw} → ${signed.status} ${signed.text}`);
    const unsigned = await call(ctx.app, { url: '/mono/webhook', rawBody: raw, headers: { 'x-sign': 'AAAA' } });
    assert.ok(unsigned.status >= 400 && unsigned.status < 500, `${raw} без підпису → ${unsigned.status}`);
  }
});
