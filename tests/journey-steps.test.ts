import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import {
  ORDERED_JOURNEY_VERSION,
  journeyPlanSchema,
  readOrderedJourney,
  currentJourneyInstruction,
  completeJourneyInstruction,
} from '../src/journey-steps.js';

const steps = [
  {
    id: 'open',
    text: 'Open the flight search',
    intent: 'navigate' as const,
    success: 'The flight-search form is visible.',
  },
  {
    id: 'route',
    text: 'Enter the requested route',
    intent: 'form' as const,
    success: 'The form shows the requested departure and arrival.',
  },
  {
    id: 'results',
    text: 'Read usable results without choosing a flight',
    intent: 'verify' as const,
    success: 'Actual results show the applied route and dates.',
  },
];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ordered-journey-')),
    store = new Store(dir);
  const run = store.create(
    'Find a flight, stopping before selection.',
    'https://example.com/',
    'offline',
  );
  const plan = store.append(run.id, 'plan', 'driver', {
    executionVersion: ORDERED_JOURNEY_VERSION,
    steps,
  });
  const capture = () => store.append(run.id, 'capture', 'browser', { stable: true, url: run.url });
  const first = capture();
  return {
    store,
    run,
    plan,
    first,
    capture,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test('generated plans require distinct specific instructions with completion conditions', () => {
  assert.equal(journeyPlanSchema.safeParse({ steps }).success, true);
  for (const invalid of [
    { steps: [] },
    { steps: [steps[0]] },
    { steps: [steps[0], steps[0]] },
    { steps: [{ ...steps[0], success: '' }, steps[1]] },
    { steps, invented: 'unsupported' },
    {
      steps: [
        steps[0],
        {
          ...steps[1],
          text: 'Follow the journey described above, stopping before any commitment.',
        },
      ],
    },
  ])
    assert.equal(journeyPlanSchema.safeParse(invalid).success, false);
});
test('the navigator receives one current instruction, and earlier completion persists', () => {
  const f = fixture();
  try {
    const before = JSON.stringify(f.store.records(f.run.id));
    const start = readOrderedJourney(f.store.records(f.run.id))!;
    assert.equal(currentJourneyInstruction(start).currentStep?.id, 'open');
    assert.deepEqual(currentJourneyInstruction(start).completedStepIds, []);
    assert.equal(JSON.stringify(f.store.records(f.run.id)), before);
    completeJourneyInstruction(f.store, f.run.id, 'open', f.first.id, f.first);
    const next = readOrderedJourney(f.store.records(f.run.id))!;
    assert.equal(next.currentIndex, 1);
    assert.equal(currentJourneyInstruction(next).currentStep?.id, 'route');
    assert.deepEqual(currentJourneyInstruction(next).completedStepIds, ['open']);
    assert.deepEqual(f.store.record(f.run.id, f.first.id), f.first);
  } finally {
    f.cleanup();
  }
});
test('out-of-order, wrong-source and duplicate completion do not advance the journey', () => {
  const f = fixture();
  try {
    for (const [step, capture] of [
      ['route', f.first.id],
      ['open', 'missing'],
    ])
      assert.throws(() => completeJourneyInstruction(f.store, f.run.id, step!, capture!, f.first));
    completeJourneyInstruction(f.store, f.run.id, 'open', f.first.id, f.first);
    assert.throws(() => completeJourneyInstruction(f.store, f.run.id, 'open', f.first.id, f.first));
    assert.equal(readOrderedJourney(f.store.records(f.run.id))!.currentIndex, 1);
  } finally {
    f.cleanup();
  }
});
test('a changed original or stopped run cannot complete an instruction', () => {
  const f = fixture();
  try {
    assert.throws(() =>
      completeJourneyInstruction(f.store, f.run.id, 'open', f.first.id, {
        ...f.first,
        payload: { ...f.first.payload, stable: false },
      }),
    );
    f.store.finish(f.run.id, 'stopped', 'Owner stopped.');
    assert.throws(() => completeJourneyInstruction(f.store, f.run.id, 'open', f.first.id, f.first));
    assert.equal(readOrderedJourney(f.store.records(f.run.id))!.currentIndex, 0);
  } finally {
    f.cleanup();
  }
});
test('all recorded steps finish the cursor without settling a criterion or rewriting originals', () => {
  const f = fixture();
  try {
    for (const [index, step] of steps.entries()) {
      const cap = index === 0 ? f.first : f.capture();
      completeJourneyInstruction(f.store, f.run.id, step.id, cap.id, cap);
    }
    const result = readOrderedJourney(f.store.records(f.run.id))!;
    assert.equal(currentJourneyInstruction(result).currentStep, null);
    assert.equal(result.completed.length, 3);
    assert.equal(
      f.store.records(f.run.id).some((r) => r.kind === 'criterion_review'),
      false,
    );
    assert.equal(f.store.run(f.run.id).state, 'running');
  } finally {
    f.cleanup();
  }
});
test('legacy saved plans are not silently reinterpreted as ordered plans', () => {
  const f = fixture();
  try {
    assert.equal(readOrderedJourney([{ ...f.plan, payload: { steps } }]), null);
  } finally {
    f.cleanup();
  }
});
test('tampered completion notes are refused rather than credited as progress', () => {
  const f = fixture();
  try {
    completeJourneyInstruction(f.store, f.run.id, 'open', f.first.id, f.first);
    const records = f.store.records(f.run.id);
    const changed = records.map((r) =>
      r.payload.kind === 'step_completed'
        ? { ...r, payload: { ...r.payload, stepId: 'results' } }
        : r,
    );
    assert.throws(() => readOrderedJourney(changed));
  } finally {
    f.cleanup();
  }
});
