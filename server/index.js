import http from 'node:http';
import { loadConfig } from './config.js';
import { openStore } from './store.js';
import { createApp } from './app.js';

const config = loadConfig();
const store = openStore(config.dbPath);
const app = createApp({ config, store });

console.log(`База даних: ${config.dbPath}${config.dbPath.startsWith('/data') ? '' : ' (УВАГА: не на диску Render, дані зникнуть при перезапуску)'}`);
console.log(`KeyCRM: ${app.keycrm ? `увімкнено, джерело ${config.keycrmSourceId}` : 'вимкнено (немає KEYCRM_API_KEY)'}`);

const server = http.createServer((req, res) => app.handle(req, res));
server.listen(config.port, () => {
  console.log(`quick-order слухає порт ${config.port}`);
});

// Фонова черга: повторні відправки, нагадування, тижневий звіт
let running = false;
const worker = setInterval(async () => {
  if (running) return;
  running = true;
  try {
    await app.tick();
  } catch (err) {
    console.error('worker tick failed', err);
  } finally {
    running = false;
  }
}, config.workerIntervalMs);
worker.unref();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => {
    clearInterval(worker);
    store.close();
    process.exit(0);
  }));
}
