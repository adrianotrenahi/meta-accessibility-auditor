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

/** One report screen per strip picture (owner, 31 Oct: the strip and the Findings tab show
 * the same pictures, and only those). Consecutive screen groups with the same page key form
 * one page visit, as the strip always did; a modal, menu or viewport change starts its own.
 * Every picture the analyst read, or a finding points to, is its own screen, so the Booking.com
 * cookie banner and the home page behind it both show and pins stay on their own image. A
 * picture that proved a finished journey step is also its own
 * screen even when its analysis never came back (owner, 31 Oct: a failed analysis hid the
 * Barcelona to London screen the robot had reached); it is marked as not analysed. A visit
 * nobody checked shows its latest picture. Every original stays in `captures`. */
export function metaReportScreens<T extends StateCapture>(
  snapshot: {
    captures: readonly T[];
    analysis?: { completed: { role: string; captureIds: string[] }[] };
    findings: readonly { captureIds: string[]; anchor: { captureId: string } | null }[];
    journey?: { completed: readonly { captureId: string }[] };
  },
  pageKey: (capture: T) => string,
) {
  const analysed = new Set([
    ...(snapshot.analysis?.completed ?? [])
      .filter((row) => row.role === 'analyst')
      .flatMap((row) => row.captureIds),
    ...snapshot.findings.map((finding) => finding.anchor?.captureId ?? finding.captureIds[0]!),
  ]);
  // Only the analyst's own reading counts as analysed; a finished-step screen that only the
  // reviewer read is shown, deliberately marked as not analysed.
  const shown = new Set([
    ...analysed,
    ...(snapshot.journey?.completed ?? []).map((row) => row.captureId),
  ]);
  const explicit = (capture: T) => capture.screenState !== undefined;
  const visits: { first: T; captures: T[] }[] = [];
  for (const group of metaScreenGroups(snapshot.captures)) {
    const previous = visits.at(-1);
    if (previous && !explicit(group.primary) && !explicit(previous.first) &&
      pageKey(previous.first) === pageKey(group.primary))
      previous.captures.push(...group.originals);
    else visits.push({ first: group.primary, captures: [...group.originals] });
  }
  return visits.flatMap(({ captures }) => {
    if (!captures.some((capture) => shown.has(capture.id)))
      return [{ primary: captures.at(-1)!, originals: [captures.at(-1)!], captures, analysed: false }];
    // Unshown pictures belong to the screen they lead up to, or else the last one.
    const screens: { primary: T; originals: T[]; captures: T[]; analysed: boolean }[] = [];
    let waiting: T[] = [];
    for (const capture of captures) {
      waiting.push(capture);
      if (!shown.has(capture.id)) continue;
      screens.push({
        primary: capture,
        originals: [capture],
        captures: waiting,
        analysed: analysed.has(capture.id),
      });
      waiting = [];
    }
    screens.at(-1)!.captures.push(...waiting);
    return screens;
  });
}
