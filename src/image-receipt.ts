import { z } from 'zod';
import { recordIsIntact } from './store.js';
import type { RecordEntry } from './types.js';

export const LEGACY_IMAGE_RECEIPT_VERSION = 'original-images/1' as const;
export const IMAGE_RECEIPT_VERSION = 'original-images/2' as const;
// Configured Muse Spark limit, verified 28 October 2026.
// https://dev.meta.ai/docs/image-understanding#multiple-images
export const PROVIDER_IMAGE_LIMIT = 50;
const pinSchema = z
  .object({
    captureId: z.string().min(1),
    captureHash: z.string().regex(/^[a-f0-9]{64}$/),
    imageHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const baselinePinSchema = pinSchema
  .extend({
    reason: z.literal('approved_return_entry_baseline'),
    comparisonId: z.string().min(1),
    baselineId: z.string().min(1),
    typedActionId: z.string().min(1),
  })
  .strict();
const receiptFields = {
  currentCaptureId: z.string().min(1),
};
const receiptSchema = z.discriminatedUnion('version', [
  z
    .object({
      ...receiptFields,
      version: z.literal(LEGACY_IMAGE_RECEIPT_VERSION),
      supplied: z.array(pinSchema).min(1).max(8),
      recordsOnly: z.array(baselinePinSchema).max(1),
    })
    .strict(),
  z
    .object({
      ...receiptFields,
      version: z.literal(IMAGE_RECEIPT_VERSION),
      supplied: z.array(pinSchema).min(1).max(PROVIDER_IMAGE_LIMIT),
      recordsOnly: z.array(baselinePinSchema).max(0),
    })
    .strict(),
]);
export type ImageReceipt = z.infer<typeof receiptSchema>;
export type BaselineImagePin = z.infer<typeof baselinePinSchema>;
export const readHashMatches = (read: RecordEntry, expected: unknown) =>
  Object.hasOwn(read.payload, 'imageReceipt') || expected !== undefined
    ? typeof expected === 'string' && expected === read.hash
    : true;
const sameIds = (a: string[], b: string[]) =>
  a.length === b.length && new Set(a).size === a.length && a.every((id) => b.includes(id));
const pin = (capture: RecordEntry) => ({
  captureId: capture.id,
  captureHash: capture.hash,
  imageHash: capture.payload.imageHash,
});

/** Only the original pre-type picture is nonvisual in this exact recorded comparison. */
export function returnBaselineImage(
  records: RecordEntry[],
  comparisonId: string,
  currentCaptureId: string,
): BaselineImagePin | null {
  const get = (id: unknown) => records.find((record) => record.id === id);
  const comparison = get(comparisonId),
    p = comparison?.payload;
  const current = get(currentCaptureId);
  const entry = get(p?.entryCaptureId),
    typed = get(p?.typedActionId);
  const beforeType = get(typed?.payload.sourceCaptureId);
  const beforeBack = get(p?.beforeCaptureId),
    back = get(p?.actionId);
  const baselines = records.filter(
    (record) =>
      comparison?.sources.includes(record.id) && record.payload.method === 'return_entry_baseline',
  );
  const baseline = baselines[0];
  if (
    !comparison ||
    !current ||
    !entry ||
    !typed ||
    !beforeType ||
    !beforeBack ||
    !back ||
    baselines.length !== 1 ||
    !baseline
  )
    return null;
  const originals = [beforeType, typed, entry, baseline, beforeBack, back, current, comparison];
  if (
    originals.some(
      (record, i) =>
        !recordIsIntact(record) ||
        record.runId !== current.runId ||
        record.author !== 'browser' ||
        (i > 0 && record.seq <= originals[i - 1].seq),
    )
  )
    return null;
  const captures = [beforeType, entry, beforeBack, current];
  if (
    new Set(captures.map((record) => record.id)).size !== 4 ||
    captures.some(
      (record) =>
        record.kind !== 'capture' ||
        record.payload.stable !== true ||
        !/^[a-f0-9]{64}$/.test(record.payload.imageHash ?? ''),
    )
  )
    return null;
  const actual = (action: RecordEntry, source: RecordEntry) =>
    action.kind === 'action' &&
    action.payload.method === 'actual_keyboard_or_browser' &&
    action.payload.outcome === 'performed' &&
    action.payload.sourceCaptureId === source.id &&
    action.payload.sourceImageHash === source.payload.imageHash &&
    sameIds(action.sources, [source.id]);
  const field = (capture: RecordEntry) =>
    (capture.payload.elements ?? []).filter(
      (element: any) =>
        element.selector === '#email' && element.tag === 'input' && element.type === 'email',
    );
  const entryFields = field(entry),
    returnedFields = field(current);
  if (
    !actual(typed, beforeType) ||
    typed.payload.action?.kind !== 'type' ||
    typed.payload.action.text !== 'test@example.org' ||
    typed.payload.before?.id !== 'email' ||
    typed.payload.before?.tag !== 'input' ||
    typed.payload.before?.type !== 'email' ||
    !actual(back, beforeBack) ||
    back.payload.action?.kind !== 'back' ||
    baseline.kind !== 'observation' ||
    baseline.payload.version !== 'journey-evidence/1' ||
    baseline.payload.stable !== true ||
    baseline.payload.baselineRecorded !== true ||
    baseline.payload.sourceCaptureId !== entry.id ||
    baseline.payload.typedActionId !== typed.id ||
    baseline.payload.fieldId !== 'email' ||
    !sameIds(baseline.sources, [beforeType.id, typed.id, entry.id]) ||
    comparison.kind !== 'observation' ||
    p.method !== 'return_preservation' ||
    p.version !== 'journey-evidence/1' ||
    p.stable !== true ||
    p.afterCaptureId !== current.id ||
    p.returned !== true ||
    p.entriesCompared !== true ||
    typeof p.preserved !== 'boolean' ||
    p.fieldId !== 'email' ||
    !sameIds(comparison.sources, [
      beforeBack.id,
      back.id,
      current.id,
      baseline.id,
      entry.id,
      typed.id,
    ]) ||
    beforeType.payload.url !== entry.payload.url ||
    entry.payload.url !== current.payload.url ||
    entryFields.length !== 1 ||
    returnedFields.length !== 1 ||
    typeof entryFields[0].name !== 'string' ||
    entryFields[0].name !== returnedFields[0].name
  )
    return null;
  return {
    ...pin(beforeType),
    reason: 'approved_return_entry_baseline',
    comparisonId,
    baselineId: baseline.id,
    typedActionId: typed.id,
  };
}

/** A separately required visual/measurement source cannot borrow the C15-only exemption. */
export function baselineHasIndependentUse(records: RecordEntry[], omitted: BaselineImagePin) {
  const reaches = (ids: string[]) => {
    const pending = [...ids],
      seen = new Set<string>();
    while (pending.length) {
      const id = pending.pop()!;
      if (id === omitted.captureId) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      pending.push(...(records.find((record) => record.id === id)?.sources ?? []));
    }
    return false;
  };
  return records.some(
    (record) =>
      (record.kind === 'candidate' &&
        (record.payload.targetCaptureId === omitted.captureId ||
          ((record.payload.visualTopic ||
            ['expert_visual', 'mixed'].includes(record.payload.basis)) &&
            reaches(record.sources)))) ||
      (['observation', 'at_check', 'visual_observation'].includes(record.kind) &&
        ![omitted.baselineId, omitted.comparisonId].includes(record.id) &&
        record.sources.includes(omitted.captureId)),
  );
}

export function makeImageReceipt(
  records: RecordEntry[],
  currentCaptureId: string,
  omitted?: BaselineImagePin,
): ImageReceipt {
  return {
    // Explicit omissions exist only for reading/reconstructing the old format.
    // Fresh requestEvidence calls supply every required original picture.
    version: omitted ? LEGACY_IMAGE_RECEIPT_VERSION : IMAGE_RECEIPT_VERSION,
    currentCaptureId,
    supplied: records
      .filter((record) => record.kind === 'capture' && record.id !== omitted?.captureId)
      .map(pin),
    recordsOnly: omitted ? [omitted] : [],
  };
}

/** Legacy reads offered every selected picture. Explicit new receipts fail closed. */
export function suppliedImageIds(read: RecordEntry, records: RecordEntry[]): string[] {
  if (
    read.kind !== 'read_snapshot' ||
    !recordIsIntact(read) ||
    !Array.isArray(read.payload.records)
  )
    throw Error('The original image receipt has no intact read.');
  const selected: RecordEntry[] = [];
  const ids = new Set<string>();
  const byId = new Map(records.map((record) => [record.id, record]));
  if (byId.size !== records.length)
    throw Error('The original image receipt has ambiguous records.');
  for (const item of read.payload.records) {
    const record = byId.get(item.id);
    if (
      !record ||
      record.runId !== read.runId ||
      !recordIsIntact(record) ||
      record.hash !== item.hash ||
      JSON.stringify(record.sources) !== JSON.stringify(item.sources) ||
      ids.has(record.id)
    )
      throw Error('The original image receipt contains changed or missing sources.');
    ids.add(record.id);
    selected.push(record);
  }
  const captures = selected.filter((record) => record.kind === 'capture');
  if (!Object.hasOwn(read.payload, 'imageReceipt')) return captures.map((record) => record.id);
  const receipt = receiptSchema.parse(read.payload.imageReceipt);
  const allPins = [...receipt.supplied, ...receipt.recordsOnly];
  if (
    !sameIds(
      allPins.map((item) => item.captureId),
      captures.map((record) => record.id),
    ) ||
    !receipt.supplied.some((item) => item.captureId === receipt.currentCaptureId) ||
    receipt.supplied.length >
      (read.author === 'analyst' || read.author === 'reviewer'
        ? receipt.version === LEGACY_IMAGE_RECEIPT_VERSION
          ? read.author === 'analyst'
            ? 3
            : 8
          : PROVIDER_IMAGE_LIMIT
        : 1)
  )
    throw Error('The original image receipt does not match this read and its allowance.');
  for (const item of allPins) {
    const capture = captures.find((record) => record.id === item.captureId)!;
    if (
      capture.payload.stable !== true ||
      item.captureHash !== capture.hash ||
      item.imageHash !== capture.payload.imageHash
    )
      throw Error('A supplied or records-only original image changed.');
  }
  for (const omitted of receipt.recordsOnly) {
    const allowed = returnBaselineImage(selected, omitted.comparisonId, receipt.currentCaptureId);
    if (
      read.author !== 'analyst' ||
      !allowed ||
      JSON.stringify(allowed) !== JSON.stringify(omitted) ||
      baselineHasIndependentUse(selected, omitted)
    )
      throw Error('The records-only baseline is not an intact nonvisual return dependency.');
  }
  return receipt.supplied.map((item) => item.captureId);
}

export function imageRecordsForRead(snapshot: { read: RecordEntry; records: RecordEntry[] }) {
  const ids = new Set(suppliedImageIds(snapshot.read, snapshot.records));
  return snapshot.records.filter((record) => record.kind === 'capture' && ids.has(record.id));
}
