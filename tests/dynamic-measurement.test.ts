import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server/index.js';
import { BrowserWalk, MeasurementStateChanged } from '../src/browser.js';
import { evaluateCriteria } from '../src/criteria.js';
import { requestEvidence } from '../src/request-evidence.js';
import { Runner } from '../src/runner.js';
import { Store } from '../src/store.js';
import type { RecordEntry } from '../src/types.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'access-walk-changing-measurement-'));
  const store = new Store(dir);
  const run = store.create('Controlled changing page', 'http://127.0.0.1:4317/shop/', 'offline');
  const runner = new Runner(store, 'http://127.0.0.1:4317');
  const capture = (stable = true) =>
    store.append(run.id, 'capture', 'browser', {
      stable,
      stateStamp: 'a'.repeat(64),
      url: run.url,
      imageFile: 'controlled.png',
      imageHash: 'b'.repeat(64),
    });
  const automatic = (walk: unknown, source: RecordEntry, signal = new AbortController().signal) =>
    (runner as any).automaticMeasurement(run, walk, source, signal) as Promise<{
      current: RecordEntry;
      scan?: RecordEntry;
    }>;
  return {
    store,
    run,
    runner,
    capture,
    automatic,
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test(
  'A changed real page is refreshed once without scanning stale evidence or repeating its input',
  { timeout: 90000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'access-walk-dynamic-browser-'));
    const app = await startServer(0, dir, false);
    const run = app.store.create(
      'Controlled dynamic measurement',
      app.origin + '/shop/?case=broken',
      'offline',
    );
    const walk = new BrowserWalk(app.store, run.id, app.origin, true, 'chromium');
    try {
      const first = await walk.start(run.url);
      await walk.act({ kind: 'press', key: 'Tab', note: 'One actual controlled input.' }, first);
      const stale = await walk.capture();
      // Deliberately update the controlled fixture after its original capture was saved.
      await walk.page.locator('h1').evaluate((heading) => {
        heading.textContent = 'Updated controlled product';
      });
      let measurements = 0;
      const originalMeasurements = walk.measurements.bind(walk);
      walk.measurements = async (source) => {
        measurements++;
        return originalMeasurements(source);
      };
      const beforeActions = walk.actions;
      const measured = await (app.runner as any).automaticMeasurement(
        run,
        walk,
        stale,
        new AbortController().signal,
      );
      assert.equal(measurements, 1, 'No measurement retry is made');
      assert.notEqual(measured.current.id, stale.id);
      assert.equal(measured.current.payload.stable, true);
      assert(measured.current.payload.text.includes('Updated controlled product'));
      assert.equal(measured.scan, undefined);
      assert.equal(walk.actions, beforeActions, 'Observation refresh sends no input');
      const records = app.store.records(run.id);
      assert.equal(records.filter((r) => r.kind === 'action').length, 1);
      assert.equal(
        records.filter(
          (r) => r.kind === 'observation' && r.payload.method === 'automatic_accessibility_scan',
        ).length,
        0,
        'The stale source is rejected before scanning',
      );
      const limit = records.find(
        (r) => r.kind === 'limit' && r.payload.sourceCaptureId === stale.id,
      )!;
      assert.equal(limit.payload.state, 'NOT_TESTED');
      const packet = requestEvidence(app.store, run.id, 'analyst', measured.current);
      assert(packet.records.some((r) => r.id === measured.current.id));
      assert.equal(app.store.usage(run.id).requests.length, 0);
      assert.equal(
        records.filter((r) => ['candidate', 'criterion_proposal', 'at_check'].includes(r.kind))
          .length,
        0,
      );
    } finally {
      await walk.close();
      assert.equal(walk.browser?.isConnected(), false);
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  'A scan that changes state retains its untrusted raw result and returns a fresh original',
  { timeout: 90000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'access-walk-during-scan-'));
    const app = await startServer(0, dir, false);
    const run = app.store.create(
      'Controlled scan boundary',
      app.origin + '/shop/?case=broken',
      'offline',
    );
    const walk = new BrowserWalk(app.store, run.id, app.origin, true, 'chromium');
    try {
      const original = await walk.start(run.url);
      let reads = 0;
      // Deterministic state-boundary change while the real axe/browser measurement executes.
      walk.observationStamp = async () =>
        ++reads === 1 ? original.payload.stateStamp : 'c'.repeat(64);
      const measured = await (app.runner as any).automaticMeasurement(
        run,
        walk,
        original,
        new AbortController().signal,
      );
      assert.equal(reads, 2);
      assert.equal(measured.scan, undefined);
      assert.notEqual(measured.current.id, original.id);
      const raw = app.store
        .records(run.id)
        .find(
          (r) => r.kind === 'observation' && r.payload.method === 'automatic_accessibility_scan',
        )!;
      assert(raw);
      assert.equal(raw.payload.stable, false);
      assert.deepEqual(raw.sources, [original.id]);
      const limitation = app.store
        .records(run.id)
        .find((r) => r.kind === 'limit' && r.payload.unavailableObservationId === raw.id)!;
      assert.equal(limitation.payload.state, 'INCONCLUSIVE');
      // Reviewing the intact historical screen must not automatically select its bad scan.
      const packet = requestEvidence(app.store, run.id, 'reviewer', original);
      assert(!packet.records.some((r) => r.id === raw.id));
      assert(packet.records.some((r) => r.id === limitation.id));
      assert.equal(
        app.store.records(run.id).filter((r) => r.payload.unavailableObservationId === raw.id)
          .length,
        1,
      );
      const report = evaluateCriteria(app.store.records(run.id), run.id, {
        imageAvailable: () => true,
      });
      assert.equal(report.counts.PASS, 0);
      assert.equal(report.counts.FAIL, 0);
      assert.equal(report.score, null);
      assert.equal(app.store.records(run.id).filter((r) => r.kind === 'action').length, 0);
      assert.equal(app.store.usage(run.id).requests.length, 0);
    } finally {
      await walk.close();
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test('An intact unstable original is a typed observation limit before any state read', async () => {
  const x = fixture();
  try {
    const source = x.capture(false);
    const walk = new BrowserWalk(x.store, x.run.id, 'http://127.0.0.1:4317', true, 'chromium');
    let stateReads = 0;
    walk.observationStamp = async () => {
      stateReads++;
      return 'a'.repeat(64);
    };
    await assert.rejects(
      walk.measurements(source),
      (error) =>
        error instanceof MeasurementStateChanged &&
        error.stage === 'before' &&
        error.captureId === source.id &&
        !error.observationId,
    );
    assert.equal(stateReads, 0);
  } finally {
    x.close();
  }
});

test('Foreign, forged and corrupt measurement originals remain hard refusals', async () => {
  for (const mode of ['foreign', 'forged', 'corrupt'] as const) {
    const x = fixture();
    try {
      const original = x.capture();
      const source = structuredClone(original);
      if (mode === 'foreign') source.runId = 'different-run';
      if (mode === 'forged') source.payload.stable = false;
      if (mode === 'corrupt')
        x.store.db
          .prepare('UPDATE records SET body=? WHERE id=?')
          .run(JSON.stringify({ ...original.payload, stable: false }), original.id);
      const walk = new BrowserWalk(x.store, x.run.id, 'http://127.0.0.1:4317', true, 'chromium');
      walk.observationStamp = async () => {
        throw Error('An invalid source must not reach a state read');
      };
      await assert.rejects(
        walk.measurements(source),
        (error) =>
          error instanceof Error &&
          !(error instanceof MeasurementStateChanged) &&
          error.message.includes('original capture'),
      );
    } finally {
      x.close();
    }
  }
});

test('Unstable automatic observations are excluded explicitly, but mandatory cited ones still refuse', () => {
  const x = fixture();
  try {
    const source = x.capture();
    const raw = x.store.append(
      x.run.id,
      'observation',
      'axe-core',
      { method: 'automatic_accessibility_scan', stable: false },
      [source.id],
    );
    const packet = requestEvidence(x.store, x.run.id, 'analyst', source);
    assert(!packet.records.some((r) => r.id === raw.id));
    assert(
      packet.records.some(
        (r) =>
          r.kind === 'limit' &&
          r.payload.unavailableObservationId === raw.id &&
          r.payload.state === 'INCONCLUSIVE',
      ),
    );
    requestEvidence(x.store, x.run.id, 'analyst', source);
    assert.equal(x.store.records(x.run.id).filter((r) => r.kind === 'limit').length, 1);
    x.store.append(x.run.id, 'candidate', 'analyst', { title: 'Unsupported moving-page claim' }, [
      raw.id,
    ]);
    assert.throws(() => requestEvidence(x.store, x.run.id, 'reviewer', source), /unstable/);
    x.store.db
      .prepare('UPDATE records SET body=? WHERE id=?')
      .run(JSON.stringify({ ...raw.payload, changed: true }), raw.id);
    assert.throws(
      () => requestEvidence(x.store, x.run.id, 'analyst', source),
      /missing or changed/,
    );
  } finally {
    x.close();
  }
});

test('Automatic start continues from one fresh observation and always cleans up', async () => {
  const x = fixture();
  try {
    const stale = x.capture(false);
    const fresh = x.capture();
    const cleanup: string[] = [];
    let measureAttempts = 0,
      captures = 0,
      continued = 0;
    const walk = {
      engine: 'chromium',
      async start() {
        return stale;
      },
      async measurements() {
        measureAttempts++;
        throw new MeasurementStateChanged(stale.id, 'before');
      },
      async capture() {
        captures++;
        return fresh;
      },
      assertActive() {
        assert.equal(x.store.run(x.run.id).state, 'running');
      },
      async close() {
        cleanup.push('browser');
      },
    };
    (x.runner as any).offline = async (_run: unknown, _walk: unknown, current: RecordEntry) => {
      continued++;
      assert.equal(current.id, fresh.id);
    };
    await (x.runner as any).execute(
      x.run,
      walk,
      {
        async cleanup() {
          cleanup.push('reader');
        },
      },
      new AbortController(),
      false,
      false,
    );
    assert.equal(measureAttempts, 1);
    assert.equal(captures, 1);
    assert.equal(continued, 1);
    assert.deepEqual(cleanup, ['reader', 'browser']);
    assert.equal(x.store.run(x.run.id).state, 'partial');
    assert(
      x.store.run(x.run.id).stopReason?.includes('Offline saved-response demonstration finished'),
    );
    assert.equal(x.store.records(x.run.id).filter((r) => r.kind === 'action').length, 0);
    assert.equal(x.store.usage(x.run.id).requests.length, 0);
  } finally {
    x.close();
  }
});

test('Excluding an unstable observation cannot conceal foreign or missing source links', () => {
  const x = fixture();
  try {
    const current = x.capture();
    const missing = x.capture();
    x.store.append(
      x.run.id,
      'observation',
      'axe-core',
      { method: 'automatic_accessibility_scan', stable: false },
      [current.id, missing.id],
    );
    // The store refuses new foreign links; simulate loss of a previously valid source.
    x.store.db.prepare('DELETE FROM records WHERE id=?').run(missing.id);
    assert.throws(
      () => requestEvidence(x.store, x.run.id, 'analyst', current),
      /Required original evidence is missing or changed/,
    );
    assert.equal(
      x.store.records(x.run.id).filter((record) => record.kind === 'read_snapshot').length,
      0,
    );
  } finally {
    x.close();
  }
});

test('Stopping during refresh and unknown scan failures cannot be recovered as usable evidence', async () => {
  for (const mode of ['aborted-refresh', 'aborted-measurement', 'unknown'] as const) {
    const x = fixture();
    try {
      const source = x.capture();
      const controller = new AbortController();
      let captures = 0;
      const failure =
        mode === 'unknown'
          ? Error('Controlled unrecognized scan failure')
          : new MeasurementStateChanged(source.id, 'before');
      const walk = {
        async measurements() {
          if (mode === 'aborted-measurement') controller.abort();
          throw failure;
        },
        async capture() {
          captures++;
          controller.abort();
          return x.capture();
        },
        assertActive() {},
      };
      await assert.rejects(x.automatic(walk, source, controller.signal), (error) =>
        mode === 'aborted-refresh'
          ? error instanceof Error && error.message.includes('stopped during')
          : error === failure,
      );
      assert.equal(captures, mode === 'aborted-refresh' ? 1 : 0);
      assert.equal(
        x.store
          .records(x.run.id)
          .filter((r) =>
            ['candidate', 'criterion_proposal', 'read_snapshot', 'action'].includes(r.kind),
          ).length,
        0,
      );
      assert.equal(x.store.usage(x.run.id).requests.length, 0);
    } finally {
      x.close();
    }
  }
});
