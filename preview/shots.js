// E2E-перевірка попапа у справжньому Chromium + скріншоти в preview/out/shots.
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const page_url = (q = '') => `file://${root}/preview/out/index.html${q}`;
const shots = path.join(root, 'preview/out/shots');
fs.mkdirSync(shots, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox'],
});

async function session(name, viewport, q = '') {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, locale: 'uk-UA', hasTouch: viewport.width < 700 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(page_url(q));
  const shot = (n) => page.screenshot({ path: path.join(shots, `${name}-${n}.png`) });
  return { page, ctx, shot, errors };
}

const open = async (page) => {
  await page.click('.qo-block .qo-trigger');
  await page.waitForSelector('.qo-dialog.is-open');
  await page.waitForTimeout(400);
};

async function flow(name, viewport) {
  const { page, ctx, shot, errors } = await session(name, viewport);
  await shot('0-page');
  await open(page);

  // Початковий стан: кнопка неактивна, підказка просить вибрати колір
  assert.equal(await page.getAttribute('[data-qo-submit]', 'aria-disabled'), 'true');
  assert.equal(await page.textContent('[data-qo-cta-hint]'), 'Оберіть колір');
  assert.match(await page.textContent('[data-qo-note]'), /Менеджер зв'яжеться з вами, як тільки звільниться/);
  await shot('1-open');

  // Фото змінюється вже при виборі кольору (без розміру), навіть якщо в варіанта немає власного фото
  const imgSrc = () => page.getAttribute('[data-qo-image]', 'src');
  await page.click('.qo-choice[data-qo-value="Білий"]');
  await page.waitForFunction(() => document.querySelector('[data-qo-image]').src.includes('%23ffffff'));
  await page.click('.qo-choice[data-qo-value="Графітовий"]');
  await page.waitForFunction(() => document.querySelector('[data-qo-image]').src.includes('%233b3b3d'));
  assert.ok((await imgSrc()).includes('%233b3b3d'));

  // Колір → розмір; недоступні розміри для графітового
  assert.equal(await page.textContent('[data-qo-cta-hint]'), 'Оберіть розмір');
  assert.equal(await page.getAttribute('.qo-choice[data-qo-value="S"]', 'aria-disabled'), 'true');
  assert.equal(await page.getAttribute('.qo-choice[data-qo-value="L"]', 'aria-disabled'), 'false');
  await shot('2-color');

  // Зміна кольору скидає розмір, якщо він став недоступним
  await page.click('.qo-choice[data-qo-value="Чорний"]');
  await page.click('.qo-choice[data-qo-value="L"]');
  await page.click('.qo-choice[data-qo-value="Білий"]');
  assert.equal(await page.getAttribute('.qo-choice[data-qo-value="L"]', 'aria-checked'), 'true');
  await page.click('.qo-choice[data-qo-value="Чорний"]');

  // Залишок: Чорний/L → "Залишилось 2 шт.", кількість обмежена
  assert.equal(await page.textContent('[data-qo-stock]'), 'Залишилось 2 шт.');
  await page.click('[data-qo-qty="1"]');
  assert.equal(await page.inputValue('[data-qo-qty-input]'), '2');
  assert.equal(await page.isDisabled('[data-qo-qty="1"]'), true);
  assert.match(await page.textContent('[data-qo-total]'), /1\s?780/);
  assert.equal(await page.textContent('[data-qo-badge]'), '−19%');

  // Клік по неактивній кнопці підсвічує поле, а не відправляє
  await page.click('[data-qo-submit]', { force: true });
  assert.equal(await page.evaluate(() => window.__orders.length), 0);
  assert.equal(await page.textContent('[data-qo-cta-hint]'), 'Вкажіть імʼя');
  await shot('3-missing-name');

  // Маска телефону
  await page.fill('[data-qo-name]', 'Іван');
  await page.click('[data-qo-phone]');
  await page.keyboard.type('0671234567');
  assert.equal(await page.inputValue('[data-qo-phone]'), '(67) 123 45 67');
  await page.keyboard.press('Backspace');
  assert.equal(await page.inputValue('[data-qo-phone]'), '(67) 123 45 6');
  await page.fill('[data-qo-phone]', '');
  await page.keyboard.type('67');
  assert.equal(await page.inputValue('[data-qo-phone]'), '(67)');
  await page.keyboard.press('Backspace');
  assert.equal(await page.inputValue('[data-qo-phone]'), '(6');
  await page.fill('[data-qo-phone]', '');
  await page.keyboard.type('+380671234567');
  assert.equal(await page.inputValue('[data-qo-phone]'), '(67) 123 45 67');
  assert.equal(await page.getAttribute('[data-qo-submit]', 'aria-disabled'), 'false');
  assert.equal(await page.textContent('[data-qo-cta-hint]'), '');
  await shot('4-ready');

  // Відправка → екран успіху
  await page.click('[data-qo-submit]');
  assert.equal(await page.getAttribute('[data-qo-submit]', 'aria-busy'), 'true');
  await shot('5-loading');
  await page.waitForSelector('[data-qo-success-view]:not([hidden])');
  const order = await page.evaluate(() => window.__orders[0]);
  assert.equal(order.phone, '+380671234567');
  assert.equal(order.quantity, 2);
  assert.equal(order.variant_id, 1002 + 0); // Чорний / L
  assert.equal(order.page_url.endsWith('/products/futbolka-monoclo-volvo-fh16'), true);
  assert.match(await page.textContent('[data-qo-success-title]'), /Замовлення №20251005-213405 прийнято/);
  assert.equal(await page.isVisible('[data-qo-submit]'), false);
  assert.equal(await page.evaluate(() => window.__lastEvent.value), 1780);
  await shot('6-success');

  // Закриття повертає фокус, наступне відкриття — з чистою формою, імʼя запамʼятоване
  await page.click('.qo-success [data-qo-close]');
  await page.waitForFunction(() => !document.querySelector('[data-qo-dialog]').open);
  await open(page);
  assert.equal(await page.inputValue('[data-qo-name]'), 'Іван');
  assert.equal(await page.inputValue('[data-qo-phone]'), '(67) 123 45 67');
  assert.equal(await page.textContent('[data-qo-cta-hint]'), 'Оберіть колір');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('[data-qo-dialog]').open);

  assert.deepEqual(errors, []);
  await ctx.close();
}

await flow('desktop', { width: 1280, height: 820 });
await flow('mobile', { width: 390, height: 844 });

// Помилки відправки
for (const mode of ['network', 'soldout', 'invalid']) {
  const { page, ctx, shot, errors } = await session(`mobile-${mode}`, { width: 390, height: 844 }, `?mode=${mode}`);
  await open(page);
  await page.click('.qo-choice[data-qo-value="Чорний"]');
  await page.click('.qo-choice[data-qo-value="M"]');
  await page.fill('[data-qo-name]', 'Олена');
  await page.click('[data-qo-phone]');
  await page.keyboard.type('501112233');
  await page.click('[data-qo-submit]');
  await page.waitForSelector('[data-qo-error]:not([hidden])');
  const text = await page.textContent('[data-qo-error]');
  if (mode === 'network') assert.match(text, /Перевірте інтернет/);
  if (mode === 'soldout') {
    assert.match(text, /щойно закінчився/);
    assert.equal(await page.getAttribute('.qo-choice[data-qo-value="M"]', 'aria-checked'), 'false');
  }
  if (mode === 'invalid') assert.match(text, /правильний номер/);
  // Після помилки введені дані на місці, кнопку можна натиснути ще раз
  assert.equal(await page.inputValue('[data-qo-name]'), 'Олена');
  await shot('error');
  assert.deepEqual(errors.filter((e) => !/Failed to fetch|409|422/.test(e)), []);
  await ctx.close();
}

// Неробочий час
{
  const { page, ctx, shot } = await session('mobile-afterhours', { width: 390, height: 844 }, '?hours=off');
  await open(page);
  assert.equal(await page.isVisible('[data-qo-hours-note]'), true);
  assert.match(await page.textContent('[data-qo-hours-note]'), /з 10:00 до 20:00/);
  await shot('open');
  await ctx.close();
}

// Кнопка копіює вигляд кнопки теми і стоїть упритул до неї
for (const theme of ['pill', 'square']) {
  const { page, ctx, shot, errors } = await session(`theme-${theme}`, { width: 390, height: 844 }, theme === 'square' ? '?theme=square' : '');
  await page.waitForTimeout(1000);
  const m = await page.evaluate(() => {
    const css = (el) => getComputedStyle(el);
    const ref = document.querySelector('form[action="/cart/add"] button');
    const ours = document.querySelector('.qo-block .qo-trigger');
    const pay = document.getElementById('pay');
    const r = (el) => el.getBoundingClientRect();
    return {
      refRadius: css(ref).borderTopLeftRadius, ourRadius: css(ours).borderTopLeftRadius,
      refWeight: css(ref).fontWeight, ourWeight: css(ours).fontWeight,
      refSize: css(ref).fontSize, ourSize: css(ours).fontSize,
      refHeight: Math.round(r(ref).height), ourHeight: Math.round(r(ours).height),
      gapAbove: Math.round(r(ours).top - r(ref).bottom), gapBelow: Math.round(r(pay).top - r(ours).bottom),
    };
  });
  assert.equal(m.ourRadius, m.refRadius, theme + ' radius');
  assert.equal(m.ourWeight, m.refWeight, theme + ' weight');
  assert.equal(m.ourSize, m.refSize, theme + ' size');
  assert.equal(m.ourHeight, m.refHeight, theme + ' height');
  assert.ok(Math.abs(m.gapAbove - 12) <= 1, theme + ' gap above ' + m.gapAbove);
  assert.ok(Math.abs(m.gapBelow - 12) <= 1, theme + ' gap below ' + m.gapBelow);
  await shot('page');
  // Попап: кнопка «Замовити» теж у формі теми
  await open(page);
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('[data-qo-submit]')).borderTopLeftRadius),
    m.refRadius);
  await shot('popup');
  assert.deepEqual(errors, []);
  await ctx.close();
}

await browser.close();
console.log('E2E: усе пройшло. Скріншоти:', shots);
