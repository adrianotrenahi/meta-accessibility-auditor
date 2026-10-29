import { exportHostSamAssociation } from './host-sam.js';
import { exportScreenState } from './screen-state.js';
import { digest, type Store } from './store.js';
import { hostSnapshotSchema } from './host-contract.js';
import { exportKeyboardEvidence } from './keyboard-evidence.js';
import { exportHostActivity } from './host-activity.js';
import { exportHostAnalysis } from './host-analysis.js';
import { exportHostJourney } from './host-journey.js';

/** A whitelist projection: model prompts, raw candidates and private settings never leave here. */
export function exportHostSnapshot(store: Store, runId: string) {
  const run = store.run(runId);
  if (run.state === 'planning' || run.state === 'prepared')
    throw Error(
      'This proposal has not started a browser journey. Read its planning status instead.',
    );
  const records = store.records(runId);
  const originals = records.filter((record) => record.kind === 'capture');
  const assets = new Map<string, Buffer>();
  const unavailable = new Set<string>();
  const imageLimits: string[] = [];
  const captures = originals.map((record) => {
    const c = record.payload;
    const imageFile = `images/${c.imageHash}.png`;
    try {
      assets.set(imageFile, store.image(runId, c.imageFile));
    } catch {
      unavailable.add(record.id);
      imageLimits.push(
        `Original screenshot ${record.id} is unavailable or failed its integrity check; findings using it are withheld.`,
      );
    }
    const screenState = exportScreenState(record, originals);
    return {
      id: record.id,
      ...(screenState
        ? {
            recordHash: record.hash,
            screenState,
          }
        : {}),
      imageAvailable: !unavailable.has(record.id),
      sequence: record.seq,
      imageHash: c.imageHash,
      imageFile,
      width: c.width,
      height: c.height,
      url: c.url,
      title: c.title,
      stable: c.stable,
      createdAt: record.createdAt,
    };
  });
  function captureSources(sourceIds: string[]) {
    const seen = new Set<string>(),
      captured = new Set<string>(),
      pending = [...sourceIds];
    while (pending.length) {
      const id = pending.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const record = records.find((record) => record.id === id);
      if (!record) throw Error('A host finding has missing original evidence.');
      if (record.kind === 'capture') captured.add(id);
      else pending.push(...record.sources);
    }
    return originals.filter((record) => captured.has(record.id)).map((record) => record.id);
  }
  const limits = records
    .filter((record) => record.kind === 'limit')
    .map((record) =>
      String(record.payload.reason ?? record.payload.cleanup ?? 'A check was incomplete.'),
    );
  limits.push(...imageLimits);
  limits.push(...store.publicationLimits(runId));
  const findings = store.published(runId).flatMap((finding) => {
    const candidate = records.find((record) => record.id === finding.id)!;
    const review = records
      .filter((record) => record.kind === 'review' && record.payload.candidateId === candidate.id)
      .at(-1)!;
    const captureIds = captureSources(finding.evidence);
    if (captureIds.some((id) => unavailable.has(id))) return [];
    if (!captureIds.length) {
      limits.push('An accepted claim lacks a retrievable original image and is not exported.');
      return [];
    }
    let anchor = null;
    const anchorId =
      candidate.payload.targetCaptureId ?? (captureIds.length === 1 ? captureIds[0] : null);
    if (anchorId && captureIds.includes(anchorId) && candidate.payload.targetId) {
      const record = originals.find((record) => record.id === anchorId)!;
      const element = record.payload.elements.find(
        (element: { id: string }) => element.id === candidate.payload.targetId,
      );
      if (element && record.payload.stable) {
        const b = element.box;
        if (
          b.x >= 0 &&
          b.y >= 0 &&
          b.x + b.width <= record.payload.width &&
          b.y + b.height <= record.payload.height
        ) {
          const sam = exportHostSamAssociation(
            records,
            record,
            element,
            assets.get(`images/${record.payload.imageHash}.png`)!,
          );
          if (sam.limit) limits.push(sam.limit);
          anchor = {
            captureId: record.id,
            elementId: element.id,
            box: b,
            ...(sam.association ? { sam: sam.association } : {}),
          };
        }
      }
    }
    return [
      {
        id: candidate.id,
        candidateHash: candidate.hash,
        reviewHash: review.hash,
        reviewProvenance:
          review.payload.provenance === 'saved-example' || review.author.startsWith('saved_')
            ? ('saved-example' as const)
            : ('model' as const),
        title: finding.title,
        detail: finding.detail,
        recommendation: finding.recommendation,
        criterion: finding.criterion,
        basis: finding.basis,
        severity: finding.severity,
        captureIds,
        sourceIds: finding.evidence,
        anchor,
      },
    ];
  });
  const usage = store.usage(runId);
  let journey: ReturnType<typeof exportHostJourney>;
  try {
    journey = exportHostJourney(records, runId);
  } catch {
    limits.push('Ordered journey progress could not be verified; its steps remain unconfirmed.');
  }
  const snapshot = hostSnapshotSchema.parse({
    protocol: 'access-walk/host-v1',
    provenance: 'saved-engine-records',
    run: {
      id: run.id,
      goal: run.goal,
      url: run.url,
      state: run.state,
      mode: run.mode,
      createdAt: run.startedAt ?? run.createdAt,
      stopReason: run.stopReason ?? null,
    },
    sequence: 0,
    activity: exportHostActivity(records, runId, run.state === 'running'),
    analysis: exportHostAnalysis(records, runId, usage.requests),
    ...(journey ? { journey } : {}),
    captures,
    findings,
    coverage: {
      scope: 'limited',
      score: null,
      realVoiceOver: 'not-established',
      sam: 'not-established',
    },
    limits,
    cost: { usageEstimateUsd: usage.spent / 1e6, heldUnknownUsd: usage.reserved / 1e6 },
  });
  const keyboard = exportKeyboardEvidence(runId, records);
  snapshot.sequence = store.hostRevision(runId, digest(JSON.stringify({ snapshot, keyboard })));
  return { snapshot, assets, keyboard };
}
