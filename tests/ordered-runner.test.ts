import { RoleAllowanceLimit } from '../src/role-allowance.js';
import { showsForm } from '../src/runner.js';
import { DECISIONS_PER_FORM_STEP, DECISIONS_PER_STEP } from '../src/types.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, digest } from '../src/store.js';
import { Runner } from '../src/runner.js';
import { BrowserWalk, PageUnreadable } from '../src/browser.js';
import { VoiceOverProbe } from '../src/voiceover.js';
import { MetaModels } from '../src/models.js';
import { startServer } from '../server/index.js';
import { ORDERED_JOURNEY_VERSION, readOrderedJourney } from '../src/journey-steps.js';
import type { Approval, RecordEntry } from '../src/types.js';

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

test('Ordered navigation hands each completed task to the analysis track without waiting for it', async (t) => {
  const x = await fixture();
  let calls = 0,
    analyses = 0,
    measurements = 0,
    reviews = 0,
    handedOver = 0;
  // The analyst never answers while the robot walks: the walk must not wait for it.
  let release!: () => void;
  const answered = new Promise<void>((resolve) => (release = resolve));
  t.mock.method(
    x.runner as any,
    'automaticMeasurement',
    async (_run: any, _walk: any, current: any) => {
      measurements++;
      return { current };
    },
  );
  const queue = (x.runner as any).queueCheckpoint.bind(x.runner);
  t.mock.method(x.runner as any, 'queueCheckpoint', async (...args: any[]) => {
    handedOver++;
    return queue(...args);
  });
  t.mock.method(
    x.runner as any,
    'analyse',
    async (
      _models: any,
      _run: any,
      current: any,
      _walk: any,
      _signal: any,
      _probe: any,
      background: any,
    ) => {
      analyses++;
      if (background) await answered;
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
      assert.equal(handedOver, 0, 'no analysis pause after three dialog keys');
      return {
        kind: 'step_done',
        stepId: 'open',
        captureId: latest.id,
        note: 'Entry instruction observed.',
      };
    }
    assert.equal(handedOver, 1, 'the completed task was handed over before the next instruction');
    assert.equal(reviews, 0, 'the robot decides again while the earlier check is still unanswered');
    release();
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
      'One task checkpoint on the track and one final analysis; no duplicate final task analysis.',
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
      element.insertAdjacentHTML(
        'afterend',
        '<div role="dialog" aria-label="Changed page"><p>Sign in for member deals</p></div>',
      );
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

// Owner, 31 Oct: the navigator's allowance is per journey step, not twenty for the whole audit,
// and the planning request no longer takes one from it.
test('A step that never finishes uses its own decision allowance, not a whole-audit twenty', async (t) => {
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
    const allowance = showsForm(x.current) ? DECISIONS_PER_FORM_STEP : DECISIONS_PER_STEP;
    assert.equal(calls, allowance);
    assert.equal(
      x.app.store.usage(x.run.id).requests.filter((request) => request.role === 'driver').length,
      allowance + 1,
    );
    assert.equal(x.app.store.usage(x.run.id).spent, 123);
    assert.equal(readOrderedJourney(x.app.store.records(x.run.id))?.completed.length, 0);
  } finally {
    await x.close();
  }
});

test('A finished step gives the next step a fresh decision allowance', async (t) => {
  const x = await fixture();
  let driverCalls = 0;
  t.mock.method(
    x.runner as any,
    'analyseCheckpoint',
    async (_models: any, _run: any, current: any) => current,
  );
  t.mock.method(x.runner as any, 'analyse', async () => {});
  t.mock.method(x.runner as any, 'review', async () => {});
  t.mock.method(MetaModels.prototype, 'reason', async (_id: string, role: string) => {
    if (role !== 'driver') return { findings: [], coverage: [] };
    driverCalls++;
    // The first decision finishes step one; every later one names the finished step again,
    // which is refused, so step two spends exactly its own allowance.
    return {
      kind: 'step_done',
      stepId: 'open',
      captureId: x.current.id,
      note: driverCalls === 1 ? 'The requested page is visible.' : 'Synthetic refused completion.',
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
    assert.deepEqual(
      readOrderedJourney(x.app.store.records(x.run.id))?.completed.map((c) => c.stepId),
      ['open'],
    );
    const allowance = showsForm(x.current) ? DECISIONS_PER_FORM_STEP : DECISIONS_PER_STEP;
    assert.equal(driverCalls, 1 + allowance, 'step two starts from zero, not from step one');
    assert(
      x.app.store
        .records(x.run.id)
        .some(
          (r) =>
            r.kind === 'limit' &&
            String(r.payload.reason).includes(
              `${allowance} navigation decisions for the step "Inspect the available search."`,
            ),
        ),
    );
  } finally {
    await x.close();
  }
});

test('Running out of the navigator money share stops navigation cleanly and still analyses', async (t) => {
  const x = await fixture();
  let finalChecks = 0;
  t.mock.method(
    x.runner as any,
    'analyseCheckpoint',
    async (_models: any, _run: any, current: any) => {
      finalChecks++;
      return current;
    },
  );
  t.mock.method(x.runner as any, 'review', async () => {});
  t.mock.method(MetaModels.prototype, 'reason', async (_id: string, role: string) => {
    if (role !== 'driver') return { findings: [], coverage: [] };
    throw new RoleAllowanceLimit('driver', 'Phase spending limit reached.');
  });
  try {
    await (x.runner as any).live(
      x.run,
      x.walk,
      new VoiceOverProbe(x.walk),
      x.current,
      x.controller,
    );
    assert.equal(finalChecks, 1, 'the final check still runs');
    assert(
      x.app.store
        .records(x.run.id)
        .some(
          (r) =>
            r.kind === 'limit' &&
            r.payload.method === 'navigation_limit' &&
            String(r.payload.reason).includes('Phase spending limit reached.'),
        ),
    );
  } finally {
    await x.close();
  }
});

// Owner, 31 Oct: Booking.com's results page stayed unreadable after Search and the audit ended
// on a technical error. Now that stop is clean: what was reached is still checked and reviewed.
test('A page that stays unreadable after an input stops navigation cleanly and still analyses', async (t) => {
  const x = await fixture();
  let finalChecks = 0,
    reads = 0;
  t.mock.method(
    x.runner as any,
    'analyseCheckpoint',
    async (_models: any, _run: any, current: any) => {
      finalChecks++;
      return current;
    },
  );
  t.mock.method(x.runner as any, 'review', async () => {});
  t.mock.method(MetaModels.prototype, 'reason', async (_id: string, role: string) => {
    if (role !== 'driver') return { findings: [], coverage: [] };
    return { kind: 'press', key: 'Tab', note: 'Synthetic key before a slow page.' };
  });
  t.mock.method(x.walk, 'captureSettled', async () => {
    reads++;
    throw new PageUnreadable('The page did not become readable within 30 seconds of waiting.');
  });
  try {
    await (x.runner as any).live(
      x.run,
      x.walk,
      new VoiceOverProbe(x.walk),
      x.current,
      x.controller,
    );
    assert.equal(finalChecks, 1, 'the final check still runs');
    assert.equal(reads, 1, 'the unreadable page is not waited for a second time');
    assert(
      x.app.store
        .records(x.run.id)
        .some(
          (r) =>
            r.kind === 'limit' &&
            r.payload.method === 'navigation_limit' &&
            String(r.payload.reason).includes('did not become readable'),
        ),
    );
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
  t.mock.method(x.runner as any, 'analyse', async (_models: any, _run: any, current: any) => {
    analyses++;
    return current;
  });
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

test('Two instructions finished on one unchanged screenshot get one scan and one paid check', async (t) => {
  // Owner, 30 Oct: Booking.com's home page was scanned, analysed and reviewed twice.
  // The real analysis runs here, including its own journey-context read of the page.
  const x = await fixture();
  let decisions = 0,
    analyses = 0,
    scans = 0;
  const realScan = x.walk.measurements.bind(x.walk);
  x.walk.measurements = async (source) => {
    scans++;
    return realScan(source);
  };
  t.mock.method(MetaModels.prototype, 'reason', async (...args: any[]) => {
    const [, role, records] = args as [string, string, RecordEntry[]];
    if (role === 'analyst') {
      analyses++;
      const capture = records.findLast((record) => record.kind === 'capture')!;
      assert.equal(capture.id, x.current.id);
      return {
        findings: [],
        coverage: [
          { captureId: capture.id, topic: 'content', state: 'examined', reason: 'Synthetic.' },
        ],
      };
    }
    if (role !== 'driver') throw Error(`Unexpected ${role} request.`);
    decisions++;
    return {
      kind: 'step_done',
      stepId: decisions === 1 ? 'open' : 'check',
      captureId: x.current.id,
      note: 'Synthetic completion on the same screenshot.',
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
    assert.equal(readOrderedJourney(records)?.completed.length, 2);
    assert(
      records.some(
        (record) =>
          record.kind === 'observation' &&
          record.payload.method === 'journey_context' &&
          record.payload.stable === true,
      ),
      'the analysis read the journey context for real',
    );
    assert.equal(scans, 1, 'the second completion reuses the scan of the same screenshot');
    assert.equal(analyses, 1, 'the final checkpoint does not resend the same screenshot');
    const skipped = records.filter(
      (record) => record.kind === 'coverage' && record.payload.method === 'repeat_checkpoint/1',
    );
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0]!.payload.captureId, x.current.id);
    assert.equal(skipped[0]!.payload.state, 'ALREADY_CHECKED');
    const reads = records.filter((record) => record.kind === 'read_snapshot');
    assert(
      reads.every((read) => read.payload.records.every((pin: any) => pin.id !== skipped[0]!.id)),
      'the note is never sent to a model as evidence',
    );
  } finally {
    await x.close();
  }
});

test('A check the analyst asks for is done by the robot only while the page still matches', async (t) => {
  const x = await fixture();
  let calls = 0;
  let release!: () => void;
  const answered = new Promise<void>((resolve) => (release = resolve));
  t.mock.method(
    x.runner as any,
    'automaticMeasurement',
    async (_run: any, _walk: any, current: any) => ({ current }),
  );
  t.mock.method(
    x.runner as any,
    'analyse',
    async (_m: any, _run: any, current: any, _w: any, _s: any, _p: any, background: any) => {
      if (!background) return current;
      // The analyst answers only after the robot has already pressed a key and moved on.
      await answered;
      background.track.ask({
        method: 'keyboard_focus',
        captureId: current.id,
        criterionId: null,
        reason: 'Synthetic request for the screen the analyst checked.',
      });
      return current;
    },
  );
  t.mock.method(x.runner as any, 'review', async () => {});
  t.mock.method(MetaModels.prototype, 'reason', async () => {
    calls++;
    const latest = x.app.store
      .records(x.run.id)
      .filter((record) => record.kind === 'capture')
      .at(-1)!;
    if (calls === 1)
      return { kind: 'step_done', stepId: 'open', captureId: latest.id, note: 'Opened.' };
    if (calls === 2) {
      await x.walk.page.setContent('<h1>Moved on</h1><button>Other</button>');
      return { kind: 'press', key: 'Tab', note: 'Synthetic key on the next screen.' };
    }
    if (calls === 3) {
      release();
      await new Promise((resolve) => setImmediate(resolve));
      return { kind: 'press', key: 'Tab', note: 'Another key; the request is handled first.' };
    }
    return { kind: 'step_done', stepId: 'check', captureId: latest.id, note: 'Checked.' };
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
    const focused = records.filter((record) => record.kind === 'focused_check');
    assert.equal(focused.length, 1);
    assert.equal(focused[0]!.payload.state, 'NOT_TESTED');
    assert.equal(focused[0]!.payload.attempted, false);
    assert.equal(focused[0]!.payload.captureId, x.current.id);
    assert.equal(
      records.filter((record) => record.kind === 'action').length,
      2,
      'only the robot’s own two keys were sent; the stale request sent none',
    );
  } finally {
    await x.close();
  }
});

test('A hard failure on the analysis track stops the walk at the robot’s next step', async (t) => {
  const x = await fixture();
  let calls = 0;
  t.mock.method(
    x.runner as any,
    'automaticMeasurement',
    async (_run: any, _walk: any, current: any) => ({ current }),
  );
  t.mock.method(x.runner as any, 'analyse', async (...args: any[]) => {
    if (args[6]) throw Error('Synthetic hard analysis failure.');
    return args[2];
  });
  t.mock.method(x.runner as any, 'review', async () => {
    throw Error('No review may run after a hard failure.');
  });
  t.mock.method(MetaModels.prototype, 'reason', async () => {
    calls++;
    if (calls === 1)
      return { kind: 'step_done', stepId: 'open', captureId: x.current.id, note: 'Opened.' };
    return { kind: 'press', key: 'Tab', note: 'Synthetic key.' };
  });
  try {
    await assert.rejects(
      (x.runner as any).live(x.run, x.walk, new VoiceOverProbe(x.walk), x.current, x.controller),
      /Synthetic hard analysis failure/,
    );
    assert(calls <= 2, 'at most the decision already under way when the failure arrived');
  } finally {
    await x.close();
  }
});

test('A hard failure of the walk cancels screens still waiting for their check', async (t) => {
  const x = await fixture(false, false);
  let decisions = 0,
    analyses = 0,
    reviews = 0;
  let release!: () => void;
  const answered = new Promise<void>((resolve) => (release = resolve));
  t.mock.method(MetaModels.prototype, 'reason', async (...args: any[]) => {
    const role = args[1];
    if (role === 'analyst') {
      analyses++;
      await answered;
      return { findings: [], coverage: [] };
    }
    if (role === 'reviewer') {
      reviews++;
      return { decisions: [] };
    }
    if (++decisions === 7) {
      setImmediate(release);
      throw Error('Synthetic hard driver failure.');
    }
    return { kind: 'press', key: 'Escape', note: 'Synthetic key.' };
  });
  try {
    await assert.rejects(
      (x.runner as any).live(x.run, x.walk, new VoiceOverProbe(x.walk), x.current, x.controller),
      /Synthetic hard driver failure/,
    );
    assert.equal(analyses, 1, 'the second handed-over screen never started its paid check');
    assert.equal(reviews, 0);
  } finally {
    await x.close();
  }
});
