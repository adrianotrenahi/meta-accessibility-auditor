import { voiceOver, macOSActivate } from '@guidepup/guidepup';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BrowserWalk } from './browser.js';
import type { RecordEntry } from './types.js';
import { safeError } from './config.js';
const exec = promisify(execFile);
export function voiceOverPreflight() {
  return {
    platform: process.platform,
    controlEnabled: existsSync('/private/var/db/Accessibility/.VoiceOverAppleScriptEnabled'),
    controlConfigured:
      process.platform === 'darwin' &&
      existsSync('/private/var/db/Accessibility/.VoiceOverAppleScriptEnabled'),
    operationProven: false,
    note: 'This checks configuration only. Real VoiceOver also needs a working desktop, app automation permission and a successful native proof.',
  };
}
export class VoiceOverProbe {
  checkpoints = 0;
  private startedByUs = false;
  private wasRunning = false;
  private starting?: Promise<void>;
  private cleaning?: Promise<void>;
  constructor(private walk: BrowserWalk) {}
  async check(source: RecordEntry, activateKnownControl = false) {
    this.walk.assertActive();
    const { store, runId } = this.walk;
    const logs: any[] = [];
    const began = new Date().toISOString();
    if (this.checkpoints >= 2) throw Error('The two VoiceOver checkpoints have been used.');
    this.checkpoints++;
    this.cleaning = undefined;
    if (!voiceOverPreflight().controlConfigured)
      return store.append(
        runId,
        'at_check',
        'voiceover',
        {
          method: 'real_VoiceOver',
          state: 'NOT_TESTED',
          reason: 'VoiceOver AppleScript control is unavailable.',
          commands: [],
        },
        [source.id],
      );
    const command = async (name: string, fn: () => Promise<any>) => {
      if (logs.length >= 12) throw Error('VoiceOver command limit reached.');
      this.walk.count();
      const expected = this.walk.engine === 'webkit' ? 'Playwright' : 'Chromium';
      const front = await exec(
        'osascript',
        [
          '-e',
          'tell application "System Events" to get name of first application process whose frontmost is true',
        ],
        { timeout: 5000 },
      );
      if (front.stdout.trim() !== expected)
        throw Error(
          'Another application has control; the screen-reader probe stopped before sending keys.',
        );
      const entry: any = { command: name, at: new Date().toISOString(), outcome: 'attempted' };
      logs.push(entry);
      try {
        const result = await fn();
        entry.spokenPhrases = await voiceOver.spokenPhraseLog();
        entry.itemText = await voiceOver.itemText();
        entry.outcome = 'completed';
        entry.finishedAt = new Date().toISOString();
        return result;
      } catch (e) {
        entry.outcome = 'failed';
        entry.error = safeError(e);
        throw e;
      }
    };
    try {
      await this.walk.page.bringToFront();
      const state = await exec(
        'osascript',
        ['-e', 'tell application "System Events" to return exists process "VoiceOver"'],
        { timeout: 8000 },
      );
      this.wasRunning = state.stdout.trim() === 'true';
      this.walk.assertActive();
      this.startedByUs = true;
      this.starting = voiceOver.start({ capture: true });
      await this.starting;
      this.walk.assertActive();
      await macOSActivate(this.walk.engine === 'webkit' ? 'Playwright' : 'Chromium');
      await command('interact with web content', () => voiceOver.interact({ timeout: 5000 }));
      for (let i = 0; i < 5; i++)
        await command('next VoiceOver item', () => voiceOver.next({ timeout: 5000 }));
      if (activateKnownControl) {
        // Native activation proof is allowed only on the known non-purchasing controlled page.
        if (new URL(this.walk.page.url()).origin !== this.walk.controlledOrigin)
          throw Error('Native activation proof is restricted to the controlled shop.');
        let attempts = 0;
        while (!(await voiceOver.itemText()).includes('Add to basket') && attempts++ < 3)
          await command('next VoiceOver item', () => voiceOver.next({ timeout: 4000 }));
        if (!(await voiceOver.itemText()).includes('Add to basket'))
          throw Error('The known safe target was not reached within the check limit.');
        await command('activate known Add to basket control', () =>
          voiceOver.act({ timeout: 5000 }),
        );
      }
      const spoken = logs.flatMap((x) => x.spokenPhrases ?? []).filter(Boolean);
      return store.append(
        runId,
        'at_check',
        'voiceover',
        {
          method: 'real_VoiceOver',
          state: spoken.length ? 'observed' : 'INCONCLUSIVE',
          startedAt: began,
          finishedAt: new Date().toISOString(),
          browser: this.walk.engine,
          os: process.platform,
          commands: logs,
          captureHealthy: spoken.length > 0,
          limit: spoken.length
            ? 'Observed commands only; this does not certify the entire journey.'
            : 'No spoken output was captured; this is not a website finding.',
        },
        [source.id],
      );
    } catch (e) {
      const chain = [];
      let cause: unknown = e;
      for (let n = 0; n < 5 && cause; n++) {
        chain.push(safeError(cause));
        cause = cause instanceof Error ? cause.cause : undefined;
      }
      return store.append(
        runId,
        'at_check',
        'voiceover',
        {
          method: 'real_VoiceOver',
          state: 'INCONCLUSIVE',
          reason: chain.join(' → '),
          commands: logs,
          startedAt: began,
          captureHealthy: false,
        },
        [source.id],
      );
    } finally {
      await this.cleanup();
    }
  }
  async cleanup() {
    if (this.cleaning) return this.cleaning;
    if (this.startedByUs) {
      this.cleaning = (async () => {
        await this.starting?.catch(() => {});
        try {
          await voiceOver.stop();
        } catch (e) {
          this.walk.store.append(this.walk.runId, 'limit', 'voiceover', { cleanup: safeError(e) });
        } finally {
          this.startedByUs = false;
          if (this.wasRunning)
            await exec('open', ['-a', 'VoiceOver'], { timeout: 8000 }).catch((e) => {
              this.walk.store.append(this.walk.runId, 'limit', 'voiceover', {
                restore: safeError(e),
              });
            });
        }
      })();
      return this.cleaning;
    }
  }
}
