import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, digest } from '../src/store.js';
import { CRITERIA, CRITERIA_VERSION, evaluateCriteria, makeCriterionScope } from '../src/criteria.js';
import { EvidenceRequestLimit, requestEvidence } from '../src/request-evidence.js';
import { reviewSchema } from '../src/models.js';
import { Runner } from '../src/runner.js';
import { CAPS, CRITERION_REVIEW_BATCH, MAX_FINDINGS } from '../src/types.js';
import type { RecordEntry } from '../src/types.js';

function fixture(count: number) {
  const dir = mkdtempSync(join(tmpdir(), 'access-walk-reviewer-selection-'));
  const store = new Store(dir);
  const run = store.create(
    'Controlled reviewer selection',
    'http://127.0.0.1:4317/shop/',
    'offline',
  );
  const captures = Array.from({ length: count }, (_, i) =>
    store.append(run.id, 'capture', 'browser', {
      stable: true,
      url: run.url + i,
      text: 'Controlled screen ' + i,
      imageFile: `capture_${i}.png`,
      imageHash: store.asset(run.id, `capture_${i}.png`, Buffer.from(`Controlled image ${i}`)).hash,
      limits: { visibleTextTruncated: false },
    }),
  );
  const scopes = captures.map((capture) =>
    store.append(run.id, 'criterion_scope', 'criteria-planner', makeCriterionScope(capture.id), [
      capture.id,
    ]),
  );
  const candidate = (sources: string[]) =>
    store.append(
      run.id,
      'candidate',
      'analyst',
      {
        title: 'Controlled candidate',
        visiblePremise: 'An observed controlled fact.',
        sources,
      },
      sources,
    );
  const proposal = (capture: RecordEntry, sources = [capture.id]) => {
    const scope = scopes[captures.findIndex((item) => item.id === capture.id)];
    const read = store.snapshot(run.id, 'analyst').read;
    return store.append(
      run.id,
      'criterion_proposal',
      'analyst',
      {
        version: CRITERIA_VERSION,
        scopeId: scope.id,
        checkId: `${capture.id}:C02`,
        criterionId: 'C02',
        verdict: 'FAIL',
        reason: 'Controlled proposal, pending independent review.',
        sources,
        missingEvidence: [],
        screenReaderClaimed: false,
        readSnapshotId: read.id,
      },
      [scope.id, ...sources],
    );
  };
  return {
    store,
    run,
    captures,
    scopes,
    candidate,
    proposal,
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('Optional criteria cannot displace mandatory originals or exceed the image bound', () => {
  const x = fixture(52);
  try {
    const current = x.captures[0];
    const candidate = x.candidate(x.captures.slice(1, 49).map((capture) => capture.id));
    const fitting = x.proposal(x.captures[2]);
    const fittingExtra = x.proposal(x.captures[49]);
    const oversized = x.proposal(
      x.captures[50],
      x.captures.slice(50).map((capture) => capture.id),
    );
    const walk = x.store.append(x.run.id, 'action', 'browser', { outcome: 'performed' }, [
      current.id,
    ]);
    const note = x.store.append(
      x.run.id,
      'navigator_note',
      'navigator',
      { note: 'Original walk note.' },
      [current.id],
    );
    const read = requestEvidence(x.store, x.run.id, 'reviewer', current);
    const ids = new Set(read.records.map((record) => record.id));
    for (const required of [
      current,
      candidate,
      ...x.captures.slice(1, 50),
      fitting,
      fittingExtra,
      walk,
      note,
    ])
      assert(ids.has(required.id));
    assert(!ids.has(oversized.id));
    assert(x.captures.slice(50).every((capture) => !ids.has(capture.id)));
    assert.equal(read.records.filter((record) => record.kind === 'capture').length, 50);
    assert(
      read.records.some(
        (record) =>
          record.kind === 'limit' &&
          record.payload.proposalId === oversized.id &&
          /image allowance/.test(record.payload.reason),
      ),
    );
    assert.equal(
      x.store.records(x.run.id).filter((record) => record.kind === 'criterion_review').length,
      0,
    );
    assert.equal(
      evaluateCriteria(x.store.records(x.run.id), x.run.id, { imageAvailable: () => true }).counts
        .PASS,
      0,
    );
  } finally {
    x.close();
  }
});

test('A fitting criterion carries its exact complete source closure into the reviewer read', () => {
  const x = fixture(3);
  try {
    const measurement = x.store.append(
      x.run.id,
      'observation',
      'browser',
      { stable: true, method: 'controlled_comparison' },
      [x.captures[1].id, x.captures[2].id],
    );
    const originalNote = x.store.append(
      x.run.id,
      'observation',
      'browser',
      { stable: true, method: 'controlled_context' },
      [measurement.id],
    );
    const proposal = x.proposal(x.captures[1], [originalNote.id]);
    x.candidate([x.captures[1].id, x.captures[2].id]);
    const read = requestEvidence(x.store, x.run.id, 'reviewer', x.captures[0]);
    for (const original of [proposal, originalNote, measurement, x.scopes[1], ...x.captures]) {
      const selected = read.records.find((record) => record.id === original.id);
      assert(selected);
      assert.equal(selected.hash, original.hash);
      assert.deepEqual(selected.sources, original.sources);
      const pin = read.read.payload.records.find((entry: any) => entry.id === original.id);
      assert.equal(pin.hash, original.hash);
      assert.deepEqual(pin.sources, original.sources);
    }
  } finally {
    x.close();
  }
});

// Owner, 1 Nov: the reviewer saw only the five newest proposals, including ones it had already
// judged, so in a Booking.com audit a proposal was left unreviewed 43 times.
test('Every proposal still owed a review is supplied; judged and replaced ones are not', () => {
  const x = fixture(9);
  try {
    x.candidate(x.captures.slice(1, 7).map((capture) => capture.id));
    const many = Array.from({ length: 7 }, (_, i) => x.proposal(x.captures[i + 1]));
    // One was already judged at an earlier checkpoint; another check got a newer proposal.
    const judged = many[0]!;
    x.store.append(
      x.run.id,
      'criterion_review',
      'reviewer',
      { proposalId: judged.id, proposalHash: judged.hash, verdict: 'keep' },
      [judged.id],
    );
    const replaced = many[1]!;
    const replacement = x.proposal(x.captures[2]);
    const read = requestEvidence(x.store, x.run.id, 'reviewer', x.captures[0]);
    const selected = new Set(
      read.records.filter((record) => record.kind === 'criterion_proposal').map((r) => r.id),
    );
    assert.deepEqual(
      [...selected].sort(),
      [...many.slice(2), replacement].map((p) => p.id).sort(),
      'six owed proposals, more than the old five',
    );
    assert(!selected.has(judged.id) && !selected.has(replaced.id));
    assert(read.records.some((record) => record.id === x.captures[7]!.id));
  } finally {
    x.close();
  }
});

// Loca, PR 73: a finding whose pictures can never fit one review used to refuse every review,
// so later findings were never reviewed either. It is now set aside with a single note.
test('A finding too big for any review is set aside with one note; newer findings still go', () => {
  const x = fixture(52);
  try {
    const huge = x.candidate(x.captures.slice(1, 51).map((capture) => capture.id));
    const small = x.candidate([x.captures[51]!.id]);
    const sent = () =>
      requestEvidence(x.store, x.run.id, 'reviewer', x.captures[0]!)
        .records.filter((r) => r.kind === 'candidate')
        .map((r) => r.id);
    assert.deepEqual(sent(), [small.id]);
    assert.deepEqual(sent(), [small.id]);
    const notes = x.store
      .records(x.run.id)
      .filter((r) => r.payload?.method === 'finding_review_selection');
    assert.deepEqual(notes.map((r) => r.payload.candidateId), [huge.id], 'noted once');
  } finally {
    x.close();
  }
});

test('A batch takes the waiting findings whose pictures fit; the rest wait silently', () => {
  const x = fixture(51);
  try {
    // 24 findings of two pictures each: 48 pictures plus the current screen fit (49).
    const pairs = Array.from({ length: 24 }, (_, i) =>
      x.candidate([x.captures[2 * i + 1]!.id, x.captures[2 * i + 2]!.id]),
    );
    const tooMany = x.candidate([x.captures[49]!.id, x.captures[50]!.id]); // would make 51
    const fits = x.candidate([x.captures[1]!.id]); // already selected
    const sent = requestEvidence(x.store, x.run.id, 'reviewer', x.captures[0]!).records.filter(
      (r) => r.kind === 'candidate',
    );
    assert.deepEqual(sent.map((r) => r.id), [...pairs, fits].map((c) => c.id));
    assert(!sent.some((r) => r.id === tooMany.id), 'it waits for the next review');
    assert(
      !x.store.records(x.run.id).some((r) => r.payload?.method === 'finding_review_selection'),
      'no note for a finding that merely waits',
    );
  } finally {
    x.close();
  }
});

test('A focused recapture does not lose an earlier criterion proposal when no finding exists', () => {
  const x = fixture(2);
  try {
    const proposal = x.proposal(x.captures[0]);
    const originals = JSON.stringify(x.store.records(x.run.id));
    const read = requestEvidence(x.store, x.run.id, 'reviewer', x.captures[1]);
    for (const original of [proposal, x.scopes[0], ...x.captures]) {
      assert(
        read.records.some((record) => record.id === original.id),
        original.kind,
      );
      assert(
        read.read.payload.records.some(
          (pin: any) => pin.id === original.id && pin.hash === original.hash,
        ),
      );
    }
    assert.deepEqual(
      read.read.payload.imageReceipt.supplied.map((pin: any) => pin.captureId).sort(),
      x.captures.map((capture) => capture.id).sort(),
    );
    assert.equal(
      JSON.stringify(x.store.records(x.run.id).filter((record) => record.seq < read.read.seq)),
      originals,
    );
    assert.equal(
      x.store.records(x.run.id).filter((record) => record.kind === 'criterion_review').length,
      0,
    );
    assert.equal(
      evaluateCriteria(x.store.records(x.run.id), x.run.id, { imageAvailable: () => true }).coverage
        .assessedChecks,
      0,
    );
  } finally {
    x.close();
  }
});

test('Unavailable optional criterion originals stay unassessed without displacing intact findings', () => {
  for (const damage of [
    'missing-source',
    'changed-source',
    'rewritten-source',
    'unstable-source',
    'missing-image',
    'changed-image',
    'rewritten-read',
  ] as const) {
    const x = fixture(2);
    try {
      const observation = x.store.append(
        x.run.id,
        'observation',
        'browser',
        { stable: true, method: 'controlled_context' },
        [x.captures[0].id],
      );
      const proposal = x.proposal(x.captures[0], [observation.id]);
      const candidate = x.candidate([x.captures[1].id]);
      const imagePath = join(x.store.dir, x.run.id, x.captures[0].payload.imageFile);
      if (damage === 'missing-image') rmSync(imagePath);
      if (damage === 'changed-image') writeFileSync(imagePath, 'Changed original image.');
      if (damage === 'missing-source')
        x.store.db.prepare('DELETE FROM records WHERE id=?').run(observation.id);
      if (['changed-source', 'rewritten-source', 'unstable-source'].includes(damage)) {
        const body = JSON.stringify({
          ...observation.payload,
          stable: damage !== 'unstable-source',
          changed: true,
        });
        x.store.db
          .prepare('UPDATE records SET body=?,hash=? WHERE id=?')
          .run(
            body,
            damage === 'rewritten-source' ? digest(body) : observation.hash,
            observation.id,
          );
      }
      if (damage === 'rewritten-read') {
        const read = x.store.record(x.run.id, proposal.payload.readSnapshotId)!;
        const body = JSON.stringify({
          ...read.payload,
          records: read.payload.records.filter((pin: any) => pin.id !== observation.id),
        });
        x.store.db
          .prepare('UPDATE records SET body=?,hash=? WHERE id=?')
          .run(body, digest(body), read.id);
      }
      const read = requestEvidence(x.store, x.run.id, 'reviewer', x.captures[1]);
      assert(
        read.records.some((record) => record.id === candidate.id),
        damage,
      );
      assert(!read.records.some((record) => record.id === proposal.id), damage);
      assert(
        !read.read.payload.imageReceipt.supplied.some(
          (pin: any) => pin.captureId === x.captures[0].id,
        ),
        damage,
      );
      assert(
        read.records.some(
          (record) =>
            record.kind === 'limit' &&
            record.payload.method === 'criterion_review_selection' &&
            record.payload.proposalId === proposal.id &&
            record.payload.proposalHash === proposal.hash &&
            /missing, changed or unstable/.test(record.payload.reason),
        ),
        damage,
      );
      assert.equal(
        x.store.records(x.run.id).filter((record) => record.kind === 'criterion_review').length,
        0,
        damage,
      );
      assert.equal(
        evaluateCriteria(x.store.records(x.run.id), x.run.id, { imageAvailable: () => true })
          .coverage.assessedChecks,
        0,
        damage,
      );
    } finally {
      x.close();
    }
  }
});

test('Restoring the exact optional image restores proposal selection without rewriting any original', () => {
  const x = fixture(2);
  try {
    const proposal = x.proposal(x.captures[0]);
    const imagePath = join(x.store.dir, x.run.id, x.captures[0].payload.imageFile);
    const original = readFileSync(imagePath);
    const originalProposal = JSON.stringify(proposal);
    rmSync(imagePath);
    const absent = requestEvidence(x.store, x.run.id, 'reviewer', x.captures[1]);
    assert(!absent.records.some((record) => record.id === proposal.id));
    writeFileSync(imagePath, original);
    const restored = requestEvidence(x.store, x.run.id, 'reviewer', x.captures[1]);
    assert(restored.records.some((record) => record.id === proposal.id));
    assert.equal(JSON.stringify(x.store.record(x.run.id, proposal.id)), originalProposal);
    assert.equal(
      x.store.records(x.run.id).filter((record) => record.kind === 'criterion_review').length,
      0,
    );
  } finally {
    x.close();
  }
});

// Loca and Codex, PR 71: an unlimited list could outgrow the reviewer's answer space and its
// answer format, losing the whole paid review. Each review judges one batch, oldest first.
test('One review judges at most one batch of owed proposals, oldest first', () => {
  const x = fixture(5);
  try {
    const read = x.store.snapshot(x.run.id, 'analyst').read;
    const owed = x.captures.flatMap((capture, i) =>
      CRITERIA.map((criterion) =>
        x.store.append(
          x.run.id,
          'criterion_proposal',
          'analyst',
          {
            version: CRITERIA_VERSION,
            scopeId: x.scopes[i]!.id,
            checkId: `${capture.id}:${criterion.id}`,
            criterionId: criterion.id,
            verdict: 'NOT_APPLICABLE',
            reason: 'Controlled proposal, pending independent review.',
            sources: [capture.id],
            missingEvidence: [],
            screenReaderClaimed: false,
            readSnapshotId: read.id,
          },
          [x.scopes[i]!.id, capture.id],
        ),
      ),
    );
    assert.equal(owed.length, 75);
    const picked = () =>
      requestEvidence(x.store, x.run.id, 'reviewer', x.captures[0]!)
        .records.filter((record) => record.kind === 'criterion_proposal')
        .map((record) => record.id);
    assert.deepEqual(picked().sort(), owed.slice(0, CRITERION_REVIEW_BATCH).map((p) => p.id).sort());
    picked();
    const waiting = x.store
      .records(x.run.id)
      .filter((r) => r.kind === 'limit' && /stays owed for a later review/.test(r.payload.reason));
    assert.deepEqual(
      waiting.map((r) => r.payload.proposalId).sort(),
      owed.slice(CRITERION_REVIEW_BATCH).map((p) => p.id).sort(),
      'each waiting proposal is noted once per checkpoint',
    );
  } finally {
    x.close();
  }
});

test('The answer format and answer space fit exactly one review batch', () => {
  const decision = {
    proposalId: 'p',
    proposalHash: 'a'.repeat(64),
    verdict: 'keep',
    premise: 'supported',
    reason: 'Supported by the original.',
    sources: ['c'],
  };
  const answer = (n: number) => ({ decisions: [], criterionDecisions: Array(n).fill(decision) });
  assert(reviewSchema.safeParse(answer(CRITERION_REVIEW_BATCH)).success);
  assert(!reviewSchema.safeParse(answer(CRITERION_REVIEW_BATCH + 1)).success);
  // About 200 answer tokens per decision, 250 per finding decision and room for its thinking.
  assert(CRITERION_REVIEW_BATCH * 200 + MAX_FINDINGS * 250 + 12_000 <= CAPS.reviewer.output);
});

// Loca, PR 71: a supplied proposal the reviewer did not answer left no trace.
test('A supplied proposal the reviewer does not answer is noted and offered again', async () => {
  const x = fixture(2);
  try {
    const [answered, skipped] = [x.proposal(x.captures[0]!), x.proposal(x.captures[1]!)];
    const models = {
      async reason() {
        return {
          decisions: [],
          criterionDecisions: [
            {
              proposalId: answered.id,
              proposalHash: answered.hash,
              verdict: 'unresolved',
              premise: 'unverified',
              reason: 'Controlled response; no model judgement is claimed.',
              sources: [x.captures[0]!.id],
            },
          ],
        };
      },
    };
    const walk = {
      images: (records: RecordEntry[]) =>
        records.map((record) => ({
          captureId: record.id,
          image:
            'data:image/png;base64,' +
            x.store.image(x.run.id, record.payload.imageFile).toString('base64'),
        })),
    };
    await (new Runner(x.store, 'http://127.0.0.1:4317') as any).review(
      models,
      x.run,
      x.captures[1],
      walk,
      new AbortController().signal,
      false,
    );
    const records = x.store.records(x.run.id);
    assert.equal(records.filter((r) => r.kind === 'criterion_review').length, 1);
    const missing = records.filter((r) => r.payload?.method === 'criterion_review_missing');
    assert.deepEqual(
      missing.map((r) => r.payload.proposalId),
      [skipped.id],
    );
    const again = requestEvidence(x.store, x.run.id, 'reviewer', x.captures[1]!);
    assert(again.records.some((r) => r.id === skipped.id), 'it is offered again');
    assert(!again.records.some((r) => r.id === answered.id), 'the judged one is not');
  } finally {
    x.close();
  }
});
