import crypto from 'node:crypto';
import { verifyProxySignature } from './proxy-signature.js';
import { validateSubmission } from './validate.js';
import { RateLimiter } from './rate-limit.js';
import { RecentOrders, fingerprintOf } from './orders.js';
import { fetchProduct, optionPairs } from './shopify-product.js';
import { createTelegram } from './telegram.js';
import { formatDateTime, formatTime, isWorkingTime, orderNumber } from './hours.js';
import {
  applyStatus,
  buildOrderMessage,
  newOrderKeyboard,
  statusKeyboard,
} from './message.js';

const MAX_BODY_BYTES = 16 * 1024;
const PROXY_MAX_AGE_SEC = 10 * 60;

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

export function createApp({ config, fetchFn = fetch, now = () => new Date(), log = console }) {
  const telegram = createTelegram({
    token: config.telegramToken,
    chatId: config.telegramChatId,
    fetchFn,
  });
  const ipLimiter = new RateLimiter({ limit: 8, windowMs: 10 * 60 * 1000 });
  const phoneLimiter = new RateLimiter({ limit: 3, windowMs: 60 * 60 * 1000 });
  const recent = new RecentOrders();

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

    // 2. Ліміт за IP до будь-якої важкої роботи
    if (!ipLimiter.take(clientIp(req))) {
      throw new HttpError(429, 'rate_limited', 'Забагато спроб. Спробуйте трохи пізніше');
    }

    // 3. Валідація
    const parsed = validateSubmission(await readJson(req), { maxQty: config.maxQty });
    if (!parsed.ok) throw new HttpError(422, parsed.code, parsed.message, parsed.field);
    const input = parsed.value;

    // Спам-боти заповнюють приховане поле: вдаємо успіх, нічого не відправляємо
    if (input.honeypot) return { ok: true, order_number: orderNumber(now(), config.timezone) };

    // 4. Дубль (подвійний клік, ретрай після обриву)
    const keys = { clientId: input.clientId, fingerprint: fingerprintOf(input) };
    const duplicate = recent.find(keys);
    if (duplicate) return duplicate;

    if (!phoneLimiter.take(input.phone)) {
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

    // 6. Telegram
    const date = now();
    const number = orderNumber(date, config.timezone);
    const afterHours = !isWorkingTime(date, config);
    const productUrl = input.pageUrl || `${config.storeOrigin}/products/${product.handle}`;
    const text = buildOrderMessage({
      orderNumber: number,
      when: formatDateTime(date, config.timezone),
      afterHours,
      productTitle: product.title,
      options: optionPairs(product, variant),
      quantity: input.quantity,
      totalCents: variant.price * input.quantity,
      currency: config.currency || 'UAH',
      name: input.name,
      phone: input.phone,
      comment: input.comment,
    });
    try {
      await telegram.sendOrder(text, newOrderKeyboard(productUrl));
    } catch (err) {
      log.error('telegram send failed', err.message);
      throw new HttpError(502, 'upstream', 'Не вдалося відправити замовлення. Спробуйте ще раз');
    }

    const result = { ok: true, order_number: number, after_hours: afterHours };
    recent.save(keys, result);
    log.log(JSON.stringify({ event: 'order', number, variant: input.variantId, qty: input.quantity }));
    return result;
  }

  async function telegramWebhook(req) {
    if (!safeEqual(req.headers['x-telegram-bot-api-secret-token'] || '', config.telegramWebhookSecret)) {
      throw new HttpError(401, 'unauthorized', 'Unauthorized');
    }
    const query = (await readJson(req)).callback_query;
    if (!query?.message || String(query.message.chat?.id) !== telegram.chatId) return { ok: true };

    const match = /^st:(taken|spam|reset)$/.exec(query.data || '');
    if (!match) return { ok: true };
    const status = match[1];
    const actor = [query.from?.first_name, query.from?.last_name].filter(Boolean).join(' ')
      || query.from?.username || 'менеджер';

    const message = query.message;
    const next = applyStatus(
      { text: message.text || '', entities: message.entities },
      status,
      actor,
      formatTime(now(), config.timezone),
    );
    try {
      await telegram.editMessage({
        messageId: message.message_id,
        text: next.text,
        entities: next.entities,
        replyMarkup: statusKeyboard(status, message.reply_markup),
      });
      await telegram.answerCallback(query.id);
    } catch (err) {
      log.error('telegram callback failed', err.message);
      await telegram.answerCallback(query.id, 'Не вдалося оновити статус').catch(() => {});
    }
    return { ok: true };
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === 'GET' && url.pathname === '/healthz') return send(200, { ok: true });
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

  return { handle, telegram };
}
