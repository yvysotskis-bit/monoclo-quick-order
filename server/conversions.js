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

// Час у форматі старого імпорту Google Ads (UTC, бо у файлі вказано TimeZone=+0000)
function gadsTime(ms) {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

// ISO 8601 зі зміщенням: Менеджер даних Google Ads розпізнає часовий пояс сам
function isoTime(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, '+00:00');
}

const csvCell = (value) => {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// Файл офлайн-конверсій для Google Ads. Той самий клік + дія + час не рахується двічі,
// тому час покупки фіксований (conv_at) і щоденне повторне завантаження не дублює конверсії.
// format 'data_manager' (за замовчуванням): звичайний CSV із заголовком, поля зіставляються в Менеджері даних
//   (джерело HTTPS); є order_id (ідентифікатор транзакції) і gbraid/wbraid для кліків з iOS.
// format 'legacy': шаблон старого «Завантаження → Розклади» (Parameters:TimeZone + англійські назви колонок).
export function buildGoogleAdsCsv(orders, { conversionName, format = 'data_manager' }) {
  if (format === 'legacy') {
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
  const lines = ['gclid,gbraid,wbraid,conversion_time,conversion_value,currency_code,order_id,conversion_name'];
  for (const order of orders) {
    const ads = order.data.ads || {};
    if (!ads.gclid && !ads.gbraid && !ads.wbraid) continue;
    // Один ідентифікатор кліку на рядок: gclid має пріоритет, gbraid/wbraid — для iOS без gclid
    const gclid = ads.gclid || '';
    const gbraid = gclid ? '' : ads.gbraid || '';
    const wbraid = gclid || gbraid ? '' : ads.wbraid || '';
    lines.push([gclid, gbraid, wbraid, isoTime(order.conv_at), (order.conv_value_cents / 100).toFixed(2), 'UAH',
      `quick-${order.order_number}`, conversionName].map(csvCell).join(','));
  }
  // Менеджер даних не приймає файл без жодного рядка даних («не вдалося визначити схему»).
  // Поки справжніх покупок немає, віддаємо один рядок-заглушку, який Google гарантовано відхилить при імпорті:
  // вигаданий gclid і дата понад 90 днів тому. Конверсією він не стане; щойно з'явиться справжня покупка, заглушка зникає.
  if (lines.length === 1) {
    lines.push(['PLACEHOLDER-NO-PURCHASES-YET', '', '', '2020-01-01T00:00:00+00:00', '0.00', 'UAH', 'placeholder', conversionName]
      .map(csvCell).join(','));
  }
  return `${lines.join('\n')}\n`;
}

// Покупка із замовлення KeyCRM іншого джерела (Instagram Direct): оплата + ТТН, без скасованих і вже відправлених
// старою інтеграцією (тег CAPI). Повертає { ok, valueCents } або причину відмови.
export function evaluateCrmOrder(o, { excludeStatusIds = [], excludeStatusGroupIds = [] } = {}) {
  if (excludeStatusIds.includes(Number(o.status_id))) return { ok: false, reason: 'crm_status' };
  if (excludeStatusGroupIds.includes(Number(o.status_group_id))) return { ok: false, reason: 'crm_status_group' };
  const tags = Array.isArray(o.tags) ? o.tags : [];
  if (tags.some((t) => /^capi$/i.test(String(t.alias || t.name || '')))) return { ok: false, reason: 'already_sent' };
  const paidUah = (Array.isArray(o.payments) ? o.payments : [])
    .filter((p) => String(p.status || '').toLowerCase() === 'paid')
    .reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
  if (paidUah <= 0) return { ok: false, reason: 'not_paid' };
  if (!String(o.shipping?.tracking_code || '').trim()) return { ok: false, reason: 'no_ttn' };
  const totalUah = Number(o.grand_total) || paidUah;
  return { ok: true, valueCents: Math.round(totalUah * 100) };
}

export function buildCrmMetaEvent(o, { valueCents, eventTimeMs }) {
  const phone = phoneDigits(o.buyer?.phone || o.shipping?.recipient_phone);
  const fullName = String(o.buyer?.full_name || o.shipping?.recipient_full_name || '').trim();
  // KeyCRM пише «Прізвище Ім'я» або «Ім'я Прізвище» — порядок невідомий, тож хешуємо лише як є перші два слова
  const [first, second] = fullName.split(/\s+/);
  const userData = { country: [sha256('ua')] };
  if (phone) { userData.ph = [sha256(phone)]; userData.external_id = [sha256(phone)]; }
  if (first) userData.fn = [sha256(norm(first))];
  if (second) userData.ln = [sha256(norm(second))];
  const city = norm(String(o.shipping?.shipping_address_city || '').replace(/^(м\.|с\.|смт)\s*/i, '')).replace(/[^\p{L}]/gu, '');
  if (city) userData.ct = [sha256(city)];
  const products = Array.isArray(o.products) ? o.products : [];
  return {
    event_name: 'Purchase',
    event_time: Math.floor(eventTimeMs / 1000),
    event_id: `keycrm-${o.id}`,
    action_source: 'system_generated',
    user_data: userData,
    custom_data: {
      currency: 'UAH',
      value: valueCents / 100,
      order_id: `keycrm-${o.id}`,
      content_type: 'product',
      num_items: products.reduce((n, p) => n + (Number(p.quantity) || 0), 0) || 1,
    },
  };
}

export function createConversions({ config, store, keycrm, fetchFn, now, log, notify }) {
  const c = config.conversions || { enabled: false };
  const metaOn = () => Boolean(c.metaDatasetId && c.metaToken);
  const gaOn = () => Boolean(c.gaMeasurementId && c.gaApiSecret);

  // Діагностика для /status: чому покупки не зараховуються (без персональних даних і секретів)
  const diag = { lastErrors: {}, lastQualify: null, lastCrmPoll: null };
  const noteError = (key, err) => {
    diag.lastErrors[key] = { at: new Date(now().getTime()).toISOString(), message: String(err?.message || err).slice(0, 200) };
  };

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
    const reasons = {};
    const candidates = store.conversionCandidates(nowMs, since, c.checksPerTick);
    diag.lastTick = new Date(nowMs).toISOString();
    diag.since = new Date(since).toISOString();
    // Останню перевірку, де справді були замовлення, не затираємо порожніми циклами
    if (candidates.length) diag.lastQualify = { at: new Date(nowMs).toISOString(), checked: candidates.length, reasons };
    for (const order of candidates) {
      store.markConversionChecked(order.id, nowMs);
      const localPaidCents = store.paidTotal(order.id);
      // KeyCRM питаємо лише тоді, коли там може бути щось, чого не знає сервер, або щоб перевірити статус перед зарахуванням
      let crm = null;
      // Замовлення ще не в KeyCRM: без перевірки статусу не зараховуємо (повторимо в наступній перевірці)
      if (keycrm && !order.crm_order_id) { reasons.no_crm_order = (reasons.no_crm_order || 0) + 1; continue; }
      if (keycrm) {
        try {
          crm = await readCrm(order);
        } catch (err) {
          log.error('conversion: keycrm read failed', err.message);
          noteError('keycrm_read', err);
          reasons.keycrm_error = (reasons.keycrm_error || 0) + 1;
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
      if (!verdict.ok) { reasons[verdict.reason] = (reasons[verdict.reason] || 0) + 1; continue; }
      reasons.qualified = (reasons.qualified || 0) + 1;
      if (store.markConversion(order.id, nowMs, verdict.valueCents)) {
        log.log(JSON.stringify({ event: 'purchase_qualified', number: order.order_number, value: verdict.valueCents / 100 }));
      }
    }
  }

  // Інші джерела KeyCRM (Instagram Direct): раз на 15 хв переглядаємо замовлення за вікно й зараховуємо оплачені з ТТН
  const CRM_POLL_MS = 15 * 60_000;
  const utcStamp = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
  async function qualifyCrmSources() {
    if (!keycrm || !c.crmSourceIds?.length) return;
    const nowMs = now().getTime();
    if (nowMs - Number(store.getMeta('crm_sources_polled_at') || 0) < CRM_POLL_MS) return;
    store.setMeta('crm_sources_polled_at', nowMs);
    const since = Math.max(nowMs - c.lookbackDays * DAY, startFrom(nowMs));
    const reasons = {};
    diag.lastCrmPoll = { at: new Date(nowMs).toISOString(), since: new Date(since).toISOString(), seen: 0, reasons };
    // Джерело швидких замовлень обробляється окремо (з оплатою й ТТН із бота): тут його пропускаємо, щоб не було дублів
    for (const sourceId of c.crmSourceIds.filter((id) => id !== Number(config.keycrmSourceId))) {
      for (let page = 1; page <= 10; page += 1) {
        let result;
        try {
          // Запас у добу з обох боків: часовий пояс фільтра KeyCRM не гарантований, точну межу перевіряємо нижче
          result = await keycrm.listOrders({ sourceId, from: utcStamp(since - DAY), to: utcStamp(nowMs + DAY), page });
        } catch (err) {
          log.error('conversion: keycrm list failed', err.message);
          noteError('keycrm_list', err);
          return;
        }
        diag.lastCrmPoll.seen += result.orders.length;
        const count = (k) => { reasons[k] = (reasons[k] || 0) + 1; };
        for (const o of result.orders) {
          if (!o?.id) continue;
          if (store.hasCrmPurchase(o.id)) { count('already_counted'); continue; }
          if (Number(o.source_id) && Number(o.source_id) !== Number(sourceId)) { count('other_source'); continue; }
          const created = Date.parse(String(o.created_at || '').replace(' ', 'T'));
          if (Number.isFinite(created) && created < since) { count('before_start'); continue; }
          const verdict = evaluateCrmOrder(o, c);
          if (!verdict.ok) { count(verdict.reason); continue; }
          count('qualified');
          const event = buildCrmMetaEvent(o, { valueCents: verdict.valueCents, eventTimeMs: nowMs });
          if (store.insertCrmPurchase({ crmOrderId: o.id, sourceId, convAt: nowMs, valueCents: verdict.valueCents, event })) {
            log.log(JSON.stringify({ event: 'purchase_qualified', crm_order: o.id, source: sourceId, value: verdict.valueCents / 100 }));
          }
        }
        if (!result.hasMore) break;
      }
    }
  }

  async function deliverCrmPurchases() {
    const nowMs = now().getTime();
    if (!metaOn()) return;
    for (const row of store.crmPurchasesDue(nowMs, { dryRun: Boolean(c.dryRun) })) {
      if (nowMs - row.conv_at > META_MAX_AGE_MS) { store.setCrmPurchaseState(row.crm_order_id, 'expired'); continue; }
      const body = { data: [row.event], ...(c.metaTestEventCode ? { test_event_code: c.metaTestEventCode } : {}) };
      if (c.dryRun) {
        log.log(JSON.stringify({ event: 'purchase_dry_run', channel: 'meta', crm_order: row.crm_order_id, value: row.value_cents / 100 }));
        store.setCrmPurchaseState(row.crm_order_id, 'dry');
        continue;
      }
      try {
        const url = `https://graph.facebook.com/${c.metaApiVersion}/${encodeURIComponent(c.metaDatasetId)}/events`;
        const res = await fetchFn(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...body, access_token: c.metaToken }),
          signal: AbortSignal.timeout(10000),
        });
        const text = await res.text();
        if (!res.ok) throw new Error(`Meta ${res.status}: ${text.slice(0, 200)}`);
        store.setCrmPurchaseState(row.crm_order_id, 'sent');
        log.log(JSON.stringify({ event: 'purchase_sent', channel: 'meta', crm_order: row.crm_order_id }));
      } catch (err) {
        log.error('conversion: meta (crm) failed', err.message);
        noteError('meta_crm', err);
        const attempt = store.markCrmPurchaseFailed(row.crm_order_id, err.message, nowMs);
        if (attempt === 5 && notify) {
          await notify(`⚠️ Покупку з KeyCRM #${row.crm_order_id} не вдається передати в Meta: ${String(err.message).slice(0, 150)}. Сервер повторює спроби.`).catch(() => {});
        }
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
          noteError(channel, err);
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

  // Разова повторна відправка в Meta (CONVERSIONS_RESEND_META_BEFORE). Лише в бойовому режимі без тестового коду,
  // інакше покупки знову пішли б у тест. Позначка в базі не дає повторити її після перезапуску.
  async function resendMeta() {
    const before = c.metaResendBefore;
    if (!before || c.dryRun || c.metaTestEventCode || !metaOn()) return;
    if (store.getMeta('meta_resend_before') === String(before)) return;
    const counts = store.resetMetaSent(before);
    store.setMeta('meta_resend_before', before);
    store.setMeta('meta_resend_result', JSON.stringify({ at: now().getTime(), ...counts }));
    log.log(JSON.stringify({ event: 'meta_resend', before: new Date(before).toISOString(), ...counts }));
    if (notify && counts.orders + counts.crm > 0) {
      await notify(`🔁 Повторно передаю в Meta ${counts.orders + counts.crm} покупок (швидкі: ${counts.orders}, KeyCRM: ${counts.crm}).`).catch(() => {});
    }
  }

  async function tick() {
    if (!c.enabled) return;
    await resendMeta();
    await qualify();
    await deliver();
    await qualifyCrmSources();
    await deliverCrmPurchases();
  }

  // CSV для Google Ads (захищений логіном і паролем; Google Ads підтримує HTTPS-джерело з базовою автентифікацією)
  function googleAdsCsv(format) {
    // У тестовому режимі файл порожній: заплановане завантаження Google Ads не має імпортувати тестові покупки
    const orders = c.dryRun ? [] : store.conversionsSince(now().getTime() - GADS_WINDOW_MS);
    return buildGoogleAdsCsv(orders, { conversionName: c.gadsConversionName, format });
  }

  return {
    tick,
    googleAdsCsv,
    get enabled() { return Boolean(c.enabled); },
    diagnostics() {
      return {
        dry_run: Boolean(c.dryRun),
        from: c.from ? new Date(c.from).toISOString() : null,
        enabled_at: Number(store.getMeta('conversions_enabled_at')) ? new Date(Number(store.getMeta('conversions_enabled_at'))).toISOString() : null,
        crm_sources: c.crmSourceIds || [],
        meta: metaOn(),
        meta_test_mode: Boolean(c.metaTestEventCode),
        meta_resend: store.getMeta('meta_resend_result') ? JSON.parse(store.getMeta('meta_resend_result')) : null,
        ga: gaOn(),
        google_ads_feed: Boolean(c.gadsFeedPassword),
        since: diag.since || null,
        last_tick: diag.lastTick || null,
        last_qualify: diag.lastQualify,
        last_crm_poll: diag.lastCrmPoll,
        last_errors: diag.lastErrors,
      };
    },
  };
}
