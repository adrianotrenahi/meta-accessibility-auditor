import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
import { startServer } from '../server/index.js';
import { BrowserWalk } from '../src/browser.js';
import { exportHostSnapshot } from '../src/host-export.js';

const output = resolve(process.argv[process.argv.indexOf('--out') + 1] ?? 'output/host-proof');
if (process.argv.indexOf('--out') < 0) throw Error('Supply --out with the proof output folder.');
const portIndex = process.argv.indexOf('--port');
const port = portIndex < 0 ? 4340 : Number(process.argv[portIndex + 1]);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw Error('Pass --port with an available local port from 1 to 65535.');
const temporary = mkdtempSync(join(tmpdir(), 'access-walk-host-'));
let app: Awaited<ReturnType<typeof startServer>>;
try {
  app = await startServer(port, temporary, false);
} catch {
  rmSync(temporary, { recursive: true, force: true });
  throw Error(
    `The local proof could not start on port ${port}. Retry with --port and a different unused local port.`,
  );
}
const run = app.store.create(
  'Add the canvas bag and open the basket, stopping before review.',
  app.origin + '/shop/?case=broken',
  'offline',
);
const walk = new BrowserWalk(app.store, run.id, app.origin, true, 'chromium');
const previousFetch = globalThis.fetch;
globalThis.fetch = async () => {
  throw Error('This offline proof cannot make a model or service request.');
};
try {
  let capture = await walk.start(run.url);
  const original = capture;
  const scan = await walk.measurements(capture);
  assert(scan.payload.violations.some((v: { id: string }) => v.id === 'button-name'));
  const target = capture.payload.elements.find(
    (element: { tag: string }) => element.tag === 'button',
  );
  assert(target && target.name === '');
  const candidate = app.store.append(
    run.id,
    'candidate',
    'saved_analyst_response',
    {
      title: 'The add-to-basket button has no accessible name',
      detail:
        'The original product page exposes an unnamed button. The saved automatic button-name measurement supports this naming finding; no spoken output is inferred.',
      recommendation: 'Give the button a useful accessible name such as Add to basket.',
      criterion: 'C02',
      basis: 'measured',
      severity: 'serious',
      targetId: target.id,
    },
    [capture.id, scan.id],
  );
  function review() {
    const read = app.store.snapshot(run.id, 'reviewer');
    app.store.append(
      run.id,
      'review',
      'saved_reviewer_response',
      {
        candidateId: candidate.id,
        candidateHash: candidate.hash,
        verdict: 'keep',
        title: candidate.payload.title,
        reason:
          'Saved review example: the exact original button-name measurement supports this scoped claim. Real VoiceOver and SAM are not established.',
        sources: [original.id, scan.id],
        readSnapshotId: read.read.id,
      },
      [candidate.id, original.id, scan.id, read.read.id],
    );
  }
  review();
  const initial = exportHostSnapshot(app.store, run.id);
  const states = [{ name: 'initial.json', result: initial }];
  for (const key of ['Tab', 'Tab', 'Tab', 'Enter', 'Tab', 'Enter'] as const) {
    await walk.act(
      {
        kind: 'press',
        key,
        note: 'Offline compatibility proof: real keyboard action on the controlled shop.',
      },
      capture,
    );
    capture = await walk.capture();
    states.push({
      name: `after-action-${states.length}.json`,
      result: exportHostSnapshot(app.store, run.id),
    });
  }
  assert(capture.payload.url.includes('/basket'));
  review();
  app.store.append(
    run.id,
    'coverage',
    'offline-proof',
    {
      method: 'real_VoiceOver',
      state: 'NOT_TESTED',
      reason: 'Saved-record compatibility proof; no native screen-reader or model request.',
    },
    [capture.id],
  );
  app.store.finish(
    run.id,
    'partial',
    'Controlled basket goal reached. This saved-record proof is not a complete accessibility assessment; VoiceOver and SAM are not tested.',
  );
  const final = exportHostSnapshot(app.store, run.id);
  states.push({ name: 'final.json', result: final });
  mkdirSync(join(output, 'images'), { recursive: true });
  for (const state of states) {
    for (const [name, bytes] of state.result.assets) writeFileSync(join(output, name), bytes);
    writeFileSync(join(output, state.name), JSON.stringify(state.result.snapshot, null, 2) + '\n');
  }
  writeFileSync(
    join(output, 'index.json'),
    JSON.stringify(
      {
        protocol: 'access-walk/replay-v1',
        snapshots: states.map((state) => state.name),
        label:
          'Offline compatibility proof: real controlled browser captures, saved analysis/review examples, no model calls.',
        liveFrameCaptureProven: false,
        modelCalls: 0,
        creditsSpent: 0,
      },
      null,
      2,
    ) + '\n',
  );
  assert.equal(app.store.usage(run.id).requests.length, 0);
  console.log(
    JSON.stringify({
      output,
      runId: run.id,
      captures: final.snapshot.captures.length,
      findings: final.snapshot.findings.length,
      actions: walk.actions - 1,
      modelCalls: 0,
      creditsSpent: 0,
    }),
  );
} finally {
  globalThis.fetch = previousFetch;
  await walk.close();
  await app.close();
  rmSync(temporary, { recursive: true, force: true });
}
