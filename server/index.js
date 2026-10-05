import http from 'node:http';
import { loadConfig } from './config.js';
import { createApp } from './app.js';

const config = loadConfig();
const app = createApp({ config });

const server = http.createServer((req, res) => app.handle(req, res));
server.listen(config.port, () => {
  console.log(`quick-order слухає порт ${config.port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
