import fs from 'node:fs';
import path from 'node:path';

function parseJson(raw, name) {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${name} має бути коректним JSON`);
  }
}

// ISO-дата (наприклад, 2026-10-06T07:00:00Z) у мілісекунди; порожньо = 0
function parseDate(raw, name) {
  if (!raw) return 0;
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) throw new Error(`${name} має бути датою, наприклад 2026-10-06T07:00:00Z`);
  return ms;
}

// «13, 19» → [13, 19]; сміття відкидається
function idList(raw) {
  return String(raw || '').split(/[,\s]+/).map(Number).filter((n) => Number.isInteger(n) && n > 0);
}

export function loadConfig(env = process.env) {
  const required = (key) => {
    // Зайві пробіли й переноси рядків при копіюванні в Render ламають секрети
    const value = env[key]?.trim();
    if (!value) throw new Error(`Не задано змінну оточення ${key}`);
    return value;
  };
  const optional = (key) => env[key]?.trim() || '';
  const number = (key, fallback) => {
    const raw = optional(key);
    if (raw === '') return fallback;
    // Помилка в числі (наприклад, «10 год») не має тихо перетворитися на NaN і зламати розклад чи ліміти
    const value = Number(raw.replace(',', '.'));
    if (!Number.isFinite(value)) throw new Error(`${key} має бути числом, а зараз «${raw}»`);
    return value;
  };

  const shop = required('SHOPIFY_SHOP');
  const apiSecret = required('SHOPIFY_API_SECRET');
  const storeOrigin = (optional('STORE_ORIGIN') || `https://${shop}`).replace(/\/+$/, '');
  const keycrmSourceId = number('KEYCRM_SOURCE_ID', 216);
  // Магазини, з яких приймаємо замовлення. Основний (Monoclo) має всі функції; другий (Morning Star, MS_*) — лише
  // Telegram, статуси, нагадування і KeyCRM зі своїм джерелом, без оплат Monobank, ТТН і передачі покупок у рекламу.
  const shops = [{
    key: 'main', shop, apiSecret, storeOrigin, keycrmSourceId, tag: optional('BRAND_TAG') || '#Monoclo', name: '', full: true,
  }];
  const msShop = optional('MS_SHOP');
  if (msShop) {
    if (msShop === shop) throw new Error('MS_SHOP має відрізнятися від SHOPIFY_SHOP');
    shops.push({
      key: 'ms',
      shop: msShop,
      apiSecret: required('MS_API_SECRET'),
      storeOrigin: (optional('MS_STORE_ORIGIN') || `https://${msShop}`).replace(/\/+$/, ''),
      keycrmSourceId: number('MS_KEYCRM_SOURCE_ID', 215),
      tag: optional('MS_TAG') || '#MorningStar',
      name: optional('MS_NAME') || 'Morning Star',
      full: false,
    });
  }
  const dbPath = optional('DB_PATH') || (fs.existsSync('/data') ? '/data/quick-order.db' : './data/quick-order.db');
  return {
    port: number('PORT', 3000),
    shop,
    apiSecret,
    storeOrigin,
    shops,
    telegramToken: required('TELEGRAM_BOT_TOKEN'),
    telegramChatId: required('TELEGRAM_CHAT_ID'),
    telegramWebhookSecret: required('TELEGRAM_WEBHOOK_SECRET'),
    timezone: optional('TIMEZONE') || 'Europe/Kyiv',
    workStart: number('WORK_HOURS_START', 10),
    workEnd: number('WORK_HOURS_END', 20),
    maxQty: number('MAX_QTY', 10),
    // Ціни заявок «Свій принт» у гривнях поверх таблиці server/custom-print.js, напр. {"tee":1450}
    customPrintPrices: parseJson(optional('CUSTOM_PRINT_PRICES'), 'CUSTOM_PRINT_PRICES'),
    currency: optional('CURRENCY') || 'UAH',
    // Подарункові сертифікати «Свій принт» (потрібен KEYCRM_API_KEY): коди для замовлень сайту з товаром-сертифікатом.
    // CERT_ENABLED=0 вимикає; CERT_SOURCE_IDS - джерела KeyCRM замовлень сайту (порожньо = усі джерела)
    certEnabled: optional('CERT_ENABLED') !== '0',
    certSourceIds: idList(optional('CERT_SOURCE_IDS')),
    certProductMatch: optional('CERT_PRODUCT_MATCH') || 'сертифікат',
    certPollMinutes: number('CERT_POLL_MINUTES', 10),
    certLookbackDays: number('CERT_LOOKBACK_DAYS', 3),
    certFrom: parseDate(optional('CERT_FROM'), 'CERT_FROM'),
    // Публічна адреса цього сервера (на Render підставляється автоматично як RENDER_EXTERNAL_URL)
    publicUrl: (optional('PUBLIC_URL') || optional('RENDER_EXTERNAL_URL')).replace(/\/+$/, ''),

    // База: на Render підключіть Disk з Mount Path /data, інакше дані губляться при перезапуску
    dbPath,
    workerIntervalMs: number('WORKER_INTERVAL_SECONDS', 30) * 1000,

    // KeyCRM (необовʼязково: без ключа замовлення йдуть лише в Telegram)
    keycrmToken: optional('KEYCRM_API_KEY'),
    keycrmSourceId,
    keycrmStatusMap: parseJson(optional('KEYCRM_STATUS_MAP'), 'KEYCRM_STATUS_MAP'),
    // Служба доставки «Нова пошта» у KeyCRM (Налаштування → Служби доставки); 0 = не вказувати
    // Статус у KeyCRM, у який переводити замовлення після створення ТТН (id зі списку статусів); 0 = не змінювати
    keycrmTtnStatusId: number('KEYCRM_TTN_STATUS_ID', 0),
    keycrmNovaPoshtaServiceId: number('KEYCRM_NOVA_POSHTA_SERVICE_ID', 0),

    // Нова пошта: ключ з кабінету my.novaposhta.ua. Без нього місто й відділення вводяться вручну
    novaPoshtaApiKey: optional('NOVA_POSHTA_API_KEY'),
    // Відправка (ТТН): місто й номер відділення відправника, розміри пакета за замовчуванням
    npSenderCity: optional('NP_SENDER_CITY') || 'Чернівці',
    npSenderWarehouse: optional('NP_SENDER_WAREHOUSE') || '31',
    npSenderPhone: optional('NP_SENDER_PHONE'),
    npParcel: { weightKg: number('NP_WEIGHT_KG', 1), length: number('NP_LENGTH_CM', 30), width: number('NP_WIDTH_CM', 25), height: number('NP_HEIGHT_CM', 5) },
    // control = «Контроль оплати» (за замовчуванням), transfer = «Грошовий переказ»
    npCodMode: optional('NP_COD_MODE') === 'transfer' ? 'transfer' : 'control',
    npDescription: optional('NP_DESCRIPTION') || 'Monoclo',

    // Передоплата через Monobank (Plata by mono): без токена кнопка «Передоплата» не показується
    monobankToken: optional('MONOBANK_TOKEN'),
    prepayAmountUah: number('PREPAY_AMOUNT_UAH', 200),
    payMaxAmountUah: number('PAY_MAX_AMOUNT_UAH', 50000),
    payValiditySeconds: number('PAY_VALIDITY_HOURS', 24) * 3600,
    keycrmPaymentMethodId: number('KEYCRM_PAYMENT_METHOD_ID', 0),

    // Нагадування про замовлення без відповіді
    reminderMinutes: number('REMINDER_MINUTES', 15),
    reminderRepeatMinutes: number('REMINDER_REPEAT_MINUTES', 30),
    reminderMax: number('REMINDER_MAX', 3),
    // Нагадувати лише про замовлення, створені не раніше цієї дати (старі, наприклад тестові, ігноруються)
    remindersFrom: parseDate(optional('REMINDERS_FROM'), 'REMINDERS_FROM'),

    // Тижневий звіт: день тижня (1 = понеділок) і година за київським часом
    reportDay: number('REPORT_DAY', 1),
    reportHour: number('REPORT_HOUR', 9),

    // Щоденна резервна копія бази: на диск (BACKUP_DIR, за замовчуванням поруч із базою) і, за наявності,
    // у приватний чат Telegram (BACKUP_CHAT_ID). BACKUP_HOUR — година за київським часом.
    // Мінімум схожих покупців, щоб порадити розмір за історією (менше — лишається таблиця розмірів)
    sizeAdvisorMin: number('SIZE_ADVISOR_MIN', 5),
    // A/B-тести форми: вимкнути — AB_ENABLED=false; переможця обирають, коли різниця значуща (p<0,05)
    abEnabled: optional('AB_ENABLED') !== 'false',
    abMinViews: number('AB_MIN_VIEWS', 300),
    abMaxViews: number('AB_MAX_VIEWS', 3000),
    abMinConversions: number('AB_MIN_CONVERSIONS', 20),
    // Скільки накладних Нової пошти опитувати за раз (не більше 100, ліміт методу)
    npTrackBatch: number('NP_TRACK_BATCH', 100),
    backupHour: number('BACKUP_HOUR', 4),
    backupKeep: number('BACKUP_KEEP', 7),
    backupChatId: optional('BACKUP_CHAT_ID'),
    backupDir: optional('BACKUP_DIR') || (dbPath === ':memory:' ? '' : path.join(path.dirname(dbPath), 'backups')),

    // Покупка для реклами: оплата + ТТН → Purchase у Meta, purchase у GA4, офлайн-конверсія Google Ads
    conversions: {
      enabled: optional('CONVERSIONS_ENABLED') === '1',
      // Тестовий режим: покупки зараховуються й пишуться в лог, але нікуди не відправляються
      dryRun: optional('CONVERSIONS_DRY_RUN') === '1',
      // Не зараховувати замовлення, створені раніше цієї дати (ISO, UTC)
      from: parseDate(optional('CONVERSIONS_FROM'), 'CONVERSIONS_FROM'),
      lookbackDays: number('CONVERSIONS_LOOKBACK_DAYS', 30),
      checksPerTick: number('CONVERSIONS_CHECKS_PER_TICK', 3),
      // Статуси KeyCRM, які ніколи не стають покупкою (id через кому) і групи статусів (6 = «Скасовано»)
      excludeStatusIds: idList(optional('CONVERSIONS_EXCLUDE_STATUS_IDS')),
      excludeStatusGroupIds: idList(optional('CONVERSIONS_EXCLUDE_STATUS_GROUPS') || '6'),
      // Інші джерела KeyCRM, чиї оплачені замовлення з ТТН теж ідуть у Meta як покупка (198 = «Інстаграм | Monoclo»)
      crmSourceIds: idList(optional('CONVERSIONS_CRM_SOURCE_IDS')),
      // Замовлення, які менеджери завели вручну в джерело швидких замовлень (без номера quick-…), теж зараховувати
      crmManualQuick: optional('CONVERSIONS_CRM_MANUAL_QUICK') !== 'false',
      metaDatasetId: optional('META_DATASET_ID'),
      metaToken: optional('META_CAPI_TOKEN'),
      metaTestEventCode: optional('META_TEST_EVENT_CODE'),
      // Разово переслати в Meta вже відправлені покупки, зараховані до цієї дати (ISO, UTC): наприклад, ті, що пішли
      // з тестовим кодом. Ті самі event_id, тож Meta прибере дублі. Спрацьовує один раз на кожне значення.
      metaResendBefore: parseDate(optional('CONVERSIONS_RESEND_META_BEFORE'), 'CONVERSIONS_RESEND_META_BEFORE'),
      metaApiVersion: optional('META_API_VERSION') || 'v24.0',
      // Як товар записаний у каталозі Meta. Основний каталог Shopify (510365305413392): ID контенту = ID варіанта Shopify
      metaContentId: optional('META_CONTENT_ID') || '{variant_id}',
      gaMeasurementId: optional('GA4_MEASUREMENT_ID'),
      gaApiSecret: optional('GA4_API_SECRET'),
      gadsConversionName: optional('GADS_CONVERSION_NAME') || 'Quick order purchase',
      gadsFeedUser: optional('GADS_FEED_USER') || 'googleads',
      gadsFeedPassword: optional('GADS_FEED_PASSWORD'),
    },
  };
}
