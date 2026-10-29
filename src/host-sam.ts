import { decodeSavedSamMask } from './sam-mask.js';
import { samAssociationSchema, samAssociationFits } from './sam-association.js';
import type { ElementInfo, RecordEntry } from './types.js';

/** Read-only association for an already reviewed finding; no model is constructed or called. */
export function exportHostSamAssociation(
  records: readonly RecordEntry[],
  capture: RecordEntry,
  element: ElementInfo,
  image: Uint8Array,
) {
  const matches = records.filter(
    (record) =>
      record.kind === 'sam_mapping' &&
      record.payload.stage === 'result' &&
      record.payload.captureId === capture.id &&
      record.payload.targetId === element.id,
  );
  if (!matches.length) return {};
  const limit =
    'A saved SAM association for this original target could not be verified; its ordinary finding marker is retained without SAM.';
  try {
    if (matches.length !== 1) return { limit };
    const decoded = decodeSavedSamMask(matches[0], capture, image);
    if (decoded.state !== 'decoded') return { limit };
    const association = samAssociationSchema.parse({
      version: 'prompted-sam-association/1',
      mappingId: decoded.mappingId,
      mappingHash: decoded.mappingHash,
      captureId: decoded.captureId,
      captureHash: decoded.captureHash,
      imageHash: decoded.imageHash,
      targetId: decoded.targetId,
      width: decoded.width,
      height: decoded.height,
      targetBox: element.box,
      bounds: decoded.bounds,
      maskWidth: decoded.maskWidth,
      maskHeight: decoded.maskHeight,
      foregroundPixels: decoded.foregroundPixels,
      rasterHash: decoded.rasterHash,
    });
    if (
      !samAssociationFits(
        association,
        { captureId: capture.id, elementId: element.id, box: element.box },
        {
          id: capture.id,
          imageHash: capture.payload.imageHash,
          width: capture.payload.width,
          height: capture.payload.height,
          stable: capture.payload.stable === true,
          imageAvailable: true,
        },
      )
    )
      return { limit };
    return { association };
  } catch {
    return { limit };
  }
}
