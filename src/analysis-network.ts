import { MetaTransportError } from './meta-transport.js';
import type { RecordEntry } from './types.js';
import { recordIsIntact } from './store.js';

export type AnalysisRole = 'analyst' | 'reviewer';
export class AnalysisNetworkUnavailable extends Error {
  constructor(public readonly role: AnalysisRole) {
    super(
      'The analysis or review connection did not return a usable result. Its checkpoint remains unknown and any possible charge stays held. This request will not be repeated; navigation needs a fresh observation.',
    );
  }
}
/** Bind only these exact caller roles, after the model wrapper has retained cost. */
export async function optionalAnalysisRequest<T>(role: AnalysisRole, request: () => Promise<T>) {
  if (!['analyst', 'reviewer'].includes(role))
    throw Error('Only analysis or review may defer a network result.');
  try {
    return await request();
  } catch (error) {
    if (error instanceof MetaTransportError && error.analysisMayContinue)
      throw new AnalysisNetworkUnavailable(role);
    throw error;
  }
}
/** A fresh picture alone cannot silently reopen an unknown generation. A later
 * actual browser input creates new walk evidence for a different checkpoint.
 */
export function analysisNetworkDeferred(records: RecordEntry[], role: AnalysisRole) {
  const failure = records.findLast(
    (record) =>
      record.kind === 'limit' &&
      record.author === role &&
      record.payload.method === 'analysis_network_unavailable',
  );
  if (!failure) return false;
  if (!recordIsIntact(failure)) throw Error('The saved analysis interruption changed.');
  // Measured from the failed checkpoint's own screenshot: on the analysis track the robot may
  // already have moved on before the failure is saved, and those inputs are new evidence.
  const checkpoint = records.find(
    (record) => record.kind === 'capture' && record.id === failure.payload.checkpointCaptureId,
  );
  const after = Math.min(failure.seq, checkpoint?.seq ?? failure.seq);
  return !records.some((record) => {
    if (record.kind !== 'action' || record.author !== 'browser' || record.seq <= after)
      return false;
    if (!recordIsIntact(record)) throw Error('The later original input changed.');
    // A dropdown choice that sent presses changed the page even when it stopped short.
    const dropdownPresses =
      record.payload.action?.kind === 'choose_option' && Number(record.payload.action?.presses) > 0;
    if (
      record.payload.method !== 'actual_keyboard_or_browser' ||
      (!dropdownPresses &&
        (record.payload.outcome !== 'performed' ||
          !['press', 'type', 'scroll', 'back'].includes(record.payload.action?.kind)))
    )
      return false;
    const source = records.find((item) => item.id === record.payload.sourceCaptureId);
    if (!source || !record.sources.includes(source.id)) return false;
    if (!recordIsIntact(source)) throw Error('The later input original capture changed.');
    return (
      source.kind === 'capture' &&
      source.author === 'browser' &&
      source.payload.stable === true &&
      record.payload.sourceImageHash === source.payload.imageHash
    );
  });
}
