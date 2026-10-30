import { z } from 'zod';
const id = z.string().min(1).max(200);
const step = z.object({
  id: z.string().min(1).max(80), text: z.string().trim().min(1).max(500),
  intent: z.enum(['navigate', 'search', 'form', 'explore', 'verify', 'complete']).optional(),
  success: z.string().trim().min(1).max(500).optional(), hint: z.string().max(500).optional(),
  optional: z.boolean().optional(),
}).strict();
export const metaJourneyStepsSchema = z.array(step).min(1).max(12).refine((steps) =>
  new Set(steps.map((item) => item.id)).size === steps.length);
export const metaJourneySchema = z.object({
  version: z.literal('ordered-journey-progress/1'),
  runId: id, planId: id, planHash: z.string().regex(/^[a-f0-9]{64}$/),
  steps: metaJourneyStepsSchema,
  currentStepId: z.string().nullable(),
  completed: z.array(z.object({
    stepId: z.string().min(1).max(80), captureId: id,
    recordId: id, recordHash: z.string().regex(/^[a-f0-9]{64}$/),
    sequence: z.number().int().positive(),
    meaning: z.literal('navigator-recorded-completion'),
  }).strict()).max(12),
}).strict().superRefine((journey, context) => {
  const next = journey.steps[journey.completed.length]?.id ?? null;
  if (journey.completed.length > journey.steps.length || journey.currentStepId !== next)
    context.addIssue({ code: 'custom', message: 'The current instruction does not match recorded progress.' });
  let previous = 0;
  const records = new Set<string>();
  for (const [index, completed] of journey.completed.entries()) {
    if (journey.steps[index]?.id !== completed.stepId || completed.sequence <= previous ||
      records.has(completed.recordId))
      context.addIssue({ code: 'custom', message: 'Recorded instructions are out of order.' });
    previous = completed.sequence; records.add(completed.recordId);
  }
});
export type MetaJourney = z.infer<typeof metaJourneySchema>;
export function metaJourneyFits(journey: MetaJourney, snapshot: {
  run: { id: string }; captures: { id: string; sequence: number; imageAvailable: boolean; stable: boolean }[];
}) {
  return journey.runId === snapshot.run.id && journey.completed.every((row) =>
    snapshot.captures.some((capture) => capture.id === row.captureId &&
      capture.sequence < row.sequence && capture.imageAvailable && capture.stable),
  );
}
const stepValues = (steps: MetaJourney['steps']) => steps.map((item) =>
  [item.id, item.text, item.intent, item.success, item.hint ?? '', item.optional ?? false]);
/** The host may show only progress for the exact steps approved in this setup.
 * A completed instruction remains navigator progress, never a criterion PASS. */
export function metaJourneyProgress(journey: MetaJourney | undefined, approved: unknown) {
  if (!journey) return null;
  const parsed = z.array(step).min(1).max(12).safeParse(approved);
  if (!parsed.success || JSON.stringify(stepValues(parsed.data)) !== JSON.stringify(stepValues(journey.steps)))
    return null;
  const completed = new Set(journey.completed.map((row) => row.stepId));
  return {
    currentStep: journey.currentStepId ? journey.steps.findIndex((item) => item.id === journey.currentStepId) + 1 : journey.steps.length,
    // The existing Cavioo list chooses the first pending instruction while
    // the run is active. A separate running value would skip that row.
    status: (stepId: string) => completed.has(stepId) ? 'done' as const : 'pending' as const,
  };
}
