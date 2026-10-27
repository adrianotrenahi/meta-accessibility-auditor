import { originalClosure } from './request-evidence.js';
import type { RecordEntry } from './types.js';

export function candidateTarget(candidate: any, records: RecordEntry[]) {
  const evidence = originalClosure(records, candidate.sources);
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
  if (!capture || capture.payload.stable !== true || matches.length !== 1)
    throw Error('An element claim needs one exact target in its stable original screen.');
  const target = matches[0];
  if (target.selector && elements.filter((e: any) => e.selector === target.selector).length !== 1)
    throw Error('The target identity is ambiguous in this original screen.');
  return { capture, target };
}
