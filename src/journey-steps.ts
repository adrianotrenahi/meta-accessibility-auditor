import { z } from 'zod';
import { journeyStepSchema } from './public-target.js';
import { digest, recordIsIntact, type Store } from './store.js';
import type { RecordEntry } from './types.js';

export const ORDERED_JOURNEY_VERSION = 'ordered-journey/1' as const;
export const plannedStepSchema = journeyStepSchema
  .extend({
    intent: z.enum(['navigate', 'search', 'form', 'explore', 'verify', 'complete']),
    success: z.string().trim().min(1).max(500),
  })
  .strict();
export const journeyPlanSchema = z
  .object({
    steps: z
      .array(plannedStepSchema)
      .min(2)
      .max(12)
      .refine(
        (steps) => new Set(steps.map((step) => step.id)).size === steps.length,
        'Each instruction needs a different identity.',
      )
      .refine(
        (steps) =>
          steps.every(
            (step) => !/^follow the journey described above(?:[,\s.]|$)/i.test(step.text.trim()),
          ),
        'A generated plan must break down the task rather than return the old whole-brief placeholder.',
      ),
  })
  .strict();
export type JourneyStep = z.infer<typeof plannedStepSchema>;
export const approvedJourneyPlanSchema = z
  .object({
    steps: z
      .array(plannedStepSchema)
      .min(1)
      .max(12)
      .refine(
        (steps) => new Set(steps.map((step) => step.id)).size === steps.length,
        'Each approved instruction needs a different identity.',
      ),
  })
  .strict();

export interface OrderedJourney {
  version: typeof ORDERED_JOURNEY_VERSION;
  planId: string;
  planHash: string;
  steps: JourneyStep[];
  completed: { stepId: string; captureId: string; recordId: string }[];
  currentIndex: number;
}

/** Completion here is a navigator claim tied to its original, never a criterion
 * PASS, a confirmed booking, or proof that a model understood the website. */
export function readOrderedJourney(records: RecordEntry[]): OrderedJourney | null {
  const plans = records.filter(
    (record) =>
      record.kind === 'plan' && record.payload.executionVersion === ORDERED_JOURNEY_VERSION,
  );
  if (plans.length > 1) throw Error('The run has more than one approved execution plan.');
  const plan = plans[0];
  if (!plan) return null;
  if (!recordIsIntact(plan)) throw Error('The approved journey plan changed.');
  const parsed = approvedJourneyPlanSchema.parse({ steps: plan.payload.steps });
  const completed: OrderedJourney['completed'] = [];
  for (const record of records) {
    if (record.kind !== 'navigator_note' || record.payload.kind !== 'step_completed') continue;
    if (record.payload.version !== ORDERED_JOURNEY_VERSION) continue;
    if (
      !recordIsIntact(record) ||
      record.runId !== plan.runId ||
      record.author !== 'driver' ||
      record.payload.planId !== plan.id ||
      record.payload.planHash !== plan.hash
    )
      throw Error('Journey progress does not match its approved plan.');
    const expected = parsed.steps[completed.length];
    const capture = records.find((source) => source.id === record.payload.captureId);
    if (
      !expected ||
      record.payload.stepId !== expected.id ||
      !capture ||
      capture.kind !== 'capture' ||
      capture.runId !== plan.runId ||
      capture.seq <= plan.seq ||
      capture.seq >= record.seq ||
      !recordIsIntact(capture) ||
      record.payload.captureHash !== capture.hash ||
      record.sources.length !== 2 ||
      !record.sources.includes(plan.id) ||
      !record.sources.includes(capture.id)
    )
      throw Error('A completed instruction has no exact original evidence or is out of order.');
    completed.push({ stepId: expected.id, captureId: capture.id, recordId: record.id });
  }
  return {
    version: ORDERED_JOURNEY_VERSION,
    planId: plan.id,
    planHash: plan.hash,
    steps: parsed.steps,
    completed,
    currentIndex: completed.length,
  };
}

export function currentJourneyInstruction(journey: OrderedJourney) {
  const step = journey.steps[journey.currentIndex];
  return {
    version: journey.version,
    planId: journey.planId,
    planHash: journey.planHash,
    completedStepIds: journey.completed.map((item) => item.stepId),
    currentStep: step ? { ...step, position: journey.currentIndex + 1 } : null,
    totalSteps: journey.steps.length,
    boundary:
      'Work only on the current instruction. Completing it is not a criterion PASS. Stop before booking, purchase, login, account creation, personal details or payment.',
  };
}

/** Recording a step never sends another browser input or changes its screenshot. */
export function completeJourneyInstruction(
  store: Store,
  runId: string,
  stepId: string,
  captureId: string,
  current: RecordEntry,
) {
  if (store.run(runId).state !== 'running') throw Error('The journey has stopped.');
  const records = store.records(runId);
  const journey = readOrderedJourney(records);
  const step = journey?.steps[journey.currentIndex];
  const saved = records.find((record) => record.id === current.id);
  if (
    !journey ||
    !step ||
    step.id !== stepId ||
    captureId !== current.id ||
    current.runId !== runId ||
    current.kind !== 'capture' ||
    !recordIsIntact(current) ||
    !saved ||
    saved.seq !== current.seq ||
    JSON.stringify(saved.sources) !== JSON.stringify(current.sources) ||
    records.filter((record) => record.kind === 'capture').at(-1)?.id !== current.id ||
    saved.hash !== current.hash ||
    digest(JSON.stringify(saved.payload)) !== current.hash ||
    !recordIsIntact(saved) ||
    saved.payload.stable !== true
  )
    throw Error(
      'Only the current instruction and its fresh stable original can be marked complete.',
    );
  return store.append(
    runId,
    'navigator_note',
    'driver',
    {
      kind: 'step_completed',
      version: ORDERED_JOURNEY_VERSION,
      planId: journey.planId,
      planHash: journey.planHash,
      stepId,
      captureId,
      captureHash: saved.hash,
      meaning:
        'The navigator recorded this instruction as complete against the cited original. Accessibility coverage remains independently assessed.',
    },
    [journey.planId, current.id],
  );
}
