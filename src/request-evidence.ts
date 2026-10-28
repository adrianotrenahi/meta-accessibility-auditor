import { recordIsIntact, type Store } from './store.js';
import type { RecordEntry, Role } from './types.js';
import { reviewFeedbackIds } from './review-feedback.js';
import {
  baselineHasIndependentUse,
  makeImageReceipt,
  returnBaselineImage,
  suppliedImageIds,
  type BaselineImagePin,
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

export function requestEvidence(
  store: Store,
  runId: string,
  role: Exclude<Role, 'sam'>,
  current: RecordEntry,
) {
  const records = store.records(runId);
  if (current.runId !== runId || current.kind !== 'capture')
    throw Error('Requests need an original current screen from this run.');
  const candidates = records.filter((r) => r.kind === 'candidate');
  let roots: string[] = [current.id];
  if (role === 'reviewer') roots.push(...candidates.map((r) => r.id));
  else if (role === 'analyst') {
    const lastAction = records.findLast((r) => r.kind === 'action');
    if (lastAction) roots.push(lastAction.id);
    const otherView = records.findLast(
      (r) => r.kind === 'capture' && r.payload.url !== current.payload.url,
    );
    if (otherView) roots.push(otherView.id);
  }
  let originals = originalClosure(records, roots);
  if (role !== 'driver') {
    const selectedCaptures = new Set(
      originals.filter((record) => record.kind === 'capture').map((record) => record.id),
    );
    // Read attached measurements and reader results with their entire original source
    // graph. A return comparison, for example, also needs the earlier typed-entry baseline.
    // Select attachments from this request's original pictures only: a historical source
    // is not an instruction to add unrelated observations from that historical screen.
    const attached = records.filter(
      (record) =>
        ['observation', 'at_check', 'criterion_scope'].includes(record.kind) &&
        record.sources.some((id) => selectedCaptures.has(id)),
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
  let recordsOnly: BaselineImagePin | undefined;
  if (role === 'analyst' && captureIds.size === 4) {
    const directCaptures = new Set(
      originalClosure(records, roots)
        .filter((r) => r.kind === 'capture')
        .map((r) => r.id),
    );
    const choices = originals
      .filter((r) => r.payload.method === 'return_preservation')
      .map((r) => returnBaselineImage(originals, r.id, current.id))
      .filter(
        (item) =>
          item !== null &&
          !directCaptures.has(item.captureId) &&
          !baselineHasIndependentUse(
            [
              ...originals,
              ...candidates,
              ...records.filter((record) => record.kind === 'at_check'),
            ],
            item,
          ),
      );
    if (choices.length === 1 && choices[0]) recordsOnly = choices[0];
  }
  if (
    captureIds.size - (recordsOnly ? 1 : 0) >
    (role === 'reviewer' ? 8 : role === 'analyst' ? 3 : 1)
  )
    throw new EvidenceRequestLimit(role);
  if (role === 'reviewer') {
    // Optional criteria reuse the mandatory original pictures; they cannot enlarge the finding packet.
    const selectedIds = new Set(originals.map((record) => record.id));
    let selectedProposals = 0;
    for (const proposal of records
      .filter((record) => record.kind === 'criterion_proposal')
      .reverse()) {
      if (selectedProposals === 5) break;
      let closure: RecordEntry[];
      try {
        closure = originalClosure(records, [proposal.id]);
      } catch {
        // Missing or changed optional evidence cannot prevent review of intact existing findings.
        continue;
      }
      const addedCaptures = closure
        .filter((record) => record.kind === 'capture')
        .map((record) => record.id);
      if (addedCaptures.some((id) => !captureIds.has(id))) continue;
      for (const record of closure)
        if (!selectedIds.has(record.id)) {
          selectedIds.add(record.id);
          originals.push(record);
        }
      selectedProposals++;
    }
  }
  roots = originals.map((r) => r.id);
  // Prior claims prevent repeat proposals; they are not a substitute for original evidence.
  if (role === 'analyst')
    roots.push(...candidates.map((r) => r.id), ...reviewFeedbackIds(records, runId));
  // The omitted picture stays on disk and is verified just like the three sent originals.
  if (recordsOnly)
    for (const capture of originals.filter((r) => r.kind === 'capture'))
      store.image(runId, capture.payload.imageFile);
  if (
    recordsOnly &&
    !records.some(
      (record) =>
        record.kind === 'limit' &&
        record.payload.method === 'records_only_return_baseline' &&
        record.payload.recordsOnlyCaptureId === recordsOnly.captureId,
    )
  )
    store.append(
      runId,
      'limit',
      'browser',
      {
        method: 'records_only_return_baseline',
        state: 'NOT_TESTED',
        recordsOnlyCaptureId: recordsOnly.captureId,
        comparisonId: recordsOnly.comparisonId,
        reason:
          'A return-check request read this pre-typing baseline as an original record without supplying its picture. That request did not examine this screen visually or settle its criteria. Unsupported checks remain NOT_TESTED; any separately supported earlier assessment is unchanged.',
      },
      [recordsOnly.captureId],
    );
  const receipt = makeImageReceipt(originals, current.id, recordsOnly);
  const snapshot = store.snapshot(runId, role, roots, receipt);
  for (const r of snapshot.records)
    if (!recordIsIntact(r)) throw Error('A selected original record changed; no request is sent.');
  suppliedImageIds(snapshot.read, snapshot.records);
  return snapshot;
}
