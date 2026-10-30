import { z } from "zod";
import type { HostSnapshot } from "./metaWalkHost";

export const META_CRITERIA = [
  "C01",
  "C02",
  "C03",
  "C04",
  "C05",
  "C06",
  "C07",
  "C08",
  "C09",
  "C10",
  "C11",
  "C12",
  "C13",
  "C14",
  "C15",
] as const;
const verdicts = [
  "PASS",
  "FAIL",
  "INCONCLUSIVE",
  "NOT_TESTED",
  "NOT_APPLICABLE",
] as const;
const verdict = z.enum(verdicts),
  count = z.number().int().nonnegative();
const id = z.string().min(1).max(250),
  text = z.string().max(3000);
const check = z
  .object({
    scopeId: id,
    checkId: id,
    captureId: id,
    verdict,
    reviewed: z.boolean(),
    complete: z.boolean(),
    reason: text,
    missingEvidence: z.array(text),
    evidence: z.array(id),
    proposalId: id.nullable(),
    reviewId: id.nullable(),
  })
  .strict();
const row = z
  .object({
    id: z.enum(META_CRITERIA),
    question: text,
    verdict,
    reviewed: z.boolean(),
    coverageComplete: z.boolean(),
    requiredChecks: count,
    assessedChecks: count,
    checks: z.array(check).max(300),
    reason: text,
  })
  .strict();
export const metaAssessmentSchema = z
  .object({
    protocol: z.literal("access-walk/assessment-v1"),
    runId: id,
    version: z.literal("access-walk/criteria-v1"),
    sequence: count,
    scope: text,
    criteria: z
      .object({
        version: z.literal("access-walk/criteria-v1"),
        definitionsVersion: z.literal("access-walk/criteria-v1"),
        recordedVersions: z.array(z.literal("access-walk/criteria-v1")),
        results: z.array(row).length(15),
        counts: z
          .object({
            PASS: count,
            FAIL: count,
            INCONCLUSIVE: count,
            NOT_TESTED: count,
            NOT_APPLICABLE: count,
          })
          .strict(),
        score: z.number().min(0).max(100).nullable(),
        coverage: z
          .object({
            complete: z.boolean(),
            requiredChecks: count,
            assessedChecks: count,
            remainingChecks: count,
            applicableCriteria: count,
            assessedCriteria: count,
            unassessedCriteria: count,
          })
          .strict(),
        limits: z.array(text),
      })
      .strict(),
    visualCoverage: z.array(z.unknown()),
    visualLimits: z.array(text),
  })
  .strict();
export type MetaAssessment = z.infer<typeof metaAssessmentSchema>;
export const META_ASSESSMENT_UNAVAILABLE =
  "Limited fifteen-criterion details are unavailable or do not match these original screens. Screens and reviewed findings remain available; no Cavioo score is inferred.";

/** The assessment sequence is an original-record number, not the host revision. */
export function readMetaAssessment(
  value: unknown,
  snapshot: HostSnapshot,
): MetaAssessment {
  const data = metaAssessmentSchema.parse(value),
    report = data.criteria;
  const captures = new Set(snapshot.captures.map((capture) => capture.id));
  if (
    data.runId !== snapshot.run.id ||
    data.sequence <
      Math.max(0, ...snapshot.captures.map((capture) => capture.sequence))
  )
    throw Error(
      "The assessment does not cover this run's retained original screens.",
    );
  if (new Set(report.results.map((result) => result.id)).size !== 15)
    throw Error("Every one of the fifteen criteria must appear exactly once.");
  for (const result of report.results) {
    const settled = result.checks.filter((entry) => entry.complete).length;
    if (
      result.requiredChecks !== result.checks.length ||
      result.checks.length !== captures.size ||
      result.assessedChecks !== settled ||
      result.coverageComplete !==
        (result.checks.length > 0 && settled === result.checks.length) ||
      result.reviewed !==
        (result.checks.length > 0 &&
          result.checks.every((entry) => entry.reviewed)) ||
      new Set(result.checks.map((entry) => entry.captureId)).size !==
        captures.size ||
      result.checks.some(
        (entry) =>
          !captures.has(entry.captureId) ||
          entry.checkId !== `${entry.captureId}:${result.id}` ||
          (entry.complete &&
            (!entry.reviewed ||
              !["PASS", "FAIL", "NOT_APPLICABLE"].includes(entry.verdict) ||
              !entry.proposalId?.trim() ||
              !entry.reviewId?.trim() ||
              entry.evidence.length === 0 ||
              entry.evidence.some((sourceId) => !sourceId.trim()) ||
              entry.missingEvidence.length !== 0)),
      )
    )
      throw Error(
        "Assessment check counts or original-screen identities disagree.",
      );
    const failure = result.checks.some(
      (entry) => entry.reviewed && entry.verdict === "FAIL",
    );
    const expected = failure
      ? "FAIL"
      : result.coverageComplete &&
          result.checks.every((entry) => entry.verdict === "NOT_APPLICABLE")
        ? "NOT_APPLICABLE"
        : result.coverageComplete &&
            result.checks.every((entry) =>
              ["PASS", "NOT_APPLICABLE"].includes(entry.verdict),
            )
          ? "PASS"
          : result.checks.some((entry) => entry.verdict === "INCONCLUSIVE")
            ? "INCONCLUSIVE"
            : "NOT_TESTED";
    if (result.verdict !== expected)
      throw Error("The criterion status does not match its scoped checks.");
  }
  const counts = Object.fromEntries(
    verdicts.map((status) => [
      status,
      report.results.filter((result) => result.verdict === status).length,
    ]),
  ) as MetaAssessment["criteria"]["counts"];
  if (verdicts.some((status) => counts[status] !== report.counts[status]))
    throw Error("Assessment status counts disagree.");
  const required = report.results.reduce(
    (total, result) => total + result.requiredChecks,
    0,
  );
  const assessed = report.results.reduce(
    (total, result) => total + result.assessedChecks,
    0,
  );
  const coverage = report.coverage;
  if (
    coverage.requiredChecks !== required ||
    coverage.assessedChecks !== assessed ||
    coverage.remainingChecks !== required - assessed ||
    coverage.applicableCriteria !== counts.PASS + counts.FAIL ||
    coverage.assessedCriteria !==
      counts.PASS + counts.FAIL + counts.NOT_APPLICABLE ||
    coverage.unassessedCriteria !== counts.INCONCLUSIVE + counts.NOT_TESTED ||
    (coverage.complete &&
      report.results.some(
        (result) =>
          !result.coverageComplete ||
          ["INCONCLUSIVE", "NOT_TESTED"].includes(result.verdict),
      ))
  )
    throw Error("Assessment coverage counts disagree.");
  if (
    report.score !== null &&
    (!coverage.complete || snapshot.run.state !== "complete")
  )
    throw Error("A partial assessment cannot carry a complete score.");
  return data;
}
export function readOptionalMetaAssessment(
  value: unknown,
  snapshot: HostSnapshot,
): { assessment?: MetaAssessment; warning?: string } {
  try {
    return { assessment: readMetaAssessment(value, snapshot) };
  } catch {
    return { warning: META_ASSESSMENT_UNAVAILABLE };
  }
}

/** Same-version assessment changes and rewinds cannot revive old criterion decisions. */
export function acceptMetaAssessment(
  current: {
    assessment?: MetaAssessment;
    assessmentSeen?: { sequence: number; json: string };
    assessmentWarning?: string;
  } | null,
  value: unknown,
  snapshot: HostSnapshot,
  unavailable = false,
) {
  const optional = unavailable
    ? { warning: META_ASSESSMENT_UNAVAILABLE }
    : readOptionalMetaAssessment(value, snapshot);
  const seen = current?.assessmentSeen;
  if (!optional.assessment)
    return {
      assessment: undefined,
      assessmentSeen: seen,
      assessmentWarning: optional.warning,
    };
  const data = optional.assessment,
    json = JSON.stringify(data);
  if (
    seen &&
    (data.sequence < seen.sequence ||
      (data.sequence === seen.sequence && json !== seen.json))
  )
    return {
      assessment: undefined,
      assessmentSeen: seen,
      assessmentWarning: META_ASSESSMENT_UNAVAILABLE,
    };
  return {
    assessment: data,
    assessmentSeen: { sequence: data.sequence, json },
    assessmentWarning: undefined,
  };
}

const labels = {
  PASS: "Pass",
  FAIL: "Fail",
  INCONCLUSIVE: "Inconclusive",
  NOT_TESTED: "Not tested",
  NOT_APPLICABLE: "Not applicable",
};
export function metaAssessmentNote(data: MetaAssessment, captureId?: string) {
  const rows = META_CRITERIA.map((criterionId) => {
    const result = data.criteria.results.find(
      (entry) => entry.id === criterionId,
    )!;
    const status = captureId
      ? result.checks.find((entry) => entry.captureId === captureId)!.verdict
      : result.verdict;
    return `${criterionId}: ${labels[status]}`;
  }).join("; ");
  const coverage = data.criteria.coverage;
  return `Limited fifteen-criterion ${captureId ? "screen" : "journey"} status: ${rows}. ${captureId ? "" : `${coverage.assessedChecks} of ${coverage.requiredChecks} required checks settled; ${coverage.remainingChecks} remain incomplete. `}This is not complete Cavioo coverage or a Cavioo score.`;
}
