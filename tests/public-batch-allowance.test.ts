import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { controlledHostMode } from '../server/controlled-live.js';
import { Store } from '../src/store.js';
import type { Approval } from '../src/types.js';

const approved = (): Approval => ({
  approvedBy: 'Adriano',
  maxUsd: 5,
  maxRunUsd: 3,
  approvedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60000).toISOString(),
});
const settings = (allowed: unknown, key: string | undefined = 'synthetic-test-key') => ({
  readApproval: () => allowed as Approval,
  readKey: () => key,
});
const ordinaryError =
  'Controlled model testing needs a key and a current approval capped at $3 total and per run.';

test('Only the separate explicitly public host accepts a cumulative batch above three dollars', () => {
  for (const maxUsd of [3, 5, 10])
    assert.equal(controlledHostMode(true, settings({ ...approved(), maxUsd }), true), 'live');
  for (const publicWebsites of [undefined, false, 'true', 1]) {
    assert.throws(() => controlledHostMode(true, settings(approved()), publicWebsites as boolean), {
      message: ordinaryError,
    });
    assert.equal(
      controlledHostMode(true, settings({ ...approved(), maxUsd: 3 }), publicWebsites as boolean),
      'live',
    );
  }
  assert.throws(() => controlledHostMode(true, settings({ ...approved(), maxUsd: 3.01 })), {
    message: ordinaryError,
  });
  assert.equal(
    controlledHostMode(
      false,
      {
        readApproval() {
          throw Error('Offline must not read approval');
        },
        readKey() {
          throw Error('Offline must not read key');
        },
      },
      true,
    ),
    'offline',
  );
});

test('Real-website approvals need the owner, a finite optional total, a key and at most $10 per audit', () => {
  const invalid: unknown[] = [
    null,
    undefined,
    [],
    'not an approval',
    5,
    ...[
      { approvedBy: 'Someone else' },
      { maxUsd: 0 },
      { maxUsd: -1 },
      { maxUsd: NaN },
      { maxUsd: Infinity },
      { maxUsd: '5' },
      { maxRunUsd: 10.000001 },
      { maxRunUsd: 0 },
      { maxRunUsd: -1 },
      { maxRunUsd: NaN },
      { maxRunUsd: Infinity },
      { maxRunUsd: '3' },
      { maxRunUsd: undefined },
      { maxUsd: 1, maxRunUsd: 2 },
      { expiresAt: 'invalid' },
      { expiresAt: 77777 },
      { expiresAt: {} },
      { expiresAt: false },
      { expiresAt: undefined },
      { expiresAt: new Date(Date.now() - 1000).toISOString() },
    ].map((patch) => ({ ...approved(), ...patch })),
  ];
  for (const value of invalid) {
    assert.throws(
      () => controlledHostMode(true, settings(value), true),
      /current approval of at most \$10 per audit/,
    );
  }
  // Owner, 31 Oct: at most $10 per audit and no project total for real websites.
  for (const allowed of [
    { ...approved(), maxUsd: undefined, maxRunUsd: 10 },
    { ...approved(), maxUsd: 500, maxRunUsd: 10 },
  ])
    assert.equal(controlledHostMode(true, settings(allowed), true), 'live');
  // The controlled shop keeps its own $3 total and per-run limit.
  for (const allowed of [
    { ...approved(), maxUsd: undefined },
    { ...approved(), maxUsd: 3, maxRunUsd: 3.01 },
  ])
    assert.throws(
      () => controlledHostMode(true, settings(allowed), false),
      /\$3 total and per run/,
    );
  for (const key of [undefined, ''])
    assert.throws(
      () => controlledHostMode(true, { readApproval: approved, readKey: () => key }, true),
      /needs a key/,
    );
  assert.throws(
    () =>
      controlledHostMode(
        true,
        {
          readApproval() {
            throw Error('Synthetic malformed approval file');
          },
          readKey() {
            throw Error('A missing approval must stop before the key read');
          },
        },
        true,
      ),
    /Synthetic malformed approval file/,
  );
});

test('Server passes its explicit public flag to the allowance guard before opening the records', () => {
  const source = readFileSync(new URL('../server/index.ts', import.meta.url), 'utf8');
  const start = source.indexOf('const hostMode = controlledHostMode(');
  const end = source.indexOf('const store = new Store(dir, {', start);
  assert(start >= 0 && end > start, 'The guard must precede the original store opening.');
  // Only the real-website host opens the store with the $10 per-audit ceiling.
  assert.match(
    source.slice(end, end + 200),
    /maxRunMicros: options\.publicWebsites === true \? LIMITS\.runMicros : undefined/,
  );
  const call = source.slice(start, end);
  assert(call.includes('options.controlledLiveProof'), 'The live-host gate must remain explicit.');
  assert.match(
    call,
    /controlledHostMode\(\s*options\.controlledLiveProof,\s*undefined,\s*options\.publicWebsites === true,?\s*\)/,
  );
  const script = readFileSync(new URL('../scripts/serve-host.ts', import.meta.url), 'utf8');
  assert(script.includes("const publicWebsites = process.argv.includes('--public-websites');"));
  assert.match(
    script,
    /controlledLiveProof: controlledLiveProof \|\| publicWebsites,\s*publicWebsites,/,
  );
});

test('Actual public startup accepts only the five-dollar synthetic approval without creating requests or runs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'access-walk-public-batch-startup-'));
  try {
    writeFileSync(join(dir, '.env'), 'META_API_KEY=synthetic-local-startup-no-provider\n', {
      mode: 0o600,
    });
    const serverUrl = new URL('../server/index.ts', import.meta.url).href;
    const moduleLoader = import.meta.resolve('tsx');
    const run = (publicWebsites: boolean, value: unknown = approved()) => {
      writeFileSync(join(dir, 'spend-approval.json'), JSON.stringify(value), { mode: 0o600 });
      const script = `import {startServer} from ${JSON.stringify(serverUrl)}; globalThis.fetch=async()=>{throw Error('No provider or website request may occur in this startup test.');}; let app; try { app=await startServer(0,${JSON.stringify(join(dir, 'records'))},false,{controlledLiveProof:true,publicWebsites:${publicWebsites}}); console.log(JSON.stringify({accepted:true,runs:app.store.runs().length,requests:app.store.usage().requests.length})); } catch(error) { console.log(JSON.stringify({accepted:false,message:error.message})); } finally {await app?.close();}`;
      const child = spawnSync(
        process.execPath,
        ['--import', moduleLoader, '--input-type=module', '-e', script],
        {
          cwd: dir,
          env: { PATH: process.env.PATH ?? '', NODE_NO_WARNINGS: '1' },
          encoding: 'utf8',
          timeout: 15000,
        },
      );
      assert.equal(child.status, 0, child.stderr);
      return JSON.parse(child.stdout);
    };
    assert.deepEqual(run(true), { accepted: true, runs: 0, requests: 0 });
    assert.deepEqual(run(false), { accepted: false, message: ordinaryError });
    for (const value of [null, { ...approved(), maxUsd: 0 }, { ...approved(), maxRunUsd: 10.01 }]) {
      const refused = run(true, value);
      assert.equal(refused.accepted, false);
      assert.match(
        refused.message,
        value === null
          ? /current bounded approval file/
          : /current approval of at most \$10 per audit/,
      );
      assert(!refused.message.includes('synthetic-local-startup-no-provider'));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('The public startup allowance retains the complete old local ledger and the original Store ceilings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'access-walk-public-batch-ledger-'));
  const store = new Store(dir);
  try {
    const allowed = approved();
    assert.equal(controlledHostMode(true, settings(allowed), true), 'live');
    const old = store.create(
      'Synthetic previous local requests',
      'http://127.0.0.1/shop',
      'offline',
    );
    store.db
      .prepare('INSERT INTO requests VALUES(?,?,?,?,?,?,?)')
      .run(
        'earlier-known',
        old.id,
        'analyst',
        1874353,
        1874353,
        'completed',
        new Date().toISOString(),
      );
    store.db
      .prepare('INSERT INTO requests VALUES(?,?,?,?,?,?,?)')
      .run('earlier-unknown', old.id, 'driver', 78087, null, 'unknown', new Date().toISOString());
    store.finish(old.id, 'partial', 'Synthetic earlier unknown charge is held.');
    const before = store.usage(old.id);
    const next = store.create('Synthetic next local run', 'http://127.0.0.1/shop', 'offline');
    const request = store.reserve(next.id, 'driver', 10000, allowed);
    assert.equal(store.usage().spent, 1874353);
    assert.equal(store.usage().reserved, 88087);
    assert.deepEqual(store.usage(old.id), before);
    store.settle(request, 10000, 'completed');
    assert.throws(
      () => store.reserve(next.id, 'driver', 10000, { ...allowed, maxRunUsd: 10.01 }),
      /approval/,
    );
    assert.throws(
      () => store.reserve(next.id, 'driver', 10000, { ...allowed, maxUsd: 1.96 }),
      /Approved project spending limit reached/,
    );
    assert.deepEqual(store.usage(old.id), before);
    assert.equal(
      store.usage(old.id).requests.find((row) => row.id === 'earlier-unknown')?.actual,
      null,
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
