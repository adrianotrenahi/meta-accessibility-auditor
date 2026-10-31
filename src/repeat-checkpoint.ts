import { recordIsIntact } from './store.js';
import type { RecordEntry } from './types.js';

// A checkpoint on the very screenshot already measured or checked, with nothing seen or
// done on the page since, would only repeat the same scan or paid analysis (owner, 30 Oct:
// two journey steps finished on one Booking.com screen spent the analyst's allowance twice).
const WALK_EVIDENCE = new Set(['capture', 'action', 'observation', 'at_check', 'focused_check']);

// A check first reads the page's journey context for its own screenshot. A settled read of
// that same screenshot adds nothing new about the page; an unsettled one is real news.
const ownContextRead = (record: RecordEntry, capture: RecordEntry) =>
  record.kind === 'observation' &&
  record.author === 'browser' &&
  record.payload.method === 'journey_context' &&
  record.payload.stable === true &&
  record.payload.sourceCaptureId === capture.id &&
  record.payload.sourceCaptureHash === capture.hash;

/** A screenshot, input, measurement or check about this screen saved after this point. */
export const walkEvidenceSince = (records: RecordEntry[], seq: number, capture: RecordEntry) =>
  records.some(
    (record) =>
      record.seq > seq && WALK_EVIDENCE.has(record.kind) && !ownContextRead(record, capture),
  );
const newerWalkEvidence = (records: RecordEntry[], after: RecordEntry, capture: RecordEntry) =>
  walkEvidenceSince(records, after.seq, capture);

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
  if (!scan || !recordIsIntact(scan) || newerWalkEvidence(records, scan, capture)) return undefined;
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
    newerWalkEvidence(records, coverage, capture)
  )
    return undefined;
  return coverage;
}

const pageOf = (url: unknown) => {
  try {
    const parsed = new URL(String(url));
    return parsed.origin + parsed.pathname;
  } catch {
    return undefined;
  }
};

/** A settled automatic scan of the same page, taken on an earlier screenshot. Owner, 31 Oct:
 * the page check runs once per page, not after every step (two steps finished on Booking.com's
 * home page each waited 12 s for it). The page is its address without the query or fragment,
 * so Booking's changing tracking parameters do not make a new page. */
export function earlierPageScan(records: RecordEntry[], capture: RecordEntry) {
  const page = pageOf(capture.payload.url);
  if (!page) return undefined;
  return records.findLast((record) => {
    if (
      record.kind !== 'observation' ||
      record.author !== 'axe-core' ||
      record.payload.method !== 'automatic_accessibility_scan' ||
      record.payload.stable !== true ||
      !recordIsIntact(record)
    )
      return false;
    const source = records.find((item) => item.id === record.payload.sourceCaptureId);
    return (
      source?.kind === 'capture' &&
      source.hash === record.payload.sourceCaptureHash &&
      pageOf(source.payload.url) === page
    );
  });
}
