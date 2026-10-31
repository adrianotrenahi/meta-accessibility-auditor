import { startServer } from '../server/index.js';
import { approval, key, safeError } from '../src/config.js';
import { digest } from '../src/store.js';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

// An approval is supplied privately after owner authorisation, never created by this script.
const approved = approval();
if (!key() || (approved.maxUsd ?? Infinity) > 10 || approved.maxRunUsd > 3)
  throw Error('This controlled batch needs a private approval capped at $10 total and $3 per run.');
const withVoiceOver = process.argv.includes('--with-voiceover');
const correctedBuild = process.argv.includes('--verify-corrected-build');
const outlineRegression = process.argv.includes('--outline-provenance-regression');
if (correctedBuild && outlineRegression) throw Error('Select one explicit validation purpose.');
const maximumAttempts = outlineRegression ? 6 : correctedBuild ? 5 : 3;
const validationConfiguration = {
  browser: withVoiceOver ? 'webkit' : 'chromium',
  headless: !withVoiceOver,
  readerRequested: withVoiceOver,
};
const sourceFiles = ['src', 'server', 'scripts'].flatMap((dir) =>
  readdirSync(dir)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => join(dir, name)),
);
const codeFingerprint = digest(
  sourceFiles
    .sort()
    .map((file) => file + ':' + digest(readFileSync(file)))
    .join('\n'),
);
mkdirSync('output', { recursive: true });
for (const file of sourceFiles) {
  const target = join('output/day-two-tested-source', codeFingerprint, file);
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, readFileSync(file), { mode: 0o600 });
}
const app = await startServer(0, 'data/day-two-proof', false);
const results: any[] = [];
try {
  const existing = app.store.runs().length;
  if (existing >= maximumAttempts)
    throw Error('The bounded attempt allowance is used; this script cannot launch another run.');
  if (outlineRegression && existing !== 5)
    throw Error('The one outline-provenance regression follows the five retained attempts.');
  if (correctedBuild) {
    const marker = 'output/day-two-corrected-validation.json';
    if (existsSync(marker)) {
      const previous = JSON.parse(readFileSync(marker, 'utf8'));
      if (
        previous.codeFingerprint !== codeFingerprint ||
        JSON.stringify(previous.configuration) !== JSON.stringify(validationConfiguration)
      )
        throw Error(
          'The corrected validation build changed; preserve these results and re-plan before more paid work.',
        );
    } else {
      if (existing !== 2)
        throw Error('Corrected validation follows the two retained investigation attempts.');
      writeFileSync(
        marker,
        JSON.stringify(
          {
            firstAttempt: 3,
            lastAttempt: 5,
            codeFingerprint,
            configuration: validationConfiguration,
            maxBatchUsd: 10,
            reason:
              'Three corrected-build checks after two investigation failures; all charges stay in the same bounded ledger.',
          },
          null,
          2,
        ),
        { flag: 'wx', mode: 0o600 },
      );
    }
  }
  for (let attempt = existing + 1; attempt <= maximumAttempts; attempt++) {
    if (app.store.usage().requests.some((r) => r.actual === null))
      throw Error('An earlier charge is unconfirmed; reconcile it before another request.');
    const broken = outlineRegression || attempt % 2 === 1;
    const run = await app.runner.start({
      mode: 'live',
      headless: !withVoiceOver,
      engine: withVoiceOver ? 'webkit' : 'chromium',
      voiceOver: withVoiceOver,
      url: app.origin + '/shop/' + (broken ? '?case=broken' : ''),
      goal: `Use actual keyboard actions to add the canvas day bag, open the basket, enter test@example.org and open the safe review dialog. Stop when the review dialog is visible; do not close it or place any order. ${withVoiceOver ? 'Browser is Mac WebKit: use Alt+Tab to include links. Native VoiceOver checkpoints are available; retain their limits and do not repeat a failed checkpoint.' : 'Browser is Chromium: use Tab. Native VoiceOver is not tested in this headless attempt; do not request it or infer its speech.'} Inspect original accessibility and visual UX evidence without a finding quota.`,
    });
    console.log(
      JSON.stringify({
        attempt,
        runId: run.id,
        controlledCase: broken ? 'broken' : 'clean',
        maxRunUsd: approved.maxRunUsd,
      }),
    );
    await app.runner.completion;
    const records = app.store.records(run.id),
      usage = app.store.usage(run.id);
    const captures = records.filter((r) => r.kind === 'capture');
    const actions = records.filter((r) => r.kind === 'action');
    const last = captures.at(-1);
    const added = captures.some((r) => r.payload.text.includes('Added to your basket.'));
    const addAction = actions.find(
      (r) =>
        r.payload.before?.id === 'add' &&
        r.payload.action?.key === 'Enter' &&
        r.payload.outcome === 'performed',
    );
    const reviewAction = actions.findLast(
      (r) =>
        r.payload.before?.id === 'continue' &&
        r.payload.action?.key === 'Enter' &&
        r.payload.outcome === 'performed',
    );
    const reachedReview = !!last?.payload.text.includes(
      'This is the safe stopping point. No order will be placed.',
    );
    const journeySuccess = !!addAction && added && !!reviewAction && reachedReview;
    const result = {
      attempt,
      run: app.store.run(run.id),
      controlledCase: broken ? 'broken' : 'clean',
      journeySuccess,
      added,
      reachedReview,
      boundaryCaptureId: last?.id,
      keyboardActions: actions.length,
      reviewActionId: reviewAction?.id,
      finalFocus: last?.payload.focus,
      nativeReader: records
        .filter((r) => r.kind === 'at_check')
        .map((r) => ({ id: r.id, ...r.payload })),
      rawCandidates: records
        .filter((r) => r.kind === 'candidate')
        .map((r) => ({ id: r.id, ...r.payload })),
      published: app.store.published(run.id),
      sam: records
        .filter((r) => r.kind === 'sam_mapping' && r.payload.stage === 'result')
        .map((r) => ({ id: r.id, ...r.payload })),
      limits: records.filter((r) => r.kind === 'limit').map((r) => r.payload),
      requests: usage.requests,
      usageEstimateUsd: usage.spent / 1e6,
      heldUsd: usage.reserved / 1e6,
      tokens: records
        .filter((r) => r.kind === 'model_response')
        .map((r) => ({
          role: r.author,
          usage: r.payload.usage,
          instructionHash: r.payload.instructionHash,
        })),
      codeFingerprint,
      configuration: validationConfiguration,
      validationPurpose: outlineRegression
        ? 'outline-provenance-regression'
        : correctedBuild
          ? 'corrected-build-consistency'
          : 'investigation',
      baseCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      truthStatus:
        'Engineer inspection pending; owner case labels and independent human validation remain required.',
    };
    results.push(result);
    writeFileSync(`output/day-two-attempt-${attempt}.json`, JSON.stringify(result, null, 2), {
      mode: 0o600,
    });
    console.log(
      JSON.stringify({
        attempt,
        journeySuccess,
        keyboardActions: actions.length,
        rawClaims: result.rawCandidates.length,
        published: result.published.map((f) => ({ title: f.title, evidence: f.evidence })),
        samMatches: result.sam.map((s) => s.match),
        usageEstimateUsd: result.usageEstimateUsd,
        heldUsd: result.heldUsd,
        limits: result.limits,
      }),
    );
    if (!journeySuccess || usage.reserved || result.limits.some((l) => l.reason?.includes('HTTP')))
      break; // Fix a repeated failure before paying for another identical attempt.
  }
} catch (error) {
  console.error(safeError(error));
  process.exitCode = 1;
} finally {
  const usage = app.store.usage();
  writeFileSync(
    'output/day-two-batch.json',
    JSON.stringify(
      {
        at: new Date().toISOString(),
        approval: approved,
        codeFingerprint,
        runs: app.store.runs(),
        completedThisInvocation: results.map((r) => r.run.id),
        usageEstimateUsd: usage.spent / 1e6,
        heldUsd: usage.reserved / 1e6,
        billingReconciled: false,
        productionUsed: false,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  await app.close();
}
