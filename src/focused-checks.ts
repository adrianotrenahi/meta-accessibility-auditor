import { Store } from './store.js';
import { BrowserWalk } from './browser.js';
import { VoiceOverProbe } from './voiceover.js';
import {
  FocusedCheckBudget,
  focusedCheckEligibility,
  missingEvidenceSchema,
  type MissingEvidenceRequest,
} from './evidence-checks.js';
import { safeError } from './config.js';
import type { RecordEntry } from './types.js';

/** Shares the same two slots between native checks and missing-fact requests. */
export async function performFocusedCheck(
  store: Store,
  runId: string,
  walk: BrowserWalk,
  probe: VoiceOverProbe | undefined,
  budget: FocusedCheckBudget,
  current: RecordEntry,
  value: MissingEvidenceRequest,
  signal: AbortSignal,
) {
  const request = missingEvidenceSchema.parse(value);
  const refuse = (reason: string) => {
    store.append(
      runId,
      'focused_check',
      'runner',
      { ...request, state: 'NOT_TESTED', reason, attempted: false },
      [current.id],
    );
    return current;
  };
  if (signal.aborted || store.run(runId).state !== 'running')
    return refuse('The run stopped before this focused check.');
  const source = store.record(runId, request.captureId);
  if (!source) return refuse('The requested original screen is unavailable.');
  let actualStateStamp: string;
  try {
    actualStateStamp = await walk.observationStamp();
  } catch (error) {
    return refuse('The current page state could not be read: ' + safeError(error));
  }
  const eligible = focusedCheckEligibility(request, {
    runId,
    source,
    storedSource: source,
    current,
    actualStateStamp,
  });
  if (!eligible.allowed) return refuse(eligible.reason);
  if (signal.aborted || store.run(runId).state !== 'running')
    return refuse('The run stopped while the current page state was being checked.');
  // Recheck after the awaited read: concurrent requests cannot claim this original twice.
  if (
    store
      .records(runId)
      .some(
        (record) =>
          record.kind === 'focused_check' &&
          record.payload.captureId === request.captureId &&
          record.payload.method === request.method &&
          record.payload.attempted === true,
      )
  )
    return refuse(
      'This focused method was already attempted on this original screen; no identical retry was sent.',
    );
  if (request.method === 'voiceover' && !probe)
    return refuse('A real reader is unavailable in this check context.');
  const claim = budget.claim(request.method);
  if (!claim.allowed) return refuse(claim.reason);
  const begun = store.append(
    runId,
    'focused_check',
    'runner',
    { ...request, state: 'attempted', attempted: true, remaining: budget.remaining },
    [source.id],
  );
  let result: RecordEntry | undefined;
  try {
    if (signal.aborted) throw Error('The run stopped before the focused input.');
    if (request.method === 'measurement') result = await walk.measurements(current);
    else if (request.method === 'voiceover') result = await probe!.check(current);
    else
      result = await walk.act(
        {
          kind: 'press',
          key: 'Tab',
          note: 'One bounded keyboard-focus observation requested by the analyst; this does not establish activation or journey success.',
        },
        current,
      );
    // Save the tested state before any navigation/restoration. A failed read never repeats input.
    const after = await walk.capture();
    const observed =
      request.method === 'voiceover'
        ? result.payload.state === 'observed'
        : result.payload.stable !== false && after.payload.stable === true;
    store.append(
      runId,
      'focused_check',
      'runner',
      {
        ...request,
        state: observed ? 'observed' : 'INCONCLUSIVE',
        attempted: true,
        resultId: result.id,
        afterCaptureId: after.id,
        remaining: budget.remaining,
        limit: 'A recorded check is not a criterion pass or an accepted finding.',
      },
      [begun.id, result.id, after.id],
    );
    return after;
  } catch (error) {
    store.append(
      runId,
      'focused_check',
      'runner',
      {
        ...request,
        state: 'INCONCLUSIVE',
        attempted: true,
        reason: safeError(error),
        remaining: budget.remaining,
        resultId: result?.id ?? null,
      },
      result ? [begun.id, result.id] : [begun.id],
    );
    if (signal.aborted) throw error;
    return current;
  }
}
