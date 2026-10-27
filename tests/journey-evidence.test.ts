import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, digest } from '../src/store.js';
import type { BrowserWalk } from '../src/browser.js';
import type { RecordEntry } from '../src/types.js';
import {
  JOURNEY_EVIDENCE_VERSION,
  compareJourneyTotals,
  recordOptOutContext,
  ReturnEvidence,
} from '../src/journey-evidence.js';

function data(changes: any = {}) {
  return {
    commerce: {
      kind: 'declared_bundle_offer',
      total: 24,
      currency: 'EUR',
      items: [{ id: 'bag', quantity: 1 }],
      disclosure: null,
    },
    choices: [],
    choicesComplete: true,
    limits: [],
    ...changes,
  };
}
function extra(checked: boolean, changes: any = {}) {
  return {
    id: 'gift',
    selector: '#gift',
    type: 'checkbox',
    checked,
    selectedIndexes: [],
    quantity: null,
    extra: { id: 'gift-wrap', price: 5, currency: 'EUR' },
    ...changes,
  };
}
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'access-walk-journey-'));
  const store = new Store(dir);
  const run = store.create(
    'Controlled original journey checks',
    'http://127.0.0.1:4317/form',
    'offline',
  );
  let count = 0;
  const capture = (url = run.url, changes: any = {}) => {
    const n = count++;
    const asset = store.asset(run.id, `source_${n}.png`, Buffer.from(`original-source-${n}`));
    return store.append(run.id, 'capture', 'browser', {
      url,
      stable: true,
      stateStamp: digest(`state_${n}`),
      imageFile: asset.file,
      imageHash: asset.hash,
      elements: [
        {
          id: 'e0',
          selector: '#gift',
          tag: 'input',
          type: 'checkbox',
          name: 'Gift wrap',
          disabled: false,
        },
        {
          id: 'e1',
          selector: '#email',
          tag: 'input',
          type: 'email',
          name: 'Email address',
          disabled: false,
        },
      ],
      ...changes,
    });
  };
  const context = (source: RecordEntry, value: any) =>
    store.append(
      run.id,
      'observation',
      'browser',
      {
        method: 'journey_context',
        version: JOURNEY_EVIDENCE_VERSION,
        stable: true,
        sourceCaptureId: source.id,
        sourceCaptureHash: source.hash,
        sourceImageHash: source.payload.imageHash,
        data: value,
      },
      [source.id],
    );
  const action = (source: RecordEntry, value: any = { kind: 'wait' }, changes: any = {}) =>
    store.append(
      run.id,
      'action',
      'browser',
      {
        method: 'actual_keyboard_or_browser',
        outcome: 'performed',
        sourceCaptureId: source.id,
        sourceImageHash: source.payload.imageHash,
        action: value,
        before: { id: 'gift', tag: 'input', type: 'checkbox' },
        ...changes,
      },
      [source.id],
    );
  const triplet = (
    first = data(),
    last = data(),
    value: any = { kind: 'wait' },
    actionChanges: any = {},
  ) => {
    const before = capture(),
      beforeContext = context(before, first),
      performed = action(before, value, actionChanges),
      after = capture(),
      afterContext = context(after, last);
    return { before, beforeContext, action: performed, after, afterContext };
  };
  return {
    dir,
    store,
    run,
    capture,
    context,
    action,
    triplet,
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('Comparable totals require declared same items, quantities and currency; no automatic verdict is created', () => {
  const x = setup();
  try {
    const t = x.triplet(
      data(),
      data({
        commerce: { ...data().commerce, total: 30, disclosure: 'Shipping is added before review.' },
      }),
    );
    const observation = compareJourneyTotals(
      x.store,
      x.run.id,
      t.beforeContext,
      t.action,
      t.afterContext,
    );
    assert.equal(observation.payload.comparable, true);
    assert.equal(observation.payload.selectionSame, true);
    assert.equal(observation.payload.beforeTotal, 24);
    assert.equal(observation.payload.afterTotal, 30);
    assert.equal(observation.payload.currency, 'EUR');
    assert.equal(Object.hasOwn(observation.payload, 'verdict'), false);
    assert.match(observation.payload.limit, /null structured description is not proof/);
    assert(
      observation.sources.includes(t.before.id) &&
        observation.sources.includes(t.after.id) &&
        observation.sources.includes(t.action.id),
    );
  } finally {
    x.close();
  }
});

test('Changed quantity, product, choice or currency cannot become an unexplained-price claim', () => {
  const x = setup();
  try {
    for (const last of [
      data({ commerce: { ...data().commerce, items: [{ id: 'bag', quantity: 2 }], total: 48 } }),
      data({ commerce: { ...data().commerce, items: [{ id: 'other-bag', quantity: 1 }] } }),
      data({ commerce: { ...data().commerce, currency: 'USD' } }),
      data({ choices: [extra(false)] }),
      data({ choicesComplete: false }),
      data({ commerce: null }),
    ]) {
      const t = x.triplet(data(), last, { kind: 'press', key: 'ArrowUp' });
      const observation = compareJourneyTotals(
        x.store,
        x.run.id,
        t.beforeContext,
        t.action,
        t.afterContext,
      );
      assert.equal(observation.payload.comparable, false);
      assert.match(observation.payload.limit, /No unexplained increase or pass/);
    }
  } finally {
    x.close();
  }
});

test('An extra price change is not mislabelled as a different user selection', () => {
  const x = setup();
  try {
    const first = data({ choices: [extra(true)] });
    const last = data({
      choices: [extra(true, { extra: { id: 'gift-wrap', price: 7, currency: 'EUR' } })],
      commerce: { ...data().commerce, total: 26 },
    });
    const t = x.triplet(first, last);
    assert.equal(
      compareJourneyTotals(x.store, x.run.id, t.beforeContext, t.action, t.afterContext).payload
        .comparable,
      true,
    );
  } finally {
    x.close();
  }
});

test('Same URL or ordinary total-like content does not replace missing structured selection evidence', () => {
  const x = setup();
  try {
    const t = x.triplet(data({ commerce: null }), data({ commerce: null }));
    const observation = compareJourneyTotals(
      x.store,
      x.run.id,
      t.beforeContext,
      t.action,
      t.afterContext,
    );
    assert.equal(t.before.payload.url, t.after.payload.url);
    assert.equal(observation.payload.comparable, false);
    assert.equal(observation.payload.selectionSame, null);
    assert.equal(observation.payload.beforeTotal, null);
  } finally {
    x.close();
  }
});

test('Changed sources, fabricated actions, missing images and retrospective initial context are refused', () => {
  const x = setup();
  try {
    const t = x.triplet();
    assert.throws(
      () =>
        compareJourneyTotals(
          x.store,
          x.run.id,
          { ...t.beforeContext, sources: [] },
          t.action,
          t.afterContext,
        ),
      /unchanged original/,
    );
    const proposed = x.triplet(data(), data(), { kind: 'wait' }, { outcome: 'proposed' });
    assert.throws(
      () =>
        compareJourneyTotals(
          x.store,
          x.run.id,
          proposed.beforeContext,
          proposed.action,
          proposed.afterContext,
        ),
      /actual performed action/,
    );
    const before = x.capture(),
      performed = x.action(before),
      late = x.context(before, data()),
      after = x.capture(),
      afterContext = x.context(after, data());
    assert.throws(
      () => compareJourneyTotals(x.store, x.run.id, late, performed, afterContext),
      /not observed before/,
    );
    writeFileSync(join(x.dir, x.run.id, t.after.payload.imageFile), 'changed source pixels');
    assert.throws(
      () => compareJourneyTotals(x.store, x.run.id, t.beforeContext, t.action, t.afterContext),
      /original image has changed/,
    );
  } finally {
    x.close();
  }
});

test('An actual safe keyboard attempt can establish changed or unchanged opt-out choice state', () => {
  const x = setup();
  try {
    for (const checkedAfter of [false, true]) {
      const t = x.triplet(
        data({ choices: [extra(true)] }),
        data({ choices: [extra(checkedAfter)] }),
        { kind: 'press', key: 'Space' },
      );
      const observed = recordOptOutContext(
        x.store,
        x.run.id,
        t.beforeContext,
        t.action,
        t.afterContext,
      );
      assert.equal(observed.payload.initialChoiceKnown, true);
      assert.equal(observed.payload.priceKnown, true);
      assert.equal(observed.payload.optOutTested, true);
      assert.equal(observed.payload.choiceChanged, !checkedAfter);
      assert.equal(Object.hasOwn(observed.payload, 'verdict'), false);
    }
  } finally {
    x.close();
  }
});

test('Programmatic changes, opt-in, unknown price and unbound rendered controls do not prove opt-out testing', () => {
  const x = setup();
  try {
    for (const [first, last, value] of [
      [extra(true), extra(false), { kind: 'wait' }],
      [extra(false), extra(true), { kind: 'press', key: 'Space' }],
      [
        extra(true, { extra: null }),
        extra(false, { extra: null }),
        { kind: 'press', key: 'Space' },
      ],
      [
        extra(true, { selector: '#another' }),
        extra(false, { selector: '#another' }),
        { kind: 'press', key: 'Space' },
      ],
    ] as const) {
      const t = x.triplet(data({ choices: [first] }), data({ choices: [last] }), value);
      assert.equal(
        recordOptOutContext(x.store, x.run.id, t.beforeContext, t.action, t.afterContext).payload
          .optOutTested,
        false,
      );
    }
  } finally {
    x.close();
  }
});

function returnWalk(
  x: ReturnType<typeof setup>,
  current: RecordEntry,
  initial = 'test@example.org',
) {
  let value = initial,
    reads = 0;
  return {
    walk: {
      store: x.store,
      runId: x.run.id,
      page: {
        url: () => current.payload.url,
        locator: () => ({
          count: async () => 1,
          getAttribute: async () => 'email',
          inputValue: async () => {
            reads++;
            return value;
          },
        }),
        evaluate: async () => {
          throw Error('No input value may be passed into page evaluation.');
        },
      },
      observationStamp: async () => current.payload.stateStamp,
    } as unknown as BrowserWalk,
    setCurrent(source: RecordEntry) {
      current = source;
    },
    setValue(next: string) {
      value = next;
    },
    get reads() {
      return reads;
    },
  };
}

test('A back action without an observed original value stays unknown, even if a prior type action exists', async () => {
  const x = setup();
  try {
    const typedBefore = x.capture(),
      typed = x.action(typedBefore, { kind: 'type', text: 'test@example.org' }),
      typedAfter = x.capture();
    const before = x.capture(x.run.url + '/review'),
      back = x.action(before, { kind: 'back' }),
      after = x.capture();
    const stub = returnWalk(x, after);
    const tracker = new ReturnEvidence(x.store, x.run.id);
    const observed = await tracker.compareAfterBack(stub.walk, before, back, after);
    assert.equal(typed.payload.action.kind, 'type');
    assert(typedAfter.seq < back.seq);
    assert.equal(observed.payload.entriesCompared, false);
    assert.equal(observed.payload.preserved, null);
    assert.equal(stub.reads, 0);
    assert.match(observed.payload.limit, /not evidence that entries were lost/);
  } finally {
    x.close();
  }
});

test('Return comparison observes the synthetic original in Node and persists only identity/outcome', async () => {
  const x = setup();
  try {
    const tracker = new ReturnEvidence(x.store, x.run.id);
    const beforeType = x.capture(),
      typed = x.action(
        beforeType,
        { kind: 'type', text: 'test@example.org' },
        { before: { id: 'email', tag: 'input', type: 'email' } },
      ),
      afterType = x.capture();
    const stub = returnWalk(x, afterType);
    assert.equal(await tracker.rememberTyped(stub.walk, beforeType, typed, afterType), true);
    for (const afterValue of ['test@example.org', '']) {
      const beforeBack = x.capture(x.run.url + '/review'),
        back = x.action(beforeBack, { kind: 'back' }),
        afterBack = x.capture();
      stub.setCurrent(afterBack);
      stub.setValue(afterValue);
      const observed = await tracker.compareAfterBack(stub.walk, beforeBack, back, afterBack);
      assert.equal(observed.payload.returned, true);
      assert.equal(observed.payload.entriesCompared, true);
      assert.equal(observed.payload.preserved, afterValue === 'test@example.org');
      assert.equal(observed.payload.fieldId, 'email');
      assert.equal(observed.payload.typedActionId, typed.id);
      assert(observed.sources.includes(afterType.id));
    }
    const records = x.store.records(x.run.id).filter((record) => record.kind === 'observation');
    assert(records.length >= 3);
    assert(records.every((record) => !JSON.stringify(record.payload).includes('test@example.org')));
    assert(
      records.every(
        (record) =>
          !['value', 'valueHash', 'expectedValue', 'fieldValue'].some((name) =>
            Object.hasOwn(record.payload, name),
          ),
      ),
    );
    tracker.clear();
    const before = x.capture(x.run.url + '/review'),
      back = x.action(before, { kind: 'back' }),
      after = x.capture();
    stub.setCurrent(after);
    assert.equal(
      (await tracker.compareAfterBack(stub.walk, before, back, after)).payload.preserved,
      null,
    );
  } finally {
    x.close();
  }
});

test('Unapproved values/types and a reused field with different identity do not create a return baseline', async () => {
  const x = setup();
  try {
    const tracker = new ReturnEvidence(x.store, x.run.id);
    for (const [value, type] of [
      ['not-approved@example.invalid', 'email'],
      ['test@example.org', 'password'],
    ] as const) {
      const before = x.capture(),
        action = x.action(
          before,
          { kind: 'type', text: value },
          { before: { id: 'email', tag: 'input', type } },
        ),
        after = x.capture();
      const stub = returnWalk(x, after, value);
      assert.equal(await tracker.rememberTyped(stub.walk, before, action, after), false);
      assert.equal(stub.reads, 0);
    }
    const before = x.capture(),
      typed = x.action(
        before,
        { kind: 'type', text: 'test@example.org' },
        { before: { id: 'email', tag: 'input', type: 'email' } },
      ),
      after = x.capture();
    const stub = returnWalk(x, after);
    assert.equal(await tracker.rememberTyped(stub.walk, before, typed, after), true);
    const beforeBack = x.capture(x.run.url + '/review'),
      back = x.action(beforeBack, { kind: 'back' }),
      reused = x.capture(x.run.url, {
        elements: [
          { selector: '#email', tag: 'input', type: 'email', name: 'Different account field' },
        ],
      });
    stub.setCurrent(reused);
    const observed = await tracker.compareAfterBack(stub.walk, beforeBack, back, reused);
    assert.equal(observed.payload.entriesCompared, false);
    assert.equal(observed.payload.preserved, null);
    assert.equal(stub.reads, 1);
  } finally {
    x.close();
  }
});
