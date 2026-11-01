import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { journeyEndReason } from '../src/runner.js';
import { completeJourneyInstruction, ORDERED_JOURNEY_VERSION } from '../src/journey-steps.js';

// Owner, 1 Nov: a Booking.com audit finished all 7 steps and still said "Journey stopped".
test('An audit that finished every approved step says so; an unfinished one still says stopped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'journey-end-')),
    store = new Store(dir);
  try {
    const run = store.create('Search flights.', 'https://www.booking.com/', 'offline');
    const steps = [
      { id: 'airports', text: 'Enter the airports.' },
      { id: 'dates', text: 'Choose the dates.' },
    ];
    store.append(run.id, 'plan', 'driver', { executionVersion: ORDERED_JOURNEY_VERSION, steps });
    const stopped = 'Journey stopped. Required tests and coverage remain explicitly scoped.';
    assert.equal(journeyEndReason(store.records(run.id)), stopped);
    for (const step of steps) {
      const capture = store.append(run.id, 'capture', 'browser', { stable: true, url: run.url });
      completeJourneyInstruction(store, run.id, step.id, capture.id, capture);
      if (step.id === 'airports') assert.equal(journeyEndReason(store.records(run.id)), stopped);
    }
    assert.match(
      journeyEndReason(store.records(run.id)),
      /^Journey finished: all 2 approved steps were completed\./,
    );
    // No approved plan (an older audit) keeps the old wording.
    assert.equal(journeyEndReason([]), stopped);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
