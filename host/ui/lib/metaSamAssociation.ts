import { z } from 'zod';

const id = z.string().min(1).max(200);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const box = z.object({ x: z.number().nonnegative(), y: z.number().nonnegative(),
  width: z.number().positive(), height: z.number().positive() }).strict();
/** A prompted geometry receipt. It never supplies a finding or changes its marker. */
export const samAssociationSchema = z.object({
  version: z.literal('prompted-sam-association/1'),
  mappingId: id, mappingHash: hash, captureId: id, captureHash: hash, imageHash: hash,
  targetId: id, width: z.number().int().positive(), height: z.number().int().positive(),
  targetBox: box, bounds: box, maskWidth: z.number().int().positive(),
  maskHeight: z.number().int().positive(), foregroundPixels: z.number().int().positive(),
  rasterHash: hash,
}).strict();
export type SamAssociation = z.infer<typeof samAssociationSchema>;

export function samAssociationFits(
  sam: SamAssociation,
  anchor: { captureId: string; elementId: string; box: z.infer<typeof box> },
  capture: { id: string; imageHash: string; width: number; height: number; stable: boolean; imageAvailable: boolean },
) {
  const a = sam.bounds, b = anchor.box;
  const intersection = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const overlap = intersection / (a.width * a.height + b.width * b.height - intersection || 1);
  return capture.stable && capture.imageAvailable && sam.captureId === capture.id &&
    sam.captureId === anchor.captureId && sam.targetId === anchor.elementId &&
    sam.imageHash === capture.imageHash && sam.width === capture.width && sam.height === capture.height &&
    ['x', 'y', 'width', 'height'].every((key) => sam.targetBox[key as keyof typeof b] === b[key as keyof typeof b]) &&
    Number.isSafeInteger(a.x) && Number.isSafeInteger(a.y) &&
    a.x + a.width <= capture.width && a.y + a.height <= capture.height &&
    sam.maskWidth === a.width && sam.maskHeight === a.height &&
    sam.foregroundPixels <= sam.maskWidth * sam.maskHeight &&
    sam.width * sam.height <= 1_500_000 && overlap >= 0.5;
}
