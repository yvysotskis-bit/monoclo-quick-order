import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';

const gzipAsync = promisify(gzip);
const RETRY_MS = 15 * 60_000;
import { dateKey, hourOf } from './hours.js';

const PREFIX = 'quick-order-';

// Щоденна резервна копія бази: знімок SQLite на диск (останні N штук) і, якщо задано BACKUP_CHAT_ID,
// стиснутий файл у приватний чат Telegram, щоб копія пережила втрату диска Render.
export function createBackup({ config, store, telegram, fetchFn, now, log }) {
  const enabled = Boolean(config.backupDir) || Boolean(config.backupChatId);

  async function sendToTelegram(file, caption) {
    // Асинхронно: стиснення великої бази не має заморожувати сервер для замовлень і Telegram
    const gz = await gzipAsync(await fs.promises.readFile(file));
    const form = new FormData();
    form.append('chat_id', config.backupChatId);
    form.append('caption', caption);
    form.append('document', new Blob([gz]), `${path.basename(file)}.gz`);
    const res = await fetchFn(`https://api.telegram.org/bot${config.telegramToken}/sendDocument`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(60000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(`Telegram sendDocument failed: ${data.description || res.status}`);
  }

  function prune(dir) {
    const files = fs.readdirSync(dir).filter((f) => f.startsWith(PREFIX) && f.endsWith('.db')).sort();
    for (const f of files.slice(0, Math.max(files.length - config.backupKeep, 0))) fs.rmSync(path.join(dir, f), { force: true });
  }

  // Викликається з кожним tick: сама вирішує, чи пора (раз на добу після BACKUP_HOUR за київським часом)
  async function run() {
    if (!enabled) return false;
    const date = now();
    const today = dateKey(date, config.timezone);
    if (hourOf(date, config.timezone) < config.backupHour) return false;
    if (store.getMeta('backup_date') === today) return false;
    // Після збою Telegram чекаємо, а не повторюємо щоразу: інакше кожен цикл заново знімає й вантажить базу
    if (date.getTime() < Number(store.getMeta('backup_retry_at') || 0)) return false;

    const dir = config.backupDir || path.join(path.dirname(config.dbPath), 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${PREFIX}${today}.db`);
    fs.rmSync(file, { force: true });
    store.snapshot(file);
    prune(dir);
    if (config.backupChatId) {
      try {
        await sendToTelegram(file, `Резервна копія бази Quick Order ${today}`);
      } catch (err) {
        store.setMeta('backup_retry_at', date.getTime() + RETRY_MS);
        throw err;
      }
    }
    store.setMeta('backup_date', today);
    log.log(`Резервну копію створено: ${file}${config.backupChatId ? ' (і надіслано в Telegram)' : ''}`);
    return true;
  }

  return { run };
}
