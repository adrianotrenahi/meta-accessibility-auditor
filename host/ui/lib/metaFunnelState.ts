import { z } from "zod";
import { applyHostSnapshot, hostSnapshotSchema } from "./metaWalkHost";
import { metaJourneyStepsSchema } from "./metaJourney";
import { acceptMetaAssessment, type MetaAssessment } from "./metaAssessment";
import {
  KEYBOARD_RECORDS_UNAVAILABLE,
  readOptionalMetaKeyboardEvidence,
  type MetaKeyboardEvidence,
} from "./metaKeyboardEvidence";

const pendingStartSchema = z.object({
  url: z.string().url().refine((value) => /^https?:\/\//.test(value)),
  goal: z.string().min(1).max(1500),
  steps: metaJourneyStepsSchema,
}).strict();
export const metaPendingStartsSchema = z.object({
  pendingStarts: z.array(pendingStartSchema.extend({ jobId: z.string().uuid() }).strict()),
}).strict();
const jobSchema = z.object({
  jobId: z.string().uuid(),
  snapshot: hostSnapshotSchema.optional(),
  pendingStart: pendingStartSchema.optional(),
  keyboard: z.unknown().optional(),
  keyboardWarning: z.string().max(500).optional(),
  assessment: z.unknown().optional(),
  assessmentWarning: z.string().max(500).optional(),
  waiting: z.boolean().optional(),
  deleted: z.boolean().optional(),
  discarding: z.boolean().optional(),
  discardError: z.string().nullable().optional(),
});
export type MetaFunnelJob = Omit<
  z.infer<typeof jobSchema>,
  "keyboard" | "assessment"
> & {
  keyboard?: MetaKeyboardEvidence;
  // Local comparison only. It is cleared on discard and is never supplied by the host.
  keyboardSeen?: { sequence: number; json: string };
  assessment?: MetaAssessment;
  assessmentSeen?: { sequence: number; json: string };
};

/** Saved reads cannot rewind reviews, replace originals or resurrect discarded evidence. */
export function acceptMetaFunnelJob(
  current: MetaFunnelJob | null,
  incoming: unknown,
  jobId: string,
): MetaFunnelJob {
  const next = jobSchema.parse(incoming);
  if (next.jobId !== jobId || (current && current.jobId !== jobId))
    throw Error("This saved response belongs to a different local run.");
  if (current?.deleted) return current;
  if (!next.deleted && current?.pendingStart && next.pendingStart &&
    JSON.stringify(current.pendingStart) !== JSON.stringify(next.pendingStart))
    throw Error("The original saved Start instructions changed.");
  if (next.deleted || next.discarding)
    return {
      ...next,
      snapshot: undefined,
      pendingStart: next.deleted || current?.snapshot ? undefined : next.pendingStart ?? current?.pendingStart,
      keyboard: undefined,
      keyboardSeen: undefined,
      keyboardWarning: undefined,
      assessment: undefined,
      assessmentSeen: undefined,
      assessmentWarning: undefined,
      waiting: false,
    };
  if (current?.discarding) return current;
  if (next.pendingStart) {
    if (next.snapshot) throw Error("An unconfirmed Start cannot also claim original run records.");
    if (current?.snapshot) return current;
    if (current?.pendingStart && JSON.stringify(current.pendingStart) !== JSON.stringify(next.pendingStart))
      throw Error("The original saved Start instructions changed.");
    return { ...next, keyboard: undefined, assessment: undefined, waiting: false };
  }
  if (!next.snapshot)
    throw Error("The original local run records are unavailable.");
  const snapshot = applyHostSnapshot(current?.snapshot, next.snapshot);
  if (current?.snapshot && next.snapshot.sequence < current.snapshot.sequence)
    return current;
  const assessment = acceptMetaAssessment(
    current,
    next.assessment,
    snapshot,
    !!next.assessmentWarning,
  );
  const optional = next.keyboardWarning
    ? { warning: KEYBOARD_RECORDS_UNAVAILABLE, keyboard: undefined }
    : readOptionalMetaKeyboardEvidence(next.keyboard, snapshot);
  const keyboardSeen = current?.keyboardSeen;
  if (optional.keyboard) {
    const json = JSON.stringify(optional.keyboard);
    if (
      keyboardSeen?.sequence === snapshot.sequence &&
      keyboardSeen.json !== json
    )
      return {
        ...next,
        snapshot,
        keyboard: current?.keyboard,
        keyboardSeen,
        keyboardWarning: current?.keyboardWarning,
        ...assessment,
      };
    return {
      ...next,
      snapshot,
      keyboard: optional.keyboard,
      keyboardSeen: { sequence: snapshot.sequence, json },
      keyboardWarning: undefined,
      ...assessment,
    };
  }
  return {
    ...next,
    snapshot,
    keyboard: undefined,
    keyboardSeen,
    keyboardWarning:
      optional.warning ??
      (keyboardSeen ? KEYBOARD_RECORDS_UNAVAILABLE : undefined),
    ...assessment,
  };
}
