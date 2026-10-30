import { z } from 'zod';

const id = z.string().min(1).max(200);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
/** Completion receipts only: never output, prompts, private reasoning or acceptance. */
export const metaAnalysisSchema = z.object({
  version: z.literal('recorded-analysis/1'),
  runId: id,
  completed: z.array(z.object({
    id,
    sequence: z.number().int().positive(),
    recordHash: hash,
    role: z.enum(['analyst', 'reviewer']),
    requestId: id,
    readSnapshotId: id,
    readSnapshotHash: hash,
    readSnapshotSequence: z.number().int().positive(),
    captureIds: z.array(id).min(1),
  }).strict()),
}).strict().superRefine((data, ctx) => {
  const ids = new Set<string>(), requests = new Set<string>();
  let previous = 0;
  for (const row of data.completed) {
    if (ids.has(row.id) || requests.has(row.requestId) || row.sequence <= previous ||
        row.readSnapshotSequence >= row.sequence || new Set(row.captureIds).size !== row.captureIds.length)
      ctx.addIssue({ code: 'custom', message: 'Completed analysis source identities or order disagree' });
    ids.add(row.id); requests.add(row.requestId); previous = row.sequence;
  }
});


import type { HostSnapshot } from './metaWalkHost';
import type { RecordedAnalysisAttribution } from '@/components/audits/report/reportModel';
/** The response and finding counts are separate facts; neither establishes full coverage. */
export function metaAnalysisAttribution(snapshot: HostSnapshot, sessionId: string): RecordedAnalysisAttribution {
  return {
    sessionId,
    completedAnalystResponses: snapshot.analysis ? snapshot.analysis.completed.filter((row) => row.role === 'analyst').length : null,
    completedReviewerResponses: snapshot.analysis ? snapshot.analysis.completed.filter((row) => row.role === 'reviewer').length : null,
    modelFindings: snapshot.findings.filter((row) => row.reviewProvenance === 'model').length,
    savedExamples: snapshot.findings.filter((row) => row.reviewProvenance === 'saved-example').length,
  };
}
