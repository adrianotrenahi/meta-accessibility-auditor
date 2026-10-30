import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Store, digest } from '../src/store.js';
import { Runner } from '../src/runner.js';
import { JourneyPlanner } from '../src/journey-planner.js';
import { hostRequest } from '../server/host.js';
import type { Approval } from '../src/types.js';

const steps = [
  { id: 'arrival', text: 'Open the search.', intent: 'navigate', success: 'The form is visible.' },
  {
    id: 'results',
    text: 'Read usable results.',
    intent: 'verify',
    success: 'Usable results are visible.',
  },
];
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'journey-start-cleanup-'));
  const store = new Store(directory),
    origin = 'http://127.0.0.1:4317';
  const approved: Approval = {
    approvedBy: 'Adriano',
    approvedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    maxUsd: 5,
    maxRunUsd: 1.4,
  };
  const url = 'https://93.184.216.34/',
    goal = 'Read results without selecting anything.';
  const binding = {
    draftId: randomUUID(),
    ownerHash: digest('synthetic owner'),
    url,
    goal,
    briefHash: digest(JSON.stringify({ url, goal })),
  };
  const claimed = store.claimJourneyDraft(binding);
  const planningRequest = store.reserve(
    claimed.run.id,
    'driver',
    1000,
    approved,
    false,
    'planning',
  );
  store.settle(planningRequest, 600, 'completed');
  const response = store.append(claimed.run.id, 'model_response', 'driver', {
    requestId: planningRequest,
    purpose: 'planning',
    status: 'completed',
    output: [
      { type: 'function_call', name: 'return_result', arguments: JSON.stringify({ steps }) },
    ],
    provenance: 'Synthetic local fixture only; no provider/count call.',
  });
  const prepared = store.prepareJourneyDraft(binding, {
    proposalVersion: 'journey-proposal/1',
    steps,
  });
  const asset = store.asset(
    prepared.run.id,
    'saved.png',
    Buffer.from('synthetic saved source bytes'),
  );
  let startupChecks = 0;
  const runner = new Runner(store, origin, () => {
    startupChecks++;
    throw Error('Synthetic startup approval expired after activation.');
  });
  const planner = new JourneyPlanner(store, {
    async plan() {
      throw Error('This test never calls a model.');
    },
  } as any);
  const start = {
    mode: 'live',
    requestId: randomUUID(),
    target: { url, goal, steps },
    journeyPlan: {
      draftId: binding.draftId,
      ownerHash: binding.ownerHash,
      planId: prepared.plan!.id,
      planHash: prepared.plan!.hash,
    },
  };
  const discard = { draftId: binding.draftId, ownerHash: binding.ownerHash, url, goal };
  const call = async (path: string, body?: unknown, authenticated = true) => {
    let result: { status: number; body: any } | undefined;
    await hostRequest(
      Object.assign(Readable.from(body === undefined ? [] : [JSON.stringify(body)]), {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'x-session-token': authenticated ? 'unit' : 'wrong' },
      }) as any,
      {} as any,
      new URL(path, origin),
      {
        origin,
        token: 'unit',
        store,
        runner,
        planner,
        mode: 'live',
        publicWebsites: true,
        getApproval: () => approved,
        json(_res, status, value) {
          result = { status, body: value };
        },
      },
    );
    assert(result);
    return result;
  };
  return {
    directory,
    store,
    approved,
    binding,
    prepared,
    response,
    planningRequest,
    runner,
    planner,
    start,
    discard,
    call,
    startupChecks: () => startupChecks,
    asset,
    close() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

for (const damage of ['proposal', 'response', 'planning-receipt'] as const) {
  test(`Owned discard removes a damaged ${damage} without weakening ownership or losing charges`, async () => {
    const f = fixture();
    try {
      if (damage === 'proposal')
        f.store.db
          .prepare('UPDATE records SET hash=? WHERE id=?')
          .run('0'.repeat(64), f.prepared.plan!.id);
      if (damage === 'response')
        f.store.db.prepare('DELETE FROM records WHERE id=?').run(f.response.id);
      if (damage === 'planning-receipt') f.store.settle(f.planningRequest, null, 'unknown');
      assert.throws(() => f.store.journeyDraft(f.binding));
      const before = f.store.usage();
      assert.equal((await f.call('/api/host/journey-plans/discard', f.discard, false)).status, 403);
      for (const changed of [
        { ownerHash: digest('other owner') },
        { url: 'https://93.184.216.34/changed' },
        { goal: 'Changed journey.' },
      ]) {
        await assert.rejects(
          f.call('/api/host/journey-plans/discard', { ...f.discard, ...changed }),
        );
        assert.equal(f.store.hasRun(f.prepared.run.id), true);
      }
      assert.equal((await f.call('/api/host/journey-plans/discard', f.discard)).status, 200);
      assert.equal(f.store.hasRun(f.prepared.run.id), false);
      assert.equal(existsSync(join(f.directory, f.prepared.run.id)), false);
      assert.deepEqual(f.store.records(f.prepared.run.id), []);
      assert.equal(f.store.usage().spent, before.spent);
      assert.equal(f.store.usage().reserved, before.reserved);
      assert.equal(f.store.usage().requests.length, before.requests.length);
      assert.equal((await f.call('/api/host/journey-plans/discard', f.discard)).status, 200);
    } finally {
      f.close();
    }
  });
}

test('An actual Runner validation failure after activation ends the saved run and retries only return its exact ID', async () => {
  const f = fixture();
  try {
    const before = f.store.usage(),
      original = f.store.record(f.prepared.run.id, f.prepared.plan!.id)!;
    const first = await f.call('/api/host/runs', f.start);
    assert.deepEqual(first, { status: 201, body: { id: f.prepared.run.id } });
    assert.equal(f.store.run(f.prepared.run.id).state, 'partial');
    assert.equal(f.runner.active, undefined);
    assert.equal(f.startupChecks(), 1);
    assert.equal(f.store.record(f.prepared.run.id, original.id)!.hash, original.hash);
    assert.equal(f.store.usage().spent, before.spent);
    assert.equal(f.store.usage().reserved, before.reserved);
    assert(
      f.store
        .records(f.prepared.run.id)
        .some((record) => record.payload.method === 'journey_start_failed'),
    );
    assert.deepEqual(await f.call('/api/host/runs', f.start), {
      status: 200,
      body: { id: f.prepared.run.id },
    });
    assert.equal(f.startupChecks(), 1);
    for (const reference of [
      { ...f.start.journeyPlan, ownerHash: digest('another synthetic owner') },
      { ...f.start.journeyPlan, draftId: randomUUID() },
      { ...f.start.journeyPlan, planId: randomUUID() },
      { ...f.start.journeyPlan, planHash: '0'.repeat(64) },
    ]) {
      try {
        const refused = await f.call('/api/host/runs', { ...f.start, journeyPlan: reference });
        assert.equal(refused.status, 409);
      } catch (error) {
        assert.match((error as Error).message, /different owner|different|discarded/);
      }
      assert.equal(f.startupChecks(), 1);
    }
    await assert.rejects(
      f.call('/api/host/runs', { ...f.start, requestId: randomUUID() }),
      /not waiting for Start/,
    );
    assert.equal(f.startupChecks(), 1);
    const changed = await f.call('/api/host/runs', {
      ...f.start,
      target: {
        ...f.start.target,
        steps: [{ ...steps[0], text: 'Different exact instruction.' }, steps[1]],
      },
    });
    assert.equal(changed.status, 409);
    assert.equal(f.startupChecks(), 1);
    assert.equal((await f.call('/api/host/journey-plans/discard', f.discard)).status, 200);
    assert.equal((await f.call('/api/host/runs', f.start)).status, 409);
    assert.equal(f.store.usage().spent, before.spent);
  } finally {
    f.close();
  }
});

for (const status of ['unknown', 'sending'] as const) {
  test(`Startup failure preserves the ${status} execution reservation and never repeats Start`, async () => {
    const f = fixture();
    let execution = '',
      starts = 0;
    try {
      f.runner.start = async () => {
        starts++;
        execution = f.store.reserve(f.prepared.run.id, 'driver', 200, f.approved);
        if (status === 'unknown') f.store.settle(execution, null, 'unknown');
        throw Error('Synthetic uncertain startup failure.');
      };
      assert.equal((await f.call('/api/host/runs', f.start)).body.id, f.prepared.run.id);
      assert.equal(f.store.run(f.prepared.run.id).state, 'partial');
      assert.equal(f.store.usage().reserved, 200);
      assert.equal(f.store.usage().requests.find((row) => row.id === execution)!.status, status);
      assert.equal((await f.call('/api/host/runs', f.start)).body.id, f.prepared.run.id);
      assert.equal(starts, 1);
      if (status === 'sending') {
        await assert.rejects(
          f.call('/api/host/journey-plans/discard', f.discard),
          /active paid request/,
        );
        assert.equal(f.store.usage().reserved, 200);
        f.store.settle(execution, null, 'unknown');
      }
      assert.equal((await f.call('/api/host/journey-plans/discard', f.discard)).status, 200);
      assert.equal(f.store.usage().reserved, 200);
      assert.equal(f.store.usage().spent, 600);
    } finally {
      f.close();
    }
  });
}

test('Failed startup cleanup stops only its own active run and records a truthful ended failure', async () => {
  const f = fixture();
  let stopped = '';
  try {
    f.runner.start = async (options) => {
      f.runner.active = { run: options.prepared!.run } as any;
      throw Error('Synthetic failure after own activation.');
    };
    f.runner.stop = async (id) => {
      stopped = id;
      f.store.finish(id, 'stopped', 'Synthetic cleanup stop.');
      f.runner.active = undefined;
    };
    assert.equal((await f.call('/api/host/runs', f.start)).body.id, f.prepared.run.id);
    assert.equal(stopped, f.prepared.run.id);
    assert.equal(f.store.run(f.prepared.run.id).state, 'partial');
    assert.match(f.store.run(f.prepared.run.id).stopReason!, /Start|start/);
  } finally {
    f.close();
  }
});

test('A different active run is never stopped or edited while failed Start is retained', async () => {
  const f = fixture();
  const other = f.store.create('Other synthetic run.', 'https://93.184.216.34/other', 'offline');
  let stopped = false;
  try {
    const originalOther = JSON.stringify(f.store.run(other.id));
    f.runner.start = async () => {
      f.runner.active = { run: other } as any;
      throw Error('Synthetic other-run race.');
    };
    f.runner.stop = async () => {
      stopped = true;
      throw Error('Must never stop the other run.');
    };
    assert.equal((await f.call('/api/host/runs', f.start)).body.id, f.prepared.run.id);
    assert.equal(f.store.run(f.prepared.run.id).state, 'partial');
    assert.equal(stopped, false);
    assert.equal(JSON.stringify(f.store.run(other.id)), originalOther);
    assert.equal(f.runner.active!.run.id, other.id);
  } finally {
    f.close();
  }
});

test('An ended failed Start reconnects after reopening the synthetic store without another startup', async () => {
  const f = fixture();
  try {
    await f.call('/api/host/runs', f.start);
    const reopened = new Store(f.directory);
    try {
      const runner = new Runner(reopened, 'http://127.0.0.1:4317', () => {
        throw Error('A reconnect must not start again.');
      });
      let result: any;
      await hostRequest(
        Object.assign(Readable.from([JSON.stringify(f.start)]), {
          method: 'POST',
          headers: { 'x-session-token': 'unit' },
        }) as any,
        {} as any,
        new URL('/api/host/runs', 'http://127.0.0.1:4317'),
        {
          origin: 'http://127.0.0.1:4317',
          token: 'unit',
          store: reopened,
          runner,
          mode: 'live',
          publicWebsites: true,
          json(_res, status, body) {
            result = { status, body };
          },
        },
      );
      assert.deepEqual(result, { status: 200, body: { id: f.prepared.run.id } });
      assert.equal(reopened.run(f.prepared.run.id).state, 'partial');
      assert.equal(reopened.usage().requests.length, 1);
      assert.equal(reopened.usage().spent, 600);
    } finally {
      reopened.close();
    }
  } finally {
    f.close();
  }
});
