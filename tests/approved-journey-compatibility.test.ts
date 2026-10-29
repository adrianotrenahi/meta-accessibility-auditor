import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { navigationActionSchema } from '../src/models.js';
import { journeyPlanView } from '../src/journey-planner.js';
import {
  approvedJourneyPlanSchema,
  journeyPlanSchema,
  readOrderedJourney,
  currentJourneyInstruction,
  completeJourneyInstruction,
  ORDERED_JOURNEY_VERSION,
} from '../src/journey-steps.js';

test('owner-written steps keep optional metadata while generated plans still require full conditions', () => {
  const ownerSteps = [{ id: 'owner_filter', text: 'Open the available filters.' }];
  assert.deepEqual(approvedJourneyPlanSchema.parse({ steps: ownerSteps }).steps, ownerSteps);
  assert.equal(
    journeyPlanSchema.safeParse({ steps: [ownerSteps[0], { id: 'read', text: 'Read results.' }] })
      .success,
    false,
  );
  const dir = mkdtempSync(join(tmpdir(), 'owner-step-')),
    store = new Store(dir);
  try {
    const run = store.create(
      'Inspect filters without choosing a result.',
      'https://example.com/',
      'offline',
    );
    store.append(run.id, 'plan', 'driver', {
      executionVersion: ORDERED_JOURNEY_VERSION,
      steps: ownerSteps,
    });
    const capture = store.append(run.id, 'capture', 'browser', { stable: true, url: run.url });
    const current = currentJourneyInstruction(readOrderedJourney(store.records(run.id))!);
    assert.equal(current.currentStep?.text, ownerSteps[0]!.text);
    assert.equal('intent' in current.currentStep!, false);
    assert.equal('success' in current.currentStep!, false);
    completeJourneyInstruction(store, run.id, ownerSteps[0]!.id, capture.id, capture);
    assert.equal(readOrderedJourney(store.records(run.id))!.currentIndex, 1);
    assert.equal(
      store.records(run.id).some((record) => record.payload.verdict === 'PASS'),
      false,
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('completion keeps an accepted padded step identity verbatim', () => {
  const exactId = ' arrival ';
  const result = navigationActionSchema.parse({
    kind: 'step_done',
    stepId: exactId,
    captureId: randomUUID(),
    note: 'The exact current original shows the requested arrival.',
  });
  assert.equal(result.stepId, exactId);
});

test('a proposal with a saved Start reports the actual run state instead of unavailable planning', () => {
  for (const state of ['running', 'complete', 'partial', 'stopped', 'interrupted']) {
    const view = journeyPlanView({
      run: { id: 'saved-run', state, startedAt: '2026-10-29T10:00:00.000Z' },
      draft: {},
      plan: null,
    } as any);
    assert.equal(view.state, 'started');
    assert.equal((view as any).runState, state);
    assert.match(view.reason!, /Start has already been requested/);
    assert.equal('steps' in view, false);
  }
});
