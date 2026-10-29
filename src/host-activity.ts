import type { RecordEntry } from './types.js';
import { recordIsIntact } from './store.js';
import { safeError } from './config.js';
const initialCaptureNote =
  'Initial page captured. Automatic scan results do not establish keyboard or screen-reader operation.';

/** Public progress is recorded activity, never a private model-reasoning stream. */
export function exportHostActivity(records: RecordEntry[], runId: string, running = true) {
  const intact = records.filter((record) => record.runId === runId && recordIsIntact(record));
  const scrub = (text: string, through: number) => {
    // Later unrelated typing cannot rewrite an already published activity row.
    const typed = intact
      .filter((record) => record.seq <= through)
      .filter((record) => record.kind === 'action' && record.author === 'browser')
      .flatMap((record) => [record.payload.action, record.payload.requestedAction])
      .filter((action) => action?.kind === 'type' && typeof action.text === 'string' && action.text)
      .map((action) => action.text as string)
      .sort((a, b) => b.length - a.length);
    for (const value of typed) text = text.split(value).join('[redacted input]');
    return safeError(Error(text));
  };
  let awaitingInput = false;
  const entries = intact.flatMap((record, index) => {
    if (awaitingInput) return [];
    let kind: 'progress' | 'action' | 'preparing' | 'limit';
    let action: 'Recorded progress' | 'Input result' | 'Preparing next action' | 'Run limit';
    let reason: string;
    let target: string | undefined;
    if (
      record.kind === 'navigator_note' &&
      record.author === 'driver' &&
      record.payload.kind === 'progress' &&
      typeof record.payload.text === 'string'
    ) {
      const following = intact.slice(index + 1);
      const nextRead = following.findIndex(
        (item) => item.kind === 'read_snapshot' && item.author === 'driver',
      );
      const interval = nextRead < 0 ? following : following.slice(0, nextRead);
      const input = interval.find(
        (item) =>
          item.kind === 'action' &&
          item.author === 'browser' &&
          item.payload.method === 'actual_keyboard_or_browser' &&
          record.sources.includes(item.payload.sourceCaptureId),
      );
      const keyboardTarget = record.payload.progressMode === 'keyboard_target';
      if (record.payload.text !== initialCaptureNote && !keyboardTarget) {
        // Freeform notes can name future typed values even without a model
        // response. Close the whole input interval before publishing its text.
        if (nextRead < 0 && running) {
          awaitingInput = true;
          return [];
        }
        if (!input) return [];
      }
      kind = 'progress';
      action = 'Recorded progress';
      reason = keyboardTarget
        ? 'Moving toward the requested control with real keyboard input. Each sent key is recorded below; reaching the control is not yet established.'
        : record.payload.text === initialCaptureNote
          ? initialCaptureNote
          : scrub(
              record.payload.text,
              nextRead < 0 ? Number.MAX_SAFE_INTEGER : following[nextRead]!.seq,
            );
    } else if (record.kind === 'read_snapshot' && record.author === 'driver') {
      kind = 'preparing';
      action = 'Preparing next action';
      reason =
        'Preparing the recorded screen for navigation. No decision is established by this preparation.';
    } else if (
      record.kind === 'action' &&
      record.author === 'browser' &&
      record.payload.method === 'actual_keyboard_or_browser'
    ) {
      kind = 'action';
      action = 'Input result';
      const input = record.payload.action;
      if (
        input?.kind === 'press' &&
        [
          'Tab',
          'Shift+Tab',
          'Alt+Tab',
          'Alt+Shift+Tab',
          'Enter',
          'Space',
          'Escape',
          'ArrowDown',
          'ArrowUp',
          'ArrowLeft',
          'ArrowRight',
        ].includes(input.key)
      )
        target = input.key;
      reason =
        record.payload.outcome === 'performed'
          ? 'The recorded browser input was sent. Its result still needs checking.'
          : 'This record does not establish a performed browser input.';
    } else if (record.kind === 'limit' && typeof record.payload.reason === 'string') {
      kind = 'limit';
      action = 'Run limit';
      reason = scrub(record.payload.reason, record.seq);
    } else return [];
    return [
      {
        id: record.id,
        sequence: record.seq,
        recordHash: record.hash,
        createdAt: record.createdAt,
        kind,
        action,
        reason,
        ...(target ? { target } : {}),
      },
    ];
  });
  return { version: 'recorded-activity/1' as const, runId, entries: entries.slice(-40) };
}
