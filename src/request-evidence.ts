import { recordIsIntact, type Store } from './store.js';
import type { RecordEntry, Role } from './types.js';
import { reviewFeedbackIds } from './review-feedback.js';
import {
  JOURNEY_EVIDENCE_VERSION,
  INCOMPARABLE_TOTALS_LIMIT,
  JOURNEY_CONTEXT_LIMIT,
  UNRECOGNISED_BUNDLE_LIMIT,
  journeyDataSchema,
} from './journey-evidence.js';
import {
  makeImageReceipt,
  suppliedImageIds,
  PROVIDER_IMAGE_LIMIT,
  readHashMatches,
} from './image-receipt.js';

export class EvidenceRequestLimit extends Error {
  constructor(
    public role: Exclude<Role, 'sam'>,
    kind: 'screens' | 'input' = 'screens',
  ) {
    super(
      kind === 'input'
        ? 'Required original evidence exceeds the input allowance; this check remains incomplete.'
        : 'Required original screens exceed this request allowance; review remains incomplete.',
    );
  }
}

/** Retrieve originals from the shared pool, never another role's summary. */
export function originalClosure(records: RecordEntry[], ids: string[]) {
  const selected = new Set<string>();
  const pending = [...ids];
  while (pending.length) {
    const id = pending.pop()!;
    if (selected.has(id)) continue;
    const record = records.find((r) => r.id === id);
    if (!record || !recordIsIntact(record))
      throw Error('Required original evidence is missing or changed.');
    if (record.payload.stable === false)
      throw Error('Required original evidence was unstable; the claim remains unresolved.');
    selected.add(id);
    pending.push(...record.sources);
  }
  return records.filter((r) => selected.has(r.id));
}

/** Keep an older, empty price comparison outside a first analysis checkpoint.
 * This does not declare its picture equivalent or checked. Preserve the raw pool,
 * claims, material history, current tests and broken-source refusals.
 */
const comparisonFields = new Set([
  'method',
  'version',
  'stable',
  'beforeCaptureId',
  'afterCaptureId',
  'actionId',
  'comparable',
  'selectionSame',
  'sameCurrency',
  'currency',
  'beforeTotal',
  'afterTotal',
  'disclosure',
  'beforeDisclosure',
  'afterDisclosure',
  'limit',
  '_sourcesHash',
]);
/** A comparison across one input that recorded no price, choice or other change. With
 * `anyInput` false it must be a Tab press on one page; with true, any recorded input (a
 * page change alone is not a recorded change), and both originals must be settled. */
function emptyEarlierTraversal(
  record: RecordEntry,
  current: RecordEntry | null,
  records: RecordEntry[],
  anyInput = false,
) {
  const p = record.payload;
  if (
    record.author !== 'browser' ||
    !recordIsIntact(record) ||
    p.method !== 'comparable_totals' ||
    p.version !== JOURNEY_EVIDENCE_VERSION ||
    p.stable !== true ||
    p.comparable !== false ||
    p.limit !== INCOMPARABLE_TOTALS_LIMIT ||
    Object.keys(p).some((key) => !comparisonFields.has(key)) ||
    (current !== null && (record.seq >= current.seq || p.afterCaptureId === current.id)) ||
    ![
      'selectionSame',
      'sameCurrency',
      'currency',
      'beforeTotal',
      'afterTotal',
      'disclosure',
      'beforeDisclosure',
      'afterDisclosure',
    ].every((key) => p[key] === null)
  )
    return false;
  const before = records.find((item) => item.id === p.beforeCaptureId);
  const after = records.find((item) => item.id === p.afterCaptureId);
  const action = records.find((item) => item.id === p.actionId);
  if (
    !before ||
    !after ||
    !action ||
    before.kind !== 'capture' ||
    after.kind !== 'capture' ||
    before.author !== 'browser' ||
    after.author !== 'browser' ||
    typeof before.payload.url !== 'string' ||
    (!anyInput && before.payload.url !== after.payload.url) ||
    (anyInput && (before.payload.stable !== true || after.payload.stable !== true)) ||
    action.kind !== 'action' ||
    action.author !== 'browser' ||
    action.payload.method !== 'actual_keyboard_or_browser' ||
    action.payload.outcome !== 'performed' ||
    action.payload.sourceCaptureId !== before.id ||
    action.payload.sourceImageHash !== before.payload.imageHash ||
    !(before.seq < action.seq && action.seq < after.seq && after.seq < record.seq) ||
    (!anyInput &&
      (action.payload.action?.kind !== 'press' ||
        !['Tab', 'Shift+Tab', 'Alt+Tab', 'Alt+Shift+Tab'].includes(action.payload.action.key))) ||
    record.sources.length !== 5 ||
    ![before.id, after.id, action.id].every((id) => record.sources.includes(id))
  )
    return false;
  try {
    const chain = originalClosure(records, [record.id]);
    const contexts = chain.filter(
      (item) =>
        record.sources.includes(item.id) &&
        item.kind === 'observation' &&
        item.payload.method === 'journey_context',
    );
    if (contexts.length !== 2) return false;
    for (const capture of [before, after]) {
      const matching = contexts.filter((item) => item.payload.sourceCaptureId === capture.id);
      if (matching.length !== 1) return false;
      const context = matching[0]!;
      const value = context.payload;
      if (
        context.author !== 'browser' ||
        value.version !== JOURNEY_EVIDENCE_VERSION ||
        value.stable !== true ||
        value.limit !== JOURNEY_CONTEXT_LIMIT ||
        value.sourceCaptureHash !== capture.hash ||
        value.sourceImageHash !== capture.payload.imageHash ||
        context.sources.length !== 1 ||
        context.sources[0] !== capture.id ||
        Object.keys(value).some(
          (key) =>
            ![
              'method',
              'version',
              'stable',
              'sourceCaptureId',
              'sourceCaptureHash',
              'sourceImageHash',
              'data',
              'limit',
              '_sourcesHash',
            ].includes(key),
        )
      )
        return false;
      const parsed = journeyDataSchema.safeParse(value.data);
      if (
        !parsed.success ||
        parsed.data.commerce !== null ||
        parsed.data.choices.length !== 0 ||
        parsed.data.choicesComplete !== true ||
        parsed.data.limits.some((limit) => limit !== UNRECOGNISED_BUNDLE_LIMIT)
      )
        return false;
    }
    return true;
  } catch {
    // A missing/changed dependency must still refuse the request, not disappear from it.
    return false;
  }
}

export function requestEvidence(
  store: Store,
  runId: string,
  role: Exclude<Role, 'sam'>,
  current: RecordEntry,
  throughSeq?: number,
) {
  const records = store.records(runId);
  if (current.runId !== runId || current.kind !== 'capture')
    throw Error('Requests need an original current screen from this run.');
  // A screen checked on the analysis track reads the walk as it stood when the screen was
  // handed over, not the robot's later steps; claims and reviews are still read in full.
  const walked =
    throughSeq === undefined ? records : records.filter((record) => record.seq <= throughSeq);
  const candidates = records.filter((r) => r.kind === 'candidate');
  let roots: string[] = [current.id];
  if (role === 'reviewer') roots.push(...candidates.map((r) => r.id));
  else if (role === 'analyst') {
    // Owner, 30 Oct: the analyst reads the screens a customer sees on the strip: the screen
    // being checked and, after an input on that same page, the screen just before it (the
    // cookie pop-up before it was dismissed). Earlier pictures come only with a recorded
    // change between them (below) or a control Tab never reached. Everything else stays in
    // the written record of the walk.
    const lastAction = walked.findLast((r) => r.kind === 'action');
    const before = lastAction && records.find((r) => r.id === lastAction.payload.sourceCaptureId);
    const tabMove =
      lastAction?.payload.action?.kind === 'press' &&
      ['Tab', 'Shift+Tab', 'Alt+Tab', 'Alt+Shift+Tab'].includes(lastAction.payload.action.key);
    if (
      lastAction &&
      before?.kind === 'capture' &&
      before.payload.url === current.payload.url &&
      !tabMove
    )
      roots.push(lastAction.id);
    // A recorded price or choice change between screens keeps both screens (latest two).
    roots.push(
      ...walked
        .filter(
          (r) =>
            r.kind === 'observation' &&
            r.payload.method === 'comparable_totals' &&
            !emptyEarlierTraversal(r, null, records, true),
        )
        .slice(-2)
        .map((r) => r.id),
    );
    // A control Tab never reached is measured keyboard evidence, still owed to the journey.
    roots.push(
      ...walked
        .filter(
          (r) =>
            r.kind === 'observation' &&
            r.payload.method === 'keyboard_reach/1' &&
            r.payload.reached === false,
        )
        .slice(-2)
        .map((r) => r.id),
    );
  }
  let originals = originalClosure(records, roots);
  if (role !== 'driver') {
    const selectedCaptures = new Set(
      originals.filter((record) => record.kind === 'capture').map((record) => record.id),
    );
    const requiredIds = new Set(originals.map((record) => record.id));
    // Read attached measurements and reader results with their entire original source
    // graph. A return comparison, for example, also needs the earlier typed-entry baseline.
    // Select attachments from this request's original pictures only: a historical source
    // is not an instruction to add unrelated observations from that historical screen.
    const attached = walked.filter(
      (record) =>
        ['observation', 'at_check', 'criterion_scope'].includes(record.kind) &&
        record.sources.some((id) => selectedCaptures.has(id)) &&
        // An input that changed nothing brings no picture to the analyst or reviewer; a
        // saved claim that cites one still keeps it (requiredIds).
        !(!requiredIds.has(record.id) && emptyEarlierTraversal(record, null, records, true)),
    );
    const available = attached.filter((record) => {
      if (record.kind !== 'observation' || record.payload.stable !== false) return true;
      const pending = [record];
      const checked = new Set<string>();
      while (pending.length) {
        const original = pending.pop()!;
        if (checked.has(original.id)) continue;
        if (original.runId !== runId || !recordIsIntact(original))
          throw Error('Required original evidence is missing or changed.');
        checked.add(original.id);
        for (const id of original.sources) {
          const dependency = records.find((item) => item.id === id);
          if (!dependency) throw Error('Required original evidence is missing or changed.');
          pending.push(dependency);
        }
      }
      // Retain the raw original in the pool, but never offer a moving-page measurement
      // as a usable fact. Mandatory cited dependencies still refuse in originalClosure.
      if (
        !records.some(
          (limit) => limit.kind === 'limit' && limit.payload.unavailableObservationId === record.id,
        )
      )
        store.append(
          runId,
          'limit',
          'browser',
          {
            state: 'INCONCLUSIVE',
            reason:
              'A measurement changed while it was collected. Its raw original is retained but excluded from usable evidence; the required check remains unknown.',
            unavailableObservationId: record.id,
          },
          [record.id],
        );
      return false;
    });
    originals = originalClosure(records, [...roots, ...available.map((record) => record.id)]);
  }
  const captureIds = new Set(originals.filter((r) => r.kind === 'capture').map((r) => r.id));
  // Analysis/review supply all required originals. The provider's documented
  // image bound is separate from the counted context and spending admission.
  if (captureIds.size > (role === 'driver' ? 1 : PROVIDER_IMAGE_LIMIT))
    throw new EvidenceRequestLimit(role);
  if (role === 'reviewer') {
    // A focused check can create a new current picture after the analyst has proposed
    // criteria. Keep those exact proposals with their own originals, without displacing
    // mandatory finding evidence or exceeding the existing request bounds.
    const selectedIds = new Set(originals.map((record) => record.id));
    const omit = (proposal: RecordEntry, reason: string) => {
      if (
        records.some(
          (record) =>
            record.kind === 'limit' &&
            record.author === 'reviewer' &&
            record.payload.method === 'criterion_review_selection' &&
            record.payload.proposalId === proposal.id &&
            record.payload.proposalHash === proposal.hash &&
            record.payload.checkpointCaptureId === current.id &&
            record.payload.reason === reason,
        )
      )
        return;
      store.append(
        runId,
        'limit',
        'reviewer',
        {
          method: 'criterion_review_selection',
          state: 'INCONCLUSIVE',
          proposalId: proposal.id,
          proposalHash: proposal.hash,
          checkpointCaptureId: current.id,
          reason,
        },
        [current.id],
      );
    };
    let selectedProposals = 0;
    for (const proposal of records
      .filter((record) => record.kind === 'criterion_proposal')
      .reverse()) {
      if (selectedProposals === 5) {
        omit(
          proposal,
          'This checkpoint already supplies five newer criterion proposals. This exact proposal remains unassessed here.',
        );
        continue;
      }
      let closure: RecordEntry[];
      try {
        closure = originalClosure(records, [proposal.id]);
        const analystRead = records.find((record) => record.id === proposal.payload.readSnapshotId);
        if (
          !analystRead ||
          analystRead.kind !== 'read_snapshot' ||
          analystRead.author !== 'analyst' ||
          !recordIsIntact(analystRead) ||
          !readHashMatches(analystRead, proposal.payload.readSnapshotHash) ||
          analystRead.seq >= proposal.seq ||
          !Array.isArray(analystRead.payload.records) ||
          closure.some(
            (record) =>
              record.id !== proposal.id &&
              (record.seq >= analystRead.seq ||
                !analystRead.payload.records.some(
                  (pin: any) =>
                    pin.id === record.id &&
                    pin.hash === record.hash &&
                    JSON.stringify(pin.sources) === JSON.stringify(record.sources),
                )),
          )
        )
          throw Error('The proposal no longer matches its original analyst read.');
        for (const capture of closure.filter((record) => record.kind === 'capture'))
          if (!captureIds.has(capture.id)) store.image(runId, capture.payload.imageFile);
      } catch {
        // Missing or changed optional evidence cannot prevent review of intact existing findings.
        omit(
          proposal,
          'Required original criterion evidence is missing, changed or unstable. This exact proposal remains unassessed here.',
        );
        continue;
      }
      const addedCaptures = closure
        .filter((record) => record.kind === 'capture')
        .map((record) => record.id);
      if (new Set([...captureIds, ...addedCaptures]).size > PROVIDER_IMAGE_LIMIT) {
        omit(
          proposal,
          'Required original criterion pictures exceed this checkpoint image allowance. This exact proposal remains unassessed here.',
        );
        continue;
      }
      for (const record of closure)
        if (!selectedIds.has(record.id)) {
          selectedIds.add(record.id);
          originals.push(record);
        }
      for (const id of addedCaptures) captureIds.add(id);
      selectedProposals++;
    }
  }
  roots = originals.map((r) => r.id);
  // Prior claims prevent repeat proposals; they are not a substitute for original evidence.
  if (role === 'analyst')
    roots.push(...candidates.map((r) => r.id), ...reviewFeedbackIds(records, runId));
  const receipt = makeImageReceipt(originals, current.id);
  const snapshot = store.snapshot(runId, role, roots, receipt, throughSeq);
  for (const r of snapshot.records)
    if (!recordIsIntact(r)) throw Error('A selected original record changed; no request is sent.');
  suppliedImageIds(snapshot.read, snapshot.records);
  return snapshot;
}
