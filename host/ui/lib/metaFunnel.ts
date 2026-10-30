import type { AuditSession } from "@/components/audits/AuditReportClient";
import { projectMetaWalk, type HostSnapshot } from "./metaWalkHost";
import {
  readOptionalMetaKeyboardEvidence,
  metaKeyboardMap,
} from "./metaKeyboardEvidence";
import { readOptionalMetaAssessment, metaAssessmentNote } from "./metaAssessment";
import { metaScreenGroups } from "./metaScreenState";
/** The host's session identity stays separate from the engine's original IDs. */
export function metaWalkSession(
  snapshot: HostSnapshot,
  jobId: string,
  keyboardRecords?: unknown,
  keyboardWarning?: string,
  assessmentRecords?: unknown,
  assessmentWarning?: string,
): AuditSession {
  const optional = readOptionalMetaKeyboardEvidence(keyboardRecords, snapshot);
  const warning = keyboardWarning ?? optional.warning;
  const keyboard = warning ? undefined : optional.keyboard;
  const optionalAssessment = readOptionalMetaAssessment(
    assessmentRecords,
    snapshot,
  );
  const assessmentLimit = assessmentWarning ?? optionalAssessment.warning;
  const assessment = assessmentLimit ? undefined : optionalAssessment.assessment;
  const keyPressCount = keyboard?.keyPresses.length ?? 0;
  const recordedKeys = [
    ...new Set(keyboard?.keyPresses.map((event) => event.key) ?? []),
  ].join(", ");
  const keyboardNote = keyboard
    ? `${keyPressCount ? `${keyPressCount} keyboard ${keyPressCount === 1 ? "attempt is" : "attempts are"} linked to original screenshots. Recorded keys: ${recordedKeys}.` : "No keyboard attempts with original screenshot links are available."} Their outcomes are not confirmed. Full Tab order, visible focus and VoiceOver remain unassessed.`
    : null;
  const publicSite = snapshot.run.mode === "live" && new URL(snapshot.run.url).hostname !== "127.0.0.1";
  const view = projectMetaWalk(snapshot, {
    sessionId: jobId,
    evidenceBase: `/api/offline/jobs/${jobId}/assets`,
  });
  const groups = new Map(metaScreenGroups(snapshot.captures).map((group) => [group.primary.id, group]));
  return {
    id: jobId,
    name:
      snapshot.run.mode === "live"
        ? publicSite ? `${new URL(snapshot.run.url).hostname} · Meta website run` : "Controlled shop · Meta live proof"
        : "Controlled shop · offline proof",
    templateKey: null,
    version: snapshot.sequence,
    createdAt: snapshot.run.createdAt,
    updatedAt: snapshot.run.createdAt,
    createdBy: {
      id: "offline-user",
      name: snapshot.run.mode === "live" ? "Local Meta proof" : "Testing Account",
      email: "offline@cavioo.test",
    },
    project: null,
    runs: [
      {
        id: jobId,
        name: publicSite ? "Website keyboard walk" : "Controlled keyboard walk",
        source: "autonomous",
        createdAt: snapshot.run.createdAt,
        keyboardJourneyNote: [
          snapshot.run.state !== "running" && snapshot.run.state !== "complete" && snapshot.run.stopReason
            ? `Run stopped: ${snapshot.run.stopReason}`
            : null,
          warning ?? keyboardNote,
          assessment ? metaAssessmentNote(assessment) : assessmentLimit,
        ].filter(Boolean).join(" "),
      },
    ],
    stages: [],
    steps: view.steps.map((step) => ({
      ...step,
      keyboardMap: metaKeyboardMap(keyboard, groups.get(step.id)!.primary),
      originalKeyboardMaps: Object.fromEntries(groups.get(step.id)!.originals.map((capture) =>
        [capture.id, metaKeyboardMap(keyboard, capture)])),
      notes: [
        step.notes,
        assessment ? groups.get(step.id)!.originals.map((capture) =>
          metaAssessmentNote(assessment, capture.id)).join(" ") : assessmentLimit,
      ].filter(Boolean).join(" "),
    })),
    issues: view.issues,
    strengths: [],
    analysisRuns: [],
    rubricVerdicts: [],
    pageVerdicts: [],
    scope: view.scope,
    synthesis: {
      ...view.synthesis,
      journeyBeats: view.synthesis.journeyBeats.map((beat) => ({
        ...beat,
        line: [
          beat.line,
          assessment ? groups.get(beat.fromStepId)!.originals.map((capture, index, originals) =>
            `${originals.length > 1 ? `Original ${index + 1}: ` : ""}${metaAssessmentNote(assessment, capture.id)}`).join(" ") : null,
        ].filter(Boolean).join(" "),
      })),
      limitations: [
        ...view.synthesis.limitations,
        ...(keyboard?.limits ?? []),
        ...(warning ? [warning] : []),
        ...(assessment?.criteria.limits ?? []),
        ...(assessment?.visualLimits ?? []),
        ...(assessmentLimit ? [assessmentLimit] : []),
      ],
    },
    isOwner: false,
    isLockedByOther: false,
    people: [],
    canDelete: false,
    canTransferOwnership: false,
    canEdit: false,
    canComment: false,
    viewerUserId: "offline-user",
    journeyMap: null,
  };
}
