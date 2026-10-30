import { recordIsIntact } from './store.js';
import type { RecordEntry } from './types.js';

// A checkpoint on the very screenshot already measured or checked, with nothing seen or
// done on the page since, would only repeat the same scan or paid analysis (owner, 30 Oct:
// two journey steps finished on one Booking.com screen spent the analyst's allowance twice).
const WALK_EVIDENCE = new Set(['capture', 'action', 'observation', 'at_check', 'focused_check']);

const newerWalkEvidence = (records: RecordEntry[], after: RecordEntry) =>
  records.some((record) => record.seq > after.seq && WALK_EVIDENCE.has(record.kind));

/** The automatic scan of this exact original, when no input or observation followed it. */
export function earlierScan(records: RecordEntry[], capture: RecordEntry) {
  const scan = records.findLast(
    (record) =>
      record.kind === 'observation' &&
      record.author === 'axe-core' &&
      record.payload.method === 'automatic_accessibility_scan' &&
      record.payload.sourceCaptureId === capture.id &&
      record.payload.sourceCaptureHash === capture.hash &&
      record.payload.stable === true,
  );
  if (!scan || !recordIsIntact(scan) || newerWalkEvidence(records, scan)) return undefined;
  return scan;
}

/** The analyst's completed coverage of this exact original, when nothing was seen or done since. */
export function earlierCheck(records: RecordEntry[], capture: RecordEntry) {
  const coverage = records.findLast(
    (record) => record.kind === 'coverage' && record.author === 'analyst',
  );
  if (
    !coverage ||
    !recordIsIntact(coverage) ||
    !Array.isArray(coverage.payload.topics) ||
    !coverage.payload.topics.some((topic: any) => topic?.captureId === capture.id) ||
    newerWalkEvidence(records, coverage)
  )
    return undefined;
  return coverage;
}
