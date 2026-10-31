export type Role = 'driver' | 'analyst' | 'reviewer' | 'sam';
export type RecordKind =
  | 'plan'
  | 'action'
  | 'capture'
  | 'observation'
  | 'navigator_note'
  | 'at_check'
  | 'candidate'
  | 'review'
  | 'sam_mapping'
  | 'read_snapshot'
  | 'coverage'
  | 'criterion_scope'
  | 'criterion_proposal'
  | 'criterion_review'
  | 'visual_coverage'
  | 'visual_observation'
  | 'focused_check'
  | 'limit'
  | 'model_response';
export type RunState =
  'planning' | 'prepared' | 'running' | 'complete' | 'partial' | 'stopped' | 'interrupted';
export interface Run {
  id: string;
  goal: string;
  url: string;
  mode: 'offline' | 'live';
  state: RunState;
  createdAt: string;
  startedAt?: string;
  stopReason?: string;
}
export interface RecordEntry {
  id: string;
  runId: string;
  seq: number;
  kind: RecordKind;
  author: string;
  payload: any;
  sources: string[];
  hash: string;
  createdAt: string;
}
export interface ElementInfo {
  id: string;
  selector?: string;
  contextFingerprint?: string;
  controlInstance?: string;
  controlFingerprint?: string;
  tag: string;
  role: string;
  name: string;
  text: string;
  type: string;
  disabled: boolean;
  box: { x: number; y: number; width: number; height: number };
}
export interface Capture {
  screenState?: import('./screen-state-contract.js').ScreenState;
  stateStamp: string;
  /** The same page apart from keyboard focus; absent on records saved before page-state/1. */
  pageStamp?: string;
  dialogs?: { role: string; name: string }[];
  /** Accessibility-snapshot lines that changed while this original was captured. */
  contentDrift?: { changedLines: number; settled?: boolean };
  /** Identifies this original's page-side list of exact controls (page-state/1). */
  stampToken?: string;
  stable: boolean;
  url: string;
  title: string;
  imageFile: string;
  imageHash: string;
  width: number;
  height: number;
  elements: ElementInfo[];
  text: string;
  aria: string;
  focus: { tag: string; text: string; name: string };
  limits: {
    controlIdentityChanged?: boolean;
    totalControls: number;
    maximumListedControls: number;
    visibleTextTruncated: boolean;
    imageScope: 'viewport';
  };
  imageProvenance?: {
    source: string;
    engineAddedAnnotations: boolean;
    focusOutline: string;
    animations: string;
  };
}
export interface Candidate {
  issueKey: string;
  scope: 'element' | 'view';
  visiblePremise: string;
  title: string;
  detail: string;
  criterion: string | null;
  basis: 'measured' | 'expert_visual' | 'mixed';
  severity: 'blocker' | 'serious' | 'minor';
  sources: string[];
  targetCaptureId: string | null;
  targetId: string | null;
  recommendation: string;
  visualTopic?: string | null;
  visualObservationId?: string | null;
}
export interface Decision {
  candidateId: string;
  candidateHash: string;
  verdict: 'keep' | 'rewrite' | 'reject' | 'unresolved';
  premise: 'supported' | 'contradicted' | 'unverified';
  title: string;
  reason: string;
  sources: string[];
}
export interface Approval {
  approvedBy: 'Adriano';
  /** Optional project total; without it only the per-audit limit applies (owner, 31 Oct). */
  maxUsd?: number;
  maxRunUsd: number;
  expiresAt: string;
  approvedAt: string;
}
export const LIMITS = {
  // Owner, 31 Oct: at most $10 per audit and no project total.
  runMicros: 10_000_000,
  // Owner, 31 Oct: the navigator's allowance is per journey step (below), so the whole-audit
  // time and key limits must leave room for several steps.
  // One key-press decision can send up to 24 keys, so a 32-decision form step can need 768.
  actions: 1200,
  minutes: 45,
  // Only a backstop: the real navigator limit is per step (DECISIONS_PER_STEP below). At most
  // 12 approved steps of 32 decisions, plus the one planning request.
  driver: 12 * 32 + 1,
  analyst: 8,
  reviewer: 4,
  sam: 16,
  voiceOverCheckpoints: 2,
  voiceOverCommands: 12,
} as const;
/** Navigator decisions per journey step (owner, 31 Oct: "PER STEP, not for the entire audit"),
 * and per step whose page shows a form, where typing and choosing take more decisions. */
export const DECISIONS_PER_STEP = 24;
export const DECISIONS_PER_FORM_STEP = 32;
/** Each role's share of one audit's limit, so the split holds at any approved amount. At
 * $3 it matches the original $1.60 / $0.65 / $0.65 / $0.10 split within a cent. */
export const PHASE_SHARE = { driver: 0.53, analyst: 0.22, reviewer: 0.22, sam: 0.03 } as const;
export const phaseLimits = (runLimitMicros: number) =>
  Object.fromEntries(
    Object.entries(PHASE_SHARE).map(([role, share]) => [role, Math.floor(share * runLimitMicros)]),
  ) as Record<keyof typeof PHASE_SHARE, number>;
/** The role limits of a $3 audit, the amount the controlled tests approve. */
export const PHASE = phaseLimits(3_000_000);
// Configured capacity shared by every Muse Spark 1.3 model ID, verified 28 October 2026.
// https://dev.meta.ai/docs/models — input and reserved output share this window.
// This is documented configuration, not automatic provider-capability discovery.
export const MODEL_CONTEXT_TOKENS = 1_048_576;
// Preserve the legacy final-review money reserve independently of model capacity.
// It does not guarantee that a full-context final review fits the remaining budget.
export const FINAL_REVIEW_RESERVE_MICROS = 109_816;
// Pay-as-you-go prices in billionths of a dollar per token, verified 31 October 2026 at
// https://dev.meta.ai/docs/pricing-rate-limits. Contributor mode is the same model at a
// lower price, in exchange for Meta being allowed to train on what is sent and returned.
export const MODEL_PRICES = {
  'muse-spark-1.3': { input: 1250, output: 4250 },
  'muse-spark-1.3-contributor': { input: 100, output: 200 },
} as const;
export type ReasoningModel = keyof typeof MODEL_PRICES;
/** Integer millionths of a dollar, rounded up, for one request's tokens. */
export const tokenCostMicros = (model: ReasoningModel, input: number, output: number) =>
  Math.ceil((input * MODEL_PRICES[model].input + output * MODEL_PRICES[model].output) / 1000);
// Each role names its own model (owner, 31 Oct: Contributor mode for all three).
// Journey planning is a navigator request and uses the navigator's model.
export const CAPS = {
  driver: {
    model: 'muse-spark-1.3-contributor',
    input: MODEL_CONTEXT_TOKENS - 4096,
    output: 4096,
    effort: 'low',
  },
  analyst: {
    model: 'muse-spark-1.3-contributor',
    input: MODEL_CONTEXT_TOKENS - 8192,
    output: 8192,
    effort: 'low',
  },
  reviewer: {
    model: 'muse-spark-1.3-contributor',
    input: MODEL_CONTEXT_TOKENS - 8192,
    output: 8192,
    effort: 'medium',
  },
} as const satisfies Record<
  Exclude<Role, 'sam'>,
  { model: ReasoningModel; input: number; output: number; effort: string }
>;
