import { z } from 'zod';
import { digest } from './store.js';
import type { RecordEntry } from './types.js';

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
    keyPresses: z.array(keyPressSchema).max(120),
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
    for (const event of value.keyPresses) {
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
  const keyPresses: KeyboardEvidence['keyPresses'] = [];
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
    if (record.runId !== runId || record.hash !== digest(JSON.stringify(p))) {
      limits.push('A saved keypress failed its integrity check; it is not exported.');
      continue;
    }
    if (p.outcome !== 'performed') {
      limits.push('A keypress was not recorded as performed; it is not exported.');
      continue;
    }
    const linked =
      source?.kind === 'capture' &&
      source.runId === runId &&
      source.seq < record.seq &&
      p.sourceCaptureId === source.id &&
      p.sourceImageHash === source.payload?.imageHash &&
      source.hash === digest(JSON.stringify(source.payload)) &&
      source.payload?.stable === true;
    if (!linked) {
      limits.push(
        'A keypress has no verified link to a stable original screen; it is not exported.',
      );
      continue;
    }
    // Raw notes, typed values, URLs and model responses never leave here.
    const projected = {
      id: record.id,
      sequence: record.seq,
      recordHash: record.hash,
      captureId: source!.id,
      imageHash: source!.payload.imageHash,
      key: p.action.key,
      control: { tag: p.before?.tag, name: p.before?.name },
      result: 'not-confirmed' as const,
      createdAt: record.createdAt,
    };
    if (!keyPressSchema.safeParse(projected).success) {
      limits.push('A keypress uses an unsupported control or record format; it is not exported.');
      continue;
    }
    keyPresses.push(keyPressSchema.parse(projected));
  }
  return keyboardEvidenceSchema.parse({
    protocol: 'access-walk/keyboard-v1',
    runId,
    throughSequence: records.at(-1)?.seq ?? 0,
    keyPresses,
    coverage: {
      tabOrder: 'not-established',
      visibleFocus: 'not-established',
      nativeScreenReader: 'not-established',
    },
    limits,
  });
}
