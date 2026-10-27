import { startServer } from '../server/index.js';
import { Store, digest } from '../src/store.js';
import { approval, key, safeError } from '../src/config.js';
import { assessmentForRun } from '../src/assessment.js';
import { BrowserWalk } from '../src/browser.js';
import { MetaModels } from '../src/models.js';
import { CRITERIA_VERSION } from '../src/criteria.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';

// Retained investigations, one focused check and one final journey. No automatic retry loop.
const args = process.argv.slice(2);
if (
  args.some((arg) => !['--corrected', '--assessment-only', '--final-journey'].includes(arg)) ||
  args.length > 1
)
  throw Error('Only one explicit proof mode is supported.');
const corrected = args.includes('--corrected');
const assessmentOnly = args.includes('--assessment-only');
const finalJourney = args.includes('--final-journey');
const proofName = finalJourney
  ? 'day-three-final-journey'
  : assessmentOnly
    ? 'day-three-assessment-proof'
    : corrected
      ? 'day-three-live-proof-corrected'
      : 'day-three-live-proof';
const approved = approval();
if (!key() || approved.maxUsd > 3 || approved.maxRunUsd > 3)
  throw Error('The Day 3 check requires a private approval capped at $3 total and $3 per run.');
// The first one-off test predates the batch ledgers; its retained cost is in FIRST-PAID-TEST.md.
let priorEstimate = 0.314504;
let dayThreeSpent = 0;
if (
  (corrected || assessmentOnly || finalJourney) &&
  !existsSync('data/day-three-live-proof/runs.sqlite')
)
  throw Error('The corrected proof requires the retained first attempt.');
if (
  assessmentOnly &&
  (!existsSync('data/day-three-live-proof-corrected/runs.sqlite') ||
    approved.maxUsd > 0.5 ||
    approved.maxRunUsd > 0.5)
)
  throw Error(
    'The analysis-only check requires the retained correction and a maximum $0.50 approval.',
  );
if (
  finalJourney &&
  (!existsSync('data/day-three-assessment-proof/runs.sqlite') ||
    approved.maxUsd > 1.25 ||
    approved.maxRunUsd > 1.25)
)
  throw Error(
    'The final journey requires the retained focused check and a maximum $1.25 approval.',
  );
for (const dir of [
  'data',
  'data/day-two-proof',
  ...(corrected || assessmentOnly || finalJourney ? ['data/day-three-live-proof'] : []),
  ...(assessmentOnly || finalJourney ? ['data/day-three-live-proof-corrected'] : []),
  ...(finalJourney ? ['data/day-three-assessment-proof'] : []),
]) {
  if (!existsSync(dir + '/runs.sqlite')) continue;
  const prior = new Store(dir);
  try {
    const usage = prior.usage();
    if (usage.reserved || usage.requests.some((r) => r.actual === null))
      throw Error('An earlier charge is unconfirmed; reconcile it before this check.');
    priorEstimate += usage.spent / 1e6;
    if (dir.startsWith('data/day-three-')) dayThreeSpent += usage.spent / 1e6;
  } finally {
    prior.close();
  }
}
if (dayThreeSpent + approved.maxUsd > 3)
  throw Error('All Day 3 proof versions must fit the original $3 total ceiling.');
if (priorEstimate + approved.maxUsd > 10)
  throw Error('This check would exceed the conservative $10 cumulative local testing ceiling.');
const sourceFiles = [
  'src/runner.ts',
  'src/models.ts',
  'src/criteria.ts',
  'src/assessment.ts',
  'src/evidence-checks.ts',
  'src/visual-inspection.ts',
  'src/focused-checks.ts',
  'src/journey-evidence.ts',
  'src/browser.ts',
  'src/store.ts',
  'src/request-evidence.ts',
  'src/types.ts',
];
const sourceHashes = Object.fromEntries(
  sourceFiles.map((file) => [file, digest(readFileSync(file))]),
);
mkdirSync('output', { recursive: true });
const app = await startServer(0, `data/${proofName}`, false);
let focusedWalk: BrowserWalk | undefined;
try {
  if (app.store.runs().length !== 0)
    throw Error('The single Day 3 provider attempt is already retained; no retry was started.');
  const options = {
    mode: 'live',
    headless: true,
    engine: 'chromium',
    voiceOver: false,
    url: app.origin + '/shop/?case=broken',
    goal: 'Use real keyboard input to add the canvas day bag, open the basket, type test@example.org and open the safe review dialog. Stop when that dialog is visible; do not place an order or close the dialog. Use Chromium Tab/Enter. Native VoiceOver is not available in this headless check; retain NOT_TESTED and do not ask for it. Inspect the supplied originals using the fifteen scoped criteria and six visual topics, without a finding quota. Ordinary price text does not establish comparable selections or paid-choice control.',
  } as const;
  let run;
  if (assessmentOnly) {
    run = app.store.create(
      'One controlled analysis/review check; no full-journey or accuracy claim.',
      options.url,
      'live',
    );
    app.store.append(run.id, 'plan', 'controlled-proof', {
      criterionVersion: CRITERIA_VERSION,
      navigation: 'Scripted local checkpoint, not model-driven navigation.',
      nativeReader: 'NOT_TESTED',
    });
    focusedWalk = new BrowserWalk(app.store, run.id, app.origin, true, 'chromium');
    const capture = await focusedWalk.start(run.url);
    await focusedWalk.measurements(capture);
    app.store.append(
      run.id,
      'coverage',
      'controlled-proof',
      {
        method: 'real_VoiceOver',
        state: 'NOT_TESTED',
        reason: 'Headless local criterion check; no native reader was used.',
      },
      [capture.id],
    );
    try {
      await (app.runner as any).analyse(
        new MetaModels(app.store),
        run,
        capture,
        focusedWalk,
        AbortSignal.timeout(180_000),
      );
    } catch (error) {
      app.store.append(run.id, 'limit', 'controlled-proof', {
        reason: safeError(error),
        check: 'focused-provider-check',
      });
    }
    app.store.finish(
      run.id,
      'partial',
      'Focused model schema/evidence check only; the full journey was not run.',
    );
  } else run = await app.runner.start(options);
  console.log(
    JSON.stringify({
      runId: run.id,
      maxRunUsd: approved.maxRunUsd,
      priorUsageEstimateUsd: priorEstimate,
      purpose: assessmentOnly
        ? 'One focused analysis/review check; no complete journey claim'
        : 'One real controlled Day 3 schema and journey check',
    }),
  );
  if (!assessmentOnly) await app.runner.completion;
  const records = app.store.records(run.id),
    usage = app.store.usage(run.id);
  const captures = records.filter((r) => r.kind === 'capture');
  const actions = records.filter((r) => r.kind === 'action');
  const added = captures.some((r) => r.payload.text.includes('Added to your basket.'));
  const reviewReached = !!captures
    .at(-1)
    ?.payload.text.includes('This is the safe stopping point. No order will be placed.');
  const addInput = actions.some(
    (r) =>
      r.payload.before?.id === 'add' &&
      r.payload.action?.key === 'Enter' &&
      r.payload.outcome === 'performed',
  );
  const reviewInput = actions.some(
    (r) =>
      r.payload.before?.id === 'continue' &&
      r.payload.action?.key === 'Enter' &&
      r.payload.outcome === 'performed',
  );
  const assessment = assessmentForRun(app.store, run.id);
  const result = {
    at: new Date().toISOString(),
    assessmentOnly,
    sourceHashes,
    run: app.store.run(run.id),
    journeySuccess: added && reviewReached && addInput && reviewInput,
    added,
    reviewReached,
    actualActions: actions.length,
    providerGenerationRequests: usage.requests.filter((r) => r.role !== 'sam').length,
    samRequests: usage.requests.filter((r) => r.role === 'sam').length,
    usageEstimateUsd: usage.spent / 1e6,
    heldUnknownUsd: usage.reserved / 1e6,
    cumulativeLocalEstimateUsd: priorEstimate + usage.spent / 1e6,
    dayThreeUsageEstimateUsd: dayThreeSpent + usage.spent / 1e6,
    rawCandidates: records.filter((r) => r.kind === 'candidate').length,
    criterionProposals: records.filter((r) => r.kind === 'criterion_proposal').length,
    criterionReviews: records.filter((r) => r.kind === 'criterion_review').length,
    findings: app.store.published(run.id),
    assessment,
    limits: records
      .filter((r) => r.kind === 'limit' || r.kind === 'focused_check')
      .map((r) => ({ id: r.id, kind: r.kind, payload: r.payload })),
    provenance:
      'Actual Meta provider results and original local Chromium evidence; no native-reader or customer-production proof.',
    billing: 'Conservative provider-usage estimate, pending Billing reconciliation.',
  };
  const analysisSuccess =
    result.criterionProposals > 0 &&
    result.criterionReviews > 0 &&
    assessment.visualCoverage.some((entry: any) => entry.state === 'examined');
  Object.assign(result, { analysisSuccess });
  writeFileSync(`output/${proofName}.json`, JSON.stringify(result, null, 2), {
    mode: 0o600,
  });
  console.log(
    JSON.stringify({
      runId: run.id,
      journeySuccess: result.journeySuccess,
      actualActions: actions.length,
      usageEstimateUsd: result.usageEstimateUsd,
      heldUnknownUsd: result.heldUnknownUsd,
      candidates: result.rawCandidates,
      findings: result.findings.length,
      criterionProposals: result.criterionProposals,
      criterionReviews: result.criterionReviews,
      analysisSuccess,
      artifact: `output/${proofName}.json`,
    }),
  );
  if ((!assessmentOnly && !result.journeySuccess) || !analysisSuccess || result.heldUnknownUsd)
    process.exitCode = 1;
} finally {
  try {
    await focusedWalk?.close();
  } finally {
    try {
      await app.close();
    } finally {
      if (existsSync('spend-approval.json')) unlinkSync('spend-approval.json');
    }
  }
}
