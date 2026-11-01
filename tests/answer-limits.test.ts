import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { MAX_FINDINGS } from '../src/types.js';
import { MetaModels, analysisSchema, keepWhatFits, reviewSchema } from '../src/models.js';

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
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
