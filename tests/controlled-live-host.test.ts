import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { controlledHostMode } from '../server/controlled-live.js';
import { hostRequest } from '../server/host.js';
import { startServer } from '../server/index.js';
import { Store } from '../src/store.js';
import type { Approval } from '../src/types.js';

const approved = (): Approval => ({
  approvedBy: 'Adriano',
  maxUsd: 3,
  maxRunUsd: 2,
  approvedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60000).toISOString(),
});

test('Default host never reads or enables a paid approval, and the ordinary frontend cannot opt in', async () => {
  assert.equal(
    controlledHostMode(false, {
      readApproval() {
        throw Error('Unexpected approval read');
      },
      readKey() {
        throw Error('Unexpected key read');
      },
    }),
    'offline',
  );
  await assert.rejects(
    startServer(0, '/unused', true, { controlledLiveProof: true }),
    /separate local host/,
  );
});

test('Only an explicit small current approval and key enable controlled host inference', () => {
  assert.equal(
    controlledHostMode(true, { readApproval: approved, readKey: () => 'fake-key' }),
    'live',
  );
  for (const patch of [
    { maxUsd: 3.01 },
    { maxUsd: 0 },
    { maxUsd: NaN },
    { maxRunUsd: 3.01 },
    { maxRunUsd: 0 },
    { maxUsd: 1, maxRunUsd: 2 },
    { expiresAt: 'invalid' },
    { expiresAt: new Date(Date.now() - 1).toISOString() },
    { approvedBy: 'Someone else' },
  ])
    assert.throws(
      () =>
        controlledHostMode(true, {
          readApproval: () => ({ ...approved(), ...patch }) as Approval,
          readKey: () => 'fake-key',
        }),
      /current approval capped/,
    );
  assert.throws(
    () => controlledHostMode(true, { readApproval: approved, readKey: () => undefined }),
    /needs a key/,
  );
});

test('Configured live host authenticates and accepts only its fixed mode, with idempotent starts and no Advance', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'access-walk-live-host-contract-'));
  const store = new Store(dir),
    starts: any[] = [];
  const origin = 'http://127.0.0.1:4317';
  const runner = {
    async start(options: any) {
      starts.push(options);
      return store.create(
        options.goal,
        origin + '/shop/?case=broken',
        options.mode,
        options.requestId,
      );
    },
    isWaiting() {
      return false;
    },
  } as any;
  const request = async (method: string, path: string, body?: unknown, authorized = true) => {
    let status = 0,
      result: any;
    const req = Object.assign(Readable.from(body === undefined ? [] : [JSON.stringify(body)]), {
      method,
      headers: { 'x-session-token': authorized ? 'controlled-unit-token' : 'foreign' },
    });
    const res = {
      writeHead(code: number) {
        status = code;
      },
      end(value: string) {
        result = JSON.parse(value);
      },
    };
    await hostRequest(req as any, res as any, new URL(path, origin), {
      origin,
      token: 'controlled-unit-token',
      store,
      runner,
      mode: 'live',
      json(response: any, code: number, value: unknown) {
        response.writeHead(code);
        response.end(JSON.stringify(value));
      },
    });
    return { status, body: result };
  };
  try {
    assert.equal((await request('GET', '/api/host', undefined, false)).status, 403);
    const manifest = (await request('GET', '/api/host')).body;
    assert.equal(manifest.mode, 'live');
    assert.equal(manifest.capabilities.manualCheckpoints, false);
    assert.equal(manifest.modelCalls, 0);
    assert.equal(manifest.modelCallsScope, 'local-history-including-discarded-runs');
    const requestId = randomUUID();
    await assert.rejects(request('POST', '/api/host/runs', { mode: 'offline', requestId }));
    await assert.rejects(
      request('POST', '/api/host/runs', { mode: 'live', requestId, url: 'https://example.org' }),
    );
    assert.equal(starts.length, 0);
    const created = await request('POST', '/api/host/runs', { mode: 'live', requestId });
    assert.equal(created.status, 201);
    assert.deepEqual(
      (await request('POST', '/api/host/runs', { mode: 'live', requestId })).body,
      created.body,
    );
    assert.equal(starts.length, 1);
    assert.equal(starts[0].manualCheckpoints, false);
    assert.equal(starts[0].headless, true);
    assert.equal(starts[0].voiceOver, false);
    assert.equal(starts[0].engine, 'chromium');
    assert.equal(starts[0].mode, 'live');
    assert.equal(
      (await request('POST', `/api/host/runs/${created.body.id}/advance`, { sequence: 1 })).status,
      409,
    );
    assert.equal(
      store.usage().requests.length,
      0,
      'Contract fixture starts no real browser or model.',
    );
    // Local request records are instrumentation; no provider request is made.
    const history = store.create('Earlier local instrumentation', origin + '/shop', 'offline');
    for (const role of ['analyst', 'sam'] as const) {
      const reservation = store.reserve(history.id, role, 1, approved());
      store.settle(reservation, 1, 'completed');
    }
    store.finish(history.id, 'partial');
    store.discard(history.id);
    const current = store.reserve(created.body.id, 'driver', 1, approved());
    store.settle(current, 1, 'completed');
    const counted = (await request('GET', '/api/host')).body;
    assert.equal(counted.modelCalls, 2, 'History includes discarded non-SAM request records.');
    assert.equal(counted.modelCallsScope, 'local-history-including-discarded-runs');
    assert.equal(store.usage(created.body.id).requests.length, 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
