import { Store, recordIsIntact } from './store.js';
import { MetaModels } from './models.js';
import type { RecordEntry, ElementInfo } from './types.js';
export function overlap(a: ElementInfo['box'], b: ElementInfo['box']) {
  const w = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)),
    h = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const intersection = w * h;
  return intersection / (a.width * a.height + b.width * b.height - intersection || 1);
}
export function boxPrompt(target: ElementInfo, width: number, height: number) {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    ![target.box.x, target.box.y, target.box.width, target.box.height].every(Number.isFinite) ||
    target.box.width <= 0 ||
    target.box.height <= 0
  )
    throw Error('SAM needs valid original dimensions and a visible target.');
  const x1 = Math.max(0, Math.floor(target.box.x)),
    y1 = Math.max(0, Math.floor(target.box.y)),
    x2 = Math.min(width - 1, Math.ceil(target.box.x + target.box.width) - 1),
    y2 = Math.min(height - 1, Math.ceil(target.box.y + target.box.height) - 1);
  if (x1 > x2 || y1 > y2) throw Error('The element is outside this capture.');
  return `<0f>1<|box;x1=${x1};y1=${y1};x2=${x2};y2=${y2};w=${width};h=${height}|>`;
}
export async function mapElement(
  store: Store,
  models: MetaModels,
  runId: string,
  capture: RecordEntry,
  targetId: string,
  signal: AbortSignal,
) {
  const original = store.record(runId, capture.id);
  if (
    capture.kind !== 'capture' ||
    capture.runId !== runId ||
    capture.payload.stable !== true ||
    original?.hash !== capture.hash ||
    !recordIsIntact(capture) ||
    !recordIsIntact(original)
  )
    throw Error('SAM needs the exact original capture.');
  const targets = capture.payload.elements.filter((x: ElementInfo) => x.id === targetId);
  if (targets.length !== 1) throw Error('The proposed element is not unique in this capture.');
  const target = targets[0];
  const prompt = boxPrompt(target, capture.payload.width, capture.payload.height),
    cacheKey = `sam-3.1:${capture.payload.imageHash}:${prompt}`;
  // Verify bytes even on a cache hit. Identical pixels from another capture are not this source.
  const image =
    'data:image/png;base64,' + store.image(runId, capture.payload.imageFile).toString('base64');
  const prior = store
    .records(runId)
    .find(
      (r) =>
        r.kind === 'sam_mapping' &&
        r.payload.cacheKey === cacheKey &&
        r.payload.stage === 'result' &&
        r.payload.captureId === capture.id &&
        r.payload.targetId === targetId,
    );
  if (prior) {
    if (
      !recordIsIntact(prior) ||
      prior.payload.captureHash !== capture.payload.imageHash ||
      prior.payload.dimensions?.width !== capture.payload.width ||
      prior.payload.dimensions?.height !== capture.payload.height ||
      !prior.sources.includes(capture.id)
    )
      throw Error('The saved SAM result changed; it cannot be reused.');
    return prior;
  }
  const priorAttempt = store
    .records(runId)
    .find(
      (r) =>
        r.kind === 'sam_mapping' &&
        r.payload.stage === 'requested' &&
        r.payload.captureId === capture.id &&
        r.payload.targetId === targetId &&
        r.payload.cacheKey === cacheKey,
    );
  if (priorAttempt)
    throw Error(
      'A prior SAM attempt for this original target has no usable result; it will not be silently retried.',
    );
  const count = store.usage(runId).requests.filter((r) => r.role === 'sam').length;
  const forImage = store
    .records(runId)
    .filter(
      (r) =>
        r.kind === 'sam_mapping' &&
        r.payload.captureId === capture.id &&
        r.payload.stage === 'requested',
    ).length;
  if (count >= 16 || forImage >= 2) throw Error('SAM request limit reached for this run or view.');
  store.append(
    runId,
    'sam_mapping',
    'sam',
    { stage: 'requested', captureId: capture.id, cacheKey, targetId, prompt },
    [capture.id],
  );
  const result = await models.sam(
    runId,
    image,
    prompt,
    { width: capture.payload.width, height: capture.payload.height },
    signal,
  );
  const match = result.objects.find((x) => x.objectId === '1' && overlap(x.box, target.box) >= 0.5);
  return store.append(
    runId,
    'sam_mapping',
    'sam',
    {
      ...result,
      stage: 'result',
      cacheKey,
      captureId: capture.id,
      captureHash: capture.payload.imageHash,
      targetId,
      prompt,
      dimensions: { width: capture.payload.width, height: capture.payload.height },
      match: match ? 'geometry_matches_target' : 'unresolved',
      matchingObjectId: match?.objectId,
      limit:
        'Geometric overlap is not semantic correctness or proof of an accessibility claim. Mask payloads are retained encoded; their pixels have not been decoded or validated.',
    },
    [capture.id],
  );
}
