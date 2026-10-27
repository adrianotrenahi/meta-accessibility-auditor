import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, digest } from '../src/store.js';
import { CRITERIA_VERSION, makeCriterionScope } from '../src/criteria.js';
import { declareCriterionScopes, recordAnalysisDetails } from '../src/assessment.js';
import { analysisSchema } from '../src/models.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'access-walk-criterion-binding-'));
  const store = new Store(dir);
  const run = store.create(
    'Controlled criterion binding',
    'http://127.0.0.1:4317/shop/',
    'offline',
  );
  const image = store.asset(run.id, 'capture_binding.png', Buffer.from('Controlled binding image'));
  const capture = store.append(run.id, 'capture', 'browser', {
    stable: true,
    url: run.url,
    width: 1440,
    height: 900,
    imageFile: image.file,
    imageHash: image.hash,
    text: 'Canvas bag +',
    limits: { visibleTextTruncated: false },
  });
  declareCriterionScopes(store, run.id);
  const scope = store.records(run.id).find((record) => record.kind === 'criterion_scope')!;
  const observation = store.append(
    run.id,
    'observation',
    'browser',
    {
      stable: true,
      method: 'automatic_accessibility_scan',
      sourceCaptureId: capture.id,
      sourceCaptureHash: capture.hash,
      sourceImageHash: image.hash,
      facts: { schema: 'access-walk/facts-v1', captureId: capture.id },
    },
    [capture.id],
  );
  const note = store.append(
    run.id,
    'navigator_note',
    'navigator',
    { note: 'Observed an unnamed add control.' },
    [capture.id],
  );
  const assessment = {
    captureId: capture.id,
    criterionId: 'C02',
    verdict: 'FAIL',
    reason: 'The original observed control exposes an empty name.',
    sources: [observation.id, note.id, capture.id],
    missingEvidence: [],
    screenReaderClaimed: false,
  };
  return {
    store,
    run,
    capture,
    scope,
    observation,
    note,
    assessment,
    read: () => store.snapshot(run.id, 'analyst'),
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('The analyst names a capture and criterion; the engine binds exact declared IDs without changing sources', () => {
  const x = fixture();
  try {
    const read = x.read();
    const input = { findings: [], coverage: [], criterionProposals: [x.assessment] };
    const raw = JSON.stringify(input);
    const parsed = analysisSchema.parse(input);
    recordAnalysisDetails(x.store, x.run.id, read, [x.capture.id], parsed);
    const proposals = x.store
      .records(x.run.id)
      .filter((record) => record.kind === 'criterion_proposal');
    assert.equal(proposals.length, 1);
    const proposal = proposals[0];
    assert.equal(proposal.payload.scopeId, x.scope.id);
    assert.equal(proposal.payload.checkId, `${x.capture.id}:C02`);
    assert.equal(proposal.payload.version, CRITERIA_VERSION);
    assert.equal(proposal.payload.readSnapshotId, read.read.id);
    assert.deepEqual(proposal.payload.sources, x.assessment.sources);
    assert.deepEqual(proposal.sources, [x.scope.id, ...x.assessment.sources]);
    assert.equal(JSON.stringify(input), raw, 'The raw model result remains unchanged.');
    assert(
      !analysisSchema.safeParse({
        ...input,
        criterionProposals: [{ ...x.assessment, scopeId: x.scope.id }],
      }).success,
    );
  } finally {
    x.close();
  }
});

test('Unknown, foreign, missing, changed, duplicate or incompatible declarations cannot be guessed into a scope', () => {
  for (const damage of [
    'unknown-capture',
    'foreign-capture',
    'missing-scope',
    'changed-scope',
    'rewritten-scope',
    'duplicate-scope',
    'wrong-version',
    'scope-edges',
    'unpinned-scope',
  ] as const) {
    const x = fixture();
    try {
      let assessment: any = { ...x.assessment };
      if (damage === 'unknown-capture') assessment.captureId = 'unknown-original-capture';
      if (damage === 'duplicate-scope')
        x.store.append(
          x.run.id,
          'criterion_scope',
          'criteria-planner',
          makeCriterionScope(x.capture.id),
          [x.capture.id],
        );
      if (damage === 'wrong-version' || damage === 'scope-edges') {
        const payload = {
          ...x.scope.payload,
          ...(damage === 'wrong-version' ? { version: 'future-version' } : {}),
        };
        const sources = damage === 'scope-edges' ? [] : x.scope.sources;
        payload._sourcesHash = digest(JSON.stringify(sources));
        x.store.db
          .prepare('UPDATE records SET body=?,hash=?,sources=? WHERE id=?')
          .run(
            JSON.stringify(payload),
            digest(JSON.stringify(payload)),
            JSON.stringify(sources),
            x.scope.id,
          );
      }
      const read = x.read();
      if (damage === 'missing-scope')
        read.records = read.records.filter((record) => record.id !== x.scope.id);
      if (damage === 'changed-scope')
        read.records.find((record) => record.id === x.scope.id)!.payload.checks[0].requirement =
          'Changed after the original read.';
      if (damage === 'rewritten-scope') {
        const payload = {
          ...x.scope.payload,
          checks: x.scope.payload.checks.map((check: any) => ({
            ...check,
            requirement: 'Rewritten after the retained read.',
          })),
        };
        x.store.db
          .prepare('UPDATE records SET body=?,hash=? WHERE id=?')
          .run(JSON.stringify(payload), digest(JSON.stringify(payload)), x.scope.id);
      }
      if (damage === 'foreign-capture') {
        const foreignRun = x.store.create('Foreign controlled run', x.run.url, 'offline');
        const foreignCapture = x.store.append(
          foreignRun.id,
          'capture',
          'browser',
          x.capture.payload,
        );
        read.records.push(foreignCapture);
        assessment.captureId = foreignCapture.id;
      }
      if (damage === 'unpinned-scope') {
        const withoutScope = x.store.snapshot(x.run.id, 'analyst', [
          x.capture.id,
          x.observation.id,
          x.note.id,
        ]);
        read.read = withoutScope.read;
      }
      recordAnalysisDetails(x.store, x.run.id, read, [x.capture.id], {
        criterionProposals: [assessment],
      });
      const records = x.store.records(x.run.id);
      assert.equal(
        records.filter((record) => record.kind === 'criterion_proposal').length,
        0,
        damage,
      );
      assert(
        records.some(
          (record) => record.kind === 'limit' && record.payload.check === 'criterion_proposal',
        ),
        damage,
      );
    } finally {
      x.close();
    }
  }
});

test('An absent cited original withholds the whole proposal instead of silently dropping that source', () => {
  const x = fixture();
  try {
    const read = x.read();
    const proposal = { ...x.assessment, sources: [...x.assessment.sources, 'unread-original'] };
    const before = JSON.stringify(proposal);
    recordAnalysisDetails(x.store, x.run.id, read, [x.capture.id], {
      criterionProposals: [proposal],
    });
    assert.equal(
      x.store.records(x.run.id).filter((record) => record.kind === 'criterion_proposal').length,
      0,
    );
    assert.equal(JSON.stringify(proposal), before);
  } finally {
    x.close();
  }
});

test('Internal full proposals keep only their exact strict binding; a capture in scopeId is never repaired', () => {
  for (const mistakenId of [false, true]) {
    const x = fixture();
    try {
      const { captureId: _captureId, ...content } = x.assessment;
      const proposal = {
        ...content,
        version: CRITERIA_VERSION,
        scopeId: mistakenId ? x.capture.id : x.scope.id,
        checkId: `${x.capture.id}:C02`,
      };
      recordAnalysisDetails(x.store, x.run.id, x.read(), [x.capture.id], {
        criterionProposals: [proposal],
      });
      const proposals = x.store
        .records(x.run.id)
        .filter((record) => record.kind === 'criterion_proposal');
      assert.equal(proposals.length, mistakenId ? 0 : 1);
      if (proposals[0]) assert.deepEqual(proposals[0].payload.sources, x.assessment.sources);
    } finally {
      x.close();
    }
  }
});
