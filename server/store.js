import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_number TEXT NOT NULL,
  client_id TEXT,
  fingerprint TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  data TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  status_by TEXT,
  status_at INTEGER,
  first_response_at INTEGER,
  tg_state TEXT NOT NULL DEFAULT 'pending',
  tg_message_id INTEGER,
  tg_attempts INTEGER NOT NULL DEFAULT 0,
  tg_next_at INTEGER,
  tg_error TEXT,
  crm_state TEXT NOT NULL DEFAULT 'pending',
  crm_order_id INTEGER,
  crm_attempts INTEGER NOT NULL DEFAULT 0,
  crm_next_at INTEGER,
  crm_error TEXT,
  reminders INTEGER NOT NULL DEFAULT 0,
  last_reminder_at INTEGER
);
CREATE INDEX IF NOT EXISTS orders_created ON orders (created_at);
CREATE INDEX IF NOT EXISTS orders_client ON orders (client_id);
CREATE INDEX IF NOT EXISTS orders_fingerprint ON orders (fingerprint, created_at);
CREATE INDEX IF NOT EXISTS orders_message ON orders (tg_message_id);
CREATE TABLE IF NOT EXISTS hits (key TEXT NOT NULL, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS hits_key ON hits (key, at);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  invoice_id TEXT NOT NULL UNIQUE,
  amount INTEGER NOT NULL,
  kind TEXT NOT NULL,
  url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'created',
  created_by TEXT,
  created_at INTEGER NOT NULL,
  paid_at INTEGER,
  crm_synced INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS payments_order ON payments (order_id);
CREATE TABLE IF NOT EXISTS crm_purchases (
  crm_order_id INTEGER PRIMARY KEY,
  source_id INTEGER NOT NULL,
  conv_at INTEGER NOT NULL,
  value_cents INTEGER NOT NULL,
  event TEXT NOT NULL,
  meta_state TEXT,
  meta_attempts INTEGER NOT NULL DEFAULT 0,
  meta_next_at INTEGER,
  meta_error TEXT
);
CREATE TABLE IF NOT EXISTS pay_prompts (
  message_id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL,
  user_id INTEGER,
  created_at INTEGER NOT NULL
);
`;

const backoff = (attempts, now) => now + Math.min(30_000 * 2 ** attempts, 15 * 60_000);

function hydrate(row) {
  return row ? { ...row, data: JSON.parse(row.data) } : null;
}

// Нові колонки додаються до вже існуючої бази без втрати даних
const ADDED_COLUMNS = {
  pay_invoice_id: 'TEXT',
  pay_url: 'TEXT',
  pay_status: 'TEXT',
  pay_amount: 'INTEGER',
  pay_created_at: 'INTEGER',
  pay_paid_at: 'INTEGER',
  ttn_number: 'TEXT',
  ttn_ref: 'TEXT',
  crm_status: 'TEXT',
  ttn_crm_synced: 'INTEGER NOT NULL DEFAULT 0',
  // Покупка для реклами: момент, коли замовлення вперше мало і оплату, і ТТН, та сума покупки
  conv_at: 'INTEGER',
  conv_value_cents: 'INTEGER',
  conv_checked_at: 'INTEGER',
  // Відправка покупки окремо в кожен канал: null = чекає, sent, failed (спроби вичерпано), skipped, expired, dry
  meta_state: 'TEXT',
  meta_attempts: 'INTEGER NOT NULL DEFAULT 0',
  meta_next_at: 'INTEGER',
  meta_error: 'TEXT',
  ga_state: 'TEXT',
  ga_attempts: 'INTEGER NOT NULL DEFAULT 0',
  ga_next_at: 'INTEGER',
  ga_error: 'TEXT',
};

export const CONVERSION_CHANNELS = ['meta', 'ga'];

function migrate(db) {
  const existing = new Set(db.prepare('PRAGMA table_info(orders)').all().map((c) => c.name));
  for (const [name, type] of Object.entries(ADDED_COLUMNS)) {
    if (!existing.has(name)) db.exec(`ALTER TABLE orders ADD COLUMN ${name} ${type}`);
  }
  // Колонки синхронізації з'явились уже після появи замовлень: для наявних замовлень вважаємо стан у KeyCRM актуальним.
  // Інакше після оновлення старі статуси й ТТН були б повторно відправлені й перезаписали б зміни менеджерів у KeyCRM.
  // (також для баз, де колонка вже є, але замовлення створені попередньою версією без неї)
  db.exec('UPDATE orders SET crm_status = status WHERE crm_status IS NULL');
  if (!existing.has('ttn_crm_synced')) db.exec('UPDATE orders SET ttn_crm_synced = 1 WHERE ttn_number IS NOT NULL');
  db.exec('CREATE INDEX IF NOT EXISTS orders_invoice ON orders (pay_invoice_id)');
  const paymentColumns = new Set(db.prepare('PRAGMA table_info(payments)').all().map((c) => c.name));
  if (!paymentColumns.has('modified_at')) db.exec('ALTER TABLE payments ADD COLUMN modified_at INTEGER');
  if (!paymentColumns.has('polled_at')) db.exec('ALTER TABLE payments ADD COLUMN polled_at INTEGER');
  if (!paymentColumns.has('final_amount')) db.exec('ALTER TABLE payments ADD COLUMN final_amount INTEGER');
  // Рахунки зі старої схеми (один на замовлення) переносимо в таблицю платежів; в CRM вони вже потрапили
  db.exec(`INSERT OR IGNORE INTO payments (order_id, invoice_id, amount, kind, url, status, created_at, paid_at, crm_synced)
    SELECT id, pay_invoice_id, COALESCE(pay_amount, 0), 'prepay', COALESCE(pay_url, ''),
           COALESCE(pay_status, 'created'), COALESCE(pay_created_at, created_at), pay_paid_at, 1
    FROM orders WHERE pay_invoice_id IS NOT NULL`);
}

export class Store {
  constructor(db) {
    this.db = db;
  }

  q(sql, ...params) {
    return this.db.prepare(sql).all(...params).map(hydrate);
  }

  one(sql, ...params) {
    return hydrate(this.db.prepare(sql).get(...params));
  }

  run(sql, ...params) {
    return this.db.prepare(sql).run(...params);
  }

  close() {
    this.db.close();
  }

  ping() {
    this.db.prepare('SELECT 1').get();
    return true;
  }

  /* ---- ліміти запитів ---- */

  // true — дозволено (і запит зараховано)
  takeHit(key, limit, windowMs, now = Date.now()) {
    this.run('DELETE FROM hits WHERE key = ? AND at < ?', key, now - windowMs);
    const { n } = this.db.prepare('SELECT COUNT(*) AS n FROM hits WHERE key = ?').get(key);
    if (n >= limit) return false;
    this.run('INSERT INTO hits (key, at) VALUES (?, ?)', key, now);
    if (Math.random() < 0.02) this.run('DELETE FROM hits WHERE at < ?', now - 24 * 3600e3);
    return true;
  }

  /* ---- замовлення ---- */

  findDuplicate({ clientId, fingerprint, since }) {
    if (clientId) {
      const byId = this.one('SELECT * FROM orders WHERE client_id = ? ORDER BY id DESC LIMIT 1', clientId);
      if (byId) return byId;
    }
    return this.one('SELECT * FROM orders WHERE fingerprint = ? AND created_at >= ? ORDER BY id DESC LIMIT 1',
      fingerprint, since);
  }

  uniqueOrderNumber(base) {
    let candidate = base;
    for (let i = 2; this.db.prepare('SELECT 1 FROM orders WHERE order_number = ?').get(candidate); i += 1) {
      candidate = `${base}-${i}`;
    }
    return candidate;
  }

  insertOrder({ orderNumber, clientId, fingerprint, createdAt, data }) {
    const { lastInsertRowid } = this.run(
      "INSERT INTO orders (order_number, client_id, fingerprint, created_at, data, crm_status) VALUES (?, ?, ?, ?, ?, 'new')",
      this.uniqueOrderNumber(orderNumber), clientId || null, fingerprint, createdAt, JSON.stringify(data),
    );
    return this.getOrder(Number(lastInsertRowid));
  }

  getOrder(id) {
    return this.one('SELECT * FROM orders WHERE id = ?', id);
  }

  findByMessageId(messageId) {
    return this.one('SELECT * FROM orders WHERE tg_message_id = ? ORDER BY id DESC LIMIT 1', messageId);
  }

  /* ---- Telegram ---- */

  telegramDue(now, limit = 10) {
    return this.q(
      "SELECT * FROM orders WHERE tg_state = 'pending' AND (tg_next_at IS NULL OR tg_next_at <= ?) ORDER BY id LIMIT ?",
      now, limit,
    );
  }

  markTelegramSent(id, messageId) {
    this.run("UPDATE orders SET tg_state = 'sent', tg_message_id = ?, tg_error = NULL, tg_next_at = NULL WHERE id = ?",
      messageId, id);
  }

  markTelegramFailed(id, error, now) {
    const { tg_attempts: attempts } = this.db.prepare('SELECT tg_attempts FROM orders WHERE id = ?').get(id);
    this.run('UPDATE orders SET tg_attempts = ?, tg_error = ?, tg_next_at = ? WHERE id = ?',
      attempts + 1, String(error).slice(0, 300), backoff(attempts, now), id);
  }

  oldestPendingTelegram() {
    return this.db.prepare("SELECT MIN(created_at) AS at FROM orders WHERE tg_state = 'pending'").get().at;
  }

  /* ---- KeyCRM ---- */

  // Замовлення зі станом failed теж повертаються в чергу (раз на кілька годин): воно не має загубитися назавжди
  crmDue(now, limit = 10) {
    return this.q(
      "SELECT * FROM orders WHERE crm_state IN ('pending', 'failed') AND (crm_next_at IS NULL OR crm_next_at <= ?) ORDER BY id LIMIT ?",
      now, limit,
    );
  }

  markCrmSent(id, crmOrderId) {
    this.run("UPDATE orders SET crm_state = 'sent', crm_order_id = ?, crm_error = NULL, crm_next_at = NULL WHERE id = ?",
      crmOrderId, id);
  }

  markCrmSkipped(id) {
    this.run("UPDATE orders SET crm_state = 'skipped' WHERE id = ?", id);
  }

  // Повертає true лише в момент, коли спроби вичерпано й замовлення стало failed (менеджера попереджаємо один раз).
  // Далі спроба повторюється раз на 6 годин.
  markCrmFailed(id, error, now, maxAttempts = 10) {
    const row = this.db.prepare('SELECT crm_attempts, crm_state FROM orders WHERE id = ?').get(id);
    const giveUp = row.crm_attempts + 1 >= maxAttempts;
    this.run('UPDATE orders SET crm_attempts = ?, crm_error = ?, crm_next_at = ?, crm_state = ? WHERE id = ?',
      row.crm_attempts + 1, String(error).slice(0, 300), giveUp ? now + 6 * 3600e3 : backoff(row.crm_attempts, now),
      giveUp ? 'failed' : 'pending', id);
    return giveUp && row.crm_state !== 'failed';
  }

  // Замовлення, статус яких у KeyCRM ще не збігається з нашим (оновлення могло не пройти)
  statusDrift(limit = 10) {
    return this.q(
      "SELECT * FROM orders WHERE crm_order_id IS NOT NULL AND status != COALESCE(crm_status, 'new') ORDER BY id LIMIT ?",
      limit,
    );
  }

  markCrmStatus(id, status) {
    this.run('UPDATE orders SET crm_status = ? WHERE id = ?', status, id);
  }

  /* ---- оплата ---- */

  insertPayment({ orderId, invoiceId, amount, kind, url, createdBy, createdAt }) {
    const { lastInsertRowid } = this.run(
      'INSERT INTO payments (order_id, invoice_id, amount, kind, url, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      orderId, invoiceId, amount, kind, url, createdBy || null, createdAt,
    );
    return Number(lastInsertRowid);
  }

  getPayment(id) {
    return this.db.prepare('SELECT * FROM payments WHERE id = ?').get(id) || null;
  }

  findPaymentByInvoice(invoiceId) {
    return this.db.prepare('SELECT * FROM payments WHERE invoice_id = ?').get(invoiceId) || null;
  }

  paymentsForOrder(orderId) {
    return this.db.prepare('SELECT * FROM payments WHERE order_id = ? ORDER BY id').all(orderId);
  }

  // Рахунки, що ще можна оплатити (створені після `since` і не завершені)
  activePayments(orderId, since) {
    return this.db.prepare(
      "SELECT * FROM payments WHERE order_id = ? AND status IN ('created', 'processing') AND created_at >= ? ORDER BY id",
    ).all(orderId, since);
  }

  // Рахунки, оплату яких варто перевірити в банку (вебхук міг не дійти): ще не завершені, не старші за термін дії + запас.
  // Перша перевірка через 3 хв після створення, далі кожні 5 хв першу годину і кожні 30 хв після.
  pollablePayments(now, validityMs, limit = 5) {
    return this.db.prepare(
      `SELECT * FROM payments
       WHERE status IN ('created', 'processing', 'hold')
         AND created_at >= ? AND created_at <= ?
         AND (polled_at IS NULL OR polled_at <= ? - CASE WHEN ? - created_at < 3600000 THEN 300000 ELSE 1800000 END)
       ORDER BY COALESCE(polled_at, 0), id LIMIT ?`,
    ).all(now - validityMs - 6 * 3600e3, now - 180_000, now, now, limit);
  }

  setFinalAmount(id, amount) {
    this.run('UPDATE payments SET final_amount = ? WHERE id = ?', amount, id);
  }

  markPolled(id, at) {
    this.run('UPDATE payments SET polled_at = ? WHERE id = ?', at, id);
  }

  setPaymentStatus(id, status, paidAt = null, modifiedAt = null) {
    this.run('UPDATE payments SET status = ?, paid_at = COALESCE(?, paid_at), modified_at = COALESCE(?, modified_at) WHERE id = ?',
      status, paidAt, modifiedAt, id);
  }

  // Сума отриманих оплат за замовленням, у копійках
  paidTotal(orderId) {
    // finalAmount банку = сума після повернень; якщо його ще не було, беремо суму рахунку
    return this.db.prepare("SELECT COALESCE(SUM(COALESCE(final_amount, amount)), 0) AS n FROM payments WHERE order_id = ? AND status = 'success'")
      .get(orderId).n;
  }

  unsyncedPayments() {
    return this.db.prepare(
      `SELECT p.* FROM payments p JOIN orders o ON o.id = p.order_id
       WHERE p.status = 'success' AND p.crm_synced = 0 AND o.crm_order_id IS NOT NULL ORDER BY p.id`,
    ).all();
  }

  markPaymentSynced(id) {
    this.run('UPDATE payments SET crm_synced = 1 WHERE id = ?', id);
  }

  paidSince(since) {
    return this.db.prepare(
      "SELECT id, order_id, invoice_id, kind, status, paid_at, COALESCE(final_amount, amount) AS amount FROM payments WHERE status = 'success' AND paid_at >= ? ORDER BY id",
    ).all(since);
  }

  /* ---- запити суми (відповідь менеджера на повідомлення бота) ---- */

  insertPrompt({ messageId, orderId, userId, createdAt }) {
    this.run('INSERT OR REPLACE INTO pay_prompts (message_id, order_id, user_id, created_at) VALUES (?, ?, ?, ?)',
      messageId, orderId, userId ?? null, createdAt);
  }

  findPrompt(messageId) {
    return this.db.prepare('SELECT * FROM pay_prompts WHERE message_id = ?').get(messageId) || null;
  }

  deletePrompt(messageId) {
    this.run('DELETE FROM pay_prompts WHERE message_id = ?', messageId);
  }

  pruneOldPrompts(before) {
    this.run('DELETE FROM pay_prompts WHERE created_at < ?', before);
  }

  /* ---- статуси ---- */

  setTtn(id, number, ref) {
    this.run('UPDATE orders SET ttn_number = ?, ttn_ref = ?, ttn_crm_synced = 0 WHERE id = ?', number, ref, id);
  }

  // ТТН створено, але ще не записано в KeyCRM
  ttnNotInCrm(limit = 10) {
    return this.q('SELECT * FROM orders WHERE ttn_number IS NOT NULL AND crm_order_id IS NOT NULL AND ttn_crm_synced = 0 ORDER BY id LIMIT ?', limit);
  }

  markTtnInCrm(id) {
    this.run('UPDATE orders SET ttn_crm_synced = 1 WHERE id = ?', id);
  }

  setStatus(id, status, by, at) {
    this.run(
      `UPDATE orders SET status = ?, status_by = ?, status_at = ?,
         first_response_at = COALESCE(first_response_at, CASE WHEN ? = 'new' THEN NULL ELSE ? END)
       WHERE id = ?`,
      status, by, at, status, at, id,
    );
  }

  /* ---- покупка для реклами ---- */

  // Замовлення, які ще можуть стати покупкою: не спам і не скасовані, ще не зараховані, свіжі.
  // Свіжі перевіряються частіше: до 2 діб раз на 20 хв, до 7 діб раз на 2 год, далі раз на 6 год
  // (так KeyCRM отримує кілька запитів на хвилину навіть за сотень замовлень).
  conversionCandidates(now, since, limit = 3) {
    return this.q(
      `SELECT * FROM orders
       WHERE conv_at IS NULL AND created_at >= ? AND status NOT IN ('spam', 'cancelled')
         AND (conv_checked_at IS NULL OR conv_checked_at <= ? - CASE
               WHEN ? - created_at < 172800000 THEN 1200000
               WHEN ? - created_at < 604800000 THEN 7200000
               ELSE 21600000 END)
       ORDER BY COALESCE(conv_checked_at, 0), id LIMIT ?`,
      since, now, now, now, limit,
    );
  }

  markConversionChecked(id, at) {
    this.run('UPDATE orders SET conv_checked_at = ? WHERE id = ?', at, id);
  }

  // Повертає false, якщо замовлення вже зараховане (повторний виклик нічого не змінює)
  markConversion(id, at, valueCents) {
    return this.run('UPDATE orders SET conv_at = ?, conv_value_cents = ?, conv_checked_at = ? WHERE id = ? AND conv_at IS NULL',
      at, valueCents, at, id).changes > 0;
  }

  // Зараховані покупки, які ще треба відправити в канал (meta | ga). У тестовому режимі (dry) нічого не відправляється,
  // а після його вимкнення ці покупки відправляються по-справжньому.
  conversionDue(channel, now, { dryRun = false, limit = 10 } = {}) {
    if (!CONVERSION_CHANNELS.includes(channel)) throw new Error(`unknown channel ${channel}`);
    const states = dryRun ? `${channel}_state IS NULL` : `(${channel}_state IS NULL OR ${channel}_state = 'dry')`;
    return this.q(
      `SELECT * FROM orders WHERE conv_at IS NOT NULL AND ${states}
         AND (${channel}_next_at IS NULL OR ${channel}_next_at <= ?) ORDER BY conv_at, id LIMIT ?`,
      now, limit,
    );
  }

  setConversionState(channel, id, state, error = null) {
    if (!CONVERSION_CHANNELS.includes(channel)) throw new Error(`unknown channel ${channel}`);
    this.run(`UPDATE orders SET ${channel}_state = ?, ${channel}_error = ?, ${channel}_next_at = NULL WHERE id = ?`,
      state, error ? String(error).slice(0, 300) : null, id);
  }

  // Збій каналу: повтор з наростаючою паузою (30 с … 1 год), доки покупка не застаріє для каналу (тоді expired).
  // Тривалий збій (наприклад, протермінований токен Meta) не губить покупки: після заміни токена вони підуть.
  // Повертає номер спроби.
  markConversionFailed(channel, id, error, now) {
    if (!CONVERSION_CHANNELS.includes(channel)) throw new Error(`unknown channel ${channel}`);
    const row = this.db.prepare(`SELECT ${channel}_attempts AS n FROM orders WHERE id = ?`).get(id);
    this.run(`UPDATE orders SET ${channel}_attempts = ?, ${channel}_error = ?, ${channel}_next_at = ? WHERE id = ?`,
      row.n + 1, String(error).slice(0, 300), now + Math.min(30_000 * 2 ** row.n, 3600e3), id);
    return row.n + 1;
  }

  // Зараховані покупки за період (для файлу офлайн-конверсій Google Ads)
  // Спам і скасовані після зарахування з файлу прибираються (Google Ads їх ще не імпортував або імпортує без них)
  conversionsSince(since) {
    return this.q("SELECT * FROM orders WHERE conv_at IS NOT NULL AND conv_at >= ? AND status NOT IN ('spam', 'cancelled') ORDER BY conv_at, id", since);
  }

  // Повторна відправка в Meta: відправлені покупки, зараховані до before, знову стають у чергу. Повертає кількість.
  resetMetaSent(before) {
    const reset = 'meta_state = NULL, meta_attempts = 0, meta_error = NULL, meta_next_at = NULL';
    const orders = this.run(`UPDATE orders SET ${reset} WHERE meta_state = 'sent' AND conv_at < ?`, before).changes;
    const crm = this.run(`UPDATE crm_purchases SET ${reset} WHERE meta_state = 'sent' AND conv_at < ?`, before).changes;
    return { orders: Number(orders), crm: Number(crm) };
  }

  /* ---- покупки з інших джерел KeyCRM (Instagram Direct) ---- */

  // true, якщо покупку додано вперше (повторне зарахування того самого замовлення ігнорується)
  insertCrmPurchase({ crmOrderId, sourceId, convAt, valueCents, event }) {
    return this.run('INSERT OR IGNORE INTO crm_purchases (crm_order_id, source_id, conv_at, value_cents, event) VALUES (?, ?, ?, ?, ?)',
      crmOrderId, sourceId, convAt, valueCents, JSON.stringify(event)).changes > 0;
  }

  hasCrmPurchase(crmOrderId) {
    return Boolean(this.db.prepare('SELECT 1 FROM crm_purchases WHERE crm_order_id = ?').get(crmOrderId));
  }

  crmPurchasesDue(now, { dryRun = false, limit = 10 } = {}) {
    const states = dryRun ? 'meta_state IS NULL' : "(meta_state IS NULL OR meta_state = 'dry')";
    return this.db.prepare(`SELECT * FROM crm_purchases WHERE ${states} AND (meta_next_at IS NULL OR meta_next_at <= ?) ORDER BY conv_at LIMIT ?`)
      .all(now, limit).map((r) => ({ ...r, event: JSON.parse(r.event) }));
  }

  setCrmPurchaseState(crmOrderId, state, error = null) {
    this.run('UPDATE crm_purchases SET meta_state = ?, meta_error = ?, meta_next_at = NULL WHERE crm_order_id = ?',
      state, error ? String(error).slice(0, 300) : null, crmOrderId);
  }

  markCrmPurchaseFailed(crmOrderId, error, now) {
    const row = this.db.prepare('SELECT meta_attempts AS n FROM crm_purchases WHERE crm_order_id = ?').get(crmOrderId);
    this.run('UPDATE crm_purchases SET meta_attempts = ?, meta_error = ?, meta_next_at = ? WHERE crm_order_id = ?',
      row.n + 1, String(error).slice(0, 300), now + Math.min(30_000 * 2 ** row.n, 3600e3), crmOrderId);
    return row.n + 1;
  }

  conversionCounts() {
    const row = this.db.prepare(
      `SELECT COUNT(*) AS qualified,
         SUM(meta_state = 'sent') AS meta_sent, SUM(meta_state IS NULL AND meta_error IS NOT NULL) AS meta_retrying,
         SUM(ga_state = 'sent') AS ga_sent, SUM(ga_state IS NULL AND ga_error IS NOT NULL) AS ga_retrying
       FROM orders WHERE conv_at IS NOT NULL`,
    ).get();
    const crm = this.db.prepare(
      `SELECT COUNT(*) AS crm_qualified, SUM(meta_state = 'sent') AS crm_meta_sent,
         SUM(meta_state IS NULL AND meta_error IS NOT NULL) AS crm_meta_retrying FROM crm_purchases`,
    ).get();
    return Object.fromEntries(Object.entries({ ...row, ...crm }).map(([k, v]) => [k, v || 0]));
  }

  /* ---- нагадування ---- */

  reminderCandidates(max, since = 0) {
    return this.q(
      "SELECT * FROM orders WHERE status = 'new' AND tg_state = 'sent' AND reminders < ? AND created_at >= ?",
      max, since,
    );
  }

  markReminded(id, at) {
    this.run('UPDATE orders SET reminders = reminders + 1, last_reminder_at = ? WHERE id = ?', at, id);
  }

  /* ---- звіт та моніторинг ---- */

  ordersSince(since) {
    return this.q('SELECT * FROM orders WHERE created_at >= ? ORDER BY id', since);
  }

  counts() {
    return {
      pendingTelegram: this.db.prepare("SELECT COUNT(*) AS n FROM orders WHERE tg_state = 'pending'").get().n,
      pendingCrm: this.db.prepare("SELECT COUNT(*) AS n FROM orders WHERE crm_state = 'pending'").get().n,
      failedCrm: this.db.prepare("SELECT COUNT(*) AS n FROM orders WHERE crm_state = 'failed'").get().n,
    };
  }

  // Узгоджений знімок бази в окремий файл (безпечно при активних записах)
  snapshot(file) {
    this.db.exec(`VACUUM INTO '${String(file).replace(/'/g, "''")}'`);
  }

  getMeta(key) {
    return this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
  }

  setMeta(key, value) {
    this.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      key, String(value));
  }
}

export function openStore(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;');
  db.exec(SCHEMA);
  migrate(db);
  return new Store(db);
}
