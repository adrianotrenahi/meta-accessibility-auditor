import { RoleAllowanceLimit } from './role-allowance.js';
import { walkToKeyboardTarget } from './keyboard-target.js';
import { disposeKeyboardCycles } from './keyboard-cycle-memory.js';
import { publicEntryLimit, PUBLIC_TRAFFIC_CHALLENGE } from './public-target.js';
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import {
  ARRIVAL_QUIET_MS,
  RELOAD_QUIET_MS,
  BrowserWalk,
  MeasurementStateChanged,
  ActionLimitReached,
  ActionStateChanged,
} from './browser.js';
import { documentWasReplaced } from './page-observation.js';
/** Attempts across page reloads before a scan stays unknown (owner, 30 Oct). */
const MEASUREMENT_ATTEMPTS = 3;
/** Attempts across page reloads before banner clearing gives up. */
const BLOCKER_ATTEMPTS = 3;
/** Navigator answers in a row that break the decision rules before navigation stops. */
export const MAX_REFUSED_ANSWERS = 3;
import { VoiceOverProbe } from './voiceover.js';
import { Store, digest, recordIsIntact } from './store.js';
import {
  earlierCheck,
  earlierPageScan,
  earlierScan,
  walkEvidenceSince,
} from './repeat-checkpoint.js';
import { AnalysisTrack } from './analysis-track.js';
import {
  MetaModels,
  IncompleteModelResult,
  InvalidModelAnswer,
  navigationActionSchema,
  analysisSchema,
  reviewSchema,
  type Action,
} from './models.js';
import {
  CAPS,
  DECISIONS_PER_FORM_STEP,
  DECISIONS_PER_STEP,
  LIMITS,
  type Approval,
  type RecordEntry,
  type Run,
} from './types.js';
import {
  ORDERED_JOURNEY_VERSION,
  approvedJourneyPlanSchema,
  journeyPlanSchema,
  readOrderedJourney,
  currentJourneyInstruction,
  completeJourneyInstruction,
} from './journey-steps.js';
import { approval, safeError } from './config.js';
import { mapElement } from './segmentation.js';
import { EvidenceRequestLimit, requestEvidence } from './request-evidence.js';
import {
  AnalysisNetworkUnavailable,
  analysisNetworkDeferred,
  optionalAnalysisRequest,
} from './analysis-network.js';
import { imageRecordsForRead } from './image-receipt.js';
import { candidateTarget } from './candidate-target.js';
import { CRITERIA_VERSION } from './criteria.js';
import {
  declareCriterionScopes,
  recordAnalysisDetails,
  visualCandidateSources,
} from './assessment.js';
import { FocusedCheckBudget, type MissingEvidenceRequest } from './evidence-checks.js';
import { performFocusedCheck } from './focused-checks.js';
import { clearPageBlockers } from './page-blockers.js';
import {
  readJourneyContext,
  compareJourneyTotals,
  journeyDataChanged,
  journeyDataNow,
  recordOptOutContext,
  ReturnEvidence,
} from './journey-evidence.js';
/** Real websites default to the visitor's Chrome (owner, 31 Oct), so a caller that names no
 * engine cannot quietly bring back the automation signal; the controlled shop keeps WebKit. */
export const defaultEngine = (publicWebsite: boolean) =>
  publicWebsite ? ('chromium' as const) : ('webkit' as const);
/** The navigator sees one screenshot per decision, the current one, so a "step finished"
 * answer that names no screenshot can only mean that one (owner, 31 Oct: such an answer
 * ended a Booking.com audit). The engine fills it in; the usual freshness check still runs
 * before any step is recorded as finished. A control named both by its number and by its
 * role and name is kept by number when both describe the same listed control on this screen;
 * if they disagree, the answer is still refused and the navigator is asked again. */
export const completionOnScreen = (
  currentCaptureId: string,
  elements: readonly { id?: unknown; role?: unknown; name?: unknown }[] = [],
) =>
  z.preprocess((value) => {
    if (!value || typeof value !== 'object') return value;
    const answer = value as Record<string, unknown>;
    if (answer.kind === 'step_done' && answer.captureId == null)
      return { ...answer, captureId: currentCaptureId };
    if (
      answer.kind === 'focus_target' &&
      answer.targetId &&
      (answer.targetRole || answer.targetName)
    ) {
      const listed = elements.find((element) => element.id === answer.targetId);
      if (listed && listed.role === answer.targetRole && listed.name === answer.targetName) {
        const { targetRole: _role, targetName: _name, ...byNumber } = answer;
        return byNumber;
      }
    }
    return value;
  }, navigationActionSchema);
/** Whether a screenshot shows a form: somewhere to type, pick a date or choose an option. */
export const showsForm = (capture: RecordEntry) =>
  Array.isArray(capture.payload.elements) &&
  capture.payload.elements.some(
    (element: { role?: unknown; tag?: unknown }) =>
      ['textbox', 'searchbox', 'combobox', 'spinbutton', 'listbox', 'radio', 'checkbox'].includes(
        String(element.role),
      ) || ['input', 'select', 'textarea'].includes(String(element.tag)),
  );
export class Runner {
  private readonly targetJourneyContexts = new WeakMap<BrowserWalk, Map<string, RecordEntry>>();
  active?: { run: Run; walk: BrowserWalk; probe: VoiceOverProbe; controller: AbortController };
  completion?: Promise<void>;
  private waiting?: { runId: string; release: () => void };
  private discarding = new Map<string, Promise<void>>();
  private focusedBudgets = new Map<string, FocusedCheckBudget>();
  private focusedBudget(runId: string, reserveVoiceOver = false) {
    if (!this.focusedBudgets.has(runId))
      this.focusedBudgets.set(
        runId,
        new FocusedCheckBudget({ reserveVoiceOver: reserveVoiceOver ? 2 : 0 }),
      );
    return this.focusedBudgets.get(runId)!;
  }
  isWaiting(id: string) {
    return this.waiting?.runId === id;
  }
  advance(id: string) {
    if (this.waiting?.runId !== id) throw Error('The next controlled checkpoint is not ready.');
    const wait = this.waiting;
    this.waiting = undefined;
    wait.release();
  }
  private checkpoint(runId: string, signal: AbortSignal) {
    if (signal.aborted) return Promise.reject(Error('The run has stopped.'));
    return new Promise<void>((resolve) => {
      const release = () => {
        signal.removeEventListener('abort', release);
        if (this.waiting?.release === release) this.waiting = undefined;
        resolve();
      };
      this.waiting = { runId, release };
      signal.addEventListener('abort', release, { once: true });
    });
  }
  async discard(id: string) {
    const prior = this.discarding.get(id);
    if (prior) return prior;
    const work = (async () => {
      if (this.active?.run.id === id) await this.stop(id);
      this.store.discard(id);
    })();
    this.discarding.set(id, work);
    try {
      await work;
    } finally {
      this.discarding.delete(id);
    }
  }
  constructor(
    public store: Store,
    public origin: string,
    private getApproval: () => Approval = approval,
  ) {}
  async start(options: {
    mode: 'offline' | 'live';
    url?: string;
    goal?: string;
    headless?: boolean;
    voiceOver?: boolean;
    engine?: 'webkit' | 'chromium';
    manualCheckpoints?: boolean;
    requestId?: string;
    publicWebsite?: boolean;
    steps?: import('./public-target.js').PublicTarget['steps'];
    requestTargetHash?: string;
    prepared?: { run: Run; proposalId: string; proposalHash: string };
  }) {
    if (this.active) throw Error('Another run is using the browser.');
    if (options.mode === 'live') this.getApproval();
    const url = options.url ?? this.origin + '/shop/?case=broken';
    let proposal: RecordEntry | undefined;
    let approvedSteps = options.steps;
    if (options.prepared) {
      const saved = this.store.run(options.prepared.run.id);
      const original = this.store.record(saved.id, options.prepared.proposalId);
      if (
        options.mode !== 'live' ||
        saved.mode !== 'live' ||
        saved.state !== 'running' ||
        !saved.startedAt ||
        !Number.isFinite(Date.parse(saved.startedAt)) ||
        !isDeepStrictEqual(saved, options.prepared.run) ||
        !options.requestId ||
        this.store.hostStart(options.requestId) !== saved.id ||
        (options.url !== undefined && options.url !== saved.url) ||
        (options.goal !== undefined && options.goal !== saved.goal) ||
        !original ||
        original.kind !== 'plan' ||
        !recordIsIntact(original) ||
        original.hash !== options.prepared.proposalHash ||
        original.payload.proposalVersion !== 'journey-proposal/1' ||
        readOrderedJourney(this.store.records(saved.id))
      )
        throw Error('Start requires the exact activated run and its unchanged prepared proposal.');
      journeyPlanSchema.parse({ steps: original.payload.steps });
      approvedSteps = approvedJourneyPlanSchema.parse({
        steps: options.steps ?? original.payload.steps,
      }).steps;
      proposal = original;
    }
    const run = options.prepared
      ? this.store.run(options.prepared.run.id)
      : this.store.create(
          options.goal ??
            'Add the canvas bag to the basket and review the form, stopping before any order.',
          url,
          options.mode,
          options.requestId,
        );
    const walk = new BrowserWalk(
      this.store,
      run.id,
      this.origin,
      options.headless ?? false,
      options.engine ?? defaultEngine(options.publicWebsite === true),
      options.publicWebsite === true,
    );
    const probe = new VoiceOverProbe(walk),
      controller = new AbortController();
    this.active = { run, walk, probe, controller };
    this.completion = this.execute(
      run,
      walk,
      probe,
      controller,
      options.voiceOver !== false,
      options.manualCheckpoints === true,
      approvedSteps,
      options.requestTargetHash,
      proposal,
      options.requestId,
    )
      .catch((e) => {
        this.store.append(run.id, 'limit', 'runner', { cleanup: safeError(e) });
        if (this.store.run(run.id).state === 'running')
          this.store.finish(
            run.id,
            'partial',
            'Cleanup could not finish; inspect the saved limit before starting again.',
          );
      })
      .finally(() => {
        this.active = undefined;
      });
    return run;
  }
  async stop(id: string) {
    const active = this.active,
      completion = this.completion;
    if (active?.run.id !== id) throw Error('This run is not active.');
    this.store.finish(id, 'stopped', 'Stopped by the owner.');
    active.controller.abort();
    await active.probe.cleanup();
    await Promise.all([disposeKeyboardCycles(active.walk), active.walk.close()]);
    await completion;
  }
  private stopForDeniedPage(run: Run, walk: BrowserWalk, current: RecordEntry, initial = false) {
    const entryLimit = walk.publicWebsite
      ? publicEntryLimit(current.payload.title, current.payload)
      : null;
    if (!entryLimit || this.store.run(run.id).state !== 'running') return false;
    const reason = initial
      ? entryLimit
      : entryLimit === PUBLIC_TRAFFIC_CHALLENGE
        ? 'The website presented an automated-traffic challenge during the journey. That page was not assessed; earlier evidence remains limited.'
        : 'The website presented an access-denied page during the journey. This page was not assessed; earlier evidence remains limited.';
    this.store.append(run.id, 'limit', 'runner', { reason }, [current.id]);
    this.store.finish(run.id, 'partial', reason);
    return true;
  }
  private async execute(
    run: Run,
    walk: BrowserWalk,
    probe: VoiceOverProbe,
    controller: AbortController,
    withVoiceOver: boolean,
    manualCheckpoints: boolean,
    steps?: import('./public-target.js').PublicTarget['steps'],
    requestTargetHash?: string,
    proposal?: RecordEntry,
    startRequestId?: string,
  ) {
    try {
      this.store.append(
        run.id,
        'plan',
        'driver',
        {
          goal: run.goal,
          ...(steps ? { steps, requestTargetHash } : {}),
          ...(proposal
            ? {
                executionVersion: ORDERED_JOURNEY_VERSION,
                proposalId: proposal.id,
                proposalHash: proposal.hash,
                startRequestId,
                stepsOrigin:
                  digest(JSON.stringify(steps)) === digest(JSON.stringify(proposal.payload.steps))
                    ? 'generated-proposal'
                    : 'owner-edited-approved-plan',
              }
            : {}),
          mode: run.mode,
          model:
            run.mode === 'offline'
              ? 'Saved offline examples; no AI inference'
              : {
                  driver: CAPS.driver.model,
                  analyst: CAPS.analyst.model,
                  reviewer: CAPS.reviewer.model,
                  sam: 'sam-3.1',
                },
          stopBoundary: 'No orders, payments, account creation or bookings.',
          ...(walk.publicWebsite
            ? {
                typingBoundary:
                  'Only short search terms in identified search fields. Do not enter patient, personal, account or payment details. Stop at that boundary and report the actual limitation.',
              }
            : {}),
          criteriaVersion: CRITERIA_VERSION,
          focusedChecks: {
            maximum: 2,
            reservedForVoiceOver: withVoiceOver ? 2 : 0,
            extraModelRequests: 0,
          },
          keyboardPattern:
            walk.engine === 'webkit'
              ? 'Mac WebKit Option-Tab includes links; Tab/Shift+Tab requests are performed as Alt+Tab/Alt+Shift+Tab and both requested and actual keys are recorded.'
              : 'Chromium Tab/Shift+Tab; requested and actual keys are recorded.',
        },
        proposal ? [proposal.id] : [],
      );
      let current = await walk.start(run.url);
      if (this.stopForDeniedPage(run, walk, current, true)) return;
      if (run.mode === 'live' && current.payload.stable !== true)
        current = await walk.captureSettled(current);
      declareCriterionScopes(this.store, run.id);
      const initialMeasurement = await this.automaticMeasurement(
        run,
        walk,
        current,
        controller.signal,
      );
      current = initialMeasurement.current;
      if (this.stopForDeniedPage(run, walk, current, true)) return;
      // Instrumented walks without a live page have nothing to clear.
      if (run.mode === 'live' && walk.page) {
        current = await this.clearBlockersAcrossReloads(run, walk, current, controller.signal, {
          arrival: true,
        });
        if (this.stopForDeniedPage(run, walk, current, true)) return;
      }
      this.store.append(
        run.id,
        'navigator_note',
        'driver',
        {
          kind: 'progress',
          text: 'Initial page captured. Automatic scan results do not establish keyboard or screen-reader operation.',
        },
        [current.id, ...(initialMeasurement.scan ? [initialMeasurement.scan.id] : [])],
      );
      if (withVoiceOver) {
        current = await performFocusedCheck(
          this.store,
          run.id,
          walk,
          probe,
          this.focusedBudget(run.id, true),
          current,
          {
            method: 'voiceover',
            captureId: current.id,
            criterionId: null,
            reason: 'Initial bounded real screen-reader checkpoint.',
          },
          controller.signal,
        );
      } else
        this.store.append(
          run.id,
          'coverage',
          'browser',
          {
            method: 'real_VoiceOver',
            state: 'NOT_TESTED',
            reason: 'This headless/offline browser proof does not run a native screen reader.',
          },
          [current.id],
        );
      if (run.mode === 'offline')
        await this.offline(run, walk, current, controller.signal, manualCheckpoints);
      else await this.live(run, walk, probe, current, controller);
      if (this.store.run(run.id).state === 'running')
        this.store.finish(
          run.id,
          'partial',
          run.mode === 'offline'
            ? 'Offline saved-response demonstration finished. AI quality, SAM output and full VoiceOver coverage have not been established.'
            : 'Journey stopped. Required tests and coverage remain explicitly scoped.',
        );
    } catch (e) {
      if (this.store.run(run.id).state === 'running') {
        this.store.append(run.id, 'limit', 'runner', { reason: safeError(e) });
        this.store.finish(run.id, 'partial', safeError(e));
      }
    } finally {
      try {
        if (this.store.hasRun(run.id)) declareCriterionScopes(this.store, run.id);
      } finally {
        try {
          await probe.cleanup();
        } finally {
          try {
            await Promise.all([disposeKeyboardCycles(walk), walk.close()]);
          } finally {
            this.focusedBudgets.delete(run.id);
          }
        }
      }
    }
  }
  private async offline(
    run: Run,
    walk: BrowserWalk,
    start: RecordEntry,
    signal: AbortSignal,
    manual: boolean,
  ) {
    // Newly written saved responses; no model inference or native reader claim.
    const analystRead = this.store.snapshot(run.id, 'analyst');
    const source = analystRead.records.find(
      (r) =>
        r.kind === 'observation' &&
        r.payload.stable !== false &&
        r.payload.violations?.some((v: any) => v.id === 'button-name'),
    );
    const original = source?.sources
      .map((id) => this.store.record(run.id, id))
      .find((r) => r?.kind === 'capture');
    const target = original?.payload.elements?.find(
      (element: any) => element.tag === 'button' && !element.name,
    );
    const candidate = source
      ? this.store.append(
          run.id,
          'candidate',
          'saved_analyst_response',
          {
            title: 'The add-to-basket button has no accessible name',
            detail:
              'The original controlled product page exposes an unnamed button. Its automatic button-name measurement supports this naming finding; no keyboard or spoken-reader failure is inferred.',
            criterion: 'C02',
            basis: 'measured',
            severity: 'serious',
            targetId: target?.id,
            recommendation: 'Give this button a useful accessible name, such as Add to basket.',
          },
          [source.id],
        )
      : undefined;
    const namingScope =
      original &&
      analystRead.records.find(
        (r) => r.kind === 'criterion_scope' && r.payload.captureId === original.id,
      );
    const namingProposal =
      candidate && source && original && namingScope
        ? this.store.append(
            run.id,
            'criterion_proposal',
            'saved-example',
            {
              version: CRITERIA_VERSION,
              scopeId: namingScope.id,
              checkId: `${original.id}:C02`,
              criterionId: 'C02',
              verdict: 'FAIL',
              reason:
                'Saved fixture: the original automatic scan and browser facts show an empty control name. No keyboard or reader result is inferred.',
              sources: [original.id, source.id],
              missingEvidence: [],
              screenReaderClaimed: false,
              readSnapshotId: analystRead.read.id,
            },
            [namingScope.id, original.id, source.id],
          )
        : undefined;
    const review = () => {
      if (!candidate || !source) return;
      const read = this.store.snapshot(run.id, 'reviewer');
      this.store.append(
        run.id,
        'review',
        'saved_reviewer_response',
        {
          candidateId: candidate.id,
          candidateHash: candidate.hash,
          verdict: 'keep',
          title: candidate.payload.title,
          reason:
            'Saved review example: the original controlled button-name measurement supports only this naming claim.',
          sources: [source.id],
          readSnapshotId: read.read.id,
        },
        [source.id, candidate.id, read.read.id],
      );
      if (namingProposal && original)
        this.store.append(
          run.id,
          'criterion_review',
          'saved-example',
          {
            proposalId: namingProposal.id,
            proposalHash: namingProposal.hash,
            verdict: 'keep',
            premise: 'supported',
            reason:
              'Saved review example: the exact original empty-name facts support only this scoped naming failure.',
            sources: [original.id, source.id],
            readSnapshotId: read.read.id,
            provenance: 'saved-example',
          },
          [namingProposal.id, read.read.id, original.id, source.id],
        );
    };
    const pause = async () => {
      review();
      if (manual) await this.checkpoint(run.id, signal);
      walk.assertActive();
    };
    if (manual) await pause();
    let current = start;
    const tab = walk.engine === 'webkit' ? 'Alt+Tab' : 'Tab';
    for (const target of ['add', 'basket'] as const) {
      let reached = false;
      for (let n = 0; n < 12; n++) {
        const focus = await walk.focus();
        reached =
          target === 'add'
            ? focus.id === 'add'
            : focus.tag === 'a' && focus.href.startsWith('/shop/basket');
        if (reached) break;
        await walk.act(
          {
            kind: 'press',
            key: tab,
            note: 'Saved example: advance by real keys until the known controlled target is observed.',
          },
          current,
        );
        current = await walk.capture();
        if (manual) await pause();
      }
      if (!reached)
        throw Error('The known controlled target was not reached within the keyboard limit.');
      await walk.act(
        {
          kind: 'press',
          key: 'Enter',
          note: 'Activate the observed, non-purchasing controlled target.',
        },
        current,
      );
      current = await walk.capture();
      if (manual) await pause();
    }
    const measured = await this.automaticMeasurement(run, walk, current, signal);
    current = measured.current;
    const snap = this.store.snapshot(run.id, 'analyst');
    review();
    this.store.append(run.id, 'coverage', 'runner', {
      criteria: 'Foundation only; this is not the complete fifteen-criterion assessment.',
      analystRead: snap.read.id,
      scan: measured.scan?.id ?? null,
      modelEvaluation: 'NOT_TESTED',
      sam: 'NOT_TESTED',
    });
  }
  private async live(
    run: Run,
    walk: BrowserWalk,
    probe: VoiceOverProbe,
    start: RecordEntry,
    controller: AbortController,
  ) {
    const models = new MetaModels(this.store);
    const returnEvidence = new ReturnEvidence(this.store, run.id);
    let current = start;
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(LIMITS.minutes * 60000),
    ]);
    let unchangedTraversal = 0;
    let unreachedTargets = 0;
    let decisionAllowanceSpent = true;
    let refusedAnswers = 0;
    let finalReviewSafe = true;
    const track = new AnalysisTrack();
    // Each journey step has its own allowance; a walk without a plan is one step.
    let stepId: string | undefined;
    let stepDecisions = 0;
    let stepHasForm = false;
    let stepTitle = '';
    try {
      try {
      for (let i = 0; ; i++) {
        walk.assertActive();
        if (this.stopForDeniedPage(run, walk, current)) return;
        current = await this.requestedChecks(track, run, walk, probe, current, signal);
        if (this.stopForDeniedPage(run, walk, current)) return;
        const journey = readOrderedJourney(this.store.records(run.id));
        const step = journey && currentJourneyInstruction(journey).currentStep;
        if (journey && !step) {
          decisionAllowanceSpent = false;
          break;
        }
        const id = step ? step.id : 'walk';
        if (id !== stepId) {
          stepId = id;
          stepDecisions = 0;
          stepHasForm = false;
          stepTitle = step ? step.text : '';
        }
        stepHasForm ||= showsForm(current);
        if (stepDecisions >= (stepHasForm ? DECISIONS_PER_FORM_STEP : DECISIONS_PER_STEP)) break;
        stepDecisions++;
        const snap = requestEvidence(this.store, run.id, 'driver', current);
        let action;
        try {
          action = await models.reason(
            run.id,
            'driver',
            snap.records,
            walk.images(imageRecordsForRead(snap)),
            completionOnScreen(
              current.id,
              Array.isArray(current.payload.elements) ? current.payload.elements : [],
            ),
            false,
            signal,
            snap.read,
          );
        } catch (error) {
          // An answer that breaks the decision rules is not acted on, and it no longer ends the
          // audit (owner, 31 Oct: one "step finished" answer without its screenshot ended a
          // Booking.com audit). The refusal is saved where the navigator reads it, and it is
          // asked again within its usual decision allowance; three in a row stop navigation.
          if (!(error instanceof InvalidModelAnswer)) throw error;
          refusedAnswers++;
          this.store.append(
            run.id,
            'limit',
            'driver',
            {
              method: 'navigator_answer_refused',
              reason: `The navigator's answer did not meet the decision rules and was not acted on: ${error.message} No browser input was sent.`,
              consecutive: refusedAnswers,
            },
            [current.id],
          );
          if (refusedAnswers >= MAX_REFUSED_ANSWERS) {
            this.store.append(
              run.id,
              'limit',
              'driver',
              {
                method: 'navigator_answers_refused',
                reason: `${MAX_REFUSED_ANSWERS} navigator answers in a row broke the decision rules. Navigation stopped so the recorded evidence can be analysed; remaining instructions stay incomplete.`,
              },
              [current.id],
            );
            decisionAllowanceSpent = false;
            break;
          }
          continue;
        }
        refusedAnswers = 0;
        this.store.append(
          run.id,
          'navigator_note',
          'driver',
          {
            kind: 'progress',
            text: action.note,
            ...(action.kind === 'focus_target' ? { progressMode: 'keyboard_target' } : {}),
          },
          [current.id],
        );
        if (action.kind !== 'focus_target') unreachedTargets = 0;
        if (action.kind === 'finish') {
          if (journey && currentJourneyInstruction(journey).currentStep)
            this.store.append(
              run.id,
              'limit',
              'driver',
              {
                method: 'unfinished_journey',
                reason:
                  'The navigator stopped before every approved instruction was completed. Remaining instructions and untested criteria stay unknown.',
                pendingStepId: journey.steps[journey.currentIndex]!.id,
              },
              [journey.planId, current.id],
            );
          decisionAllowanceSpent = false;
          break;
        }
        if (action.kind === 'step_done') {
          const instruction = journey && currentJourneyInstruction(journey).currentStep;
          if (!instruction || action.stepId !== instruction.id || action.captureId !== current.id) {
            this.store.append(
              run.id,
              'limit',
              'driver',
              {
                method: 'step_completion_refused',
                reason:
                  'The requested completion does not match the current instruction and its current original. No instruction was advanced and no input was sent.',
              },
              [current.id],
            );
            continue;
          }
          try {
            await walk.verifyCompletionCapture(current);
          } catch (error) {
            if (!(error instanceof ActionStateChanged)) throw error;
            this.store.append(
              run.id,
              'limit',
              'driver',
              {
                method: 'step_completion_refused',
                reason:
                  'The screen changed before instruction completion could be checked. No instruction was advanced and no input was sent.',
              },
              [current.id],
            );
            current = await walk.captureSettled();
            continue;
          }
          completeJourneyInstruction(
            this.store,
            run.id,
            action.stepId!,
            action.captureId!,
            current,
          );
          unchangedTraversal = 0;
          const updated = readOrderedJourney(this.store.records(run.id))!;
          current = (await this.automaticMeasurement(run, walk, current, signal)).current;
          if (this.stopForDeniedPage(run, walk, current)) return;
          if (!currentJourneyInstruction(updated).currentStep) {
            decisionAllowanceSpent = false;
            break;
          }
          await this.queueCheckpoint(track, models, run, current, walk, signal);
          continue;
        }
        if (action.kind === 'focus_target') {
          try {
            const traversed = await walkToKeyboardTarget(
              walk,
              this.store,
              run.id,
              current,
              action,
              signal,
              (before, key, guard) => this.targetKeyboardStep(run, walk, before, key, guard),
            );
            current =
              traversed.current.kind === 'capture'
                ? traversed.current
                : await walk.captureSettled();
            // Two requested controls in a row that keys could not reach: further
            // decisions would only repeat the attempt, so navigation ends here and
            // the final analysis reads the recorded keyboard evidence. A request refused
            // before any key was sent proves nothing about the page and does not count
            // (owner, 31 Oct); the navigator's own decision limit still bounds retries.
            const refusedUnsent = traversed.outcome === 'unavailable' && !traversed.actions.length;
            unreachedTargets = refusedUnsent
              ? unreachedTargets
              : ['cycle', 'unavailable'].includes(traversed.outcome)
                ? unreachedTargets + 1
                : 0;
            if (unreachedTargets >= 2) {
              this.store.append(
                run.id,
                'limit',
                'driver',
                {
                  method: 'unreached_targets',
                  reason:
                    'Two requested controls in a row could not be reached by keyboard. Navigation stopped so the recorded keyboard evidence can be analysed; remaining instructions stay incomplete.',
                },
                [current.id],
              );
              decisionAllowanceSpent = false;
              break;
            }
          } catch (error) {
            if (!(error instanceof ActionStateChanged)) throw error;
            this.store.append(
              run.id,
              'limit',
              'browser',
              {
                reason:
                  'The page changed before target traversal. No stale target input was performed; navigation resumes from a fresh observation and decision.',
              },
              [current.id],
            );
            current = await walk.captureSettled();
            unchangedTraversal = 0;
            continue;
          }
          unchangedTraversal = 0;
        } else if (action.kind === 'voiceover') {
          unchangedTraversal = 0;
          current = await performFocusedCheck(
            this.store,
            run.id,
            walk,
            probe,
            this.focusedBudget(run.id),
            current,
            { method: 'voiceover', captureId: current.id, criterionId: null, reason: action.note },
            signal,
          );
        } else {
          const before = current;
          let beforeContext: RecordEntry | undefined;
          try {
            beforeContext = await readJourneyContext(walk, before);
          } catch (error) {
            this.store.append(
              run.id,
              'limit',
              'runner',
              {
                reason:
                  'Journey context was unavailable; no price, choice or return result is inferred.',
                detail: safeError(error),
              },
              [before.id],
            );
          }
          let performed: RecordEntry;
          try {
            performed = await walk.act(action, current);
          } catch (error) {
            if (!(error instanceof ActionStateChanged)) throw error;
            this.store.append(
              run.id,
              'limit',
              'browser',
              {
                reason:
                  'The page changed before input. The stale decision was not performed; navigation resumes from a fresh observation and a new decision.',
              },
              [current.id],
            );
            current = await walk.captureSettled();
            unchangedTraversal = 0;
            continue;
          }
          current = await walk.captureSettled();
          if (this.stopForDeniedPage(run, walk, current)) return;
          try {
            const afterContext = await readJourneyContext(walk, current);
            if (beforeContext?.payload.stable === true && afterContext.payload.stable === true) {
              compareJourneyTotals(this.store, run.id, beforeContext, performed, afterContext);
              if (performed.payload.before?.type === 'checkbox')
                recordOptOutContext(this.store, run.id, beforeContext, performed, afterContext);
            }
            if (action.kind === 'type')
              await returnEvidence.rememberTyped(walk, before, performed, current);
            if (action.kind === 'back')
              await returnEvidence.compareAfterBack(walk, before, performed, current);
          } catch (error) {
            this.store.append(
              run.id,
              'limit',
              'runner',
              {
                reason: 'A journey comparison remains incomplete; this is not a website defect.',
                detail: safeError(error),
              },
              [performed.id, current.id],
            );
          }
          // A new page often brings its own consent banner. Cleared only after this
          // input's own before/after comparison, so the dismissal is never credited to it.
          if (current.payload.url !== before.payload.url && walk.page) {
            current = await this.clearBlockersAcrossReloads(run, walk, current, signal, {
              arrival: false,
            });
            if (this.stopForDeniedPage(run, walk, current)) return;
          }
          unchangedTraversal =
            action.kind === 'press' &&
            ['Tab', 'Shift+Tab', 'Alt+Tab', 'Alt+Shift+Tab'].includes(action.key ?? '') &&
            typeof before.payload.stateStamp === 'string' &&
            before.payload.stateStamp === current.payload.stateStamp
              ? unchangedTraversal + 1
              : 0;
          if (unchangedTraversal >= 3) {
            this.store.append(
              run.id,
              'limit',
              'driver',
              {
                reason:
                  'Three consecutive navigation attempts changed no recorded page state. The robot stopped; this does not establish a website keyboard barrier.',
              },
              [before.id, current.id],
            );
            decisionAllowanceSpent = false;
            break;
          }
        }
        if (this.stopForDeniedPage(run, walk, current)) return;
        if (!journey && i % 3 === 2) {
          current = (await this.automaticMeasurement(run, walk, current, signal)).current;
          if (this.stopForDeniedPage(run, walk, current)) return;
          await this.queueCheckpoint(track, models, run, current, walk, signal);
        }
      }
      } catch (error) {
        // The navigator's share of the audit's money, or the audit's key-press limit, ends
        // navigation cleanly: what the robot reached is still checked and reviewed below
        // (owner, 31 Oct). Any other failure keeps the hard path.
        if (
          !(error instanceof ActionLimitReached) &&
          !(error instanceof RoleAllowanceLimit && error.role === 'driver')
        )
          throw error;
        this.store.append(
          run.id,
          'limit',
          'driver',
          {
            method: 'navigation_limit',
            reason: `${safeError(error)} Navigation stopped so the recorded evidence can be analysed; remaining instructions stay incomplete.`,
          },
          [current.id],
        );
        decisionAllowanceSpent = false;
      }
      if (this.stopForDeniedPage(run, walk, current)) return;
      if (decisionAllowanceSpent)
        this.store.append(
          run.id,
          'limit',
          'driver',
          {
            reason: `The robot used its ${stepDecisions} navigation decisions for ${
              stepTitle ? `the step "${stepTitle}"` : 'this walk'
            } and stopped. This limit does not establish a website defect.`,
          },
          [current.id],
        );
      // Every screen handed to the analysis track is checked before the final one.
      await track.drain();
      signal.throwIfAborted();
      if (this.store.run(run.id).state !== 'running') throw Error('The run has stopped.');
      current = await this.requestedChecks(track, run, walk, probe, current, signal);
      if (this.stopForDeniedPage(run, walk, current)) return;
      current = await this.analyseCheckpoint(models, run, current, walk, signal, probe);
    } catch (error) {
      // A hard navigation, money, source or observation failure cannot start
      // another optional model request from finally, nor from the analysis track.
      finalReviewSafe = false;
      track.cancel();
      throw error;
    } finally {
      returnEvidence.clear();
      // No background check may still be writing when the final review or the run's end begins.
      await track.settle();
      if (
        finalReviewSafe &&
        !signal.aborted &&
        this.store.run(run.id).state === 'running' &&
        !this.stopForDeniedPage(run, walk, current)
      ) {
        try {
          await this.review(models, run, current, walk, signal, true);
        } catch (e) {
          if (e instanceof AnalysisNetworkUnavailable)
            this.incompleteCheckpoint(e, run, current, signal, true);
          else {
            if (
              !(
                (e instanceof IncompleteModelResult ||
                  e instanceof EvidenceRequestLimit ||
                  e instanceof RoleAllowanceLimit) &&
                e.role === 'reviewer'
              ) ||
              signal.aborted ||
              this.store.run(run.id).state !== 'running'
            )
              throw e;
            this.store.append(run.id, 'limit', 'reviewer', {
              reason: safeError(e),
              finalReview: 'incomplete',
            });
          }
        }
      }
    }
  }
  private async targetKeyboardStep(
    run: Run,
    walk: BrowserWalk,
    before: RecordEntry,
    action: Action,
    expectedTarget?: () => Promise<boolean>,
  ) {
    const focusMovement =
      action.kind === 'press' &&
      ['Tab', 'Shift+Tab', 'Alt+Tab', 'Alt+Shift+Tab'].includes(action.key ?? '');
    let contexts = this.targetJourneyContexts.get(walk);
    if (!contexts) {
      contexts = new Map();
      this.targetJourneyContexts.set(walk, contexts);
    }
    const readContext = async (source: RecordEntry) => {
      try {
        const context = await readJourneyContext(walk, source);
        contexts!.set(source.id, context);
        return context;
      } catch (error) {
        this.store.append(
          run.id,
          'limit',
          'runner',
          {
            reason:
              'Journey context was unavailable; no price, choice or return result is inferred.',
            detail: safeError(error),
          },
          [source.id],
        );
      }
    };
    let beforeContext =
      before.kind === 'capture'
        ? await readContext(before)
        : contexts.get(before.payload.sourceCaptureId);
    const simplePage =
      beforeContext?.payload.stable === true &&
      beforeContext.payload.data?.commerce === null &&
      beforeContext.payload.data?.choices?.length === 0;
    // Every declared price and choice was read: the strict before/after screenshots can
    // prove a price result (C11), so they stay. Booking.com never declares its prices.
    const fullyDeclared =
      beforeContext?.payload.data?.commerce != null &&
      beforeContext.payload.data.choicesComplete === true;
    // A Tab only moves focus. It saves where focus landed and takes a real screenshot only
    // when the screen visibly changed, on pages with prices or choices too (owner, 31 Oct:
    // one Booking.com screenshot per Tab cost about 7 s each and none reached the strip).
    if (focusMovement && beforeContext?.payload.stable === true && !fullyDeclared) {
      let performed: RecordEntry;
      try {
        performed = await walk.act(action, before, expectedTarget);
      } catch (error) {
        if (!(error instanceof ActionStateChanged)) throw error;
        return { current: await walk.captureSettled() };
      }
      let current = await walk.observeKeyboardMovement(before, performed);
      if (simplePage) return { current, performed };
      this.uncheckedTabPrices(run, beforeContext);
      // No visible change, but a declared price or choice could still change quietly: they
      // are read as text after the Tab, and a real screenshot is taken if they differ or
      // cannot be read.
      if (current.kind !== 'capture') {
        let changed = true;
        try {
          changed = journeyDataChanged(beforeContext.payload.data, await journeyDataNow(walk));
        } catch (error) {
          walk.assertActive();
          if (error instanceof DOMException && error.name === 'AbortError') throw error;
        }
        if (changed) current = await walk.captureSettled();
      }
      if (current.kind !== 'capture') return { current, performed };
      if (before.kind === 'capture')
        // A Tab from a real screenshot keeps the full before/after comparison.
        await this.compareAcross(run, walk, beforeContext, performed, current);
      else {
        // Within a run of Tabs there is no picture of the moment before, so a change since
        // the last real screenshot is saved as text and stays unconfirmed ("save uncertainty").
        const afterContext = await readContext(current);
        if (
          afterContext?.payload.stable !== true ||
          journeyDataChanged(beforeContext.payload.data, afterContext.payload.data)
        )
          this.store.append(
            run.id,
            'limit',
            'browser',
            {
              method: 'tab_price_change/1',
              reason:
                'By this Tab press the declared prices or choices differed from the last real screenshot, or could not be read. A new screenshot was taken. This is not a validated price comparison, no cause is inferred, and it is not a website defect.',
              before: beforeContext.payload.data,
              after: afterContext?.payload.stable === true ? afterContext.payload.data : null,
              sourceCaptureId: beforeContext.payload.sourceCaptureId,
              capturedId: current.id,
            },
            [current.id, performed.id],
          );
      }
      return { current, performed };
    }
    // Other inputs and unknown context keep their strict original before/action/after
    // comparison. Lightweight facts never replace those images.
    if (before.kind !== 'capture') {
      before = await walk.captureSettled();
      beforeContext = await readContext(before);
    }
    let performed: RecordEntry;
    try {
      performed = await walk.act(action, before, expectedTarget);
    } catch (error) {
      if (!(error instanceof ActionStateChanged)) throw error;
      return { current: await walk.captureSettled() };
    }
    const current = await walk.captureSettled();
    await this.compareAcross(run, walk, beforeContext, performed, current);
    return { current, performed };
  }
  /** Once per page address: its prices or choices could not be fully read, so a price
   * change during its Tab steps is not checked (save uncertainty, not a website defect). */
  private uncheckedTabPrices(run: Run, beforeContext: RecordEntry) {
    const data = beforeContext.payload.data;
    if (data?.commerce != null && data.choicesComplete === true) return;
    const original = this.store.record(run.id, beforeContext.payload.sourceCaptureId);
    const url = original?.payload.url ?? null;
    if (
      this.store
        .records(run.id)
        .some(
          (record) =>
            record.kind === 'limit' &&
            record.payload.method === 'tab_prices_unread/1' &&
            record.payload.url === url,
        )
    )
      return;
    this.store.append(
      run.id,
      'limit',
      'browser',
      {
        method: 'tab_prices_unread/1',
        url,
        reason:
          'This page does not declare all its prices and choices in a readable form, so a price change during Tab steps here was not checked. This is not a website defect.',
      },
      original ? [original.id] : [],
    );
  }
  /** Compares prices and choices before and after one input on two real screenshots. */
  private async compareAcross(
    run: Run,
    walk: BrowserWalk,
    beforeContext: RecordEntry | undefined,
    performed: RecordEntry,
    current: RecordEntry,
  ) {
    try {
      const afterContext = await readJourneyContext(walk, current);
      if (beforeContext?.payload.stable === true && afterContext.payload.stable === true) {
        compareJourneyTotals(this.store, run.id, beforeContext, performed, afterContext);
        if (performed.payload.before?.type === 'checkbox')
          recordOptOutContext(this.store, run.id, beforeContext, performed, afterContext);
      }
    } catch (error) {
      this.store.append(
        run.id,
        'limit',
        'runner',
        {
          reason: 'A journey comparison remains incomplete; this is not a website defect.',
          detail: safeError(error),
        },
        [performed.id, current.id],
      );
    }
  }
  private async automaticMeasurement(
    run: Run,
    walk: BrowserWalk,
    current: RecordEntry,
    signal: AbortSignal,
  ): Promise<{ current: RecordEntry; scan?: RecordEntry }> {
    // Measure only once the page has stopped reloading; if it reloads mid-scan anyway,
    // wait, observe the new page and measure again (owner, 30 Oct). A scan sends no input.
    if (signal.aborted) throw Error('The run stopped before the automatic measurement.');
    const records = this.store.records(run.id);
    const repeated = earlierScan(records, current);
    if (repeated) return { current, scan: repeated };
    // Once per page: a later step on a page already measured adds a note, not another scan.
    const samePage = earlierPageScan(records, current);
    // The same screenshot already measured needs no note: nothing about the page is reused.
    if (samePage?.payload.sourceCaptureId === current.id) return { current, scan: samePage };
    if (samePage) {
      this.store.append(
        run.id,
        'coverage',
        'runner',
        {
          method: 'page_scan_reused/1',
          reason:
            'This page was already measured by the automatic scan on an earlier screenshot. Its measured results stay with that screenshot; this screenshot was not measured again.',
          sourceCaptureId: current.id,
          scanId: samePage.id,
        },
        [current.id, samePage.id],
      );
      return { current, scan: samePage };
    }
    let observeAgain = false;
    for (let attempt = 1; ; attempt++) {
      if (signal.aborted) throw Error('The run stopped before the automatic measurement.');
      const last = attempt >= MEASUREMENT_ATTEMPTS;
      try {
        await walk.waitForReloadsToStop();
        if (observeAgain) current = await this.observeAgain(run, walk, signal);
        const scan = await walk.measurements(current);
        if (signal.aborted) throw Error('The run stopped during the automatic measurement.');
        return { current, scan };
      } catch (error) {
        const changed = error instanceof MeasurementStateChanged;
        // A closed page is a refusal, never a reload to wait out.
        if ((!changed && !documentWasReplaced(error)) || signal.aborted || walk.page?.isClosed())
          throw error;
        this.store.append(
          run.id,
          'limit',
          'browser',
          {
            method: 'automatic_accessibility_scan',
            state: changed && error.stage === 'before' ? 'NOT_TESTED' : 'INCONCLUSIVE',
            reason: last
              ? `The page changed during automatic measurement ${attempt} of ${MEASUREMENT_ATTEMPTS}. This check remains unknown; navigation resumes from a bounded observation refresh without repeating input.`
              : `The page changed during automatic measurement ${attempt} of ${MEASUREMENT_ATTEMPTS}. This attempt is unknown; the robot waits for the page to settle, observes it again and measures again, without repeating input.`,
            attempt,
            sourceCaptureId: changed ? error.captureId : current.id,
            unavailableObservationId: (changed && error.observationId) || null,
          },
          [current.id, ...(changed && error.observationId ? [error.observationId] : [])],
        );
        observeAgain = true;
        if (last) {
          await walk.waitForReloadsToStop();
          return { current: await this.observeAgain(run, walk, signal) };
        }
      }
    }
  }
  /** A fresh original of the page as it is now, with no input; each original remains saved. */
  private async observeAgain(run: Run, walk: BrowserWalk, signal: AbortSignal) {
    const refreshed = await walk.captureSettled();
    if (signal.aborted) throw Error('The run stopped during the automatic observation refresh.');
    walk.assertActive();
    declareCriterionScopes(this.store, run.id);
    return refreshed;
  }
  /** Clears banners and popups; if the page reloads meanwhile (a robot check, a
   * redirect), waits, observes the new page and clears again, at most three times. */
  private async clearBlockersAcrossReloads(
    run: Run,
    walk: BrowserWalk,
    current: RecordEntry,
    signal: AbortSignal,
    options: { arrival: boolean },
  ): Promise<RecordEntry> {
    for (let attempt = 1; ; attempt++) {
      try {
        if (attempt > 1) {
          await walk.waitForReloadsToStop(options.arrival ? ARRIVAL_QUIET_MS : RELOAD_QUIET_MS);
          current = await this.observeAgain(run, walk, signal);
        }
        return await clearPageBlockers(walk, this.store, run.id, current, signal, options);
      } catch (error) {
        if (
          !documentWasReplaced(error) ||
          attempt >= BLOCKER_ATTEMPTS ||
          signal.aborted ||
          walk.page?.isClosed()
        )
          throw error;
        this.store.append(
          run.id,
          'limit',
          'browser',
          {
            method: 'page_blocker/1',
            state: 'PAGE_RELOADED',
            attempt,
            reason: `The page loaded a new document while banners and popups were being cleared (attempt ${attempt} of ${BLOCKER_ATTEMPTS}). The robot waits for it to settle and clears again on the new page.`,
            sourceCaptureId: current.id,
          },
          [current.id],
        );
      }
    }
  }
  private async analyseCheckpoint(
    models: MetaModels,
    run: Run,
    current: RecordEntry,
    walk: BrowserWalk,
    signal: AbortSignal,
    probe?: VoiceOverProbe,
  ) {
    if (this.stopForDeniedPage(run, walk, current)) return current;
    if (this.repeatCheckpoint(run, current, signal)) return current;
    try {
      return (await this.analyse(models, run, current, walk, signal, probe)) ?? current;
    } catch (error) {
      return this.recoverIncomplete(error, run, current, walk, signal);
    }
  }
  /** Records that this exact screenshot was already checked, or handed over, with nothing
   * seen or done since; the analyst and reviewer are not called again for it. */
  private repeatCheckpoint(
    run: Run,
    current: RecordEntry,
    signal: AbortSignal,
    track?: AnalysisTrack,
  ) {
    const records = this.store.records(run.id);
    const checked = earlierCheck(records, current);
    const queued =
      track?.last?.captureId === current.id &&
      !walkEvidenceSince(records, track.last.throughSeq, current);
    if (!checked && !queued) return false;
    signal.throwIfAborted();
    if (this.store.run(run.id).state !== 'running') throw Error('The run has stopped.');
    this.store.append(
      run.id,
      'coverage',
      'runner',
      {
        method: 'repeat_checkpoint/1',
        state: 'ALREADY_CHECKED',
        reason: checked
          ? 'The analyst already checked this exact screenshot, and nothing was seen or done on the page since. It is not sent to the analyst or reviewer again; the earlier check and any review of it stand.'
          : 'This exact screenshot is already being checked, and nothing was seen or done on the page since. It is not sent to the analyst or reviewer again.',
        captureId: current.id,
        ...(checked ? { analystCoverageId: checked.id } : {}),
      },
      [current.id, ...(checked ? [checked.id] : [])],
    );
    return true;
  }
  /** Hands this screen to the analysis track and returns at once, so the robot keeps
   * walking while the analyst and reviewer check it (owner, 30 Oct). */
  private async queueCheckpoint(
    track: AnalysisTrack,
    models: MetaModels,
    run: Run,
    current: RecordEntry,
    walk: BrowserWalk,
    signal: AbortSignal,
  ) {
    track.rethrow();
    if (this.stopForDeniedPage(run, walk, current)) return;
    if (this.repeatCheckpoint(run, current, signal, track)) return;
    // The live page is read here, on the robot's track; the check itself reads saved originals.
    await this.readCheckpointContext(run, walk, current);
    track.rethrow();
    declareCriterionScopes(this.store, run.id);
    const throughSeq = this.store.records(run.id).at(-1)?.seq ?? 0;
    track.add(current, throughSeq, async () => {
      if (signal.aborted || this.store.run(run.id).state !== 'running') return;
      try {
        await this.analyse(models, run, current, walk, signal, undefined, { track, throughSeq });
      } catch (error) {
        if (signal.aborted || this.store.run(run.id).state !== 'running') return;
        this.incompleteCheckpoint(error, run, current, signal);
      }
    });
  }
  /** Focused checks the analyst asked for, done now, between the robot's own steps.
   * Each is refused, and saved as not tested, unless the page still matches its screenshot. */
  private async requestedChecks(
    track: AnalysisTrack,
    run: Run,
    walk: BrowserWalk,
    probe: VoiceOverProbe,
    current: RecordEntry,
    signal: AbortSignal,
  ) {
    track.rethrow();
    for (const request of track.takeRequests())
      current = await performFocusedCheck(
        this.store,
        run.id,
        walk,
        probe,
        this.focusedBudget(run.id),
        current,
        request,
        signal,
      );
    return current;
  }
  private async readCheckpointContext(run: Run, walk: BrowserWalk, current: RecordEntry) {
    if (typeof walk.observationStamp !== 'function') return;
    try {
      await readJourneyContext(walk, current);
    } catch (error) {
      this.store.append(
        run.id,
        'limit',
        'analyst',
        { reason: 'Original journey context could not be collected.', detail: safeError(error) },
        [current.id],
      );
    }
  }
  private async recoverIncomplete(
    error: unknown,
    run: Run,
    current: RecordEntry,
    walk: BrowserWalk,
    signal: AbortSignal,
  ) {
    const retained = this.incompleteCheckpoint(error, run, current, signal);
    if (!(error instanceof AnalysisNetworkUnavailable)) return retained;
    signal.throwIfAborted();
    walk.assertActive();
    const refreshed = await walk.captureSettled();
    signal.throwIfAborted();
    walk.assertActive();
    if (this.store.run(run.id).state !== 'running') throw Error('The run has stopped.');
    declareCriterionScopes(this.store, run.id);
    return refreshed;
  }
  private incompleteCheckpoint(
    error: unknown,
    run: Run,
    current: RecordEntry,
    signal: AbortSignal,
    finalReview = false,
  ) {
    if (
      !(
        error instanceof IncompleteModelResult ||
        error instanceof EvidenceRequestLimit ||
        error instanceof RoleAllowanceLimit ||
        error instanceof AnalysisNetworkUnavailable
      ) ||
      !['analyst', 'reviewer'].includes(error.role) ||
      signal.aborted ||
      this.store.run(run.id).state !== 'running'
    )
      throw error;
    this.store.append(
      run.id,
      'limit',
      error.role,
      {
        ...(finalReview ? { finalReview: 'incomplete' } : {}),
        ...(error instanceof AnalysisNetworkUnavailable
          ? { method: 'analysis_network_unavailable', checkpointState: 'unknown' }
          : {}),
        reason:
          error instanceof AnalysisNetworkUnavailable
            ? error.message
            : error instanceof EvidenceRequestLimit || error instanceof RoleAllowanceLimit
              ? `${error.message} Navigation continues; no over-limit request was sent.`
              : 'An analysis or review response ended before returning a result. Navigation continues; this checkpoint remains incomplete.',
        checkpointCaptureId: current.id,
      },
      [current.id],
    );
    return current;
  }
  private async analyse(
    models: MetaModels,
    run: Run,
    current: RecordEntry,
    walk: BrowserWalk,
    signal: AbortSignal,
    probe?: VoiceOverProbe,
    background?: { track: AnalysisTrack; throughSeq: number },
  ) {
    const track = background?.track;
    declareCriterionScopes(this.store, run.id);
    if (!track) await this.readCheckpointContext(run, walk, current);
    const snapshot = requestEvidence(
      this.store,
      run.id,
      'analyst',
      current,
      background?.throughSeq,
    );
    const images = walk.images(imageRecordsForRead(snapshot));
    if (analysisNetworkDeferred(this.store.records(run.id), 'analyst')) return current;
    const analysis = await optionalAnalysisRequest('analyst', () =>
      models.reason(
        run.id,
        'analyst',
        snapshot.records,
        images,
        analysisSchema,
        false,
        signal,
        snapshot.read,
      ),
    );
    const visual = recordAnalysisDetails(
      this.store,
      run.id,
      snapshot,
      images.map((image) => image.captureId),
      analysis,
    );
    for (const c of analysis.findings) {
      if (!c.sources.every((id) => snapshot.records.some((r) => r.id === id)))
        throw Error('Analyst cited evidence it did not read.');
      let target: ReturnType<typeof candidateTarget>;
      try {
        target = candidateTarget(
          c,
          snapshot.records,
          images.map((image) => image.captureId),
        );
      } catch (error) {
        this.store.append(run.id, 'limit', 'analyst', {
          reason: safeError(error),
          issueKey: c.issueKey,
          claimStatus: 'withheld; raw result remains in model_response',
        });
        continue;
      }
      let visualSources: ReturnType<typeof visualCandidateSources>;
      try {
        visualSources = visualCandidateSources(c, visual);
      } catch (error) {
        this.store.append(run.id, 'limit', 'analyst', {
          reason: safeError(error),
          issueKey: c.issueKey,
          claimStatus: 'withheld; visual support missing',
        });
        continue;
      }
      const { visualObservationIndex: _index, ...claim } = c;
      this.store.append(
        run.id,
        'candidate',
        'analyst',
        {
          ...claim,
          visualObservationId: visualSources.visualObservationId,
          analystReadSnapshotId: snapshot.read.id,
          analystReadSnapshotHash: snapshot.read.hash,
        },
        visualSources.sources,
      );
      if (target && !track?.isCancelled) {
        try {
          await mapElement(this.store, models, run.id, target.capture, target.target.id, signal);
        } catch (e) {
          this.store.append(
            run.id,
            'limit',
            'sam',
            {
              reason: safeError(e),
              captureId: target.capture.id,
              source: 'SAM unavailable; original capture remains available.',
            },
            [target.capture.id],
          );
        }
      }
    }
    this.store.append(run.id, 'coverage', 'analyst', {
      topics: analysis.coverage,
      readSnapshotId: snapshot.read.id,
    });
    if (track) {
      // On the analysis track the browser belongs to the robot: requested checks are handed
      // back, and the review reads the same saved originals the analyst read.
      for (const request of (analysis.missingEvidence ?? []) as MissingEvidenceRequest[])
        track.ask(request);
      declareCriterionScopes(this.store, run.id);
      if (
        !track.isCancelled &&
        this.store.usage(run.id).requests.filter((r) => r.role === 'reviewer').length < 3
      )
        await this.review(models, run, current, walk, signal, false, background.throughSeq);
      return current;
    }
    let next = current;
    for (const request of (analysis.missingEvidence ?? []) as MissingEvidenceRequest[])
      next = await performFocusedCheck(
        this.store,
        run.id,
        walk,
        probe,
        this.focusedBudget(run.id),
        next,
        request,
        signal,
      );
    if (this.stopForDeniedPage(run, walk, next)) return next;
    declareCriterionScopes(this.store, run.id);
    if (this.store.usage(run.id).requests.filter((r) => r.role === 'reviewer').length < 3)
      try {
        await this.review(models, run, next, walk, signal, false);
      } catch (error) {
        return this.recoverIncomplete(error, run, next, walk, signal);
      }
    return next;
  }
  private async review(
    models: MetaModels,
    run: Run,
    current: RecordEntry,
    walk: BrowserWalk,
    signal: AbortSignal,
    final: boolean,
    throughSeq?: number,
  ) {
    const candidates = this.store.records(run.id).filter((r) => r.kind === 'candidate');
    const proposals = this.store.records(run.id).filter((r) => r.kind === 'criterion_proposal');
    if (!candidates.length && !proposals.length) return;
    const snapshot = requestEvidence(this.store, run.id, 'reviewer', current, throughSeq);
    const images = walk.images(imageRecordsForRead(snapshot));
    if (analysisNetworkDeferred(this.store.records(run.id), 'reviewer')) return;
    const result = await optionalAnalysisRequest('reviewer', () =>
      models.reason(
        run.id,
        'reviewer',
        snapshot.records,
        images,
        reviewSchema,
        final,
        signal,
        snapshot.read,
      ),
    );
    for (const d of result.decisions) {
      const c = candidates.find((r) => r.id === d.candidateId);
      if (!c || c.hash !== d.candidateHash)
        throw Error('Review does not match the exact candidate.');
      if (!d.sources.every((id) => snapshot.records.some((r) => r.id === id)))
        throw Error('Reviewer cited evidence it did not read.');
      const verdict =
        d.verdict === 'keep' && (d.premise !== 'supported' || d.title !== c.payload.title)
          ? 'rewrite'
          : d.verdict;
      this.store.append(
        run.id,
        'review',
        'reviewer',
        {
          ...d,
          verdict,
          readSnapshotId: snapshot.read.id,
          readSnapshotHash: snapshot.read.hash,
          provenance: run.mode === 'offline' ? 'saved-example' : 'model',
        },
        [...d.sources, c.id, snapshot.read.id],
      );
    }
    for (const decision of result.criterionDecisions ?? []) {
      const proposal = snapshot.records.find(
        (r) => r.id === decision.proposalId && r.kind === 'criterion_proposal',
      );
      if (
        !proposal ||
        proposal.hash !== decision.proposalHash ||
        !decision.sources.every((id) => snapshot.records.some((r) => r.id === id))
      ) {
        this.store.append(run.id, 'limit', 'reviewer', {
          reason:
            'Criterion review did not match an exact supplied proposal and its original evidence.',
        });
        continue;
      }
      this.store.append(
        run.id,
        'criterion_review',
        'reviewer',
        {
          ...decision,
          readSnapshotId: snapshot.read.id,
          readSnapshotHash: snapshot.read.hash,
          provenance: run.mode === 'offline' ? 'saved-example' : 'model',
        },
        [...new Set([proposal.id, snapshot.read.id, ...decision.sources])],
      );
    }
  }
}
