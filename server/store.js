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
};

function migrate(db) {
  const existing = new Set(db.prepare('PRAGMA table_info(orders)').all().map((c) => c.name));
  for (const [name, type] of Object.entries(ADDED_COLUMNS)) {
    if (!existing.has(name)) db.exec(`ALTER TABLE orders ADD COLUMN ${name} ${type}`);
  }
  db.exec('CREATE INDEX IF NOT EXISTS orders_invoice ON orders (pay_invoice_id)');
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
      'INSERT INTO orders (order_number, client_id, fingerprint, created_at, data) VALUES (?, ?, ?, ?, ?)',
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

  crmDue(now, limit = 10) {
    return this.q(
      "SELECT * FROM orders WHERE crm_state = 'pending' AND (crm_next_at IS NULL OR crm_next_at <= ?) ORDER BY id LIMIT ?",
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

  // Повертає true, якщо спроби вичерпано й замовлення позначено як failed
  markCrmFailed(id, error, now, maxAttempts = 10) {
    const { crm_attempts: attempts } = this.db.prepare('SELECT crm_attempts FROM orders WHERE id = ?').get(id);
    const giveUp = attempts + 1 >= maxAttempts;
    this.run('UPDATE orders SET crm_attempts = ?, crm_error = ?, crm_next_at = ?, crm_state = ? WHERE id = ?',
      attempts + 1, String(error).slice(0, 300), backoff(attempts, now), giveUp ? 'failed' : 'pending', id);
    return giveUp;
  }

  /* ---- оплата ---- */

  findByInvoiceId(invoiceId) {
    return this.one('SELECT * FROM orders WHERE pay_invoice_id = ? ORDER BY id DESC LIMIT 1', invoiceId);
  }

  setPayment(id, { invoiceId, url, status, amount, createdAt }) {
    this.run(
      `UPDATE orders SET pay_invoice_id = ?, pay_url = ?, pay_status = ?, pay_amount = ?,
         pay_created_at = ?, pay_paid_at = NULL WHERE id = ?`,
      invoiceId, url, status, amount, createdAt, id,
    );
  }

  setPayStatus(id, status, paidAt = null) {
    this.run('UPDATE orders SET pay_status = ?, pay_paid_at = COALESCE(?, pay_paid_at) WHERE id = ?', status, paidAt, id);
  }

  /* ---- статуси ---- */

  setStatus(id, status, by, at) {
    this.run(
      `UPDATE orders SET status = ?, status_by = ?, status_at = ?,
         first_response_at = COALESCE(first_response_at, CASE WHEN ? = 'new' THEN NULL ELSE ? END)
       WHERE id = ?`,
      status, by, at, status, at, id,
    );
  }

  /* ---- нагадування ---- */

  reminderCandidates(max) {
    return this.q("SELECT * FROM orders WHERE status = 'new' AND tg_state = 'sent' AND reminders < ?", max);
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
