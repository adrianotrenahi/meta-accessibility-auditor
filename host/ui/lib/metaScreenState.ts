import { z } from 'zod';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const state = z.object({ version: z.literal('meaningful-screen/1'), fingerprint: hash });
const screenStateSchema = z.discriminatedUnion('purpose', [
  state.extend({ purpose: z.literal('screen') }).strict(),
  state.extend({ purpose: z.literal('same-state-evidence'),
    primaryCaptureId: z.string().min(1).max(200), primaryCaptureHash: hash }).strict(),
]);
type StateCapture = {
  id: string; sequence: number; recordHash?: string; url: string; title: string;
  width: number; height: number; stable: boolean; screenState?: unknown;
};

/** Independent check of the public optional grouping receipt. It does not
 * equate the pixels/focus in different original images or settle any check. */
function verifiedScreenState(capture: StateCapture, captures: readonly StateCapture[]) {
  const parsed = screenStateSchema.safeParse(capture.screenState);
  if (!parsed.success || !capture.stable || !hash.safeParse(capture.recordHash).success) return;
  const value = parsed.data;
  if (value.purpose === 'screen') return value;
  const originals = captures.filter((row) => row.id === value.primaryCaptureId);
  const original = originals[0];
  const primary = screenStateSchema.safeParse(original?.screenState);
  if (originals.length !== 1 || !original || !primary.success ||
    primary.data.purpose !== 'screen' || !original.stable ||
    original.recordHash !== value.primaryCaptureHash || original.sequence >= capture.sequence ||
    primary.data.fingerprint !== value.fingerprint || original.url !== capture.url ||
    original.title !== capture.title || original.width !== capture.width || original.height !== capture.height)
    return;
  return value;
}

export function normalizeMetaScreenStates<T extends StateCapture>(captures: readonly T[]) {
  let withheld = false;
  const result: (Omit<T, 'screenState'> & { screenState?: z.infer<typeof screenStateSchema> })[] = captures.map((capture) => {
    const { screenState: raw, ...original } = capture;
    const verified = verifiedScreenState(capture, captures);
    if (raw !== undefined && !verified) withheld = true;
    return verified ? { ...original, screenState: verified } : original;
  });
  return { captures: result, withheld };
}

/** One report screen, with every exact original retained as an evidence variant.
 * Legacy/unverifiable captures stay separate; a repeated URL is insufficient. */
export function metaScreenGroups<T extends StateCapture>(captures: readonly T[]) {
  const groups: { primary: T; originals: T[] }[] = [];
  const byId = new Map<string, { primary: T; originals: T[] }>();
  for (const capture of captures) {
    const state = verifiedScreenState(capture, captures);
    const primaryId = state?.purpose === 'same-state-evidence' ? state.primaryCaptureId : capture.id;
    const previous = byId.get(primaryId);
    if (previous) previous.originals.push(capture);
    else {
      const group = { primary: capture, originals: [capture] };
      groups.push(group); byId.set(primaryId, group);
    }
  }
  return groups;
}
