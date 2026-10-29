import { z } from 'zod';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const state = z.object({
  version: z.literal('meaningful-screen/1'),
  fingerprint: hash,
});
export const screenStateSchema = z.discriminatedUnion('purpose', [
  state.extend({ purpose: z.literal('screen') }).strict(),
  state
    .extend({
      purpose: z.literal('same-state-evidence'),
      primaryCaptureId: z.string().min(1).max(200),
      primaryCaptureHash: hash,
    })
    .strict(),
]);
export type ScreenState = z.infer<typeof screenStateSchema>;

export type StateCapture = {
  id: string;
  sequence: number;
  recordHash?: string;
  url: string;
  title: string;
  width: number;
  height: number;
  stable: boolean;
  screenState?: unknown;
};

/** Optional grouping never repairs missing originals or equates focus pictures. */
export function verifiedScreenState(capture: StateCapture, captures: readonly StateCapture[]) {
  const parsed = screenStateSchema.safeParse(capture.screenState);
  if (!parsed.success || !capture.stable || !hash.safeParse(capture.recordHash).success) return;
  const value = parsed.data;
  if (value.purpose === 'screen') return value;
  const originals = captures.filter((row) => row.id === value.primaryCaptureId);
  const original = originals[0];
  const primary = screenStateSchema.safeParse(original?.screenState);
  if (
    originals.length !== 1 ||
    !original ||
    !primary.success ||
    primary.data.purpose !== 'screen' ||
    !original.stable ||
    original.recordHash !== value.primaryCaptureHash ||
    original.sequence >= capture.sequence ||
    primary.data.fingerprint !== value.fingerprint ||
    original.url !== capture.url ||
    original.title !== capture.title ||
    original.width !== capture.width ||
    original.height !== capture.height
  )
    return;
  return value;
}

export function normalizeScreenStateCaptures<T extends StateCapture>(captures: readonly T[]) {
  let withheld = false;
  const result: (Omit<T, 'screenState'> & { screenState?: ScreenState })[] = captures.map(
    (capture) => {
      const { screenState: raw, ...original } = capture;
      const verified = verifiedScreenState(capture, captures);
      if (raw !== undefined && !verified) withheld = true;
      return verified ? { ...original, screenState: verified } : original;
    },
  );
  return { captures: result, withheld };
}
