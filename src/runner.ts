import { RoleAllowanceLimit } from './role-allowance.js';
import { walkToKeyboardTarget } from './keyboard-target.js';
import { publicEntryLimit, PUBLIC_TRAFFIC_CHALLENGE } from './public-target.js';
import { z } from 'zod';
import { BrowserWalk, MeasurementStateChanged, ActionStateChanged } from './browser.js';
import { VoiceOverProbe } from './voiceover.js';
import { Store } from './store.js';
import {
  MetaModels,
  IncompleteModelResult,
  navigationActionSchema,
  analysisSchema,
  reviewSchema,
  type Action,
} from './models.js';
import type { RecordEntry, Run } from './types.js';
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
import {
  readJourneyContext,
  compareJourneyTotals,
  recordOptOutContext,
  ReturnEvidence,
} from './journey-evidence.js';
export class Runner {
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
  }) {
    if (this.active) throw Error('Another run is using the browser.');
    if (options.mode === 'live') approval();
    const url = options.url ?? this.origin + '/shop/?case=broken';
    const run = this.store.create(
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
      options.engine ?? 'webkit',
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
      options.steps,
      options.requestTargetHash,
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
    await active.walk.close();
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
  ) {
    try {
      this.store.append(run.id, 'plan', 'driver', {
        goal: run.goal,
        ...(steps ? { steps, requestTargetHash } : {}),
        mode: run.mode,
        model:
          run.mode === 'offline' ? 'Saved offline examples; no AI inference' : 'muse-spark-1.3',
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
      });
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
            await walk.close();
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
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15 * 60000)]);
    let unchangedTraversal = 0;
    let decisionAllowanceSpent = true;
    let finalReviewSafe = true;
    try {
      for (let i = 0; i < 20; i++) {
        walk.assertActive();
        if (this.stopForDeniedPage(run, walk, current)) return;
        const snap = requestEvidence(this.store, run.id, 'driver', current);
        const action = await models.reason(
          run.id,
          'driver',
          snap.records,
          walk.images(imageRecordsForRead(snap)),
          navigationActionSchema,
          false,
          signal,
          snap.read,
        );
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
        if (action.kind === 'finish') {
          decisionAllowanceSpent = false;
          break;
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
            current = traversed.current;
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
        if (i % 3 === 2) {
          current = (await this.automaticMeasurement(run, walk, current, signal)).current;
          if (this.stopForDeniedPage(run, walk, current)) return;
          current = await this.analyseCheckpoint(models, run, current, walk, signal, probe);
        }
      }
      if (this.stopForDeniedPage(run, walk, current)) return;
      if (decisionAllowanceSpent)
        this.store.append(
          run.id,
          'limit',
          'driver',
          {
            reason:
              'The robot used its twenty navigation decisions and stopped. This limit does not establish a website defect.',
          },
          [current.id],
        );
      current = await this.analyseCheckpoint(models, run, current, walk, signal, probe);
    } catch (error) {
      // A hard navigation, money, source or observation failure cannot start
      // another optional model request from finally.
      finalReviewSafe = false;
      throw error;
    } finally {
      returnEvidence.clear();
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
    let beforeContext: RecordEntry | undefined;
    try {
      beforeContext = await readJourneyContext(walk, before);
    } catch (error) {
      this.store.append(
        run.id,
        'limit',
        'runner',
        {
          reason: 'Journey context was unavailable; no price, choice or return result is inferred.',
          detail: safeError(error),
        },
        [before.id],
      );
    }
    let performed: RecordEntry;
    try {
      performed = await walk.act(action, before, expectedTarget);
    } catch (error) {
      if (!(error instanceof ActionStateChanged)) throw error;
      return { current: await walk.captureSettled() };
    }
    const current = await walk.captureSettled();
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
    return { current, performed };
  }
  private async automaticMeasurement(
    run: Run,
    walk: BrowserWalk,
    current: RecordEntry,
    signal: AbortSignal,
  ): Promise<{ current: RecordEntry; scan?: RecordEntry }> {
    if (signal.aborted) throw Error('The run stopped before the automatic measurement.');
    try {
      const scan = await walk.measurements(current);
      if (signal.aborted) throw Error('The run stopped during the automatic measurement.');
      return { current, scan };
    } catch (error) {
      if (!(error instanceof MeasurementStateChanged) || signal.aborted) throw error;
      this.store.append(
        run.id,
        'limit',
        'browser',
        {
          method: 'automatic_accessibility_scan',
          state: error.stage === 'before' ? 'NOT_TESTED' : 'INCONCLUSIVE',
          reason:
            'The page changed before its automatic measurement could settle. This check remains unknown; navigation resumes from a bounded observation refresh without repeating input or the scan.',
          sourceCaptureId: error.captureId,
          unavailableObservationId: error.observationId ?? null,
        },
        [current.id, ...(error.observationId ? [error.observationId] : [])],
      );
      // At most three observation reads, with no new input or scan; each original remains saved.
      const refreshed = await walk.captureSettled();
      if (signal.aborted) throw Error('The run stopped during the automatic observation refresh.');
      walk.assertActive();
      declareCriterionScopes(this.store, run.id);
      return { current: refreshed };
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
    try {
      return (await this.analyse(models, run, current, walk, signal, probe)) ?? current;
    } catch (error) {
      return this.recoverIncomplete(error, run, current, walk, signal);
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
  ) {
    declareCriterionScopes(this.store, run.id);
    if (typeof walk.observationStamp === 'function') {
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
    const snapshot = requestEvidence(this.store, run.id, 'analyst', current);
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
      if (target) {
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
  ) {
    const candidates = this.store.records(run.id).filter((r) => r.kind === 'candidate');
    const proposals = this.store.records(run.id).filter((r) => r.kind === 'criterion_proposal');
    if (!candidates.length && !proposals.length) return;
    const snapshot = requestEvidence(this.store, run.id, 'reviewer', current);
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
