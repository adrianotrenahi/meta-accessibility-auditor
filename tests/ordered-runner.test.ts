import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, digest } from '../src/store.js';
import { Runner } from '../src/runner.js';
import { BrowserWalk } from '../src/browser.js';
import { VoiceOverProbe } from '../src/voiceover.js';
import { MetaModels } from '../src/models.js';
import { startServer } from '../server/index.js';
import { ORDERED_JOURNEY_VERSION, readOrderedJourney } from '../src/journey-steps.js';
import type { Approval } from '../src/types.js';

const steps = [
  {
    id: 'open',
    text: 'Open the requested page.',
    intent: 'navigate' as const,
    success: 'The requested page is visible.',
  },
  {
    id: 'check',
    text: 'Inspect the available search.',
    intent: 'verify' as const,
    success: 'The search control is visible.',
  },
];
const approved = (): Approval => ({
  approvedBy: 'Adriano',
  approvedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60000).toISOString(),
  maxUsd: 10,
  maxRunUsd: 3,
});

test('Explicit Start reuses the activated preparation, creates a separate approved execution plan and retains its charge', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ordered-start-'));
  const store = new Store(dir);
  const binding = {
    draftId: randomUUID(),
    ownerHash: digest('synthetic owner'),
    briefHash: digest('synthetic brief'),
    url: 'https://example.com/',
    goal: 'Inspect search without buying.',
  };
  const draft = store.claimJourneyDraft(binding);
  const id = store.reserve(draft.run.id, 'driver', 1000, approved(), false, 'planning');
  store.settle(id, 123, 'completed');
  store.append(draft.run.id, 'model_response', 'driver', {
    requestId: id,
    status: 'completed',
    output: [
      { type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ steps }) }] },
    ],
  });
  const ready = store.prepareJourneyDraft(binding, {
    proposalVersion: 'journey-proposal/1',
    steps,
  });
  const proposal = JSON.stringify(ready.plan);
  let browserStarts = 0;
  t.mock.method(BrowserWalk.prototype, 'start', async () => {
    browserStarts++;
    throw Error('Synthetic browser launch stopped before any actual browser work.');
  });
  const runner = new Runner(store, 'http://127.0.0.1:4317', approved);
  try {
    assert.equal(browserStarts, 0);
    assert.equal(runner.active, undefined);
    assert.equal(
      readOrderedJourney(store.records(draft.run.id)),
      null,
      'A proposal cannot act as an execution plan.',
    );
    await assert.rejects(
      runner.start({
        mode: 'live',
        requestId: randomUUID(),
        prepared: { run: ready.run, proposalId: ready.plan!.id, proposalHash: ready.plan!.hash },
      }),
    );
    assert.equal(browserStarts, 0, 'Preparation alone cannot construct an active browser.');
    const requestId = randomUUID();
    const activated = store.activateJourneyDraft(binding, {
      requestId,
      planId: ready.plan!.id,
      planHash: ready.plan!.hash,
      approval: approved(),
    });
    await assert.rejects(
      runner.start({
        mode: 'live',
        requestId,
        prepared: {
          run: activated.run,
          proposalId: ready.plan!.id,
          proposalHash: digest('changed'),
        },
      }),
    );
    await assert.rejects(
      runner.start({
        mode: 'live',
        requestId,
        url: 'https://different.example/',
        prepared: {
          run: activated.run,
          proposalId: ready.plan!.id,
          proposalHash: ready.plan!.hash,
        },
      }),
    );
    await assert.rejects(
      runner.start({
        mode: 'live',
        requestId,
        steps: [{ ...steps[0]!, success: '' }],
        prepared: {
          run: activated.run,
          proposalId: ready.plan!.id,
          proposalHash: ready.plan!.hash,
        },
      }),
    );
    assert.equal(browserStarts, 0);
    const started = await runner.start({
      mode: 'live',
      requestId,
      steps: [steps[1]!],
      voiceOver: false,
      prepared: { run: activated.run, proposalId: ready.plan!.id, proposalHash: ready.plan!.hash },
    });
    await runner.completion;
    assert.equal(started.id, draft.run.id);
    assert.equal(store.runs().length, 1);
    assert.equal(browserStarts, 1);
    assert.equal(store.usage(started.id).spent, 123);
    assert.equal(store.usage(started.id).requests.length, 1);
    assert.equal(JSON.stringify(store.record(started.id, ready.plan!.id)), proposal);
    const execution = store
      .records(started.id)
      .find(
        (record) =>
          record.kind === 'plan' && record.payload.executionVersion === ORDERED_JOURNEY_VERSION,
      )!;
    assert(execution);
    assert.notEqual(execution.id, ready.plan!.id);
    assert.deepEqual(execution.sources, [ready.plan!.id]);
    assert.equal(execution.payload.proposalHash, ready.plan!.hash);
    assert.equal(execution.payload.stepsOrigin, 'owner-edited-approved-plan');
    assert.deepEqual(execution.payload.steps, [steps[1]]);
    assert.equal(readOrderedJourney(store.records(started.id))?.steps.length, 1);
    assert.equal(store.run(started.id).state, 'partial');
    store.append(started.id, 'plan', 'driver', {
      executionVersion: ORDERED_JOURNEY_VERSION,
      steps,
    });
    assert.throws(() => readOrderedJourney(store.records(started.id)), /more than one/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

async function fixture(ordered = true, planningCharge = true) {
  const dir = mkdtempSync(join(tmpdir(), 'ordered-runner-'));
  const app = await startServer(0, dir, false);
  const run = app.store.create(
    'Synthetic ordered walk; no model calls.',
    app.origin + '/shop/',
    'offline',
  );
  if (planningCharge)
    app.store.db
      .prepare('INSERT INTO requests VALUES(?,?,?,?,?,?,?)')
      .run(randomUUID(), run.id, 'driver', 1000, 123, 'completed', new Date().toISOString());
  app.store.append(run.id, 'plan', 'driver', {
    ...(ordered ? { executionVersion: ORDERED_JOURNEY_VERSION } : {}),
    steps,
  });
  const walk = new BrowserWalk(app.store, run.id, app.origin, true, 'chromium');
  await walk.start(run.url);
  await walk.page.setContent('<h1>Controlled search page</h1><button>Search</button>');
  const current = await walk.captureSettled();
  const runner = new Runner(app.store, app.origin);
  const controller = new AbortController();
  return {
    app,
    run,
    walk,
    current,
    runner,
    controller,
    close: async () => {
      await walk.close();
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('Ordered navigation checks completed tasks, without an analysis pause after three dialog keys', async (t) => {
  const x = await fixture();
  let calls = 0,
    analyses = 0,
    measurements = 0,
    reviews = 0;
  t.mock.method(
    x.runner as any,
    'automaticMeasurement',
    async (_run: any, _walk: any, current: any) => {
      measurements++;
      return { current };
    },
  );
  t.mock.method(
    x.runner as any,
    'analyseCheckpoint',
    async (_models: any, _run: any, current: any) => {
      analyses++;
      return current;
    },
  );
  t.mock.method(x.runner as any, 'review', async () => {
    reviews++;
  });
  t.mock.method(MetaModels.prototype, 'reason', async () => {
    calls++;
    if (calls <= 3) return { kind: 'press', key: 'Escape', note: 'Synthetic blocking-dialog key.' };
    const latest = x.app.store
      .records(x.run.id)
      .filter((record) => record.kind === 'capture')
      .at(-1)!;
    if (calls === 4) {
      assert.equal(analyses, 0);
      return {
        kind: 'step_done',
        stepId: 'open',
        captureId: latest.id,
        note: 'Entry instruction observed.',
      };
    }
    assert.equal(analyses, 1, 'One completed task checkpoint ran before the next instruction.');
    return {
      kind: 'step_done',
      stepId: 'check',
      captureId: latest.id,
      note: 'Second instruction observed.',
    };
  });
  try {
    await (x.runner as any).live(
      x.run,
      x.walk,
      new VoiceOverProbe(x.walk),
      x.current,
      x.controller,
    );
    assert.equal(calls, 5);
    assert.equal(readOrderedJourney(x.app.store.records(x.run.id))?.completed.length, 2);
    assert.equal(
      x.app.store.records(x.run.id).filter((record) => record.kind === 'action').length,
      3,
    );
    assert.equal(measurements, 2);
    assert.equal(
      analyses,
      2,
      'One task checkpoint and one final analysis; no duplicate final task analysis.',
    );
    assert.equal(reviews, 1);
    assert.deepEqual(x.app.store.published(x.run.id), []);
  } finally {
    await x.close();
  }
});

test('Out-of-order and wrong-original completions cannot advance, and finish leaves remaining instructions unknown', async (t) => {
  const x = await fixture();
  let calls = 0;
  t.mock.method(
    x.runner as any,
    'analyseCheckpoint',
    async (_models: any, _run: any, current: any) => current,
  );
  t.mock.method(x.runner as any, 'review', async () => {});
  t.mock.method(MetaModels.prototype, 'reason', async () =>
    ++calls === 1
      ? {
          kind: 'step_done',
          stepId: 'check',
          captureId: x.current.id,
          note: 'Synthetic out-of-order request.',
        }
      : calls === 2
        ? {
            kind: 'step_done',
            stepId: 'open',
            captureId: 'wrong-original',
            note: 'Synthetic wrong original.',
          }
        : { kind: 'finish', note: 'Stop with incomplete work.' },
  );
  try {
    await (x.runner as any).live(
      x.run,
      x.walk,
      new VoiceOverProbe(x.walk),
      x.current,
      x.controller,
    );
    const records = x.app.store.records(x.run.id);
    assert.equal(readOrderedJourney(records)?.completed.length, 0);
    assert.equal(
      records.filter((record) => record.payload.method === 'step_completion_refused').length,
      2,
    );
    assert.equal(
      records.filter((record) => record.payload.method === 'unfinished_journey').length,
      1,
    );
    assert.equal(records.filter((record) => record.kind === 'action').length, 0);
    assert.deepEqual(x.app.store.published(x.run.id), []);
  } finally {
    await x.close();
  }
});

test('A screen changed during the model decision refreshes without completing the instruction or sending input', async (t) => {
  const x = await fixture();
  let calls = 0;
  t.mock.method(
    x.runner as any,
    'analyseCheckpoint',
    async (_models: any, _run: any, current: any) => current,
  );
  t.mock.method(x.runner as any, 'review', async () => {});
  t.mock.method(MetaModels.prototype, 'reason', async () => {
    if (++calls > 1) return { kind: 'finish', note: 'Stop after the refused stale completion.' };
    // A popup opening is a meaningful change; ordinary copy drift is tolerated (page-state/1).
    await x.walk.page.locator('h1').evaluate((element) => {
      element.textContent = 'Changed page';
      element.insertAdjacentHTML('afterend', '<div role="dialog" aria-label="Changed page"></div>');
    });
    return {
      kind: 'step_done',
      stepId: 'open',
      captureId: x.current.id,
      note: 'Synthetic stale completion.',
    };
  });
  try {
    await (x.runner as any).live(
      x.run,
      x.walk,
      new VoiceOverProbe(x.walk),
      x.current,
      x.controller,
    );
    const records = x.app.store.records(x.run.id);
    assert.equal(readOrderedJourney(records)?.completed.length, 0);
    assert.equal(records.filter((record) => record.kind === 'action').length, 0);
    assert.notEqual(records.filter((record) => record.kind === 'capture').at(-1)!.id, x.current.id);
    assert(records.some((record) => record.payload.method === 'step_completion_refused'));
  } finally {
    await x.close();
  }
});

test('One charged planning request leaves at most nineteen navigation decisions', async (t) => {
  const x = await fixture();
  let calls = 0;
  t.mock.method(
    x.runner as any,
    'analyseCheckpoint',
    async (_models: any, _run: any, current: any) => current,
  );
  t.mock.method(x.runner as any, 'review', async () => {});
  t.mock.method(MetaModels.prototype, 'reason', async () => {
    calls++;
    x.app.store.db
      .prepare('INSERT INTO requests VALUES(?,?,?,?,?,?,?)')
      .run(randomUUID(), x.run.id, 'driver', 0, 0, 'completed', new Date().toISOString());
    return {
      kind: 'step_done',
      stepId: 'check',
      captureId: x.current.id,
      note: 'Synthetic refused completion to exhaust the allowance.',
    };
  });
  try {
    await (x.runner as any).live(
      x.run,
      x.walk,
      new VoiceOverProbe(x.walk),
      x.current,
      x.controller,
    );
    assert.equal(calls, 19);
    assert.equal(
      x.app.store.usage(x.run.id).requests.filter((request) => request.role === 'driver').length,
      20,
    );
    assert.equal(x.app.store.usage(x.run.id).spent, 123);
    assert.equal(readOrderedJourney(x.app.store.records(x.run.id))?.completed.length, 0);
  } finally {
    await x.close();
  }
});

test('Legacy controlled walks keep their every-third-decision checkpoint', async (t) => {
  const x = await fixture(false, false);
  let calls = 0,
    analyses = 0;
  t.mock.method(
    x.runner as any,
    'automaticMeasurement',
    async (_run: any, _walk: any, current: any) => ({ current }),
  );
  t.mock.method(
    x.runner as any,
    'analyseCheckpoint',
    async (_models: any, _run: any, current: any) => {
      analyses++;
      return current;
    },
  );
  t.mock.method(x.runner as any, 'review', async () => {});
  t.mock.method(MetaModels.prototype, 'reason', async () =>
    ++calls <= 3
      ? { kind: 'press', key: 'Escape', note: 'Synthetic legacy key.' }
      : { kind: 'finish', note: 'Synthetic legacy finish.' },
  );
  try {
    await (x.runner as any).live(
      x.run,
      x.walk,
      new VoiceOverProbe(x.walk),
      x.current,
      x.controller,
    );
    assert.equal(analyses, 2);
    assert.equal(readOrderedJourney(x.app.store.records(x.run.id)), null);
  } finally {
    await x.close();
  }
});
