import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { Store, digest } from '../src/store.js';
import { MetaModels } from '../src/models.js';
import { JourneyPlanner } from '../src/journey-planner.js';
import { Runner } from '../src/runner.js';
import { hostRequest } from '../server/host.js';
import { CAPS, tokenCostMicros, type Approval } from '../src/types.js';
// The planner's 10 counted input and 20 output tokens, at the navigator model's price.
const planCharge = tokenCostMicros(CAPS.driver.model, 10, 20);

const steps = [
  {
    id: 'open',
    text: 'Open the requested page.',
    intent: 'navigate',
    success: 'The page is visible.',
  },
  {
    id: 'read',
    text: 'Read the requested information.',
    intent: 'verify',
    success: 'The requested information is visible.',
  },
];
async function fixture(
  options: { holdGeneration?: boolean; uncertain?: boolean; blockedAddress?: boolean } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'plan-discard-api-')),
    store = new Store(dir);
  let remote = 0,
    release!: (value: Response) => void,
    entered!: () => void,
    aborted!: () => void;
  const generation = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const stopObserved = new Promise<void>((resolve) => {
    aborted = resolve;
  });
  const approved: Approval = {
    approvedBy: 'Adriano',
    approvedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    maxUsd: 5,
    maxRunUsd: 1.4,
  };
  const reply = () =>
    Response.json({
      status: 'completed',
      usage: { input_tokens: 10, output_tokens: 20 },
      output: [
        { type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ steps }) }] },
      ],
    });
  const models = new MetaModels(
    store,
    (async (input: any, init: any) => {
      remote++;
      if (String(input).endsWith('input_tokens')) return Response.json({ input_tokens: 10 });
      entered();
      init.signal.addEventListener('abort', aborted, { once: true });
      if (options.uncertain) throw TypeError('Synthetic provider outcome is unknown.');
      return options.holdGeneration ? generation : reply();
    }) as typeof fetch,
    () => approved,
    () => 'synthetic-key-no-network',
  );
  const planner = new JourneyPlanner(store, models);
  const runner = new Runner(store, 'http://127.0.0.1:4317');
  const body = {
    draftId: randomUUID(),
    ownerHash: digest('synthetic owner'),
    url: options.blockedAddress ? 'http://127.0.0.1/owned' : 'https://93.184.216.34/',
    goal: 'Synthetic private journey words to remove.',
  };
  const binding = {
    ...body,
    briefHash: digest(JSON.stringify({ url: body.url, goal: body.goal })),
  };
  const token = 'synthetic-host-token';
  let origin = '';
  const server = createServer(async (req, res) => {
    const json = (_: any, status: number, value: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    try {
      await hostRequest(req, res, new URL(req.url!, origin), {
        origin,
        token,
        store,
        runner,
        planner,
        mode: 'live',
        publicWebsites: true,
        json,
      });
    } catch (error) {
      json(res, 400, { error: error instanceof Error ? error.message : 'Refused' });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + (server.address() as any).port;
  const post = async (path: string, value: unknown, authenticated = true) => {
    const response = await fetch(origin + path, {
      method: 'POST',
      headers: {
        ...(authenticated ? { 'x-session-token': token } : {}),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(value),
    });
    return { status: response.status, body: (await response.json()) as any };
  };
  return {
    dir,
    store,
    planner,
    body,
    binding,
    post,
    approved,
    started,
    stopObserved,
    release: () => release(reply()),
    remote: () => remote,
    async close() {
      release(reply());
      await planner.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('Cancel after private job persistence removes the charged proposal even before any Start link exists', async () => {
  const f = await fixture();
  try {
    const prepared = await f.planner.prepare(f.binding);
    const requestId = randomUUID();
    assert.equal(f.store.hostStart(requestId), null);
    assert.equal((await f.post(`/api/host/requests/${requestId}/discard`, {})).status, 200);
    assert.equal(
      f.store.hasRun(prepared.run.id),
      true,
      'The Start tombstone alone cannot delete an unstarted preparation.',
    );
    const discarded = await f.post('/api/host/journey-plans/discard', f.body);
    assert.equal(discarded.status, 200);
    assert.deepEqual(discarded.body, { discarded: true });
    assert.equal(f.store.hasRun(prepared.run.id), false);
    assert.deepEqual(f.store.records(prepared.run.id), []);
    assert.equal(f.store.record(prepared.run.id, prepared.plan!.id), undefined);
    assert.equal(f.store.usage().spent, planCharge);
    assert.equal(f.store.journeyDraftDiscarded(f.binding), true);
    await assert.rejects(async () => f.planner.prepare(f.binding));
    assert.equal((await f.post('/api/host/journey-plans/discard', f.body)).status, 200);
    assert.equal(f.remote(), 2);
  } finally {
    await f.close();
  }
});

test('Discard is local and still works for an owned saved address that navigation now refuses', async () => {
  const f = await fixture({ blockedAddress: true });
  try {
    const prepared = await f.planner.prepare(f.binding);
    // This deliberately seeded local address would fail publicDestination;
    // no website or DNS request is needed to delete its owned local records.
    const response = await f.post('/api/host/journey-plans/discard', f.body);
    assert.equal(response.status, 200);
    assert.equal(f.store.hasRun(prepared.run.id), false);
    assert.equal(f.remote(), 2);
  } finally {
    await f.close();
  }
});

test('A pending planner discard waits for its late charge, deletes every original and cannot resurrect the proposal', async () => {
  const f = await fixture({ holdGeneration: true });
  try {
    const pending = f.planner.prepare(f.binding).catch((error) => error);
    await f.started;
    const runId = f.store.journeyDraft(f.binding)!.run.id;
    let finished = false;
    const removal = f.post('/api/host/journey-plans/discard', f.body).then((value) => {
      finished = true;
      return value;
    });
    await f.stopObserved;
    assert.equal(finished, false);
    assert.equal(f.store.run(runId).state, 'stopped');
    assert.equal(f.store.usage(runId).requests[0]!.status, 'sending');
    f.release();
    assert.equal((await removal).status, 200);
    assert((await pending) instanceof Error);
    assert.equal(f.store.hasRun(runId), false);
    assert.equal(f.store.usage().spent, planCharge);
    assert.equal(f.store.records(runId).length, 0);
    await assert.rejects(async () => f.planner.prepare(f.binding));
    assert.equal(f.remote(), 2);
  } finally {
    await f.close();
  }
});

test('Unknown planning charges remain in the cumulative allowance after local discard', async () => {
  const f = await fixture({ uncertain: true });
  try {
    await assert.rejects(f.planner.prepare(f.binding));
    const reserved = f.store.usage().reserved;
    assert(reserved > 0);
    assert.equal((await f.post('/api/host/journey-plans/discard', f.body)).status, 200);
    assert.equal(f.store.usage().reserved, reserved);
    assert.equal(f.store.usage().requests[0]!.status, 'unknown');
    assert.equal(f.store.runs().length, 0);
  } finally {
    await f.close();
  }
});

test('Missing, foreign or changed bindings refuse; tombstone retries remain bound to the same owner and brief', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.post('/api/host/journey-plans/discard', f.body, false)).status, 403);
    assert.equal((await f.post('/api/host/journey-plans/discard', f.body)).status, 404);
    assert.equal(f.store.journeyDraftDiscarded(f.binding), false);
    const prepared = await f.planner.prepare(f.binding);
    for (const changed of [
      { ownerHash: digest('different owner') },
      { goal: 'Different words.' },
      { url: 'https://1.1.1.1/' },
      { url: 'https://user:password@93.184.216.34/' },
    ])
      assert.equal(
        (await f.post('/api/host/journey-plans/discard', { ...f.body, ...changed })).status,
        400,
      );
    assert.equal(f.store.hasRun(prepared.run.id), true);
    assert.equal((await f.post('/api/host/journey-plans/discard', f.body)).status, 200);
    assert.equal(
      (
        await f.post('/api/host/journey-plans/discard', {
          ...f.body,
          ownerHash: digest('different owner'),
        })
      ).status,
      400,
    );
    assert.equal(
      (await f.post('/api/host/journey-plans/discard', { ...f.body, goal: 'Different words.' }))
        .status,
      400,
    );
    assert.equal(f.remote(), 2);
  } finally {
    await f.close();
  }
});

test('A proposal deleted through an already-started request remains idempotent in the second cleanup step', async () => {
  const f = await fixture();
  try {
    const prepared = await f.planner.prepare(f.binding);
    const requestId = randomUUID();
    f.store.activateJourneyDraft(f.binding, {
      requestId,
      planId: prepared.plan!.id,
      planHash: prepared.plan!.hash,
      approval: f.approved,
    });
    f.store.finish(
      prepared.run.id,
      'partial',
      'Synthetic completed browser cleanup; no browser was started.',
    );
    assert.equal((await f.post(`/api/host/requests/${requestId}/discard`, {})).status, 200);
    assert.equal(f.store.hasRun(prepared.run.id), false);
    assert.equal((await f.post('/api/host/journey-plans/discard', f.body)).status, 200);
    assert.equal(f.store.usage().spent, planCharge);
    assert.equal(f.remote(), 2);
  } finally {
    await f.close();
  }
});

test('A discard retry must finish failed physical cleanup before confirming its tombstone', async (t) => {
  const f = await fixture();
  let failure: any;
  try {
    const prepared = await f.planner.prepare(f.binding);
    const asset = f.store.asset(prepared.run.id, 'private.json', Buffer.from(f.body.goal));
    const folder = join(f.dir, prepared.run.id);
    const original = fs.rmSync;
    failure = t.mock.method(fs, 'rmSync', ((path: any, options: any) => {
      if (String(path) === folder) throw Error('Synthetic physical cleanup failure.');
      return original(path, options);
    }) as typeof fs.rmSync);
    syncBuiltinESMExports();
    assert.equal((await f.post('/api/host/journey-plans/discard', f.body)).status, 400);
    assert.equal(f.store.hasRun(prepared.run.id), false);
    assert.equal(f.store.discardPending(prepared.run.id), true);
    assert.equal(f.store.journeyDraftDiscardRun(f.binding), prepared.run.id);
    // The evidence is already in the kept copy; only the run's own folder remains.
    assert.equal(fs.existsSync(folder), true);
    assert.equal(fs.existsSync(join(f.store.keptDir(prepared.run.id), asset.file)), true);
    failure.mock.restore();
    failure = undefined;
    syncBuiltinESMExports();
    const reopened = new Store(f.dir);
    try {
      assert.equal(reopened.journeyDraftDiscardRun(f.binding), prepared.run.id);
      assert.throws(() =>
        reopened.journeyDraftDiscardRun({ ...f.binding, ownerHash: digest('different owner') }),
      );
    } finally {
      reopened.close();
    }
    assert.equal((await f.post('/api/host/journey-plans/discard', f.body)).status, 200);
    assert.equal(fs.existsSync(folder), false);
    assert.equal(fs.existsSync(join(f.store.keptDir(prepared.run.id), asset.file)), true);
    assert.equal(f.store.discardPending(prepared.run.id), false);
    assert.equal(f.store.journeyDraftDiscardRun(f.binding), null);
  } finally {
    failure?.mock.restore();
    syncBuiltinESMExports();
    await f.close();
  }
});
