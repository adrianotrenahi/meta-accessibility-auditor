import { z } from 'zod';

const id = z.string().min(1).max(200);
const webUrl = z
  .string()
  .url()
  .refine((value) => /^https?:\/\//.test(value), 'Expected a web URL');
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const box = z
  .object({
    x: z.number().nonnegative(),
    y: z.number().nonnegative(),
    width: z.number().positive(),
    height: z.number().positive(),
  })
  .strict();
export const hostSnapshotSchema = z
  .object({
    protocol: z.literal('access-walk/host-v1'),
    provenance: z.literal('saved-engine-records'),
    run: z
      .object({
        id,
        goal: z.string(),
        url: webUrl,
        state: z.enum(['running', 'complete', 'partial', 'stopped', 'interrupted']),
        mode: z.enum(['offline', 'live']),
        createdAt: z.iso.datetime(),
        stopReason: z.string().nullable(),
      })
      .strict(),
    sequence: z.number().int().nonnegative(),
    captures: z.array(
      z
        .object({
          id,
          sequence: z.number().int().positive(),
          imageHash: hash,
          imageFile: z.string().regex(/^images\/[a-f0-9]{64}\.png$/),
          width: z.number().int().positive(),
          height: z.number().int().positive(),
          url: webUrl,
          title: z.string(),
          stable: z.boolean(),
          createdAt: z.iso.datetime(),
        })
        .strict(),
    ),
    findings: z.array(
      z
        .object({
          id,
          candidateHash: hash,
          reviewHash: hash,
          reviewProvenance: z.enum(['saved-example', 'model']),
          title: z.string(),
          detail: z.string(),
          recommendation: z.string(),
          criterion: z.string().nullable(),
          basis: z.enum(['measured', 'expert_visual', 'mixed']),
          severity: z.enum(['blocker', 'serious', 'minor']),
          captureIds: z.array(id).min(1),
          sourceIds: z.array(id).min(1),
          anchor: z.object({ captureId: id, elementId: id, box }).strict().nullable(),
        })
        .strict(),
    ),
    coverage: z
      .object({
        scope: z.literal('limited'),
        score: z.null(),
        realVoiceOver: z.literal('not-established'),
        sam: z.literal('not-established'),
      })
      .strict(),
    limits: z.array(z.string()),
    cost: z
      .object({
        usageEstimateUsd: z.number().nonnegative(),
        heldUnknownUsd: z.number().nonnegative(),
      })
      .strict(),
  })
  .strict()
  .superRefine((snapshot, ctx) => {
    const ids = new Set<string>();
    let previousSequence = 0;
    for (const capture of snapshot.captures) {
      if (capture.sequence <= previousSequence)
        ctx.addIssue({ code: 'custom', message: 'Captures must retain their original order' });
      previousSequence = capture.sequence;
      if (ids.has(capture.id))
        ctx.addIssue({ code: 'custom', message: 'Duplicate capture identity' });
      ids.add(capture.id);
      if (capture.imageFile !== `images/${capture.imageHash}.png`)
        ctx.addIssue({ code: 'custom', message: 'Capture image hash and file disagree' });
    }
    const findings = new Set<string>();
    for (const finding of snapshot.findings) {
      if (findings.has(finding.id))
        ctx.addIssue({ code: 'custom', message: 'Duplicate finding identity' });
      findings.add(finding.id);
      if (finding.captureIds.some((captureId) => !ids.has(captureId)))
        ctx.addIssue({ code: 'custom', message: 'Finding refers to missing original capture' });
      if (finding.anchor) {
        const capture = snapshot.captures.find((c) => c.id === finding.anchor!.captureId);
        const b = finding.anchor.box;
        if (
          !capture ||
          !capture.stable ||
          !finding.captureIds.includes(capture.id) ||
          b.x + b.width > capture.width ||
          b.y + b.height > capture.height
        )
          ctx.addIssue({
            code: 'custom',
            message: 'Finding anchor does not fit its original capture',
          });
      }
    }
  });
export type HostSnapshot = z.infer<typeof hostSnapshotSchema>;

/** Reconnects replace a saved state; they never start a browser or a model. */
export function applyHostSnapshot(
  current: HostSnapshot | undefined,
  incoming: unknown,
): HostSnapshot {
  const next = hostSnapshotSchema.parse(incoming);
  if (!current) return next;
  if (next.run.id !== current.run.id)
    throw Error('A different run needs a separate host connection.');
  if (next.sequence <= current.sequence) return current;
  for (const field of ['goal', 'url', 'mode', 'createdAt'] as const) {
    if (next.run[field] !== current.run[field])
      throw Error('The original run identity cannot change.');
  }
  for (const previous of current.captures) {
    const now = next.captures.find((capture) => capture.id === previous.id);
    if (!now || JSON.stringify(now) !== JSON.stringify(previous))
      throw Error('A retained original capture cannot be changed or removed.');
  }
  return next;
}
