import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { CRITERIA_VERSION, evaluateCriteria, makeCriterionScope } from '../src/criteria.js';
import { EvidenceRequestLimit, originalClosure, requestEvidence } from '../src/request-evidence.js';
import type { RecordEntry } from '../src/types.js';

/** Exact return evidence graph emitted by ReturnEvidence, without a browser or model call. */
function returnHistory(preserved = true) {
  const dir = mkdtempSync(join(tmpdir(), 'access-walk-return-closure-'));
  const store = new Store(dir);
  const run = store.create('Controlled return comparison', 'http://127.0.0.1:4317/form', 'offline');
  let number = 0;
  function capture(url = run.url) {
    const image = store.asset(run.id, `capture_${++number}.png`, Buffer.from(`Fixture ${number}`));
    return store.append(run.id, 'capture', 'browser', {
      stable: true,
      url,
      text: 'Controlled email form and review page.',
      imageFile: image.file,
      imageHash: image.hash,
      limits: { visibleTextTruncated: false, imageScope: 'viewport' },
    });
  }
  function action(before: RecordEntry, command: Record<string, unknown>) {
    return store.append(
      run.id,
      'action',
      'browser',
      {
        method: 'actual_keyboard_or_browser',
        sourceCaptureId: before.id,
        sourceImageHash: before.payload.imageHash,
        action: command,
        before: { id: 'email', tag: 'input', type: 'email', name: 'Email address' },
        outcome: 'performed',
        waitAfterMs: 180,
      },
      [before.id],
    );
  }
  const beforeTyping = capture();
  const typed = action(beforeTyping, { kind: 'type', text: 'test@example.org' });
  const entry = capture();
  const baseline = store.append(
    run.id,
    'observation',
    'browser',
    {
      method: 'return_entry_baseline',
      version: 'journey-evidence/1',
      stable: true,
      sourceCaptureId: entry.id,
      typedActionId: typed.id,
      fieldId: 'email',
      baselineRecorded: true,
      limit: 'Only the approved synthetic email was observed; its value is not stored.',
    },
    [beforeTyping.id, typed.id, entry.id],
  );
  const forward = action(entry, { kind: 'press', key: 'Enter' });
  const beforeBack = capture(run.url + '/review');
  const back = action(beforeBack, { kind: 'back' });
  const current = capture();
  const comparison = store.append(
    run.id,
    'observation',
    'browser',
    {
      method: 'return_preservation',
      version: 'journey-evidence/1',
      stable: true,
      beforeCaptureId: beforeBack.id,
      afterCaptureId: current.id,
      actionId: back.id,
      returned: true,
      entriesCompared: true,
      preserved,
      fieldId: 'email',
      entryCaptureId: entry.id,
      typedActionId: typed.id,
      limit: 'The permitted original field was compared after the actual Back action.',
    },
    [beforeBack.id, back.id, current.id, baseline.id, entry.id, typed.id],
  );
  const scope = store.append(run.id, 'criterion_scope', 'runner', makeCriterionScope(current.id), [
    current.id,
  ]);
  const note = store.append(
    run.id,
    'navigator_note',
    'navigator',
    { note: 'Entered the controlled email, continued, then returned.' },
    [entry.id, current.id],
  );
  return {
    store,
    run,
    capture,
    beforeTyping,
    typed,
    entry,
    baseline,
    forward,
    beforeBack,
    back,
    current,
    comparison,
    scope,
    note,
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

for (const preserved of [true, false])
  test(`Reviewer reads the four-picture return history before reviewing C15 ${preserved ? 'PASS' : 'FAIL'}`, () => {
    const x = returnHistory(preserved);
    try {
      const closure = originalClosure(x.store.records(x.run.id), [x.comparison.id]);
      assert.equal(closure.filter((record) => record.kind === 'capture').length, 4);
      // A complete historical analyst read is a test precondition, not a claim that the
      // current three-picture analyst allowance can submit this four-picture history.
      const analyst = x.store.snapshot(x.run.id, 'analyst');
      const proposal = x.store.append(
        x.run.id,
        'criterion_proposal',
        'analyst',
        {
          version: CRITERIA_VERSION,
          scopeId: x.scope.id,
          checkId: `${x.current.id}:C15`,
          criterionId: 'C15',
          verdict: preserved ? 'PASS' : 'FAIL',
          reason: 'The controlled original entry was compared after returning.',
          sources: [x.comparison.id],
          missingEvidence: [],
          screenReaderClaimed: false,
          readSnapshotId: analyst.read.id,
        },
        [x.scope.id, x.comparison.id],
      );
      const reviewer = requestEvidence(x.store, x.run.id, 'reviewer', x.current);
      for (const original of [...closure, x.scope, proposal, x.forward, x.note]) {
        const selected = reviewer.records.find((record) => record.id === original.id);
        assert(selected, `Required original ${original.kind} ${original.id} was not read`);
        assert.equal(selected.hash, original.hash);
        assert.deepEqual(selected.sources, original.sources);
        const pin = reviewer.read.payload.records.find((record: any) => record.id === original.id);
        assert.equal(pin.hash, original.hash);
        assert.deepEqual(pin.sources, original.sources);
      }
      assert.equal(reviewer.records.filter((record) => record.kind === 'capture').length, 4);
      x.store.append(
        x.run.id,
        'criterion_review',
        'reviewer',
        {
          proposalId: proposal.id,
          proposalHash: proposal.hash,
          verdict: 'keep',
          premise: 'supported',
          reason: 'Independently read all original return and typed-entry records.',
          sources: [x.comparison.id],
          readSnapshotId: reviewer.read.id,
        },
        [proposal.id, reviewer.read.id, x.comparison.id],
      );
      const report = evaluateCriteria(x.store.records(x.run.id), x.run.id, {
        imageAvailable(capture) {
          x.store.image(x.run.id, capture.payload.imageFile);
          return true;
        },
      });
      const result = report.results.find((criterion) => criterion.id === 'C15')!.checks[0];
      assert.equal(result.verdict, preserved ? 'PASS' : 'FAIL');
      assert.equal(result.reviewed, true);
      assert.equal(result.complete, true);
      assert.equal(
        report.score,
        null,
        'One reviewed return does not establish all fifteen criteria',
      );
    } finally {
      x.close();
    }
  });

test('The real four-picture return graph exceeds the unchanged three-picture analyst allowance', () => {
  const x = returnHistory();
  try {
    const before = x.store.records(x.run.id).length;
    assert.throws(
      () => requestEvidence(x.store, x.run.id, 'analyst', x.current),
      (error) => error instanceof EvidenceRequestLimit && error.role === 'analyst',
    );
    assert.equal(x.store.records(x.run.id).length, before, 'No incomplete read is recorded');
  } finally {
    x.close();
  }
});

test('Observation closure cannot silently push mandatory reviewer pictures past eight', () => {
  const x = returnHistory();
  try {
    const extra = Array.from({ length: 5 }, (_, i) => x.capture(x.run.url + '/other/' + i));
    x.store.append(
      x.run.id,
      'candidate',
      'analyst',
      { title: 'Existing finding' },
      extra.map((r) => r.id),
    );
    const before = x.store.records(x.run.id).length;
    assert.throws(
      () => requestEvidence(x.store, x.run.id, 'reviewer', x.current),
      (error) => error instanceof EvidenceRequestLimit && error.role === 'reviewer',
    );
    assert.equal(x.store.records(x.run.id).length, before);
  } finally {
    x.close();
  }
});

test('Capture-associated reader results include transitive original observation dependencies', () => {
  const x = returnHistory();
  try {
    const detached = x.capture(x.run.url + '/reader');
    const reader = x.store.append(
      x.run.id,
      'at_check',
      'voiceover',
      { method: 'real_VoiceOver', state: 'inconclusive' },
      [detached.id, x.baseline.id],
    );
    const read = requestEvidence(x.store, x.run.id, 'reviewer', detached);
    for (const required of [detached, reader, x.baseline, x.beforeTyping, x.typed, x.entry, x.note])
      assert(read.records.some((record) => record.id === required.id));
    assert.equal(read.records.filter((record) => record.kind === 'capture').length, 3);
    assert(!read.records.some((record) => record.id === x.comparison.id));
  } finally {
    x.close();
  }
});

test('Changed transitive return originals prevent a request rather than dropping their dependencies', () => {
  const x = returnHistory();
  try {
    x.store.db
      .prepare('UPDATE records SET body=? WHERE id=?')
      .run(JSON.stringify({ ...x.baseline.payload, baselineRecorded: false }), x.baseline.id);
    const before = x.store.records(x.run.id).length;
    assert.throws(
      () => requestEvidence(x.store, x.run.id, 'reviewer', x.current),
      /Required original evidence is missing or changed/,
    );
    assert.equal(x.store.records(x.run.id).length, before);
  } finally {
    x.close();
  }
});

test('Driver retains its one-picture allowance and does not request adjacent return observations', () => {
  const x = returnHistory();
  try {
    const read = requestEvidence(x.store, x.run.id, 'driver', x.current);
    assert.equal(read.records.filter((record) => record.kind === 'capture').length, 1);
    assert(!read.records.some((record) => record.id === x.comparison.id));
    for (const walk of [x.typed, x.forward, x.back, x.note])
      assert(read.records.some((record) => record.id === walk.id));
  } finally {
    x.close();
  }
});
