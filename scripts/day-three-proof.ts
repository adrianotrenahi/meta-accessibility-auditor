import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import type { z } from 'zod';
import { startServer } from '../server/index.js';
import { BrowserWalk } from '../src/browser.js';
import type { MetaModels } from '../src/models.js';
import { digest, recordIsIntact } from '../src/store.js';
import { CRITERIA_VERSION } from '../src/criteria.js';
import { VISUAL_TOPICS } from '../src/visual-inspection.js';
import { hostSnapshotSchema } from '../src/host-contract.js';
import type { RecordEntry } from '../src/types.js';

// This is a controlled integration fixture. It uses saved synthetic interpretations,
// actual Chromium measurements and one actual Tab input, never provider inference.
const out = 'output/day-three-proof';
mkdirSync(out, { recursive: true });
const dir = mkdtempSync(join(tmpdir(), 'access-walk-day-three-'));
const sourceFiles = [
  'scripts/day-three-proof.ts',
  'src/runner.ts',
  'src/models.ts',
  'src/assessment.ts',
  'src/criteria.ts',
  'src/evidence-checks.ts',
  'src/focused-checks.ts',
  'src/browser.ts',
  'src/visual-inspection.ts',
  'src/store.ts',
  'src/request-evidence.ts',
  'server/index.ts',
  'server/host.ts',
  'client/main.tsx',
  'client/styles.css',
];
const sourceHashes = Object.fromEntries(
  sourceFiles.map((file) => [file, digest(readFileSync(file))]),
);
const app = await startServer(0, dir, true);
const originalFetch = globalThis.fetch;
const remoteRequests: string[] = [];
globalThis.fetch = async (input, options) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (new URL(url).origin !== app.origin) {
    remoteRequests.push(new URL(url).origin);
    throw Error('This zero-credit proof forbids remote provider or production requests.');
  }
  return originalFetch(input, options);
};
const walks: BrowserWalk[] = [];
const savedRoleCalls: { runId: string; role: string }[] = [];
const cases: any[] = [];
const get = async (path: string, token?: string) => {
  const response = await fetch(
    app.origin + path,
    token ? { headers: { 'x-session-token': token } } : undefined,
  );
  return { status: response.status, body: await response.json() };
};
const premise =
  'A plus glyph is shown beside the visible Canvas day bag name, description and price.';
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  for (const broken of [true, false]) {
    const run = app.store.create(
      'Saved Day 3 integration example; no model-quality claim',
      app.origin + '/shop/' + (broken ? '?case=broken' : ''),
      'offline',
    );
    app.store.append(run.id, 'plan', 'saved-proof', {
      method: 'controlled_saved_response_integration',
      criterionVersion: CRITERIA_VERSION,
      source: 'Saved synthetic analyst/reviewer answers; no model provider called.',
      nativeReader: 'NOT_TESTED',
      sam: 'NOT_TESTED',
    });
    const walk = new BrowserWalk(app.store, run.id, app.origin, true, 'chromium');
    walks.push(walk);
    const original = await walk.start(run.url);
    const measured = await walk.measurements(original);
    assert.equal(measured.payload.stable, true);
    const add = measured.payload.facts.controls.find((control: any) => control.selector === '#add');
    assert(add);
    assert.equal(add.name === '', broken);
    app.store.append(
      run.id,
      'coverage',
      'browser',
      {
        method: 'real_VoiceOver',
        state: 'NOT_TESTED',
        reason:
          'Headless saved-response integration fixture; no native-reader commands were performed.',
      },
      [original.id],
    );
    const beforeActions = walk.actions;
    const models = {
      async reason(
        _runId: string,
        role: string,
        records: RecordEntry[],
        images: { captureId: string; image: string }[],
        schema: z.ZodType<any>,
      ) {
        savedRoleCalls.push({ runId: run.id, role });
        let answer: unknown;
        if (role === 'analyst') {
          const scope = records.find(
            (record) =>
              record.kind === 'criterion_scope' && record.payload.captureId === original.id,
          )!;
          assert(scope);
          assert(images.some((image) => image.captureId === original.id));
          answer = {
            findings: broken
              ? [
                  {
                    issueKey: 'explicit_visual_action_label',
                    scope: 'view',
                    visiblePremise: premise,
                    title: 'The plus control could use an explicit action label',
                    detail:
                      'The product name, description and price are visible. The plus glyph alone does not explicitly name the Add to basket action. This saved expert example makes no user-study, activation or spoken-output claim.',
                    criterion: null,
                    visualTopic: 'affordances',
                    visualObservationIndex: 0,
                    basis: 'expert_visual',
                    severity: 'minor',
                    sources: [original.id, measured.id],
                    targetCaptureId: null,
                    targetId: null,
                    recommendation: 'Use an explicit Add to basket label.',
                  },
                ]
              : [],
            coverage: images.flatMap((image) =>
              VISUAL_TOPICS.map((topic) => ({
                captureId: image.captureId,
                topic,
                state: 'examined',
                reason:
                  'Saved coverage fixture for the supplied original viewport; this is not a model accuracy or quality verdict.',
                sources: [image.captureId],
              })),
            ),
            visualObservations: broken
              ? [
                  {
                    captureId: original.id,
                    topic: 'affordances',
                    visiblePremise: premise,
                    interpretation:
                      'An explicit action label could make the intended Add to basket action clearer.',
                    taskConcern:
                      'The current glyph requires interpreting the intended product action.',
                    recommendation: 'Use an explicit Add to basket label.',
                    limits: [
                      'Saved synthetic expert interpretation for integration testing, not a measured usability outcome.',
                    ],
                    sources: [original.id],
                  },
                ]
              : [],
            criterionProposals: [
              {
                captureId: original.id,
                criterionId: 'C02',
                verdict: broken ? 'FAIL' : 'PASS',
                reason: broken
                  ? 'The actual browser exposes an empty name for the visible Add control.'
                  : 'The actual observed controls expose nonempty names and roles; meaning is accepted only by this saved review fixture.',
                sources: [original.id, measured.id],
                missingEvidence: [],
                screenReaderClaimed: false,
              },
            ],
            missingEvidence: broken
              ? [
                  {
                    method: 'keyboard_focus',
                    captureId: original.id,
                    criterionId: 'C06',
                    reason:
                      'Capture one actual bounded Tab stop; do not infer functional activation or spoken output.',
                  },
                ]
              : [],
          };
        } else {
          assert.equal(role, 'reviewer');
          const candidates = records.filter((record) => record.kind === 'candidate');
          const proposals = records.filter((record) => record.kind === 'criterion_proposal');
          answer = {
            decisions: candidates.map((candidate) => ({
              candidateId: candidate.id,
              candidateHash: candidate.hash,
              verdict: 'keep',
              premise: 'supported',
              title: candidate.payload.title,
              reason:
                'Saved exact-version review fixture, bounded to the original image and qualified visual interpretation.',
              sources: [original.id, measured.id],
            })),
            criterionDecisions: proposals.map((proposal) => ({
              proposalId: proposal.id,
              proposalHash: proposal.hash,
              verdict: 'keep',
              premise: 'supported',
              reason:
                'Saved review of the exact proposal and actual original browser name observations.',
              sources: [original.id, measured.id],
            })),
          };
        }
        const parsed = schema.parse(answer);
        app.store.append(run.id, 'model_response', role, {
          provenance: 'saved-response-proof',
          providerCalled: false,
          description:
            'Synthetic response validated against the normal role schema; not generated inference.',
          output: parsed,
        });
        return parsed;
      },
      async sam() {
        throw Error('No paid SAM request is allowed in this saved-response proof.');
      },
    } as unknown as MetaModels;
    const after = await (app.runner as any).analyse(
      models,
      run,
      original,
      walk,
      new AbortController().signal,
    );
    assert.equal(walk.actions - beforeActions, broken ? 1 : 0);
    assert.equal(after.id !== original.id, broken);
    const input = app.store.records(run.id).filter((record) => record.kind === 'action');
    assert.equal(input.length, broken ? 1 : 0);
    if (broken) {
      assert.equal(input[0].payload.action.key, 'Tab');
      assert.equal(input[0].payload.waitAfterMs, 180);
    }
    app.store.finish(
      run.id,
      'partial',
      'Saved integration proof finished; all other required criteria and native/SAM checks remain unassessed.',
    );
    const report = await get('/api/runs/' + run.id);
    assert.equal(report.status, 200);
    assert.equal(report.body.assessment.criteria.results.length, 15);
    assert.equal(report.body.score, null);
    assert.equal(report.body.assessment.criteria.score, null);
    const naming = report.body.assessment.criteria.results.find((row: any) => row.id === 'C02');
    assert.equal(naming.verdict, broken ? 'FAIL' : 'PASS');
    assert.equal(naming.coverageComplete, !broken);
    assert.equal(report.body.findings.length, broken ? 1 : 0);
    if (broken) {
      assert.equal(report.body.findings[0].criterion, null);
      assert.equal(report.body.findings[0].reviewProvenance, 'saved-example');
      assert.equal(report.body.findings[0].visualTopic, 'affordances');
      assert(report.body.findings[0].evidence.includes(original.id));
    }
    const visual = report.body.assessment.visualCoverage;
    assert.equal(visual.filter((row: any) => row.captureId === original.id).length, 6);
    assert(
      visual
        .filter((row: any) => row.captureId === original.id)
        .every((row: any) => row.state === 'examined'),
    );
    if (broken)
      assert(
        visual
          .filter((row: any) => row.captureId === after.id)
          .every((row: any) => row.state === 'not_assessed'),
      );
    assert(app.store.records(run.id).every(recordIsIntact));
    assert.equal(app.store.usage(run.id).requests.length, 0);
    cases.push({
      case: broken ? 'broken' : 'clean',
      runId: run.id,
      originalCaptureId: original.id,
      afterCaptureId: after.id,
      sourceImageFile: original.payload.imageFile,
      sourceImageHash: original.payload.imageHash,
      measurementId: measured.id,
      providerCalls: 0,
      actualTabInputs: input.length,
      naming,
      visualCoverage: visual,
      score: report.body.score,
      findingCount: report.body.findings.length,
      savedReasoningOnly: true,
      nativeReader: 'NOT_TESTED',
      sam: 'NOT_TESTED',
    });
    await walk.close();
  }
  const broken = cases[0],
    clean = cases[1];
  const before = app.store.runs().map((run) => ({
    id: run.id,
    records: app.store.records(run.id).length,
    digest: digest(JSON.stringify(app.store.records(run.id))),
  }));
  for (const entry of cases) {
    assert.equal((await get(`/api/host/runs/${entry.runId}/assessment`)).status, 403);
    assert.equal(
      (await get(`/api/host/runs/${entry.runId}/assessment`, 'foreign-session')).status,
      403,
    );
    const assessed = await get(`/api/host/runs/${entry.runId}/assessment`, app.token);
    assert.equal(assessed.status, 200);
    assert.equal(assessed.body.protocol, 'access-walk/assessment-v1');
    assert.equal(assessed.body.criteria.results.length, 15);
    assert.equal(assessed.body.criteria.score, null);
    const host = await get(`/api/host/runs/${entry.runId}`, app.token);
    assert.equal(host.status, 200);
    hostSnapshotSchema.parse(host.body.snapshot);
    assert.deepEqual(host.body.snapshot.coverage, {
      scope: 'limited',
      score: null,
      realVoiceOver: 'not-established',
      sam: 'not-established',
    });
    assert.equal(host.body.snapshot.findings.length, entry.findingCount);
  }
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  const page = await context.newPage();
  await context.route('**/*', async (route) => {
    if (new URL(route.request().url()).origin !== app.origin) {
      remoteRequests.push(new URL(route.request().url()).origin);
      await route.abort();
      return;
    }
    await route.continue();
  });
  const ui: any[] = [];
  for (const width of [1440, 320]) {
    await page.setViewportSize({ width, height: 1100 });
    await page.goto(app.origin);
    await page.locator(`[data-run-id="${broken.runId}"]`).click();
    await page.locator(`[data-report-run-id="${broken.runId}"]`).waitFor();
    await page
      .getByRole('heading', { name: 'The plus control could use an explicit action label' })
      .waitFor();
    await page.getByText('Unscored visual concern', { exact: false }).waitFor();
    await page.getByRole('button', { name: 'Show original captured page' }).click();
    assert.equal(await page.locator('select').inputValue(), broken.originalCaptureId);
    const src = await page.locator('.evidence img').getAttribute('src');
    assert(src?.endsWith('/' + broken.sourceImageFile));
    const pixels = await page.request.get(app.origin + src);
    assert.equal(digest(await pixels.body()), broken.sourceImageHash);
    for (const details of await page.locator('details').all())
      if (!(await details.getAttribute('open'))) {
        const open = await details.evaluate((element) => (element as HTMLDetailsElement).open);
        if (!open) await details.locator('summary').click();
      }
    const criteria = page
      .locator('details')
      .filter({ has: page.getByText('Read the fifteen criterion results', { exact: true }) });
    assert.equal(await criteria.locator('ol > li').count(), 15);
    const coverage = page
      .locator('details')
      .filter({ has: page.getByText('Read visual inspection coverage', { exact: true }) });
    assert.equal(await coverage.locator('ul > li').count(), 12);
    await page
      .getByText(
        'No overall score is shown before the run and its required reviewed checks are complete.',
        { exact: true },
      )
      .waitFor();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    assert.equal(overflow, false);
    const scan = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    const violations = scan.violations.map((row) => ({
      id: row.id,
      targets: row.nodes.map((node) => node.target),
    }));
    assert.deepEqual(violations, [], `Expanded proof must have no scan violations at ${width}px.`);
    await page.getByRole('button', { name: 'Show original captured page' }).click();
    await page.keyboard.press('Tab');
    const support = page.locator('.finding details');
    assert(
      await support.locator('summary').evaluate((element) => document.activeElement === element),
    );
    if (await support.evaluate((element) => (element as HTMLDetailsElement).open))
      await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    const panel = support.locator('pre').first();
    assert(await panel.evaluate((element) => document.activeElement === element));
    const ring = await panel.evaluate((element) => {
      const s = getComputedStyle(element);
      return {
        style: s.outlineStyle,
        width: parseFloat(s.outlineWidth),
        scrollHeight: element.scrollHeight,
        height: element.clientHeight,
        top: element.scrollTop,
      };
    });
    assert.equal(ring.style, 'solid');
    assert(ring.width >= 2);
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(100);
    const scrolled = await panel.evaluate((element) => element.scrollTop);
    assert(scrolled > ring.top, 'Keyboard must scroll the expanded evidence panel.');
    const screenshot = `${out}/expanded-${width}.png`;
    await page.screenshot({ path: screenshot, fullPage: true });
    const viewportScreenshot = `${out}/viewport-${width}.png`;
    await page.screenshot({ path: viewportScreenshot });
    ui.push({
      width,
      overflow,
      violations,
      criterionRows: 15,
      visualRows: 12,
      originalImageVerified: true,
      ring,
      scrolled,
      screenshot,
      viewportScreenshot,
    });
    await page.reload();
    await page.locator(`[data-run-id="${broken.runId}"]`).click();
    await page.locator(`[data-report-run-id="${broken.runId}"]`).waitFor();
  }
  await context.close();
  assert.equal(app.store.runs().length, 2);
  for (const saved of before) {
    assert.equal(app.store.records(saved.id).length, saved.records);
    assert.equal(digest(JSON.stringify(app.store.records(saved.id))), saved.digest);
  }
  assert.equal(app.store.usage().requests.length, 0);
  assert.deepEqual(remoteRequests, []);
  const report = {
    at: new Date().toISOString(),
    passed: true,
    sourceHashes,
    fixtureDir: dir,
    evidenceKind:
      'Actual browser/measurement pipeline with saved synthetic analyst/reviewer answers; not model quality proof.',
    cases,
    savedRoleCalls,
    ui,
    hostV1Unchanged: true,
    hostAssessmentTokenChecked: true,
    foreignSessionRefused: true,
    reportAndAssessmentReadsWriteNoEvidence: true,
    providerCalls: 0,
    nativeCalls: 0,
    samCalls: 0,
    costUsd: 0,
    remoteRequests,
    limits: [
      'No general accuracy, user study, full website accessibility or complete criterion coverage is established.',
      'Saved visual judgement and coverage are test fixtures; actual Spark interpretation is unproved by this script.',
      'No private Cavioo components, data, production service or customer browser defaults are changed.',
    ],
  };
  writeFileSync(out + '/result.json', JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(
    JSON.stringify({
      passed: true,
      runIds: cases.map((row) => row.runId),
      criteria: 15,
      visualTopicsPerView: 6,
      providerCalls: 0,
      nativeCalls: 0,
      samCalls: 0,
      costUsd: 0,
      artifact: out + '/result.json',
    }),
  );
} finally {
  globalThis.fetch = originalFetch;
  await browser?.close();
  for (const walk of walks) await walk.close();
  await app.close();
}
