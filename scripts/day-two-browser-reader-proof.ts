import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { startServer } from '../server/index.js';
import { BrowserWalk } from '../src/browser.js';
import { VoiceOverProbe } from '../src/voiceover.js';
import { digest } from '../src/store.js';
import { safeError } from '../src/config.js';
import type { Action } from '../src/models.js';

// Full combination proof: native VoiceOver is stopped/restored before the keyboard walk.
// Targets are reached through observed focus and real keys, never control.focus() or DOM edits.
const keyboardOnly = process.argv.includes('--keyboard-only');
const sourceHashes = Object.fromEntries(
  ['src/browser.ts', 'src/voiceover.ts', 'scripts/day-two-browser-reader-proof.ts'].map((file) => [
    file,
    digest(readFileSync(file)),
  ]),
);
const app = await startServer(
  0,
  keyboardOnly ? 'data/day-two-keyboard-only-proof' : 'data/day-two-browser-reader-proof',
  false,
);
const results: any[] = [];
try {
  for (const broken of [false, true]) {
    const url = app.origin + '/shop/' + (broken ? '?case=broken' : '');
    const run = app.store.create(
      keyboardOnly
        ? 'Complete controlled keyboard journey; native reader not requested'
        : 'Real VoiceOver followed by a complete controlled keyboard journey',
      url,
      'offline',
    );
    const walk = new BrowserWalk(app.store, run.id, app.origin, keyboardOnly, 'webkit');
    const probe = new VoiceOverProbe(walk);
    const readerCheck = (source: Awaited<ReturnType<BrowserWalk['capture']>>) =>
      keyboardOnly
        ? Promise.resolve(
            app.store.append(
              run.id,
              'coverage',
              'browser-reader-proof',
              {
                method: 'real_VoiceOver',
                state: 'NOT_TESTED',
                commands: [],
                reason: 'Keyboard-only proof; no native-reader operation is claimed.',
              },
              [source.id],
            ),
          )
        : probe.check(source);
    try {
      let current = await walk.start(url);
      const scan = await walk.measurements(current);
      const unnamed = scan.payload.violations.some((v: any) => v.id === 'button-name');
      assert.equal(unnamed, broken);
      const reader = await readerCheck(current);
      const readerObserved = reader.payload.state === 'observed';
      if (readerObserved) assert.equal(reader.payload.commands.length, 6);
      current = await walk.capture();
      const postReaderFocus = current.payload.focus;
      const keys: {
        actionId: string;
        key?: string;
        requestedKey?: string;
        kind: string;
        before: any;
        after: any;
      }[] = [];
      const act = async (action: Action) => {
        const record = await walk.act(action, current);
        keys.push({
          actionId: record.id,
          key: record.payload.action.key,
          requestedKey: record.payload.requestedAction?.key ?? action.key,
          kind: action.kind,
          before: record.payload.before,
          after: record.payload.after,
        });
        current = await walk.capture();
      };
      const reach = async (
        matches: (focus: Awaited<ReturnType<BrowserWalk['focus']>>) => boolean,
        label: string,
      ) => {
        for (let n = 0; n < 12; n++) {
          if (matches(await walk.focus())) return;
          await act({
            kind: 'press',
            key: 'Tab',
            note: `Request Tab to reach ${label} from observed focus; the recorded Mac WebKit method uses Option-Tab.`,
          });
          assert.equal(
            keys.at(-1)?.key,
            'Alt+Tab',
            'The actual key must record the WebKit navigation method.',
          );
          assert.equal(
            keys.at(-1)?.requestedKey,
            'Tab',
            'The original semantic key request remains recorded.',
          );
        }
        if (!matches(await walk.focus()))
          throw Error(
            `The controlled ${label} was not reached within the recorded keyboard allowance.`,
          );
      };
      await reach((focus) => focus.id === 'add' && focus.tag === 'button', 'Add to basket button');
      await act({
        kind: 'press',
        key: 'Enter',
        note: 'Activate the observed controlled Add to basket button.',
      });
      assert.match(await walk.page.locator('#status').innerText(), /Added to your basket/);
      await reach(
        (focus) => focus.tag === 'a' && focus.href.startsWith('/shop/basket'),
        'basket link',
      );
      await act({ kind: 'press', key: 'Enter', note: 'Open the observed controlled basket link.' });
      assert.match(walk.page.url(), /\/shop\/basket/);
      await reach((focus) => focus.id === 'email' && focus.tag === 'input', 'email field');
      await act({
        kind: 'type',
        text: 'test@example.org',
        note: 'Enter the approved synthetic email into the observed field.',
      });
      await reach(
        (focus) => focus.id === 'continue' && focus.tag === 'button',
        'Continue to review button',
      );
      await act({
        kind: 'press',
        key: 'Enter',
        note: 'Open the safe review dialog; no order is placed.',
      });
      assert.equal(await walk.page.locator('dialog[open]').isVisible(), true);
      const dialogFocusInside = await walk.page.evaluate(
        () => !!document.querySelector('dialog')?.contains(document.activeElement),
      );
      assert.equal(
        dialogFocusInside,
        !broken,
        'Clean and broken examples retain their different actual focus outcomes.',
      );
      const keyboardDialogCaptureId = current.id;
      const endReader = await readerCheck(current);
      const endReaderObserved = endReader.payload.state === 'observed';
      const endReaderSpeech = endReader.payload.commands.flatMap(
        (entry: any) => entry.spokenPhrases ?? [],
      );
      current = await walk.capture();
      const combinedPassed = readerObserved && endReaderObserved;
      const observation = app.store.append(
        run.id,
        'observation',
        'browser-reader-proof',
        {
          method: keyboardOnly ? 'actual_keyboard_only' : 'real_VoiceOver_then_actual_keyboard',
          readerCheckId: reader.id,
          readerObserved,
          endReaderCheckId: endReader.id,
          endReaderObserved,
          keyboardDialogCaptureId,
          postReaderFocus,
          keyboardMethod: 'Requested Tab; actual Mac WebKit Alt+Tab',
          unnamedButton: unnamed,
          safeReviewReached: true,
          dialogFocusInside,
          expectedBrokenCase: broken,
          focusRecovery:
            'None: no control focus, DOM edits or extra app activation after the reader check.',
        },
        [reader.id, endReader.id, keyboardDialogCaptureId, current.id],
      );
      app.store.finish(
        run.id,
        keyboardOnly || combinedPassed ? 'complete' : 'partial',
        keyboardOnly
          ? 'Controlled keyboard proof passed; native reader was not requested.'
          : combinedPassed
            ? 'Controlled native-reader and keyboard combination passed; no model calls or full-site accessibility verdict.'
            : 'Controlled keyboard path passed, but native-reader guard stopped the reader; this is not a combined pass.',
      );
      if (!keyboardOnly && !combinedPassed) process.exitCode = 1;
      results.push({
        case: broken ? 'broken' : 'clean',
        runId: run.id,
        passed: keyboardOnly || combinedPassed,
        keyboardOnly,
        combinedPassed,
        keyboardPassed: true,
        readerObserved,
        readerLimit: reader.payload.reason ?? null,
        endReaderCheckId: endReader.id,
        endReaderObserved,
        endReaderSpeech,
        endReaderCommands: endReader.payload.commands,
        endReaderLimit: endReader.payload.reason ?? null,
        keyboardDialogCaptureId,
        readerCheckId: reader.id,
        readerCommands: reader.payload.commands.length,
        speechDeltas: reader.payload.commands.flatMap((c: any) => c.spokenPhrases ?? []),
        postReaderFocus,
        keyboardActions: keys,
        unnamedButton: unnamed,
        safeReviewReached: true,
        dialogFocusInside,
        finalCaptureId: current.id,
        observationId: observation.id,
        focusRecovery: 'None',
        modelCalls: 0,
        spendUsd: 0,
      });
    } catch (error) {
      const reason = safeError(error);
      app.store.append(run.id, 'limit', 'browser-reader-proof', { reason });
      app.store.finish(run.id, 'partial', reason);
      results.push({ case: broken ? 'broken' : 'clean', runId: run.id, passed: false, reason });
      process.exitCode = 1;
    } finally {
      await probe.cleanup();
      await walk.close();
    }
    mkdirSync('output', { recursive: true });
    writeFileSync(
      keyboardOnly
        ? 'output/day-two-keyboard-only-proof.json'
        : 'output/day-two-browser-reader-proof.json',
      JSON.stringify(
        {
          at: new Date().toISOString(),
          baseCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
          sourceHashes,
          results,
          modelCalls: 0,
          spendUsd: 0,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    console.log(JSON.stringify(results.at(-1)));
  }
} finally {
  await app.close();
}
