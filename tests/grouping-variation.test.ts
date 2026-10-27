import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupPublished } from '../src/finding-key.js';
import type { RecordEntry } from '../src/types.js';

function record(
  id: string,
  kind: RecordEntry['kind'],
  payload: any,
  sources: string[] = [],
): RecordEntry {
  return {
    id,
    runId: 'same-run',
    seq: 1,
    kind,
    author: kind === 'capture' ? 'browser' : 'analyst',
    payload,
    sources,
    hash: 'original-' + id,
    createdAt: '2026-10-27T19:00:00.000Z',
  };
}
function capture(id: string, selector = '#add') {
  return record(id, 'capture', {
    url: 'http://127.0.0.1:4317/shop/',
    elements: [
      { id: 'e0', selector, tag: 'button', role: 'button', name: '', text: '+', type: '' },
    ],
  });
}
function candidate(id: string, captureId: string, changes: any = {}, sources = [captureId]) {
  return record(
    id,
    'candidate',
    {
      issueKey: 'missing_accessible_name',
      criterion: 'C02',
      basis: 'measured',
      scope: 'element',
      title: 'The add button has no accessible name',
      detail: 'Original first accepted detail.',
      visiblePremise: 'Original exposed name is empty.',
      severity: 'serious',
      recommendation: 'Original first accepted recommendation.',
      targetCaptureId: captureId,
      targetId: 'e0',
      ...changes,
    },
    sources,
  );
}
function finding(c: RecordEntry) {
  return {
    ...c.payload,
    id: c.id,
    evidence: [...c.sources],
    review: { candidateId: c.id, candidateHash: c.hash, verdict: 'keep', premise: 'supported' },
  };
}

test('Accepted basis variations group one control problem while retaining the first accepted claim unchanged', () => {
  const first = capture('first'),
    later = capture('later');
  const measured = candidate('measured', first.id);
  const mixed = candidate('mixed', later.id, {
    basis: 'mixed',
    detail: 'A different accepted description of the same missing name.',
    severity: 'blocker',
    recommendation: 'A different accepted recommendation.',
  });
  const records = [first, later, measured, mixed],
    findings = [finding(measured), finding(mixed)];
  const before = structuredClone({ records, findings });
  const grouped = groupPublished(findings, records);
  assert.equal(grouped.length, 1);
  assert.deepEqual(
    grouped[0],
    {
      ...findings[0],
      evidence: [first.id, later.id],
      occurrenceIds: [measured.id, mixed.id],
    },
    'Grouping must not synthesize a new basis, severity, detail, recommendation or review.',
  );
  assert.deepEqual(
    { records, findings },
    before,
    'Every raw accepted claim and source stays intact.',
  );
});

test('View repetitions group only their declared problem, criterion and exact original source set', () => {
  const original = capture('original'),
    another = capture('another');
  const action = record('open-action', 'action', { key: 'Enter' }, [original.id]);
  const view = {
    scope: 'view',
    targetCaptureId: null,
    targetId: null,
    issueKey: 'dialog_focus_not_moved',
    criterion: 'C04',
    title: 'Focus stays behind the dialog',
  };
  const first = candidate('view-first', original.id, view, [original.id, action.id]);
  const repeated = candidate('view-repeat', original.id, { ...view, basis: 'mixed' }, [
    action.id,
    original.id,
  ]);
  const differentCapture = candidate('different-capture', original.id, view, [
    another.id,
    action.id,
  ]);
  const differentScope = candidate('extra-evidence', original.id, view, [
    original.id,
    action.id,
    another.id,
  ]);
  const differentIssue = candidate(
    'different-issue',
    original.id,
    { ...view, issueKey: 'dialog_label_missing' },
    [original.id, action.id],
  );
  const differentCriterion = candidate(
    'different-criterion',
    original.id,
    { ...view, criterion: 'C05' },
    [original.id, action.id],
  );
  const candidates = [
    first,
    repeated,
    differentCapture,
    differentScope,
    differentIssue,
    differentCriterion,
  ];
  const grouped = groupPublished(candidates.map(finding), [
    original,
    another,
    action,
    ...candidates,
  ]);
  assert.equal(grouped.length, 5);
  assert.deepEqual(grouped[0].occurrenceIds, [first.id, repeated.id]);
  assert.deepEqual(grouped[0].evidence, [original.id, action.id]);
  assert.equal(grouped[0].basis, first.payload.basis);
});

test('Different controls, problems and criteria remain separate when basis is no longer an identity field', () => {
  const first = capture('first'),
    other = capture('other', '#remove');
  const candidates = [
    candidate('add-name', first.id),
    candidate('remove-name', other.id, { basis: 'mixed' }),
    candidate('add-visual', first.id, { issueKey: 'ambiguous_visible_label', basis: 'mixed' }),
    candidate('add-other-criterion', first.id, { criterion: 'C03' }),
  ];
  assert.equal(groupPublished(candidates.map(finding), [first, other, ...candidates]).length, 4);
});

test('Missing source or target identity and legacy claims do not merge by shared URL or title', () => {
  const original = capture('original');
  const ambiguous = capture('ambiguous');
  delete ambiguous.payload.elements[0].selector;
  const view = {
    scope: 'view',
    targetCaptureId: null,
    targetId: null,
    issueKey: 'dialog_focus_not_moved',
  };
  const candidates = [
    candidate('empty-one', original.id, view, []),
    candidate('empty-two', original.id, view, []),
    candidate('unknown-one', ambiguous.id),
    candidate('unknown-two', ambiguous.id),
    candidate('legacy-one', original.id, { issueKey: undefined }),
    candidate('legacy-two', original.id, { issueKey: undefined }),
  ];
  assert.equal(
    groupPublished(candidates.map(finding), [original, ambiguous, ...candidates]).length,
    6,
  );
});
