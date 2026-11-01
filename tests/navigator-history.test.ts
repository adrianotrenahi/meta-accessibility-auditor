import { LIMITS, DECISIONS_PER_FORM_STEP, type Approval } from '../src/types.js';
import { RoleAllowanceLimit } from '../src/role-allowance.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NAVIGATOR_RECENT_DECISIONS, Store, navigatorWindowStart } from '../src/store.js';
import { navigationActionSchema } from '../src/models.js';
import { completionOnScreen, checkpointReviewAllowed } from '../src/runner.js';

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
    // Owner, 1 Nov: the window moves in blocks of eight for prompt caching (30 decisions: 16-29).
    const start = navigatorWindowStart(actions.length);
    assert.equal(start, 16);
    const recent = actions.slice(start);
    assert(
      recent.every((a) => driver.has(a.id)),
      'recent key presses',
    );
    assert(actions.slice(0, start).every((a) => !driver.has(a.id)));
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

test('A control named both by number and by name is kept when both mean the same control', () => {
  const current = '18fc92b1-5517-468b-ae05-f22e31a3c232';
  const elements = [
    { id: 'e9', role: 'menuitem', name: 'Flights' },
    { id: 'e10', role: 'menuitem', name: 'Car rental' },
  ];
  // The answer refused at 63 s in the 31 Oct Booking.com audit.
  const answer = {
    kind: 'focus_target',
    note: 'Reach Flights nav item to open flight search',
    targetId: 'e9',
    targetRole: 'menuitem',
    targetName: 'Flights',
    traversalKey: 'Tab',
  };
  assert(!navigationActionSchema.safeParse(answer).success, 'the plain rules refuse it');
  const kept = completionOnScreen(current, elements).parse(answer);
  assert.equal(kept.targetId, 'e9');
  assert(!('targetRole' in kept) && !('targetName' in kept));
  // Number and name that point to different controls stay refused.
  assert(
    !completionOnScreen(current, elements).safeParse({ ...answer, targetName: 'Car rental' })
      .success,
  );
  // A number that is not on this screen stays refused too.
  assert(!completionOnScreen(current, elements).safeParse({ ...answer, targetId: 'e99' }).success);
});

// Codex, PR 59: the store still refused the navigator's 21st request in an audit, so the
// per-step allowance could never be used. Its count is now only a whole-audit backstop.
test('One audit can make more than twenty navigator requests, up to the backstop', () => {
  const dir = mkdtempSync(join(tmpdir(), 'navigator-backstop-'));
  const store = new Store(dir);
  try {
    const run = store.create('Many decisions', 'https://www.booking.com/', 'offline');
    const approval: Approval = {
      approvedBy: 'Adriano',
      maxRunUsd: 3,
      approvedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    };
    for (let i = 0; i < LIMITS.driver; i++)
      store.settle(store.reserve(run.id, 'driver', 1, approval), 1, 'completed');
    assert(LIMITS.driver > 20 * 1 && LIMITS.driver >= 12 * DECISIONS_PER_FORM_STEP);
    assert.throws(() => store.reserve(run.id, 'driver', 1, approval), RoleAllowanceLimit);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// Owner, 31 Oct: "8 at most? no. It should check all screens that go to the strip".
test('The analyst and reviewer can check far more than eight screens in one audit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'every-strip-screen-'));
  const store = new Store(dir);
  try {
    const run = store.create('Many screens', 'https://www.booking.com/', 'offline');
    const approval: Approval = {
      approvedBy: 'Adriano',
      maxRunUsd: 3,
      approvedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    };
    for (let i = 0; i < 30; i++) {
      store.settle(store.reserve(run.id, 'analyst', 1, approval), 1, 'completed');
      store.settle(store.reserve(run.id, 'reviewer', 1, approval), 1, 'completed');
      // The robot's own gate still lets each new checkpoint be reviewed (not only the first 3).
      assert(checkpointReviewAllowed(store, run.id), `review ${i + 2} allowed`);
    }
    assert(LIMITS.analyst >= 30 && LIMITS.reviewer >= 31);
    while (
      store.usage(run.id).requests.filter((r) => r.role === 'reviewer').length <
      LIMITS.reviewer - 1
    )
      store.settle(store.reserve(run.id, 'reviewer', 1, approval), 1, 'completed');
    assert(!checkpointReviewAllowed(store, run.id), 'the final review keeps its slot');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// Owner, 1 Nov: eDreams offers keyboard users an accessible mode ("press Enter"); a keyboard
// user would take it, so the navigator does too. Owner, PR 77: the accessible mode carries no
// rule of its own about accounts or payment; the instructions' one commitment line covers it.
test("The navigator takes a site's own accessible way through", async () => {
  const { jobInstructions } = await import('../src/models.js');
  assert.match(jobInstructions.driver, /press Enter for accessible navigation/);
  assert.match(jobInstructions.driver, /take it with Enter as a keyboard user would/);
  assert.doesNotMatch(jobInstructions.driver, /never use it to sign in/);
  assert.match(jobInstructions.driver, /THE LINE YOU NEVER CROSS/);
});

// Owner, PR 77: the instructions describe the keyboard walk as PRs 75 and 76 left it. Tab goes
// round the whole page, a miss is saved as evidence, and two misses in a row end the walk.
test('The navigator knows how a keyboard walk ends and that a miss is not retried', async () => {
  const { jobInstructions } = await import('../src/models.js');
  const { MAX_TARGET_KEYS, MAX_ARROW_KEYS } = await import('../src/keyboard-target.js');
  assert.match(jobInstructions.driver, new RegExp(`at most ${MAX_TARGET_KEYS} presses`));
  assert.match(
    jobInstructions.driver,
    new RegExp(`arrow keys were pressed ${MAX_ARROW_KEYS} times`),
  );
  assert.match(
    jobInstructions.driver,
    /Two unreached controls in a row, with no other move between/,
  );
  assert.match(jobInstructions.driver, /the miss is already saved as evidence/);
  assert.doesNotMatch(jobInstructions.driver, /Try one other real keyboard route/);
});

// Owner, 1 Nov: the navigator was told only how to move and what not to claim, so its notes
// said little about what a keyboard user met. It now records what it sees on every decision,
// without inventing screen-reader speech, and its examples are not tied to one flight site.
test('The navigator records what a keyboard user meets, without inventing speech', async () => {
  const { jobInstructions } = await import('../src/models.js');
  const text = jobInstructions.driver;
  assert.match(text, /Be the witness/);
  assert.match(text, /"Did:" what you did and why/);
  assert.match(text, /"Saw:" what the keyboard user met on this screen/);
  assert.match(text, /Write "Saw: nothing new" when nothing new appeared/);
  assert.match(
    text,
    /Never say what a screen reader announces, says or reads unless a voiceover check in this run recorded that speech/,
  );
  assert.match(text, /Never purchase, pay, subscribe, register, create an account, sign in/);
  // Owner, 1 Nov: scrolling is Page Down / Page Up, and the screen reader has no limit per audit.
  assert.match(text, /scroll presses Page Down \(direction down\) or Page Up/);
  assert.match(text, /There is no limit per audit, but each screen gets one check/);
  assert.doesNotMatch(text, /mouse wheel|two such checks/);
  // The no-commitment rule is stated once, not repeated in several places.
  assert.equal(text.match(/Never purchase/g)?.length, 1);
  assert.doesNotMatch(text, /London|airport/i);
});
