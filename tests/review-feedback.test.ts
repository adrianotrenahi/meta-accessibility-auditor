import { test } from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../src/store.js';
import { reviewFeedbackIds } from '../src/review-feedback.js';
import type { RecordEntry } from '../src/types.js';

function fixture() {
  let n = 0;
  const runId = 'controlled-feedback-run';
  function record(
    kind: RecordEntry['kind'],
    seq: number,
    content: any,
    sources: string[] = [],
    run = runId,
  ): RecordEntry {
    const payload = { ...content, _sourcesHash: digest(JSON.stringify(sources)) };
    return {
      id: `record-${++n}`,
      runId: run,
      seq,
      kind,
      author: kind === 'candidate' ? 'analyst' : 'reviewer',
      payload,
      sources,
      hash: digest(JSON.stringify(payload)),
      createdAt: '2026-10-28T09:00:00.000Z',
    };
  }
  const candidate = record('candidate', 1, {
    title: 'The Add control has no programmatic name',
    detail: 'Original unchanged candidate body.',
  });
  function review(
    seq: number,
    verdict: 'keep' | 'rewrite' | 'reject' | 'unresolved',
    changes: any = {},
    run = runId,
  ) {
    return record(
      'review',
      seq,
      {
        candidateId: candidate.id,
        candidateHash: candidate.hash,
        verdict,
        premise: 'supported',
        reason: verdict === 'keep' ? 'Keep the exact claim.' : 'Revise the unsupported impact.',
        ...changes,
      },
      [],
      run,
    );
  }
  return { runId, candidate, review, record };
}

test('The retained keep, rewrite, keep pattern preserves the latest review and disputed reason', () => {
  const x = fixture(),
    kept = x.review(2, 'keep'),
    rewritten = x.review(3, 'rewrite'),
    latest = x.review(4, 'keep');
  assert.deepEqual(reviewFeedbackIds([x.candidate, kept, rewritten, latest], x.runId), [
    latest.id,
    rewritten.id,
  ]);
});

test('Feedback is bounded to two unique records per exact candidate, regardless of input order or duplication', () => {
  const x = fixture();
  const reviews = [
    x.review(2, 'rewrite'),
    x.review(3, 'reject'),
    x.review(4, 'unresolved'),
    x.review(5, 'keep'),
    x.review(6, 'keep'),
  ];
  assert.deepEqual(
    reviewFeedbackIds(
      [
        reviews[4],
        x.candidate,
        reviews[2],
        reviews[1],
        reviews[3],
        reviews[0],
        x.candidate,
        reviews[4],
      ],
      x.runId,
    ),
    [reviews[4].id, reviews[2].id],
  );
  assert.deepEqual(reviewFeedbackIds([x.candidate, ...reviews.slice(0, 3)], x.runId), [
    reviews[2].id,
  ]);
  assert.deepEqual(reviewFeedbackIds([x.candidate, reviews[3], reviews[4]], x.runId), [
    reviews[4].id,
  ]);
});

test("A different candidate body or foreign run cannot inherit another version's feedback", () => {
  const x = fixture(),
    review = x.review(2, 'rewrite');
  const revised = {
    ...x.candidate,
    payload: { ...x.candidate.payload, detail: 'A genuinely different body.' },
  };
  revised.hash = digest(JSON.stringify(revised.payload));
  assert.deepEqual(reviewFeedbackIds([revised, review], x.runId), []);
  assert.deepEqual(
    reviewFeedbackIds([x.candidate, x.review(3, 'rewrite', {}, 'foreign-run')], x.runId),
    [],
  );
  assert.deepEqual(
    reviewFeedbackIds([{ ...x.candidate, runId: 'foreign-run' }, review], x.runId),
    [],
  );
  assert.deepEqual(
    reviewFeedbackIds(
      [x.candidate, x.review(3, 'rewrite', { candidateId: 'another-candidate' })],
      x.runId,
    ),
    [],
  );
  assert.deepEqual(
    reviewFeedbackIds([x.candidate, revised, review], x.runId),
    [],
    'Conflicting versions with one identity are not guessed.',
  );
});

test('Changed review bodies or source edges and changed candidates cannot become feedback', () => {
  const x = fixture(),
    intact = x.review(2, 'rewrite');
  const changed = x.review(3, 'keep');
  changed.payload.reason = 'Changed after hashing.';
  const changedEdges = x.review(4, 'keep');
  changedEdges.sources.push('changed-source');
  assert.deepEqual(reviewFeedbackIds([x.candidate, intact, changed, changedEdges], x.runId), [
    intact.id,
  ]);
  const damagedCandidate = {
    ...x.candidate,
    payload: { ...x.candidate.payload, title: 'Changed title.' },
  };
  assert.deepEqual(reviewFeedbackIds([damagedCandidate, intact], x.runId), []);
});

test('Exact raw review identity can supply context without retrieving its legacy evidence graph', () => {
  const x = fixture();
  const review = x.record(
    'review',
    2,
    {
      candidateId: x.candidate.id,
      candidateHash: x.candidate.hash,
      verdict: 'rewrite',
      reason: 'This old correction is interpretation context, not original proof.',
      readSnapshotId: 'legacy-read-not-in-packet',
    },
    ['legacy-original-not-in-packet', 'legacy-read-not-in-packet'],
  );
  const records = [x.candidate, review],
    before = JSON.stringify(records);
  assert.deepEqual(reviewFeedbackIds(records, x.runId), [review.id]);
  assert.equal(JSON.stringify(records), before, 'No body, link or hash is rewritten.');
});

test('A review predating the candidate and unrelated decision kinds are not feedback', () => {
  const x = fixture();
  const earlier = x.review(0, 'rewrite');
  const unrelated = x.record('criterion_review', 3, {
    candidateId: x.candidate.id,
    candidateHash: x.candidate.hash,
    verdict: 'rewrite',
  });
  const unsupported = x.review(4, 'keep', { premise: 'unverified' }),
    latest = x.review(5, 'keep');
  assert.deepEqual(reviewFeedbackIds([x.candidate, earlier, unrelated], x.runId), []);
  assert.deepEqual(reviewFeedbackIds([x.candidate, unsupported, latest], x.runId), [
    latest.id,
    unsupported.id,
  ]);
});
