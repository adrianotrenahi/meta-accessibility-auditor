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
      {
        id: 'e0',
        selector,
        contextFingerprint: 'a'.repeat(64),
        tag: 'button',
        role: 'button',
        name: '',
        text: '+',
        type: '',
      },
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

test('Positional slots in separate captures never establish a persistent control identity', () => {
  for (const selector of [
    'article:nth-of-type(1) > button:nth-of-type(1)',
    '#products > button:nth-of-type(1)',
  ]) {
    const first = capture('first', selector),
      replacement = capture('replacement', selector);
    const before = candidate('before-product-replacement', first.id);
    const after = candidate('after-product-replacement', replacement.id);
    assert.equal(
      groupPublished([finding(before), finding(after)], [first, replacement, before, after]).length,
      2,
      'The same list position, URL, label and even matching container markup do not establish persistence.',
    );
    const repeated = candidate('same-original-again', first.id, { basis: 'mixed' });
    assert.equal(
      groupPublished([finding(before), finding(repeated)], [first, before, repeated]).length,
      1,
      'The exact same captured control may still group repeated accepted claims.',
    );
  }
});

test('A reused own ID with different original context cannot merge different products', () => {
  const first = capture('first'),
    replacement = capture('replacement');
  replacement.payload.elements[0].contextFingerprint = 'b'.repeat(64);
  const before = candidate('before-product-replacement', first.id);
  const after = candidate('after-product-replacement', replacement.id);
  assert.equal(
    groupPublished([finding(before), finding(after)], [first, replacement, before, after]).length,
    2,
  );
});

test('Old captures without a context fingerprint remain capture-bound even when an own ID matches', () => {
  const first = capture('first'),
    later = capture('later');
  delete first.payload.elements[0].contextFingerprint;
  delete later.payload.elements[0].contextFingerprint;
  const before = candidate('before', first.id),
    after = candidate('after', later.id);
  assert.equal(
    groupPublished([finding(before), finding(after)], [first, later, before, after]).length,
    2,
  );
});

test('An escaped own ID and matching original context may group across captures', () => {
  const first = capture('first', '#product\\:add'),
    later = capture('later', '#product\\:add');
  const before = candidate('before', first.id),
    after = candidate('after', later.id, { basis: 'mixed' });
  assert.equal(
    groupPublished([finding(before), finding(after)], [first, later, before, after]).length,
    1,
  );
});

test('Malformed context fingerprints cannot establish cross-capture identity', () => {
  for (const fingerprint of ['', 'not-a-fingerprint', 'A'.repeat(64), 123, null]) {
    const first = capture('first'),
      later = capture('later');
    first.payload.elements[0].contextFingerprint = fingerprint;
    later.payload.elements[0].contextFingerprint = fingerprint;
    const before = candidate('before', first.id),
      after = candidate('after', later.id);
    assert.equal(
      groupPublished([finding(before), finding(after)], [first, later, before, after]).length,
      2,
    );
  }
});

const instance = 'control-v1:af657a8e-276f-4c26-baa6-311c68202f09:1';
function identifiedCapture(id: string) {
  const c = capture(id);
  Object.assign(c.payload.elements[0], {
    controlInstance: instance,
    controlFingerprint: 'c'.repeat(64),
  });
  return c;
}

test('Hex-escaped own numeric IDs can group, but descendant selectors cannot', () => {
  for (const selector of ['#\\31 add', '#\\31 23', '#product\\:add']) {
    const first = identifiedCapture('first'),
      later = identifiedCapture('later');
    first.payload.elements[0].selector = later.payload.elements[0].selector = selector;
    later.payload.elements[0].contextFingerprint = 'b'.repeat(64);
    const before = candidate('before', first.id),
      after = candidate('after', later.id);
    assert.equal(
      groupPublished([finding(before), finding(after)], [first, later, before, after]).length,
      1,
      selector,
    );
  }
  for (const selector of [
    '#\\31 add > button',
    '#\\31 add button',
    '#products > button:nth-of-type(1)',
  ]) {
    const first = identifiedCapture('first'),
      later = identifiedCapture('later');
    first.payload.elements[0].selector = later.payload.elements[0].selector = selector;
    const before = candidate('before', first.id),
      after = candidate('after', later.id);
    assert.equal(
      groupPublished([finding(before), finding(after)], [first, later, before, after]).length,
      2,
      selector,
    );
  }
});

test('One unchanged unnamed button groups across an outside update using its latest whole accepted claim', () => {
  const first = identifiedCapture('first'),
    later = identifiedCapture('later');
  later.payload.elements[0].contextFingerprint = 'b'.repeat(64);
  const before = candidate('before', first.id);
  const after = candidate('after', later.id, {
    detail: 'Later independently reviewed wording.',
    recommendation: 'Later independently reviewed recommendation.',
    basis: 'mixed',
  });
  before.seq = 2;
  after.seq = 7;
  const records = [first, before, later, after];
  const findings = [finding(before), finding(after)];
  const originals = structuredClone({ records, findings });
  const expected = {
    ...findings[1],
    evidence: [first.id, later.id],
    occurrenceIds: [before.id, after.id],
  };
  assert.deepEqual(groupPublished(findings, records), [expected]);
  const reversed = groupPublished([...findings].reverse(), records)[0];
  assert.equal(
    reversed.id,
    after.id,
    'Representative follows original sequence, not caller order.',
  );
  assert.deepEqual(reversed.review, findings[1].review);
  assert.deepEqual({ records, findings }, originals);
});

test('Changed, replaced, malformed and differently reviewed controls cannot use the new empty-name shortcut', () => {
  const changes = [
    { controlInstance: instance.replace(':1', ':2') },
    { controlInstance: instance.replace('af657a8e', 'bf657a8e') },
    { controlInstance: 'forged' },
    { controlInstance: undefined },
    { controlFingerprint: undefined },
    { controlFingerprint: 'changed' },
    { controlFingerprint: 'd'.repeat(64) },
    { name: 'Add' },
    { text: 'Remove' },
    { selector: '#other' },
    { tag: 'input' },
    { role: 'link' },
    { type: 'submit' },
  ];
  for (const change of changes) {
    const first = identifiedCapture('first'),
      later = identifiedCapture('later');
    Object.assign(later.payload.elements[0], change);
    const before = candidate('before', first.id),
      after = candidate('after', later.id);
    assert.equal(
      groupPublished([finding(before), finding(after)], [first, later, before, after]).length,
      2,
      JSON.stringify(change),
    );
  }
  for (const change of [
    { severity: 'blocker' },
    { issueKey: 'another_problem' },
    { criterion: 'C03' },
  ]) {
    const first = identifiedCapture('first'),
      later = identifiedCapture('later');
    const before = candidate('before', first.id),
      after = candidate('after', later.id, change);
    assert.equal(
      groupPublished([finding(before), finding(after)], [first, later, before, after]).length,
      2,
      JSON.stringify(change),
    );
  }
});

test('Other criteria and nonempty names still require matching surrounding context with new node identity', () => {
  for (const changes of [{ criterion: 'C03' }, { criterion: 'C02', named: true }]) {
    const first = identifiedCapture('first'),
      later = identifiedCapture('later');
    if (changes.named) {
      first.payload.elements[0].name = 'Add';
      later.payload.elements[0].name = 'Add';
    }
    const before = candidate('before', first.id, { criterion: changes.criterion });
    const after = candidate('after', later.id, { criterion: changes.criterion });
    const records = [first, later, before, after];
    assert.equal(groupPublished([finding(before), finding(after)], records).length, 1);
    later.payload.elements[0].contextFingerprint = 'b'.repeat(64);
    assert.equal(groupPublished([finding(before), finding(after)], records).length, 2);
  }
});
