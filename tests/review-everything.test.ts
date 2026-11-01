import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, reviewReadIsCurrent } from '../src/store.js';
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

// Codex, PR 73: a check-up on the analysis track reads the walk only up to its hand-over.
test('A verdict from a read that stopped before later steps is out of date for queue and report', () => {
  const x = fixture(1);
  try {
    const [finding] = x.candidates as [RecordEntry];
    const cutoff = x.store.records(x.run.id).at(-1)!.seq;
    // The robot keeps walking after the hand-over, then the background review saves its read.
    x.store.append(x.run.id, 'action', 'browser', { kind: 'press' }, [x.capture.id]);
    const read = x.store.snapshot(x.run.id, 'reviewer', [finding.id], undefined, cutoff).read;
    x.store.append(
      x.run.id,
      'review',
      'reviewer',
      { candidateId: finding.id, candidateHash: finding.hash, verdict: 'keep', readSnapshotId: read.id, readSnapshotHash: read.hash },
      [finding.id, read.id],
    );
    const records = x.store.records(x.run.id);
    assert.deepEqual(owedForReview(records).candidates.map((c) => c.id), [finding.id]);
    assert(!reviewReadIsCurrent(read, records), 'the report does not treat it as current either');
    // A read of the whole walk, with nothing after it, is current.
    const whole = x.store.snapshot(x.run.id, 'reviewer', [finding.id]).read;
    assert(reviewReadIsCurrent(whole, x.store.records(x.run.id)));
  } finally {
    x.close();
  }
});

// Loca, PR 73: a supplied finding the reviewer skips is noted and offered again.
test('A finding the reviewer skips is noted, offered again, and a round answering none ends', async () => {
  const x = fixture(3);
  try {
    const runner = new Runner(x.store, 'http://127.0.0.1:4317') as any;
    let rounds = 0;
    const models = {
      async reason(_runId: string, _role: string, records: RecordEntry[]) {
        rounds++;
        const supplied = records.filter((r) => r.kind === 'candidate');
        // First round answers only the first finding; later rounds answer nothing.
        const answer = rounds === 1 ? supplied.slice(0, 1) : [];
        return {
          decisions: answer.map((c) => ({
            candidateId: c.id,
            candidateHash: c.hash,
            verdict: 'reject',
            premise: 'contradicted',
            title: c.payload.title,
            reason: 'Controlled response; no model judgement is claimed.',
            sources: [x.capture.id],
          })),
          criterionDecisions: [],
        };
      },
    };
    const walk = { images: () => [] };
    await runner.finalReviews(models, x.run, x.capture, walk, new AbortController().signal);
    assert.equal(rounds, 2, 'the second round judged nothing, so the loop ended');
    const missing = x.store
      .records(x.run.id)
      .filter((r) => r.payload?.method === 'finding_review_missing')
      .map((r) => r.payload.candidateId);
    assert.deepEqual(missing.slice(0, 2), x.candidates.slice(1).map((c) => c.id));
    assert.deepEqual(
      owedForReview(x.store.records(x.run.id)).candidates.map((c) => c.id),
      x.candidates.slice(1).map((c) => c.id),
      'the skipped findings stay owed',
    );
  } finally {
    x.close();
  }
});
