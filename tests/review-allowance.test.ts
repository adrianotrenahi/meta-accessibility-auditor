import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Runner } from '../src/runner.js';
import type { RecordEntry } from '../src/types.js';
import { VISUAL_TOPICS } from '../src/visual-inspection.js';

// Loca, PR 73: findings whose pictures together exceed fifty no longer refuse every review;
// each review takes the oldest that fit, and later checkpoints continue.
test('Findings on more than fifty original screens are reviewed in batches that fit, while later checkpoints continue', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'access-walk-review-allowance-'));
  const store = new Store(dir);
  try {
    const run = store.create(
      'Controlled evidence allowance',
      'http://127.0.0.1:4317/shop/',
      'offline',
    );
    const captures: RecordEntry[] = [];
    for (let n = 0; n < 51; n++) {
      const image = store.asset(run.id, `capture_${n}.png`, Buffer.from('Controlled image ' + n));
      const capture = store.append(run.id, 'capture', 'browser', {
        url: run.url,
        stable: true,
        elements: [],
        imageFile: image.file,
        imageHash: image.hash,
      });
      captures.push(capture);
    }
    // Each review now takes at most 25 waiting findings (owner, 1 Nov), so each claim cites
    // three screens: the 25 oldest still need all 51 pictures, above the 50-picture limit.
    for (let n = 0; n < 51; n++)
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
        [captures[n]!.id, captures[(n + 17) % 51]!.id, captures[(n + 34) % 51]!.id],
      );
    const originalIds = store.records(run.id).map((record) => record.id);
    const called: string[] = [];
    const models = {
      reason: async (
        _runId: string,
        role: string,
        _records: RecordEntry[],
        images: { captureId: string }[],
      ) => {
        called.push(role);
        if (role === 'reviewer') {
          assert(images.length <= 50, 'a review request stays within the fifty-picture limit');
          return { decisions: [], criterionDecisions: [] };
        }
        return {
          findings: [],
          coverage: images.flatMap(({ captureId }) =>
            VISUAL_TOPICS.map((topic) => ({
              captureId,
              topic,
              state: 'not_assessed',
              reason: 'This allowance fixture performs no visual assessment.',
              sources: [],
            })),
          ),
        };
      },
    };
    const runner = new Runner(store, 'http://127.0.0.1:4317');
    const walk = {
      images: (records: RecordEntry[]) =>
        records
          .filter((record) => record.kind === 'capture')
          .map((record) => ({
            captureId: record.id,
            image:
              'data:image/png;base64,' +
              store.image(run.id, record.payload.imageFile).toString('base64'),
          })),
    };
    const signal = new AbortController().signal;
    for (const current of [captures[49], captures[50]])
      await (runner as any).analyseCheckpoint(models, run, current, walk, signal);

    assert.deepEqual(called, ['analyst', 'reviewer', 'analyst', 'reviewer']);
    // The stub judged nothing, so each supplied finding is noted as unanswered and stays owed.
    const missing = store
      .records(run.id)
      .filter((record) => record.payload?.method === 'finding_review_missing');
    assert(missing.length > 0 && missing.every((record) => record.author === 'reviewer'));
    assert.equal(store.run(run.id).state, 'running');
    assert.deepEqual(
      store
        .records(run.id)
        .slice(0, originalIds.length)
        .map((r) => r.id),
      originalIds,
    );
    assert.deepEqual(store.published(run.id), []);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
