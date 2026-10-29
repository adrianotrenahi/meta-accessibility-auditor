import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { exportHostSnapshot } from '../src/host-export.js';
import { applyHostSnapshot, hostSnapshotSchema } from '../src/host-contract.js';

function sample() {
  const dir = mkdtempSync(join(tmpdir(), 'walk-host-')),
    store = new Store(dir);
  const run = store.create('Controlled proof', 'https://controlled.example/', 'offline');
  const asset = store.asset(run.id, 'original.png', Buffer.from('original image bytes'));
  const capture = store.append(run.id, 'capture', 'browser', {
    imageFile: asset.file,
    imageHash: asset.hash,
    width: 1440,
    height: 900,
    url: run.url,
    title: 'Product',
    stable: true,
    elements: [{ id: 'e1', box: { x: 40, y: 50, width: 60, height: 30 } }],
  });
  const candidate = store.append(
    run.id,
    'candidate',
    'saved_analyst_response',
    {
      title: 'Unnamed button',
      detail: 'Measured missing name.',
      recommendation: 'Add a useful name.',
      criterion: 'C02',
      basis: 'measured',
      severity: 'serious',
      targetId: 'e1',
      privateMemo: 'DO_NOT_EXPORT',
    },
    [capture.id],
  );
  function review(verdict = 'keep') {
    const read = store.snapshot(run.id, 'reviewer');
    return store.append(
      run.id,
      'review',
      'saved_reviewer_response',
      {
        candidateId: candidate.id,
        candidateHash: candidate.hash,
        verdict,
        title: candidate.payload.title,
        sources: [capture.id],
        readSnapshotId: read.read.id,
      },
      [candidate.id, capture.id, read.read.id],
    );
  }
  return {
    store,
    run,
    capture,
    candidate,
    review,
    close: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('Host export contains accepted exact versions and original image identity, without model internals', () => {
  const x = sample();
  try {
    assert.equal(exportHostSnapshot(x.store, x.run.id).snapshot.findings.length, 0);
    const review = x.review();
    x.store.append(x.run.id, 'model_response', 'analyst', { privatePrompt: 'DO_NOT_EXPORT' });
    const { snapshot, assets } = exportHostSnapshot(x.store, x.run.id);
    assert.equal(snapshot.findings[0].candidateHash, x.candidate.hash);
    assert.equal(snapshot.findings[0].reviewHash, review.hash);
    assert.equal(snapshot.findings[0].anchor?.captureId, x.capture.id);
    assert.deepEqual(snapshot.findings[0].anchor?.box, { x: 40, y: 50, width: 60, height: 30 });
    assert(assets.has(snapshot.captures[0].imageFile));
    assert(!JSON.stringify(snapshot).includes('DO_NOT_EXPORT'));
    assert.equal(snapshot.coverage.score, null);
    assert.equal(snapshot.coverage.realVoiceOver, 'not-established');
    assert.equal(snapshot.findings[0].reviewProvenance, 'saved-example');
  } finally {
    x.close();
  }
});

test('A later rejection withdraws a finding, and duplicate or stale delivery cannot restore it', () => {
  const x = sample();
  try {
    x.review();
    const first = exportHostSnapshot(x.store, x.run.id).snapshot;
    x.review('reject');
    const withdrawn = exportHostSnapshot(x.store, x.run.id).snapshot;
    const current = applyHostSnapshot(first, withdrawn);
    assert.equal(current.findings.length, 0);
    assert.equal(applyHostSnapshot(current, first), current);
    assert.equal(applyHostSnapshot(current, withdrawn), current);
  } finally {
    x.close();
  }
});

test('Cross-run delivery, changed originals, foreign anchors and extra private fields are refused', () => {
  const x = sample();
  try {
    x.review();
    const first = exportHostSnapshot(x.store, x.run.id).snapshot;
    assert.throws(
      () =>
        applyHostSnapshot(first, {
          ...first,
          run: { ...first.run, id: 'other' },
          sequence: first.sequence + 1,
        }),
      /different run/,
    );
    assert.throws(
      () =>
        applyHostSnapshot(first, {
          ...first,
          sequence: first.sequence + 1,
          captures: first.captures.map((c) => ({ ...c, title: 'Wrong original' })),
        }),
      /cannot be changed/,
    );
    const wrongAnchor = structuredClone(first);
    wrongAnchor.findings[0].anchor!.captureId = 'foreign';
    assert.equal(hostSnapshotSchema.safeParse(wrongAnchor).success, false);
    assert.equal(
      hostSnapshotSchema.safeParse({ ...first, privateKey: 'DO_NOT_EXPORT' }).success,
      false,
    );
    const wrongImage = structuredClone(first);
    wrongImage.captures[0].imageFile = '../.env';
    assert.equal(hostSnapshotSchema.safeParse(wrongImage).success, false);
  } finally {
    x.close();
  }
});

test('Run completion, recovery and cost changes advance the persisted host revision without new evidence', () => {
  const x = sample();
  try {
    const first = exportHostSnapshot(x.store, x.run.id).snapshot;
    assert.equal(exportHostSnapshot(x.store, x.run.id).snapshot.sequence, first.sequence);
    x.store.finish(x.run.id, 'partial', 'Stopped at a safe boundary');
    const ended = exportHostSnapshot(x.store, x.run.id).snapshot;
    const reopened = new Store(x.store.dir);
    try {
      assert.equal(exportHostSnapshot(reopened, x.run.id).snapshot.sequence, ended.sequence);
    } finally {
      reopened.close();
    }
    assert(ended.sequence > first.sequence);
    assert.equal(applyHostSnapshot(first, ended).run.state, 'partial');
    const run = x.store.create('Recovery', 'https://controlled.example/', 'offline');
    const before = exportHostSnapshot(x.store, run.id).snapshot;
    x.store.recoverInterrupted();
    const after = exportHostSnapshot(x.store, run.id).snapshot;
    assert(after.sequence > before.sequence);
    assert.equal(applyHostSnapshot(before, after).run.state, 'interrupted');
    x.store.db
      .prepare('INSERT INTO requests VALUES(?,?,?,?,?,?,?)')
      .run('test-charge', run.id, 'analyst', 100, null, 'unknown', new Date().toISOString());
    const cost = exportHostSnapshot(x.store, run.id).snapshot;
    assert(cost.sequence > after.sequence);
    assert.equal(cost.cost.heldUnknownUsd, 0.0001);
  } finally {
    x.close();
  }
});

test('One unavailable screenshot withholds its claim without hiding unrelated intact evidence', () => {
  const x = sample();
  try {
    x.review();
    const first = exportHostSnapshot(x.store, x.run.id).snapshot;
    const broken = x.store.append(
      x.run.id,
      'capture',
      'browser',
      { ...x.capture.payload, imageFile: 'missing.png' },
      [],
    );
    x.review();
    const later = exportHostSnapshot(x.store, x.run.id).snapshot;
    assert.equal(later.captures.find((c) => c.id === broken.id)?.imageAvailable, false);
    assert.equal(later.findings.length, 1);
    assert(later.limits.some((line) => line.includes('unavailable')));
    assert.equal(applyHostSnapshot(first, later).captures.length, 2);
    rmSync(join(x.store.dir, x.run.id, x.capture.payload.imageFile));
    const missing = exportHostSnapshot(x.store, x.run.id).snapshot;
    assert.equal(missing.findings.length, 0);
    assert.equal(missing.captures[0].imageAvailable, false);
    assert(missing.sequence > later.sequence);
    assert.equal(applyHostSnapshot(later, missing).captures.length, 2);
  } finally {
    x.close();
  }
});

test('Every original behind a grouped host finding must be available, including an unpinned claim', () => {
  const x = sample();
  try {
    x.review();
    const first = exportHostSnapshot(x.store, x.run.id).snapshot;
    const grouped = structuredClone(first);
    const earlier = grouped.captures[0];
    const later = { ...earlier, id: 'later-original', sequence: earlier.sequence + 1 };
    grouped.captures.push(later);
    grouped.findings[0].captureIds.push(later.id);
    grouped.findings[0].anchor!.captureId = later.id;
    assert.equal(hostSnapshotSchema.safeParse(grouped).success, true);
    const before = JSON.stringify(grouped);
    for (const anchored of [true, false]) {
      const missing = structuredClone(grouped);
      missing.captures[0].imageAvailable = false;
      if (!anchored) missing.findings[0].anchor = null;
      assert.equal(
        hostSnapshotSchema.safeParse(missing).success,
        false,
        'A readable later anchor cannot replace a missing earlier original.',
      );
    }
    const unrelated = structuredClone(grouped);
    unrelated.captures.push({
      ...later,
      id: 'unrelated-missing',
      sequence: later.sequence + 1,
      imageAvailable: false,
    });
    assert.equal(hostSnapshotSchema.safeParse(unrelated).success, true);
    const absent = structuredClone(grouped);
    absent.findings[0].captureIds.push('absent-original');
    const refused = hostSnapshotSchema.safeParse(absent);
    assert.equal(refused.success, false);
    if (!refused.success)
      assert.deepEqual(
        refused.error.issues.map((issue) => issue.message),
        ['Finding refers to missing original capture'],
      );
    const withdrawn = structuredClone(grouped);
    withdrawn.captures[0].imageAvailable = false;
    withdrawn.findings = [];
    withdrawn.sequence++;
    assert.equal(applyHostSnapshot(grouped, withdrawn).findings.length, 0);
    assert.equal(
      JSON.stringify(grouped),
      before,
      'Reading must preserve the original grouped packet.',
    );
  } finally {
    x.close();
  }
});

test('Confirmed discard removes evidence while keeping incurred and uncertain costs in the project limit', () => {
  const x = sample();
  try {
    x.review();
    exportHostSnapshot(x.store, x.run.id);
    x.store.db
      .prepare('INSERT INTO requests VALUES(?,?,?,?,?,?,?)')
      .run('known-cost', x.run.id, 'analyst', 100, 80, 'done', new Date().toISOString());
    x.store.db
      .prepare('INSERT INTO requests VALUES(?,?,?,?,?,?,?)')
      .run('unknown-cost', x.run.id, 'reviewer', 120, null, 'unknown', new Date().toISOString());
    assert.throws(() => x.store.discard(x.run.id), /Stop/);
    x.store.finish(x.run.id, 'stopped', 'Discard requested');
    x.store.discard(x.run.id);
    assert.equal(x.store.hasRun(x.run.id), false);
    assert.deepEqual(x.store.records(x.run.id), []);
    assert.equal(x.store.usage().spent, 80);
    assert.equal(x.store.usage().reserved, 120);
    assert(!JSON.stringify(x.store.usage()).includes(x.run.id));
    x.store.settle('unknown-cost', 90, 'done');
    assert.equal(x.store.usage().spent, 170);
    assert.equal(x.store.usage().reserved, 0);
    x.store.discard(x.run.id);
  } finally {
    x.close();
  }
});

test('A start request keeps its identity across reopen and cannot resurrect discarded evidence', () => {
  const x = sample();
  try {
    const key = '10000000-0000-4000-8000-000000000000';
    const run = x.store.create(
      'Controlled host request',
      'https://controlled.example/',
      'offline',
      key,
    );
    assert.equal(x.store.hostStart(key), run.id);
    const reopened = new Store(x.store.dir);
    try {
      assert.equal(reopened.hostStart(key), run.id);
    } finally {
      reopened.close();
    }
    assert.throws(() => x.store.create('Duplicate', 'https://controlled.example/', 'offline', key));
    assert.equal(x.store.runs().length, 2);
    x.store.finish(run.id, 'stopped');
    x.store.discard(run.id);
    assert.equal(x.store.hostStart(key), null);
    assert.equal(x.store.hostStartDiscarded(key), true);
    assert.equal(x.store.hasRun(run.id), false);
    const cancelled = '20000000-0000-4000-8000-000000000000';
    assert.equal(x.store.discardHostStart(cancelled), null);
    const afterDiscard = new Store(x.store.dir);
    try {
      assert.equal(afterDiscard.hostStartDiscarded(cancelled), true);
      assert.throws(
        () =>
          afterDiscard.create('Late start', 'https://controlled.example/', 'offline', cancelled),
        /discarded/,
      );
      assert.equal(afterDiscard.runs().length, 1);
    } finally {
      afterDiscard.close();
    }
  } finally {
    x.close();
  }
});

test('Failed record deletion preserves originals and pending file cleanup can be retried after reopen', () => {
  const x = sample();
  try {
    const imageFile = join(x.store.dir, x.run.id, x.capture.payload.imageFile);
    x.store.finish(x.run.id, 'stopped');
    x.store.db.exec(
      "CREATE TEMP TRIGGER fail_discard BEFORE DELETE ON runs BEGIN SELECT RAISE(ABORT,'forced discard rollback'); END",
    );
    assert.throws(() => x.store.discard(x.run.id), /forced discard rollback/);
    assert.equal(x.store.hasRun(x.run.id), true);
    assert.equal(existsSync(imageFile), true);
    assert.equal(
      x.store.image(x.run.id, x.capture.payload.imageFile).toString(),
      'original image bytes',
    );
    x.store.db.exec('DROP TRIGGER fail_discard');
    x.store.discard(x.run.id);
    assert.equal(existsSync(imageFile), false);
    mkdirSync(join(x.store.dir, x.run.id));
    writeFileSync(imageFile, 'pending original cleanup');
    x.store.db.prepare('INSERT INTO discard_cleanup VALUES(?)').run(x.run.id);
    const reopened = new Store(x.store.dir);
    try {
      assert.equal(reopened.discardPending(x.run.id), true);
      reopened.discard(x.run.id);
      assert.equal(existsSync(imageFile), false);
      assert.equal(reopened.discardPending(x.run.id), false);
    } finally {
      reopened.close();
    }
  } finally {
    x.close();
  }
});

test('Legacy saved captures gain no invented state receipts or record hashes on reopen', () => {
  const x = sample();
  try {
    const first = exportHostSnapshot(x.store, x.run.id).snapshot;
    const legacy = structuredClone(first);
    for (const capture of legacy.captures) {
      delete capture.recordHash;
      delete capture.screenState;
    }
    const reopened = exportHostSnapshot(x.store, x.run.id).snapshot;
    assert.deepEqual(reopened.captures, legacy.captures);
    assert.equal(reopened.captures[0]!.recordHash, undefined);
    assert.equal(reopened.captures[0]!.screenState, undefined);
    assert.deepEqual(applyHostSnapshot(legacy, reopened).captures, legacy.captures);
    x.store.append(x.run.id, 'capture', 'browser', {
      ...x.capture.payload,
      screenState: {
        version: 'meaningful-screen/1',
        purpose: 'screen',
        fingerprint: 'f'.repeat(64),
      },
    });
    const mixed = exportHostSnapshot(x.store, x.run.id).snapshot;
    assert.deepEqual(mixed.captures[0], legacy.captures[0]);
    assert.equal(mixed.captures[1]!.screenState?.purpose, 'screen');
    assert.deepEqual(applyHostSnapshot(legacy, mixed).captures[0], legacy.captures[0]);
    const forged = structuredClone(reopened);
    forged.sequence++;
    forged.captures[0]!.recordHash = 'a'.repeat(64);
    forged.captures[0]!.screenState = {
      version: 'meaningful-screen/1',
      purpose: 'screen',
      fingerprint: 'f'.repeat(64),
    };
    assert.throws(() => applyHostSnapshot(legacy, forged), /cannot be changed/);
  } finally {
    x.close();
  }
});
