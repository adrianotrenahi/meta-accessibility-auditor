import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { startServer } from '../server/index.js';
import { BrowserWalk } from '../src/browser.js';
import { Runner } from '../src/runner.js';
import { walkToKeyboardTarget } from '../src/keyboard-target.js';
import { exportHostSnapshot } from '../src/host-export.js';
import { declareCriterionScopes } from '../src/assessment.js';
import type { RecordEntry } from '../src/types.js';
import type { Action } from '../src/models.js';

const out = resolve(process.argv[process.argv.indexOf('--out') + 1] ?? '');
if (!process.argv.includes('--out')) throw Error('Pass --out with a fresh local proof folder.');
await mkdir(out, { recursive: false });
const app = await startServer(0, join(out, 'data'), false);
const run = app.store.create(
  'Reach Target and retain meaningful screen states',
  app.origin + '/shop/',
  'offline',
);
const walk = new BrowserWalk(app.store, run.id, app.origin, true, 'chromium');
try {
  await walk.start(run.url);
  const fixtureUrl = app.origin + '/shop/state-fixture';
  const html =
    '<title>Controlled state shop</title><style>button:focus{outline:3px solid blue}body{font:20px sans-serif;padding:30px}button,a{margin:20px}</style><h1>Controlled state shop</h1><button>A</button><a href="#b">B</a><button id="target">Target</button><button id="add"><span aria-hidden="true">+</span></button><dialog><h2>Cookie choices</h2><button>Reject optional cookies</button></dialog>';
  await walk.page.route(fixtureUrl, (route) =>
    route.fulfill({ contentType: 'text/html', body: html }),
  );
  await walk.page.goto(fixtureUrl);
  const before = await walk.captureSettled();
  const measured = await walk.measurements(before);
  const captureCount = app.store.records(run.id).filter((r) => r.kind === 'capture').length;
  const runner = new Runner(app.store, app.origin);
  const step = (source: RecordEntry, action: Action, guard?: () => Promise<boolean>) =>
    (runner as any).targetKeyboardStep(run, walk, source, action, guard);
  const moved = await walkToKeyboardTarget(
    walk,
    app.store,
    run.id,
    before,
    { kind: 'focus_target', targetRole: 'button', targetName: 'Target', note: 'Reach Target' },
    new AbortController().signal,
    step,
  );
  assert.equal(moved.outcome, 'reached');
  assert.equal(moved.actions.length, 3);
  assert.equal(app.store.records(run.id).filter((r) => r.kind === 'capture').length, captureCount);
  const focus = await walk.captureSettled();
  assert.equal(focus.payload.screenState.purpose, 'same-state-evidence');
  const target = focus.payload.elements.find((element: any) => element.selector === '#add');
  assert.equal(target.name, '');
  const candidate = app.store.append(
    run.id,
    'candidate',
    'saved_analyst_response',
    {
      title: 'The Add button has no accessible name',
      detail: 'The original control exposes no accessible name.',
      recommendation: 'Give the button an accessible name.',
      criterion: 'C02',
      basis: 'measured',
      severity: 'serious',
      targetId: target.id,
      targetCaptureId: focus.id,
    },
    [before.id, focus.id, measured.id],
  );
  await walk.page
    .locator('dialog')
    .evaluate((element) => (element as HTMLDialogElement).showModal());
  const dialog = await walk.captureSettled();
  assert.notEqual(dialog.id, focus.id);
  assert.notEqual(dialog.payload.screenState?.purpose, 'same-state-evidence');
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
      sources: [before.id, focus.id, measured.id],
      readSnapshotId: read.read.id,
    },
    [candidate.id, before.id, focus.id, measured.id, read.read.id],
  );
  declareCriterionScopes(app.store, run.id);
  app.store.finish(
    run.id,
    'partial',
    'Controlled original states and saved analysis example; no model or native-reader inference.',
  );
  const exported = exportHostSnapshot(app.store, run.id);
  assert.equal(exported.snapshot.findings.length, 1);
  assert.equal(app.store.usage().requests.length, 0);
  const fixture = join(out, 'fixture');
  await mkdir(join(fixture, 'images'), { recursive: true });
  for (const [name, image] of exported.assets) await writeFile(join(fixture, name), image);
  await writeFile(join(fixture, 'state.json'), JSON.stringify(exported.snapshot, null, 2));
  await writeFile(
    join(fixture, 'index.json'),
    JSON.stringify({
      protocol: 'access-walk/replay-v1',
      snapshots: ['state.json'],
      modelCalls: 0,
      creditsSpent: 0,
    }),
  );
  await writeFile(
    join(out, 'receipt.json'),
    JSON.stringify(
      {
        originalCount: exported.snapshot.captures.length,
        expectedScreenCount: 3,
        rawTabCount: moved.actions.length,
        imagesDuringTabs: 0,
        focusImageHash: focus.payload.imageHash,
        primaryImageHash: before.payload.imageHash,
        sourceCaptureIds: exported.snapshot.findings[0]!.captureIds,
        separateOriginalCriterionScopes: app.store
          .records(run.id)
          .filter((r) => r.kind === 'criterion_scope').length,
        modelCalls: 0,
        creditsSpent: 0,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      fixture,
      originals: exported.snapshot.captures.length,
      realTabs: 3,
      imagesDuringTabs: 0,
      modelCalls: 0,
    }),
  );
} finally {
  await walk.close();
  await app.close();
}
