import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, digest, recordIsIntact } from '../src/store.js';
import { candidateTarget } from '../src/candidate-target.js';
import { exportHostSnapshot } from '../src/host-export.js';
import type { RecordEntry } from '../src/types.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'access-walk-adversarial-'));
  const store = new Store(dir);
  const run = store.create('Inspect an original control', 'http://127.0.0.1:4317/shop/', 'offline');
  function capture(n: number, stable = true) {
    const asset = store.asset(run.id, `capture_${n}.png`, Buffer.from(`original-${n}`));
    return store.append(run.id, 'capture', 'browser', {
      url: run.url,
      title: 'Original screen',
      width: 100,
      height: 100,
      imageFile: asset.file,
      imageHash: asset.hash,
      stable,
      elements: [
        {
          id: 'e0',
          selector: '#add',
          tag: 'button',
          role: 'button',
          name: '',
          text: '+',
          type: '',
          box: { x: 10, y: 10, width: 30, height: 30 },
        },
      ],
    });
  }
  function candidate(
    source: RecordEntry,
    scope: 'element' | 'view' = 'element',
    targetSource = source,
  ) {
    const payload = {
      issueKey: 'missing_accessible_name',
      scope,
      visiblePremise: 'Original measured name is empty.',
      title: 'The control has no accessible name',
      detail: 'The original browser name is empty.',
      criterion: 'C02',
      basis: 'measured',
      severity: 'serious',
      sources: [source.id],
      targetCaptureId: scope === 'element' ? targetSource.id : null,
      targetId: scope === 'element' ? 'e0' : null,
      recommendation: 'Give this control an accessible name.',
    };
    return store.append(run.id, 'candidate', 'analyst', payload, payload.sources);
  }
  function keep(c: RecordEntry, source: RecordEntry, readIds: string[]) {
    const read = store.snapshot(run.id, 'reviewer', [c.id, ...readIds]);
    store.append(
      run.id,
      'review',
      'reviewer',
      {
        candidateId: c.id,
        candidateHash: c.hash,
        verdict: 'keep',
        premise: 'supported',
        title: c.payload.title,
        reason: 'Original evidence supports the unchanged claim.',
        readSnapshotId: read.read.id,
      },
      [source.id, c.id, read.read.id],
    );
  }
  return {
    store,
    run,
    capture,
    candidate,
    keep,
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('A source link rewritten after review cannot move a kept claim to an unread screen', () => {
  const x = fixture();
  try {
    const original = x.capture(0),
      unread = x.capture(1);
    const c = x.candidate(original);
    x.keep(c, original, [original.id]);
    assert.equal(x.store.published(x.run.id).length, 1);
    x.store.db
      .prepare('UPDATE records SET sources=? WHERE id=?')
      .run(JSON.stringify([unread.id]), c.id);
    assert.equal(
      x.store.published(x.run.id).length,
      0,
      'The original payload/review hashes must not bless a changed source edge.',
    );
    assert.equal(exportHostSnapshot(x.store, x.run.id).snapshot.findings.length, 0);
  } finally {
    x.close();
  }
});

test('An unstable original cannot support a view claim through a stable intermediary observation', () => {
  const x = fixture();
  try {
    const unstable = x.capture(0, false);
    const measured = x.store.append(
      x.run.id,
      'observation',
      'browser',
      {
        stable: true,
        method: 'saved browser measurement',
      },
      [unstable.id],
    );
    const c = x.candidate(measured, 'view');
    assert.throws(
      () => candidateTarget(c.payload, x.store.records(x.run.id)),
      /unstable|stable|incomplete/,
      'An intermediary must not hide that its underlying original changed while captured.',
    );
    x.keep(c, measured, [measured.id, unstable.id]);
    assert.equal(x.store.published(x.run.id).length, 0);
  } finally {
    x.close();
  }
});

test('Rewriting an intermediate observation link cannot change a reviewed finding image', () => {
  const x = fixture();
  try {
    const original = x.capture(0),
      unread = x.capture(1);
    const measured = x.store.append(
      x.run.id,
      'observation',
      'browser',
      {
        stable: true,
        measuredName: '',
      },
      [original.id],
    );
    const c = x.candidate(measured, 'element', original);
    assert.equal(candidateTarget(c.payload, x.store.records(x.run.id))?.capture.id, original.id);
    x.keep(c, measured, [measured.id, original.id]);
    assert.equal(x.store.published(x.run.id).length, 1);
    x.store.db
      .prepare('UPDATE records SET sources=? WHERE id=?')
      .run(JSON.stringify([unread.id]), measured.id);
    assert.equal(
      x.store.published(x.run.id).length,
      0,
      'The entire reviewed source graph must remain pinned, not just the candidate links.',
    );
  } finally {
    x.close();
  }
});

test('An unrelated changed screen cannot withdraw a finding whose entire reviewed source graph is intact', () => {
  const x = fixture();
  try {
    const original = x.capture(0),
      unrelated = x.capture(1);
    const c = x.candidate(original);
    x.keep(c, original, [original.id]);
    x.store.db
      .prepare('UPDATE records SET body=? WHERE id=?')
      .run(
        JSON.stringify({ ...unrelated.payload, title: 'Changed unrelated original' }),
        unrelated.id,
      );
    assert.equal(x.store.published(x.run.id).length, 1);
    assert.equal(exportHostSnapshot(x.store, x.run.id).snapshot.findings.length, 1);
  } finally {
    x.close();
  }
});

test('Historical reviews without source pins are explicitly unverified while their original records stay intact', () => {
  const x = fixture();
  try {
    const original = x.capture(0);
    const c = x.candidate(original);
    x.keep(c, original, [original.id]);
    const read = x.store.records(x.run.id).find((record) => record.kind === 'read_snapshot')!;
    const historicalPayload = {
      ...read.payload,
      records: read.payload.records.map((record: { id: string; hash: string }) => ({
        id: record.id,
        hash: record.hash,
      })),
      _sourcesHash: digest(JSON.stringify(read.sources)),
    };
    const body = JSON.stringify(historicalPayload);
    x.store.db
      .prepare('UPDATE records SET body=?,hash=? WHERE id=?')
      .run(body, digest(body), read.id);
    assert(
      recordIsIntact(x.store.record(x.run.id, read.id)!),
      'The fixture represents an intact older format, not a corrupted payload.',
    );
    const before = x.store.records(x.run.id);

    const result = exportHostSnapshot(x.store, x.run.id);
    assert.equal(result.snapshot.findings.length, 0);
    assert.equal(result.snapshot.coverage.scope, 'limited');
    assert(
      result.snapshot.limits.some(
        (limit) =>
          /legacy|earlier|older|historical|unpinned/i.test(limit) &&
          /review|finding/i.test(limit) &&
          /unverified|not verified|cannot be verified|missing.*source|lack.*source|source.*pin/i.test(
            limit,
          ),
      ),
      'The report must explain that historical reviews lack verifiable source pins; an unexplained empty report is misleading.',
    );
    assert.deepEqual(
      x.store.records(x.run.id),
      before,
      'Reading the report must preserve raw claims, reviews and the historical read instead of retroactively adding pins.',
    );
    assert.equal(result.snapshot.captures[0].imageAvailable, true);
    assert.deepEqual(
      x.store.image(x.run.id, original.payload.imageFile),
      Buffer.from('original-0'),
    );
    const keptReview = x.store.records(x.run.id).find((record) => record.kind === 'review')!;
    assert.equal(keptReview.payload.verdict, 'keep');
    assert(
      x.store
        .record(x.run.id, read.id)!
        .payload.records.every((record: { sources?: unknown }) => record.sources === undefined),
    );
  } finally {
    x.close();
  }
});
