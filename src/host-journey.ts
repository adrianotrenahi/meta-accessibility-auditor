import { z } from 'zod';
import { approvedJourneyPlanSchema, readOrderedJourney } from './journey-steps.js';
import type { RecordEntry } from './types.js';
const id = z.string().min(1).max(200),
  hash = z.string().regex(/^[a-f0-9]{64}$/);
export const hostJourneySchema = z
  .object({
    version: z.literal('ordered-journey-progress/1'),
    runId: id,
    planId: id,
    planHash: hash,
    steps: approvedJourneyPlanSchema.shape.steps,
    currentStepId: z.string().nullable(),
    completed: z
      .array(
        z
          .object({
            stepId: z.string().min(1).max(80),
            captureId: id,
            recordId: id,
            recordHash: hash,
            sequence: z.number().int().positive(),
            meaning: z.literal('navigator-recorded-completion'),
          })
          .strict(),
      )
      .max(12),
  })
  .strict()
  .superRefine((journey, context) => {
    const next = journey.steps[journey.completed.length]?.id ?? null;
    if (journey.completed.length > journey.steps.length || journey.currentStepId !== next)
      context.addIssue({
        code: 'custom',
        message: 'Journey progress skipped its current instruction.',
      });
    let previous = 0;
    const records = new Set<string>();
    for (const [index, completed] of journey.completed.entries()) {
      if (
        journey.steps[index]?.id !== completed.stepId ||
        completed.sequence <= previous ||
        records.has(completed.recordId)
      )
        context.addIssue({
          code: 'custom',
          message: 'Journey instructions are not in their approved order.',
        });
      previous = completed.sequence;
      records.add(completed.recordId);
    }
  });
export type HostJourney = z.infer<typeof hostJourneySchema>;

export function journeyProgressFits(
  journey: HostJourney,
  snapshot: {
    run: { id: string };
    captures: {
      id: string;
      sequence: number;
      imageAvailable: boolean;
      stable: boolean;
    }[];
  },
) {
  return (
    journey.runId === snapshot.run.id &&
    journey.completed.every((row) =>
      snapshot.captures.some(
        (capture) =>
          capture.id === row.captureId &&
          capture.sequence < row.sequence &&
          capture.imageAvailable &&
          capture.stable,
      ),
    )
  );
}
export function exportHostJourney(records: RecordEntry[], runId: string) {
  const journey = readOrderedJourney(records);
  if (!journey) return undefined;
  if (!records.some((record) => record.id === journey.planId && record.runId === runId))
    throw Error('Journey progress belongs to a different run.');
  return hostJourneySchema.parse({
    version: 'ordered-journey-progress/1',
    runId,
    planId: journey.planId,
    planHash: journey.planHash,
    steps: journey.steps,
    currentStepId: journey.steps[journey.currentIndex]?.id ?? null,
    completed: journey.completed.map((item) => {
      const record = records.find((record) => record.id === item.recordId)!;
      return {
        stepId: item.stepId,
        captureId: item.captureId,
        recordId: record.id,
        recordHash: record.hash,
        sequence: record.seq,
        meaning: 'navigator-recorded-completion',
      };
    }),
  });
}
