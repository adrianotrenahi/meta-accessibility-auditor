import { z } from 'zod';
import { recordIsIntact } from './store.js';
import { suppliedImageIds } from './image-receipt.js';
import type { RecordEntry } from './types.js';

const id = z.string().min(1).max(200);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
/** Completion receipts only: never output, prompts, private reasoning or acceptance. */
export const hostAnalysisSchema = z
  .object({
    version: z.literal('recorded-analysis/1'),
    runId: id,
    completed: z.array(
      z
        .object({
          id,
          sequence: z.number().int().positive(),
          recordHash: hash,
          role: z.enum(['analyst', 'reviewer']),
          requestId: id,
          readSnapshotId: id,
          readSnapshotHash: hash,
          readSnapshotSequence: z.number().int().positive(),
          captureIds: z.array(id).min(1),
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((data, ctx) => {
    const ids = new Set<string>(),
      requests = new Set<string>();
    let previous = 0;
    for (const row of data.completed) {
      if (
        ids.has(row.id) ||
        requests.has(row.requestId) ||
        row.sequence <= previous ||
        row.readSnapshotSequence >= row.sequence ||
        new Set(row.captureIds).size !== row.captureIds.length
      )
        ctx.addIssue({
          code: 'custom',
          message: 'Completed analysis source identities or order disagree',
        });
      ids.add(row.id);
      requests.add(row.requestId);
      previous = row.sequence;
    }
  });

interface RequestReceipt {
  id: string;
  run_id: string;
  role: string;
  status: string;
  actual: number | null;
}
/** A completed provider envelope alone is insufficient: parsed-result completion must also be saved. */
export function exportHostAnalysis(
  records: RecordEntry[],
  runId: string,
  requests: RequestReceipt[],
) {
  const originals = new Map(records.map((row) => [row.id, row]));
  if (originals.size !== records.length)
    return { version: 'recorded-analysis/1' as const, runId, completed: [] };
  const completed = records
    .flatMap((record) => {
      const p = record.payload;
      if (
        record.runId !== runId ||
        record.kind !== 'model_response' ||
        !['analyst', 'reviewer'].includes(record.author) ||
        !recordIsIntact(record) ||
        p.status !== 'completed'
      )
        return [];
      const matching = requests.filter((request) => request.id === p.requestId);
      const request = matching[0],
        read = originals.get(p.readSnapshotId);
      if (
        matching.length !== 1 ||
        !request ||
        request.run_id !== runId ||
        request.role !== record.author ||
        request.status !== 'completed' ||
        !Number.isSafeInteger(request.actual) ||
        request.actual! < 0 ||
        records.filter(
          (row) => row.kind === 'model_response' && row.payload.requestId === request.id,
        ).length !== 1 ||
        !read ||
        read.runId !== runId ||
        read.kind !== 'read_snapshot' ||
        read.author !== record.author ||
        !recordIsIntact(read) ||
        read.hash !== p.readSnapshotHash ||
        read.seq >= record.seq ||
        JSON.stringify(p.imageReceipt ?? null) !== JSON.stringify(read.payload.imageReceipt ?? null)
      )
        return [];
      try {
        const captureIds = suppliedImageIds(read, records);
        if (
          !captureIds.length ||
          read.payload.records.some((pin: { id: string }) => originals.get(pin.id)!.seq >= read.seq)
        )
          return [];
        return [
          {
            id: record.id,
            sequence: record.seq,
            recordHash: record.hash,
            role: record.author as 'analyst' | 'reviewer',
            requestId: request.id,
            readSnapshotId: read.id,
            readSnapshotHash: read.hash,
            readSnapshotSequence: read.seq,
            captureIds,
          },
        ];
      } catch {
        return [];
      }
    })
    .sort((a, b) => a.sequence - b.sequence);
  return hostAnalysisSchema.parse({ version: 'recorded-analysis/1', runId, completed });
}
