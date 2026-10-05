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
  const { page, ctx, shot, errors } = await session(name, viewport, '?hour=12');
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

  // Виділена кнопка при наведенні курсора лишається контрастною
  await page.click('.qo-choice[data-qo-value="Чорний"]');
  await page.click('.qo-choice[data-qo-value="S"]');
  await page.hover('.qo-choice[data-qo-value="S"]');
  await page.waitForTimeout(350);
  const hovered = await page.evaluate(() => {
    const cs = getComputedStyle(document.querySelector('.qo-choice[data-qo-value="S"]'));
    return [cs.backgroundColor, cs.color];
  });
  assert.notEqual(hovered[0], hovered[1], 'виділена кнопка не має зливатися при hover');
  assert.equal(hovered[0], 'rgb(0, 0, 0)');

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
  await page.fill('[data-qo-city]', 'Львів');
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
  assert.equal(order.city, 'Львів');
  assert.equal(order.variant_id, 1002 + 0); // Чорний / L
  assert.equal(order.page_url.endsWith('/products/futbolka-monoclo-volvo-fh16'), true);
  assert.match(await page.textContent('[data-qo-success-title]'), /Замовлення №20251005-213405 прийнято/);
  assert.equal(await page.isVisible('[data-qo-submit]'), false);
  // Після замовлення: кнопка «Написати нам у Telegram» магазину
  const tg = page.locator('[data-qo-telegram]');
  assert.equal(await tg.isVisible(), true);
  assert.equal(await tg.getAttribute('href'), 'https://t.me/monoclo_store_bot?start=site');
  assert.equal(await tg.getAttribute('target'), '_blank');
  assert.match(await page.textContent('.qo-note--contact'), /особистий кабінет MONOCLO у Telegram: замовлення, звʼязок із менеджером/);
  assert.equal((await tg.textContent()).trim(), 'Відкрити кабінет у Telegram');
  assert.doesNotMatch(await page.textContent('[data-qo-success-view]'), /Напишіть нам/);
  assert.equal(await page.evaluate(() => window.__lastEvent.value), 1780);
  // Аналітика: GA4 generate_lead, Meta Pixel Lead, dataLayer
  const ga = await page.evaluate(() => window.__ga);
  assert.equal(ga[0][0], 'event');
  assert.equal(ga[0][1], 'generate_lead');
  assert.equal(ga[0][2].value, 1780);
  assert.equal(ga[0][2].transaction_id, '20251005-213405');
  assert.equal(ga[0][2].items[0].item_id, 'TEE-Чо-L');
  const fb = await page.evaluate(() => window.__fb);
  assert.deepEqual(fb[0].slice(0, 2), ['track', 'Lead']);
  assert.equal(fb[0][2].value, 1780);
  assert.equal(fb[0][3].eventID, '20251005-213405');
  assert.equal(await page.evaluate(() => window.dataLayer[0].event), 'quick_order');
  await shot('6-success');

  // Закриття повертає фокус, наступне відкриття — з чистою формою, імʼя запамʼятоване
  await page.click('.qo-success [data-qo-close]');
  await page.waitForFunction(() => !document.querySelector('[data-qo-dialog]').open);
  await open(page);
  assert.equal(await page.inputValue('[data-qo-name]'), 'Іван');
  assert.equal(await page.inputValue('[data-qo-city]'), 'Львів');
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

// Тема за часом: світла до 17:00, темна після (до 06:00)
for (const [hour, expected] of [[5, 'dark'], [6, 'light'], [12, 'light'], [16, 'light'], [17, 'dark'], [23, 'dark']]) {
  const { page, ctx, shot } = await session(`mobile-theme-${hour}`, { width: 390, height: 844 }, `?hour=${hour}`);
  await open(page);
  assert.equal(await page.getAttribute('[data-qo-dialog]', 'data-theme'), expected, `hour ${hour}`);
  if (hour === 12 || hour === 17) await shot('popup');
  if (hour === 17) {
    // Темна тема: фон і CTA інвертовані
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.qo-sheet')).backgroundColor), 'rgb(20, 20, 20)');
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('[data-qo-submit]')).backgroundColor), 'rgb(242, 242, 242)');
    await page.click('.qo-choice[data-qo-value="Чорний"]');
    await page.click('.qo-choice[data-qo-value="M"]');
    await shot('popup-selected');
  }
  await ctx.close();
}
{
  // Режими «завжди»: перевіряємо вибір теми чистою функцією
  const { page, ctx } = await session('theme-fn', { width: 390, height: 844 }, '?hour=12');
  await open(page);
  const r = await page.evaluate(() => {
    const f = window.QuickOrder._test.pickTheme;
    return [f('light', 22, 17, 6), f('dark', 12, 17, 6), f('time', 3, 17, 6), f('time', 18, 17, 6), f('time', 9, 22, 8), f('time', 23, 22, 8), f('time', 5, 22, 8)];
  });
  assert.deepEqual(r, ['light', 'dark', 'dark', 'dark', 'light', 'dark', 'dark']);
  await ctx.close();
}

// UTM: мітки з посилання запамʼятовуються і йдуть у замовлення на інших сторінках
{
  const { page, ctx } = await session('utm', { width: 390, height: 844 },
    '?hour=12&utm_source=facebook&utm_medium=cpc&utm_campaign=autumn&fbclid=abc');
  await page.goto(page_url('?hour=12')); // «наступна сторінка» без міток
  await open(page);
  await page.click('.qo-choice[data-qo-value="Чорний"]');
  await page.click('.qo-choice[data-qo-value="M"]');
  await page.fill('[data-qo-name]', 'Олена');
  await page.click('[data-qo-phone]');
  await page.keyboard.type('501112233');
  await page.click('[data-qo-submit]');
  await page.waitForSelector('[data-qo-success-view]:not([hidden])');
  const sent = await page.evaluate(() => window.__orders[0]);
  assert.deepEqual(sent.utm, { source: 'facebook', medium: 'cpc', campaign: 'autumn' });
  assert.equal(sent.click, 'fbclid');
  await ctx.close();
}

// Анімація кнопки: зʼявляється через ~8 с, зникає після дотику
{
  const { page, ctx } = await session('nudge', { width: 390, height: 844 }, '?hour=12');
  await page.waitForSelector('.qo-trigger.is-nudging', { timeout: 12000 });
  await page.hover('.qo-block .qo-trigger');
  await page.waitForFunction(() => !document.querySelector('.qo-trigger.is-nudging'));
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
