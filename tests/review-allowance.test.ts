import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Runner } from '../src/runner.js';
import type { RecordEntry } from '../src/types.js';

test('A review beyond eight original screens stays incomplete while later checkpoints continue', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'access-walk-review-allowance-'));
  const store = new Store(dir);
  try {
    const run = store.create(
      'Controlled evidence allowance',
      'http://127.0.0.1:4317/shop/',
      'offline',
    );
    const captures: RecordEntry[] = [];
    for (let n = 0; n < 9; n++) {
      const capture = store.append(run.id, 'capture', 'browser', {
        url: run.url,
        stable: true,
        elements: [],
      });
      captures.push(capture);
      store.append(
        run.id,
        'candidate',
        'analyst',
        {
          title: `A claim on original screen ${n}`,
          scope: 'view',
          targetId: null,
          targetCaptureId: null,
        },
        [capture.id],
      );
    }
    const originalIds = store.records(run.id).map((record) => record.id);
    const called: string[] = [];
    const models = {
      reason: async (_runId: string, role: string) => {
        called.push(role);
        assert.equal(
          role,
          'analyst',
          'An over-limit reviewer request must not reach the provider.',
        );
        return { findings: [], coverage: [] };
      },
    };
    const runner = new Runner(store, 'http://127.0.0.1:4317');
    const walk = { images: () => [] };
    const signal = new AbortController().signal;
    for (const current of [captures[7], captures[8]])
      await (runner as any).analyseCheckpoint(models, run, current, walk, signal);

    const limits = store.records(run.id).filter((record) => record.kind === 'limit');
    assert.equal(limits.length, 2);
    assert(limits.every((record) => record.author === 'reviewer'));
    assert(limits.every((record) => /review remains incomplete/i.test(record.payload.reason)));
    assert(limits.every((record) => /navigation continues/i.test(record.payload.reason)));
    assert.deepEqual(called, ['analyst', 'analyst']);
    assert.equal(store.run(run.id).state, 'running');
    assert.deepEqual(
      store
        .records(run.id)
        .slice(0, originalIds.length)
        .map((r) => r.id),
      originalIds,
    );
    assert.deepEqual(store.published(run.id), []);
    assert.equal(store.usage(run.id).requests.length, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
