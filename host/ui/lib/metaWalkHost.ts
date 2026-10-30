// Offline host boundary for the public access-walk/host-v1 protocol.
// Public schema mirrored using Cavioo's existing Zod version; the cross-repo
// proof exercises the public exporter against this independent consumer.
import { z } from 'zod';
import { samAssociationSchema, samAssociationFits } from './metaSamAssociation';
import { classifyDeviceScope } from './deviceScope';
import { railGroupKey } from '@/components/audits/railGroupKey';
import { metaActivitySchema, metaActivityThoughts } from './metaActivity';
import { metaAnalysisSchema, metaAnalysisAttribution } from './metaAnalysis';
import { normalizeMetaScreenStates, metaScreenGroups } from './metaScreenState';
import { metaJourneySchema, metaJourneyFits } from './metaJourney';

const id = z.string().min(1).max(200);
const webUrl = z.string().url().refine((value) => /^https?:\/\//.test(value), 'Expected a web URL');
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const box = z
  .object({
    x: z.number().nonnegative(),
    y: z.number().nonnegative(),
    width: z.number().positive(),
    height: z.number().positive(),
  })
  .strict();
export const hostSnapshotSchema = z
  .object({
    protocol: z.literal('access-walk/host-v1'),
    provenance: z.literal('saved-engine-records'),
    run: z
      .object({
        id,
        goal: z.string(),
        url: webUrl,
        state: z.enum(['running', 'complete', 'partial', 'stopped', 'interrupted']),
        mode: z.enum(['offline', 'live']),
        createdAt: z.string().datetime(),
        stopReason: z.string().nullable(),
      })
      .strict(),
    sequence: z.number().int().nonnegative(),
    activity: metaActivitySchema.optional(),
    analysis: metaAnalysisSchema.optional(),
    journey: z.unknown().optional(),
    captures: z.array(
      z
        .object({
          id,
          sequence: z.number().int().positive(),
          recordHash: hash.optional(),
          screenState: z.unknown().optional(),
          imageHash: hash,
          imageAvailable: z.boolean(),
          imageFile: z.string().regex(/^images\/[a-f0-9]{64}\.png$/),
          width: z.number().int().positive(),
          height: z.number().int().positive(),
          url: webUrl,
          title: z.string(),
          stable: z.boolean(),
          createdAt: z.string().datetime(),
        })
        .strict(),
    ),
    findings: z.array(
      z
        .object({
          id,
          candidateHash: hash,
          reviewHash: hash,
          reviewProvenance: z.enum(['saved-example', 'model']),
          title: z.string(),
          detail: z.string(),
          recommendation: z.string(),
          criterion: z.string().nullable(),
          basis: z.enum(['measured', 'expert_visual', 'mixed']),
          severity: z.enum(['blocker', 'serious', 'minor']),
          captureIds: z.array(id).min(1),
          sourceIds: z.array(id).min(1),
          anchor: z.object({ captureId: id, elementId: id, box, sam: z.unknown().optional() }).strict().nullable(),
        })
        .strict(),
    ),
    coverage: z
      .object({
        scope: z.literal('limited'),
        score: z.null(),
        realVoiceOver: z.literal('not-established'),
        sam: z.literal('not-established'),
      })
      .strict(),
    limits: z.array(z.string()),
    cost: z
      .object({
        usageEstimateUsd: z.number().nonnegative(),
        heldUnknownUsd: z.number().nonnegative(),
      })
      .strict(),
  })
  .strict()
  .transform((snapshot) => {
    const states = normalizeMetaScreenStates(snapshot.captures);
    const { journey: rawJourney, ...core } = snapshot;
    const parsedJourney = metaJourneySchema.safeParse(rawJourney);
    const journey = parsedJourney.success && metaJourneyFits(parsedJourney.data, snapshot)
      ? parsedJourney.data : undefined;
    const progressLimits = rawJourney !== undefined && !journey
      ? ['Ordered journey progress could not be verified; its steps remain unconfirmed.'] : [];
    let withheld = false;
    const findings = snapshot.findings.map((finding) => {
      if (!finding.anchor) return { ...finding, anchor: null };
      const { sam: originalSam, ...anchor } = finding.anchor;
      const capture = snapshot.captures.find((c) => c.id === anchor.captureId);
      const parsed = samAssociationSchema.safeParse(originalSam);
      const sam = parsed.success && capture && samAssociationFits(parsed.data, anchor, capture)
        ? parsed.data : undefined;
      if (originalSam !== undefined && !sam) withheld = true;
      const retainedAnchor: typeof anchor & { sam?: z.infer<typeof samAssociationSchema> } = sam ? { ...anchor, sam } : anchor;
      return { ...finding, anchor: retainedAnchor };
    });
    return {
      ...core,
      ...(journey ? { journey } : {}),
      captures: states.captures,
      findings,
      limits: withheld || states.withheld || progressLimits.length ? [...new Set([...snapshot.limits, ...progressLimits,
        ...(withheld ? ['An optional SAM association could not be verified; the independently supported finding is retained without SAM.'] : []),
        ...(states.withheld ? ['Optional screen-state grouping could not be verified; original screens remain separate.'] : []),
      ])] : snapshot.limits,
    };
  })
  .superRefine((snapshot, ctx) => {
    if (snapshot.activity && snapshot.activity.runId !== snapshot.run.id)
      ctx.addIssue({code:'custom',message:'Recorded activity belongs to a different run'});
    if (snapshot.analysis && (snapshot.analysis.runId !== snapshot.run.id ||
        (snapshot.run.mode !== 'live' && snapshot.analysis.completed.length > 0) ||
        snapshot.analysis.completed.some((row) => row.captureIds.some((id) =>
          !snapshot.captures.some((capture) => capture.id === id && capture.sequence < row.readSnapshotSequence)))))
      ctx.addIssue({ code: 'custom', message: 'Completed analysis does not match this original run and its screens' });
    const ids = new Set<string>();
    let previousSequence = 0;
    for (const capture of snapshot.captures) {
      if (capture.sequence <= previousSequence)
        ctx.addIssue({code: 'custom', message: 'Captures must retain their original order'});
      previousSequence = capture.sequence;
      if (ids.has(capture.id))
        ctx.addIssue({ code: 'custom', message: 'Duplicate capture identity' });
      ids.add(capture.id);
      if (capture.imageFile !== `images/${capture.imageHash}.png`)
        ctx.addIssue({ code: 'custom', message: 'Capture image hash and file disagree' });
    }
    const findings = new Set<string>();
    const capturesById = new Map(snapshot.captures.map((capture) => [capture.id, capture]));
    for (const finding of snapshot.findings) {
      if (findings.has(finding.id))
        ctx.addIssue({ code: 'custom', message: 'Duplicate finding identity' });
      findings.add(finding.id);
      if (finding.captureIds.some((captureId) => !ids.has(captureId)))
        ctx.addIssue({ code: 'custom', message: 'Finding refers to missing original capture' });
      if (finding.captureIds.some((captureId) => capturesById.get(captureId)?.imageAvailable === false))
        ctx.addIssue({ code: 'custom', message: 'Finding requires every original image to be available' });
      if (finding.anchor) {
        const capture = snapshot.captures.find((c) => c.id === finding.anchor!.captureId);
        const b = finding.anchor.box;
        if (finding.anchor.sam && (!capture || !samAssociationFits(finding.anchor.sam, finding.anchor, capture)))
          ctx.addIssue({ code: 'custom', message: 'SAM association does not match its original finding target' });
        if (
          !capture ||
          !capture.stable ||
          !capture.imageAvailable ||
          !finding.captureIds.includes(capture.id) ||
          b.x + b.width > capture.width ||
          b.y + b.height > capture.height
        )
          ctx.addIssue({
            code: 'custom',
            message: 'Finding anchor does not fit its original capture',
          });
      }
    }
  });
export type HostSnapshot = z.infer<typeof hostSnapshotSchema>;

/** Reconnects replace a saved state; they never start a browser or a model. */
export function applyHostSnapshot(
  current: HostSnapshot | undefined,
  incoming: unknown,
): HostSnapshot {
  const next = hostSnapshotSchema.parse(incoming);
  if (!current) return next;
  if (next.run.id !== current.run.id)
    throw Error('A different run needs a separate host connection.');
  if (next.sequence <= current.sequence) return current;
  for (const field of ['goal', 'url', 'mode', 'createdAt'] as const) {
    if (next.run[field] !== current.run[field]) throw Error('The original run identity cannot change.');
  }
  for (const previous of current.captures) {
    const now = next.captures.find((capture) => capture.id === previous.id);
    const {imageAvailable: _wasAvailable, ...original} = previous;
    const {imageAvailable: _isAvailable, ...retained} = now ?? {};
    if (!now || JSON.stringify(retained) !== JSON.stringify(original))
      throw Error('A retained original capture cannot be changed or removed.');
  }
  for (const previous of current.activity?.entries ?? []) {
    const retained = next.activity?.entries.find((entry) => entry.id === previous.id);
    if (retained && JSON.stringify(retained) !== JSON.stringify(previous))
      throw Error('A retained recorded activity entry cannot be rewritten.');
  }
  for (const previous of current.analysis?.completed ?? []) {
    const retained = next.analysis?.completed.find((row) => row.id === previous.id);
    if (!retained || JSON.stringify(retained) !== JSON.stringify(previous))
      throw Error('A retained completed analysis receipt cannot be rewritten or removed.');
  }
  return next;
}


import type { AuditIssue, AuditScope, AuditStep, AuditSynthesis } from "@/components/audits/AuditReportClient";
import type { Issue } from "@/components/AnnotationPostit";
import type { JobProgress } from "@/app/audits/new/RunProgress";

export type MetaWalkIssue = AuditIssue & Issue;
const severity = { blocker: ["CRITICAL", 5], serious: ["MAJOR", 4], minor: ["MINOR", 2] } as const;

/** Claim wording follows retained reviews; mode alone does not prove a model result. */
export function metaReviewSource(snapshot: HostSnapshot) {
  const model = snapshot.findings.some((finding) => finding.reviewProvenance === "model");
  const saved = snapshot.findings.some((finding) => finding.reviewProvenance === "saved-example");
  return model && saved
    ? "actual Meta model-reviewed findings and saved review examples"
    : model
      ? "actual Meta model-reviewed findings"
      : saved
        ? "saved review examples"
        : "no accepted reviewed findings";
}

/** Pure projection: no requests, writes, scoring, analysis or browser launch. */
export function projectMetaWalk(snapshot: HostSnapshot, host?: {sessionId: string; evidenceBase: string}) {
  const sessionId=host?.sessionId ?? snapshot.run.id;
  const live = snapshot.run.mode === "live";
  const publicSite = live && new URL(snapshot.run.url).hostname !== "127.0.0.1";
  const reviewSource = metaReviewSource(snapshot);
  const imageUrl = (hash: string) => `${host?.evidenceBase ?? "/evidence"}/${hash}.png`;
  const originals: AuditStep[] = snapshot.captures.map((capture, order) => ({
    id: capture.id, evidenceId: capture.id, sessionId,
    customTitle: capture.title || null, stageId: null, kind: "screen",
    captureProfile: classifyDeviceScope(capture.width), devicePreset: null,
    url: capture.url, pageTitle: capture.title, stateLabel: null, shortLabel: null,
    order, viewportWidth: capture.width, viewportHeight: capture.height,
    notes: `Original ${publicSite ? "website" : "controlled browser"} capture. Limited ${live ? "Meta live" : "offline"} proof; no complete Cavioo assessment.`,
    capturedAt: capture.createdAt, screenshotUrl: capture.imageAvailable ? imageUrl(capture.imageHash) : null,
    screenshotVariants: [{
      evidenceId: capture.id,
      screenshotUrl: capture.imageAvailable ? imageUrl(capture.imageHash) : null,
      hasFailedEvidence: !capture.imageAvailable,
      devicePreset: null,
      viewportWidth: capture.width,
      viewportHeight: capture.height,
      label: "Original viewport",
      customTitle: null,
    }], hasFailedEvidence: !capture.imageAvailable,
    perfMetrics: null, keyboardRoute: null, keyboardMap: null, attentionMap: null,
    wcagChecksRan: null, axeRuleResults: null, formFieldInCensus: null,
    aiAnalysisStatus: publicSite && snapshot.captures.length === 1 &&
      snapshot.run.stopReason === "The website presented an access-denied entry page. The requested journey was not reached; no model request was made."
      ? "access_denied" : "skipped", aiAnalysisError: null, source: "autonomous",
  }));
  const groups = metaScreenGroups(snapshot.captures);
  const originalsById = new Map(originals.map((step) => [step.id, step]));
  const screenForCapture = new Map(groups.flatMap((group) =>
    group.originals.map((capture) => [capture.id, group.primary.id] as const)));
  const steps: AuditStep[] = groups.map((group, order) => {
    const primary = originalsById.get(group.primary.id)!;
    return {
      ...primary, order,
      showOriginalVariants: group.originals.length > 1,
      screenshotVariants: group.originals.flatMap((capture, index) =>
        originalsById.get(capture.id)!.screenshotVariants.map((variant) => ({
          ...variant,
          label: group.originals.length > 1 ? `Original ${index + 1}` : variant.label,
        }))),
      notes: group.originals.length > 1
        ? `${primary.notes} ${group.originals.length} original pictures are retained for this screen state. Their focus and evidence checks remain separate; grouping does not establish that any check passed.`
        : primary.notes,
    };
  });
  const issues: MetaWalkIssue[] = snapshot.findings.map((finding) => {
    const captureId = finding.anchor?.captureId ?? finding.captureIds[0]!;
    const capture = snapshot.captures.find((item) => item.id === captureId)!;
    const b = finding.anchor?.box;
    const point = b ? { x: (b.x + b.width / 2) / capture.width * 100,
      y: (b.y + b.height / 2) / capture.height * 100 } : null;
    return {
      id: finding.id, sessionId, stepId: screenForCapture.get(capture.id)!,
      analysisRunId: null, analysisType: finding.criterion === "C02" ? "accessibility" : null, aiId: null, duplicateOfId: null,
      category: finding.criterion === "C02" ? "Accessibility" : null, title: finding.title, problemStatement: finding.detail,
      recommendation: finding.recommendation, quickWin: null, deeperFix: null,
      userImpactRationale: null, userImpactDetail: null, affectedUsers: null,
      expectedImpact: null, metrics: null,
      severity: severity[finding.severity][0], severityScore: severity[finding.severity][1],
      severityRationale: null, severityLabelText: null,
      // Neither a model review nor a saved example establishes reproduction or confidence.
      confidence: null, reproConfirmed: null, status: "ready",
      pinX: point?.x ?? null, pinY: point?.y ?? null,
      pinTargetId: finding.anchor?.elementId ?? null,
      pinBBox: b ? { x: b.x, y: b.y, w: b.width, h: b.height } : null,
      pinOriginal: point, pinGrounded: point, groundingConfidence: null,
      requiresPinReview: false, pinSource: b ? "bbox" : null, deviceScope: classifyDeviceScope(capture.width),
      analyzedEvidenceId: capture.id, rubricCriterionId: null,
      createdAt: capture.createdAt, updatedAt: capture.createdAt,
    };
  });
  const latest = snapshot.captures.at(-1);
  // New explicit state receipts retain a row for a modal/menu/viewport change.
  // Legacy originals keep their previous consecutive page-visit preview only.
  const pageVisits: AuditStep[] = [];
  const explicitStates = new Set(snapshot.captures.filter((capture) => capture.screenState).map((capture) => capture.id));
  for (const step of steps) {
    const previous = pageVisits.at(-1);
    const key = railGroupKey(step, step.pageTitle || 'Untitled');
    if (!explicitStates.has(step.id) && previous && !explicitStates.has(previous.id) &&
      railGroupKey(previous, previous.pageTitle || 'Untitled') === key)
      pageVisits[pageVisits.length - 1] = step;
    else pageVisits.push(step);
  }
  const scope: AuditScope = { siteHost: new URL(snapshot.run.url).host,
    entryUrl: snapshot.run.url, journey: snapshot.run.goal, flowSteps: [],
    devices: ["desktop"], source: "autonomous", recordedAnalysis: metaAnalysisAttribution(snapshot, sessionId) };
  const progress: JobProgress = {
    phase: "capturing", message: live ? (publicSite ? "Meta website run" : "Controlled Meta live run") : "Recorded offline replay",
    currentUrl: latest?.url, pageTitle: latest?.title,
    screenshotUrl: latest?.imageAvailable ? imageUrl(latest.imageHash) : undefined,
    screensFinal: snapshot.run.state !== "running",
    screens: pageVisits.map((step, index) => ({ order: index, label: step.pageTitle || `Screen ${index + 1}`,
      url: step.url!, screenshotUrl: step.screenshotUrl ?? undefined, status: "captured", kind: "screen" })),
    tasks: [],
    thoughts: metaActivityThoughts(snapshot),
  };
  const synthesis: AuditSynthesis = {
    executiveSummary: live
      ? `${publicSite ? "Meta website run" : "Controlled Meta live proof"} using original browser screens and ${reviewSource}. This is a limited check, with no full accessibility assessment or score.`
      : "Offline compatibility proof using recorded browser screens and saved review examples. This is a limited check, with no full accessibility assessment or score.",
    verdictHeadline: "Recorded evidence, limited assessment", userGoal: snapshot.run.goal,
    successCriteria: [], darkPatterns: [], limitations: [...snapshot.limits,
      "Real VoiceOver, SAM and live video transport are not established."],
    methodologyNote: live
      ? `This report reads retained original records with ${reviewSource}; opening it does not call a model. A screen with no finding is not a clean-screen verdict.`
      : "Prepared locally from saved records, without model calls. A screen with no finding is not a clean-screen verdict.",
    sectionHeadlines: {}, overviewCards: [], recommendationFacts: [], briefOutcomes: [],
    journeyBeats: steps.map((step) => ({fromStepId: step.id, toStepId: step.id,
      line: issues.some((issue) => issue.stepId === step.id)
        ? `${live ? "Reviewed" : "Saved reviewed"} finding on this screen; the broader assessment remains incomplete.`
        : `Captured for the ${live ? (publicSite ? "public website" : "controlled live") : "offline"} ${publicSite ? "run" : "proof"}. This screen has not received a complete assessment.`,
      metric: null, metricLabel: null})),
    priceWalk: [], rootCauses: [], dimensionNotes: {}, featureNotes: [], promptHash: null,
    generatedAt: snapshot.run.createdAt,
  };
  return { steps, issues, scope, progress, synthesis, rubric: null,
    sources: new Map(snapshot.findings.map((finding) => [finding.id, {
      candidateHash: finding.candidateHash, reviewHash: finding.reviewHash,
      provenance: finding.reviewProvenance, captureIds: finding.captureIds, sourceIds: finding.sourceIds,
    }])) };
}

/** A matching URL is insufficient: pins belong to the exact saved capture. */
export function metaWalkPins(snapshot: HostSnapshot, displayedCaptureId: string, displayedImageHash: string) {
  const capture = snapshot.captures.find((item) => item.id === displayedCaptureId);
  if (!capture || !capture.stable || !capture.imageAvailable || capture.imageHash !== displayedImageHash) return [];
  const anchored = new Set(snapshot.findings.filter((finding) => finding.anchor?.captureId === capture.id).map((finding) => finding.id));
  return projectMetaWalk(snapshot).issues.filter((issue) => anchored.has(issue.id));
}

export interface MetaReplayState {
  snapshot: HostSnapshot;
  position: number;
  refusal: string | null;
}
/** A refused record leaves the last valid evidence visible; replay does no work. */
export function advanceMetaReplay(current: MetaReplayState, snapshots: readonly unknown[]): MetaReplayState {
  if (current.refusal || current.position >= snapshots.length - 1) return current;
  const position = current.position + 1;
  try {
    return {snapshot: applyHostSnapshot(current.snapshot, snapshots[position]), position, refusal: null};
  } catch {
    return {...current, refusal: "Saved record refused. The previous original evidence remains visible. No audit was started."};
  }
}
