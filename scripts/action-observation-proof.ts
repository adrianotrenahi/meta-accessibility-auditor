import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { startServer } from '../server/index.js';
import { BrowserWalk } from '../src/browser.js';

const app = await startServer(0, 'data/action-observation-proof', false);
const run = app.store.create(
  'Controlled test: retain sent input when after-reading fails',
  app.origin + '/shop/',
  'offline',
);
const walk = new BrowserWalk(app.store, run.id, app.origin, true, 'chromium');
try {
  let capture = await walk.start(run.url);
  for (let n = 0; n < 12 && (await walk.focus()).id !== 'add'; n++) {
    await walk.act(
      { kind: 'press', key: 'Tab', note: 'Reach the known controlled button by actual keys.' },
      capture,
    );
    capture = await walk.capture();
  }
  assert.equal((await walk.focus()).id, 'add');
  await walk.page.evaluate(() => {
    (window as any).__proofClicks = 0;
    document
      .querySelector('#add')!
      .addEventListener('click', () => (window as any).__proofClicks++);
  });
  app.store.append(
    run.id,
    'navigator_note',
    'action-observation-proof',
    {
      text: 'Controlled proof instrumentation counts clicks; after-input focus reading will deliberately fail. This is not a website defect.',
    },
    [capture.id],
  );
  const source = capture;
  const originalFocus = walk.focus.bind(walk);
  const beforeCount = walk.actions;
  walk.focus = async () => {
    if (walk.actions > beforeCount) throw Error('Deliberately unavailable after-action focus');
    return originalFocus();
  };
  const action = await walk.act(
    { kind: 'press', key: 'Enter', note: 'Activate exactly once; test after-reading failure.' },
    source,
  );
  walk.focus = originalFocus;
  assert.equal(action.payload.outcome, 'performed');
  assert.equal(action.payload.after, null);
  assert.equal(action.payload.sourceCaptureId, source.id);
  assert.equal(await walk.page.evaluate(() => (window as any).__proofClicks), 1);
  assert.match(await walk.page.locator('#status').innerText(), /Added to your basket/);
  assert.equal(
    app.store.records(run.id).filter((r) => r.kind === 'action' && r.payload.action.key === 'Enter')
      .length,
    1,
  );
  assert(
    app.store
      .records(run.id)
      .some(
        (r) =>
          r.kind === 'limit' &&
          r.payload.reason.includes('not evidence that the website action failed'),
      ),
  );
  app.store.finish(
    run.id,
    'complete',
    'The actual single input survives an unavailable after-reading; no website defect inferred.',
  );
  mkdirSync('output', { recursive: true });
  writeFileSync(
    'output/action-observation-proof.json',
    JSON.stringify(
      {
        runId: run.id,
        passed: true,
        singleClick: true,
        originalActionPreserved: action.id,
        afterFocus: null,
        inputRepeated: false,
        modelCalls: 0,
        spendUsd: 0,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      passed: true,
      inputRepeated: false,
      originalActionPreserved: true,
      modelCalls: 0,
    }),
  );
} finally {
  await walk.close();
  await app.close();
}
