import { Store, recordIsIntact, digest } from './store.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CRITERIA_VERSION,
  makeCriterionScope,
  criterionAssessmentSchema,
  criterionProposalSchema,
  criterionScopeSchema,
  evaluateCriteria,
} from './criteria.js';
import { normalizeVisualCoverage, validateVisualObservation } from './visual-inspection.js';
import type { RecordEntry, RunState } from './types.js';
import type { CriteriaReport } from './criteria.js';
import { safeError } from './config.js';
import { originalClosure } from './request-evidence.js';
import { readHashMatches, suppliedImageIds } from './image-receipt.js';
import { exportHostAnalysis } from './host-analysis.js';

/** Bind only an exact declared scope already present in this verified analyst read. */
function criterionBinding(
  store: Store,
  runId: string,
  snapshot: { read: RecordEntry; records: RecordEntry[] },
  imageCaptureIds: string[],
) {
  const { read, records } = snapshot;
  const storedRead = store.record(runId, read.id);
  const current = new Map(store.records(runId).map((record) => [record.id, record]));
  const pins = new Map<string, { hash: string; sources: string[] }>();
  if (
    read.runId !== runId ||
    read.kind !== 'read_snapshot' ||
    read.author !== 'analyst' ||
    !recordIsIntact(read) ||
    !storedRead ||
    !recordIsIntact(storedRead) ||
    storedRead.runId !== read.runId ||
    storedRead.kind !== read.kind ||
    storedRead.author !== read.author ||
    storedRead.hash !== read.hash ||
    storedRead.seq !== read.seq ||
    JSON.stringify(storedRead.sources) !== JSON.stringify(read.sources) ||
    !Array.isArray(read.payload.records)
  )
    throw Error('Criterion assessment has no verified original analyst read.');
  for (const pin of read.payload.records) {
    const original = records.find((record) => record.id === pin?.id);
    const stored = original && current.get(original.id);
    if (
      !original ||
      !stored ||
      original.runId !== runId ||
      original.seq >= read.seq ||
      !recordIsIntact(original) ||
      !recordIsIntact(stored) ||
      original.hash !== stored.hash ||
      original.kind !== stored.kind ||
      original.author !== stored.author ||
      original.seq !== stored.seq ||
      original.hash !== pin.hash ||
      !Array.isArray(pin.sources) ||
      JSON.stringify(original.sources) !== JSON.stringify(pin.sources) ||
      JSON.stringify(original.sources) !== JSON.stringify(stored.sources)
    )
      throw Error('Criterion assessment read contains missing or changed original records.');
    pins.set(original.id, pin);
  }
  const pinned = (record: RecordEntry) => {
    const pin = pins.get(record.id);
    return (
      !!pin &&
      pin.hash === record.hash &&
      JSON.stringify(pin.sources) === JSON.stringify(record.sources)
    );
  };
  return (value: unknown) => {
    const modelFacing = !!value && typeof value === 'object' && 'captureId' in value;
    const supplied = modelFacing
      ? criterionAssessmentSchema.parse(value)
      : criterionProposalSchema.strict().parse(value);
    // Full stored-shape inputs are only an exact internal compatibility path, never ID repair.
    const explicitScope = modelFacing
      ? undefined
      : records.find(
          (record) => record.id === (supplied as any).scopeId && record.kind === 'criterion_scope',
        );
    const captureId = modelFacing ? (supplied as any).captureId : explicitScope?.payload?.captureId;
    const captures = records.filter(
      (record) => record.id === captureId && record.kind === 'capture',
    );
    const scopes = records.filter(
      (record) => record.kind === 'criterion_scope' && record.payload?.captureId === captureId,
    );
    const capture = captures[0],
      scope = scopes[0];
    const declared = scope && criterionScopeSchema.safeParse(scope.payload);
    if (
      captures.length !== 1 ||
      scopes.length !== 1 ||
      !capture ||
      capture.runId !== runId ||
      !recordIsIntact(capture) ||
      !pinned(capture) ||
      !imageCaptureIds.includes(capture.id) ||
      capture.payload.stable !== true ||
      !scope ||
      scope.runId !== runId ||
      !recordIsIntact(scope) ||
      !pinned(scope) ||
      !declared?.success ||
      scope.seq <= capture.seq ||
      scope.seq >= read.seq ||
      JSON.stringify(scope.sources) !== JSON.stringify([capture.id])
    )
      throw Error(
        'Criterion assessment needs exactly one intact current declared scope for its original capture.',
      );
    const check = declared.data.checks.find((entry) => entry.criterionId === supplied.criterionId)!;
    if (
      !modelFacing &&
      ((supplied as any).version !== declared.data.version ||
        (supplied as any).scopeId !== scope.id ||
        (supplied as any).checkId !== check.checkId)
    )
      throw Error(
        'The internal criterion proposal does not match its exact declared scope and check.',
      );
    const allowed = new Set([
      'capture',
      'observation',
      'action',
      'at_check',
      'navigator_note',
      'plan',
      'limit',
      'focused_check',
    ]);
    const originals = originalClosure(records, supplied.sources);
    if (
      !originals.some((record) => record.id === capture.id) ||
      originals.some(
        (record) => record.runId !== runId || !allowed.has(record.kind) || !pinned(record),
      )
    )
      throw Error('Criterion assessment did not read all of its exact original sources.');
    return criterionProposalSchema.parse({
      ...supplied,
      version: declared.data.version,
      scopeId: scope.id,
      checkId: check.checkId,
    });
  };
}

/** Declare owed checks before analysis; an unanalysed original cannot vanish from coverage. */
export function declareCriterionScopes(store: Store, runId: string) {
  const records = store.records(runId);
  const existing = new Set(
    records
      .filter(
        (r) =>
          r.kind === 'criterion_scope' &&
          recordIsIntact(r) &&
          r.payload.version === CRITERIA_VERSION,
      )
      .map((r) => r.payload.captureId),
  );
  for (const capture of records.filter((r) => r.kind === 'capture')) {
    if (existing.has(capture.id)) continue;
    store.append(runId, 'criterion_scope', 'criteria-planner', makeCriterionScope(capture.id), [
      capture.id,
    ]);
    existing.add(capture.id);
  }
}

export function recordAnalysisDetails(
  store: Store,
  runId: string,
  snapshot: { read: RecordEntry; records: RecordEntry[] },
  imageCaptureIds: string[],
  analysis: { coverage?: unknown; visualObservations?: unknown[]; criterionProposals?: unknown[] },
) {
  if (Object.hasOwn(snapshot.read.payload, 'imageReceipt')) {
    const expected = suppliedImageIds(snapshot.read, snapshot.records);
    if (
      expected.length !== imageCaptureIds.length ||
      new Set(imageCaptureIds).size !== imageCaptureIds.length ||
      expected.some((id) => !imageCaptureIds.includes(id))
    )
      throw Error('The assessment image list does not match its exact original receipt.');
  }
  const normalized = normalizeVisualCoverage(
    analysis.coverage,
    imageCaptureIds,
    snapshot.records,
    imageCaptureIds,
  );
  for (const row of normalized.coverage)
    store.append(
      runId,
      'visual_coverage',
      'analyst',
      {
        ...row,
        readSnapshotId: snapshot.read.id,
        readSnapshotHash: snapshot.read.hash,
        suppliedImageCaptureIds: imageCaptureIds,
      },
      [...new Set([row.captureId, ...row.sources])],
    );
  for (const reason of normalized.limits)
    store.append(runId, 'limit', 'analyst', { reason, check: 'visual_coverage' });
  const observations = new Map<number, RecordEntry>();
  for (const [index, value] of (analysis.visualObservations ?? []).entries()) {
    try {
      const observation = validateVisualObservation(value, snapshot.records, imageCaptureIds);
      const record = store.append(
        runId,
        'visual_observation',
        'analyst',
        {
          ...observation,
          readSnapshotId: snapshot.read.id,
          readSnapshotHash: snapshot.read.hash,
        },
        observation.sources,
      );
      observations.set(index, record);
    } catch (error) {
      store.append(runId, 'limit', 'analyst', {
        reason: safeError(error),
        check: 'visual_observation',
        index,
      });
    }
  }
  let bindCriterion: ReturnType<typeof criterionBinding> | undefined;
  let bindingError: unknown;
  if (analysis.criterionProposals?.length)
    try {
      bindCriterion = criterionBinding(store, runId, snapshot, imageCaptureIds);
    } catch (error) {
      bindingError = error;
    }
  for (const value of analysis.criterionProposals ?? []) {
    try {
      if (bindingError) throw bindingError;
      const proposal = bindCriterion!(value);
      store.append(
        runId,
        'criterion_proposal',
        'analyst',
        {
          ...proposal,
          readSnapshotId: snapshot.read.id,
          readSnapshotHash: snapshot.read.hash,
        },
        [...new Set([proposal.scopeId, ...proposal.sources])],
      );
    } catch (error) {
      store.append(runId, 'limit', 'analyst', {
        reason: safeError(error),
        check: 'criterion_proposal',
      });
    }
  }
  return observations;
}

/** Bind an expert observation to its claim; integrity is not a semantic truth verdict. */
export function visualCandidateSources(
  candidate: {
    visualTopic?: string | null;
    visualObservationIndex?: number | null;
    visiblePremise: string;
    basis: string;
    sources: string[];
  },
  observations: Map<number, RecordEntry>,
) {
  const index = candidate.visualObservationIndex;
  if (!candidate.visualTopic) {
    if (index != null || ['expert_visual', 'mixed'].includes(candidate.basis))
      throw Error('An expert visual claim needs its topic and exact visual observation.');
    return { visualObservationId: null, sources: candidate.sources };
  }
  if (index == null) throw Error('The visual claim has no exact observation reference.');
  const observation = observations.get(index);
  if (
    !observation ||
    observation.payload.topic !== candidate.visualTopic ||
    observation.payload.visiblePremise !== candidate.visiblePremise ||
    !candidate.sources.includes(observation.payload.captureId)
  )
    throw Error('The visual claim does not match its original image, topic and visible premise.');
  return {
    visualObservationId: observation.id,
    sources: [...new Set([...candidate.sources, observation.id])],
  };
}

export function finalCriteriaReport(report: CriteriaReport, state: RunState): CriteriaReport {
  if (state === 'complete' || report.score === null) return report;
  return {
    ...report,
    score: null,
    limits: [
      ...report.limits,
      'An overall score waits for a completed run and final reviewed coverage; provisional counts are not an overall score.',
    ],
  };
}

/** Read-only projection. Opening a report cannot declare scopes or start model/browser work. */
export function assessmentForRun(store: Store, runId: string) {
  const run = store.run(runId);
  if (run.id !== runId || !/^[a-f0-9-]{36}$/i.test(runId))
    throw Error('The original run identity cannot be verified.');
  const records = store.records(runId);
  const images = new Map<string, boolean>();
  const imageAvailable = (capture: RecordEntry) => {
    if (!images.has(capture.id)) {
      try {
        const p = capture.payload;
        if (
          !recordIsIntact(capture) ||
          !/^[a-zA-Z0-9_-]+\.png$/.test(p.imageFile ?? '') ||
          !/^[a-f0-9]{64}$/.test(p.imageHash ?? '')
        )
          throw Error('The original capture cannot be verified.');
        // Recheck disk bytes on every report read, without reparsing all records per picture.
        const bytes = readFileSync(join(store.dir, runId, p.imageFile));
        if (digest(bytes) !== p.imageHash) throw Error('Original image bytes changed.');
        images.set(capture.id, true);
      } catch {
        images.set(capture.id, false);
      }
    }
    return images.get(capture.id)!;
  };
  // The screens shown in the report are the ones a completed analyst request read; only
  // their checks are owed. A screen with any recorded check answer (an offline saved example,
  // say) was assessed too. Every other screenshot stays a record of the journey.
  const scopeCapture = new Map(
    records.filter((r) => r.kind === 'criterion_scope').map((r) => [r.id, r.payload?.captureId]),
  );
  const analysedCaptureIds = new Set<string>([
    ...exportHostAnalysis(records, runId, store.usage(runId).requests)
      .completed.filter((row) => row.role === 'analyst')
      .flatMap((row) => row.captureIds),
    ...records
      .filter((r) => r.kind === 'criterion_proposal')
      .map((r) => scopeCapture.get(r.payload?.scopeId))
      .filter((id): id is string => typeof id === 'string'),
  ]);
  const criteria = finalCriteriaReport(
    evaluateCriteria(records, runId, { imageAvailable, analysedCaptureIds }),
    run.state,
  );
  const availableImageIds = records
    .filter((r) => r.kind === 'capture' && imageAvailable(r))
    .map((r) => r.id);
  const latest = new Map<string, RecordEntry>();
  const visualRows = records.filter((r) => r.kind === 'visual_coverage');
  const unreadableCoverage = visualRows.some((row) => !recordIsIntact(row));
  if (!unreadableCoverage)
    for (const row of visualRows)
      latest.set(JSON.stringify([row.payload.captureId, row.payload.topic]), row);
  const visualCoverage: unknown[] = [];
  // Call-local only: every later report reload validates its manifests and disk images again.
  const byId = new Map(records.map((record) => [record.id, record]));
  const manifests = new Map<
    string,
    { read: RecordEntry; ids: Set<string>; images: Set<string> } | null
  >();
  const visualManifest = (id: string) => {
    if (manifests.has(id)) return manifests.get(id)!;
    const read = byId.get(id);
    if (
      !read ||
      read.kind !== 'read_snapshot' ||
      read.author !== 'analyst' ||
      !recordIsIntact(read) ||
      !Array.isArray(read.payload.records)
    ) {
      manifests.set(id, null);
      return null;
    }
    const ids = new Set<string>();
    for (const pin of read.payload.records) {
      const original = byId.get(pin.id);
      if (
        !original ||
        !recordIsIntact(original) ||
        pin.hash !== original.hash ||
        !Array.isArray(pin.sources) ||
        JSON.stringify(pin.sources) !== JSON.stringify(original.sources)
      ) {
        manifests.set(id, null);
        return null;
      }
      ids.add(pin.id);
    }
    let images: Set<string>;
    try {
      images = new Set(suppliedImageIds(read, records));
    } catch {
      manifests.set(id, null);
      return null;
    }
    const verified = { read, ids, images };
    manifests.set(id, verified);
    return verified;
  };
  for (const capture of records.filter((r) => r.kind === 'capture')) {
    const entries = [...latest.values()]
      .filter((row) => {
        if (row.payload.captureId !== capture.id || !recordIsIntact(row)) return false;
        const manifest = visualManifest(row.payload.readSnapshotId);
        if (!manifest || manifest.read.seq <= capture.seq || row.seq <= manifest.read.seq)
          return false;
        if (!readHashMatches(manifest.read, row.payload.readSnapshotHash)) return false;
        if (!manifest.images.has(capture.id)) return false;
        try {
          return originalClosure(records, row.payload.sources).every(
            (original) =>
              manifest.ids.has(original.id) &&
              (original.kind !== 'capture' ||
                row.payload.suppliedImageCaptureIds?.includes(original.id)),
          );
        } catch {
          return false;
        }
      })
      .map((r) => {
        const { captureId, topic, state, reason, sources } = r.payload;
        return { captureId, topic, state, reason, sources };
      });
    visualCoverage.push(
      ...normalizeVisualCoverage(entries, [capture.id], records, availableImageIds).coverage,
    );
  }
  return {
    protocol: 'access-walk/assessment-v1' as const,
    runId,
    version: CRITERIA_VERSION,
    sequence: records.at(-1)?.seq ?? 0,
    scope:
      'Fifteen criteria for the recorded journey; not full Cavioo coverage or accessibility certification.',
    criteria,
    visualCoverage,
    visualLimits: unreadableCoverage
      ? [
          'A visual coverage record changed or is unreadable; previous examinations cannot be assumed current.',
        ]
      : [],
  };
}
