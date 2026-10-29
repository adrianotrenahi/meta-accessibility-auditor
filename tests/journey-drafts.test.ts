import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, digest, recordIsIntact } from '../src/store.js';
import type { Approval } from '../src/types.js';
import type { JourneyDraftBinding } from '../src/journey-drafts.js';

const approval = (): Approval => ({
  approvedBy: 'Adriano',
  approvedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  maxUsd: 10,
  maxRunUsd: 3,
});
const plan = {
  executionVersion: 'ordered-journey/1',
  steps: [
    {
      id: 'open',
      text: 'Open the given website.',
      intent: 'navigate',
      success: 'Its entry page is visible.',
    },
    {
      id: 'search',
      text: 'Search for the requested item.',
      intent: 'search',
      success: 'Matching results are visible.',
    },
  ],
};
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'journey-drafts-'));
  const store = new Store(dir);
  const binding: JourneyDraftBinding = {
    draftId: randomUUID(),
    ownerHash: digest('synthetic owner'),
    briefHash: digest('synthetic canonical brief'),
    url: 'https://example.com/',
    goal: 'Find an item without buying it.',
  };
  const claim = () => store.claimJourneyDraft(binding);
  const response = (runId: string, status = 'completed', actual: number | null = 1000) => {
    const id = store.reserve(runId, 'driver', 2000, approval(), false, 'planning');
    store.settle(id, actual, status);
    const record = store.append(runId, 'model_response', 'driver', {
      requestId: id,
      status: status === 'completed' ? 'completed' : 'incomplete',
      purpose: 'planning',
      output: [
        {
          type: 'function_call',
          name: 'return_result',
          arguments: JSON.stringify({ steps: plan.steps }),
        },
      ],
      provenance: 'synthetic local test; no provider call',
    });
    return { id, record };
  };
  const prepared = () => {
    const claimed = claim();
    response(claimed.run.id);
    return store.prepareJourneyDraft(binding, plan);
  };
  return {
    store,
    binding,
    claim,
    response,
    prepared,
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('A draft has one atomic claim; matching retries return it and changed bindings never regenerate', async () => {
  const x = setup();
  try {
    const views = await Promise.all([
      Promise.resolve().then(x.claim),
      Promise.resolve().then(x.claim),
    ]);
    assert.equal(views.filter((view) => view.created).length, 1);
    assert.equal(views[0]!.run.id, views[1]!.run.id);
    assert.equal(views[0]!.run.state, 'planning');
    assert.equal(x.store.runs().length, 1);
    assert.equal(x.store.usage().requests.length, 0);
    for (const changed of [
      { ownerHash: digest('other owner') },
      { briefHash: digest('other brief') },
      { url: 'https://other.example/' },
      { goal: 'Different journey.' },
    ])
      assert.throws(() => x.store.claimJourneyDraft({ ...x.binding, ...changed }));
    assert.equal(x.store.runs().length, 1);
  } finally {
    x.close();
  }
});

test('Planning can reserve only one existing driver slot and cannot borrow execution, analyst or prepared capacity', () => {
  const x = setup();
  try {
    const { run } = x.claim();
    assert.throws(() => x.store.reserve(run.id, 'driver', 2000, approval()));
    assert.throws(() => x.store.reserve(run.id, 'analyst', 2000, approval(), false, 'planning'));
    const { id } = x.response(run.id);
    assert.equal(x.store.journeyDraft(x.binding)?.draft.planningRequestId, id);
    assert.throws(() => x.store.reserve(run.id, 'driver', 2000, approval(), false, 'planning'));
    const ready = x.store.prepareJourneyDraft(x.binding, plan);
    assert.equal(ready.run.state, 'prepared');
    assert.throws(() => x.store.reserve(run.id, 'driver', 2000, approval()));
    assert.throws(() => x.store.reserve(run.id, 'driver', 2000, approval(), false, 'planning'));
    assert.equal(x.store.usage(run.id).requests.length, 1);
  } finally {
    x.close();
  }
});

test('A validated response and prepared transition are saved together; retries return the exact plan', () => {
  const x = setup();
  try {
    const { run } = x.claim();
    assert.throws(() => x.store.prepareJourneyDraft(x.binding, plan));
    const { record } = x.response(run.id);
    assert.throws(() => x.store.prepareJourneyDraft(x.binding, { steps: [] }));
    assert.equal(x.store.run(run.id).state, 'planning');
    assert.equal(x.store.records(run.id).filter((entry) => entry.kind === 'plan').length, 0);
    // A missing extra source makes append fail inside the preparation transaction.
    assert.throws(() => x.store.prepareJourneyDraft(x.binding, plan, ['missing-original']));
    assert.equal(x.store.run(run.id).state, 'planning');
    const ready = x.store.prepareJourneyDraft(x.binding, plan);
    assert.equal(ready.run.state, 'prepared');
    assert.equal(ready.run.startedAt, undefined);
    assert.deepEqual(ready.plan?.sources, [record.id]);
    assert.equal(ready.plan?.payload.planningRequestId, x.store.usage(run.id).requests[0]!.id);
    assert.deepEqual(x.claim().plan, ready.plan);
    assert.deepEqual(x.store.prepareJourneyDraft(x.binding, plan).plan, ready.plan);
    assert.throws(() =>
      x.store.prepareJourneyDraft(x.binding, { ...plan, steps: [...plan.steps].reverse() }),
    );
    assert.equal(x.store.records(run.id).filter((entry) => entry.kind === 'plan').length, 1);
    assert(ready.plan && recordIsIntact(ready.plan));
  } finally {
    x.close();
  }
});

test('Start activates the exact preparation once and keeps its original planning charge and creation time', () => {
  const x = setup();
  try {
    const ready = x.prepared();
    const options = {
      requestId: randomUUID(),
      planId: ready.plan!.id,
      planHash: ready.plan!.hash,
      approval: approval(),
    };
    for (const changed of [{ planId: randomUUID() }, { planHash: digest('different plan') }])
      assert.throws(() => x.store.activateJourneyDraft(x.binding, { ...options, ...changed }));
    const started = x.store.activateJourneyDraft(x.binding, options);
    assert.equal(started.activated, true);
    assert.equal(started.run.id, ready.run.id);
    assert.equal(started.run.createdAt, ready.run.createdAt);
    assert.equal(started.run.state, 'running');
    assert(Number.isFinite(Date.parse(started.run.startedAt!)));
    assert.equal(x.store.hostStart(options.requestId), ready.run.id);
    assert.equal(x.store.usage(ready.run.id).spent, 1000);
    assert.equal(x.store.usage(ready.run.id).requests.length, 1);
    assert.equal(x.store.activateJourneyDraft(x.binding, options).activated, false);
    assert.throws(() =>
      x.store.activateJourneyDraft(x.binding, { ...options, requestId: randomUUID() }),
    );
    x.store.reserve(ready.run.id, 'driver', 2000, approval());
    assert.equal(x.store.usage(ready.run.id).requests.length, 2);
    assert.equal(x.store.usage(ready.run.id).spent, 1000);
    assert.equal(x.store.usage(ready.run.id).reserved, 2000);
    assert.equal(x.store.runs().length, 1);
  } finally {
    x.close();
  }
});

test('An expired approval or exhausted same-run budget leaves the proposal prepared and unstarted', () => {
  const x = setup();
  try {
    const ready = x.prepared();
    const options = {
      requestId: randomUUID(),
      planId: ready.plan!.id,
      planHash: ready.plan!.hash,
      approval: { ...approval(), expiresAt: new Date(0).toISOString() },
    };
    assert.throws(() => x.store.activateJourneyDraft(x.binding, options));
    assert.throws(() =>
      x.store.activateJourneyDraft(x.binding, {
        ...options,
        approval: { ...approval(), maxRunUsd: 0.001 },
      }),
    );
    assert.equal(x.store.run(ready.run.id).state, 'prepared');
    assert.equal(x.store.hostStart(options.requestId), null);
  } finally {
    x.close();
  }
});

test('Recovery preserves an idle prepared proposal, interrupts planning and retains unknown reservations', () => {
  const ready = setup(),
    pending = setup();
  try {
    const proposal = ready.prepared();
    const run = pending.claim().run;
    pending.store.reserve(run.id, 'driver', 2000, approval(), false, 'planning');
    ready.store.recoverInterrupted();
    pending.store.recoverInterrupted();
    assert.equal(ready.store.run(proposal.run.id).state, 'prepared');
    assert.deepEqual(ready.claim().plan, proposal.plan);
    assert.equal(pending.store.run(run.id).state, 'interrupted');
    assert.equal(pending.store.usage(run.id).requests[0]!.status, 'unknown');
    assert.equal(pending.store.usage(run.id).reserved, 2000);
    assert.equal(pending.claim().created, false);
    assert.throws(() =>
      pending.store.reserve(run.id, 'driver', 2000, approval(), false, 'planning'),
    );
    assert.throws(() => pending.store.prepareJourneyDraft(pending.binding, plan));
  } finally {
    ready.close();
    pending.close();
  }
});

test('Stopped or uncertain planning cannot be completed or prepared after a late result', () => {
  const x = setup();
  try {
    const run = x.claim().run;
    x.response(run.id, 'unknown', null);
    assert.throws(() => x.store.prepareJourneyDraft(x.binding, plan));
    assert.throws(() => x.store.finish(run.id, 'complete'));
    x.store.finish(run.id, 'stopped', 'Synthetic owner stop.');
    const request = x.store.usage(run.id).requests[0]!;
    x.store.settle(request.id, 1000, 'completed');
    assert.throws(() => x.store.prepareJourneyDraft(x.binding, plan));
    assert.equal(x.store.run(run.id).state, 'stopped');
    assert.equal(x.store.records(run.id).filter((record) => record.kind === 'plan').length, 0);
  } finally {
    x.close();
  }
});

test('Discard waits for live planning work and keeps only a retry tombstone plus cumulative unknown cost', () => {
  const x = setup();
  try {
    const run = x.claim().run;
    const id = x.store.reserve(run.id, 'driver', 2000, approval(), false, 'planning');
    assert.throws(() => x.store.discard(run.id));
    x.store.finish(run.id, 'stopped', 'Synthetic owner stop.');
    assert.throws(() => x.store.discard(run.id));
    x.store.settle(id, null, 'unknown');
    x.store.discard(run.id);
    assert.equal(x.store.hasRun(run.id), false);
    assert.equal(x.store.usage().reserved, 2000);
    assert.equal(x.store.records(run.id).length, 0);
    assert.throws(x.claim);
    const tombstone = x.store.db
      .prepare('SELECT * FROM journey_drafts WHERE draft_id=?')
      .get(x.binding.draftId) as any;
    assert.equal(tombstone.run_id, null);
    assert.equal(tombstone.planning_request_id, null);
    assert.equal(tombstone.plan_id, null);
    assert.equal(tombstone.plan_hash, null);
    assert(!JSON.stringify(tombstone).includes(x.binding.goal));
  } finally {
    x.close();
  }
});

test('Discarding a prepared plan removes its original result and never recreates it on retry', () => {
  const x = setup();
  try {
    const ready = x.prepared();
    x.store.discard(ready.run.id);
    assert.throws(x.claim);
    assert.equal(x.store.runs().length, 0);
    assert.equal(x.store.usage().spent, 1000);
    assert.equal(x.store.record(ready.run.id, ready.plan!.id), undefined);
  } finally {
    x.close();
  }
});

test('The saved instructions must be the actual completed tool or structured JSON result', () => {
  for (const form of ['structured', 'different', 'missing'] as const) {
    const x = setup();
    try {
      const run = x.claim().run;
      const { record } = x.response(run.id);
      const output =
        form === 'missing'
          ? []
          : [
              {
                type: 'message',
                content: [
                  {
                    type: 'output_text',
                    text: JSON.stringify({
                      steps: form === 'different' ? [...plan.steps].reverse() : plan.steps,
                    }),
                  },
                ],
              },
            ];
      // Store a new intact synthetic provider response in the second supported shape.
      x.store.db.prepare('DELETE FROM records WHERE id=?').run(record.id);
      x.store.append(run.id, 'model_response', 'driver', {
        requestId: x.store.usage(run.id).requests[0]!.id,
        status: 'completed',
        output,
      });
      if (form === 'structured')
        assert.equal(x.store.prepareJourneyDraft(x.binding, plan).run.state, 'prepared');
      else {
        assert.throws(() => x.store.prepareJourneyDraft(x.binding, plan));
        assert.equal(x.store.run(run.id).state, 'planning');
        assert.equal(x.store.usage(run.id).spent, 1000);
        assert.equal(x.claim().created, false);
        assert.throws(() => x.store.reserve(run.id, 'driver', 2000, approval(), false, 'planning'));
      }
    } finally {
      x.close();
    }
  }
});

test('A failure between saving the plan and preparing the run rolls back both changes', () => {
  const x = setup();
  try {
    const run = x.claim().run;
    x.response(run.id);
    x.store.db.exec(
      "CREATE TEMP TRIGGER refuse_preparation BEFORE UPDATE ON runs BEGIN SELECT RAISE(ABORT,'synthetic prepare failure'); END",
    );
    assert.throws(() => x.store.prepareJourneyDraft(x.binding, plan), /synthetic prepare failure/);
    assert.equal(x.store.run(run.id).state, 'planning');
    assert.equal(x.store.records(run.id).filter((record) => record.kind === 'plan').length, 0);
    assert.equal(x.store.journeyDraft(x.binding)?.draft.planId, null);
    assert.equal(x.store.usage(run.id).spent, 1000);
    x.store.db.exec('DROP TRIGGER refuse_preparation');
    assert.equal(x.store.prepareJourneyDraft(x.binding, plan).run.state, 'prepared');
  } finally {
    x.close();
  }
});

test('Changed original planning receipts cannot be read or activated as the old prepared plan', () => {
  const x = setup();
  try {
    const ready = x.prepared();
    const receipt = x.store
      .records(ready.run.id)
      .find((record) => record.kind === 'model_response')!;
    x.store.db
      .prepare('UPDATE records SET body=? WHERE id=?')
      .run(JSON.stringify({ ...receipt.payload, output: [] }), receipt.id);
    assert.throws(x.claim);
    assert.throws(() =>
      x.store.activateJourneyDraft(x.binding, {
        requestId: randomUUID(),
        planId: ready.plan!.id,
        planHash: ready.plan!.hash,
        approval: approval(),
      }),
    );
    assert.equal(x.store.run(ready.run.id).state, 'prepared');
    assert.equal(x.store.usage(ready.run.id).spent, 1000);
  } finally {
    x.close();
  }
});
