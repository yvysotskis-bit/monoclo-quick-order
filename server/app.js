import crypto from 'node:crypto';
import { verifyProxySignature } from './proxy-signature.js';
import { validateSubmission } from './validate.js';
import { fetchProduct, optionPairs } from './shopify-product.js';
import { createTelegram } from './telegram.js';
import { createBackup } from './backup.js';
import { createKeycrm } from './keycrm.js';
import { createNovaPoshta } from './novaposhta.js';
import { createTtnService } from './ttn.js';
import { createMonobank } from './monobank.js';
import { createConversions } from './conversions.js';
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
  buildAmountPrompt,
  buildPaidMessage,
  buildTtnMessage,
  describeDelivery,
  buildTtnFailedMessage,
  ttnKeyboard,
  ttnNoCodKeyboard,
  ttnSenderPaysKeyboard,
  buildPayFailedMessage,
  buildReversedMessage,
  buildPartialRefundMessage,
  buildAmountMismatchMessage,
  buildPaymentMessage,
  parseAmountKopecks,
  PAYMENT_KIND,
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
const PROMPT_TTL_MS = 30 * 60 * 1000;
const STATUS_ACTION = new RegExp(`^st:(${[...STATUS_KEYS, 'reset'].join('|')})$`);

class HttpError extends Error {
  constructor(status, code, message, field) {
    super(message);
    Object.assign(this, { status, code, field });
  }
}

async function readBuffer(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'too_large', 'Запит завеликий');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readBody(req) {
  return (await readBuffer(req)).toString('utf8');
}

async function readJson(req) {
  try {
    return JSON.parse((await readBody(req)) || '{}');
  } catch (err) {
    if (err instanceof HttpError) throw err;
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
  const backup = createBackup({ config, store, telegram, fetchFn, now, log });
  const keycrm = config.keycrmToken
    ? createKeycrm({
      token: config.keycrmToken,
      sourceId: config.keycrmSourceId,
      statusMap: config.keycrmStatusMap,
      deliveryServiceId: config.keycrmNovaPoshtaServiceId,
      fetchFn,
    })
    : null;
  const novaPoshta = config.novaPoshtaApiKey
    ? createNovaPoshta({ apiKey: config.novaPoshtaApiKey, fetchFn })
    : null;

  const ttnService = novaPoshta ? createTtnService({ np: novaPoshta, config, store, now }) : null;
  const conversions = createConversions({ config, store, keycrm, fetchFn, now, log, notify: (text) => telegram.sendText(text) });

  // Передоплата працює, лише коли є токен Monobank і публічна адреса сервера (для вебхука)
  const monobank = config.monobankToken && config.publicUrl
    ? createMonobank({ token: config.monobankToken, fetchFn })
    : null;
  // Що показувати на кнопках оплати для конкретного замовлення
  const payInfo = (order) => {
    if (!monobank) return null;
    const paidCents = store.paidTotal(order.id);
    return {
      prepayUah: config.prepayAmountUah,
      paidCents,
      remainingCents: Math.max(order.data.totalCents - paidCents, 0),
    };
  };

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
        const message = await telegram.sendOrder(text, newOrderKeyboard(d.productUrl, d.phone, config.publicUrl, payInfo(order)));
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
        // (якщо оновлення не вдасться, його підхопить syncStatuses у фоновій черзі)
        await syncStatuses();
        const fresh = store.getOrder(order.id);
        for (const payment of store.paymentsForOrder(order.id)) {
          if (payment.status === 'success' && !payment.crm_synced) await syncCrmPayment(payment, { ...fresh, crm_order_id: crmId });
        }
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

  // Оплата, що вже надійшла, фіксується в замовленні KeyCRM (якщо вказано спосіб оплати)
  // Платіж потрапляє в KeyCRM рівно один раз: вебхук і фонова черга не працюють одночасно, а перед додаванням
  // перевіряється, чи такого платежу (за номером рахунку в описі) там уже немає, наприклад, якщо відповідь KeyCRM загубилась.
  function syncCrmPayment(payment, order) {
    if (!keycrm || !config.keycrmPaymentMethodId || !order.crm_order_id) return Promise.resolve(false);
    return once('crm-pay', payment.id, async () => {
      if (store.getPayment(payment.id)?.crm_synced) return true;
      try {
        if (!(await keycrm.hasPayment(order.crm_order_id, payment.invoice_id))) {
          await keycrm.addPayment(order.crm_order_id, {
            methodId: config.keycrmPaymentMethodId,
            amountUah: payment.amount / 100,
            description: `${PAYMENT_KIND[payment.kind] || 'Оплата'} Monobank, рахунок ${payment.invoice_id}`,
          });
        }
        store.markPaymentSynced(payment.id);
        return true;
      } catch (err) {
        log.error('keycrm payment failed', err.message);
        return false;
      }
    });
  }

  // Статус замовлення в KeyCRM доганяє наш: збій окремого оновлення не губить зміну назавжди
  async function syncStatuses() {
    if (!keycrm) return;
    for (const order of store.statusDrift()) {
      try {
        if (keycrm.statusMap[order.status]) await keycrm.updateStatus(order.crm_order_id, order.status);
        store.markCrmStatus(order.id, order.status);
      } catch (err) {
        log.error('keycrm status', err.message);
        break;
      }
    }
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
    // Ліміт щедрий: якщо Shopify передає одну й ту саму адресу для всіх, 8 замовлень за 10 хвилин на весь магазин блокували б людей.
    // Основний захист від спаму: підпис проксі, honeypot і ліміт за номером.
    if (!store.takeHit(`ip:${clientIp(req)}`, 30, 10 * 60_000, nowMs)) {
      log.error('rate limited by ip', clientIp(req));
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

    // Під час перевірки товару могла надійти така сама заявка (подвійний клік): після await дивимось ще раз,
    // між цією перевіркою і записом у базу немає жодного await
    const raced = store.findDuplicate({ clientId: input.clientId, fingerprint, since: nowMs - DUPLICATE_WINDOW_MS });
    if (raced) return { ok: true, order_number: raced.order_number, after_hours: raced.data.afterHours };
    // Ліміт за номером рахуємо лише для замовлень, які справді дійшли до збереження
    if (!store.takeHit(`phone:${input.phone}`, 3, 60 * 60_000, nowMs)) {
      throw new HttpError(429, 'rate_limited', 'Забагато замовлень з цього номера. Спробуйте пізніше');
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
        productId: product.id ? String(product.id) : '',
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
        surname: input.surname,
        body: input.body,
        phone: input.phone,
        city: input.city,
        delivery: input.delivery,
        comment: input.comment,
        utm: input.utm,
        referrer: input.referrer,
        click: input.click,
        ads: input.ads,
        afterHours,
      },
    });

    // 7. Спроба доставити одразу; якщо не вийде, фонова черга повторить
    await Promise.allSettled([deliverTelegram(order), deliverCrm(order)]);
    log.log(JSON.stringify({ event: 'order', number: order.order_number, variant: input.variantId, qty: input.quantity }));
    return { ok: true, order_number: order.order_number, after_hours: afterHours };
  }

  /* ---------- Статуси з Telegram ---------- */

  // Telegram може доставити той самий апдейт двічі (повтор після повільної відповіді): друга копія ігнорується
  const seenUpdates = new Set();

  async function telegramWebhook(req) {
    if (!safeEqual(req.headers['x-telegram-bot-api-secret-token'] || '', config.telegramWebhookSecret)) {
      throw new HttpError(401, 'unauthorized', 'Unauthorized');
    }
    const update = await readJson(req);
    if (update.update_id != null) {
      if (seenUpdates.has(update.update_id)) return { ok: true };
      seenUpdates.add(update.update_id);
      if (seenUpdates.size > 500) seenUpdates.delete(seenUpdates.values().next().value);
    }
    // Збій обробки не повертаємо як 5xx: Telegram тоді повторював би апдейт (і дії) знову й знову
    try {
      return await handleTelegramUpdate(update);
    } catch (err) {
      log.error('telegram update failed', err.message);
      return { ok: true };
    }
  }

  async function handleTelegramUpdate(update) {
    // Відповідь менеджера на прохання ввести суму
    if (update.message) return amountReply(update.message);

    const query = update.callback_query;
    if (!query?.message || String(query.message.chat?.id) !== telegram.chatId) return { ok: true };

    if (query.data === 'pay:link') return paymentLink(query, 'prepay');
    if (query.data === 'pay:full') return paymentLink(query, 'full');
    if (query.data === 'pay:custom') return customAmountPrompt(query);
    if (/^ttn0?:\d+(:s)?$/.test(query.data || '')) return createTtn(query);

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
      await syncStatuses();
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
        replyMarkup: statusKeyboard(action, message.reply_markup, order ? payInfo(order) : null),
      });
      await telegram.answerCallback(query.id);
    } catch (err) {
      log.error('telegram callback failed', err.message);
      await telegram.answerCallback(query.id, 'Не вдалося оновити статус').catch(() => {});
    }
    return { ok: true };
  }

  /* ---------- Оплата (Monobank) ---------- */

  const actorName = (from) => [from?.first_name, from?.last_name].filter(Boolean).join(' ') || from?.username || 'менеджер';

  // Створює рахунок (або повертає чинний на ту саму суму). Неоплачені рахунки з іншою сумою закриваються,
  // щоб клієнт не заплатив за двома посиланнями.
  async function issuePayment({ order, amount, kind, actor }) {
    const nowMs = now().getTime();
    const active = store.activePayments(order.id, nowMs - config.payValiditySeconds * 1000);
    const same = active.find((p) => p.amount === amount);
    if (same) return { payment: same, reused: true };

    for (const old of active) {
      try {
        await monobank.removeInvoice(old.invoice_id);
        store.setPaymentStatus(old.id, 'removed');
      } catch (err) {
        log.error('remove invoice failed', err.message);
      }
    }
    const count = store.paymentsForOrder(order.id).length;
    const invoice = await monobank.createInvoice({
      amount,
      reference: count ? `${order.order_number}-${count + 1}` : order.order_number,
      destination: `${kind === 'prepay' ? 'Передоплата за' : 'Оплата'} замовлення №${order.order_number}`,
      redirectUrl: config.storeOrigin,
      webHookUrl: `${config.publicUrl}/mono/webhook`,
      validity: config.payValiditySeconds,
    });
    const id = store.insertPayment({
      orderId: order.id, invoiceId: invoice.invoiceId, amount, kind, url: invoice.pageUrl, createdBy: actor, createdAt: nowMs,
    });
    return { payment: store.getPayment(id), reused: false };
  }

  function postPaymentLink(order, payment, replyTo) {
    return telegram.sendText(buildPaymentMessage({
      orderNumber: order.order_number,
      amountCents: payment.amount,
      kind: payment.kind,
      url: payment.url,
      hours: config.payValiditySeconds / 3600,
      createdBy: payment.created_by,
      totalCents: order.data.totalCents,
      paidCents: store.paidTotal(order.id),
    }), { replyTo });
  }

  // Кнопки «💳 Передоплата» і «💳 Повна сума / Залишок»
  async function paymentLink(query, kind) {
    const message = query.message;
    const answer = (text) => telegram.answerCallback(query.id, text).catch(() => {});
    const order = store.findByMessageId(message.message_id);
    if (!monobank) { await answer('Оплата не налаштована'); return { ok: true }; }
    if (!order) { await answer('Замовлення не знайдено'); return { ok: true }; }

    const total = order.data.totalCents;
    const paid = store.paidTotal(order.id);
    let amount;
    if (kind === 'prepay') {
      amount = Math.min(config.prepayAmountUah * 100, total);
      if (paid >= amount) { await answer('Передоплата вже отримана'); return { ok: true }; }
    } else {
      amount = total - paid;
      if (amount <= 0) { await answer('Замовлення вже оплачено повністю'); return { ok: true }; }
    }

    try {
      // Одночасні натискання не створюють кілька рахунків: другий чекає на перший не буде, а отримає відмову
      const issued = await once('pay', order.id, () => issuePayment({ order, amount, kind, actor: actorName(query.from) }));
      if (!issued) { await answer('Посилання вже створюється, зачекайте секунду'); return { ok: true }; }
      await postPaymentLink(order, issued.payment, message.message_id);
      await answer(issued.reused ? 'Посилання вже було, надіслав ще раз' : 'Посилання створено');
    } catch (err) {
      log.error('payment link failed', err.message);
      await answer('Не вдалося створити посилання. Спробуйте ще раз');
    }
    return { ok: true };
  }

  // Кнопка «✏️ Інша сума»: бот просить менеджера відповісти сумою
  async function customAmountPrompt(query) {
    const message = query.message;
    const answer = (text) => telegram.answerCallback(query.id, text).catch(() => {});
    const order = store.findByMessageId(message.message_id);
    if (!monobank) { await answer('Оплата не налаштована'); return { ok: true }; }
    if (!order) { await answer('Замовлення не знайдено'); return { ok: true }; }
    try {
      const sent = await telegram.sendPrompt(buildAmountPrompt({
        orderNumber: order.order_number,
        userId: query.from?.id,
        userName: actorName(query.from),
        maxUah: config.payMaxAmountUah,
      }), { replyTo: message.message_id });
      store.insertPrompt({
        messageId: sent.message_id, orderId: order.id, userId: query.from?.id, createdAt: now().getTime(),
      });
      await answer('Введіть суму у відповідь на нове повідомлення');
    } catch (err) {
      log.error('amount prompt failed', err.message);
      await answer('Не вдалося. Спробуйте ще раз');
    }
    return { ok: true };
  }

  // Менеджер відповів на прохання числом: створюємо рахунок на цю суму
  async function amountReply(message) {
    if (!monobank || String(message.chat?.id) !== telegram.chatId || !message.reply_to_message) return { ok: true };
    const prompt = store.findPrompt(message.reply_to_message.message_id);
    if (!prompt) return { ok: true };

    const reply = (text) => telegram.sendText(text, { replyTo: message.message_id }).catch((e) => log.error('reply failed', e.message));
    const nowMs = now().getTime();
    if (nowMs - prompt.created_at > PROMPT_TTL_MS) {
      store.deletePrompt(prompt.message_id);
      await reply('Запит застарів. Натисніть «✏️ Інша сума» ще раз.');
      return { ok: true };
    }

    const amount = parseAmountKopecks(message.text);
    if (!amount) {
      await reply('Не вдалося розпізнати суму. Введіть число в гривнях, наприклад 1500 або 1499.50.');
      return { ok: true };
    }
    if (amount > config.payMaxAmountUah * 100) {
      await reply(`Сума завелика. Максимум ${config.payMaxAmountUah} ₴.`);
      return { ok: true };
    }

    const order = store.getOrder(prompt.order_id);
    if (!order) return { ok: true };
    try {
      const issued = await once('pay', order.id, () => issuePayment({ order, amount, kind: 'custom', actor: actorName(message.from) }));
      if (!issued) { await reply('Посилання вже створюється, зачекайте секунду і спробуйте ще раз.'); return { ok: true }; }
      store.deletePrompt(prompt.message_id);
      await postPaymentLink(order, issued.payment, order.tg_message_id || message.message_id);
    } catch (err) {
      log.error('custom payment failed', err.message);
      await reply('Не вдалося створити посилання. Спробуйте ще раз.');
    }
    return { ok: true };
  }

  /* ---------- ТТН Нової пошти ---------- */

  // Номер ТТН у KeyCRM: якщо з першого разу не вдалось, фонова черга дописує його пізніше
  async function syncTtnToCrm(orderId) {
    const order = store.getOrder(orderId);
    if (!keycrm || !order?.crm_order_id || !order.ttn_number) return false;
    try {
      await keycrm.setTrackingCode(order.crm_order_id, order.ttn_number);
      store.markTtnInCrm(order.id);
      return true;
    } catch (err) {
      log.error('keycrm tracking', err.message);
      return false;
    }
  }

  async function createTtn(query) {
    const message = query.message;
    const answer = (text) => telegram.answerCallback(query.id, text).catch(() => {});
    const noCod = query.data.startsWith('ttn0:');
    const senderPays = query.data.endsWith(':s');
    const order = store.getOrder(Number(query.data.slice(query.data.indexOf(':') + 1).replace(/:s$/, '')));
    if (!ttnService) { await answer('Нова пошта не налаштована'); return { ok: true }; }
    if (!order) { await answer('Замовлення не знайдено'); return { ok: true }; }
    if (order.ttn_number) { await answer(`ТТН уже створено: ${order.ttn_number}`); return { ok: true }; }

    const ran = await once('ttn', order.id, async () => {
      // Поки чекали на чергу, ТТН могли створити в іншому запиті
      if (store.getOrder(order.id).ttn_number) { await answer('ТТН уже створено'); return true; }
      const replyTo = order.tg_message_id || message.message_id;
      let ttn;
      try {
        ttn = await ttnService.create({ order, paidCents: store.paidTotal(order.id), noCod, senderPays });
        store.setTtn(order.id, ttn.number, ttn.ref);
      } catch (err) {
        log.error('ttn failed', err.message);
        // Кнопки залежать від причини: післяплата недоступна → «без післяплати»; поштомат → «доставку оплачує відправник»
        const unpaid = store.paidTotal(order.id) < order.data.totalCents;
        const flags = { senderPays };
        let replyMarkup;
        if (err.code === 'postomat_payer') replyMarkup = ttnSenderPaysKeyboard(order.id, { noCod });
        else if ((err.code === 'cod_unavailable' || /післяплат|контроль оплати/i.test(err.message)) && unpaid) replyMarkup = ttnNoCodKeyboard(order.id, flags);
        await telegram.sendText(buildTtnFailedMessage(order.order_number, err.message), { replyTo, replyMarkup }).catch(() => {});
        await answer('Не вдалося створити ТТН');
        return true;
      }
      // Далі ТТН уже існує: збій повідомлення чи KeyCRM не має виглядати як «не вдалося створити»
      try {
        const tracked = await syncTtnToCrm(order.id);
        let statusFailed = false;
        if (keycrm && order.crm_order_id && config.keycrmTtnStatusId) {
          await keycrm.setStatusId(order.crm_order_id, config.keycrmTtnStatusId).catch((e) => {
            statusFailed = true;
            log.error('keycrm ttn status', e.message);
          });
        }
        await telegram.clearButtons(message.message_id).catch(() => {});
        await telegram.sendText(buildTtnMessage({
          orderNumber: order.order_number,
          number: ttn.number,
          codUah: ttn.codUah,
          costUah: ttn.costUah,
          unpaidUah: ttn.unpaidUah,
          deliveryUah: ttn.deliveryUah,
          senderPays: ttn.senderPays,
          warnings: ttn.warnings,
          address: describeDelivery(order.data.delivery).join('\n'),
          tracked,
          statusFailed,
        }), { replyTo });
      } catch (err) {
        log.error('ttn notice failed', err.message);
      }
      await answer('ТТН створено');
      return true;
    });
    if (!ran) await answer('ТТН уже створюється, зачекайте');
    return { ok: true };
  }

  // Вебхук банку: підпис обовʼязково перевіряється, інакше будь-хто міг би «оплатити» замовлення
  async function monoWebhook(req) {
    if (!monobank) throw new HttpError(404, 'not_found', 'Not found');
    // Підпис рахується від точних байтів тіла (як у офіційному прикладі), а не від рядка після декодування
    const rawBytes = await readBuffer(req);
    const raw = rawBytes.toString('utf8');
    const signature = req.headers['x-sign'];
    if (!signature || !(await monobank.verifyWebhook(rawBytes, signature))) {
      log.error('bad monobank signature');
      throw new HttpError(401, 'unauthorized', 'Unauthorized');
    }
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      throw new HttpError(400, 'bad_request', 'Bad request');
    }

    return applyInvoiceUpdate(body);
  }

  // Однакова обробка для вебхука й для фонової звірки: статус рахунку → оплата, повідомлення, KeyCRM
  async function applyInvoiceUpdate(body) {
    // Тіло має бути обʼєктом із рядковим invoiceId, інакше це не повідомлення про наш рахунок
    if (!body || typeof body !== 'object' || typeof body.invoiceId !== 'string') return { ok: true };
    const payment = store.findPaymentByInvoice(body.invoiceId);
    if (!payment) return { ok: true };
    const status = String(body.status);
    const modified = Date.parse(body.modifiedDate) || 0;
    // Банк може повторювати й переставляти вебхуки: старіше за вже оброблене повідомлення ігноруємо
    if (modified && payment.modified_at && modified < payment.modified_at) return { ok: true };
    // Оплата вже була успішною, але банк повідомляє меншу «фінальну» суму: це часткове повернення коштів
    if (payment.status === 'success' && status === 'success' && Number.isInteger(body.finalAmount)
      && body.finalAmount !== (payment.final_amount ?? payment.amount)) {
      const order = store.getOrder(payment.order_id);
      store.setFinalAmount(payment.id, body.finalAmount);
      store.setPaymentStatus(payment.id, 'success', null, modified || null);
      await telegram.sendText(buildPartialRefundMessage(order.order_number, payment.amount, body.finalAmount, !!payment.crm_synced), { replyTo: order.tg_message_id || undefined })
        .catch((e) => log.error('refund notice failed', e.message));
      return { ok: true };
    }
    if (payment.status === status) return { ok: true };
    // Запізніле «processing» не скасовує вже отриману оплату; повернення коштів остаточне
    if (payment.status === 'success' && status !== 'reversed') return { ok: true };
    if (payment.status === 'reversed') return { ok: true };

    const order = store.getOrder(payment.order_id);
    const replyTo = order.tg_message_id || undefined;
    store.setPaymentStatus(payment.id, status, status === 'success' ? now().getTime() : null, modified || null);
    if (status === 'success' && Number.isInteger(body.finalAmount)) store.setFinalAmount(payment.id, body.finalAmount);
    if (status === 'success') {
      await telegram.sendText(buildPaidMessage({
        orderNumber: order.order_number,
        amountCents: payment.amount,
        kind: payment.kind,
        totalCents: order.data.totalCents,
        paidCents: store.paidTotal(order.id),
        method: order.data.delivery?.method || '',
      }), {
        replyTo,
        replyMarkup: ttnService && order.data.delivery?.method && !order.ttn_number ? ttnKeyboard(order.id) : undefined,
      }).catch((e) => log.error('paid notice failed', e.message));
      // Банк повідомив іншу суму, ніж у нашому рахунку: це треба перевірити людині
      if (Number.isInteger(body.finalAmount) && body.finalAmount !== payment.amount) {
        await telegram.sendText(buildAmountMismatchMessage(order.order_number, payment.amount, body.finalAmount), { replyTo })
          .catch((e) => log.error('mismatch notice failed', e.message));
      }
      await syncCrmPayment(payment, order);
    } else if (status === 'reversed') {
      await telegram.sendText(buildReversedMessage(order.order_number, payment.amount, !!payment.crm_synced), { replyTo })
        .catch((e) => log.error('reversed notice failed', e.message));
    } else if (status === 'failure') {
      await telegram.sendText(buildPayFailedMessage(order.order_number, body.failureReason), { replyTo }).catch((e) => log.error('pay failed notice failed', e.message));
    }
    return { ok: true };
  }

  /* ---------- Фонова робота ---------- */

  // Вебхук банку може не дійти (перезапуск сервера, збій): раз на кілька хвилин перевіряємо ще не завершені рахунки
  async function reconcilePayments() {
    if (!monobank) return;
    const nowMs = now().getTime();
    for (const payment of store.pollablePayments(nowMs, config.payValiditySeconds * 1000)) {
      store.markPolled(payment.id, nowMs);
      try {
        const status = await monobank.invoiceStatus(payment.invoice_id);
        await applyInvoiceUpdate({ ...status, invoiceId: payment.invoice_id });
      } catch (err) {
        log.error('invoice status poll failed', err.message);
      }
    }
  }

  async function sendReminders(date) {
    const nowMs = date.getTime();
    if (!isWorkingTime(date, config)) return;
    for (const order of store.reminderCandidates(config.reminderMax, config.remindersFrom || 0)) {
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
      payments: store.paidSince(from),
      startOf: (o) => effectiveStart(o.created_at, config),
    });
    try {
      await telegram.sendText(text);
      store.setMeta('last_report', key);
    } catch (err) {
      log.error('weekly report failed', err.message);
    }
  }

  // Викликається періодично: повторні відправки, нагадування, тижневий звіт
  // Кожен етап виконується окремо: збій одного (наприклад, KeyCRM) не зупиняє решту
  // (доставку в Telegram, нагадування, звіт)
  async function tick() {
    const date = now();
    const stages = [
      ['telegram', async () => { for (const order of store.telegramDue(date.getTime())) await deliverTelegram(order); }],
      ['crm', async () => { for (const order of store.crmDue(date.getTime())) await deliverCrm(order); }],
      ['mono', () => reconcilePayments()],
      ['payments', async () => { for (const payment of store.unsyncedPayments()) await syncCrmPayment(payment, store.getOrder(payment.order_id)); }],
      ['statuses', () => syncStatuses()],
      ['ttn', async () => { for (const order of store.ttnNotInCrm()) await syncTtnToCrm(order.id); }],
      ['prompts', async () => store.pruneOldPrompts(date.getTime() - PROMPT_TTL_MS)],
      ['conversions', () => conversions.tick()],
      ['reminders', () => sendReminders(date)],
      ['report', () => sendWeeklyReport(date)],
      ['backup', () => backup.run()],
    ];
    for (const [name, run] of stages) {
      try {
        await run();
      } catch (err) {
        log.error(`tick stage ${name} failed`, err.message);
      }
    }
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
    const purchases = conversions.enabled
      ? { purchases: store.conversionCounts(), conversions: conversions.diagnostics() }
      : {};
    return { code: ok ? 200 : 503, body: { ok, db: true, ...counts, stuck_seconds: stuckSeconds, ...purchases } };
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

  /* ---------- Нова пошта: підказки міст, відділень, вулиць ---------- */

  const npCache = new Map();
  const NP_CACHE_TTL_MS = 10 * 60 * 1000;
  const NP_CACHE_MAX = 500;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  // Однакові запити (наприклад, «Київ») не навантажують API Нової пошти щоразу
  async function cached(key, loader) {
    const hit = npCache.get(key);
    if (hit && hit.expires > Date.now()) return hit.value;
    const value = await loader();
    if (npCache.size >= NP_CACHE_MAX) npCache.delete(npCache.keys().next().value);
    npCache.set(key, { value, expires: Date.now() + NP_CACHE_TTL_MS });
    return value;
  }

  async function novaPoshtaLookup(req, url, kind) {
    // Запит має прийти через App Proxy свого магазину
    if (!verifyProxySignature(url.searchParams, config.apiSecret) || url.searchParams.get('shop') !== config.shop) {
      throw new HttpError(401, 'unauthorized', 'Недійсний підпис');
    }
    if (!novaPoshta) throw new HttpError(503, 'np_disabled', 'Нова пошта не підключена');
    if (!store.takeHit(`np:${clientIp(req)}`, 600, 60_000, now().getTime())) {
      log.error('np lookups rate limited by ip', clientIp(req));
      throw new HttpError(429, 'rate_limited', 'Забагато запитів');
    }

    const q = (url.searchParams.get('q') || '').trim().slice(0, 60);
    const settlement = url.searchParams.get('settlement') || '';
    try {
      if (kind === 'cities') {
        if (q.length < 2) return { ok: true, items: [] };
        return { ok: true, items: await cached(`c:${q.toLowerCase()}`, () => novaPoshta.searchCities(q)) };
      }
      if (!UUID.test(settlement)) throw new HttpError(422, 'bad_request', 'Оберіть місто');
      if (kind === 'points') {
        const pointKind = url.searchParams.get('kind') === 'postomat' ? 'postomat' : 'warehouse';
        return {
          ok: true,
          items: await cached(`p:${pointKind}:${settlement}:${q.toLowerCase()}`,
            () => novaPoshta.searchPoints({ settlement, query: q, kind: pointKind })),
        };
      }
      if (q.length < 2) return { ok: true, items: [] };
      return {
        ok: true,
        items: await cached(`s:${settlement}:${q.toLowerCase()}`, () => novaPoshta.searchStreets({ settlement, query: q })),
      };
    } catch (err) {
      if (err instanceof HttpError) throw err;
      log.error('nova poshta lookup failed', err.message);
      throw new HttpError(502, 'upstream', 'Нова пошта недоступна');
    }
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
      const np = req.method === 'GET' && /^\/proxy\/np\/(cities|points|streets)$/.exec(url.pathname);
      if (np) return send(200, await novaPoshtaLookup(req, url, np[1]));
      // Друга адреса того самого файлу: Менеджер даних Google Ads запам'ятовує заголовок за адресою,
      // тож нова адреса змушує його прочитати колонки наново
      if (req.method === 'GET' && (url.pathname === '/conversions/google-ads.csv' || url.pathname === '/conversions/quick-order-purchases.csv')) {
        const c = config.conversions;
        if (!conversions.enabled || !c?.gadsFeedPassword) return send(404, { ok: false, code: 'not_found' });
        const [scheme, encoded] = String(req.headers.authorization || '').split(' ');
        const [user, ...pass] = Buffer.from(encoded || '', 'base64').toString('utf8').split(':');
        if (scheme !== 'Basic' || !safeEqual(user, c.gadsFeedUser) || !safeEqual(pass.join(':'), c.gadsFeedPassword)) {
          res.writeHead(401, { 'www-authenticate': 'Basic realm="conversions"', 'cache-control': 'no-store' });
          return res.end();
        }
        res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(conversions.googleAdsCsv(url.searchParams.get('format') === 'legacy' ? 'legacy' : 'data_manager'));
      }
      if (req.method === 'POST' && url.pathname === '/proxy/submit') return send(200, await submit(req, url));
      if (req.method === 'POST' && url.pathname === '/telegram/webhook') return send(200, await telegramWebhook(req));
      if (req.method === 'POST' && url.pathname === '/mono/webhook') return send(200, await monoWebhook(req));
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
