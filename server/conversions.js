// Покупка для реклами: швидке замовлення стає покупкою, коли в нього є і оплата, і ТТН.
// Тоді сервер один раз передає її в Meta (Conversions API), GA4 (Measurement Protocol)
// і показує в CSV для запланованого завантаження офлайн-конверсій Google Ads.
// Браузерні події форми лишаються лідом (Lead / generate_lead): на момент заявки покупки ще немає.
import crypto from 'node:crypto';

const DAY = 24 * 3600e3;
const META_MAX_AGE_MS = 7 * DAY; // Meta не приймає події, старші за 7 днів
const GA_MAX_AGE_MS = 72 * 3600e3; // GA4 приймає timestamp_micros не давніше 72 годин
const GADS_WINDOW_MS = 63 * DAY; // офлайн-конверсії Google Ads: до 90 днів після кліку

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const norm = (value) => String(value || '').trim().toLowerCase();

// Телефон для Meta: лише цифри з кодом країни (380…)
const phoneDigits = (phone) => String(phone || '').replace(/\D/g, '');

// Ідентифікатор товару так, як він записаний у каталозі Meta (налаштовується змінною META_CONTENT_ID)
export function contentId(template, d) {
  const values = { product_id: d.productId, variant_id: d.variantId, sku: d.sku };
  let missing = false;
  const id = String(template || '{variant_id}').replace(/\{(product_id|variant_id|sku)\}/g, (_, key) => {
    if (!values[key]) missing = true;
    return values[key] || '';
  });
  // Неповний ID не збігся б із каталогом: краще не передати товар зовсім, ніж передати чужий
  return missing ? '' : id;
}

// Чи вважається замовлення покупкою, і з якою сумою
export function evaluatePurchase({ order, localPaidCents, crm, excludeStatusIds = [], excludeStatusGroupIds = [] }) {
  if (['spam', 'cancelled'].includes(order.status)) return { ok: false, reason: 'status' };
  if (crm) {
    if (excludeStatusIds.includes(crm.statusId)) return { ok: false, reason: 'crm_status' };
    if (excludeStatusGroupIds.includes(crm.statusGroupId)) return { ok: false, reason: 'crm_status_group' };
  }
  const paid = localPaidCents > 0 || (crm?.paidUah || 0) > 0;
  const ttn = Boolean(order.ttn_number || crm?.trackingCode);
  if (!paid) return { ok: false, reason: 'not_paid' };
  if (!ttn) return { ok: false, reason: 'no_ttn' };
  // Сума з KeyCRM враховує зміни менеджера (промокод, інша кількість); якщо її немає, беремо суму заявки
  const valueCents = crm?.grandTotalUah > 0 ? Math.round(crm.grandTotalUah * 100) : order.data.totalCents;
  return { ok: true, valueCents };
}

export function buildMetaEvent(order, { contentIdTemplate, eventTimeMs }) {
  const d = order.data;
  const ads = d.ads || {};
  const value = order.conv_value_cents / 100;
  const id = contentId(contentIdTemplate, d);
  const userData = {
    ph: [sha256(phoneDigits(d.phone))],
    external_id: [sha256(phoneDigits(d.phone))],
    country: [sha256('ua')],
  };
  const [first, ...rest] = String(d.name || '').trim().split(/\s+/);
  const last = d.surname || rest.join(' ');
  if (first) userData.fn = [sha256(norm(first))];
  if (last) userData.ln = [sha256(norm(last))];
  const city = norm(d.delivery?.city?.name || d.city).replace(/[^\p{L}]/gu, '');
  if (city) userData.ct = [sha256(city)];
  if (ads.fbc) userData.fbc = ads.fbc;
  if (ads.fbp) userData.fbp = ads.fbp;
  if (ads.ua) userData.client_user_agent = ads.ua;

  return {
    event_name: 'Purchase',
    event_time: Math.floor(eventTimeMs / 1000),
    event_id: `quick-${order.order_number}`,
    // Для action_source=website Meta вимагає user-agent; без нього подія позначається як згенерована системою
    action_source: ads.ua ? 'website' : 'system_generated',
    ...(ads.ua ? { event_source_url: d.productUrl } : {}),
    user_data: userData,
    custom_data: {
      currency: 'UAH',
      value,
      order_id: `quick-${order.order_number}`,
      content_type: 'product',
      content_name: d.productTitle,
      ...(id ? {
        content_ids: [id],
        contents: [{ id, quantity: d.quantity, item_price: d.unitCents / 100 }],
      } : {}),
      num_items: d.quantity,
    },
  };
}

export function buildGaPayload(order, { measurementId, eventTimeMs }) {
  const d = order.data;
  const ads = d.ads || {};
  // Без cookie _ga покупка все одно рахується в GA4, але без прив'язки до рекламної сесії
  // Стабільний для замовлення, щоб повтор відправки не створював нового «користувача»
  const pseudo = parseInt(sha256(order.order_number).slice(0, 8), 16);
  const clientId = ads.gaClientId || `${pseudo}.${Math.floor(order.created_at / 1000)}`;
  const stream = String(measurementId || '').replace(/^G-/, '');
  const sessionId = ads.gaSessions?.[stream];
  const variant = (d.options || []).map((o) => o.value).join(' / ');
  return {
    client_id: clientId,
    timestamp_micros: eventTimeMs * 1000,
    events: [{
      name: 'purchase',
      params: {
        transaction_id: `quick-${order.order_number}`,
        value: order.conv_value_cents / 100,
        currency: 'UAH',
        affiliation: 'quick_order',
        ...(sessionId ? { session_id: sessionId, engagement_time_msec: 1 } : {}),
        items: [{
          item_id: d.sku || d.variantId,
          item_name: d.productTitle,
          ...(variant ? { item_variant: variant } : {}),
          price: d.unitCents / 100,
          quantity: d.quantity,
        }],
      },
    }],
  };
}

// Час у форматі Google Ads (UTC, бо у файлі вказано TimeZone=+0000)
function gadsTime(ms) {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

const csvCell = (value) => {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// Файл для «Завантаження → Розклади» в Google Ads. Той самий gclid + назва + час не рахується двічі,
// тому час покупки фіксований (conv_at) і щоденне повторне завантаження не дублює конверсії.
export function buildGoogleAdsCsv(orders, { conversionName }) {
  const lines = [
    'Parameters:TimeZone=+0000',
    'Google Click ID,Conversion Name,Conversion Time,Conversion Value,Conversion Currency',
  ];
  for (const order of orders) {
    const gclid = order.data.ads?.gclid;
    if (!gclid) continue;
    lines.push([gclid, conversionName, gadsTime(order.conv_at), (order.conv_value_cents / 100).toFixed(2), 'UAH'].map(csvCell).join(','));
  }
  return `${lines.join('\n')}\n`;
}

export function createConversions({ config, store, keycrm, fetchFn, now, log, notify }) {
  const c = config.conversions || { enabled: false };
  const metaOn = () => Boolean(c.metaDatasetId && c.metaToken);
  const gaOn = () => Boolean(c.gaMeasurementId && c.gaApiSecret);

  async function readCrm(order) {
    if (!keycrm || !order.crm_order_id) return null;
    return keycrm.getOrderState(order.crm_order_id);
  }

  // Етап 1: шукаємо замовлення, у яких уже є і оплата, і ТТН
  // Без CONVERSIONS_FROM рахуємо лише замовлення, створені після першого ввімкнення: інакше всі оплачені
  // замовлення за 30 днів одразу пішли б у рекламу як «нові» покупки (частину вже слала стара інтеграція KeyCRM)
  function startFrom(nowMs) {
    if (c.from) return c.from;
    let first = Number(store.getMeta('conversions_enabled_at'));
    if (!first) {
      first = nowMs;
      store.setMeta('conversions_enabled_at', first);
    }
    return first;
  }

  async function qualify() {
    const nowMs = now().getTime();
    const since = Math.max(nowMs - c.lookbackDays * DAY, startFrom(nowMs));
    for (const order of store.conversionCandidates(nowMs, since, c.checksPerTick)) {
      store.markConversionChecked(order.id, nowMs);
      const localPaidCents = store.paidTotal(order.id);
      // KeyCRM питаємо лише тоді, коли там може бути щось, чого не знає сервер, або щоб перевірити статус перед зарахуванням
      let crm = null;
      // Замовлення ще не в KeyCRM: без перевірки статусу не зараховуємо (повторимо в наступній перевірці)
      if (keycrm && !order.crm_order_id) continue;
      if (keycrm) {
        try {
          crm = await readCrm(order);
        } catch (err) {
          log.error('conversion: keycrm read failed', err.message);
          if (err.status === 429) break; // ліміт KeyCRM: решту перевіримо в наступному циклі
          continue; // без перевірки статусу в KeyCRM не зараховуємо (тест або «некоректні дані» не мають піти в рекламу)
        }
      }
      const verdict = evaluatePurchase({
        order,
        localPaidCents,
        crm,
        excludeStatusIds: c.excludeStatusIds,
        excludeStatusGroupIds: c.excludeStatusGroupIds,
      });
      if (!verdict.ok) continue;
      if (store.markConversion(order.id, nowMs, verdict.valueCents)) {
        log.log(JSON.stringify({ event: 'purchase_qualified', number: order.order_number, value: verdict.valueCents / 100 }));
      }
    }
  }

  async function sendMeta(order, nowMs) {
    const body = {
      data: [buildMetaEvent(order, { contentIdTemplate: c.metaContentId, eventTimeMs: order.conv_at })],
      ...(c.metaTestEventCode ? { test_event_code: c.metaTestEventCode } : {}),
    };
    if (c.dryRun) {
      // У лог без даних покупця: хеш українського номера легко підібрати
      const safe = { ...body, data: body.data.map(({ user_data: userData, ...rest }) => ({ ...rest, user_data_keys: Object.keys(userData) })) };
      log.log(JSON.stringify({ event: 'purchase_dry_run', channel: 'meta', number: order.order_number, body: safe }));
      store.setConversionState('meta', order.id, 'dry');
      return;
    }
    const url = `https://graph.facebook.com/${c.metaApiVersion}/${encodeURIComponent(c.metaDatasetId)}/events`;
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, access_token: c.metaToken }),
      signal: AbortSignal.timeout(10000),
    });
    const text = await res.text();
    if (!res.ok) throw Object.assign(new Error(`Meta ${res.status}: ${text.slice(0, 200)}`), { status: res.status });
    store.setConversionState('meta', order.id, 'sent');
    log.log(JSON.stringify({ event: 'purchase_sent', channel: 'meta', number: order.order_number, at: nowMs }));
  }

  async function sendGa(order, nowMs) {
    const body = buildGaPayload(order, { measurementId: c.gaMeasurementId, eventTimeMs: order.conv_at });
    if (c.dryRun) {
      log.log(JSON.stringify({ event: 'purchase_dry_run', channel: 'ga', number: order.order_number, body: { ...body, client_id: body.client_id ? 'set' : '' } }));
      store.setConversionState('ga', order.id, 'dry');
      return;
    }
    const query = new URLSearchParams({ measurement_id: c.gaMeasurementId, api_secret: c.gaApiSecret });
    const res = await fetchFn(`https://www.google-analytics.com/mp/collect?${query}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    // GA4 відповідає 2xx навіть на некоректні події; помилкою вважаємо лише збій запиту
    if (!res.ok) throw Object.assign(new Error(`GA4 ${res.status}`), { status: res.status });
    store.setConversionState('ga', order.id, 'sent');
    log.log(JSON.stringify({ event: 'purchase_sent', channel: 'ga', number: order.order_number, at: nowMs }));
  }

  // Етап 2: відправляємо зараховані покупки в кожен канал окремо (збій одного не блокує інший)
  async function deliver() {
    const nowMs = now().getTime();
    const channels = [
      ['meta', metaOn, META_MAX_AGE_MS, sendMeta],
      ['ga', gaOn, GA_MAX_AGE_MS, sendGa],
    ];
    for (const [channel, on, maxAge, send] of channels) {
      for (const order of store.conversionDue(channel, nowMs, { dryRun: Boolean(c.dryRun) })) {
        // Канал не налаштований: покупка чекає (якщо його підключать протягом вікна, вона піде)
        if (!on()) continue;
        if (nowMs - order.conv_at > maxAge) { store.setConversionState(channel, order.id, 'expired'); continue; }
        try {
          await send(order, nowMs);
        } catch (err) {
          log.error(`conversion: ${channel} failed`, err.message);
          const attempt = store.markConversionFailed(channel, order.id, err.message, nowMs);
          // Один раз на збій попереджаємо менеджерів: найчастіша причина — протермінований токен
          if (attempt === 5 && notify) {
            await notify(`⚠️ Покупку #${order.order_number} не вдається передати в ${channel === 'meta' ? 'Meta' : 'GA4'}: ${String(err.message).slice(0, 150)}. Сервер повторює спроби.`)
              .catch(() => {});
          }
        }
      }
    }
  }

  async function tick() {
    if (!c.enabled) return;
    await qualify();
    await deliver();
  }

  // CSV для Google Ads (захищений логіном і паролем; Google Ads підтримує HTTPS-джерело з базовою автентифікацією)
  function googleAdsCsv() {
    // У тестовому режимі файл порожній: заплановане завантаження Google Ads не має імпортувати тестові покупки
    const orders = c.dryRun ? [] : store.conversionsSince(now().getTime() - GADS_WINDOW_MS);
    return buildGoogleAdsCsv(orders, { conversionName: c.gadsConversionName });
  }

  return {
    tick,
    googleAdsCsv,
    get enabled() { return Boolean(c.enabled); },
  };
}
