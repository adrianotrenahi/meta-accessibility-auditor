import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store, digest } from '../src/store.js';
import { MetaModels } from '../src/models.js';
import { JourneyPlanner, journeyPlanView } from '../src/journey-planner.js';
import { CAPS, tokenCostMicros, type Approval } from '../src/types.js';
// The planner's 10 counted input and 20 output tokens, at the navigator model's price.
const planCharge = tokenCostMicros(CAPS.driver.model, 10, 20);

const planned = {
  steps: [
    {
      id: 'open',
      text: 'Open the flight search.',
      intent: 'navigate',
      success: 'The actual form is visible.',
    },
    {
      id: 'results',
      text: 'Search the requested route and dates, stopping at results.',
      intent: 'verify',
      success: 'Usable results show the applied route and dates.',
    },
  ],
};
function fixture(
  options: {
    malformed?: boolean;
    uncertain?: boolean;
    expired?: boolean;
    countFailure?: boolean;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'journey-planner-')),
    store = new Store(dir);
  const url = 'https://93.184.216.34/',
    goal = 'Find the requested return flight, without selecting one.';
  const binding = {
    draftId: randomUUID(),
    ownerHash: 'a'.repeat(64),
    url,
    goal,
    briefHash: digest(JSON.stringify({ url, goal })),
  };
  const calls: { path: string; body: any }[] = [];
  const approved: Approval = {
    approvedBy: 'Adriano',
    maxUsd: 5,
    maxRunUsd: 1.4,
    approvedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + (options.expired ? -1000 : 60000)).toISOString(),
  };
  const models = new MetaModels(
    store,
    (async (input: any, init: any) => {
      const path = String(input),
        body = JSON.parse(init.body);
      calls.push({ path, body });
      if (path.endsWith('/responses/input_tokens')) {
        if (options.countFailure && calls.length === 1)
          throw TypeError('Synthetic count connection failure; no generation sent.');
        return Response.json({ input_tokens: 10 });
      }
      if (options.uncertain) throw TypeError('Synthetic generation connection interrupted.');
      return Response.json({
        status: 'completed',
        usage: { input_tokens: 10, output_tokens: 20 },
        output: [
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: options.malformed ? '{invalid result' : JSON.stringify(planned),
              },
            ],
          },
        ],
      });
    }) as typeof fetch,
    () => approved,
    () => 'synthetic-key-no-network',
  );
  return {
    store,
    binding,
    calls,
    models,
    approved,
    planner: new JourneyPlanner(store, models),
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test('parallel identical planning requests buy one proposal and retain the same exact result', async () => {
  const f = fixture();
  try {
    const [a, b] = await Promise.all([f.planner.prepare(f.binding), f.planner.prepare(f.binding)]);
    assert.equal(a.run.id, b.run.id);
    assert.equal(a.run.state, 'prepared');
    assert.deepEqual(a.plan, b.plan);
    assert.deepEqual(a.plan!.payload.steps, planned.steps);
    const before = JSON.stringify(f.store.records(a.run.id)),
      charge = f.store.usage(a.run.id);
    const again = await f.planner.prepare(f.binding);
    assert.deepEqual(journeyPlanView(again), journeyPlanView(a));
    assert.equal(JSON.stringify(f.store.records(a.run.id)), before);
    assert.equal(f.calls.length, 2);
    assert.equal(charge.requests.length, 1);
    assert.equal(charge.requests[0].role, 'driver');
    assert.equal(charge.requests[0].status, 'completed');
    assert.equal(charge.spent, planCharge);
    assert.equal(charge.reserved, 0);
    assert.equal(f.calls[1].body.text.format.name, 'driver_result');
    assert.equal(f.calls[1].body.tools, undefined);
    assert.equal(
      f.calls[1].body.input[0].content.some((part: any) => part.type === 'input_image'),
      false,
    );
    assert.equal(
      f.store.records(a.run.id).some((r) => r.kind === 'capture' || r.kind === 'action'),
      false,
    );
  } finally {
    f.cleanup();
  }
});
test('changed owner or brief cannot reuse a paid proposal or cause another generation', async () => {
  const f = fixture();
  try {
    await f.planner.prepare(f.binding);
    for (const changed of [
      { ...f.binding, ownerHash: 'b'.repeat(64) },
      { ...f.binding, goal: 'A different trip.' },
      { ...f.binding, url: 'https://1.1.1.1/' },
    ])
      await assert.rejects(async () => f.planner.prepare(changed));
    assert.equal(f.calls.length, 2);
  } finally {
    f.cleanup();
  }
});
test('invalid returned steps retain the charge and never become a fallback plan', async () => {
  const f = fixture({ malformed: true });
  try {
    await assert.rejects(f.planner.prepare(f.binding));
    const again = await f.planner.prepare(f.binding);
    assert.equal(again.run.state, 'interrupted');
    assert.equal(again.plan, null);
    assert.equal(journeyPlanView(again).state, 'unavailable');
    assert.equal(f.calls.length, 2);
    assert.equal(f.store.usage(again.run.id).spent, planCharge);
    assert.equal(
      f.store.records(again.run.id).some((r) => r.kind === 'plan'),
      false,
    );
  } finally {
    f.cleanup();
  }
});
test('uncertain generation keeps its reservation and same-draft retry sends nothing', async () => {
  const f = fixture({ uncertain: true });
  try {
    await assert.rejects(f.planner.prepare(f.binding));
    const again = await f.planner.prepare(f.binding),
      usage = f.store.usage(again.run.id);
    assert.equal(again.run.state, 'interrupted');
    assert.equal(again.plan, null);
    assert.equal(usage.requests.length, 1);
    assert.equal(usage.requests[0].status, 'unknown');
    assert.equal(usage.spent, 0);
    assert.ok(usage.reserved > 0);
    assert.equal(f.calls.length, 2);
  } finally {
    f.cleanup();
  }
});
test('expired approval sends no count or generation, and a busy browser creates no draft', async () => {
  const f = fixture({ expired: true });
  try {
    await assert.rejects(f.planner.prepare(f.binding));
    assert.equal(f.calls.length, 0);
    const another = { ...f.binding, draftId: randomUUID() };
    const busy = new JourneyPlanner(f.store, f.models, () => true);
    await assert.rejects(busy.prepare(another));
    assert.equal(f.store.journeyDraft(another), null);
  } finally {
    f.cleanup();
  }
});
test('a saved proposal permits no further planning or navigation model request before Start', async () => {
  const f = fixture();
  try {
    const ready = await f.planner.prepare(f.binding);
    await assert.rejects(f.models.plan(ready.run.id));
    assert.equal(f.calls.length, 2);
    await f.planner.stop(ready.run.id);
    const stopped = await f.planner.prepare(f.binding);
    assert.equal(stopped.run.state, 'stopped');
    assert.equal(f.calls.length, 2);
    assert.ok(stopped.plan);
  } finally {
    f.cleanup();
  }
});

test('an explicit same-draft retry recovers a failed count only when no generation was sent', async () => {
  const f = fixture({ countFailure: true });
  try {
    await assert.rejects(f.planner.prepare(f.binding));
    const failed = f.store.journeyDraft(f.binding)!;
    assert.equal(failed.run.state, 'interrupted');
    assert.equal(failed.draft.planningRequestId, null);
    assert.equal(f.store.usage(failed.run.id).requests.length, 0);
    const failedRecords = f.store.records(failed.run.id);
    assert.equal(f.calls.length, 1, 'Failure before generation does not auto-retry.');
    const ready = await f.planner.prepare(f.binding);
    assert.equal(ready.run.id, failed.run.id);
    assert.equal(ready.run.createdAt, failed.run.createdAt);
    assert.equal(ready.run.state, 'prepared');
    assert.equal(
      f.calls.length,
      3,
      'Only the explicit retry sends another count and one generation.',
    );
    assert.equal(f.store.usage(ready.run.id).requests.length, 1);
    assert.equal(f.store.usage(ready.run.id).spent, planCharge);
    assert.deepEqual(f.store.records(ready.run.id).slice(0, failedRecords.length), failedRecords);
    assert.throws(() => f.store.retryUnsentJourneyDraft(f.binding));
    await f.planner.stop(ready.run.id);
    assert.throws(() => f.store.retryUnsentJourneyDraft(f.binding));
    await f.planner.prepare(f.binding);
    assert.equal(f.calls.length, 3, 'A stopped proposal never restarts preparation.');
  } finally {
    f.cleanup();
  }
});
