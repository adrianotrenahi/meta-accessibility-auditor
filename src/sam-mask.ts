import { decodeMaskToRaster, decodeMaskToSVGPath } from '@meta-sam/parser';
import { digest, recordIsIntact } from './store.js';
import { parseSam } from './models.js';
import { boxPrompt, overlap } from './segmentation.js';
import type { ElementInfo, RecordEntry } from './types.js';

export const SAM_MASK_LIMITS = Object.freeze({
  pixels: 1_500_000,
  responseCharacters: 200_000,
  pathCharacters: 200_000,
  imageBytes: 4 * 1024 * 1024,
  objects: 16,
});

/** Read-only geometry derived from one exact saved SAM reply. Never an accessibility verdict. */
export function decodeSavedSamMask(mapping: RecordEntry, capture: RecordEntry, image: Uint8Array) {
  const raw = mapping.payload?.raw;
  if (
    typeof raw !== 'string' ||
    raw.length > SAM_MASK_LIMITS.responseCharacters ||
    !Array.isArray(mapping.payload.objects) ||
    mapping.payload.objects.length > SAM_MASK_LIMITS.objects
  )
    throw Error('The saved outline reply exceeds the supported text or object allowance.');
  if (image.byteLength < 33 || image.byteLength > SAM_MASK_LIMITS.imageBytes)
    throw Error('The original image exceeds the supported byte allowance.');
  if (
    mapping.kind !== 'sam_mapping' ||
    mapping.author !== 'sam' ||
    capture.kind !== 'capture' ||
    capture.author !== 'browser' ||
    mapping.runId !== capture.runId ||
    mapping.seq <= capture.seq ||
    !recordIsIntact(mapping) ||
    !recordIsIntact(capture) ||
    capture.payload.stable !== true ||
    mapping.payload.stage !== 'result' ||
    mapping.payload.source !== 'SAM 3.1' ||
    JSON.stringify(mapping.sources) !== JSON.stringify([capture.id]) ||
    mapping.payload.captureId !== capture.id ||
    mapping.payload.captureHash !== capture.payload.imageHash
  )
    throw Error('A decoded outline needs its intact saved SAM reply and exact stable original.');
  const { width, height } = capture.payload;
  if (
    ![width, height].every(Number.isSafeInteger) ||
    width <= 0 ||
    height <= 0 ||
    width * height > SAM_MASK_LIMITS.pixels ||
    mapping.payload.dimensions?.width !== width ||
    mapping.payload.dimensions?.height !== height
  )
    throw Error('The outline exceeds the supported original-image dimensions.');
  const bytes = Buffer.from(image);
  if (
    bytes.length < 33 ||
    bytes.length > SAM_MASK_LIMITS.imageBytes ||
    bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
    bytes.subarray(12, 16).toString('ascii') !== 'IHDR' ||
    bytes.readUInt32BE(8) !== 13 ||
    bytes.readUInt32BE(16) !== width ||
    bytes.readUInt32BE(20) !== height ||
    digest(bytes) !== capture.payload.imageHash
  )
    throw Error('The outline original image is missing, changed or dimensionally inconsistent.');
  const targets: ElementInfo[] = Array.isArray(capture.payload.elements)
    ? capture.payload.elements.filter(
        (element: ElementInfo) => element.id === mapping.payload.targetId,
      )
    : [];
  if (
    targets.length !== 1 ||
    (targets[0].selector &&
      capture.payload.elements.filter(
        (element: ElementInfo) => element.selector === targets[0].selector,
      ).length !== 1)
  )
    throw Error('A decoded outline needs one exact original target.');
  const prompt = boxPrompt(targets[0], width, height);
  if (
    mapping.payload.prompt !== prompt ||
    mapping.payload.cacheKey !== `sam-3.1:${capture.payload.imageHash}:${prompt}`
  )
    throw Error('The saved outline prompt does not identify this original target.');
  const objects = parseSam(raw, { width, height });
  if (
    objects.length > SAM_MASK_LIMITS.objects ||
    JSON.stringify(objects) !== JSON.stringify(mapping.payload.objects)
  )
    throw Error('The saved outline objects disagree with the complete original reply.');
  const source = {
    protocol: 'access-walk/decoded-mask-v1' as const,
    runId: capture.runId,
    mappingId: mapping.id,
    mappingHash: mapping.hash,
    captureId: capture.id,
    captureHash: capture.hash,
    imageHash: capture.payload.imageHash,
    width,
    height,
    targetId: mapping.payload.targetId,
    limit:
      'Prompted geometry only; this is not autonomous recognition, keyboard/screen-reader evidence or an accessibility verdict.',
  };
  if (
    mapping.payload.match !== 'geometry_matches_target' ||
    mapping.payload.matchingObjectId !== '1'
  )
    return {
      ...source,
      state: 'unresolved' as const,
      reason: 'The original response did not establish a matching target.',
    };
  const object = objects.find((object) => object.objectId === '1');
  if (!object || overlap(object.box, targets[0].box) < 0.5)
    throw Error('The saved outline does not overlap the exact original target sufficiently.');
  const fields = object.maskToken.match(
    /^<\|mask;x=0;y=0(?:;c=[^;]+)?;data=(\d+),(\d+),([!~])([^|]+)\|>$/,
  );
  if (!fields) throw Error('The complete saved mask cannot be read.');
  const maskHeight = Number(fields[1]),
    maskWidth = Number(fields[2]);
  if (
    maskWidth !== object.box.width ||
    maskHeight !== object.box.height ||
    maskWidth * maskHeight > SAM_MASK_LIMITS.pixels
  )
    throw Error('The mask dimensions do not match its original source-pixel box.');
  // The official decoder requires the encoding marker too, despite its type comment.
  const mask = {
    width: maskWidth,
    height: maskHeight,
    encoding: fields[3] === '!' ? ('one_bit' as const) : ('lossless' as const),
    payload: fields[3] + fields[4],
  };
  const raster = decodeMaskToRaster(mask);
  if (
    raster.length !== maskWidth * maskHeight ||
    raster.some((value) => value !== 0 && value !== 1)
  )
    throw Error('The saved mask did not decode into a complete binary shape.');
  const foregroundPixels = raster.reduce((sum, value) => sum + value, 0);
  const svgPath = foregroundPixels ? decodeMaskToSVGPath(mask) : '';
  if (
    svgPath.length > SAM_MASK_LIMITS.pathCharacters ||
    !/^[MLZ0-9., eE+\-]*$/.test(svgPath) ||
    (foregroundPixels > 0 && !svgPath)
  )
    throw Error('The decoded outline exceeds the supported safe shape allowance.');
  return {
    ...source,
    state: foregroundPixels ? ('decoded' as const) : ('empty' as const),
    objectId: object.objectId,
    bounds: object.box,
    pathCoordinates: 'mask-local-pixel-centers' as const,
    sourceTranslation: { x: object.box.x + 0.5, y: object.box.y + 0.5 },
    maskWidth,
    maskHeight,
    foregroundPixels,
    rasterHash: digest(raster),
    svgPath,
    svgPathHash: digest(svgPath),
  };
}
