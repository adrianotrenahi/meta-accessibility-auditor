import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store, digest } from '../src/store.js';
import { MetaModels, actionSchema } from '../src/models.js';
import { JourneyPlanner, journeyPlanView } from '../src/journey-planner.js';
import { journeyPlanSchema } from '../src/journey-steps.js';
import { CAPS, tokenCostMicros, type Approval } from '../src/types.js';
// The planner's 10 counted input and 20 output tokens, at the navigator model's price.
const planCharge = tokenCostMicros(CAPS.driver.model, 10, 20);

const result = {
  steps: [
    {
      id: 'open',
      text: 'Open the requested search.',
      intent: 'navigate',
      success: 'The requested form is visible.',
    },
    {
      id: 'results',
      text: 'Search without selecting or buying.',
      intent: 'search',
      success: 'Matching results are visible.',
    },
  ],
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(
  options: { holdCount?: boolean; holdGeneration?: boolean; honourAbort?: boolean } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'planner-lifecycle-'));
  const store = new Store(dir);
  const url = 'https://example.com/',
    goal = 'Find matching results without buying.';
  const binding = {
    draftId: randomUUID(),
    ownerHash: digest('synthetic owner'),
    url,
    goal,
    briefHash: digest(JSON.stringify({ url, goal })),
  };
  const countStarted = deferred<void>(),
    generationStarted = deferred<void>();
  const countRelease = deferred<Response>(),
    generationRelease = deferred<Response>();
  const calls: { path: string; body: any }[] = [];
  const approved: Approval = {
    approvedBy: 'Adriano',
    approvedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    maxUsd: 5,
    maxRunUsd: 1.4,
  };
  const generated = () =>
    Response.json({
      status: 'completed',
      usage: { input_tokens: 10, output_tokens: 20 },
      output: [
        { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(result) }] },
      ],
    });
  const fetcher = (async (input: any, init: any) => {
    const path = String(input);
    calls.push({ path, body: JSON.parse(init.body) });
    if (path.endsWith('/responses/input_tokens')) {
      countStarted.resolve();
      return options.holdCount ? countRelease.promise : Response.json({ input_tokens: 10 });
    }
    generationStarted.resolve();
    if (!options.holdGeneration) return generated();
    if (!options.honourAbort) return generationRelease.promise;
    return new Promise<Response>((resolve, reject) => {
      generationRelease.promise.then(resolve, reject);
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
      if (init.signal.aborted) reject(init.signal.reason);
    });
  }) as typeof fetch;
  const models = new MetaModels(
    store,
    fetcher,
    () => approved,
    () => 'synthetic-offline-key',
  );
  const planner = new JourneyPlanner(store, models);
  return {
    dir,
    store,
    binding,
    models,
    planner,
    calls,
    approved,
    generated,
    countStarted,
    generationStarted,
    countRelease,
    generationRelease,
    async close() {
      await planner.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('Stop during input count sends no generation and the same draft never resumes itself', async () => {
  const f = fixture({ holdCount: true });
  try {
    const pending = f.planner.prepare(f.binding).catch((error) => error);
    await f.countStarted.promise;
    const run = f.store.journeyDraft(f.binding)!.run;
    const stopped = f.planner.stop(run.id);
    f.countRelease.resolve(Response.json({ input_tokens: 10 }));
    await stopped;
    assert((await pending) instanceof Error);
    assert.equal(f.calls.length, 1);
    assert.equal(f.store.usage(run.id).requests.length, 0);
    assert.equal(f.store.run(run.id).state, 'stopped');
    const retry = await f.planner.prepare(f.binding);
    assert.equal(retry.run.state, 'stopped');
    assert.equal(retry.plan, null);
    assert.equal(f.calls.length, 1);
  } finally {
    await f.close();
  }
});

test('A late completed response after Stop records its actual charge but cannot prepare or resurrect a discarded draft', async () => {
  const f = fixture({ holdGeneration: true });
  try {
    const pending = f.planner.prepare(f.binding).catch((error) => error);
    await f.generationStarted.promise;
    const run = f.store.journeyDraft(f.binding)!.run;
    let stopFinished = false;
    const stopped = f.planner.stop(run.id).then(() => {
      stopFinished = true;
    });
    await Promise.resolve();
    assert.equal(stopFinished, false, 'Stop must wait for the in-flight response before discard.');
    assert.throws(() => f.store.discard(run.id));
    f.generationRelease.resolve(f.generated());
    await stopped;
    assert((await pending) instanceof Error);
    assert.equal(f.store.run(run.id).state, 'stopped');
    assert.equal(f.store.usage(run.id).spent, planCharge);
    assert.equal(f.store.usage(run.id).reserved, 0);
    assert.equal(f.store.records(run.id).filter((record) => record.kind === 'plan').length, 0);
    assert.equal((await f.planner.prepare(f.binding)).run.state, 'stopped');
    f.store.discard(run.id);
    await assert.rejects(async () => f.planner.prepare(f.binding));
    assert.equal(f.store.usage().spent, planCharge);
    assert.equal(f.store.hasRun(run.id), false);
    assert.equal(f.calls.length, 2);
  } finally {
    await f.close();
  }
});

test('An abort without a known response keeps the reservation through stopped-draft discard', async () => {
  const f = fixture({ holdGeneration: true, honourAbort: true });
  try {
    const pending = f.planner.prepare(f.binding).catch((error) => error);
    await f.generationStarted.promise;
    const run = f.store.journeyDraft(f.binding)!.run;
    await f.planner.stop(run.id);
    assert((await pending) instanceof Error);
    const usage = f.store.usage(run.id);
    assert.equal(usage.requests[0]!.status, 'unknown');
    assert(usage.reserved > 0);
    f.store.discard(run.id);
    assert.equal(f.store.usage().reserved, usage.reserved);
    assert.equal(f.calls.length, 2);
  } finally {
    await f.close();
  }
});

test('Reopening a prepared draft reads the identical proposal without fetching or exposing binding or model records', async () => {
  const f = fixture();
  let reopened: Store | undefined;
  try {
    const ready = await f.planner.prepare(f.binding);
    reopened = new Store(f.dir);
    reopened.recoverInterrupted();
    const models = new MetaModels(
      reopened,
      (async () => {
        throw Error('Reload must not fetch.');
      }) as typeof fetch,
      () => f.approved,
      () => 'synthetic-key',
    );
    const planner = new JourneyPlanner(reopened, models);
    const view = await planner.prepare(f.binding);
    assert.deepEqual(view.plan, ready.plan);
    assert.equal(view.run.state, 'prepared');
    const dto = JSON.stringify(journeyPlanView(view));
    for (const forbidden of [
      f.binding.ownerHash,
      f.binding.briefHash,
      'instructionHash',
      'model_response',
      'synthetic-key',
    ])
      assert(!dto.includes(forbidden));
    await planner.close();
    assert.equal(reopened.run(ready.run.id).state, 'prepared');
  } finally {
    reopened?.close();
    await f.close();
  }
});

test('Wrong planning purpose combinations refuse before any count or generation request', async () => {
  const f = fixture();
  try {
    const { run } = f.store.claimJourneyDraft(f.binding);
    for (const value of [
      () =>
        f.models.reason(
          run.id,
          'analyst',
          [],
          [],
          journeyPlanSchema,
          false,
          undefined,
          undefined,
          'planning',
        ),
      () =>
        f.models.reason(
          run.id,
          'driver',
          [],
          [],
          actionSchema,
          false,
          undefined,
          undefined,
          'planning',
        ),
      () =>
        f.models.reason(
          run.id,
          'driver',
          [],
          [{ captureId: 'fake', image: 'fake' }],
          journeyPlanSchema,
          false,
          undefined,
          undefined,
          'planning',
        ),
      () =>
        f.models.reason(
          run.id,
          'driver',
          [],
          [],
          journeyPlanSchema,
          true,
          undefined,
          undefined,
          'planning',
        ),
      () => f.models.reason(run.id, 'driver', [], [], actionSchema),
    ])
      await assert.rejects(value);
    assert.equal(f.calls.length, 0);
    assert.equal(f.store.usage().requests.length, 0);
  } finally {
    await f.close();
  }
});

test('Closing the planner prevents a late setup from starting another paid preparation', async () => {
  const f = fixture();
  try {
    await f.planner.close();
    await assert.rejects(async () => f.planner.prepare(f.binding));
    assert.equal(f.calls.length, 0);
    assert.equal(f.store.runs().length, 0);
  } finally {
    await f.close();
  }
});
