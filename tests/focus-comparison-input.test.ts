import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, digest } from '../src/store.js';
import { requestEvidence } from '../src/request-evidence.js';
import { suppliedImageIds } from '../src/image-receipt.js';
import {
  JOURNEY_EVIDENCE_VERSION,
  JOURNEY_CONTEXT_LIMIT,
  UNRECOGNISED_BUNDLE_LIMIT,
  compareJourneyTotals,
} from '../src/journey-evidence.js';
import type { RecordEntry } from '../src/types.js';

function fixture(
  options: {
    key?: string;
    price?: number;
    changedUrl?: boolean;
    losePrice?: boolean;
    choices?: boolean;
    choicesComplete?: boolean;
    limits?: string[];
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'meta-focus-input-'));
  const store = new Store(directory);
  const run = store.create('Controlled search focus', 'http://127.0.0.1:4317/search', 'offline');
  const picture = Buffer.from('original-test-picture');
  let n = 0;
  const capture = (url = run.url) => {
    const image = store.asset(run.id, `capture_${++n}.png`, picture);
    return store.append(run.id, 'capture', 'browser', {
      stable: true,
      url,
      imageFile: image.file,
      imageHash: image.hash,
      text: 'Search',
      elements: [],
    });
  };
  const context = (screen: RecordEntry) =>
    store.append(
      run.id,
      'observation',
      'browser',
      {
        method: 'journey_context',
        version: JOURNEY_EVIDENCE_VERSION,
        stable: true,
        sourceCaptureId: screen.id,
        sourceCaptureHash: screen.hash,
        sourceImageHash: screen.payload.imageHash,
        limit: JOURNEY_CONTEXT_LIMIT,
        data: {
          commerce:
            options.price === undefined || (options.losePrice && n > 1)
              ? null
              : {
                  kind: 'declared_bundle_offer',
                  total: options.price,
                  currency: 'EUR',
                  items: [{ id: 'bag', quantity: 1 }],
                  disclosure: null,
                },
          choices: options.choices
            ? [
                {
                  id: 'gift',
                  selector: '#gift',
                  type: 'checkbox',
                  checked: n > 1,
                  selectedIndexes: [],
                  quantity: null,
                  extra: { id: 'gift', price: 5, currency: 'EUR' },
                },
              ]
            : [],
          choicesComplete: options.choicesComplete ?? true,
          limits: options.limits ?? [],
        },
      },
      [screen.id],
    );
  const action = (screen: RecordEntry, key = 'Tab') =>
    store.append(
      run.id,
      'action',
      'browser',
      {
        method: 'actual_keyboard_or_browser',
        outcome: 'performed',
        sourceCaptureId: screen.id,
        sourceImageHash: screen.payload.imageHash,
        action: { kind: 'press', key },
        before: {},
      },
      [screen.id],
    );
  const first = capture(),
    firstContext = context(first);
  const firstAction = action(first, options.key);
  const second = capture(options.changedUrl ? run.url + '?state=2' : run.url),
    secondContext = context(second);
  const older = compareJourneyTotals(store, run.id, firstContext, firstAction, secondContext);
  const lastAction = action(second);
  const current = capture(second.payload.url),
    currentContext = context(current);
  const latest = compareJourneyTotals(store, run.id, secondContext, lastAction, currentContext);
  const note = store.append(
    run.id,
    'navigator_note',
    'driver',
    { text: 'Original note before the latest focus movement' },
    [first.id],
  );
  return {
    store,
    run,
    first,
    second,
    current,
    older,
    latest,
    note,
    read: (role: 'analyst' | 'reviewer' = 'analyst') =>
      requestEvidence(store, run.id, role, current),
    close() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('An older empty focus comparison stays original but does not add a third analysis image', () => {
  const x = fixture();
  try {
    const originals = JSON.stringify(x.store.records(x.run.id));
    const read = x.read();
    assert.deepEqual(suppliedImageIds(read.read, read.records), [x.second.id, x.current.id]);
    assert(!read.records.some((record) => record.id === x.older.id));
    assert(read.records.some((record) => record.id === x.latest.id));
    assert(read.records.some((record) => record.id === x.note.id));
    assert.equal(read.records.filter((record) => record.kind === 'action').length, 2);
    assert.equal(
      JSON.stringify(x.store.records(x.run.id).filter((record) => record.kind !== 'read_snapshot')),
      originals,
    );
    assert.equal(
      x.store.image(x.run.id, x.first.payload.imageFile).toString(),
      'original-test-picture',
    );
    assert.equal(x.store.usage().requests.length, 0);
  } finally {
    x.close();
  }
});

for (const options of [
  { key: 'Enter' },
  { price: 0 },
  { price: 24 },
  { price: 0, losePrice: true },
  { changedUrl: true },
]) {
  test(`Material or changed-page history stays supplied: ${JSON.stringify(options)}`, () => {
    const x = fixture(options);
    try {
      const read = x.read();
      assert(read.records.some((record) => record.id === x.older.id));
      assert.deepEqual(suppliedImageIds(read.read, read.records), [
        x.first.id,
        x.second.id,
        x.current.id,
      ]);
    } finally {
      x.close();
    }
  });
}

test('Existing claims keep all earlier comparison context for both analysis and independent review', () => {
  const x = fixture();
  try {
    x.store.append(
      x.run.id,
      'candidate',
      'analyst',
      { title: 'Saved claim', targetCaptureId: x.first.id },
      [x.older.id],
    );
    for (const role of ['analyst', 'reviewer'] as const) {
      const read = x.read(role);
      assert(read.records.some((record) => record.id === x.older.id));
      assert.deepEqual(suppliedImageIds(read.read, read.records), [
        x.first.id,
        x.second.id,
        x.current.id,
      ]);
    }
  } finally {
    x.close();
  }
});

for (const changes of [
  { limit: 'Additional observed task context' },
  { extraObservation: 'Menu opened' },
  { beforeDisclosure: '' },
]) {
  test(`Unrecognised or additional comparison information stays supplied: ${JSON.stringify(changes)}`, () => {
    const x = fixture();
    try {
      const body = { ...x.older.payload, ...changes };
      x.store.db
        .prepare('UPDATE records SET body=?,hash=? WHERE id=?')
        .run(JSON.stringify(body), digest(JSON.stringify(body)), x.older.id);
      const read = x.read();
      assert(read.records.some((record) => record.id === x.older.id));
      assert.equal(suppliedImageIds(read.read, read.records).length, 3);
    } finally {
      x.close();
    }
  });
}

test('A mandatory older comparison cannot be filtered to make an oversized original chain fit', () => {
  const x = fixture();
  try {
    const current = x.store.append(x.run.id, 'capture', 'browser', x.current.payload, [
      x.older.id,
      x.latest.id,
    ]);
    assert.throws(
      () => requestEvidence(x.store, x.run.id, 'analyst', current),
      /Required original screens exceed/,
    );
  } finally {
    x.close();
  }
});

for (const options of [
  { choices: true },
  { choicesComplete: false },
  { limits: ['Choice scope was incomplete'] },
]) {
  test(`Original selection context survives empty price summary: ${JSON.stringify(options)}`, () => {
    const x = fixture(options);
    try {
      assert.equal(x.older.payload.selectionSame, null);
      assert.equal(x.older.payload.beforeTotal, null);
      const read = x.read();
      assert(read.records.some((record) => record.id === x.older.id));
      assert.deepEqual(suppliedImageIds(read.read, read.records), [
        x.first.id,
        x.second.id,
        x.current.id,
      ]);
    } finally {
      x.close();
    }
  });
}

test('The latest comparison stays supplied when the current original is an observation-only recapture', () => {
  const x = fixture();
  try {
    const current = x.store.append(x.run.id, 'capture', 'browser', x.current.payload);
    const read = requestEvidence(x.store, x.run.id, 'analyst', current);
    assert(read.records.some((record) => record.id === x.latest.id));
    assert.deepEqual(suppliedImageIds(read.read, read.records), [
      x.second.id,
      x.current.id,
      current.id,
    ]);
  } finally {
    x.close();
  }
});

test('The known unavailable-bundle limit does not discard complete empty choice context', () => {
  const x = fixture({ limits: [UNRECOGNISED_BUNDLE_LIMIT] });
  try {
    const read = x.read();
    assert.deepEqual(suppliedImageIds(read.read, read.records), [x.second.id, x.current.id]);
  } finally {
    x.close();
  }
});

for (const kind of ['changed-comparison', 'missing-source', 'unstable-source'] as const) {
  test(`Invalid earlier evidence still refuses rather than disappearing: ${kind}`, () => {
    const x = fixture();
    try {
      if (kind === 'changed-comparison')
        x.store.db
          .prepare('UPDATE records SET body=? WHERE id=?')
          .run(JSON.stringify({ ...x.older.payload, changed: true }), x.older.id);
      if (kind === 'missing-source')
        x.store.db.prepare('DELETE FROM records WHERE id=?').run(x.first.id);
      if (kind === 'unstable-source') {
        const body = { ...x.first.payload, stable: false };
        x.store.db
          .prepare('UPDATE records SET body=?,hash=? WHERE id=?')
          .run(JSON.stringify(body), digest(JSON.stringify(body)), x.first.id);
      }
      assert.throws(() => x.read(), kind === 'unstable-source' ? /unstable/ : /missing or changed/);
      assert.equal(x.store.usage().requests.length, 0);
    } finally {
      x.close();
    }
  });
}
