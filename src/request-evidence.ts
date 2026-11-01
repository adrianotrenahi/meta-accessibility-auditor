import { recordIsIntact, reviewReadIsCurrent, type Store } from './store.js';
import { CRITERION_REVIEW_BATCH, MAX_FINDINGS } from './types.js';
import type { RecordEntry, Role } from './types.js';
import { reviewFeedbackIds } from './review-feedback.js';
import { INCOMPARABLE_TOTALS_LIMIT, journeyDataSchema } from './journey-evidence.js';
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

/** The fields a price comparison may carry; any other field counts as a recorded change. */
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
/** Whether a price comparison actually recorded something (owner, 31 Oct: "those are
 * different screens"). Moving to another page is not a change by itself; a choice that
 * only exists on one of the two pages is not either. Counted: a real price comparison
 * (it can prove a price result either way), a price on either side (it is copied into
 * beforeTotal/afterTotal), a choice present on both screens whose state differs, or
 * anything this check cannot read cleanly (unrecognised fields, missing or unsettled
 * contexts). */
function recordedChange(record: RecordEntry, records: RecordEntry[]) {
  const p = record.payload;
  if (record.kind !== 'observation' || p.method !== 'comparable_totals') return false;
  if (!recordIsIntact(record) || p.stable !== true || p.comparable === true) return true;
  if (Object.keys(p).some((key) => !comparisonFields.has(key))) return true;
  // Any recorded value or note beyond "not comparable" is information worth both screens.
  if (
    p.limit !== INCOMPARABLE_TOTALS_LIMIT ||
    [
      'selectionSame',
      'sameCurrency',
      'currency',
      'beforeTotal',
      'afterTotal',
      'disclosure',
      'beforeDisclosure',
      'afterDisclosure',
    ].some((key) => p[key] !== null)
  )
    return true;
  // Missing, changed or unsettled originals count, so the request refuses rather than drops them.
  const original = (id: string, kind: RecordEntry['kind']) => {
    const found = records.find((item) => item.id === id);
    return (
      !!found &&
      found.kind === kind &&
      recordIsIntact(found) &&
      (kind !== 'capture' || found.payload.stable === true)
    );
  };
  if (
    !original(p.beforeCaptureId, 'capture') ||
    !original(p.afterCaptureId, 'capture') ||
    !original(p.actionId, 'action')
  )
    return true;
  const contextOf = (captureId: string) => {
    const found = records.filter(
      (item) =>
        record.sources.includes(item.id) &&
        item.kind === 'observation' &&
        item.payload.method === 'journey_context' &&
        item.payload.sourceCaptureId === captureId,
    );
    if (found.length !== 1 || !recordIsIntact(found[0]!) || found[0]!.payload.stable !== true)
      return null;
    const parsed = journeyDataSchema.safeParse(found[0]!.payload.data);
    return parsed.success ? parsed.data : null;
  };
  const before = contextOf(p.beforeCaptureId),
    after = contextOf(p.afterCaptureId);
  if (!before || !after) return true;
  const later = new Map(after.choices.map((choice) => [choice.id, choice]));
  return before.choices.some((choice) => {
    const same = later.get(choice.id);
    return !!same && JSON.stringify(choice) !== JSON.stringify(same);
  });
}

/** What still waits for the reviewer, oldest first (owner, 1 Nov: "the reviewer should be able
 * to check all answers the analyst provides"). A check answer is judged once; one replaced by a
 * newer answer for the same check no longer counts in the report. A finding waits until it is
 * reviewed, and again when a "keep" or "unresolved" verdict has gone out of date: the report
 * shows a kept finding only while no walk evidence is newer than its review (store.published).
 * A rejected finding, or one sent back for rewriting (the rewrite is a new finding), is done. */
export function owedForReview(records: RecordEntry[]) {
  const byId = new Map(records.map((record) => [record.id, record]));
  const latestReview = new Map<string, RecordEntry>();
  for (const record of records)
    if (record.kind === 'review') latestReview.set(String(record.payload?.candidateId), record);
  const findingWaits = (candidate: RecordEntry) => {
    const review = latestReview.get(candidate.id);
    if (!review || review.payload?.candidateHash !== candidate.hash) return true;
    if (!['keep', 'unresolved'].includes(review.payload?.verdict)) return false;
    const read = byId.get(review.payload?.readSnapshotId);
    return !read || !reviewReadIsCurrent(read, records);
  };
  const judgedAnswers = new Set(
    records
      .filter((record) => record.kind === 'criterion_review')
      .map((record) => `${record.payload?.proposalId}:${record.payload?.proposalHash}`),
  );
  const newer = new Set<string>();
  const proposals = records
    .filter((record) => record.kind === 'criterion_proposal')
    .reverse()
    .filter((proposal) => {
      const check = `${proposal.payload?.scopeId}:${proposal.payload?.checkId}`;
      const replaced = newer.has(check);
      newer.add(check);
      return !replaced && !judgedAnswers.has(`${proposal.id}:${proposal.hash}`);
    })
    .reverse();
  const candidates = records.filter(
    (record) => record.kind === 'candidate' && findingWaits(record),
  );
  return { candidates, proposals };
}

/** Saved once per finding: why a waiting finding could not be put in a review. */
function noteWaitingFinding(
  store: Store,
  runId: string,
  finding: RecordEntry,
  current: RecordEntry,
  reason: string,
) {
  const records = store.records(runId);
  if (
    records.some(
      (record) =>
        record.kind === 'limit' &&
        record.payload?.method === 'finding_review_selection' &&
        record.payload?.candidateId === finding.id &&
        record.payload?.candidateHash === finding.hash,
    )
  )
    return;
  store.append(
    runId,
    'limit',
    'reviewer',
    {
      method: 'finding_review_selection',
      state: 'INCONCLUSIVE',
      candidateId: finding.id,
      candidateHash: finding.hash,
      checkpointCaptureId: current.id,
      reason,
    },
    [current.id],
  );
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
  const owedReview = role === 'reviewer' ? owedForReview(records) : undefined;
  let roots: string[] = [current.id];
  // One review judges at most MAX_FINDINGS waiting findings, oldest first, taking each only
  // while the request's pictures stay within the provider's limit (Loca, PR 73: a batch that
  // could never fit blocked every later review). One that does not fit waits for the next
  // review with a note; a finding already judged is not sent again.
  if (owedReview) {
    const pictures = (ids: string[]) =>
      originalClosure(records, ids)
        .filter((record) => record.kind === 'capture')
        .map((record) => record.id);
    const selected = new Set(pictures([current.id]));
    let taken = 0;
    for (const finding of owedReview.candidates) {
      if (taken === MAX_FINDINGS) break;
      let added: string[];
      try {
        added = pictures([finding.id]);
      } catch {
        noteWaitingFinding(store, runId, finding, current, 'Its original evidence is missing or changed, so it cannot be reviewed here.');
        continue;
      }
      if (new Set([...selected, ...added]).size > PROVIDER_IMAGE_LIMIT) {
        // One that does not fit this round simply waits for the next; one that cannot fit even
        // beside this screen alone gets a single note (it stays owed, without blocking others).
        if (new Set([...pictures([current.id]), ...added]).size > PROVIDER_IMAGE_LIMIT)
          noteWaitingFinding(store, runId, finding, current, `Its pictures and this screen's exceed the ${PROVIDER_IMAGE_LIMIT}-picture limit of one review, so it cannot be reviewed here. It stays unreviewed.`);
        continue;
      }
      for (const id of added) selected.add(id);
      roots.push(finding.id);
      taken++;
    }
  } else if (role === 'analyst') {
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
        .filter((r) => r.kind === 'observation' && recordedChange(r, records))
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
        !(
          !requiredIds.has(record.id) &&
          record.kind === 'observation' &&
          record.payload.method === 'comparable_totals' &&
          !recordedChange(record, records)
        ),
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
    // Owner, 1 Nov: the reviewer saw only the five newest proposals, counting ones it had
    // already judged, so 43 times in a Booking.com audit a proposal waited unreviewed. Every
    // proposal still owed a review is now supplied, oldest first, one batch per review.
    const owed = owedReview!.proposals;
    let selectedProposals = 0;
    for (const proposal of owed) {
      if (selectedProposals === CRITERION_REVIEW_BATCH) {
        omit(
          proposal,
          `This checkpoint already supplies ${CRITERION_REVIEW_BATCH} older criterion proposals still owed a review. This exact proposal stays owed for a later review.`,
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
