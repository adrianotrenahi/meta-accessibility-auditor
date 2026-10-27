import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, recordIsIntact } from '../src/store.js';
import { presentRecordPayload } from '../src/presentation.js';

test('Presentation hides only the reserved record fingerprint and preserves original evidence', () => {
  const raw = Object.freeze({
    _sourcesHash: 'internal-record-fingerprint',
    method: 'actual_keyboard_or_browser',
    text: 'A website can literally mention _sourcesHash without losing its content.',
    imageHash: 'original-image-fingerprint',
    sourceIds: ['original-observation'],
    nested: { value: 'Original recorded detail' },
  });
  const before = JSON.stringify(raw);
  const visible = presentRecordPayload(raw);
  assert.equal(Object.hasOwn(visible, '_sourcesHash'), false);
  const { _sourcesHash: internal, ...expected } = raw;
  assert.equal(internal, 'internal-record-fingerprint');
  assert.deepEqual(visible, expected);
  assert.equal(JSON.stringify(raw), before);
  assert.equal(raw._sourcesHash, 'internal-record-fingerprint');
  assert.notEqual(visible, raw);
});

test('Published findings and reviews omit internal fingerprints without rewriting originals or read manifests', () => {
  const dir = mkdtempSync(join(tmpdir(), 'access-walk-presentation-'));
  const store = new Store(dir);
  try {
    const run = store.create('Read an original control', 'http://127.0.0.1:4317/shop/', 'offline');
    const capture = store.append(run.id, 'capture', 'browser', {
      stable: true,
      text: 'Original controlled screen',
    });
    const observation = store.append(
      run.id,
      'observation',
      'browser',
      { stable: true, name: '', method: 'browser measurement' },
      [capture.id],
    );
    const candidate = store.append(
      run.id,
      'candidate',
      'analyst',
      {
        issueKey: 'missing_accessible_name',
        title: 'The basket button has no accessible name',
        detail: 'The browser exposes an empty name.',
        criterion: 'C02',
        basis: 'measured',
        severity: 'serious',
        recommendation: 'Give the button a useful name.',
      },
      [observation.id],
    );
    const read = store.snapshot(run.id, 'reviewer');
    const review = store.append(
      run.id,
      'review',
      'reviewer',
      {
        candidateId: candidate.id,
        candidateHash: candidate.hash,
        verdict: 'keep',
        premise: 'supported',
        title: candidate.payload.title,
        reason: 'The original measurement supports this exact claim.',
        readSnapshotId: read.read.id,
      },
      [observation.id, candidate.id, read.read.id],
    );
    const originalRecords = JSON.stringify(store.records(run.id));
    const published = store.published(run.id);
    assert.equal(published.length, 1);
    assert.equal(Object.hasOwn(published[0], '_sourcesHash'), false);
    assert.equal(Object.hasOwn(published[0].review, '_sourcesHash'), false);
    assert.equal(published[0].title, candidate.payload.title);
    assert.equal(published[0].detail, candidate.payload.detail);
    assert.deepEqual(published[0].evidence, [observation.id]);
    assert.equal(published[0].review.candidateHash, candidate.hash);
    assert.equal(JSON.stringify(store.records(run.id)), originalRecords);
    for (const original of [capture, observation, candidate, read.read, review]) {
      const retained = store.record(run.id, original.id)!;
      assert.equal(retained.hash, original.hash);
      assert.equal(typeof retained.payload._sourcesHash, 'string');
      assert(recordIsIntact(retained));
    }
    assert.deepEqual(
      store.record(run.id, read.read.id)?.payload.records,
      read.read.payload.records,
    );
    assert.equal(
      store.published(run.id).length,
      1,
      'Repeated presentation reads keep the exact accepted claim available.',
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
