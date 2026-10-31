import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { requestEvidence } from '../src/request-evidence.js';
import { suppliedImageIds } from '../src/image-receipt.js';

// Owner, 30 Oct: the analyst analyses only the screens a customer sees on the strip.
// On Booking.com that is the cookie pop-up and the home page, then the Flights page alone.
function walk() {
  const dir = mkdtempSync(join(tmpdir(), 'strip-screens-'));
  const store = new Store(dir);
  const run = store.create('Booking.com order', 'https://www.booking.com/', 'offline');
  let n = 0;
  const shot = (url: string) => {
    const asset = store.asset(run.id, `capture_${++n}.png`, Buffer.from(`screen ${n}`));
    return store.append(run.id, 'capture', 'browser', {
      url,
      stable: true,
      imageFile: asset.file,
      imageHash: asset.hash,
      elements: [],
    });
  };
  const press = (source: any, key: string) =>
    store.append(
      run.id,
      'action',
      'browser',
      {
        method: 'actual_keyboard_or_browser',
        outcome: 'performed',
        sourceCaptureId: source.id,
        sourceImageHash: source.payload.imageHash,
        action: { kind: 'press', key },
      },
      [source.id],
    );
  const images = (current: any) => {
    const read = requestEvidence(store, run.id, 'analyst', current);
    return suppliedImageIds(read.read, read.records);
  };
  return {
    store,
    run,
    shot,
    press,
    images,
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('The home page check reads the cookie pop-up and the home page, nothing else', () => {
  const x = walk();
  try {
    const popup = x.shot('https://www.booking.com/index.es.html');
    x.press(popup, 'Enter');
    const home = x.shot('https://www.booking.com/index.es.html');
    assert.deepEqual(x.images(home), [popup.id, home.id]);
  } finally {
    x.close();
  }
});

test('The Flights page check reads the Flights page alone, not the Tab steps that led there', () => {
  const x = walk();
  try {
    const home = x.shot('https://www.booking.com/index.es.html');
    let step = home;
    for (let i = 0; i < 3; i++) {
      x.press(step, 'Tab');
      step = x.shot('https://www.booking.com/index.es.html');
    }
    x.press(step, 'Enter');
    const flights = x.shot('https://www.booking.com/flights/index.es.html');
    assert.deepEqual(x.images(flights), [flights.id]);
    // The walk itself stays in the written record.
    const read = requestEvidence(x.store, x.run.id, 'analyst', flights);
    assert.equal(read.records.filter((record) => record.kind === 'action').length, 4);
  } finally {
    x.close();
  }
});

test('A control Tab never reached keeps the screen it was measured on', () => {
  const x = walk();
  try {
    const home = x.shot('https://www.booking.com/index.es.html');
    x.store.append(
      x.run.id,
      'observation',
      'browser',
      { method: 'keyboard_reach/1', reached: false },
      [home.id],
    );
    x.store.append(
      x.run.id,
      'observation',
      'browser',
      { method: 'keyboard_reach/1', reached: true },
      [home.id],
    );
    x.press(home, 'Enter');
    const flights = x.shot('https://www.booking.com/flights/index.es.html');
    assert.deepEqual(x.images(flights), [home.id, flights.id]);
  } finally {
    x.close();
  }
});

test('The reviewer is not sent Tab steps that changed nothing either', async () => {
  const { compareJourneyTotals, JOURNEY_EVIDENCE_VERSION, JOURNEY_CONTEXT_LIMIT } =
    await import('../src/journey-evidence.js');
  const x = walk();
  try {
    const context = (screen: any) =>
      x.store.append(
        x.run.id,
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
          data: { commerce: null, choices: [], choicesComplete: true, limits: [] },
        },
        [screen.id],
      );
    const step = x.shot('https://www.booking.com/index.es.html');
    const before = context(step);
    const tab = x.press(step, 'Tab');
    const home = x.shot('https://www.booking.com/index.es.html');
    compareJourneyTotals(x.store, x.run.id, before, tab, context(home));
    x.store.append(x.run.id, 'candidate', 'analyst', { title: 'Claim on the home page' }, [
      home.id,
    ]);
    const read = requestEvidence(x.store, x.run.id, 'reviewer', home);
    assert.deepEqual(suppliedImageIds(read.read, read.records), [home.id]);
  } finally {
    x.close();
  }
});

async function contextFor(x: ReturnType<typeof walk>, screen: any, choices: any[]) {
  const { JOURNEY_EVIDENCE_VERSION, JOURNEY_CONTEXT_LIMIT } =
    await import('../src/journey-evidence.js');
  return x.store.append(
    x.run.id,
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
      data: { commerce: null, choices, choicesComplete: false, limits: [] },
    },
    [screen.id],
  );
}
const choice = (id: string, checked: boolean) => ({
  id,
  selector: `#${id}`,
  type: 'checkbox',
  checked,
  selectedIndexes: [],
  quantity: null,
  extra: null,
});

test('Booking.com home page to Flights: different pages are not a change, so Flights is read alone', async () => {
  const { compareJourneyTotals } = await import('../src/journey-evidence.js');
  const x = walk();
  try {
    const home = x.shot('https://www.booking.com/index.es.html');
    const before = await contextFor(x, home, [choice('flights', false), choice('work', false)]);
    const enter = x.press(home, 'Enter');
    const flights = x.shot('https://www.booking.com/flights/index.es.html');
    const after = await contextFor(x, flights, [choice('direct', false)]);
    compareJourneyTotals(x.store, x.run.id, before, enter, after);
    assert.deepEqual(x.images(flights), [flights.id]);
  } finally {
    x.close();
  }
});

test('A choice on both screens that changed state keeps both screens', async () => {
  const { compareJourneyTotals } = await import('../src/journey-evidence.js');
  const x = walk();
  try {
    const home = x.shot('https://www.booking.com/index.es.html');
    const before = await contextFor(x, home, [choice('insurance', false)]);
    const space = x.press(home, 'Space');
    const after_ = x.shot('https://www.booking.com/index.es.html?step=2');
    const after = await contextFor(x, after_, [choice('insurance', true)]);
    compareJourneyTotals(x.store, x.run.id, before, space, after);
    assert.deepEqual(x.images(after_), [home.id, after_.id]);
  } finally {
    x.close();
  }
});
