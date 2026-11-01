import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Runner } from '../src/runner.js';
import { owedForReview, requestEvidence } from '../src/request-evidence.js';
import { MAX_FINDINGS, type RecordEntry } from '../src/types.js';

// Owner, 1 Nov: "the reviewer should be able to check all answers the analyst provides" and
// "OK do this": each finding is judged once (again only when its kept verdict is out of date),
// one review takes a batch, and the final review repeats until nothing waits.
function fixture(findings: number) {
  const dir = mkdtempSync(join(tmpdir(), 'review-everything-'));
  const store = new Store(dir);
  const run = store.create('Review everything', 'http://127.0.0.1:4317/shop/', 'offline');
  const image = store.asset(run.id, 'capture_0.png', Buffer.from('Controlled image'));
  const capture = store.append(run.id, 'capture', 'browser', {
    url: run.url,
    stable: true,
    elements: [],
    imageFile: image.file,
    imageHash: image.hash,
  });
  const candidates = Array.from({ length: findings }, (_, n) =>
    store.append(
      run.id,
      'candidate',
      'analyst',
      { title: `Claim ${n}`, scope: 'view', targetId: null, targetCaptureId: null },
      [capture.id],
    ),
  );
  // A verdict as the runner saves it: the review cites the reviewer's own read of the walk.
  const judge = (candidate: RecordEntry, verdict: string) => {
    const read = store.snapshot(run.id, 'reviewer').read;
    return store.append(
      run.id,
      'review',
      'reviewer',
      {
        candidateId: candidate.id,
        candidateHash: candidate.hash,
        verdict,
        readSnapshotId: read.id,
        readSnapshotHash: read.hash,
      },
      [candidate.id, read.id],
    );
  };
  return {
    store,
    run,
    capture,
    candidates,
    judge,
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('A finding waits until it is judged, and again only when its kept verdict is out of date', () => {
  const x = fixture(4);
  try {
    const [kept, rejected, rewrite, fresh] = x.candidates as [RecordEntry, RecordEntry, RecordEntry, RecordEntry];
    x.judge(kept, 'keep');
    x.judge(rejected, 'reject');
    x.judge(rewrite, 'rewrite');
    const ids = () => owedForReview(x.store.records(x.run.id)).candidates.map((c) => c.id);
    assert.deepEqual(ids(), [fresh.id], 'judged findings are not sent again');
    // New walk evidence makes the kept verdict out of date (the report withdraws it).
    x.store.append(x.run.id, 'navigator_note', 'driver', { text: 'A later step.' }, [x.capture.id]);
    assert.deepEqual(ids(), [kept.id, fresh.id], 'oldest first; rejected and rewrite stay done');
  } finally {
    x.close();
  }
});

test('One review takes the oldest waiting findings, up to one batch', () => {
  const x = fixture(MAX_FINDINGS + 5);
  try {
    x.judge(x.candidates[0]!, 'reject');
    const read = requestEvidence(x.store, x.run.id, 'reviewer', x.capture);
    const sent = read.records.filter((r) => r.kind === 'candidate').map((r) => r.id);
    assert.deepEqual(sent, x.candidates.slice(1, MAX_FINDINGS + 1).map((c) => c.id));
  } finally {
    x.close();
  }
});

test('The final review repeats until nothing waits, and stops when a round makes no progress', async () => {
  for (const progress of [true, false]) {
    const x = fixture(MAX_FINDINGS * 2 + 3);
    try {
      const runner = new Runner(x.store, 'http://127.0.0.1:4317') as any;
      let rounds = 0;
      runner.review = async (_m: any, _run: any, _c: any, _w: any, _s: any, final: boolean) => {
        rounds++;
        assert.equal(final, true, 'every round reserves as the final review');
        if (!progress) return;
        for (const c of owedForReview(x.store.records(x.run.id)).candidates.slice(0, MAX_FINDINGS))
          x.judge(c, 'keep');
      };
      await runner.finalReviews({}, x.run, x.capture, {}, new AbortController().signal);
      if (progress) {
        assert.equal(rounds, 3, '53 findings take three batches of up to 25');
        assert.equal(owedForReview(x.store.records(x.run.id)).candidates.length, 0);
      } else assert.equal(rounds, 1, 'a round that judges nothing is not repeated');
    } finally {
      x.close();
    }
  }
});
