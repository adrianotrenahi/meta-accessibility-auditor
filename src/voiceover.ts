import { voiceOver, macOSActivate } from '@guidepup/guidepup';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BrowserWalk } from './browser.js';
import type { RecordEntry } from './types.js';
import { safeError } from './config.js';
import { recordIsIntact } from './store.js';
const exec = promisify(execFile);
type ProcessLookup = (
  file: string,
  args: string[],
  options: { timeout: number },
) => Promise<{ stdout: string }>;
export async function isVoiceOverRunning(
  runProcess: ProcessLookup = exec,
  userId = process.getuid?.(),
) {
  if (typeof userId !== 'number' || !Number.isSafeInteger(userId) || userId < 0)
    throw Error('The current Mac user could not be identified for the VoiceOver status check.');
  try {
    const result = await runProcess('/usr/bin/pgrep', ['-u', String(userId), '-x', 'VoiceOver'], {
      timeout: 2000,
    });
    if (
      typeof result.stdout !== 'string' ||
      !/^[1-9]\d*(?:\r?\n[1-9]\d*)*$/.test(result.stdout.trim())
    )
      throw Error(
        'VoiceOver status returned no valid process identity; its previous state is unknown.',
      );
    return true;
  } catch (error) {
    const failure = error as { code?: unknown; signal?: unknown; killed?: unknown } | null;
    if (failure?.code === 1 && !failure.signal && !failure.killed) return false;
    throw error;
  }
}
export async function captureVoiceOverCommand(
  action: () => Promise<any>,
  reader: Pick<typeof voiceOver, 'spokenPhraseLog' | 'itemText'> = voiceOver,
  validateAfter?: () => Promise<void>,
) {
  const before = [...(await reader.spokenPhraseLog())];
  const result = await action();
  await validateAfter?.();
  const after = [...(await reader.spokenPhraseLog())];
  if (before.some((phrase, index) => after[index] !== phrase))
    throw Error(
      'VoiceOver speech capture changed during this command; its result is inconclusive.',
    );
  const itemText = await reader.itemText();
  await validateAfter?.();
  return {
    result,
    spokenPhrases: after.slice(before.length).filter((phrase) => phrase.trim()),
    itemText,
  };
}
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
  constructor(
    private walk: BrowserWalk,
    private restoreReader: () => Promise<unknown> = () =>
      exec('open', ['-a', 'VoiceOver'], { timeout: 8000 }),
  ) {}
  async check(source: RecordEntry, activateKnownControl = false) {
    this.walk.assertActive();
    const { store, runId } = this.walk;
    const original = store.record(runId, source.id);
    if (
      source.kind !== 'capture' ||
      source.runId !== runId ||
      source.payload.stable !== true ||
      !original ||
      original.hash !== source.hash ||
      !recordIsIntact(original) ||
      !recordIsIntact(source) ||
      source.payload.url !== this.walk.page.url()
    )
      throw Error('VoiceOver needs the exact stable original screen currently open in this run.');
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
    const assertForeground = async (after = false) => {
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
          after
            ? `Another application (${front.stdout.trim()}) has control instead of ${expected}; the screen-reader result was withheld.`
            : `Another application (${front.stdout.trim()}) has control instead of ${expected}; the screen-reader probe stopped before its native command.`,
        );
    };
    const command = async (name: string, fn: () => Promise<any>) => {
      if (logs.length >= 12) throw Error('VoiceOver command limit reached.');
      this.walk.count();
      await assertForeground();
      const entry: any = {
        command: name,
        at: new Date().toISOString(),
        outcome: 'attempted',
        control: 'VoiceOver AppleScript',
      };
      logs.push(entry);
      try {
        const observed = await captureVoiceOverCommand(fn, voiceOver, () => assertForeground(true));
        entry.spokenPhrases = observed.spokenPhrases;
        entry.itemText = observed.itemText;
        entry.outcome = 'completed';
        entry.finishedAt = new Date().toISOString();
        return observed.result;
      } catch (e) {
        entry.outcome = 'failed';
        entry.error = safeError(e);
        entry.finishedAt = new Date().toISOString();
        throw e;
      }
    };
    try {
      await this.walk.page.bringToFront();
      this.wasRunning = await isVoiceOverRunning();
      this.walk.assertActive();
      this.startedByUs = true;
      this.starting = voiceOver.start({ capture: true });
      await this.starting;
      this.walk.assertActive();
      await macOSActivate(this.walk.engine === 'webkit' ? 'Playwright' : 'Chromium');
      const browserProcess = this.walk.engine === 'webkit' ? 'Playwright' : 'Chromium';
      await exec(
        'osascript',
        [
          '-e',
          `tell application "System Events" to tell process "${browserProcess}" to set frontmost to true`,
        ],
        { timeout: 5000 },
      );
      // macOS activation is asynchronous; allow the requested browser to become frontmost.
      await this.walk.page.bringToFront();
      await this.walk.page.waitForTimeout(500);
      await command('start interacting with current VoiceOver item', () =>
        voiceOver.perform(voiceOver.commanderCommands.START_INTERACTING_WITH_ITEM, {
          timeout: 5000,
        }),
      );
      if (activateKnownControl) {
        // Native activation proof is allowed only on the known non-purchasing controlled page.
        if (new URL(this.walk.page.url()).origin !== this.walk.controlledOrigin)
          throw Error('Native activation proof is restricted to the controlled shop.');
        let attempts = 0;
        while (!(await voiceOver.itemText()).includes('Add to basket') && attempts++ < 3)
          await command('find next VoiceOver button', () =>
            voiceOver.perform(voiceOver.commanderCommands.FIND_NEXT_BUTTON, { timeout: 5000 }),
          );
        if (!(await voiceOver.itemText()).includes('Add to basket'))
          throw Error('The known safe target was not reached within the check limit.');
        await command('activate known Add to basket control', () =>
          voiceOver.act({ timeout: 5000 }),
        );
      } else
        for (let i = 0; i < 5; i++)
          await command('next VoiceOver item', () => voiceOver.next({ timeout: 5000 }));
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
            await this.restoreReader().catch((e) => {
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
