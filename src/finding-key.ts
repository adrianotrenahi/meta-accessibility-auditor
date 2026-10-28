import type { RecordEntry } from './types.js';
import { validControlInstance } from './control-identity.js';

const fingerprint = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const ownControlId = (value: unknown) =>
  typeof value === 'string' &&
  /^#(?:\\[0-9a-fA-F]{1,6}[ \t\r\n\f]?|\\[^\r\n\f]|[A-Za-z0-9_-]|[^\u0000-\u007f])+$/u.test(value);

function originalTarget(candidate: RecordEntry, records: RecordEntry[]) {
  const capture = records.find(
    (r) =>
      r.id === candidate.payload.targetCaptureId &&
      r.kind === 'capture' &&
      r.runId === candidate.runId,
  );
  return {
    capture,
    target: capture?.payload.elements.find((e: any) => e.id === candidate.payload.targetId),
  };
}

function namingInstance(candidate: RecordEntry, target: any) {
  return (
    candidate.payload.scope === 'element' &&
    candidate.payload.criterion === 'C02' &&
    target?.tag === 'button' &&
    ownControlId(target.selector) &&
    target.role === 'button' &&
    target.name === '' &&
    validControlInstance(target.controlInstance) &&
    fingerprint(target.controlFingerprint)
  );
}

/** Only group reviewed claims sharing a declared problem and an original target identity. */
export function findingKey(candidate: RecordEntry, records: RecordEntry[]) {
  const c = candidate.payload;
  if (!c.issueKey) return candidate.id; // Earlier retained examples keep their original meaning.
  if (c.scope === 'view' && candidate.sources.length)
    return JSON.stringify([
      'view',
      c.issueKey,
      c.criterion,
      [...new Set(candidate.sources)].sort(),
    ]);
  const { capture, target } = originalTarget(candidate, records);
  if (c.scope === 'element' && capture && target?.selector) {
    // A list position or an ancestor's ID does not identify a persistent control.
    // Legacy captures still require the surrounding HTML. New captures additionally distinguish
    // actual DOM nodes. Only a repeated empty-name button can survive an outside context change.
    const ownId = ownControlId(target.selector);
    const context = fingerprint(target.contextFingerprint) ? target.contextFingerprint : null;
    const hasIdentity = 'controlInstance' in target || 'controlFingerprint' in target;
    const validIdentity =
      validControlInstance(target.controlInstance) && fingerprint(target.controlFingerprint);
    const repeatedName = ownId && namingInstance(candidate, target);
    const identity = hasIdentity
      ? ownId && validIdentity && (repeatedName || context)
        ? [
            'control-instance-v1',
            candidate.runId,
            target.controlInstance,
            target.controlFingerprint,
            repeatedName ? ['empty-name-button', c.severity] : ['context', context],
          ]
        : ['exact-capture', capture.id, target.id]
      : ownId && context
        ? ['own-id-and-context', context]
        : ['exact-capture', capture.id, target.id];
    return JSON.stringify([
      'element',
      c.issueKey,
      c.criterion,
      identity,
      capture.payload.url,
      target.selector,
      target.tag,
      target.role,
      target.name,
      target.text,
      target.type,
    ]);
  }
  // Missing original identity cannot be replaced by a shared URL or similar wording.
  return candidate.id;
}

export function groupPublished(findings: any[], records: RecordEntry[]) {
  const groups = new Map<string, any>();
  for (const finding of findings) {
    const candidate = records.find((r) => r.id === finding.id)!;
    const key = findingKey(candidate, records);
    const prior = groups.get(key);
    if (prior) {
      const occurrenceIds = [...prior.occurrenceIds, finding.id];
      const evidence = [...new Set([...prior.evidence, ...finding.evidence])];
      const { target } = originalTarget(candidate, records);
      const priorCandidate = records.find((r) => r.id === prior.id)!;
      // Keep one complete accepted claim/review. Legacy groups retain the first claim;
      // a new empty-name group uses the latest accepted original to support live pins.
      const representative =
        namingInstance(candidate, target) && candidate.seq > priorCandidate.seq ? finding : prior;
      groups.set(key, { ...representative, occurrenceIds, evidence });
    } else groups.set(key, { ...finding, occurrenceIds: [finding.id] });
  }
  return [...groups.values()];
}
