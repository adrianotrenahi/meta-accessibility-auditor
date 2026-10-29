import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Runner } from '../src/runner.js';
import {
  assessmentForRun,
  declareCriterionScopes,
  finalCriteriaReport,
  recordAnalysisDetails,
  visualCandidateSources,
} from '../src/assessment.js';
import { CRITERIA_VERSION } from '../src/criteria.js';
import { VISUAL_TOPICS } from '../src/visual-inspection.js';
import { startServer } from '../server/index.js';
import { exportHostSnapshot } from '../src/host-export.js';
import { MetaModels, analysisSchema, reviewSchema } from '../src/models.js';
import { digest } from '../src/store.js';
import type { CriteriaReport } from '../src/criteria.js';
import { requestEvidence } from '../src/request-evidence.js';

test('Provisional or partial run counts never become an overall score before final completion', () => {
  const computed = {
    score: 75,
    limits: [],
    coverage: { complete: true },
  } as unknown as CriteriaReport;
  for (const state of ['running', 'partial', 'stopped', 'interrupted'] as const) {
    const projected = finalCriteriaReport(computed, state);
    assert.equal(projected.score, null);
    assert(projected.limits.some((l) => /completed run/.test(l)));
    assert.equal(
      projected.coverage.complete,
      true,
      'Provisional coverage is retained as counts, not rewritten.',
    );
  }
  assert.equal(finalCriteriaReport(computed, 'complete').score, 75);
  assert.equal(computed.score, 75);
  assert.deepEqual(computed.limits, []);
});

test('The existing model adapter serializes Day 3 schemas and records the instructions actually sent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'access-walk-day-three-model-contract-'));
  const store = new Store(dir);
  try {
    const x = setup(store);
    const sent: any[] = [];
    const model = new MetaModels(
      store,
      (async (url, init) => {
        const body = JSON.parse(String(init?.body));
        if (String(url).endsWith('/input_tokens'))
          return new Response(JSON.stringify({ input_tokens: 10 }));
        sent.push(body);
        return new Response(
          JSON.stringify({
            status: 'completed',
            usage: { input_tokens: 10, output_tokens: 10 },
            output: [
              {
                type: 'message',
                content: [
                  {
                    type: 'output_text',
                    text: JSON.stringify(
                      sent.length === 1 ? { findings: [], coverage: [] } : { decisions: [] },
                    ),
                  },
                ],
              },
            ],
          }),
        );
      }) as typeof fetch,
      () => ({
        approvedBy: 'Adriano',
        maxUsd: 3,
        maxRunUsd: 3,
        approvedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      }),
      () => 'synthetic-test-key',
    );
    const analysis = await model.reason(x.run.id, 'analyst', [], [], analysisSchema);
    const review = await model.reason(x.run.id, 'reviewer', [], [], reviewSchema);
    assert.deepEqual(analysis.criterionProposals, []);
    assert.deepEqual(analysis.missingEvidence, []);
    assert.deepEqual(review.criterionDecisions, []);
    for (const request of sent) {
      assert.equal(request.model, 'muse-spark-1.3');
      assert.equal(request.max_output_tokens, 8192);
      assert(request.instructions.includes(CRITERIA_VERSION));
      assert(request.instructions.includes('screenReaderClaimed'));
      assert.equal(request.tools, undefined);
      assert.equal(request.text.format.type, 'json_schema');
      assert.equal(request.text.format.schema.type, 'object');
      assert(!request.instructions.includes('Use return_result.'));
      assert(request.instructions.includes('without progress messages'));
    }
    assert.equal(sent[0].reasoning.effort, 'low');
    assert.equal(sent[1].reasoning.effort, 'medium');
    const responses = store.records(x.run.id).filter((r) => r.kind === 'model_response');
    assert.deepEqual(
      responses.map((r) => r.payload.instructionHash),
      sent.map((r) => digest(r.instructions)),
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

function setup(store: Store, url = 'http://127.0.0.1:4317/shop/') {
  const run = store.create('Synthetic pipeline contract proof', url, 'offline');
  const image = store.asset(run.id, 'capture_test.png', Buffer.from('unit fixture image bytes'));
  const capture = store.append(run.id, 'capture', 'browser', {
    stable: true,
    url,
    title: 'Controlled product',
    width: 1440,
    height: 900,
    imageFile: image.file,
    imageHash: image.hash,
    stateStamp: 'a'.repeat(64),
    aria: 'button',
    text: 'Canvas bag £45 +',
    elements: [
      {
        id: 'e0',
        selector: '#add',
        contextFingerprint: 'b'.repeat(64),
        tag: 'button',
        role: 'button',
        name: '',
        text: '+',
        type: '',
        disabled: false,
        box: { x: 10, y: 10, width: 40, height: 40 },
      },
    ],
    focus: { tag: 'body', name: '', text: '' },
    limits: {
      imageScope: 'viewport',
      visibleTextTruncated: false,
      totalControls: 1,
      maximumListedControls: 60,
    },
    imageProvenance: { source: 'Browser-rendered page viewport', engineAddedAnnotations: false },
  });
  const observation = store.append(
    run.id,
    'observation',
    'browser',
    {
      method: 'automatic_accessibility_scan',
      stable: true,
      sourceCaptureId: capture.id,
      sourceCaptureHash: capture.hash,
      sourceImageHash: image.hash,
      facts: {
        schema: 'access-walk/facts-v1',
        captureId: capture.id,
        imageHash: image.hash,
        url,
        scope: { controlsIncomplete: false, controlsTruncated: false },
        controls: [{ elementId: 'e0', selector: '#add', role: 'button', name: '', text: '+' }],
      },
    },
    [capture.id],
  );
  return { run, capture, observation };
}

test('The pipeline reviews an unscored visual claim and a separate criterion without inventing overall coverage', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'access-walk-day-three-'));
  const store = new Store(dir);
  try {
    const x = setup(store);
    const roles: string[] = [];
    const premise =
      'The add control uses a plus sign; the product name and price are visible nearby.';
    const models = {
      reason: async (_run: string, role: string, records: any[]) => {
        roles.push(role);
        if (role === 'analyst') {
          const scope = records.find(
            (r) => r.kind === 'criterion_scope' && r.payload.captureId === x.capture.id,
          );
          assert(scope, 'The owed checks must exist before the analyst read.');
          return {
            coverage: VISUAL_TOPICS.map((topic) => ({
              captureId: x.capture.id,
              topic,
              state: 'examined',
              reason: 'Synthetic fixture response with the exact supplied viewport.',
              sources: [x.capture.id, x.observation.id],
            })),
            visualObservations: [
              {
                captureId: x.capture.id,
                topic: 'affordances',
                visiblePremise: premise,
                interpretation: 'A written action label could clarify the meaning of this icon.',
                taskConcern: 'The task is to add this product.',
                recommendation: 'Consider visible Add to basket wording.',
                limits: ['Synthetic saved response, not a user study.'],
                sources: [x.capture.id],
              },
            ],
            findings: [
              {
                issueKey: 'icon_action_ambiguity',
                scope: 'view',
                visiblePremise: premise,
                title: 'The plus icon could explain its action more clearly',
                detail: 'Expert visual concern; surrounding product context is present.',
                criterion: null,
                visualTopic: 'affordances',
                visualObservationIndex: 0,
                basis: 'expert_visual',
                severity: 'minor',
                sources: [x.capture.id],
                targetCaptureId: null,
                targetId: null,
                recommendation: 'Consider visible Add to basket wording.',
              },
            ],
            criterionProposals: [
              {
                captureId: x.capture.id,
                criterionId: 'C02',
                verdict: 'FAIL',
                reason: 'The original browser fact exposes an empty button name.',
                sources: [x.capture.id, x.observation.id],
                missingEvidence: [],
              },
            ],
            missingEvidence: [],
          };
        }
        assert.equal(role, 'reviewer');
        const candidate = records.find((r) => r.kind === 'candidate');
        const proposal = records.find((r) => r.kind === 'criterion_proposal');
        assert(
          records.some((r) => r.kind === 'visual_observation'),
          'The reviewer reads the exact analyst interpretation alongside originals.',
        );
        assert(
          !records.some((r) => r.kind === 'visual_coverage'),
          'Coverage interpretations cannot become original factual evidence.',
        );
        return {
          decisions: [
            {
              candidateId: candidate.id,
              candidateHash: candidate.hash,
              verdict: 'keep',
              premise: 'supported',
              title: candidate.payload.title,
              reason: 'Saved review supports this bounded visual interpretation.',
              sources: [x.capture.id],
            },
          ],
          criterionDecisions: [
            {
              proposalId: proposal.id,
              proposalHash: proposal.hash,
              verdict: 'keep',
              premise: 'supported',
              reason: 'The exact empty-name observation supports this scoped result.',
              sources: [x.capture.id, x.observation.id],
            },
          ],
        };
      },
    };
    const walk = {
      images: (records: any[]) =>
        records
          .filter((r) => r.kind === 'capture')
          .map((r) => ({ captureId: r.id, image: 'data:image/png;base64,dGVzdA==' })),
    };
    const runner = new Runner(store, 'http://127.0.0.1:4317');
    await (runner as any).analyse(models, x.run, x.capture, walk, new AbortController().signal);
    assert.deepEqual(roles, ['analyst', 'reviewer']);
    const findings = store.published(x.run.id);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].criterion, null);
    assert.equal(findings[0].basis, 'expert_visual');
    const before = JSON.stringify(store.records(x.run.id));
    const report = assessmentForRun(store, x.run.id);
    assert.equal(report.criteria.results.length, 15);
    assert.equal(report.criteria.results.find((r) => r.id === 'C02')?.verdict, 'FAIL');
    assert.equal(report.criteria.counts.FAIL, 1);
    assert.equal(report.criteria.score, null);
    assert.equal(report.visualCoverage.length, 6);
    assert(report.visualCoverage.every((r: any) => r.state === 'examined'));
    assert.equal(
      JSON.stringify(store.records(x.run.id)),
      before,
      'Reading the assessment performs no work or evidence writes.',
    );
    assert.equal(store.usage(x.run.id).requests.length, 0);
    const changedBody = JSON.stringify({ ...x.observation.payload, changedAfterAnalysis: true });
    store.db
      .prepare('UPDATE records SET body=?,hash=? WHERE id=?')
      .run(changedBody, digest(changedBody), x.observation.id);
    assert(
      assessmentForRun(store, x.run.id).visualCoverage.every(
        (r: any) => r.state === 'not_assessed',
      ),
      'A changed cited observation must not inherit the older analyst examination even with a new valid body fingerprint.',
    );
    store.db
      .prepare('UPDATE records SET body=?,hash=? WHERE id=?')
      .run(JSON.stringify(x.observation.payload), x.observation.hash, x.observation.id);
    writeFileSync(join(dir, x.run.id, x.capture.payload.imageFile), 'changed image bytes');
    const damaged = assessmentForRun(store, x.run.id);
    assert.equal(damaged.criteria.score, null);
    assert(damaged.visualCoverage.every((r: any) => r.state === 'not_assessed'));
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Offline criterion-only review keeps the original scope after recapture and survives reopening', async () => {
  for (const outcome of ['keep', 'unresolved', 'empty'] as const) {
    const dir = mkdtempSync(join(tmpdir(), 'access-walk-criterion-recapture-'));
    let store = new Store(dir);
    try {
      const x = setup(store);
      declareCriterionScopes(store, x.run.id);
      const analyst = requestEvidence(store, x.run.id, 'analyst', x.capture);
      recordAnalysisDetails(store, x.run.id, analyst, [x.capture.id], {
        criterionProposals: [
          {
            captureId: x.capture.id,
            criterionId: 'C02',
            verdict: 'FAIL',
            reason: 'Offline control: the original browser measurement exposes an empty name.',
            sources: [x.capture.id, x.observation.id],
            missingEvidence: [],
            screenReaderClaimed: false,
          },
        ],
      });
      const proposal = store
        .records(x.run.id)
        .find((record) => record.kind === 'criterion_proposal')!;
      assert(proposal);
      const image = store.asset(
        x.run.id,
        'capture_after.png',
        store.image(x.run.id, x.capture.payload.imageFile),
      );
      const after = store.append(x.run.id, 'capture', 'browser', {
        ...x.capture.payload,
        imageFile: image.file,
        imageHash: image.hash,
      });
      declareCriterionScopes(store, x.run.id);
      const originalRows = store.records(x.run.id);
      assert.equal(assessmentForRun(store, x.run.id).criteria.coverage.assessedChecks, 0);
      let calls = 0;
      const models = {
        async reason(_runId: string, role: string, records: any[], images: any[]) {
          calls++;
          assert.equal(role, 'reviewer');
          for (const source of [proposal, x.capture, x.observation, after])
            assert(
              records.some((record) => record.id === source.id && record.hash === source.hash),
            );
          assert.deepEqual(
            images.map((image) => image.captureId).sort(),
            [x.capture.id, after.id].sort(),
          );
          return {
            decisions: [],
            criterionDecisions:
              outcome === 'empty'
                ? []
                : [
                    {
                      proposalId: proposal.id,
                      proposalHash: proposal.hash,
                      verdict: outcome,
                      premise: outcome === 'keep' ? 'supported' : 'unverified',
                      reason: 'Offline controlled response; no actual model judgement is claimed.',
                      sources: [x.capture.id, x.observation.id],
                    },
                  ],
          };
        },
      };
      const walk = {
        images: (records: any[]) =>
          records.map((record) => ({
            captureId: record.id,
            image:
              'data:image/png;base64,' +
              store.image(x.run.id, record.payload.imageFile).toString('base64'),
          })),
      };
      await (new Runner(store, 'http://127.0.0.1:4317') as any).review(
        models,
        x.run,
        after,
        walk,
        new AbortController().signal,
        false,
      );
      assert.equal(calls, 1);
      assert.deepEqual(
        store.records(x.run.id).filter((record) => record.seq <= originalRows.at(-1)!.seq),
        originalRows,
      );
      store.finish(x.run.id, 'partial', 'Offline saved-response control.');
      const report = assessmentForRun(store, x.run.id);
      assert.equal(report.criteria.coverage.assessedChecks, outcome === 'keep' ? 1 : 0);
      assert.equal(report.criteria.coverage.remainingChecks, outcome === 'keep' ? 29 : 30);
      assert.equal(report.criteria.score, null);
      const naming = report.criteria.results.find((result) => result.id === 'C02')!;
      assert.equal(
        naming.checks.find((check) => check.captureId === x.capture.id)?.complete,
        outcome === 'keep',
      );
      assert.equal(naming.checks.find((check) => check.captureId === after.id)?.complete, false);
      assert.equal(store.records(x.run.id).filter((record) => record.kind === 'action').length, 0);
      assert.equal(store.usage(x.run.id).requests.length, 0);
      const saved = JSON.stringify(store.records(x.run.id));
      store.close();
      store = new Store(dir);
      assert.deepEqual(assessmentForRun(store, x.run.id), report);
      assert.equal(JSON.stringify(store.records(x.run.id)), saved);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('Mixed visual claims require their exact topic and observation rather than bypassing the visual binding', () => {
  assert.throws(
    () =>
      visualCandidateSources(
        {
          basis: 'mixed',
          visualTopic: null,
          visualObservationIndex: null,
          visiblePremise: 'A bounded observation',
          sources: ['original'],
        },
        new Map(),
      ),
    /exact visual observation/,
  );
});

test('Legitimate related-view coverage retains both supplied originals, while unreadable newer coverage cannot revive older examinations', () => {
  const dir = mkdtempSync(join(tmpdir(), 'access-walk-visual-projection-'));
  const store = new Store(dir);
  try {
    const x = setup(store);
    const another = store.append(x.run.id, 'capture', 'browser', {
      ...x.capture.payload,
      title: 'Related original',
    });
    declareCriterionScopes(store, x.run.id);
    const read = store.snapshot(x.run.id, 'analyst');
    recordAnalysisDetails(store, x.run.id, read, [x.capture.id, another.id], {
      coverage: [
        {
          captureId: x.capture.id,
          topic: 'consistency_imagery',
          state: 'examined',
          reason: 'Both original views were supplied for this saved coverage fixture.',
          sources: [x.capture.id, another.id],
        },
      ],
    });
    const first = assessmentForRun(store, x.run.id);
    assert.equal(
      (first.visualCoverage as any[]).find(
        (r) => r.captureId === x.capture.id && r.topic === 'consistency_imagery',
      ).state,
      'examined',
    );
    const damaged = store.append(
      x.run.id,
      'visual_coverage',
      'analyst',
      {
        captureId: x.capture.id,
        topic: 'content',
        state: 'examined',
        readSnapshotId: read.read.id,
        sources: [x.capture.id],
        suppliedImageCaptureIds: [x.capture.id],
        reason: 'A deliberately corrupted newer fixture row.',
      },
      [x.capture.id],
    );
    store.db
      .prepare('UPDATE records SET body=?,hash=? WHERE id=?')
      .run('null', digest('null'), damaged.id);
    const unknown = assessmentForRun(store, x.run.id);
    assert(unknown.visualCoverage.every((r: any) => r.state === 'not_assessed'));
    assert.equal(unknown.visualLimits.length, 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Every new captured state declares its own checks without duplicating scopes or writing during report reads', () => {
  const dir = mkdtempSync(join(tmpdir(), 'access-walk-day-three-scope-'));
  const store = new Store(dir);
  try {
    const x = setup(store);
    declareCriterionScopes(store, x.run.id);
    declareCriterionScopes(store, x.run.id);
    assert.equal(store.records(x.run.id).filter((r) => r.kind === 'criterion_scope').length, 1);
    const first = assessmentForRun(store, x.run.id);
    assert.equal(first.criteria.coverage.requiredChecks, 15);
    store.append(x.run.id, 'capture', 'browser', {
      ...x.capture.payload,
      title: 'Another observed state',
    });
    declareCriterionScopes(store, x.run.id);
    const before = JSON.stringify(store.records(x.run.id));
    const second = assessmentForRun(store, x.run.id);
    assert.equal(second.criteria.coverage.requiredChecks, 30);
    assert.equal(second.criteria.score, null);
    assert.equal(second.criteria.counts.NOT_TESTED, 15);
    assert.equal(JSON.stringify(store.records(x.run.id)), before);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('The optional host assessment honours existing session access and leaves host-v1 coverage unchanged', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'access-walk-day-three-api-'));
  const app = await startServer(0, dir, false);
  try {
    const x = setup(app.store, app.origin + '/shop/');
    declareCriterionScopes(app.store, x.run.id);
    const baseline = JSON.stringify(app.store.records(x.run.id));
    const path = `${app.origin}/api/host/runs/${x.run.id}/assessment`;
    assert.equal((await fetch(path)).status, 403);
    const response = await fetch(path, { headers: { 'X-Session-Token': app.token } });
    assert.equal(response.status, 200);
    const report = await response.json();
    assert.equal(report.protocol, 'access-walk/assessment-v1');
    assert.equal(report.criteria.results.length, 15);
    assert.equal(report.criteria.score, null);
    assert.equal(JSON.stringify(app.store.records(x.run.id)), baseline);
    const host = exportHostSnapshot(app.store, x.run.id);
    assert.equal(host.snapshot.protocol, 'access-walk/host-v1');
    assert.equal(host.snapshot.coverage.score, null);
    assert.equal(app.store.usage(x.run.id).requests.length, 0);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
