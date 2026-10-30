import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { earlierCheck, earlierScan } from '../src/repeat-checkpoint.js';
import { Runner } from '../src/runner.js';

function seeded() {
  const dir = mkdtempSync(join(tmpdir(), 'repeat-checkpoint-'));
  const store = new Store(dir);
  const run = store.create('Repeat checkpoint rule', 'http://127.0.0.1/', 'offline');
  const capture = store.append(run.id, 'capture', 'browser', {
    url: 'http://127.0.0.1/',
    stable: true,
  });
  const scan = (source = capture, stable = true) =>
    store.append(
      run.id,
      'observation',
      'axe-core',
      {
        method: 'automatic_accessibility_scan',
        sourceCaptureId: source.id,
        sourceCaptureHash: source.hash,
        stable,
      },
      [source.id],
    );
  const coverage = (captureId = capture.id) =>
    store.append(run.id, 'coverage', 'analyst', {
      topics: [{ captureId, topic: 'content', state: 'examined', reason: 'Synthetic.' }],
    });
  const records = () => store.records(run.id);
  return {
    store,
    run,
    capture,
    scan,
    coverage,
    records,
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('A scan of the same screenshot is reused only while nothing was seen or done since', () => {
  const x = seeded();
  try {
    assert.equal(earlierScan(x.records(), x.capture), undefined, 'never scanned');
    const first = x.scan();
    assert.equal(earlierScan(x.records(), x.capture)?.id, first.id);
    x.store.append(x.run.id, 'navigator_note', 'driver', {
      kind: 'progress',
      text: 'Notes are not evidence.',
    });
    assert.equal(earlierScan(x.records(), x.capture)?.id, first.id);
    x.store.append(x.run.id, 'action', 'browser', { method: 'actual_keyboard_or_browser' });
    assert.equal(earlierScan(x.records(), x.capture), undefined, 'input since the scan');
  } finally {
    x.close();
  }
});

test('An unsettled scan, or a scan of another screenshot, is never reused', () => {
  const x = seeded();
  try {
    x.scan(x.capture, false);
    assert.equal(earlierScan(x.records(), x.capture), undefined);
    const other = x.store.append(x.run.id, 'capture', 'browser', { url: 'http://127.0.0.1/b' });
    x.scan(other);
    assert.equal(earlierScan(x.records(), x.capture), undefined);
  } finally {
    x.close();
  }
});

test('A check of the same screenshot stands only while nothing was seen or done since', () => {
  const x = seeded();
  try {
    assert.equal(earlierCheck(x.records(), x.capture), undefined, 'never checked');
    x.scan();
    const checked = x.coverage();
    assert.equal(earlierCheck(x.records(), x.capture)?.id, checked.id);
    for (const kind of ['observation', 'at_check', 'focused_check', 'capture'] as const) {
      const y = seeded();
      try {
        y.coverage();
        y.store.append(y.run.id, kind, 'browser', { synthetic: true });
        assert.equal(
          earlierCheck(y.records(), y.capture),
          undefined,
          `new ${kind} since the check`,
        );
      } finally {
        y.close();
      }
    }
  } finally {
    x.close();
  }
});

test('Only the latest analyst check counts, and only for a screenshot it covered', () => {
  const x = seeded();
  try {
    const other = x.store.append(x.run.id, 'capture', 'browser', { url: 'http://127.0.0.1/b' });
    x.coverage(other.id);
    assert.equal(earlierCheck(x.records(), x.capture), undefined, 'covered another screenshot');
    x.store.append(x.run.id, 'coverage', 'runner', { topics: [{ captureId: x.capture.id }] });
    assert.equal(earlierCheck(x.records(), x.capture), undefined, 'not the analyst');
  } finally {
    x.close();
  }
});

const contextRead = (x: ReturnType<typeof seeded>, stable: boolean) =>
  x.store.append(
    x.run.id,
    'observation',
    'browser',
    {
      method: 'journey_context',
      stable,
      sourceCaptureId: x.capture.id,
      sourceCaptureHash: x.capture.hash,
    },
    [x.capture.id],
  );

test('In the Booking.com order, the check’s own settled context read does not force a repeat', () => {
  // 30 Oct: scan, journey-context read of the same screenshot, analyst coverage, next completion.
  const x = seeded();
  try {
    const scan = x.scan();
    contextRead(x, true);
    const checked = x.coverage();
    x.store.append(x.run.id, 'navigator_note', 'driver', { kind: 'step_completed' });
    assert.equal(earlierScan(x.records(), x.capture)?.id, scan.id);
    assert.equal(earlierCheck(x.records(), x.capture)?.id, checked.id);
  } finally {
    x.close();
  }
});

test('An unsettled context read, or one of another screenshot, still forces a new scan and check', () => {
  const x = seeded();
  try {
    x.scan();
    contextRead(x, false);
    x.coverage();
    assert.equal(earlierScan(x.records(), x.capture), undefined);
    const y = seeded();
    try {
      y.scan();
      y.coverage();
      const other = y.store.append(y.run.id, 'capture', 'browser', { url: 'http://127.0.0.1/b' });
      y.store.append(y.run.id, 'observation', 'browser', {
        method: 'journey_context',
        stable: true,
        sourceCaptureId: other.id,
        sourceCaptureHash: other.hash,
      });
      assert.equal(earlierCheck(y.records(), y.capture), undefined);
    } finally {
      y.close();
    }
  } finally {
    x.close();
  }
});

test('The note that an earlier check stands is never sent to a model as evidence', () => {
  const x = seeded();
  try {
    const note = x.store.append(x.run.id, 'coverage', 'runner', {
      method: 'repeat_checkpoint/1',
      state: 'ALREADY_CHECKED',
    });
    const other = x.store.append(x.run.id, 'coverage', 'runner', { criteria: 'Foundation only.' });
    const { records } = x.store.snapshot(x.run.id, 'analyst');
    assert(!records.some((record) => record.id === note.id));
    assert(
      records.some((record) => record.id === other.id),
      'other runner notes are unchanged',
    );
  } finally {
    x.close();
  }
});

test('A stopped run never continues from a reused scan or an earlier check', async () => {
  const x = seeded();
  try {
    x.scan();
    x.coverage();
    const runner = new Runner(x.store, 'http://127.0.0.1') as any;
    const walk = { publicWebsite: false, waitForReloadsToStop: async () => {} };
    const stopped = new AbortController();
    stopped.abort();
    await assert.rejects(
      runner.automaticMeasurement(x.run, walk, x.capture, stopped.signal),
      /stopped/,
    );
    await assert.rejects(
      runner.analyseCheckpoint(undefined, x.run, x.capture, walk, stopped.signal),
    );
    assert(
      !x.records().some((record) => record.payload.method === 'repeat_checkpoint/1'),
      'no note is saved for a stopped run',
    );
  } finally {
    x.close();
  }
});
