import { z } from 'zod';
import { digest } from './store.js';
import type { RecordEntry } from './types.js';

const id = z.string().min(1).max(200);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
/** Input attempts, never a keyboard success, failure or screen-reader verdict. */
const activationSchema = z
  .object({
    id,
    sequence: z.number().int().positive(),
    recordHash: hash,
    captureId: id,
    imageHash: hash,
    key: z.enum(['Enter', 'Space']),
    control: z
      .object({
        tag: z.enum(['button', 'a', 'input', 'select', 'textarea', 'summary']),
        name: z.string().max(2000),
      })
      .strict(),
    result: z.literal('not-confirmed'),
    createdAt: z.iso.datetime(),
  })
  .strict();
export const keyboardEvidenceSchema = z
  .object({
    protocol: z.literal('access-walk/keyboard-v1'),
    runId: id,
    throughSequence: z.number().int().nonnegative(),
    activations: z.array(activationSchema).max(120),
    coverage: z
      .object({
        tabOrder: z.literal('not-established'),
        visibleFocus: z.literal('not-established'),
        nativeScreenReader: z.literal('not-established'),
      })
      .strict(),
    limits: z.array(z.string()),
  })
  .strict()
  .superRefine((value, ctx) => {
    let previous = 0;
    const ids = new Set<string>();
    for (const event of value.activations) {
      if (event.sequence <= previous || event.sequence > value.throughSequence || ids.has(event.id))
        ctx.addIssue({
          code: 'custom',
          message: 'Keyboard attempts must retain their original identities and order.',
        });
      previous = event.sequence;
      ids.add(event.id);
    }
  });
export type KeyboardEvidence = z.infer<typeof keyboardEvidenceSchema>;

/** Whitelist only performed browser Enter/Space records and their exact original capture. */
export function exportKeyboardEvidence(
  runId: string,
  records: readonly RecordEntry[],
): KeyboardEvidence {
  const limits: string[] = [];
  const activations: KeyboardEvidence['activations'] = [];
  for (const record of records) {
    const p = record.payload;
    if (
      record.kind !== 'action' ||
      record.author !== 'browser' ||
      p?.method !== 'actual_keyboard_or_browser' ||
      p?.action?.kind !== 'press' ||
      !['Enter', 'Space'].includes(p.action.key)
    )
      continue;
    const source =
      Array.isArray(record.sources) && record.sources.length === 1
        ? records.find((r) => r.id === record.sources[0])
        : undefined;
    const valid =
      record.runId === runId &&
      record.hash === digest(JSON.stringify(p)) &&
      p.outcome === 'performed' &&
      source?.kind === 'capture' &&
      source.runId === runId &&
      source.seq < record.seq &&
      p.sourceCaptureId === source.id &&
      p.sourceImageHash === source.payload?.imageHash &&
      source.hash === digest(JSON.stringify(source.payload)) &&
      source.payload?.stable === true;
    // Validate the projected subset below; raw notes, values, URLs and model responses never leave here.
    const projected = valid
      ? {
          id: record.id,
          sequence: record.seq,
          recordHash: record.hash,
          captureId: source!.id,
          imageHash: source!.payload.imageHash,
          key: p.action.key,
          control: { tag: p.before?.tag, name: p.before?.name },
          result: 'not-confirmed' as const,
          createdAt: record.createdAt,
        }
      : undefined;
    if (!projected || !activationSchema.safeParse(projected).success) {
      limits.push(
        'An activation record could not be linked to an intact original capture; its keyboard result is not exported.',
      );
      continue;
    }
    activations.push(activationSchema.parse(projected));
  }
  return keyboardEvidenceSchema.parse({
    protocol: 'access-walk/keyboard-v1',
    runId,
    throughSequence: records.at(-1)?.seq ?? 0,
    activations,
    coverage: {
      tabOrder: 'not-established',
      visibleFocus: 'not-established',
      nativeScreenReader: 'not-established',
    },
    limits,
  });
}
