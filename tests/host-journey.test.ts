import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostJourneySchema, journeyProgressFits } from '../src/host-journey.js';
import { hostSnapshotSchema } from '../src/host-contract.js';
const steps = [
  { id: 'open', text: 'Open the form.', intent: 'navigate', success: 'The form is visible.' },
  {
    id: 'results',
    text: 'Read the requested results.',
    intent: 'verify',
    success: 'Usable results show the route.',
  },
];
const original = {
  id: 'screen',
  sequence: 2,
  imageHash: 'a'.repeat(64),
  imageAvailable: true,
  imageFile: `images/${'a'.repeat(64)}.png`,
  width: 1440,
  height: 900,
  url: 'https://example.com/',
  title: 'Example',
  stable: true,
  createdAt: '2026-10-29T10:00:00.000Z',
};
const journey = {
  version: 'ordered-journey-progress/1',
  runId: 'run',
  planId: 'plan',
  planHash: 'b'.repeat(64),
  steps,
  currentStepId: 'results',
  completed: [
    {
      stepId: 'open',
      captureId: 'screen',
      recordId: 'progress',
      recordHash: 'c'.repeat(64),
      sequence: 3,
      meaning: 'navigator-recorded-completion',
    },
  ],
};
const base = {
  protocol: 'access-walk/host-v1',
  provenance: 'saved-engine-records',
  run: {
    id: 'run',
    goal: 'Find results without committing.',
    url: 'https://example.com/',
    state: 'partial',
    mode: 'offline',
    createdAt: '2026-10-29T10:00:00.000Z',
    stopReason: 'Limited proof.',
  },
  sequence: 4,
  captures: [original],
  findings: [],
  coverage: {
    scope: 'limited',
    score: null,
    realVoiceOver: 'not-established',
    sam: 'not-established',
  },
  limits: [],
  cost: { usageEstimateUsd: 0, heldUnknownUsd: 0 },
};
test('ordered host progress keeps its exact current instruction and original completion source', () => {
  const progress = hostJourneySchema.parse(journey);
  assert.equal(journeyProgressFits(progress, base), true);
  assert.deepEqual(hostSnapshotSchema.parse({ ...base, journey }).journey, progress);
});
test('wrong or lost source progress is withheld without removing independently readable originals', () => {
  for (const changed of [
    { ...journey, runId: 'foreign' },
    { ...journey, currentStepId: 'open' },
    { ...journey, completed: [{ ...journey.completed[0], captureId: 'missing' }] },
    { ...journey, completed: [{ ...journey.completed[0], sequence: 1 }] },
    { ...journey, completed: [{ ...journey.completed[0], stepId: 'results' }] },
  ]) {
    const input = { ...base, journey: changed },
      before = JSON.stringify(input);
    const parsed = hostSnapshotSchema.parse(input);
    assert.equal(parsed.journey, undefined);
    assert.deepEqual(parsed.captures, [original]);
    assert.ok(parsed.limits.some((limit) => limit.includes('steps remain unconfirmed')));
    assert.equal(JSON.stringify(input), before);
  }
});
test('missing source image never confirms an instruction and legacy reports remain readable', () => {
  const capture = { ...original, imageAvailable: false };
  const parsed = hostSnapshotSchema.parse({ ...base, captures: [capture], journey });
  assert.equal(parsed.journey, undefined);
  assert.equal(parsed.captures.length, 1);
  const legacy = hostSnapshotSchema.parse(base);
  assert.equal('journey' in legacy, false);
  assert.equal(legacy.coverage.score, null);
});
