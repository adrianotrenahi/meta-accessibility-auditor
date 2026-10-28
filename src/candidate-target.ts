import { originalClosure } from './request-evidence.js';
import type { RecordEntry } from './types.js';

export function candidateOriginalEvidence(
  candidate: any,
  records: RecordEntry[],
  suppliedImageIds: string[],
) {
  const evidence = originalClosure(records, candidate.sources);
  const allowed = new Set([
    'capture',
    'observation',
    'action',
    'at_check',
    'navigator_note',
    'plan',
    'limit',
    'focused_check',
    'visual_observation',
  ]);
  if (evidence.some((record) => !allowed.has(record.kind)))
    throw Error(
      'Finding sources must be originals; review feedback and earlier claims are interpretations.',
    );
  for (const record of evidence.filter((entry) => entry.kind === 'visual_observation'))
    if (
      !candidate.visualTopic ||
      candidate.visualTopic !== record.payload.topic ||
      candidate.visiblePremise !== record.payload.visiblePremise ||
      !suppliedImageIds.includes(record.payload.captureId) ||
      !candidate.sources.includes(record.payload.captureId)
    )
      throw Error(
        'A visual interpretation needs its exact supplied image, topic and visible premise.',
      );
  return evidence;
}

export function candidateTarget(
  candidate: any,
  records: RecordEntry[],
  suppliedImageIds = records.filter((r) => r.kind === 'capture').map((r) => r.id),
) {
  const evidence = candidateOriginalEvidence(candidate, records, suppliedImageIds);
  if (!evidence.some((r) => ['capture', 'observation', 'action', 'at_check'].includes(r.kind)))
    throw Error('A claim needs original evidence, not only another claim or note.');
  if (candidate.scope === 'view') {
    if (candidate.targetId !== null || candidate.targetCaptureId !== null)
      throw Error('A view-level claim cannot invent an element target.');
    return null;
  }
  const capture = evidence.find((r) => r.kind === 'capture' && r.id === candidate.targetCaptureId);
  const elements = capture?.payload.elements ?? [];
  const matches = elements.filter((e: any) => e.id === candidate.targetId);
  if (
    !capture ||
    !suppliedImageIds.includes(capture.id) ||
    capture.payload.stable !== true ||
    matches.length !== 1
  )
    throw Error('An element claim needs one exact target in its stable original screen.');
  const target = matches[0];
  if (target.selector && elements.filter((e: any) => e.selector === target.selector).length !== 1)
    throw Error('The target identity is ambiguous in this original screen.');
  return { capture, target };
}
