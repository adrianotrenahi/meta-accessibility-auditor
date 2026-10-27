import { z } from 'zod';
import { recordIsIntact } from './store.js';
import type { RecordEntry } from './types.js';

export const CRITERIA_VERSION = 'access-walk/criteria-v1' as const;
export const CRITERION_IDS = [
  'C01',
  'C02',
  'C03',
  'C04',
  'C05',
  'C06',
  'C07',
  'C08',
  'C09',
  'C10',
  'C11',
  'C12',
  'C13',
  'C14',
  'C15',
] as const;
export const VERDICTS = ['PASS', 'FAIL', 'INCONCLUSIVE', 'NOT_TESTED', 'NOT_APPLICABLE'] as const;
export const criterionIdSchema = z.enum(CRITERION_IDS);
export const criterionVerdictSchema = z.enum(VERDICTS);
export type CriterionId = z.infer<typeof criterionIdSchema>;
export type CriterionVerdict = z.infer<typeof criterionVerdictSchema>;

/** Fresh public journey checklist. These are not Cavioo's private criterion definitions. */
export const CRITERIA = [
  {
    id: 'C01',
    question: 'Is assessed text readable against its background?',
    evidence:
      'Measured foreground/background colours, text size and weight, contrast ratio and the applicable threshold. Unresolved image text remains uncertain.',
  },
  {
    id: 'C02',
    question: 'Do assessed controls expose meaningful names?',
    evidence:
      'The original rendered control, exposed name, role and surrounding meaning, independently reviewed together.',
  },
  {
    id: 'C03',
    question: 'Do assessed fields have understandable visible and programmatic labels?',
    evidence:
      'Original field, visible label and programmatic label observations, including their meaning in the task.',
  },
  {
    id: 'C04',
    question: 'Do assessed meaningful images have suitable text alternatives?',
    evidence:
      'Original image, exposed alternative, image purpose and surrounding context. Decorative and meaningful images are distinguished through review.',
  },
  {
    id: 'C05',
    question: 'Can the tested journey controls be used with a keyboard?',
    evidence:
      'Actual functional key actions, the original control and captured outcomes. Tab movement alone is not successful activation.',
  },
  {
    id: 'C06',
    question: 'Is focus visible at the tested keyboard stops?',
    evidence:
      'An actual key action, its resulting focused element and the original captured focus state. Styling alone is not a keyboard test.',
  },
  {
    id: 'C07',
    question: 'Do observed errors explain the problem and recovery?',
    evidence:
      'An actual trigger, captured error and field context. Spoken-announcement claims additionally require actual healthy screen-reader speech.',
  },
  {
    id: 'C08',
    question: 'Are assessed targets large enough or covered by an allowed exception?',
    evidence:
      'Actual target shape/size, neighbouring target spacing and applicable exceptions. An undersized box alone cannot establish failure.',
  },
  {
    id: 'C09',
    question: 'Do assessed views have useful titles and headings?',
    evidence:
      'Original page title, heading structure, visible wording and their meaning in the task.',
  },
  {
    id: 'C10',
    question: 'Do assessed instructions convey meaning beyond colour alone?',
    evidence:
      'Original message, colour and another visible or exposed cue, independently reviewed in context.',
  },
  {
    id: 'C11',
    question: 'Are observed price changes explained before commitment?',
    evidence:
      'Comparable original totals, proven same selections and currency, the actual transition and any disclosure before commitment.',
  },
  {
    id: 'C12',
    question: 'Are paid extras and opt-outs understandable and controllable?',
    evidence:
      'Original initial choice state, known price, actual opt-out input and its captured result.',
  },
  {
    id: 'C13',
    question: 'Is the next action understandable in context?',
    evidence:
      'Original action wording, surrounding choices and expected result, independently reviewed from the captured state.',
  },
  {
    id: 'C14',
    question: 'Does a tested action receive understandable feedback?',
    evidence:
      'An actual input, recorded wait and original before/after states. Visual feedback alone is not a screen-reader announcement.',
  },
  {
    id: 'C15',
    question:
      'Can the tested journey be understood and a tested back step preserve relevant entries?',
    evidence:
      'Original progress information plus an actual return action and compared nonsecret entries; no inference from the address alone.',
  },
] as const satisfies readonly { id: CriterionId; question: string; evidence: string }[];

const id = z.string().min(1).max(250);
const reason = z.string().min(3).max(1500);
const sourceIds = z.array(id).min(1).max(40);
export const criterionScopeSchema = z
  .object({
    version: z.literal(CRITERIA_VERSION),
    captureId: id,
    checks: z
      .array(z.object({ checkId: id, criterionId: criterionIdSchema, requirement: reason }))
      .length(15),
  })
  .superRefine((scope, ctx) => {
    const seen = new Set<string>();
    for (const check of scope.checks) {
      if (
        seen.has(check.criterionId) ||
        check.checkId !== `${scope.captureId}:${check.criterionId}`
      )
        ctx.addIssue({
          code: 'custom',
          message: 'Each original screen needs one distinct required check per criterion.',
        });
      seen.add(check.criterionId);
    }
  });
export function makeCriterionScope(captureId: string) {
  return criterionScopeSchema.parse({
    version: CRITERIA_VERSION,
    captureId,
    checks: CRITERIA.map((criterion) => ({
      checkId: `${captureId}:${criterion.id}`,
      criterionId: criterion.id,
      requirement: criterion.evidence,
    })),
  });
}
export const criterionProposalSchema = z.object({
  version: z.literal(CRITERIA_VERSION),
  scopeId: id,
  checkId: id,
  criterionId: criterionIdSchema,
  verdict: criterionVerdictSchema,
  reason,
  sources: sourceIds,
  missingEvidence: z.array(z.string().min(3).max(500)).max(12),
  screenReaderClaimed: z.boolean().default(false),
});
/** The analyst names the original screen; only the engine binds declared scope and check IDs. */
export const criterionAssessmentSchema = criterionProposalSchema
  .omit({ version: true, scopeId: true, checkId: true })
  .extend({ captureId: id })
  .strict();
export const criterionReviewSchema = z.object({
  proposalId: id,
  proposalHash: z.string().regex(/^[a-f0-9]{64}$/),
  verdict: z.enum(['keep', 'rewrite', 'reject', 'unresolved']),
  premise: z.enum(['supported', 'contradicted', 'unverified']),
  reason,
  sources: sourceIds,
  readSnapshotId: id,
});
export type CriterionScope = z.infer<typeof criterionScopeSchema>;
export type CriterionProposal = z.infer<typeof criterionProposalSchema>;
export type CriterionReview = z.infer<typeof criterionReviewSchema>;
export type CriterionCheckResult = {
  scopeId: string;
  checkId: string;
  captureId: string;
  verdict: CriterionVerdict;
  reviewed: boolean;
  complete: boolean;
  reason: string;
  missingEvidence: string[];
  evidence: string[];
  proposalId: string | null;
  reviewId: string | null;
};
export type CriterionResult = {
  id: CriterionId;
  question: string;
  verdict: CriterionVerdict;
  reviewed: boolean;
  coverageComplete: boolean;
  requiredChecks: number;
  assessedChecks: number;
  checks: CriterionCheckResult[];
  reason: string;
};
export type CriteriaReport = {
  version: string;
  definitionsVersion: typeof CRITERIA_VERSION;
  recordedVersions: string[];
  results: CriterionResult[];
  counts: Record<CriterionVerdict, number>;
  score: number | null;
  coverage: {
    complete: boolean;
    requiredChecks: number;
    assessedChecks: number;
    remainingChecks: number;
    applicableCriteria: number;
    assessedCriteria: number;
    unassessedCriteria: number;
  };
  limits: string[];
};
export type CriteriaOptions = { imageAvailable?: (capture: RecordEntry) => boolean };

const kind = (record: RecordEntry, expected: string) => String(record.kind) === expected;
const objectPayload = (value: unknown) =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const sameIds = (a: string[], b: string[]) =>
  a.length === new Set(a).size &&
  new Set(a).size === new Set(b).size &&
  a.every((id) => b.includes(id));

type ReadPin = { id: string; hash: string; sources: string[] };
type EvaluationChecks = {
  intact: (record: RecordEntry) => boolean;
  manifests: WeakMap<RecordEntry, Map<string, ReadPin> | null>;
  reset: () => void;
};

// Records are parsed once for this synchronous report. Reuse hashes only until an external callback.
function evaluationChecks(): EvaluationChecks {
  let integrity = new WeakMap<RecordEntry, boolean>();
  const checks: EvaluationChecks = {
    intact(record) {
      if (!integrity.has(record)) integrity.set(record, recordIsIntact(record));
      return integrity.get(record)!;
    },
    manifests: new WeakMap(),
    reset() {
      integrity = new WeakMap();
      checks.manifests = new WeakMap();
    },
  };
  return checks;
}

/** Original website evidence is distinct from model claims, criterion decisions and coverage. */
function originals(
  records: RecordEntry[],
  runId: string,
  roots: string[],
  checks: EvaluationChecks,
) {
  const selected = new Map<string, RecordEntry>();
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
  const visit = (id: string, beforeSeq = Infinity) => {
    const record = records.find((r) => r.id === id);
    if (
      !record ||
      record.runId !== runId ||
      !checks.intact(record) ||
      record.seq >= beforeSeq ||
      !allowed.has(String(record.kind))
    )
      throw Error('Required original criterion evidence is missing, changed or not original.');
    if (record.payload.stable === false)
      throw Error('Required original criterion evidence was unstable.');
    if (selected.has(id)) return;
    selected.set(id, record);
    for (const sourceId of record.sources) visit(sourceId, record.seq);
  };
  for (const id of roots) visit(id);
  return [...selected.values()];
}

function validRead(
  records: RecordEntry[],
  runId: string,
  id: unknown,
  role: string,
  required: RecordEntry[],
  checks: EvaluationChecks,
) {
  const read = records.find((r) => r.id === id);
  if (
    !read ||
    read.runId !== runId ||
    !kind(read, 'read_snapshot') ||
    read.author !== role ||
    !checks.intact(read) ||
    !Array.isArray(read.payload.records)
  )
    return null;
  if (!checks.manifests.has(read)) {
    const pins = new Map<string, ReadPin>();
    let valid = true;
    for (const pin of read.payload.records) {
      const original = records.find((r) => r.id === pin.id);
      if (
        !original ||
        original.runId !== runId ||
        original.hash !== pin.hash ||
        !checks.intact(original) ||
        !Array.isArray(pin.sources) ||
        JSON.stringify(original.sources) !== JSON.stringify(pin.sources)
      ) {
        valid = false;
        break;
      }
      pins.set(pin.id, pin);
    }
    checks.manifests.set(read, valid ? pins : null);
  }
  const pins = checks.manifests.get(read);
  if (!pins) return null;
  for (const record of required) {
    const pin = pins.get(record.id);
    if (
      !pin ||
      pin.hash !== record.hash ||
      JSON.stringify(pin.sources) !== JSON.stringify(record.sources)
    )
      return null;
  }
  return read;
}

function imageIntact(capture: RecordEntry, options: CriteriaOptions, checks: EvaluationChecks) {
  const p = capture.payload;
  if (
    !kind(capture, 'capture') ||
    p.stable !== true ||
    !/^[a-f0-9]{64}$/.test(p.imageHash ?? '') ||
    !/^[a-zA-Z0-9_-]+\.png$/.test(p.imageFile ?? '')
  )
    return false;
  if (!options.imageAvailable) return false;
  try {
    return options.imageAvailable(capture) === true;
  } catch {
    return false;
  } finally {
    // The callback may change the parsed originals. Never reuse earlier hashes after it returns.
    checks.reset();
  }
}

type Gate = { supported: boolean; complete: boolean; attempted: boolean; missing: string[] };
const familyByCriterion: Partial<Record<CriterionId, string>> = {
  C01: 'contrast',
  C02: 'controls',
  C03: 'fields',
  C04: 'images',
  C08: 'targets',
  C09: 'headings',
  C10: 'colourMessages',
  C13: 'controls',
};
function factsIn(original: RecordEntry[]) {
  return original.flatMap((record) => {
    const facts = record.payload.facts;
    const capture = original.find((r) => kind(r, 'capture') && r.id === facts?.captureId);
    return kind(record, 'observation') &&
      ['browser', 'axe-core'].includes(record.author) &&
      record.payload.stable === true &&
      record.payload.method === 'automatic_accessibility_scan' &&
      facts?.schema === 'access-walk/facts-v1' &&
      capture &&
      record.sources.includes(capture.id) &&
      facts.imageHash === capture.payload.imageHash &&
      facts.url === capture.payload.url &&
      record.payload.sourceCaptureId === capture.id &&
      record.payload.sourceCaptureHash === capture.hash &&
      record.payload.sourceImageHash === capture.payload.imageHash
      ? [{ record, facts, capture }]
      : [];
  });
}
const familyComplete = (facts: any, family: string) =>
  facts?.scope?.[`${family}Incomplete`] === false && facts.scope[`${family}Truncated`] === false;
function afterCapture(original: RecordEntry[], action: RecordEntry, allRecords = original) {
  const nextAction = allRecords
    .filter((r) => r.runId === action.runId && kind(r, 'action') && r.seq > action.seq)
    .sort((a, b) => a.seq - b.seq)[0];
  return original
    .filter(
      (r) => kind(r, 'capture') && r.seq > action.seq && (!nextAction || r.seq < nextAction.seq),
    )
    .sort((a, b) => a.seq - b.seq)[0];
}
function performedActions(original: RecordEntry[]) {
  return original.filter(
    (r) =>
      kind(r, 'action') &&
      r.author === 'browser' &&
      r.payload.method === 'actual_keyboard_or_browser' &&
      r.payload.outcome === 'performed' &&
      r.payload.before !== null &&
      typeof r.payload.before === 'object' &&
      original.some(
        (c) =>
          kind(c, 'capture') &&
          c.id === r.payload.sourceCaptureId &&
          r.sources.includes(c.id) &&
          c.payload.imageHash === r.payload.sourceImageHash,
      ),
  );
}
function trustedComparison(original: RecordEntry[], method: string) {
  return original.find((record) => {
    const p = record.payload;
    const before = original.find((r) => kind(r, 'capture') && r.id === p.beforeCaptureId);
    const after = original.find((r) => kind(r, 'capture') && r.id === p.afterCaptureId);
    const action = performedActions(original).find((r) => r.id === p.actionId);
    return (
      kind(record, 'observation') &&
      record.author === 'browser' &&
      p.version === 'journey-evidence/1' &&
      p.method === method &&
      p.stable === true &&
      before &&
      after &&
      action &&
      before.id !== after.id &&
      before.seq < action.seq &&
      action.seq < after.seq &&
      after.seq < record.seq &&
      record.sources.includes(before.id) &&
      record.sources.includes(after.id) &&
      record.sources.includes(action.id) &&
      action.payload.sourceCaptureId === before.id
    );
  });
}

function nativeEvidence(original: RecordEntry[], captureId: string) {
  const checks = original.filter(
    (record) =>
      kind(record, 'at_check') &&
      record.author === 'voiceover' &&
      record.payload.method === 'real_VoiceOver' &&
      record.sources.includes(captureId),
  );
  return {
    attempted: checks.length > 0,
    supported: checks.some(
      (record) =>
        record.payload.state === 'observed' &&
        record.payload.captureHealthy === true &&
        record.payload.os === 'darwin' &&
        ['webkit', 'chromium'].includes(record.payload.browser) &&
        Array.isArray(record.payload.commands) &&
        record.payload.commands.some(
          (command: any) =>
            command.outcome === 'completed' &&
            command.control === 'VoiceOver AppleScript' &&
            Number.isFinite(Date.parse(command.at)) &&
            Number.isFinite(Date.parse(command.finishedAt)) &&
            Date.parse(command.finishedAt) >= Date.parse(command.at) &&
            Array.isArray(command.spokenPhrases) &&
            command.spokenPhrases.some(
              (phrase: unknown) => typeof phrase === 'string' && phrase.trim(),
            ),
        ),
    ),
  };
}

function evidenceGate(
  criterionId: CriterionId,
  verdict: CriterionVerdict,
  captureId: string,
  original: RecordEntry[],
  allRecords: RecordEntry[],
): Gate {
  const fail = (message: string, attempted = false): Gate => ({
    supported: false,
    complete: false,
    attempted,
    missing: [message],
  });
  const yes = (complete = true): Gate => ({
    supported: true,
    complete,
    attempted: true,
    missing: [],
  });
  const capture = original.find((r) => kind(r, 'capture') && r.id === captureId);
  if (!capture) return fail('The exact original required screen was not cited.');
  const facts = factsIn(original)
    .filter((entry) => entry.capture.id === captureId)
    .at(-1)?.facts;
  const family = familyByCriterion[criterionId];
  const completeFamily = !!family && familyComplete(facts, family);
  const actions = performedActions(original);
  if (verdict === 'NOT_TESTED' || verdict === 'INCONCLUSIVE') return yes(false);
  if (verdict === 'NOT_APPLICABLE') {
    // Applicability is an explicit independently reviewed assertion, never an empty-list default.
    // A known truncated/incomplete relevant family cannot support an absence assertion.
    if (family && !completeFamily)
      return fail(
        'The relevant original observation is incomplete; non-applicability is unverified.',
        true,
      );
    if (capture.payload.limits?.visibleTextTruncated !== false)
      return fail('The captured context is incomplete; non-applicability is unverified.', true);
    const emptyFamily = (name: string) =>
      familyComplete(facts, name) && Array.isArray(facts?.[name]) && facts[name].length === 0;
    if (criterionId === 'C01' && (capture.payload.text?.trim() || !emptyFamily('images')))
      return fail(
        'Observed text or unresolved image content cannot be excluded from contrast by omission.',
        true,
      );
    if (['C02', 'C05', 'C13'].includes(criterionId) && !emptyFamily('controls'))
      return fail(
        'Observed controls cannot become non-applicable merely because they were not tested.',
        true,
      );
    if (criterionId === 'C03' && !emptyFamily('fields'))
      return fail('Observed fields still require a label assessment.', true);
    if (
      criterionId === 'C04' &&
      !emptyFamily('images') &&
      !(facts.images ?? []).every((image: any) => ['presentation', 'none'].includes(image.role))
    )
      return fail(
        'The image purpose has not established that every assessed image is decorative.',
        true,
      );
    if (
      criterionId === 'C06' &&
      actions.some(
        (action) =>
          action.payload.action?.kind === 'press' &&
          afterCapture(original, action, allRecords)?.id === captureId,
      )
    )
      return fail('An actual captured keyboard stop still requires a focus assessment.', true);
    if (
      criterionId === 'C07' &&
      (!familyComplete(facts, 'fields') ||
        !familyComplete(facts, 'colourMessages') ||
        (facts.fields ?? []).some((field: any) => field.invalid) ||
        (facts.colourMessages ?? []).some((message: any) => message.role === 'alert'))
    )
      return fail(
        'The original observations do not establish the absence of a relevant error state.',
        true,
      );
    if (criterionId === 'C08' && !emptyFamily('targets'))
      return fail('Observed pointer targets still require size or exception assessment.', true);
    if (criterionId === 'C09')
      return fail('Observed web views still require useful titles and headings.', true);
    if (criterionId === 'C10' && !emptyFamily('colourMessages'))
      return fail('Observed messages still require a beyond-colour assessment.', true);
    if (
      criterionId === 'C14' &&
      actions.some(
        (action) =>
          ['press', 'type', 'back'].includes(action.payload.action?.kind) &&
          afterCapture(original, action, allRecords)?.id === captureId,
      )
    )
      return fail('An actual captured input aftermath still requires feedback assessment.', true);
    if (criterionId === 'C15' && (!emptyFamily('fields') || !emptyFamily('controls')))
      return fail(
        'An interactive journey cannot exclude the return/entry check merely because it is missing.',
        true,
      );
    if (
      criterionId === 'C11' &&
      original.some(
        (record) =>
          kind(record, 'observation') &&
          record.payload.method === 'journey_context' &&
          record.payload.data?.commerce,
      )
    )
      return fail('Known commerce still needs a comparable price-transition assessment.', true);
    if (
      criterionId === 'C12' &&
      original.some(
        (record) =>
          kind(record, 'observation') &&
          record.payload.method === 'journey_context' &&
          record.payload.data?.choices?.some((choice: any) => choice.extra),
      )
    )
      return fail('Known paid choices still require price and control assessment.', true);
    return yes();
  }
  if (criterionId === 'C01') {
    const rows = Array.isArray(facts?.contrast) ? facts.contrast : [];
    const measured = rows.filter((row: any) => {
      const threshold =
        row.fontSizePx >= 24 || (row.fontSizePx >= (14 * 96) / 72 && row.fontWeight >= 700)
          ? 3
          : 4.5;
      return (
        row.state === 'measured' &&
        row.source === 'axe-core' &&
        /^#[a-f0-9]{6}$/i.test(row.foreground ?? '') &&
        /^#[a-f0-9]{6}$/i.test(row.background ?? '') &&
        Number.isFinite(row.ratio) &&
        row.ratio >= 1 &&
        Number.isFinite(row.fontSizePx) &&
        row.fontSizePx > 0 &&
        Number.isFinite(row.fontWeight) &&
        row.fontWeight >= 1 &&
        row.fontWeight <= 1000 &&
        row.requiredRatio === threshold
      );
    });
    if (!measured.length)
      return fail('Actual measured text colours, ratio and typography are missing.', !!facts);
    const failed = measured.some((row: any) => row.ratio < row.requiredRatio);
    if (verdict === 'FAIL')
      return failed
        ? yes(completeFamily && measured.length === rows.length)
        : fail('No measured contrast failure supports this verdict.', true);
    return completeFamily && measured.length === rows.length && !failed
      ? yes()
      : fail('Not every required text contrast result is measured and passing.', true);
  }
  if (['C02', 'C03', 'C04', 'C09', 'C10', 'C13'].includes(criterionId)) {
    if (!facts || !family) return fail('The original structured browser observations are missing.');
    const rows = criterionId === 'C09' ? facts.headings?.items : facts[family];
    if (
      criterionId === 'C09' &&
      verdict === 'FAIL' &&
      completeFamily &&
      Array.isArray(rows) &&
      rows.length === 0 &&
      typeof facts.headings.title === 'string' &&
      !facts.headings.title.trim()
    )
      return yes();
    if (!Array.isArray(rows) || !rows.length)
      return fail('No relevant original item was assessed.', true);
    if (verdict === 'PASS' && !completeFamily)
      return fail('The original observed scope is incomplete or truncated.', true);
    if (
      criterionId === 'C02' &&
      !rows.every((r: any) => typeof r.name === 'string' && typeof r.role === 'string')
    )
      return fail('Control names and roles are not established.', true);
    if (
      criterionId === 'C02' &&
      verdict === 'PASS' &&
      !rows.every((r: any) => r.name.trim() && r.role.trim())
    )
      return fail(
        'A required control exposes no name or role; semantic review cannot invent one.',
        true,
      );
    if (
      criterionId === 'C03' &&
      !rows.every((r: any) => Array.isArray(r.visibleLabels) && Array.isArray(r.programmaticLabels))
    )
      return fail('Visible and programmatic labels were not both observed.', true);
    if (
      criterionId === 'C03' &&
      verdict === 'PASS' &&
      !rows.every(
        (r: any) =>
          r.visibleLabels.some((s: string) => s.trim()) &&
          r.programmaticLabels.some((s: string) => s.trim()),
      )
    )
      return fail('A required visible or programmatic field label is missing.', true);
    if (
      criterionId === 'C04' &&
      !rows.every(
        (r: any) =>
          (r.alt === null || typeof r.alt === 'string') && typeof r.contextText === 'string',
      )
    )
      return fail(
        'Image alternatives and surrounding purpose context were not both observed.',
        true,
      );
    if (
      criterionId === 'C04' &&
      verdict === 'PASS' &&
      !rows.every(
        (image: any) =>
          ['presentation', 'none'].includes(image.role) ||
          (typeof image.alt === 'string' && image.alt.trim()) ||
          (Array.isArray(image.programmaticLabels) &&
            image.programmaticLabels.some((label: string) => label.trim())),
      )
    )
      return fail('A required image has no established text alternative or decorative role.', true);
    if (criterionId === 'C09' && typeof facts.headings.title !== 'string')
      return fail('The original page title was not observed.', true);
    if (
      criterionId === 'C09' &&
      verdict === 'PASS' &&
      (!facts.headings.title.trim() ||
        !rows.every(
          (r: any) =>
            typeof r.text === 'string' &&
            r.text.trim() &&
            Number.isInteger(r.level) &&
            r.level >= 1 &&
            r.level <= 6,
        ))
    )
      return fail('A required page title or heading is empty or unverified.', true);
    return yes(completeFamily);
  }
  if (criterionId === 'C05') {
    const functional = actions.filter(
      (r) =>
        r.payload.action?.kind === 'press' &&
        ['Enter', 'Space', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(
          r.payload.action.key,
        ) &&
        !['body', 'html', 'iframe'].includes(r.payload.before?.tag ?? 'body'),
    );
    if (!functional.length)
      return fail('A functional keyboard action was not tested; Tab focus alone is insufficient.');
    const paired = functional.some((r) => {
      const after = afterCapture(original, r, allRecords);
      return after && (r.payload.sourceCaptureId === captureId || after.id === captureId);
    });
    return paired
      ? yes()
      : fail('The original functional key action lacks its captured aftermath.', true);
  }
  if (criterionId === 'C06') {
    const paired = actions.some(
      (r) =>
        r.payload.action?.kind === 'press' &&
        afterCapture(original, r, allRecords)?.id === captureId,
    );
    return paired && capture.payload.focus && typeof capture.payload.focus.tag === 'string'
      ? yes()
      : fail(
          'Actual keyboard-stop focus and its original captured state are missing.',
          actions.some((r) => r.payload.action?.kind === 'press'),
        );
  }
  if (criterionId === 'C07') {
    const trigger = actions.some(
      (r) =>
        (r.payload.action?.kind === 'type' ||
          (r.payload.action?.kind === 'press' &&
            ['Enter', 'Space'].includes(r.payload.action.key))) &&
        afterCapture(original, r, allRecords)?.id === captureId,
    );
    if (!trigger) return fail('An actual error-triggering interaction was not recorded.');
    const context =
      facts &&
      ((facts.fields ?? []).some((f: any) => f.invalid && (f.describedBy ?? []).length) ||
        (facts.colourMessages ?? []).some((m: any) => m.role === 'alert' && m.text));
    return context
      ? yes(familyComplete(facts, 'fields') && familyComplete(facts, 'colourMessages'))
      : fail(
          'The triggered error and surrounding field/message context are not established.',
          true,
        );
  }
  if (criterionId === 'C08') {
    const targets = Array.isArray(facts?.targets) ? facts.targets : [];
    if (!targets.length)
      return fail('Actual target shape/size and spacing observations are missing.', !!facts);
    if (verdict === 'FAIL')
      return fail(
        'Undersized targets alone do not rule out every applicable target-size exception.',
        true,
      );
    return completeFamily &&
      targets.every((t: any) => t.sizeMet === true || t.spacingException === true)
      ? yes()
      : fail('Target size, spacing or remaining exceptions are unresolved.', true);
  }
  if (criterionId === 'C11') {
    const comparison = trustedComparison(original, 'comparable_totals')?.payload;
    if (!comparison)
      return fail('Comparable original totals, selections and the transition are not recorded.');
    const comparable =
      comparison.comparable === true &&
      comparison.selectionSame === true &&
      typeof comparison.currency === 'string' &&
      /^[A-Z]{3}$/.test(comparison.currency) &&
      [comparison.beforeTotal, comparison.afterTotal].every((n) => Number.isFinite(n) && n >= 0);
    if (!comparable)
      return fail(
        'Original price selections, currency or totals cannot be compared reliably.',
        true,
      );
    const changed = comparison.beforeTotal !== comparison.afterTotal;
    if (verdict === 'FAIL' && !changed)
      return fail('No comparable price change supports a failure under this criterion.', true);
    if (
      verdict === 'PASS' &&
      changed &&
      !(typeof comparison.disclosure === 'string' && comparison.disclosure.trim())
    )
      return fail('The comparable price changed without an observed explanation.', true);
    return yes();
  }
  if (criterionId === 'C12') {
    const comparison = trustedComparison(original, 'optout_context')?.payload;
    const measured =
      comparison?.initialChoiceKnown === true &&
      comparison.priceKnown === true &&
      comparison.optOutTested === true &&
      typeof comparison.choiceChanged === 'boolean';
    if (!measured)
      return fail(
        'The initial paid choice, price and actual opt-out result are not all established.',
        !!comparison,
      );
    if (verdict === 'PASS' && comparison.choiceChanged !== true)
      return fail('The attempted opt-out did not establish a changed choice state.', true);
    const contexts = original.filter(
      (record) =>
        kind(record, 'observation') &&
        record.payload.method === 'journey_context' &&
        record.payload.version === 'journey-evidence/1' &&
        record.payload.sourceCaptureId === comparison.beforeCaptureId,
    );
    const data = contexts.at(-1)?.payload.data;
    const extras = Array.isArray(data?.choices)
      ? data.choices.filter((choice: any) => choice.extra)
      : [];
    const allChoicesChecked =
      data?.choicesComplete === true && extras.length === 1 && extras[0].id === comparison.fieldId;
    return verdict === 'PASS' && !allChoicesChecked
      ? fail('One observed opt-out does not establish all paid-choice coverage.', true)
      : yes(allChoicesChecked);
  }
  if (criterionId === 'C14') {
    const paired = actions.some(
      (r) =>
        ['press', 'type', 'back'].includes(r.payload.action?.kind) &&
        r.payload.waitAfterMs > 0 &&
        afterCapture(original, r, allRecords)?.id === captureId,
    );
    return paired
      ? yes()
      : fail(
          'An actual input, recorded wait and captured aftermath are not all established.',
          actions.length > 0,
        );
  }
  const returned = trustedComparison(original, 'return_preservation');
  const returnAction = returned && actions.find((r) => r.id === returned.payload.actionId);
  const measuredReturn =
    returned?.payload.returned === true &&
    returned.payload.entriesCompared === true &&
    typeof returned.payload.preserved === 'boolean' &&
    typeof returned.payload.fieldId === 'string' &&
    returned.payload.fieldId.trim().length > 0 &&
    returnAction?.payload.action?.kind === 'back';
  if (!measuredReturn)
    return fail('A tested return and compared original entries are missing.', !!returned);
  return verdict === 'PASS' && returned.payload.preserved !== true
    ? fail('The return test did not establish that the compared entry was preserved.', true)
    : yes();
}

function checkedResult(
  records: RecordEntry[],
  runId: string,
  scope: RecordEntry,
  check: CriterionScope['checks'][number],
  options: CriteriaOptions,
  unreadableDecision: boolean,
  checks: EvaluationChecks,
): CriterionCheckResult {
  const base: CriterionCheckResult = {
    scopeId: scope.id,
    checkId: check.checkId,
    captureId: scope.payload.captureId,
    verdict: 'NOT_TESTED',
    reviewed: false,
    complete: false,
    reason: 'The required criterion check has no reviewed result.',
    missingEvidence: ['No reviewed result was recorded.'],
    evidence: [],
    proposalId: null,
    reviewId: null,
  };
  const proposals = records
    .filter(
      (r) =>
        r.runId === runId &&
        kind(r, 'criterion_proposal') &&
        r.payload?.scopeId === scope.id &&
        r.payload?.checkId === check.checkId,
    )
    .sort((a, b) => a.seq - b.seq);
  const proposal = proposals.at(-1);
  if (!proposal) return base;
  base.proposalId = proposal.id;
  const uncertain = (message: string, verdict: CriterionVerdict = 'INCONCLUSIVE') => ({
    ...base,
    verdict,
    reason: message,
    missingEvidence: [message],
  });
  if (unreadableDecision)
    return uncertain(
      'A criterion proposal or review has an unreadable payload; its exact check cannot be verified.',
    );
  if (
    proposals.some(
      (r) => r.id !== proposal.id && r.payload.readSnapshotId === proposal.payload.readSnapshotId,
    )
  )
    return uncertain(
      'Conflicting proposals were returned for the same required check and analysis read.',
    );
  const parsed = criterionProposalSchema.safeParse(proposal.payload);
  if (
    !parsed.success ||
    !checks.intact(proposal) ||
    !['analyst', 'saved-example'].includes(proposal.author) ||
    parsed.data.criterionId !== check.criterionId ||
    proposal.seq <= scope.seq
  )
    return uncertain(
      'The latest criterion proposal is invalid, changed or uses an incompatible version.',
    );
  const p = parsed.data;
  if (!sameIds(proposal.sources, [scope.id, ...new Set(p.sources)]))
    return uncertain('The criterion proposal source links do not match its declared originals.');
  let original: RecordEntry[];
  try {
    original = originals(records, runId, p.sources, checks);
  } catch (error) {
    return uncertain((error as Error).message);
  }
  const capture = original.find((r) => r.id === scope.payload?.captureId && kind(r, 'capture'));
  if (
    !capture ||
    original.filter((r) => kind(r, 'capture')).some((r) => !imageIntact(r, options, checks))
  )
    return uncertain('A required original criterion image is missing, unstable or unavailable.');
  const analystRead = validRead(
    records,
    runId,
    proposal.payload.readSnapshotId,
    'analyst',
    [scope, ...original],
    checks,
  );
  if (!analystRead || !(scope.seq < analystRead.seq && analystRead.seq < proposal.seq))
    return uncertain(
      'Required scope and originals were not verified in the analyst read before this proposal.',
    );
  const review = records
    .filter(
      (r) =>
        r.runId === runId && kind(r, 'criterion_review') && r.payload?.proposalId === proposal.id,
    )
    .sort((a, b) => a.seq - b.seq)
    .at(-1);
  if (!review) return uncertain('The latest exact criterion proposal has not been reviewed.');
  base.reviewId = review.id;
  const decision = criterionReviewSchema.safeParse(review.payload);
  if (
    !decision.success ||
    !checks.intact(review) ||
    !['reviewer', 'saved-example'].includes(review.author) ||
    decision.data.proposalHash !== proposal.hash ||
    review.seq <= proposal.seq
  )
    return uncertain('The latest criterion review does not verify this exact original proposal.');
  const d = decision.data;
  if (d.verdict !== 'keep' || d.premise !== 'supported')
    return uncertain(
      'The latest criterion proposal was rejected, left unresolved or needs a new reviewed version.',
    );
  let reviewOriginals: RecordEntry[];
  try {
    reviewOriginals = originals(records, runId, d.sources, checks);
  } catch (error) {
    return uncertain((error as Error).message);
  }
  if (!sameIds(review.sources, [proposal.id, d.readSnapshotId, ...new Set(d.sources)]))
    return uncertain(
      'Criterion review source links do not match the exact proposal and original read.',
    );
  const read = validRead(
    records,
    runId,
    d.readSnapshotId,
    'reviewer',
    [scope, proposal, ...original, ...reviewOriginals],
    checks,
  );
  if (!read || !(proposal.seq < read.seq && read.seq < review.seq))
    return uncertain(
      'The reviewer did not read the exact criterion proposal and all required originals.',
    );
  if (p.screenReaderClaimed && ['PASS', 'FAIL', 'NOT_APPLICABLE'].includes(p.verdict)) {
    const reader = nativeEvidence(original, scope.payload.captureId);
    if (!reader.supported)
      return {
        ...uncertain(
          'The claimed screen-reader result lacks healthy original commands and captured speech for this screen.',
          reader.attempted ? 'INCONCLUSIVE' : 'NOT_TESTED',
        ),
        reviewed: true,
        evidence: p.sources,
      };
  }
  const gate = evidenceGate(
    check.criterionId,
    p.verdict,
    scope.payload.captureId,
    original,
    records,
  );
  if (!gate.supported)
    return {
      ...uncertain(gate.missing.join(' '), gate.attempted ? 'INCONCLUSIVE' : 'NOT_TESTED'),
      reviewed: true,
      evidence: p.sources,
    };
  const missingEvidence = [...new Set([...p.missingEvidence, ...gate.missing])];
  const complete =
    gate.complete &&
    missingEvidence.length === 0 &&
    ['PASS', 'FAIL', 'NOT_APPLICABLE'].includes(p.verdict);
  if (!complete && ['PASS', 'NOT_APPLICABLE'].includes(p.verdict))
    return {
      ...uncertain('The positive or non-applicable result still has missing required evidence.'),
      reviewed: true,
      evidence: p.sources,
      missingEvidence,
    };
  return {
    ...base,
    verdict: p.verdict,
    reviewed: true,
    complete,
    reason: p.reason,
    missingEvidence,
    evidence: p.sources,
  };
}

// A whole-run percentage is deliberately withheld until every applicable required check settles.
export function evaluateCriteria(
  records: RecordEntry[],
  runId: string,
  options: CriteriaOptions = {},
): CriteriaReport {
  return buildReport(records, runId, options, evaluationChecks());
}

function buildReport(
  records: RecordEntry[],
  runId: string,
  options: CriteriaOptions,
  integrityChecks: EvaluationChecks,
): CriteriaReport {
  const scopes = records
    .filter((r) => r.runId === runId && kind(r, 'criterion_scope'))
    .sort((a, b) => a.seq - b.seq);
  const versions = [...new Set(scopes.map((r) => String(r.payload?.version ?? 'unknown')))];
  const limits: string[] = [];
  const validScopes: RecordEntry[] = [];
  const seenCaptures = new Set<string>();
  for (const scope of scopes) {
    const parsed = criterionScopeSchema.safeParse(scope.payload);
    const capture = records.find(
      (r) => r.runId === runId && r.id === scope.payload?.captureId && kind(r, 'capture'),
    );
    if (
      !parsed.success ||
      !integrityChecks.intact(scope) ||
      !capture ||
      !integrityChecks.intact(capture) ||
      !sameIds(scope.sources, [capture.id]) ||
      scope.seq <= capture.seq ||
      seenCaptures.has(capture.id)
    ) {
      limits.push(
        'A required criterion scope is missing, changed, duplicated or uses an unsupported version.',
      );
      continue;
    }
    seenCaptures.add(capture.id);
    validScopes.push(scope);
  }
  if (!scopes.length) limits.push('Required criterion scope was not recorded before analysis.');
  const unscopedCaptures = records.filter(
    (r) => r.runId === runId && kind(r, 'capture') && !seenCaptures.has(r.id),
  );
  if (unscopedCaptures.length)
    limits.push('Some original captured states have no verified required criterion scope.');
  if (versions.length > 1) limits.push('Criterion versions cannot be mixed into one score.');
  if (
    records.some(
      (r) =>
        r.runId === runId &&
        (kind(r, 'criterion_proposal') || kind(r, 'criterion_review')) &&
        !integrityChecks.intact(r),
    )
  )
    limits.push('A criterion proposal or review changed; a complete score cannot be verified.');
  const unreadableDecision = records.some(
    (record) =>
      record.runId === runId &&
      (kind(record, 'criterion_proposal') || kind(record, 'criterion_review')) &&
      !objectPayload(record.payload),
  );
  const results: CriterionResult[] = CRITERIA.map((criterion) => {
    const checks: CriterionCheckResult[] = validScopes.map((scope) =>
      checkedResult(
        records,
        runId,
        scope,
        scope.payload.checks.find(
          (c: CriterionScope['checks'][number]) => c.criterionId === criterion.id,
        ),
        options,
        unreadableDecision,
        integrityChecks,
      ),
    );
    // Omitted states remain explicit missing obligations, rather than disappearing from coverage.
    checks.push(
      ...unscopedCaptures.map((capture): CriterionCheckResult => ({
        scopeId: `unverified-scope:${capture.id}`,
        checkId: `${capture.id}:${criterion.id}`,
        captureId: capture.id,
        verdict: 'NOT_TESTED',
        reviewed: false,
        complete: false,
        reason: 'Required scope for this original captured state was not verified before analysis.',
        missingEvidence: ['The original state has no verified required criterion scope.'],
        evidence: [capture.id],
        proposalId: null,
        reviewId: null,
      })),
    );
    const complete = checks.length > 0 && checks.every((c) => c.complete);
    const fail = checks.some((c) => c.reviewed && c.verdict === 'FAIL');
    const verdict: CriterionVerdict = fail
      ? 'FAIL'
      : complete && checks.every((c) => c.verdict === 'NOT_APPLICABLE')
        ? 'NOT_APPLICABLE'
        : complete && checks.every((c) => ['PASS', 'NOT_APPLICABLE'].includes(c.verdict))
          ? 'PASS'
          : checks.some((c) => c.verdict === 'INCONCLUSIVE')
            ? 'INCONCLUSIVE'
            : 'NOT_TESTED';
    return {
      id: criterion.id,
      question: criterion.question,
      verdict,
      reviewed: checks.length > 0 && checks.every((c) => c.reviewed),
      coverageComplete: complete,
      requiredChecks: checks.length,
      assessedChecks: checks.filter((c) => c.complete).length,
      checks,
      reason: fail
        ? 'A reviewed failure is demonstrated; incomplete required coverage remains explicit.'
        : complete
          ? 'Every declared required check has a supported reviewed result.'
          : 'Required checks are missing, unreviewed or inconclusive; no pass is inferred.',
    };
  });
  const counts = Object.fromEntries(
    VERDICTS.map((v) => [v, results.filter((r) => r.verdict === v).length]),
  ) as Record<CriterionVerdict, number>;
  const complete =
    !limits.length &&
    results.every(
      (r) => r.coverageComplete && ['PASS', 'FAIL', 'NOT_APPLICABLE'].includes(r.verdict),
    );
  const applicableCriteria = results.filter(
    (r) => r.verdict === 'PASS' || r.verdict === 'FAIL',
  ).length;
  const requiredChecks = results.reduce((n, r) => n + r.requiredChecks, 0),
    assessedChecks = results.reduce((n, r) => n + r.assessedChecks, 0);
  return {
    version: versions.length === 1 ? versions[0] : CRITERIA_VERSION,
    definitionsVersion: CRITERIA_VERSION,
    recordedVersions: versions,
    results,
    counts,
    score: complete && applicableCriteria > 0 ? (counts.PASS / applicableCriteria) * 100 : null,
    coverage: {
      complete,
      requiredChecks,
      assessedChecks,
      remainingChecks: requiredChecks - assessedChecks,
      applicableCriteria,
      assessedCriteria: counts.PASS + counts.FAIL + counts.NOT_APPLICABLE,
      unassessedCriteria: counts.INCONCLUSIVE + counts.NOT_TESTED,
    },
    limits: [...new Set(limits)],
  };
}
