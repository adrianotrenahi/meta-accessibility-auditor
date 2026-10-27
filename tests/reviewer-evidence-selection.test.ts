import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { CRITERIA_VERSION, evaluateCriteria, makeCriterionScope } from '../src/criteria.js';
import { EvidenceRequestLimit, requestEvidence } from '../src/request-evidence.js';
import type { RecordEntry } from '../src/types.js';

function fixture(count: number) {
  const dir = mkdtempSync(join(tmpdir(), 'access-walk-reviewer-selection-'));
  const store = new Store(dir);
  const run = store.create(
    'Controlled reviewer selection',
    'http://127.0.0.1:4317/shop/',
    'offline',
  );
  const captures = Array.from({ length: count }, (_, i) =>
    store.append(run.id, 'capture', 'browser', {
      stable: true,
      url: run.url + i,
      text: 'Controlled screen ' + i,
      imageFile: `capture_${i}.png`,
      imageHash: 'a'.repeat(64),
      limits: { visibleTextTruncated: false },
    }),
  );
  const scopes = captures.map((capture) =>
    store.append(run.id, 'criterion_scope', 'criteria-planner', makeCriterionScope(capture.id), [
      capture.id,
    ]),
  );
  const candidate = (sources: string[]) =>
    store.append(
      run.id,
      'candidate',
      'analyst',
      {
        title: 'Controlled candidate',
        visiblePremise: 'An observed controlled fact.',
        sources,
      },
      sources,
    );
  const proposal = (capture: RecordEntry, sources = [capture.id]) => {
    const scope = scopes[captures.findIndex((item) => item.id === capture.id)];
    const read = store.snapshot(run.id, 'analyst').read;
    return store.append(
      run.id,
      'criterion_proposal',
      'analyst',
      {
        version: CRITERIA_VERSION,
        scopeId: scope.id,
        checkId: `${capture.id}:C02`,
        criterionId: 'C02',
        verdict: 'FAIL',
        reason: 'Controlled proposal, pending independent review.',
        sources,
        missingEvidence: [],
        screenReaderClaimed: false,
        readSnapshotId: read.id,
      },
      [scope.id, ...sources],
    );
  };
  return {
    store,
    run,
    captures,
    scopes,
    candidate,
    proposal,
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('Optional criteria cannot displace or enlarge current-screen and existing-finding originals', () => {
  const x = fixture(10);
  try {
    const current = x.captures[0];
    const candidate = x.candidate(x.captures.slice(1, 7).map((capture) => capture.id));
    const fitting = x.proposal(x.captures[2]);
    const oversized = x.proposal(x.captures[8], [x.captures[8].id, x.captures[9].id]);
    const walk = x.store.append(x.run.id, 'action', 'browser', { outcome: 'performed' }, [
      current.id,
    ]);
    const note = x.store.append(
      x.run.id,
      'navigator_note',
      'navigator',
      { note: 'Original walk note.' },
      [current.id],
    );
    const read = requestEvidence(x.store, x.run.id, 'reviewer', current);
    const ids = new Set(read.records.map((record) => record.id));
    for (const required of [current, candidate, ...x.captures.slice(1, 7), fitting, walk, note])
      assert(ids.has(required.id));
    assert(!ids.has(oversized.id));
    assert(!ids.has(x.captures[8].id));
    assert(!ids.has(x.captures[9].id));
    assert.equal(read.records.filter((record) => record.kind === 'capture').length, 7);
    assert.equal(
      x.store.records(x.run.id).filter((record) => record.kind === 'criterion_review').length,
      0,
    );
    assert.equal(
      evaluateCriteria(x.store.records(x.run.id), x.run.id, { imageAvailable: () => true }).counts
        .PASS,
      0,
    );
  } finally {
    x.close();
  }
});

test('A fitting criterion carries its exact complete source closure into the reviewer read', () => {
  const x = fixture(3);
  try {
    const measurement = x.store.append(
      x.run.id,
      'observation',
      'browser',
      { stable: true, method: 'controlled_comparison' },
      [x.captures[1].id, x.captures[2].id],
    );
    const originalNote = x.store.append(
      x.run.id,
      'observation',
      'browser',
      { stable: true, method: 'controlled_context' },
      [measurement.id],
    );
    const proposal = x.proposal(x.captures[1], [originalNote.id]);
    x.candidate([x.captures[1].id, x.captures[2].id]);
    const read = requestEvidence(x.store, x.run.id, 'reviewer', x.captures[0]);
    for (const original of [proposal, originalNote, measurement, x.scopes[1], ...x.captures]) {
      const selected = read.records.find((record) => record.id === original.id);
      assert(selected);
      assert.equal(selected.hash, original.hash);
      assert.deepEqual(selected.sources, original.sources);
      const pin = read.read.payload.records.find((entry: any) => entry.id === original.id);
      assert.equal(pin.hash, original.hash);
      assert.deepEqual(pin.sources, original.sources);
    }
  } finally {
    x.close();
  }
});

test('Fitting optional criteria are selected newest first and never exceed five proposals', () => {
  const x = fixture(9);
  try {
    x.candidate(x.captures.slice(1, 7).map((capture) => capture.id));
    const many = Array.from({ length: 6 }, (_, i) => x.proposal(x.captures[i]));
    const extraCapture = x.proposal(x.captures[8]);
    const bounded = requestEvidence(x.store, x.run.id, 'reviewer', x.captures[0]);
    const selected = bounded.records.filter((record) => record.kind === 'criterion_proposal');
    assert.equal(selected.length, 5);
    assert(!selected.some((record) => record.id === extraCapture.id));
    assert(!bounded.records.some((record) => record.id === x.captures[8].id));
    assert(!selected.some((record) => record.id === many[0].id));
    assert(many.slice(1).every((proposal) => selected.some((record) => record.id === proposal.id)));
  } finally {
    x.close();
  }
});

test('Mandatory finding originals still raise the existing limit before any reviewer read is recorded', () => {
  const x = fixture(9);
  try {
    x.candidate(x.captures.slice(1).map((capture) => capture.id));
    const before = x.store.records(x.run.id).length;
    assert.throws(
      () => requestEvidence(x.store, x.run.id, 'reviewer', x.captures[0]),
      (error) => error instanceof EvidenceRequestLimit && error.role === 'reviewer',
    );
    assert.equal(x.store.records(x.run.id).length, before);
  } finally {
    x.close();
  }
});
