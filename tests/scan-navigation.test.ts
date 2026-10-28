import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import type { Page } from 'playwright';
import { startServer } from '../server/index.js';
import { BrowserWalk, MeasurementStateChanged } from '../src/browser.js';
import { Store, digest } from '../src/store.js';
import { evaluateCriteria } from '../src/criteria.js';

const navigationError = () =>
  Error('page.evaluate: Execution context was destroyed, most likely because of a navigation');

test(
  'A real document replacement inside axe refreshes the original without input or another scan',
  { timeout: 90000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'access-walk-scan-navigation-'));
    const app = await startServer(0, directory, false);
    const run = app.store.create('Controlled reload during scan', app.origin + '/shop/', 'offline');
    const walk = new BrowserWalk(app.store, run.id, app.origin, true, 'chromium');
    try {
      const original = await walk.start(run.url);
      const beforeActions = walk.actions;
      const originalImage = digest(app.store.image(run.id, original.payload.imageFile));
      const nextUrl = app.origin + '/shop/?case=clean&scan-recovery=true';
      const evaluate = walk.page.evaluate.bind(walk.page);
      let interruptedReads = 0;
      let actualFailure: unknown;
      // Axe injects its script using a string evaluation. Hold that real browser
      // read across a local navigation to reproduce Chromium's actual error.
      walk.page.evaluate = (async (fn: unknown, argument: unknown) => {
        if (typeof fn === 'string' && interruptedReads === 0) {
          interruptedReads++;
          try {
            return await evaluate(
              (url) =>
                new Promise<void>(() => {
                  setTimeout(() => location.assign(url), 0);
                }),
              nextUrl,
            );
          } catch (error) {
            actualFailure = error;
            throw error;
          }
        }
        return evaluate(fn as any, argument);
      }) as typeof walk.page.evaluate;
      let scanAttempts = 0;
      const measurements = walk.measurements.bind(walk);
      walk.measurements = async (capture) => {
        scanAttempts++;
        return measurements(capture);
      };
      const measured = await (app.runner as any).automaticMeasurement(
        run,
        walk,
        original,
        new AbortController().signal,
      );
      assert(actualFailure instanceof Error);
      assert.match(actualFailure.message, /Execution context was destroyed/);
      assert.equal(interruptedReads, 1);
      assert.equal(scanAttempts, 1, 'The interrupted scan is not repeated');
      assert.equal(measured.scan, undefined);
      assert.notEqual(measured.current.id, original.id);
      assert.equal(measured.current.payload.url, nextUrl);
      assert.equal(measured.current.payload.stable, true);
      assert.deepEqual(app.store.record(run.id, original.id), original);
      assert.equal(digest(app.store.image(run.id, original.payload.imageFile)), originalImage);
      const records = app.store.records(run.id);
      const limit = records.find(
        (record) => record.kind === 'limit' && record.payload.sourceCaptureId === original.id,
      )!;
      assert.equal(limit.payload.state, 'INCONCLUSIVE');
      assert.equal(limit.payload.unavailableObservationId, null);
      assert.deepEqual(limit.sources, [original.id]);
      assert.equal(
        records.filter((record) =>
          ['observation', 'action', 'candidate', 'review', 'criterion_proposal'].includes(
            record.kind,
          ),
        ).length,
        0,
      );
      assert.equal(walk.actions, beforeActions, 'Recovery adds no action to the initial page open');
      assert.equal(app.store.usage(run.id).requests.length, 0);
      const report = evaluateCriteria(records, run.id, { imageAvailable: () => true });
      assert.equal(report.counts.PASS, 0);
      assert.equal(report.counts.FAIL, 0);
      assert.equal(report.score, null);
    } finally {
      await walk.close();
      await app.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test('Document replacement before the scan stays untested and requests a fresh observation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'access-walk-before-scan-navigation-'));
  const store = new Store(directory);
  const run = store.create(
    'Controlled before-scan replacement',
    'http://127.0.0.1:4317/',
    'offline',
  );
  const walk = new BrowserWalk(store, run.id, 'http://127.0.0.1:4317', true, 'chromium');
  try {
    const source = store.append(run.id, 'capture', 'browser', {
      stable: true,
      stateStamp: 'a'.repeat(64),
    });
    walk.page = { isClosed: () => false } as Page;
    walk.observationStamp = async () => {
      throw navigationError();
    };
    await assert.rejects(
      walk.measurements(source),
      (error) =>
        error instanceof MeasurementStateChanged &&
        error.stage === 'before' &&
        error.captureId === source.id &&
        error.observationId === undefined,
    );
    assert.equal(store.records(run.id).length, 1);
    assert.equal(store.usage(run.id).requests.length, 0);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Closed pages, stopped runs and unrelated scan errors remain hard failures', async () => {
  const analyze = AxeBuilder.prototype.analyze;
  for (const mode of ['closed', 'stopped', 'unknown'] as const) {
    const directory = mkdtempSync(join(tmpdir(), 'access-walk-scan-refusal-'));
    const store = new Store(directory);
    const run = store.create('Controlled scan refusal', 'http://127.0.0.1:4317/', 'offline');
    const walk = new BrowserWalk(store, run.id, 'http://127.0.0.1:4317', true, 'chromium');
    try {
      const source = store.append(run.id, 'capture', 'browser', {
        stable: true,
        stateStamp: 'a'.repeat(64),
      });
      walk.page = { isClosed: () => mode === 'closed' } as Page;
      walk.observationStamp = async () => 'a'.repeat(64);
      const failure = mode === 'unknown' ? Error('Controlled scan bug') : navigationError();
      AxeBuilder.prototype.analyze = async () => {
        if (mode === 'stopped') store.finish(run.id, 'stopped', 'Stopped during scan');
        throw failure;
      };
      await assert.rejects(walk.measurements(source), (error) => {
        assert(!(error instanceof MeasurementStateChanged));
        return mode === 'stopped'
          ? error instanceof Error && /run has stopped/.test(error.message)
          : error === failure;
      });
      assert.equal(store.records(run.id).length, 1);
      assert.equal(store.usage(run.id).requests.length, 0);
    } finally {
      AxeBuilder.prototype.analyze = analyze;
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }
});
