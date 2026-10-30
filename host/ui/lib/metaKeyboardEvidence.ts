import { z } from "zod";
import type { HostSnapshot } from "./metaWalkHost";
import type { KeyboardJourneyMap } from "./keyboardJourneyMap";
import { UNNAMED_CONTROL } from "./keyboardJourneyMap";
// Independent consumer of access-walk/keyboard-v1. No private worker inference is reused.
const id = z.string().min(1).max(200);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
/** Recorded keypresses, never a control activation or accessibility verdict. */
const keyPressSchema = z
  .object({
    id,
    sequence: z.number().int().positive(),
    recordHash: hash,
    captureId: id,
    imageHash: hash,
    key: z.enum(["Enter", "Space"]),
    control: z
      .object({
        tag: z.enum(["button", "a", "input", "select", "textarea", "summary"]),
        name: z.string().max(2000),
      })
      .strict(),
    result: z.literal("not-confirmed"),
    createdAt: z.string().datetime(),
  })
  .strict();
export const keyboardEvidenceSchema = z
  .object({
    protocol: z.literal("access-walk/keyboard-v1"),
    runId: id,
    throughSequence: z.number().int().nonnegative(),
    keyPresses: z.array(keyPressSchema).max(120),
    coverage: z
      .object({
        tabOrder: z.literal("not-established"),
        visibleFocus: z.literal("not-established"),
        nativeScreenReader: z.literal("not-established"),
      })
      .strict(),
    limits: z.array(z.string()),
  })
  .strict()
  .superRefine((value, ctx) => {
    let previous = 0;
    const ids = new Set<string>();
    for (const event of value.keyPresses) {
      if (
        event.sequence <= previous ||
        event.sequence > value.throughSequence ||
        ids.has(event.id)
      )
        ctx.addIssue({
          code: "custom",
          message:
            "Keyboard attempts must retain their original identities and order.",
        });
      previous = event.sequence;
      ids.add(event.id);
    }
  });
export type MetaKeyboardEvidence = z.infer<typeof keyboardEvidenceSchema>;

/** Same-run original pictures are required; no success/failure is inferred from input. */
export function readMetaKeyboardEvidence(
  value: unknown,
  snapshot: HostSnapshot,
): MetaKeyboardEvidence {
  const data = keyboardEvidenceSchema.parse(value);
  if (data.runId !== snapshot.run.id)
    throw Error("Keyboard records belong to a different run.");
  for (const event of data.keyPresses) {
    const capture = snapshot.captures.find((c) => c.id === event.captureId);
    if (
      !capture ||
      !capture.stable ||
      capture.sequence >= event.sequence ||
      capture.imageHash !== event.imageHash
    )
      throw Error("Keyboard records do not match their original screenshot.");
  }
  return data;
}

export const KEYBOARD_RECORDS_UNAVAILABLE =
  "Keyboard input records could not be verified. Keyboard results remain unassessed; the rest of this report is available.";

/** Optional input context cannot hide a valid report or leak rejected fields. */
export function readOptionalMetaKeyboardEvidence(
  value: unknown,
  snapshot: HostSnapshot,
): { keyboard?: MetaKeyboardEvidence; warning?: string } {
  if (value === undefined) return {};
  try {
    return { keyboard: readMetaKeyboardEvidence(value, snapshot) };
  } catch {
    return { warning: KEYBOARD_RECORDS_UNAVAILABLE };
  }
}

export function metaKeyboardMap(
  data: MetaKeyboardEvidence | undefined,
  capture: HostSnapshot["captures"][number],
): KeyboardJourneyMap | null {
  if (!data || !capture.imageAvailable) return null;
  const actions = data.keyPresses.filter(
    (event) =>
      event.captureId === capture.id && event.imageHash === capture.imageHash,
  );
  if (!actions.length) return null;
  const controls: KeyboardJourneyMap["controls"] = [];
  const grouped = new Map<
    string,
    { control: KeyboardJourneyMap["controls"][number]; keys: Set<string> }
  >();
  for (const event of actions) {
    const label =
      event.control.name.replace(/\s+/g, " ").trim() || UNNAMED_CONTROL;
    const previous = grouped.get(label);
    if (previous) {
      previous.keys.add(event.key);
      previous.control.key = [...previous.keys].join(", ");
    } else {
      const control = {
        label,
        key: event.key as string,
        result: "not_confirmed" as const,
        issueId: null,
      };
      grouped.set(label, { control, keys: new Set([event.key]) });
      controls.push(control);
    }
  }
  return {
    controls,
    views: [],
    handOff: null,
    touch: false,
  };
}
