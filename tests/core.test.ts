import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { parseSam, MetaModels, actionSchema } from '../src/models.js';
import { PHASE } from '../src/types.js';
import { VoiceOverProbe } from '../src/voiceover.js';
import { voiceOver } from '@guidepup/guidepup';
import { BrowserWalk } from '../src/browser.js';
import { webkit } from 'playwright';
import { Runner } from '../src/runner.js';
import { isCommitment } from '../src/browser.js';
import { isPublicAddress, permittedUrl } from '../src/network.js';
import { approval, keyFromText } from '../src/config.js';
import { overlap, boxPrompt } from '../src/segmentation.js';
const create = () => {
  const dir = mkdtempSync(join(tmpdir(), 'access-walk-'));
  const store = new Store(dir);
  const run = store.create('Test task', 'https://example.org', 'offline');
  return {
    store,
    run,
    close: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
};
const approved = {
  approvedBy: 'Adriano' as const,
  maxUsd: 25,
  maxRunUsd: 3,
  approvedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 86400000).toISOString(),
};
test('No paid approval exists by default', () => {
  assert.throws(() => approval(), /disabled/);
});
test('An empty key line cannot consume another setting or a following comment', () => {
  assert.equal(keyFromText('META_API_KEY=\nPORT=4317'), undefined);
  assert.equal(keyFromText('META_API_KEY=\n# Add a key later'), undefined);
  assert.equal(keyFromText('META_API_KEY=\nMODEL_API_KEY="fake-test-key"'), 'fake-test-key');
});
test('Original evidence, notes and exact analyst claim reach the reviewer', () => {
  const x = create();
  try {
    const { store, run } = x;
    const action = store.append(run.id, 'action', 'browser', { key: 'Tab' });
    const note = store.append(
      run.id,
      'navigator_note',
      'driver',
      { text: 'A limit, not a defect.' },
      [action.id],
    );
    const c = store.append(run.id, 'candidate', 'analyst', { title: 'Example' }, [action.id]);
    const snapshot = store.snapshot(run.id, 'reviewer', [c.id]);
    for (const id of [action.id, note.id, c.id]) assert(snapshot.records.some((r) => r.id === id));
  } finally {
    x.close();
  }
});
test('Missing and foreign evidence cannot be replaced by a summary', () => {
  const x = create();
  try {
    const other = x.store.create('Other', 'https://example.org', 'offline');
    const record = x.store.append(other.id, 'action', 'browser', {});
    assert.throws(() => x.store.append(x.run.id, 'candidate', 'analyst', {}, [record.id]));
    assert.throws(() => x.store.snapshot(x.run.id, 'reviewer', ['absent']));
  } finally {
    x.close();
  }
});
test('Only an accepted exact-version review publishes; new evidence makes it stale', () => {
  const x = create();
  try {
    const { store, run } = x;
    const original = store.append(run.id, 'observation', 'browser', { measured: true });
    const c = store.append(run.id, 'candidate', 'analyst', { title: 'Measured concern' }, [
      original.id,
    ]);
    assert.equal(store.published(run.id).length, 0);
    const read = store.snapshot(run.id, 'reviewer');
    const review = {
      candidateId: c.id,
      candidateHash: c.hash,
      verdict: 'keep',
      title: 'Reviewed concern',
      readSnapshotId: read.read.id,
    };
    store.append(run.id, 'review', 'reviewer', review, [original.id, c.id, read.read.id]);
    assert.equal(store.published(run.id).length, 1);
    store.append(run.id, 'action', 'browser', { new: true });
    assert.equal(store.published(run.id).length, 0);
  } finally {
    x.close();
  }
});
test('Wrong candidate hash and rejected claims remain internal', () => {
  const x = create();
  try {
    const o = x.store.append(x.run.id, 'observation', 'browser', {}),
      c = x.store.append(x.run.id, 'candidate', 'analyst', {}, [o.id]),
      r = x.store.snapshot(x.run.id, 'reviewer');
    x.store.append(
      x.run.id,
      'review',
      'reviewer',
      { candidateId: c.id, candidateHash: 'wrong', verdict: 'keep', readSnapshotId: r.read.id },
      [o.id],
    );
    assert.equal(x.store.published(x.run.id).length, 0);
    x.store.append(
      x.run.id,
      'review',
      'reviewer',
      { candidateId: c.id, candidateHash: c.hash, verdict: 'reject', readSnapshotId: r.read.id },
      [o.id],
    );
    assert.equal(x.store.published(x.run.id).length, 0);
  } finally {
    x.close();
  }
});
test('A rewrite stays internal until the complete corrected candidate receives its own review', () => {
  const x = create();
  try {
    const o = x.store.append(x.run.id, 'observation', 'browser', { name: '' });
    const old = x.store.append(
      x.run.id,
      'candidate',
      'analyst',
      {
        title: 'VoiceOver cannot activate checkout',
        detail: 'Unsupported activation claim',
        recommendation: 'Unsupported fix',
      },
      [o.id],
    );
    const read = x.store.snapshot(x.run.id, 'reviewer');
    x.store.append(
      x.run.id,
      'review',
      'reviewer',
      {
        candidateId: old.id,
        candidateHash: old.hash,
        verdict: 'rewrite',
        title: 'Missing name',
        readSnapshotId: read.read.id,
      },
      [o.id],
    );
    assert.deepEqual(x.store.published(x.run.id), []);
    const corrected = x.store.append(
      x.run.id,
      'candidate',
      'analyst',
      {
        title: 'Missing accessible name',
        detail: 'Measured name is empty',
        recommendation: 'Provide a useful name',
      },
      [o.id],
    );
    const secondRead = x.store.snapshot(x.run.id, 'reviewer');
    x.store.append(
      x.run.id,
      'review',
      'reviewer',
      {
        candidateId: corrected.id,
        candidateHash: corrected.hash,
        verdict: 'keep',
        title: corrected.payload.title,
        readSnapshotId: secondRead.read.id,
      },
      [o.id],
    );
    const published = x.store.published(x.run.id);
    assert.equal(published.length, 1);
    assert.equal(published[0].detail, 'Measured name is empty');
    assert(!JSON.stringify(published).includes('Unsupported'));
  } finally {
    x.close();
  }
});
test('The complete phase allowance fits the run cap in every reservation order', () => {
  const permutations = <T>(items: T[]): T[][] =>
    items.length
      ? items.flatMap((v, i) => permutations(items.filter((_, j) => i !== j)).map((p) => [v, ...p]))
      : [[]];
  for (const order of permutations(['driver', 'analyst', 'reviewer', 'sam'] as const)) {
    const x = create();
    try {
      for (const role of order) {
        const id = x.store.reserve(x.run.id, role, PHASE[role], approved, true);
        x.store.settle(id, PHASE[role], 'completed');
      }
      assert.equal(x.store.usage().spent, 3000000);
    } finally {
      x.close();
    }
  }
});
test('Stop waits for native startup and repeated cleanup stops the reader once', async () => {
  let resolveStart!: () => void,
    calls = 0;
  const starting = new Promise<void>((resolve) => {
    resolveStart = resolve;
  });
  const stop = mock.method(voiceOver, 'stop', async () => {
    calls++;
  });
  try {
    const probe = new VoiceOverProbe({} as any);
    Object.assign(probe, { startedByUs: true, starting });
    const a = probe.cleanup(),
      b = probe.cleanup();
    await Promise.resolve();
    assert.equal(calls, 0);
    resolveStart();
    await Promise.all([a, b]);
    assert.equal(calls, 1);
  } finally {
    stop.mock.restore();
  }
});
test('Browser cleanup shares one close operation', async () => {
  let calls = 0;
  const walk = new BrowserWalk({} as any, 'test', 'http://127.0.0.1:4317');
  walk.browser = {
    close: async () => {
      calls++;
    },
  } as any;
  await Promise.all([walk.close(), walk.close()]);
  assert.equal(calls, 1);
});
test('An unexpected cleanup failure is saved rather than becoming an unhandled run promise', async () => {
  const x = create();
  try {
    const runner = new Runner(x.store, 'https://example.org');
    (runner as any).execute = async () => {
      throw Error('Controlled cleanup failure');
    };
    const run = await runner.start({ mode: 'offline' });
    await runner.completion;
    assert.equal(x.store.run(run.id).state, 'partial');
    assert(
      x.store
        .records(run.id)
        .some((r) => r.kind === 'limit' && r.payload.cleanup === 'Controlled cleanup failure'),
    );
  } finally {
    x.close();
  }
});
test('Stop during browser launch closes the eventual browser before creating a page', async () => {
  const x = create();
  let resolveLaunch!: (browser: any) => void,
    calls = 0;
  const launch = mock.method(
    webkit,
    'launch',
    () =>
      new Promise<any>((resolve) => {
        resolveLaunch = resolve;
      }),
  );
  try {
    const walk = new BrowserWalk(x.store, x.run.id, 'https://example.org');
    const starting = walk.start('https://example.org');
    await Promise.resolve();
    await Promise.resolve();
    assert(resolveLaunch);
    x.store.finish(x.run.id, 'stopped');
    const closing = walk.close();
    resolveLaunch({
      close: async () => {
        calls++;
      },
    });
    await assert.rejects(() => starting, /closing|stopped/);
    await closing;
    assert.equal(calls, 1);
  } finally {
    launch.mock.restore();
    x.close();
  }
});
test('Billed incomplete and invalid model results retain cost without claiming completion', async () => {
  for (const status of ['incomplete', 'completed']) {
    const x = create();
    try {
      const fakeFetch = (async (url: any) =>
        new Response(
          JSON.stringify(
            String(url).endsWith('input_tokens')
              ? { input_tokens: 10 }
              : { status, usage: { input_tokens: 10, output_tokens: 10 }, output: [] },
          ),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )) as typeof fetch;
      const models = new MetaModels(
        x.store,
        fakeFetch,
        () => approved,
        () => 'fake-test-key',
      );
      await assert.rejects(() => models.reason(x.run.id, 'driver', [], [], actionSchema));
      const usage = x.store.usage();
      assert.equal(
        usage.requests[0].status,
        status === 'incomplete' ? 'incomplete' : 'invalid_result',
      );
      assert(usage.spent > 0);
      assert.equal(usage.reserved, 0);
    } finally {
      x.close();
    }
  }
});
test('A stopped run sends neither token-count nor generation requests', async () => {
  const x = create();
  let calls = 0;
  try {
    const models = new MetaModels(
      x.store,
      (async () => {
        calls++;
        return new Response('{}');
      }) as typeof fetch,
      () => approved,
      () => 'fake-test-key',
    );
    x.store.finish(x.run.id, 'stopped');
    await assert.rejects(() => models.reason(x.run.id, 'driver', [], [], actionSchema), /stopped/);
    assert.equal(calls, 0);
  } finally {
    x.close();
  }
});
test('Spending reserves before a request and retains unknown charges', () => {
  const x = create();
  try {
    const id = x.store.reserve(x.run.id, 'driver', 100000, approved);
    assert.equal(x.store.usage().reserved, 100000);
    assert.throws(() => x.store.reserve(x.run.id, 'sam', 2500, approved), /in progress/);
    x.store.settle(id, null, 'unknown');
    assert.equal(x.store.usage().reserved, 100000);
    const next = x.store.reserve(x.run.id, 'sam', 2500, approved);
    x.store.settle(next, 2500, 'completed');
    assert.equal(x.store.usage().spent, 2500);
  } finally {
    x.close();
  }
});
test('Caps protect other phases and the reserved final-review slot', () => {
  const x = create();
  try {
    assert.throws(() => x.store.reserve(x.run.id, 'driver', 1600001, approved));
    for (let n = 0; n < 3; n++) {
      const id = x.store.reserve(x.run.id, 'reviewer', 10000, approved);
      x.store.settle(id, 10000, 'completed');
    }
    assert.throws(() => x.store.reserve(x.run.id, 'reviewer', 10000, approved), /reserved/);
    assert.doesNotThrow(() => x.store.reserve(x.run.id, 'reviewer', 10000, approved, true));
  } finally {
    x.close();
  }
});
test('Expired and unbounded approvals cannot authorise spend', () => {
  const x = create();
  try {
    for (const a of [
      { ...approved, maxUsd: Infinity },
      { ...approved, maxRunUsd: 4 },
      { ...approved, maxRunUsd: NaN },
      { ...approved, expiresAt: 'invalid' },
      { ...approved, expiresAt: '2020-01-01' },
    ])
      assert.throws(() => x.store.reserve(x.run.id, 'driver', 10000, a));
  } finally {
    x.close();
  }
});
test('SAM validates coordinates and preserves real mask tokens without inventing outlines', () => {
  assert.deepEqual(parseSam('', { width: 100, height: 100 }), []);
  const text =
    '<0f>3<|box;x1=10;y1=10;x2=30;y2=30;w=100;h=100;c=0.9|><|mask;x=0;y=0;data=20,20,!abc|>';
  assert.equal(parseSam(text, { width: 100, height: 100 })[0].objectId, '3');
  assert.throws(() => parseSam(text, { width: 1440, height: 900 }));
  assert.throws(() => parseSam('unreadable', { width: 100, height: 100 }));
});
test('Local/private destinations and credential URLs are blocked', async () => {
  for (const ip of [
    '127.0.0.1',
    '10.0.0.1',
    '172.16.1.1',
    '192.168.1.1',
    '169.254.169.254',
    '::1',
    '::ffff:127.0.0.1',
    'fc00::1',
  ])
    assert.equal(isPublicAddress(ip), false, ip);
  assert.equal(isPublicAddress('8.8.8.8'), true);
  await assert.rejects(() => permittedUrl('http://127.0.0.1:9999', 'http://127.0.0.1:4317'));
  await assert.rejects(() =>
    permittedUrl('https://user:pass@example.org', 'http://127.0.0.1:4317'),
  );
  assert.equal(
    (await permittedUrl('http://127.0.0.1:4317/shop', 'http://127.0.0.1:4317')).pathname,
    '/shop',
  );
});
test('Purchase and account boundaries stop; basket actions remain possible', () => {
  for (const text of [
    'Place order',
    'Confirm booking',
    'Pay now',
    'Subscribe',
    'Register',
    'Buy now',
  ])
    assert.equal(isCommitment(text), true, text);
  assert.equal(isCommitment('Add to basket'), false);
  assert.equal(isCommitment('Continue to review'), false);
});
test('Reopening the database keeps original IDs, evidence and reservations without stopping active work', () => {
  const x = create();
  let second: Store | undefined;
  try {
    const r = x.store.append(x.run.id, 'observation', 'browser', { fact: true });
    const request = x.store.reserve(x.run.id, 'sam', 2500, approved);
    x.store.settle(request, null, 'unknown');
    second = new Store(x.store.dir);
    assert.equal(second.record(x.run.id, r.id)?.hash, r.hash);
    assert.equal(second.usage().reserved, 2500);
    assert.equal(second.run(x.run.id).state, 'running');
    second.recoverInterrupted();
    assert.equal(second.run(x.run.id).state, 'interrupted');
  } finally {
    second?.close();
    x.close();
  }
});
test('A changed original picture cannot be supplied as the old evidence', () => {
  const x = create();
  try {
    const asset = x.store.asset(x.run.id, 'original.png', Buffer.from('original'));
    x.store.append(x.run.id, 'capture', 'browser', {
      imageFile: asset.file,
      imageHash: asset.hash,
    });
    assert.equal(x.store.image(x.run.id, 'original.png').toString(), 'original');
    writeFileSync(join(x.store.dir, x.run.id, 'original.png'), 'changed');
    assert.throws(() => x.store.image(x.run.id, 'original.png'), /changed/);
  } finally {
    x.close();
  }
});
test('SAM uses capture pixels, validates visible targets and avoids unrelated geometry', () => {
  const target = {
    id: 'e1',
    tag: 'button',
    role: 'button',
    name: 'Add',
    text: 'Add',
    type: '',
    disabled: false,
    box: { x: 10, y: 20, width: 100, height: 40 },
  };
  assert.equal(boxPrompt(target, 1440, 900), '<0f>1<|box;x1=10;y1=20;x2=110;y2=60;w=1440;h=900|>');
  assert.equal(overlap(target.box, target.box), 1);
  assert.equal(overlap(target.box, { x: 900, y: 900, width: 10, height: 10 }), 0);
  assert.throws(() =>
    boxPrompt({ ...target, box: { x: 1500, y: 20, width: 100, height: 40 } }, 1440, 900),
  );
});
