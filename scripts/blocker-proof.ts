// Free real-site proof: no model request is made. Opens one public page, clears
// its consent banner and popups the way a run does, then sends six Tab presses
// and counts how many needed a new picture. Records stay in a temporary folder.
//   npm run proof:blockers -- https://www.edreams.com/
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { BrowserWalk } from '../src/browser.js';
import { clearPageBlockers } from '../src/page-blockers.js';
import { exportHostActivity } from '../src/host-activity.js';
import { exportHostSnapshot } from '../src/host-export.js';

const url = process.argv[2];
if (!url) throw Error('Pass a public website address.');
const dir = mkdtempSync(join(tmpdir(), 'blocker-proof-'));
const store = new Store(dir);
const run = store.create('Consent and popup proof', url, 'live');
const walk = new BrowserWalk(store, run.id, '', true, 'webkit', true);
const started = Date.now();
const pictures = () => store.records(run.id).filter((record) => record.kind === 'capture').length;
try {
  let current = await walk.start(url);
  if (current.payload.stable !== true) current = await walk.captureSettled(current);
  current = await clearPageBlockers(walk, store, run.id, current, new AbortController().signal, {
    arrival: true,
  });
  const before = pictures();
  for (let i = 0; i < 6; i++) {
    const performed = await walk.act({ kind: 'press', key: 'Tab', note: 'Proof' }, current);
    current = await walk.observeKeyboardMovement(current, performed);
    console.log(`Tab ${i + 1}: ${current.kind} — focus "${current.payload.focus?.name}"`);
  }
  console.log(`Pictures: ${pictures()} in total, ${pictures() - before} during six Tabs`);
  console.log(`Seconds: ${Math.round((Date.now() - started) / 1000)}`);
} catch (error) {
  console.log('Stopped:', error instanceof Error ? error.message : error);
} finally {
  for (const entry of exportHostActivity(store.records(run.id), run.id, false).entries)
    if (entry.kind !== 'action') console.log('Activity:', entry.reason);
  await walk.close();
  if (store.run(run.id).state === 'running') store.finish(run.id, 'partial', 'Proof finished.');
  exportHostSnapshot(store, run.id);
  console.log('Saved records:', join(dir, run.id), '(exported without error)');
  console.log('Model requests:', store.usage(run.id).requests.length);
}
