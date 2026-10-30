import { z } from "zod";
import type { HostSnapshot } from "./metaWalkHost";

/** Independent consumer of the public, display-only live-picture protocol. */
export const metaLiveFrameSchema = z
  .object({
    protocol: z.literal("access-walk/frame-v1"),
    runId: z.string().uuid(),
    sequence: z.number().int().positive(),
    capturedAt: z.string().datetime(),
    width: z.number().int().positive().max(4096),
    height: z.number().int().positive().max(4096),
    imageHash: z.string().regex(/^[a-f0-9]{64}$/),
    captureId: z.string().uuid().nullable(),
    png: z
      .string()
      .min(32)
      .max(5592408)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/),
  })
  .strict();
export type MetaLiveFrame = z.infer<typeof metaLiveFrameSchema>;
export function liveEvidenceIdentity(frame: MetaLiveFrame) {
  return `${frame.runId}:${frame.captureId ?? "unbound"}:${frame.imageHash}`;
}
export function livePicture(frame: MetaLiveFrame) {
  return {
    dataUrl: "data:image/png;base64," + frame.png,
    width: frame.width,
    height: frame.height,
    identity: `${frame.runId}:${frame.sequence}`,
    evidenceIdentity: liveEvidenceIdentity(frame),
  };
}
export function matchingLiveCapture(
  snapshot: HostSnapshot,
  frame: MetaLiveFrame,
) {
  if (frame.runId !== snapshot.run.id) return null;
  return (
    snapshot.captures.find(
      (capture) =>
        capture.id === frame.captureId &&
        capture.imageAvailable &&
        capture.stable &&
        capture.imageHash === frame.imageHash &&
        capture.width === frame.width &&
        capture.height === frame.height,
    ) ?? null
  );
}
