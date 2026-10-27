import type { RecordEntry } from './types.js';

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
  const capture = records.find((r) => r.id === c.targetCaptureId && r.kind === 'capture');
  const target = capture?.payload.elements.find((e: any) => e.id === c.targetId);
  if (c.scope === 'element' && capture && target?.selector)
    return JSON.stringify([
      'element',
      c.issueKey,
      c.criterion,
      capture.payload.url,
      target.selector,
      target.tag,
      target.role,
      target.name,
      target.text,
      target.type,
    ]);
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
      prior.occurrenceIds.push(finding.id);
      prior.evidence = [...new Set([...prior.evidence, ...finding.evidence])];
    } else groups.set(key, { ...finding, occurrenceIds: [finding.id] });
  }
  return [...groups.values()];
}
