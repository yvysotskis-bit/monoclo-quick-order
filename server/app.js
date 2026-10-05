import crypto from 'node:crypto';
import { verifyProxySignature } from './proxy-signature.js';
import { validateSubmission } from './validate.js';
import { fetchProduct, optionPairs } from './shopify-product.js';
import { createTelegram } from './telegram.js';
import { createKeycrm } from './keycrm.js';
import {
  dateKey,
  effectiveStart,
  formatDateTime,
  formatTime,
  hourOf,
  isWorkingTime,
  isoWeekday,
  orderNumber,
} from './hours.js';
import {
  STATUS_KEYS,
  applyStatus,
  buildOrderMessage,
  buildReminder,
  newOrderKeyboard,
  viberLink,
  statusKeyboard,
} from './message.js';
import { buildWeeklyReport } from './report.js';

const MAX_BODY_BYTES = 16 * 1024;
const PROXY_MAX_AGE_SEC = 10 * 60;
const DUPLICATE_WINDOW_MS = 5 * 60 * 1000;
const STUCK_ALERT_SEC = 10 * 60;
const STATUS_ACTION = new RegExp(`^st:(${[...STATUS_KEYS, 'reset'].join('|')})$`);

class HttpError extends Error {
  constructor(status, code, message, field) {
    super(message);
    Object.assign(this, { status, code, field });
  }
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'too_large', 'Запит завеликий');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, 'bad_request', 'Некоректний запит');
  }
}

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  return (typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : '') || req.socket.remoteAddress || 'unknown';
}

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

const fingerprintOf = ({ phone, variantId, quantity }) => `${phone}|${variantId}|${quantity}`;

export function createApp({ config, store, fetchFn = fetch, now = () => new Date(), log = console }) {
  const telegram = createTelegram({
    token: config.telegramToken,
    chatId: config.telegramChatId,
    fetchFn,
  });
  const keycrm = config.keycrmToken
    ? createKeycrm({
      token: config.keycrmToken,
      sourceId: config.keycrmSourceId,
      statusMap: config.keycrmStatusMap,
      fetchFn,
    })
    : null;

  // Замовлення, які зараз відправляються: щоб фонова черга не дублювала їх
  const inFlight = new Set();
  const once = (key, id, fn) => {
    const token = `${key}:${id}`;
    if (inFlight.has(token)) return Promise.resolve(false);
    inFlight.add(token);
    return fn().finally(() => inFlight.delete(token));
  };

  /* ---------- Доставка ---------- */

  function deliverTelegram(order) {
    return once('tg', order.id, async () => {
      const d = order.data;
      const delayed = now().getTime() - order.created_at > 2 * 60_000;
      const text = buildOrderMessage({
        ...d,
        orderNumber: order.order_number,
        when: formatDateTime(new Date(order.created_at), config.timezone),
        delayed,
      });
      try {
        const message = await telegram.sendOrder(text, newOrderKeyboard(d.productUrl, d.phone, config.publicUrl));
        store.markTelegramSent(order.id, message?.message_id ?? null);
        return true;
      } catch (err) {
        log.error('telegram send failed', err.message);
        store.markTelegramFailed(order.id, err.message, now().getTime());
        return false;
      }
    });
  }

  function deliverCrm(order) {
    return once('crm', order.id, async () => {
      if (!keycrm) {
        store.markCrmSkipped(order.id);
        return false;
      }
      try {
        const crmId = await keycrm.createOrder(order);
        store.markCrmSent(order.id, crmId);
        // Якщо менеджер уже встиг змінити статус у Telegram, підтягуємо його в CRM
        const fresh = store.getOrder(order.id);
        if (fresh.status !== 'new') await keycrm.updateStatus(crmId, fresh.status).catch((e) => log.error('keycrm status', e.message));
        return true;
      } catch (err) {
        log.error('keycrm create failed', err.message);
        const gaveUp = store.markCrmFailed(order.id, err.message, now().getTime());
        if (gaveUp) {
          await telegram
            .sendText(`⚠️ Не вдалося передати замовлення #${order.order_number} у KeyCRM. Додайте його вручну.`, { replyTo: order.tg_message_id || undefined })
            .catch(() => {});
        }
        return false;
      }
    });
  }

  /* ---------- Приймання замовлення ---------- */

  async function submit(req, url) {
    // 1. Запит має прийти через App Proxy свого магазину
    if (!verifyProxySignature(url.searchParams, config.apiSecret)) {
      // Без самого секрету: лише те, що допомагає знайти причину
      log.error('bad proxy signature', JSON.stringify({
        hasSignature: url.searchParams.has('signature'),
        params: [...new Set(url.searchParams.keys())],
        secretLength: config.apiSecret.length,
        secretPrefix: config.apiSecret.slice(0, 3),
      }));
      throw new HttpError(401, 'unauthorized', 'Недійсний підпис');
    }
    const age = Math.abs(Date.now() / 1000 - Number(url.searchParams.get('timestamp')));
    if (!(age <= PROXY_MAX_AGE_SEC)) throw new HttpError(401, 'unauthorized', 'Запит застарів');
    if (url.searchParams.get('shop') !== config.shop) {
      throw new HttpError(403, 'forbidden', 'Магазин не підтримується');
    }

    const date = now();
    const nowMs = date.getTime();

    // 2. Ліміт за IP до будь-якої важкої роботи
    if (!store.takeHit(`ip:${clientIp(req)}`, 8, 10 * 60_000, nowMs)) {
      throw new HttpError(429, 'rate_limited', 'Забагато спроб. Спробуйте трохи пізніше');
    }

    // 3. Валідація
    const parsed = validateSubmission(await readJson(req), { maxQty: config.maxQty });
    if (!parsed.ok) throw new HttpError(422, parsed.code, parsed.message, parsed.field);
    const input = parsed.value;

    // Спам-боти заповнюють приховане поле: вдаємо успіх, нічого не зберігаємо
    if (input.honeypot) return { ok: true, order_number: orderNumber(date, config.timezone) };

    // 4. Дубль (подвійний клік, ретрай після обриву)
    const fingerprint = fingerprintOf(input);
    const duplicate = store.findDuplicate({
      clientId: input.clientId,
      fingerprint,
      since: nowMs - DUPLICATE_WINDOW_MS,
    });
    if (duplicate) {
      return { ok: true, order_number: duplicate.order_number, after_hours: duplicate.data.afterHours };
    }

    if (!store.takeHit(`phone:${input.phone}`, 3, 60 * 60_000, nowMs)) {
      throw new HttpError(429, 'rate_limited', 'Забагато замовлень з цього номера. Спробуйте пізніше');
    }

    // 5. Ціна й наявність беремо з магазину, а не з форми
    let product;
    try {
      product = await fetchProduct({ fetchFn, origin: config.storeOrigin, handle: input.handle });
    } catch (err) {
      log.error('product fetch failed', err.message);
      throw new HttpError(502, 'upstream', 'Не вдалося перевірити товар. Спробуйте ще раз');
    }
    if (!product) throw new HttpError(404, 'product_not_found', 'Товар не знайдено');
    const variant = (product.variants || []).find((v) => String(v.id) === input.variantId);
    if (!variant) throw new HttpError(422, 'variant', 'Цей варіант не знайдено', 'variant');
    if (!variant.available) {
      throw new HttpError(409, 'sold_out', 'На жаль, цей варіант щойно закінчився', 'variant');
    }

    // 6. Спершу зберігаємо: з цього моменту замовлення не загубиться, навіть якщо Telegram або CRM недоступні
    const afterHours = !isWorkingTime(date, config);
    const order = store.insertOrder({
      orderNumber: orderNumber(date, config.timezone),
      clientId: input.clientId,
      fingerprint,
      createdAt: nowMs,
      data: {
        productTitle: product.title,
        productHandle: product.handle,
        productUrl: input.pageUrl || `${config.storeOrigin}/products/${product.handle}`,
        variantId: String(variant.id),
        sku: variant.sku || '',
        picture: variant.featured_image?.src || product.featured_image || '',
        options: optionPairs(product, variant),
        quantity: input.quantity,
        unitCents: variant.price,
        totalCents: variant.price * input.quantity,
        currency: config.currency,
        name: input.name,
        phone: input.phone,
        city: input.city,
        comment: input.comment,
        utm: input.utm,
        referrer: input.referrer,
        click: input.click,
        afterHours,
      },
    });

    // 7. Спроба доставити одразу; якщо не вийде, фонова черга повторить
    await Promise.allSettled([deliverTelegram(order), deliverCrm(order)]);
    log.log(JSON.stringify({ event: 'order', number: order.order_number, variant: input.variantId, qty: input.quantity }));
    return { ok: true, order_number: order.order_number, after_hours: afterHours };
  }

  /* ---------- Статуси з Telegram ---------- */

  async function telegramWebhook(req) {
    if (!safeEqual(req.headers['x-telegram-bot-api-secret-token'] || '', config.telegramWebhookSecret)) {
      throw new HttpError(401, 'unauthorized', 'Unauthorized');
    }
    const query = (await readJson(req)).callback_query;
    if (!query?.message || String(query.message.chat?.id) !== telegram.chatId) return { ok: true };

    const match = STATUS_ACTION.exec(query.data || '');
    if (!match) return { ok: true };
    const action = match[1];
    const actor = [query.from?.first_name, query.from?.last_name].filter(Boolean).join(' ')
      || query.from?.username || 'менеджер';
    const date = now();
    const message = query.message;

    const order = store.findByMessageId(message.message_id);
    const status = action === 'reset' ? 'new' : action;
    if (order) {
      store.setStatus(order.id, status, actor, date.getTime());
      if (keycrm && order.crm_order_id) {
        await keycrm.updateStatus(order.crm_order_id, status).catch((e) => log.error('keycrm status', e.message));
      }
    }

    const next = applyStatus(
      { text: message.text || '', entities: message.entities },
      action,
      actor,
      formatTime(date, config.timezone),
    );
    try {
      await telegram.editMessage({
        messageId: message.message_id,
        text: next.text,
        entities: next.entities,
        replyMarkup: statusKeyboard(action, message.reply_markup),
      });
      await telegram.answerCallback(query.id);
    } catch (err) {
      log.error('telegram callback failed', err.message);
      await telegram.answerCallback(query.id, 'Не вдалося оновити статус').catch(() => {});
    }
    return { ok: true };
  }

  /* ---------- Фонова робота ---------- */

  async function sendReminders(date) {
    const nowMs = date.getTime();
    if (!isWorkingTime(date, config)) return;
    for (const order of store.reminderCandidates(config.reminderMax)) {
      const start = effectiveStart(order.created_at, config);
      const due = start + (config.reminderMinutes + order.reminders * config.reminderRepeatMinutes) * 60_000;
      if (nowMs < due) continue;
      const waiting = Math.round((nowMs - start) / 60_000);
      try {
        await telegram.sendText(buildReminder(order.order_number, waiting), { replyTo: order.tg_message_id || undefined });
        store.markReminded(order.id, nowMs);
      } catch (err) {
        log.error('reminder failed', err.message);
      }
    }
  }

  async function sendWeeklyReport(date) {
    if (isoWeekday(date, config.timezone) !== config.reportDay) return;
    if (hourOf(date, config.timezone) < config.reportHour) return;
    const key = dateKey(date, config.timezone);
    if (store.getMeta('last_report') === key) return;
    const to = date.getTime();
    const from = to - 7 * 24 * 3600e3;
    const text = buildWeeklyReport(store.ordersSince(from), {
      from,
      to,
      timezone: config.timezone,
      currency: config.currency,
    });
    try {
      await telegram.sendText(text);
      store.setMeta('last_report', key);
    } catch (err) {
      log.error('weekly report failed', err.message);
    }
  }

  // Викликається періодично: повторні відправки, нагадування, тижневий звіт
  async function tick() {
    const date = now();
    for (const order of store.telegramDue(date.getTime())) await deliverTelegram(order);
    for (const order of store.crmDue(date.getTime())) await deliverCrm(order);
    await sendReminders(date);
    await sendWeeklyReport(date);
  }

  /* ---------- HTTP ---------- */

  function status() {
    try {
      store.ping();
    } catch (err) {
      return { code: 503, body: { ok: false, db: false, error: err.message } };
    }
    const nowMs = now().getTime();
    const counts = store.counts();
    const oldest = store.oldestPendingTelegram();
    const stuckSeconds = oldest ? Math.round((nowMs - oldest) / 1000) : 0;
    // 503, якщо замовлення застрягло в черзі: моніторинг одразу сповістить
    const ok = stuckSeconds < STUCK_ALERT_SEC;
    return { code: ok ? 200 : 503, body: { ok, db: true, ...counts, stuck_seconds: stuckSeconds } };
  }

  // Сторінка-перехідник: Telegram дозволяє лише https-посилання, а вона відкриває Viber
  function viberPage(digits) {
    const link = viberLink(digits);
    return `<!doctype html>
<html lang="uk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Відкриваємо Viber</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font:16px/1.5 -apple-system,Segoe UI,Arial,sans-serif;background:#fff;color:#111;text-align:center}
main{padding:24px;max-width:360px}a.b{display:block;margin:20px 0 12px;padding:16px;border-radius:999px;background:#111;color:#fff;text-decoration:none;font-weight:600}
p{margin:8px 0;color:#555}</style></head>
<body><main><h1 style="font-size:20px">Відкриваємо Viber…</h1>
<a class="b" href="${link}">Відкрити чат у Viber</a>
<p>Якщо Viber не відкрився, натисніть кнопку вище.</p>
<p>Номер клієнта: <b>+${digits}</b></p></main>
<script>setTimeout(function(){location.href=${JSON.stringify(link)};},150);</script></body></html>`;
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const send = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === 'GET' && url.pathname === '/healthz') return send(200, { ok: true });
      const viber = req.method === 'GET' && /^\/viber\/(\d{8,15})$/.exec(url.pathname);
      if (viber) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(viberPage(viber[1]));
      }
      if (req.method === 'GET' && url.pathname === '/status') {
        const { code, body } = status();
        return send(code, body);
      }
      if (req.method === 'POST' && url.pathname === '/proxy/submit') return send(200, await submit(req, url));
      if (req.method === 'POST' && url.pathname === '/telegram/webhook') return send(200, await telegramWebhook(req));
      return send(404, { ok: false, code: 'not_found' });
    } catch (err) {
      if (err instanceof HttpError) {
        return send(err.status, { ok: false, code: err.code, message: err.message, field: err.field });
      }
      log.error('unhandled', err);
      return send(500, { ok: false, code: 'internal', message: 'Щось пішло не так. Спробуйте ще раз' });
    }
  }

  return { handle, tick, telegram, keycrm };
}
