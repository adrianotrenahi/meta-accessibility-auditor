import { recordIsIntact, type Store } from './store.js';
import type { RecordEntry, Role } from './types.js';

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
  const originals = originalClosure(records, roots);
  const captureIds = new Set(originals.filter((r) => r.kind === 'capture').map((r) => r.id));
  if (captureIds.size > (role === 'reviewer' ? 8 : role === 'analyst' ? 3 : 1))
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
  // Measurements and reader results for the selected originals are read directly too.
  for (const r of records)
    if (
      role !== 'driver' &&
      ['observation', 'at_check', 'criterion_scope'].includes(r.kind) &&
      r.sources.some((id) => captureIds.has(id))
    )
      roots.push(r.id);
  // Prior claims prevent repeat proposals; they are not a substitute for original evidence.
  if (role === 'analyst') roots.push(...candidates.map((r) => r.id));
  const snapshot = store.snapshot(runId, role, roots);
  for (const r of snapshot.records)
    if (!recordIsIntact(r)) throw Error('A selected original record changed; no request is sent.');
  return snapshot;
}
