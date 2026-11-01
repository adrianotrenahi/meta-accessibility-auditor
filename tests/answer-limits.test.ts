import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { MAX_FINDINGS } from '../src/types.js';
import {
  MetaModels,
  NAVIGATOR_NOTE_LIMIT,
  analysisSchema,
  keepWhatFits,
  navigationActionSchema,
  reviewSchema,
} from '../src/models.js';

// Owner, 1 Nov: "Why are we limiting the amount of findings?" — "OK do 2": up to 25 findings per
// look, and an answer over a limit keeps what fits instead of being thrown away.
const finding = (i: number) => ({
  issueKey: `issue_${i}`,
  scope: 'view',
  visiblePremise: 'A controlled visible premise.',
  title: `Controlled finding ${i}`,
  detail: '',
  criterion: null,
  basis: 'measured',
  severity: 'minor',
  sources: ['c1'],
  targetCaptureId: null,
  targetId: null,
  recommendation: '',
});
const decision = (i: number) => ({
  candidateId: `f${i}`,
  candidateHash: 'a'.repeat(64),
  verdict: 'keep',
  premise: 'supported',
  title: `Controlled finding ${i}`,
  reason: 'Supported by the original.',
  sources: ['c1'],
});

test('Each look may propose up to 25 findings and a review may judge up to 25', () => {
  assert.equal(MAX_FINDINGS, 25);
  const findings = (n: number) => ({ findings: Array.from({ length: n }, (_, i) => finding(i)) });
  assert(analysisSchema.safeParse(findings(25)).success);
  assert(!analysisSchema.safeParse(findings(26)).success, 'the format itself still has an end');
  const decisions = (n: number) => ({ decisions: Array.from({ length: n }, (_, i) => decision(i)) });
  assert(reviewSchema.safeParse(decisions(25)).success);
  assert(!reviewSchema.safeParse(decisions(26)).success);
});

test('An over-long list keeps its first items and says what was left out', () => {
  const answer = { findings: Array.from({ length: 30 }, (_, i) => finding(i)), coverage: [] };
  const kept = keepWhatFits('analyst', answer);
  assert.deepEqual(kept.trimmed, [{ list: 'findings', returned: 30, kept: 25 }]);
  assert.deepEqual((kept.answer as any).findings, answer.findings.slice(0, 25));
  assert.equal(answer.findings.length, 30, 'the original answer is not changed');
  const review = keepWhatFits('reviewer', { decisions: Array.from({ length: 27 }, (_, i) => decision(i)) });
  assert.deepEqual(review.trimmed, [{ list: 'decisions', returned: 27, kept: 25 }]);
  // Within limits, or not a list at all, nothing changes.
  assert.deepEqual(keepWhatFits('analyst', { findings: [finding(1)] }).trimmed, []);
  assert.deepEqual(keepWhatFits('driver', { kind: 'press' }).trimmed, []);
  assert.equal(keepWhatFits('analyst', null).answer, null);
});

test('A paid analyst answer with 30 findings keeps 25 instead of being lost', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'answer-limits-'));
  const store = new Store(dir);
  const run = store.create('Answer limits', 'http://127.0.0.1:4317/shop/', 'offline');
  const result = { findings: Array.from({ length: 30 }, (_, i) => finding(i)) };
  const models = new MetaModels(
    store,
    (async (url: unknown) =>
      Response.json(
        String(url).endsWith('/input_tokens')
          ? { input_tokens: 1000 }
          : {
              status: 'completed',
              usage: { input_tokens: 1000, output_tokens: 20 },
              output: [
                {
                  type: 'message',
                  role: 'assistant',
                  content: [{ type: 'output_text', text: JSON.stringify(result) }],
                },
              ],
            },
      )) as typeof fetch,
    () => ({
      approvedBy: 'Adriano',
      maxUsd: 10,
      maxRunUsd: 3,
      approvedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
    () => 'mock-key-no-provider-access',
  );
  try {
    const analysis = await models.reason(run.id, 'analyst', [], [], analysisSchema);
    assert.equal(analysis.findings.length, 25);
    assert.equal(store.usage(run.id).requests[0]!.status, 'completed');
    const note = store.records(run.id).find((r) => r.payload?.method === 'answer_list_trimmed');
    assert.equal(note?.payload.returned, 30);
    assert.equal(note?.payload.kept, 25);
    // Loca, PR 72: an answer refused after shortening leaves no "were kept" note behind.
    result.findings[3] = { ...finding(3), severity: 'unknown' } as any;
    await assert.rejects(models.reason(run.id, 'analyst', [], [], analysisSchema));
    assert.equal(
      store.records(run.id).filter((r) => r.payload?.method === 'answer_list_trimmed').length,
      1,
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// Codex, PR 72: trimming extra-test requests before their own cleaning dropped a valid one.
test('Extra-test requests are cleaned before being limited, so a valid one is never dropped', () => {
  const request = (fields: Record<string, unknown>) => ({
    captureId: 'c1',
    criterionId: null,
    reason: 'Check the focused search control.',
    ...fields,
  });
  const kept = keepWhatFits('analyst', {
    findings: [],
    missingEvidence: [
      request({ method: 'keyboard_activation', targetName: 'Search Flights' }),
      request({ method: 'keyboard_activation', activationKey: 'Enter', targetName: 'Search' }),
      request({ method: 'measurement' }),
    ],
  });
  assert.deepEqual(kept.trimmed, []);
  assert.deepEqual(
    analysisSchema.parse(kept.answer).missingEvidence.map((r) => r.method),
    ['keyboard_activation', 'measurement'],
  );
});

test('A finding that points past the allowed visual notes is left out, not the whole answer', () => {
  const answer = {
    findings: [finding(0), { ...finding(1), visualObservationIndex: 13 }, finding(2)],
  };
  const kept = keepWhatFits('analyst', answer);
  assert.deepEqual(kept.trimmed, [{ list: 'findings', returned: 3, kept: 2 }]);
  assert.deepEqual(
    analysisSchema.parse(kept.answer).findings.map((f) => f.issueKey),
    ['issue_0', 'issue_2'],
  );
  assert(!analysisSchema.safeParse(answer).success, 'without it the whole answer was refused');
});

// Loca, PR 77: the navigator's notes now quote the site and say where focus was, so one can run
// past its limit. Its start is kept and marked as cut, instead of the paid decision being refused.
test('An over-long navigator note keeps its start, marked as cut, and the move still counts', async () => {
  const long = 'Saw: ' + 'the error reads "Something went wrong" under the Search button; '.repeat(12);
  assert(long.length > NAVIGATOR_NOTE_LIMIT);
  const kept = keepWhatFits('driver', { kind: 'press', key: 'Tab', note: long });
  const note = (kept.answer as any).note as string;
  assert(note.length <= NAVIGATOR_NOTE_LIMIT);
  assert(note.endsWith('[note cut]'));
  assert(long.startsWith(note.slice(0, 200)), 'the start of the note is kept');
  assert.deepEqual(kept.trimmed, [
    { list: 'note', returned: long.length, kept: NAVIGATOR_NOTE_LIMIT },
  ]);
  assert(navigationActionSchema.safeParse(kept.answer).success);
  // A note within the limit is left exactly as written.
  const short = keepWhatFits('driver', { kind: 'press', key: 'Tab', note: 'x'.repeat(500) });
  assert.equal((short.answer as any).note, 'x'.repeat(500));
  assert.deepEqual(short.trimmed, []);

  const dir = mkdtempSync(join(tmpdir(), 'answer-limits-note-'));
  const store = new Store(dir);
  const run = store.create('Note limit', 'http://127.0.0.1:4317/shop/', 'offline');
  const models = new MetaModels(
    store,
    (async (url: unknown) =>
      Response.json(
        String(url).endsWith('/input_tokens')
          ? { input_tokens: 1000 }
          : {
              status: 'completed',
              usage: { input_tokens: 1000, output_tokens: 20 },
              output: [
                {
                  type: 'function_call',
                  name: 'return_result',
                  arguments: JSON.stringify({ kind: 'press', key: 'Tab', note: long }),
                },
              ],
            },
      )) as typeof fetch,
    () => ({
      approvedBy: 'Adriano',
      maxUsd: 10,
      maxRunUsd: 3,
      approvedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
    () => 'mock-key-no-provider-access',
  );
  try {
    const action = await models.reason(run.id, 'driver', [], [], navigationActionSchema);
    assert.equal(action.note, note);
    assert.equal(store.usage(run.id).requests[0]!.status, 'completed');
    const limit = store
      .records(run.id)
      .find((r) => r.payload?.method === 'navigator_note_trimmed');
    assert.equal(limit?.payload.returned, long.length);
    assert.match(limit?.payload.reason, /marked as cut/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
