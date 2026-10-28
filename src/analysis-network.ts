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
  return !records.some((record) => {
    if (record.kind !== 'action' || record.author !== 'browser' || record.seq <= failure.seq)
      return false;
    if (!recordIsIntact(record)) throw Error('The later original input changed.');
    if (
      record.payload.method !== 'actual_keyboard_or_browser' ||
      record.payload.outcome !== 'performed' ||
      !['press', 'type', 'scroll', 'back'].includes(record.payload.action?.kind)
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
