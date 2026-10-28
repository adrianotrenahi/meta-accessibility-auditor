import { recordIsIntact } from './store.js';
import type { RecordEntry } from './types.js';

/** Raw review history is analyst context, never original website evidence or an approval. */
export function reviewFeedbackIds(records: RecordEntry[], runId: string): string[] {
  const candidates = new Map<string, RecordEntry>();
  const ambiguous = new Set<string>();
  for (const candidate of records) {
    if (candidate.runId !== runId || candidate.kind !== 'candidate' || !recordIsIntact(candidate))
      continue;
    const previous = candidates.get(candidate.id);
    if (previous && (previous.hash !== candidate.hash || previous.seq !== candidate.seq))
      ambiguous.add(candidate.id);
    else candidates.set(candidate.id, candidate);
  }

  const selected = new Set<string>();
  for (const candidate of candidates.values()) {
    if (ambiguous.has(candidate.id)) continue;
    const reviews = records
      .filter(
        (review) =>
          review.runId === runId &&
          review.kind === 'review' &&
          review.seq > candidate.seq &&
          recordIsIntact(review) &&
          review.payload.candidateId === candidate.id &&
          review.payload.candidateHash === candidate.hash &&
          ['keep', 'rewrite', 'reject', 'unresolved'].includes(review.payload.verdict),
      )
      .sort((a, b) => a.seq - b.seq);
    const latest = reviews.at(-1);
    if (!latest) continue;
    selected.add(latest.id);
    const adverse = reviews.findLast(
      (review) =>
        review.payload.verdict !== 'keep' ||
        ['contradicted', 'unverified'].includes(review.payload.premise),
    );
    if (adverse && adverse.id !== latest.id) selected.add(adverse.id);
  }
  // These exact IDs are appended as interpretation context after original-source selection.
  // Do not follow a review's old read graph or present its reason as a new measured fact.
  return [...selected];
}
