import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NAVIGATOR_RECENT_DECISIONS, Store } from '../src/store.js';
import { navigationActionSchema } from '../src/models.js';
import { completionOnScreen } from '../src/runner.js';

// Owner, 31 Oct: each Booking.com decision re-read every earlier key press (45 by the end),
// so decisions grew from 6 s to 12 s. The navigator now reads its recent steps only.
test('The navigator reads its recent steps; analysis and review still read the whole walk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'navigator-history-'));
  const store = new Store(dir);
  try {
    const run = store.create('Recent history', 'http://127.0.0.1/', 'offline');
    const plan = store.append(run.id, 'plan', 'driver', { steps: [] });
    const done = store.append(run.id, 'navigator_note', 'driver', {
      kind: 'step_completed',
      stepId: 'arrival',
    });
    const actions = [];
    const notes = [];
    for (let i = 0; i < 30; i++) {
      notes.push(
        store.append(run.id, 'navigator_note', 'driver', { kind: 'progress', text: `Step ${i}` }),
      );
      actions.push(
        store.append(run.id, 'action', 'browser', {
          method: 'actual_keyboard_or_browser',
          action: { kind: 'press', key: 'Tab' },
          outcome: 'performed',
        }),
      );
    }
    const ids = (role: 'driver' | 'analyst' | 'reviewer') =>
      new Set(store.snapshot(run.id, role, []).records.map((r) => r.id));

    const driver = ids('driver');
    const recent = actions.slice(-NAVIGATOR_RECENT_DECISIONS);
    assert(
      recent.every((a) => driver.has(a.id)),
      'recent key presses',
    );
    assert(actions.slice(0, -NAVIGATOR_RECENT_DECISIONS).every((a) => !driver.has(a.id)));
    assert(
      notes.slice(-NAVIGATOR_RECENT_DECISIONS).every((n) => driver.has(n.id)),
      'recent notes',
    );
    assert(!driver.has(notes[0]!.id), 'old notes stay out');
    assert(driver.has(plan.id) && driver.has(done.id), 'the plan and finished steps always stay');

    for (const role of ['analyst', 'reviewer'] as const) {
      const all = ids(role);
      assert(
        [...actions, ...notes].every((r) => all.has(r.id)),
        `${role} reads every step`,
      );
    }
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('A key press with a stray step or screenshot label is still that key press', () => {
  const captureId = '18fc92b1-5517-468b-ae05-f22e31a3c232';
  // The exact answer that ended the 31 Oct Booking.com audit.
  const parsed = navigationActionSchema.safeParse({
    captureId,
    key: 'Enter',
    kind: 'press',
    note: 'Activate focused Vuelos to open flights',
  });
  assert(parsed.success);
  assert.deepEqual(parsed.data, {
    kind: 'press',
    key: 'Enter',
    note: 'Activate focused Vuelos to open flights',
  });
  // So is a Tab press: the labels are dropped, not refused.
  const tab = navigationActionSchema.safeParse({
    kind: 'press',
    key: 'Tab',
    stepId: 'flights',
    captureId,
    note: 'Next',
  });
  assert(tab.success);
  assert.deepEqual(tab.data, { kind: 'press', key: 'Tab', note: 'Next' });
  // A step completion still needs both labels, and no input.
  assert(
    navigationActionSchema.safeParse({
      kind: 'step_done',
      stepId: 'flights',
      captureId,
      note: 'Done',
    }).success,
  );
  assert(
    !navigationActionSchema.safeParse({ kind: 'step_done', stepId: 'flights', note: 'Done' })
      .success,
  );
  assert(
    !navigationActionSchema.safeParse({
      kind: 'step_done',
      stepId: 'flights',
      captureId,
      key: 'Enter',
      note: 'Done',
    }).success,
  );
});

test('A "step finished" answer that names no screenshot means the current one', () => {
  const current = '18fc92b1-5517-468b-ae05-f22e31a3c232';
  const other = '6f031a69-0211-452e-800c-e944a55e80be';
  // The exact answer that ended the 31 Oct Booking.com audit.
  const answer = {
    kind: 'step_done',
    note: 'Homepage visible with search and navigation.',
    stepId: 'arrive-home',
  };
  assert(!navigationActionSchema.safeParse(answer).success, 'the plain rules still refuse it');
  assert.deepEqual(completionOnScreen(current).parse(answer), { ...answer, captureId: current });
  // An explicit empty value means the same as leaving it out.
  assert.equal(
    completionOnScreen(current).parse({ ...answer, captureId: null }).captureId,
    current,
  );
  // A screenshot the navigator did name is kept as given; the runner then checks it.
  assert.equal(completionOnScreen(current).parse({ ...answer, captureId: other }).captureId, other);
  // Nothing else is filled in: a key press stays a key press.
  assert.deepEqual(completionOnScreen(current).parse({ kind: 'press', key: 'Tab', note: 'Next' }), {
    kind: 'press',
    key: 'Tab',
    note: 'Next',
  });
});
