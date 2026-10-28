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
export type RunState = 'running' | 'complete' | 'partial' | 'stopped' | 'interrupted';
export interface Run {
  id: string;
  goal: string;
  url: string;
  mode: 'offline' | 'live';
  state: RunState;
  createdAt: string;
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
  stateStamp: string;
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
  maxUsd: number;
  maxRunUsd: number;
  expiresAt: string;
  approvedAt: string;
}
export const LIMITS = {
  runMicros: 3_000_000,
  routineMicros: 110_000_000,
  totalMicros: 150_000_000,
  actions: 120,
  minutes: 15,
  driver: 20,
  analyst: 8,
  reviewer: 4,
  sam: 16,
  voiceOverCheckpoints: 2,
  voiceOverCommands: 12,
} as const;
export const PHASE = {
  driver: 1_600_000,
  analyst: 650_000,
  reviewer: 650_000,
  sam: 100_000,
} as const;
export const CAPS = {
  driver: { input: 30000, output: 4096, effort: 'low' },
  analyst: { input: 40000, output: 8192, effort: 'low' },
  reviewer: { input: 60000, output: 8192, effort: 'medium' },
} as const;
