import { z } from 'zod';
import { recordIsIntact } from './store.js';
import { originalClosure } from './request-evidence.js';
import type { RecordEntry } from './types.js';
import { PROVIDER_IMAGE_LIMIT } from './image-receipt.js';

export const VISUAL_TOPICS = [
  'content',
  'visual_design',
  'layout_composition',
  'affordances',
  'colour_usage',
  'consistency_imagery',
] as const;
export const visualTopicSchema = z.enum(VISUAL_TOPICS);
export type VisualTopic = z.infer<typeof visualTopicSchema>;
const reference = z.string().min(1).max(200);
const explanation = z.string().trim().min(3).max(800);
const sourceIds = z.array(reference).max(32);

export const VISUAL_EVIDENCE_LIMITS = [
  'The original viewport supports visible premises and qualified expert judgement, not unseen content, another width or full-site coverage.',
  'A screenshot does not establish numerical contrast, keyboard operation, screen-reader announcements or measured user behaviour.',
  'Examined means topic coverage; it is neither a pass nor a requirement to produce a finding.',
] as const;

export const VISUAL_INSPECTION_GUIDANCE =
  'Inspect the whole supplied original viewport in the context of the task and original walk/notes. ' +
  'Cover content, visual design, layout/composition, affordances, colour usage and consistency/imagery. ' +
  'State exactly what is visible separately from expert interpretation, the task concern and a proportionate recommendation. ' +
  'Nearby labels, product descriptions and prices count as context; ambiguity does not establish their absence. ' +
  'Do not impose a preferred aesthetic, palette or invented brand rule. Unconventional styling is not itself a defect. ' +
  'Do not infer activation failure, spoken output, numerical contrast, abandonment or user-study results from an image. ' +
  'Missing content, states, widths or images remain unassessed. Our own finding/SAM overlays are not website evidence. ' +
  "A sound visual concern can remain reportable and unscored; mapping it to a criterion never bypasses that criterion's required evidence. " +
  'The reviewer independently checks the original image and the complete claim; these structural checks do not establish that a model interpretation is true.';

export const visualCoverageSchema = z
  .object({
    captureId: reference,
    topic: visualTopicSchema,
    state: z.enum(['examined', 'not_assessed', 'not_applicable']),
    reason: explanation,
    sources: sourceIds,
  })
  .strict()
  .superRefine((row, ctx) => {
    if (row.state !== 'not_assessed' && !row.sources.length)
      ctx.addIssue({
        code: 'custom',
        message: 'An examined or inapplicable topic needs original evidence.',
      });
    if (new Set(row.sources).size !== row.sources.length)
      ctx.addIssue({ code: 'custom', message: 'Original source references must not repeat.' });
  });
export const visualCoverageListSchema = z.array(visualCoverageSchema).max(18);
export type VisualCoverage = z.infer<typeof visualCoverageSchema>;

export const visualObservationSchema = z
  .object({
    captureId: reference,
    topic: visualTopicSchema,
    visiblePremise: explanation,
    interpretation: z.string().trim().min(3).max(1000),
    taskConcern: z.string().trim().min(3).max(700),
    recommendation: z.string().trim().min(3).max(700),
    limits: z.array(z.string().trim().min(3).max(500)).min(1).max(8),
    sources: sourceIds.min(1),
  })
  .strict()
  .superRefine((row, ctx) => {
    if (new Set(row.sources).size !== row.sources.length)
      ctx.addIssue({ code: 'custom', message: 'Original source references must not repeat.' });
  });
export const visualObservationListSchema = z.array(visualObservationSchema).max(12);
export type VisualObservation = z.infer<typeof visualObservationSchema>;

const originalKinds = new Set([
  'plan',
  'capture',
  'action',
  'observation',
  'at_check',
  'navigator_note',
  'limit',
]);

function requireOriginalImage(
  captureId: string,
  records: readonly RecordEntry[],
  suppliedImageCaptureIds: readonly string[],
) {
  const matches = records.filter((record) => record.id === captureId);
  const capture = matches[0];
  if (
    matches.length !== 1 ||
    capture.kind !== 'capture' ||
    !recordIsIntact(capture) ||
    capture.payload.stable !== true
  )
    throw Error('The original visual capture is missing, changed, ambiguous or unstable.');
  const p = capture.payload;
  if (
    !/^[a-f0-9]{64}$/.test(p.imageHash ?? '') ||
    typeof p.imageFile !== 'string' ||
    !/^[a-zA-Z0-9_-]+\.png$/.test(p.imageFile) ||
    !Number.isSafeInteger(p.width) ||
    !Number.isSafeInteger(p.height) ||
    p.width <= 0 ||
    p.height <= 0 ||
    p.limits?.imageScope !== 'viewport'
  )
    throw Error(
      'Visual inspection needs the complete original viewport, not a crop or missing image.',
    );
  if (
    p.imageProvenance?.source !== 'Browser-rendered page viewport' ||
    p.imageProvenance?.engineAddedAnnotations !== false
  )
    throw Error('The capture does not establish an original image without engine annotations.');
  if (!suppliedImageCaptureIds.includes(capture.id))
    throw Error('The original visual image was not supplied to this analysis request.');
  return capture;
}

function requireVisualSources(
  captureId: string,
  sources: readonly string[],
  records: readonly RecordEntry[],
  suppliedImageCaptureIds: readonly string[],
) {
  const capture = requireOriginalImage(captureId, records, suppliedImageCaptureIds);
  if (!sources.includes(captureId))
    throw Error('Visual inspection must cite its exact original viewport.');
  for (const sourceId of sources)
    if (records.filter((record) => record.id === sourceId).length !== 1)
      throw Error('A visual source is missing or ambiguous.');
  const originals = originalClosure([...records], [...sources]);
  for (const original of originals) {
    if (original.runId !== capture.runId || !originalKinds.has(original.kind))
      throw Error('A model interpretation or another run cannot replace original visual evidence.');
    if (original.kind === 'capture')
      requireOriginalImage(original.id, records, suppliedImageCaptureIds);
  }
}

/** Validate original references; the independent review still decides whether the premise is true. */
export function validateVisualObservation(
  value: unknown,
  records: readonly RecordEntry[],
  suppliedImageCaptureIds: readonly string[],
): VisualObservation {
  const observation = visualObservationSchema.parse(value);
  requireVisualSources(
    observation.captureId,
    observation.sources,
    records,
    suppliedImageCaptureIds,
  );
  return observation;
}

/** Complete the six-topic ledger without inventing examinations or choosing a duplicate answer. */
export function normalizeVisualCoverage(
  entries: unknown,
  analysedCaptureIds: readonly string[],
  records: readonly RecordEntry[],
  suppliedImageCaptureIds: readonly string[],
): { coverage: VisualCoverage[]; limits: string[] } {
  const captures = [...new Set(analysedCaptureIds)];
  if (captures.length > PROVIDER_IMAGE_LIMIT)
    throw Error('Visual analysis exceeds the documented original-image request allowance.');
  const limits = new Set<string>();
  const raw = Array.isArray(entries) && entries.length <= 18 ? entries : [];
  if (!Array.isArray(entries) || entries.length > 18)
    limits.add('Visual coverage was missing or exceeded the eighteen-row request allowance.');
  const rows = new Map<string, unknown[]>();
  for (const value of raw) {
    if (!value || typeof value !== 'object') {
      limits.add('A visual coverage row was malformed; no examination was inferred.');
      continue;
    }
    const row = value as Record<string, unknown>;
    if (
      typeof row.captureId !== 'string' ||
      !captures.includes(row.captureId) ||
      !visualTopicSchema.safeParse(row.topic).success
    ) {
      limits.add('A visual coverage row names a topic or screen outside this analysis scope.');
      continue;
    }
    const key = JSON.stringify([row.captureId, row.topic]);
    rows.set(key, [...(rows.get(key) ?? []), value]);
  }
  const coverage: VisualCoverage[] = [];
  for (const captureId of captures)
    for (const topic of VISUAL_TOPICS) {
      const matching = rows.get(JSON.stringify([captureId, topic])) ?? [];
      let reason = 'This visual topic was not assessed for this original viewport.';
      let valid: VisualCoverage | undefined;
      if (matching.length > 1)
        reason =
          'Conflicting or duplicate visual coverage was returned; this topic remains unassessed.';
      else if (matching.length === 1) {
        const parsed = visualCoverageSchema.safeParse(matching[0]);
        if (!parsed.success)
          reason = 'Visual coverage was malformed; this topic remains unassessed.';
        else {
          try {
            if (parsed.data.state !== 'not_assessed' || parsed.data.sources.length)
              requireVisualSources(
                captureId,
                parsed.data.sources,
                records,
                suppliedImageCaptureIds,
              );
            valid = parsed.data;
          } catch (error) {
            reason =
              error instanceof Error
                ? error.message
                : 'Original visual evidence could not be verified.';
          }
        }
      }
      if (valid) coverage.push(valid);
      else {
        coverage.push({ captureId, topic, state: 'not_assessed', reason, sources: [] });
        limits.add(reason);
      }
    }
  return { coverage, limits: [...limits] };
}
