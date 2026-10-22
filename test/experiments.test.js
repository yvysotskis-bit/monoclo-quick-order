import test from 'node:test';
import assert from 'node:assert/strict';
import { EXPERIMENTS, cleanAb, zScore } from '../server/experiments.js';
import { call, goodBody, makeApp, signedUrl, submit } from './helpers.js';

const ask = (app, vid) => call(app, { method: 'GET', url: signedUrl('/proxy/ab', vid === undefined ? {} : { vid }) });

// Наповнює тест виставленими показами й конверсіями напряму в базі
function fill(store, exp, variant, views, conversions, prefix) {
  for (let i = 0; i < views; i += 1) {
    store.abRecordExposure(exp, `${prefix}-${i}`.padEnd(10, 'x'), variant, 1);
    if (i < conversions) store.abMarkConverted(exp, `${prefix}-${i}`.padEnd(10, 'x'), 2);
  }
}

test('zScore: відомі значення', () => {
  assert.equal(zScore(0, 0, 5, 10), 0);
  assert.equal(zScore(10, 100, 10, 100), 0);
  assert.ok(zScore(30, 300, 60, 300) > 3);
  assert.ok(zScore(60, 300, 30, 300) < -3);
  assert.ok(Math.abs(zScore(30, 300, 36, 300)) < 1.96);
});

test('cleanAb: лише коректний vid і відомі варіанти', () => {
  assert.equal(cleanAb(null), null);
  assert.equal(cleanAb({ vid: 'коротко', cta: 'B' }), null);
  assert.deepEqual(cleanAb({ vid: 'visitor-0001', cta: 'B' }), { vid: 'visitor-0001', variants: { cta: 'B' } });
  assert.deepEqual(cleanAb({ vid: 'visitor-0001', cta: 'ZZ' }), { vid: 'visitor-0001', variants: {} });
});

test('призначення варіанта: стабільне для відвідувача, обидва варіанти зустрічаються, показ рахується один раз', async () => {
  const { app, store, now } = makeApp();
  const first = (await ask(app, 'visitor-aaaa1111')).json.variants.cta;
  assert.ok(['A', 'B'].includes(first));
  for (let i = 0; i < 3; i += 1) assert.equal((await ask(app, 'visitor-aaaa1111')).json.variants.cta, first);
  const seen = new Set();
  for (let i = 0; i < 60; i += 1) {
    if (i % 20 === 0) now.advance(61_000); // ліміт запитів з однієї адреси: 30 за хвилину
    seen.add((await ask(app, `visitor-${String(i).padStart(8, '0')}`)).json.variants.cta);
  }
  assert.deepEqual([...seen].sort(), ['A', 'B']);
  const totals = store.abStats('cta').reduce((n, r) => n + r.views, 0);
  assert.equal(totals, 61, 'кожен відвідувач — один показ');
});

test('/proxy/ab: без підпису 401, без vid — порожньо', async () => {
  const { app } = makeApp();
  assert.equal((await call(app, { method: 'GET', url: '/proxy/ab?vid=visitor-aaaa1111' })).status, 401);
  assert.deepEqual((await ask(app)).json.variants, {});
  assert.deepEqual((await ask(app, 'x')).json.variants, {});
});

test('замовлення зараховується конверсією варіанта; відвідувач без показу не рахується', async () => {
  const { app, store } = makeApp();
  const variant = (await ask(app, 'visitor-conv0001')).json.variants.cta;
  const r = await submit(app, goodBody({ ab: { vid: 'visitor-conv0001', cta: variant } }));
  assert.equal(r.status, 200);
  assert.deepEqual({ ...store.abStats('cta').find((s) => s.variant === variant) }, { variant, views: 1, conversions: 1 });
  // відвідувач без показу не створює записів
  await submit(app, goodBody({ phone: '+380671110002', client_id: 'client-id-0002', ab: { vid: 'visitor-nobody01', cta: 'B' } }));
  assert.equal(store.abStats('cta').reduce((n, s) => n + s.views, 0), 1);
});

test('значуща різниця: переможець фіксується, сповіщення менеджеру, усі отримують переможця', async () => {
  const { app, store, fetchFn } = makeApp();
  fill(store, 'cta', 'A', 400, 40, 'ctrl');
  fill(store, 'cta', 'B', 400, 80, 'test');
  await app.tick();
  assert.equal(store.getMeta('ab_winner:cta'), 'B');
  const text = fetchFn.tg('sendMessage').map((c) => c.body.text).find((t) => /A\/B-тест/.test(t));
  assert.match(text, /переміг варіант «Підтвердити»/);
  assert.match(text, /10% \(40 із 400\)/);
  assert.match(text, /20% \(80 із 400\)/);
  for (let i = 0; i < 20; i += 1) assert.equal((await ask(app, `newcomer-${String(i).padStart(6, '0')}`)).json.variants.cta, 'B');
  assert.equal(store.abStats('cta').reduce((n, s) => n + s.views, 0), 800, 'після рішення покази не накопичуються');
  const messages = fetchFn.tg('sendMessage').length;
  await app.tick();
  assert.equal(fetchFn.tg('sendMessage').length, messages, 'повідомлення лише раз');
});

test('різниця незначуща або вибірка мала: чекаємо; на межі вибірки лишаємо контроль', async () => {
  const { app, store, fetchFn } = makeApp();
  fill(store, 'cta', 'A', 100, 10, 'ctrl');
  fill(store, 'cta', 'B', 100, 30, 'test');
  await app.tick();
  assert.equal(store.getMeta('ab_winner:cta'), null, 'менше 300 показів на варіант');

  const same = makeApp({ cfg: { abMaxViews: 400 } });
  fill(same.store, 'cta', 'A', 400, 40, 'ctrl');
  fill(same.store, 'cta', 'B', 400, 42, 'test');
  await same.app.tick();
  assert.equal(same.store.getMeta('ab_winner:cta'), 'A');
  assert.match(same.fetchFn.tg('sendMessage').map((c) => c.body.text).join('\n'), /різниці немає/);
  assert.equal(fetchFn.tg('sendMessage').filter((c) => /A\/B-тест/.test(c.body.text)).length, 0);
});

test('AB_ENABLED=false: нічого не призначається й не рахується', async () => {
  const { app, store } = makeApp({ cfg: { abEnabled: false } });
  assert.deepEqual((await ask(app, 'visitor-off00001')).json.variants, {});
  assert.equal(store.abStats('cta').length, 0);
});

test('/status показує підсумок тестів', async () => {
  const { app, store } = makeApp();
  fill(store, 'cta', 'A', 10, 1, 'ctrl');
  const r = await call(app, { method: 'GET', url: '/status' });
  const cta = r.json.experiments.find((e) => e.id === EXPERIMENTS[0].id);
  assert.deepEqual(cta.variants.A, { views: 10, conversions: 1, rate: 10 });
});

test('/proxy/ab: з однієї адреси не більше 30 запитів за хвилину (захист бази від накрутки показів)', async () => {
  const { app, store } = makeApp();
  let limited = 0;
  for (let i = 0; i < 40; i += 1) if ((await ask(app, `flood-${String(i).padStart(8, '0')}`)).status === 429) limited += 1;
  assert.equal(limited, 10);
  assert.equal(store.abStats('cta').reduce((n, s) => n + s.views, 0), 30);
});
