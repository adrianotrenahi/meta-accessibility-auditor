import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { sessionLock } from '../src/lock.js';
import { Store } from '../src/store.js';
import { pullShared, sharedConfig, sharedRemote } from '../src/shared-storage.js';

// npm run storage -- pull --data <folder> [--include-discarded] [--follow]
const [command] = process.argv.slice(2);
const index = process.argv.indexOf('--data');
if (command !== 'pull' || index < 0 || !process.argv[index + 1])
  throw Error('Use: npm run storage -- pull --data <folder> [--include-discarded] [--follow]');
const config = sharedConfig();
if (!config) throw Error('Shared storage is not set up on this Mac (~/.access-walk/storage.env).');
const dir = resolve(process.argv[index + 1]);
// A running engine owns its folder; pulling into it at the same time could block its saves.
mkdirSync(dir, { recursive: true, mode: 0o700 });
const release = sessionLock(dir);
const store = new Store(dir);
const remote = sharedRemote(config);
const includeDiscarded = process.argv.includes('--include-discarded');
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => (stopping = true));
try {
  do {
    console.log(JSON.stringify(await pullShared(store, remote, { includeDiscarded })));
    if (process.argv.includes('--follow') && !stopping)
      await new Promise((done) => setTimeout(done, 3000));
  } while (process.argv.includes('--follow') && !stopping);
} finally {
  store.close();
  release();
}
