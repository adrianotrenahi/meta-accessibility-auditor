import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, recordIsIntact } from '../src/store.js';
import { BrowserWalk } from '../src/browser.js';
import { VoiceOverProbe } from '../src/voiceover.js';
import { LIMITS, type RecordEntry } from '../src/types.js';
import { FocusedCheckBudget, type MissingEvidenceRequest } from '../src/evidence-checks.js';
import { performFocusedCheck } from '../src/focused-checks.js';

function setup(
  options: {
    changeOnTab?: boolean;
    failCapture?: boolean;
    failMeasurement?: boolean;
    readerState?: string;
    expectedKey?: 'Tab' | 'Enter' | 'Space';
    focus?: { name: string; tag: string; role?: string; type?: string };
    refuseInput?: boolean;
    changedFocusedTarget?: boolean;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'access-walk-focused-integration-'));
  const store = new Store(dir);
  const run = store.create('Controlled follow-up checks', 'http://127.0.0.1:4317/shop/', 'offline');
  let actualStamp = 'b'.repeat(64);
  const capture = () =>
    store.append(run.id, 'capture', 'browser', {
      stable: true,
      url: run.url,
      imageHash: 'a'.repeat(64),
      stateStamp: actualStamp,
      elements: [],
      focus: options.focus,
      imageProvenance: { engineAddedAnnotations: false },
    });
  const original = capture();
  const calls = { read: 0, input: 0, capture: 0, measurement: 0, reader: 0 };
  const walk = {
    page: {
      evaluateHandle: async () => ({
        asElement: () => ({
          evaluate: async () => !options.changedFocusedTarget,
          dispose: async () => {},
        }),
      }),
    },
    observationStamp: async () => {
      calls.read++;
      return actualStamp;
    },
    measurements: async (source: RecordEntry) => {
      calls.measurement++;
      if (options.failMeasurement) throw Error('Controlled measurement unavailable.');
      return store.append(
        run.id,
        'observation',
        'browser',
        { method: 'automatic_accessibility_scan', stable: true },
        [source.id],
      );
    },
    act: async (action: any, source: RecordEntry, expectedTarget?: () => Promise<boolean>) => {
      assert.equal(
        store.run(run.id).state,
        'running',
        'The mocked input preserves the real walk state guard.',
      );
      assert.equal(action.kind, 'press');
      assert.equal(action.key, options.expectedKey ?? 'Tab');
      if (options.refuseInput) throw Error('Controlled ordinary action guard refused activation.');
      if (expectedTarget && !(await expectedTarget()))
        throw Error('Controlled original target changed before activation.');
      calls.input++;
      if (options.changeOnTab !== false) actualStamp = 'c'.repeat(64);
      return store.append(
        run.id,
        'action',
        'browser',
        {
          action,
          outcome: 'performed',
          waitAfterMs: 180,
          sourceCaptureId: source.id,
          sourceImageHash: source.payload.imageHash,
          before: { id: 'before' },
          after: { id: options.changeOnTab === false ? 'before' : 'after' },
        },
        [source.id],
      );
    },
    capture: async () => {
      calls.capture++;
      if (options.failCapture) throw Error('Controlled after-input capture unavailable.');
      return capture();
    },
  };
  const probe = {
    check: async (source: RecordEntry) => {
      calls.reader++;
      return store.append(
        run.id,
        'at_check',
        'voiceover',
        {
          method: 'real_VoiceOver',
          state: options.readerState ?? 'observed',
          captureHealthy: options.readerState === undefined,
          commands: options.readerState
            ? []
            : [{ command: 'Saved test command', spokenPhrases: ['Saved test speech'] }],
        },
        [source.id],
      );
    },
  };
  const controller = new AbortController();
  const request = (
    method: MissingEvidenceRequest['method'],
    source = original,
    reason = 'Check the original state.',
  ) => ({ method, captureId: source.id, criterionId: 'C05', reason }) as MissingEvidenceRequest;
  const perform = (
    budget: FocusedCheckBudget,
    source: RecordEntry,
    value: MissingEvidenceRequest,
    withProbe = true,
  ) =>
    performFocusedCheck(
      store,
      run.id,
      walk as unknown as BrowserWalk,
      withProbe ? (probe as unknown as VoiceOverProbe) : undefined,
      budget,
      source,
      value,
      controller.signal,
    );
  return {
    store,
    run,
    original,
    walk,
    probe,
    calls,
    controller,
    request,
    perform,
    setStamp: (value: string) => {
      actualStamp = value;
    },
    checks: () => store.records(run.id).filter((r) => r.kind === 'focused_check'),
    close: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('Initial, driver and analyst requests share the same two native-reserved slots', async () => {
  const x = setup();
  try {
    const budget = new FocusedCheckBudget({ reserveVoiceOver: 2 });
    assert.equal((await x.perform(budget, x.original, x.request('measurement'))).id, x.original.id);
    assert.equal(budget.used, 0);
    assert.equal(x.calls.measurement, 0);
    let current = await x.perform(
      budget,
      x.original,
      x.request('voiceover', x.original, 'Initial native checkpoint.'),
    );
    current = await x.perform(
      budget,
      current,
      x.request('voiceover', current, 'Driver native checkpoint.'),
    );
    await x.perform(
      budget,
      current,
      x.request('keyboard_focus', current, 'Analyst follow-up request.'),
    );
    assert.equal(budget.used, 2);
    assert.equal(budget.remaining, 0);
    assert.equal(x.calls.reader, 2);
    assert.equal(x.calls.input, 0);
    assert.equal(x.calls.capture, 2);
    const refused = x.checks().filter((r) => r.payload.attempted === false);
    assert.equal(refused.length, 2);
    assert(refused.every((r) => r.payload.state === 'NOT_TESTED'));
    assert.equal(x.store.usage(x.run.id).requests.length, 0);
  } finally {
    x.close();
  }
});

test('Stale or missing originals refuse without claiming a slot or sending input', async () => {
  const x = setup();
  try {
    const budget = new FocusedCheckBudget();
    x.setStamp('c'.repeat(64));
    await x.perform(budget, x.original, x.request('keyboard_focus'));
    await x.perform(budget, x.original, {
      ...x.request('keyboard_focus'),
      captureId: 'unavailable',
    });
    assert.equal(budget.used, 0);
    assert.equal(x.calls.input, 0);
    assert.equal(x.calls.capture, 0);
    assert(
      x.checks().every((r) => r.payload.attempted === false && r.payload.state === 'NOT_TESTED'),
    );
  } finally {
    x.close();
  }
});

test('Failed execution consumes its slot; unavailable VoiceOver never becomes observed', async () => {
  const x = setup({ failMeasurement: true, readerState: 'NOT_TESTED' });
  try {
    const budget = new FocusedCheckBudget();
    await x.perform(budget, x.original, x.request('measurement'));
    assert.equal(budget.used, 1);
    let current = await x.perform(budget, x.original, x.request('voiceover'));
    await x.perform(budget, current, x.request('keyboard_focus', current));
    assert.equal(budget.used, 2);
    assert.equal(x.calls.measurement, 1);
    assert.equal(x.calls.reader, 1);
    assert.equal(x.calls.input, 0);
    const result = x
      .checks()
      .findLast((r) => r.payload.method === 'voiceover' && r.payload.state !== 'attempted')!;
    assert.notEqual(result.payload.state, 'observed');
    const native = x.store.record(x.run.id, result.payload.resultId)!;
    assert.equal(native.payload.state, 'NOT_TESTED');
    assert(result.sources.includes(native.id));
    assert.deepEqual(x.store.published(x.run.id), []);
  } finally {
    x.close();
  }
});

test('A reader unavailable before execution preserves its reserved slot', async () => {
  const x = setup();
  try {
    const budget = new FocusedCheckBudget({ reserveVoiceOver: 2 });
    await x.perform(budget, x.original, x.request('voiceover'), false);
    assert.equal(budget.used, 0);
    assert.equal(x.calls.reader, 0);
    assert.equal(x.calls.capture, 0);
    assert.equal(x.checks().at(-1)?.payload.state, 'NOT_TESTED');
  } finally {
    x.close();
  }
});

test('An already stopped or aborted run executes no focused work and spends no slot', async () => {
  for (const mode of ['stop', 'abort']) {
    const x = setup();
    try {
      if (mode === 'abort') x.controller.abort();
      else x.store.finish(x.run.id, 'stopped', 'Owner stopped.');
      const budget = new FocusedCheckBudget();
      await x.perform(budget, x.original, x.request('keyboard_focus'));
      assert.equal(budget.used, 0);
      assert.deepEqual(x.calls, { read: 0, input: 0, capture: 0, measurement: 0, reader: 0 });
      assert.equal(x.checks().at(-1)?.payload.attempted, false);
    } finally {
      x.close();
    }
  }
});

test('A stop or abort during the awaited state read refuses before claiming or starting a check', async () => {
  for (const mode of ['stop', 'abort']) {
    const x = setup();
    try {
      x.walk.observationStamp = async () => {
        x.calls.read++;
        if (mode === 'abort') x.controller.abort();
        else x.store.finish(x.run.id, 'stopped', 'Owner stopped while reading.');
        return x.original.payload.stateStamp;
      };
      const budget = new FocusedCheckBudget();
      await assert.doesNotReject(() => x.perform(budget, x.original, x.request('keyboard_focus')));
      assert.equal(budget.used, 0);
      assert.equal(x.calls.input, 0);
      assert.equal(x.calls.capture, 0);
      assert(
        x.checks().every((r) => r.payload.state === 'NOT_TESTED' && r.payload.attempted === false),
      );
    } finally {
      x.close();
    }
  }
});

test('After-capture failure links the exact already-sent input without repeating it', async () => {
  const x = setup({ failCapture: true });
  try {
    const before = JSON.stringify(x.original),
      budget = new FocusedCheckBudget();
    const current = await x.perform(budget, x.original, x.request('keyboard_focus'));
    assert.equal(current.id, x.original.id);
    assert.equal(x.calls.input, 1);
    assert.equal(x.calls.capture, 1);
    assert.equal(budget.used, 1);
    const action = x.store.records(x.run.id).find((r) => r.kind === 'action')!;
    const failed = x.checks().at(-1)!;
    assert.equal(failed.payload.state, 'INCONCLUSIVE');
    assert.equal(failed.payload.resultId, action.id);
    assert(failed.sources.includes(action.id));
    assert.equal(JSON.stringify(x.store.record(x.run.id, x.original.id)), before);
    assert(recordIsIntact(action));
    assert(recordIsIntact(failed));
  } finally {
    x.close();
  }
});

test('A failed post-input capture cannot make a second request repeat Tab on the same original', async () => {
  for (const changeOnTab of [true, false]) {
    const x = setup({ failCapture: true, changeOnTab });
    try {
      const budget = new FocusedCheckBudget();
      const current = await x.perform(budget, x.original, x.request('keyboard_focus'));
      await x.perform(budget, current, x.request('keyboard_focus', current));
      assert.equal(x.calls.input, 1);
      assert.equal(x.calls.capture, 1);
      assert.equal(budget.used, 1);
      assert.equal(x.checks().at(-1)?.payload.state, 'NOT_TESTED');
    } finally {
      x.close();
    }
  }
});

test('Concurrent duplicate requests on one original cannot claim two slots', async () => {
  const x = setup();
  try {
    const budget = new FocusedCheckBudget();
    await Promise.all([
      x.perform(budget, x.original, x.request('measurement')),
      x.perform(budget, x.original, x.request('measurement')),
    ]);
    assert.equal(budget.used, 1);
    assert.equal(x.calls.measurement, 1);
    assert.equal(x.calls.capture, 1);
  } finally {
    x.close();
  }
});

test('Successful checks retain original links and never create a finding or change fixed run ceilings', async () => {
  const x = setup();
  try {
    const budget = new FocusedCheckBudget();
    const sourceBefore = JSON.stringify(x.original);
    const after = await x.perform(budget, x.original, x.request('keyboard_focus'));
    const checks = x.checks(),
      begun = checks.find((r) => r.payload.state === 'attempted')!,
      result = checks.at(-1)!;
    const action = x.store.records(x.run.id).find((r) => r.kind === 'action')!;
    assert.deepEqual(begun.sources, [x.original.id]);
    assert.deepEqual(result.sources, [begun.id, action.id, after.id]);
    assert.equal(result.payload.resultId, action.id);
    assert.equal(result.payload.afterCaptureId, after.id);
    assert.equal(result.payload.state, 'observed');
    assert.equal(JSON.stringify(x.store.record(x.run.id, x.original.id)), sourceBefore);
    assert(x.store.records(x.run.id).every(recordIsIntact));
    assert.deepEqual(x.store.published(x.run.id), []);
    assert.deepEqual(
      {
        actions: LIMITS.actions,
        minutes: LIMITS.minutes,
        driver: LIMITS.driver,
        runMicros: LIMITS.runMicros,
      },
      { actions: 120, minutes: 15, driver: 20, runMicros: 10_000_000 },
    );
  } finally {
    x.close();
  }
});

for (const activationKey of ['Enter', 'Space'] as const)
  test(`An explicit ${activationKey} follow-up activates the focused named control without substituting Tab`, async () => {
    const x = setup({
      expectedKey: activationKey,
      focus: { tag: 'button', name: 'Dismiss offer' },
    });
    try {
      const budget = new FocusedCheckBudget();
      const original = JSON.stringify(x.original);
      const after = await x.perform(budget, x.original, {
        ...x.request('keyboard_activation'),
        activationKey,
        targetName: 'Dismiss offer',
      });
      const actions = x.store.records(x.run.id).filter((record) => record.kind === 'action');
      assert.deepEqual(
        actions.map((record) => record.payload.action.key),
        [activationKey],
      );
      assert.equal(x.calls.capture, 1);
      assert.equal(budget.used, 1);
      const result = x.checks().at(-1)!;
      assert.equal(result.payload.state, 'observed');
      assert.deepEqual(result.sources, [x.checks()[0]!.id, actions[0]!.id, after.id]);
      assert.equal(JSON.stringify(x.store.record(x.run.id, x.original.id)), original);
      assert.deepEqual(x.store.published(x.run.id), []);
    } finally {
      x.close();
    }
  });

test('An activation follow-up refuses a different focus, a text field or a stale original before spending a slot', async () => {
  for (const variant of ['different-name', 'text-field', 'stale'] as const) {
    const x = setup({
      expectedKey: 'Enter',
      focus:
        variant === 'text-field'
          ? { tag: 'input', type: 'text', role: 'button', name: 'Dismiss offer' }
          : { tag: 'button', name: 'Dismiss offer' },
    });
    try {
      if (variant === 'stale') x.setStamp('c'.repeat(64));
      const budget = new FocusedCheckBudget();
      await x.perform(budget, x.original, {
        ...x.request('keyboard_activation'),
        activationKey: 'Enter',
        targetName: variant === 'different-name' ? 'Different offer' : 'Dismiss offer',
      });
      assert.equal(x.calls.input, 0);
      assert.equal(x.calls.capture, 0);
      assert.equal(budget.used, 0);
      assert.equal(x.checks().at(-1)?.payload.state, 'NOT_TESTED');
    } finally {
      x.close();
    }
  }
});

test('Activation follow-ups keep the ordinary action and target guards and cannot retry after a capture fails', async () => {
  for (const failure of ['guard', 'target', 'capture'] as const) {
    const x = setup({
      expectedKey: 'Enter',
      focus: { tag: 'button', name: 'Dismiss offer' },
      refuseInput: failure === 'guard',
      changedFocusedTarget: failure === 'target',
      failCapture: failure === 'capture',
      changeOnTab: false,
    });
    try {
      const budget = new FocusedCheckBudget();
      const request = {
        ...x.request('keyboard_activation'),
        activationKey: 'Enter' as const,
        targetName: 'Dismiss offer',
      };
      await x.perform(budget, x.original, request);
      const first = x.checks().at(-1)!;
      assert.equal(first.payload.state, 'INCONCLUSIVE');
      assert.equal(x.calls.input, failure === 'capture' ? 1 : 0);
      assert.equal(x.calls.capture, failure === 'capture' ? 1 : 0);
      await x.perform(budget, x.original, request);
      assert.equal(x.calls.input, failure === 'capture' ? 1 : 0);
      assert.equal(x.calls.capture, failure === 'capture' ? 1 : 0);
      assert.equal(budget.used, 1);
      assert.equal(x.checks().at(-1)?.payload.state, 'NOT_TESTED');
      if (failure === 'capture') {
        const action = x.store.records(x.run.id).find((record) => record.kind === 'action')!;
        assert.equal(first.payload.resultId, action.id);
        assert(first.sources.includes(action.id));
      }
      assert.deepEqual(x.store.published(x.run.id), []);
    } finally {
      x.close();
    }
  }
});
