import { resolve } from 'node:path';
import { startServer } from '../server/index.js';
const index = process.argv.indexOf('--data');
if (index < 0 || !process.argv[index + 1])
  throw Error('Pass --data with a dedicated local run folder.');
const app = await startServer(0, resolve(process.argv[index + 1]), false);
console.log(JSON.stringify({ protocol: 'access-walk/host-v1', origin: app.origin }));
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    void app.close().then(() => process.exit());
  });
