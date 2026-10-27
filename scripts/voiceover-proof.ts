import { startServer } from '../server/index.js';
import { BrowserWalk } from '../src/browser.js';
import { VoiceOverProbe } from '../src/voiceover.js';
import { mkdirSync, writeFileSync } from 'node:fs';
const app = await startServer(4322, 'data/voiceover-proof', false),
  run = app.store.create(
    'Read and activate the known safe Add to basket control with real VoiceOver',
    app.origin + '/shop/',
    'offline',
  ),
  walk = new BrowserWalk(app.store, run.id, app.origin, false),
  probe = new VoiceOverProbe(walk);
try {
  const capture = await walk.start(run.url);
  const check = await probe.check(capture, true);
  const after = await walk.capture();
  const status = await walk.page.locator('#status').innerText();
  const activated = status.includes('Added');
  const commands = check.payload.commands ?? [];
  const namedControlObserved = commands.some(
    (entry: any) =>
      entry.command === 'find next VoiceOver button' &&
      entry.outcome === 'completed' &&
      entry.itemText.includes('Add to basket') &&
      entry.spokenPhrases.some((phrase: string) => phrase.includes('Add to basket')),
  );
  const nativeActivationCompleted = commands.some(
    (entry: any) =>
      entry.command === 'activate known Add to basket control' && entry.outcome === 'completed',
  );
  const success =
    check.payload.state === 'observed' &&
    check.payload.captureHealthy &&
    namedControlObserved &&
    nativeActivationCompleted &&
    activated;
  app.store.append(
    run.id,
    'observation',
    'voiceover-proof',
    {
      knownSafeControlActivated: activated,
      namedControlObserved,
      nativeActivationCompleted,
      observedStatus: status,
    },
    [check.id, after.id],
  );
  app.store.finish(
    run.id,
    success ? 'complete' : 'partial',
    success
      ? 'Actual VoiceOver captured speech and activated the known safe control.'
      : 'Actual VoiceOver proof is incomplete; inspect original command and speech records.',
  );
  mkdirSync('output', { recursive: true });
  writeFileSync(
    'output/voiceover-proof.json',
    JSON.stringify(
      {
        at: new Date().toISOString(),
        runId: run.id,
        success,
        sourceCaptureId: capture.id,
        sourceCaptureHash: capture.hash,
        afterCaptureId: after.id,
        namedControlObserved,
        nativeActivationCompleted,
        check: check.payload,
        status,
        modelCalls: 0,
        creditsSpent: 0,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify(
      {
        runId: run.id,
        success,
        state: check.payload.state,
        reason: check.payload.reason,
        speechEntries: check.payload.commands?.length,
        activated,
      },
      null,
      2,
    ),
  );
  if (!success) process.exitCode = 1;
} finally {
  await probe.cleanup();
  await walk.close();
  await app.close();
}
