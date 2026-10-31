import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, digest } from '../src/store.js';
import { MetaModels } from '../src/models.js';
import { JourneyPlanner } from '../src/journey-planner.js';
import { hostRequest } from '../server/host.js';
import type { Runner } from '../src/runner.js';
import { CAPS, tokenCostMicros, type Approval } from '../src/types.js';
// The planner's 10 counted input and 20 output tokens, at the navigator model's price.
const planCharge = tokenCostMicros(CAPS.driver.model, 10, 20);

const steps = [
  { id: 'arrival', text: 'Open the search.', intent: 'navigate', success: 'The form is visible.' },
  {
    id: 'results',
    text: 'Read usable search results.',
    intent: 'verify',
    success: 'The requested results are visible.',
  },
];
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'plan-api-')),
    store = new Store(dir);
  let remote = 0,
    starts = 0;
  let mode: 'offline' | 'live' = 'live';
  const approved: Approval = {
    approvedBy: 'Adriano',
    maxUsd: 5,
    maxRunUsd: 1.4,
    approvedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  };
  const models = new MetaModels(
    store,
    (async (input: any) => {
      remote++;
      return Response.json(
        String(input).endsWith('input_tokens')
          ? { input_tokens: 10 }
          : {
              status: 'completed',
              usage: { input_tokens: 10, output_tokens: 20 },
              output: [
                {
                  type: 'message',
                  content: [{ type: 'output_text', text: JSON.stringify({ steps }) }],
                },
              ],
            },
      );
    }) as typeof fetch,
    () => approved,
    () => 'synthetic-key-no-network',
  );
  const runner = {
    active: undefined,
    async start(options: any) {
      starts++;
      assert.ok(options.prepared);
      const run = options.prepared.run;
      store.append(
        run.id,
        'plan',
        'driver',
        {
          goal: run.goal,
          steps: options.steps,
          requestTargetHash: options.requestTargetHash,
          executionVersion: 'ordered-journey/1',
        },
        [options.prepared.proposalId],
      );
      return run;
    },
    async discard(id: string) {
      store.discard(id);
    },
    async stop(id: string) {
      store.finish(id, 'stopped', 'Synthetic Stop.');
    },
  } as unknown as Runner;
  const planner = new JourneyPlanner(store, models);
  const token = 'synthetic-local-host';
  let origin = '';
  const server = createServer(async (req, res) => {
    const json = (_: any, status: number, body: any) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    try {
      await hostRequest(req, res, new URL(req.url!, origin), {
        origin,
        token,
        store,
        runner,
        planner,
        mode,
        publicWebsites: true,
        json,
        getApproval: () => approved,
      });
    } catch (error) {
      json(res, 400, { error: error instanceof Error ? error.message : 'Refused' });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + (server.address() as any).port;
  const request = async (path: string, body?: unknown, authenticated = true) => {
    const response = await fetch(origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(authenticated ? { 'x-session-token': token } : {}),
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as any };
  };
  const brief = {
    draftId: randomUUID(),
    ownerHash: 'a'.repeat(64),
    url: 'https://93.184.216.34/',
    goal: 'Read actual results without selecting anything.',
  };
  return {
    store,
    runner,
    models,
    planner,
    request,
    approved,
    brief,
    setMode: (value: 'offline' | 'live') => {
      mode = value;
    },
    remote: () => remote,
    starts: () => starts,
    async cleanup() {
      await planner.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test('planning is owner-bound, sends one generation, and is not a browser snapshot', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request('/api/host/journey-plans', f.brief, false)).status, 403);
    assert.equal(f.store.runs().length, 0);
    const [a, b] = await Promise.all([
      f.request('/api/host/journey-plans', f.brief),
      f.request('/api/host/journey-plans', f.brief),
    ]);
    assert.equal(a.status, 200);
    assert.equal(a.body.state, 'prepared');
    assert.deepEqual(a.body, b.body);
    assert.equal(f.remote(), 2);
    assert.equal(f.starts(), 0);
    assert.equal((await f.request('/api/host/runs/' + a.body.id)).status, 409);
    assert.equal(
      (await f.request('/api/host/journey-plans', { ...f.brief, ownerHash: 'b'.repeat(64) }))
        .status,
      400,
    );
    assert.equal(f.remote(), 2);
  } finally {
    await f.cleanup();
  }
});

test('an offline host refuses paid planning even when a public-site flag and key are present', async () => {
  const f = await fixture();
  try {
    f.setMode('offline');
    assert.equal((await f.request('/api/host/journey-plans', f.brief)).status, 400);
    assert.equal(f.remote(), 0);
    assert.equal(f.store.runs().length, 0);
  } finally {
    await f.cleanup();
  }
});
test('edited approved steps start the same charged run once, and retry cannot drop owner or plan binding', async () => {
  const f = await fixture();
  try {
    const proposal = (await f.request('/api/host/journey-plans', f.brief)).body;
    const approvedSteps = [steps[1]];
    const requestId = randomUUID();
    const body = {
      mode: 'live',
      requestId,
      target: { url: f.brief.url, goal: f.brief.goal, steps: approvedSteps },
      journeyPlan: {
        draftId: f.brief.draftId,
        ownerHash: f.brief.ownerHash,
        planId: proposal.planId,
        planHash: proposal.planHash,
      },
    };
    const a = await f.request('/api/host/runs', body),
      b = await f.request('/api/host/runs', body);
    assert.equal(a.status, 201);
    assert.equal(a.body.id, proposal.id);
    assert.equal(b.status, 200);
    assert.equal(b.body.id, proposal.id);
    assert.equal(f.starts(), 1);
    assert.equal(f.remote(), 2);
    assert.equal(f.store.usage(proposal.id).requests.length, 1);
    assert.equal(f.store.usage(proposal.id).spent, planCharge);
    assert.equal(
      (await f.request('/api/host/runs', { ...body, journeyPlan: undefined })).status,
      400,
    );
    assert.equal(
      (
        await f.request('/api/host/runs', {
          ...body,
          journeyPlan: { ...body.journeyPlan, ownerHash: 'b'.repeat(64) },
        })
      ).status,
      400,
    );
    assert.equal(
      (await f.request('/api/host/runs', { ...body, target: { ...body.target, steps } })).status,
      409,
    );
    assert.equal(f.starts(), 1);
    assert.equal(f.remote(), 2);
    assert.equal(f.store.hostStart(requestId), proposal.id);
    assert.equal(f.store.run(proposal.id).state, 'running');
    assert.equal(f.store.records(proposal.id).filter((r) => r.kind === 'plan').length, 2);
    assert.equal(
      digest(JSON.stringify(body.target)),
      f.store.records(proposal.id).at(-1)!.payload.requestTargetHash,
    );
  } finally {
    await f.cleanup();
  }
});
test('expired approval refuses Start without using the browser or losing the prepared proposal', async () => {
  const f = await fixture();
  try {
    const proposal = (await f.request('/api/host/journey-plans', f.brief)).body;
    f.approved.expiresAt = new Date(Date.now() - 1000).toISOString();
    const response = await f.request('/api/host/runs', {
      mode: 'live',
      requestId: randomUUID(),
      target: { url: f.brief.url, goal: f.brief.goal, steps },
      journeyPlan: {
        draftId: f.brief.draftId,
        ownerHash: f.brief.ownerHash,
        planId: proposal.planId,
        planHash: proposal.planHash,
      },
    });
    assert.equal(response.status, 400);
    assert.equal(f.starts(), 0);
    assert.equal(f.store.run(proposal.id).state, 'prepared');
    assert.equal(f.remote(), 2);
  } finally {
    await f.cleanup();
  }
});

test('Start cannot race another unreserved planning request or restart a closing planner', async () => {
  const f = await fixture();
  let release = () => {};
  try {
    const proposal = (await f.request('/api/host/journey-plans', f.brief)).body;
    const body = {
      mode: 'live',
      requestId: randomUUID(),
      target: { url: f.brief.url, goal: f.brief.goal, steps },
      journeyPlan: {
        draftId: f.brief.draftId,
        ownerHash: f.brief.ownerHash,
        planId: proposal.planId,
        planHash: proposal.planHash,
      },
    };
    const original = f.models.plan.bind(f.models);
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.models.plan = async (runId, signal) => {
      await gate;
      return original(runId, signal);
    };
    const another = { ...f.brief, draftId: randomUUID() };
    const pending = f.planner.prepare({
      ...another,
      briefHash: digest(JSON.stringify({ url: another.url, goal: another.goal })),
    });
    assert.equal(f.planner.isPreparing, true);
    assert.equal((await f.request('/api/host/runs', body)).status, 400);
    assert.equal(f.starts(), 0);
    assert.equal(f.store.run(proposal.id).state, 'prepared');
    release();
    await pending;
    await f.planner.close();
    assert.equal((await f.request('/api/host/runs', body)).status, 400);
    assert.equal(f.starts(), 0);
    assert.equal(f.store.run(proposal.id).state, 'prepared');
  } finally {
    release();
    await f.cleanup();
  }
});
