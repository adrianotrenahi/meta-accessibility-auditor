import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server/index.js';
import { BrowserWalk } from '../src/browser.js';
import { IncompleteModelResult } from '../src/models.js';
import { EvidenceRequestLimit } from '../src/request-evidence.js';
import { Store } from '../src/store.js';
import { Runner } from '../src/runner.js';

test('Final scope bookkeeping cannot skip reader/browser cleanup or retain a focused budget', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'access-walk-cleanup-bookkeeping-'));
  const store = new Store(dir);
  const run = store.create('Controlled cleanup fixture', 'http://127.0.0.1:4317/shop/', 'offline');
  const runner = new Runner(store, 'http://127.0.0.1:4317');
  const cleanup: string[] = [];
  const failure = Error('Controlled final scope collection failure.');
  const records = store.records.bind(store);
  let finalReads = 0;
  try {
    (runner as any).focusedBudget(run.id);
    store.records = () => {
      assert.equal(
        store.run(run.id).state,
        'partial',
        'Only the final scope collection is failing.',
      );
      finalReads++;
      throw failure;
    };
    await assert.rejects(
      (runner as any).execute(
        run,
        {
          engine: 'chromium',
          async start() {
            throw Error('Controlled browser start failure.');
          },
          async close() {
            cleanup.push('browser');
          },
        },
        {
          async cleanup() {
            cleanup.push('reader');
          },
        },
        new AbortController(),
        false,
        false,
      ),
      (error: unknown) => error === failure,
    );
    assert.equal(finalReads, 1);
    assert.deepEqual(cleanup, ['reader', 'browser']);
    assert.equal((runner as any).focusedBudgets.has(run.id), false);
  } finally {
    store.records = records;
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const failure of ['incomplete', 'allowance', 'unknown', 'aborted'] as const)
  test(
    `A saved ${failure} reviewer failure after focused Tab preserves the latest original or propagates`,
    { timeout: 90000 },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'access-walk-checkpoint-state-'));
      const app = await startServer(0, dir, false);
      const run = app.store.create(
        'Saved checkpoint recovery fixture',
        app.origin + '/shop/?case=broken',
        'offline',
      );
      const walk = new BrowserWalk(app.store, run.id, app.origin, true, 'chromium');
      try {
        const original = await walk.start(run.url);
        const measured = await walk.measurements(original);
        const controller = new AbortController();
        const error =
          failure === 'allowance'
            ? new EvidenceRequestLimit('reviewer')
            : failure === 'unknown'
              ? Error('Controlled unrecognized reviewer failure.')
              : new IncompleteModelResult('reviewer');
        const models = {
          async reason(_runId: string, role: string) {
            if (role === 'reviewer') {
              if (failure === 'aborted') controller.abort();
              throw error;
            }
            assert.equal(role, 'analyst');
            return {
              findings: [],
              coverage: [],
              visualObservations: [],
              criterionProposals: [
                {
                  captureId: original.id,
                  criterionId: 'C02',
                  verdict: 'FAIL',
                  reason: 'Saved fixture: the original browser facts expose an empty button name.',
                  sources: [original.id, measured.id],
                  missingEvidence: [],
                },
              ],
              missingEvidence: [
                {
                  method: 'keyboard_focus',
                  captureId: original.id,
                  criterionId: 'C06',
                  reason: 'Saved fixture: record one actual keyboard focus stop.',
                },
              ],
            };
          },
        };
        const checkpoint = (current = original) =>
          (app.runner as any).analyseCheckpoint(models, run, current, walk, controller.signal);
        if (failure === 'unknown' || failure === 'aborted') {
          await assert.rejects(checkpoint(), (caught: unknown) => caught === error);
          assert.equal(
            app.store
              .records(run.id)
              .filter((record) => record.kind === 'limit' && record.payload.checkpointCaptureId)
              .length,
            0,
          );
        } else {
          const current = await checkpoint();
          const latest = app.store
            .records(run.id)
            .filter((record) => record.kind === 'capture')
            .at(-1)!;
          assert.notEqual(
            current.id,
            original.id,
            'The real Tab produced a newer original capture.',
          );
          assert.equal(
            current.id,
            latest.id,
            'The caller receives the actual current page, not the pre-Tab state.',
          );
          const limit = app.store
            .records(run.id)
            .filter((record) => record.kind === 'limit' && record.payload.checkpointCaptureId)
            .at(-1)!;
          assert.equal(limit.payload.checkpointCaptureId, latest.id);
          assert.deepEqual(limit.sources, [latest.id]);
          assert.equal(
            await checkpoint(current),
            current,
            'A stale follow-up request leaves the latest original in place.',
          );
        }
        const records = app.store.records(run.id);
        const inputs = records.filter((record) => record.kind === 'action');
        assert.equal(
          inputs.length,
          1,
          'Review failure and a stale request never repeat the actual input.',
        );
        assert.equal(inputs[0].payload.action.key, 'Tab');
        assert.equal(inputs[0].payload.waitAfterMs, 180);
        assert.equal(app.store.usage(run.id).requests.length, 0);
        assert.equal(records.filter((record) => record.kind === 'at_check').length, 0);
      } finally {
        await walk.close();
        await app.close();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
