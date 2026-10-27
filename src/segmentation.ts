import { Store } from './store.js';
import { MetaModels } from './models.js';
import type { RecordEntry, ElementInfo } from './types.js';
export function overlap(a: ElementInfo['box'], b: ElementInfo['box']) {
  const w = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)),
    h = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const intersection = w * h;
  return intersection / (a.width * a.height + b.width * b.height - intersection || 1);
}
export function boxPrompt(target: ElementInfo, width: number, height: number) {
  const x1 = Math.max(0, Math.floor(target.box.x)),
    y1 = Math.max(0, Math.floor(target.box.y)),
    x2 = Math.min(width, Math.ceil(target.box.x + target.box.width)),
    y2 = Math.min(height, Math.ceil(target.box.y + target.box.height));
  if (x1 >= x2 || y1 >= y2) throw Error('The element is outside this capture.');
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
  if (capture.kind !== 'capture' || capture.runId !== runId)
    throw Error('SAM needs the exact original capture.');
  const target = capture.payload.elements.find((x: ElementInfo) => x.id === targetId);
  if (!target) throw Error('The proposed element is not part of this capture.');
  const prompt = boxPrompt(target, capture.payload.width, capture.payload.height),
    cacheKey = `sam-3.1:${capture.payload.imageHash}:${prompt}`;
  const prior = store
    .records(runId)
    .find(
      (r) =>
        r.kind === 'sam_mapping' && r.payload.cacheKey === cacheKey && r.payload.stage === 'result',
    );
  if (prior) return prior;
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
  const image =
    'data:image/png;base64,' + store.image(runId, capture.payload.imageFile).toString('base64');
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
      limit: 'Geometric overlap is not semantic correctness or proof of an accessibility claim.',
    },
    [capture.id],
  );
}
