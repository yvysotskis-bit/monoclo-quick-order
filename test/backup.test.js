import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { goodBody, makeApp, submit } from './helpers.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'qo-backup-'));
// 12:00 UTC = 14:00/15:00 за Києвом, тобто після BACKUP_HOUR
const AFTER = '2025-10-05T12:00:00Z';

test('резервна копія: файл із замовленнями, повтор того ж дня не створює нової', async () => {
  const dir = tmp();
  const { app, store, now } = makeApp({ cfg: { backupDir: dir, backupHour: 4, backupKeep: 7 }, at: AFTER });
  await submit(app, goodBody());
  await app.tick();
  const files = fs.readdirSync(dir);
  assert.equal(files.length, 1);
  assert.match(files[0], /^quick-order-2025-10-05\.db$/);
  const copy = new DatabaseSync(path.join(dir, files[0]), { readOnly: true });
  assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 1);
  copy.close();

  const mtime = fs.statSync(path.join(dir, files[0])).mtimeMs;
  now.advance(3600_000);
  await app.tick();
  assert.equal(fs.statSync(path.join(dir, files[0])).mtimeMs, mtime, 'того ж дня копія не перезаписується');
  assert.equal(store.getMeta('backup_date'), '2025-10-05');
});

test('резервна копія: до BACKUP_HOUR не створюється, зберігається лише останні N', async () => {
  const dir = tmp();
  const { app, now } = makeApp({ cfg: { backupDir: dir, backupHour: 4, backupKeep: 2 }, at: '2025-10-05T00:30:00Z' });
  await app.tick();
  assert.equal(fs.readdirSync(dir).length, 0, 'ще ніч (03:30 за Києвом)');
  now.set('2025-10-05T12:00:00Z');
  await app.tick();
  for (const day of ['06', '07']) {
    now.set(`2025-10-${day}T12:00:00Z`);
    await app.tick();
  }
  assert.deepEqual(fs.readdirSync(dir).sort(), ['quick-order-2025-10-06.db', 'quick-order-2025-10-07.db']);
});

test('резервна копія: надсилається стиснутою в чат BACKUP_CHAT_ID, без чату — нічого не шлемо', async () => {
  const dir = tmp();
  const withChat = makeApp({ cfg: { backupDir: dir, backupHour: 4, backupKeep: 7, backupChatId: '777', telegramToken: 'TT' }, at: AFTER });
  await submit(withChat.app, goodBody());
  await withChat.app.tick();
  const [doc] = withChat.fetchFn.tg('sendDocument');
  assert.ok(doc, 'документ надіслано');
  assert.equal(doc.body.get('chat_id'), '777');
  const sent = Buffer.from(await doc.body.get('document').arrayBuffer());
  assert.ok(zlib.gunzipSync(sent).subarray(0, 15).toString() === 'SQLite format 3');

  const noChat = makeApp({ cfg: { backupDir: tmp(), backupHour: 4, backupKeep: 7 }, at: AFTER });
  await noChat.app.tick();
  assert.equal(noChat.fetchFn.tg('sendDocument').length, 0);
});

test('збій надсилання копії: tick не падає, повтор не частіше за раз на 15 хв і день позначається лише після успіху', async () => {
  const dir = tmp();
  const ctx = makeApp({ cfg: { backupDir: dir, backupHour: 4, backupKeep: 7, backupChatId: '777' }, at: AFTER });
  ctx.fetchFn.fail.telegram = true;
  await ctx.app.tick();
  assert.equal(ctx.store.getMeta('backup_date'), null, 'день не позначено виконаним');
  const attempts = () => ctx.fetchFn.tg('sendDocument').length;
  assert.equal(attempts(), 1);

  ctx.fetchFn.fail.telegram = false;
  ctx.now.advance(5 * 60_000);
  await ctx.app.tick();
  assert.equal(attempts(), 1, 'за 5 хв повтору немає');
  ctx.now.advance(11 * 60_000);
  await ctx.app.tick();
  assert.equal(attempts(), 2);
  assert.equal(ctx.store.getMeta('backup_date'), '2025-10-05');
});
