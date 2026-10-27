import { z } from 'zod';
import { BrowserWalk } from './browser.js';
import { VoiceOverProbe } from './voiceover.js';
import { Store } from './store.js';
import { MetaModels, actionSchema, analysisSchema, reviewSchema, type Action } from './models.js';
import type { RecordEntry, Run } from './types.js';
import { approval, safeError } from './config.js';
import { mapElement } from './segmentation.js';
export class Runner {
  active?: { run: Run; walk: BrowserWalk; probe: VoiceOverProbe; controller: AbortController };
  completion?: Promise<void>;
  private waiting?: { runId: string; release: () => void };
  private discarding = new Map<string, Promise<void>>();
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
  private async execute(
    run: Run,
    walk: BrowserWalk,
    probe: VoiceOverProbe,
    controller: AbortController,
    withVoiceOver: boolean,
    manualCheckpoints: boolean,
  ) {
    try {
      this.store.append(run.id, 'plan', 'driver', {
        goal: run.goal,
        mode: run.mode,
        model:
          run.mode === 'offline' ? 'Saved offline examples; no AI inference' : 'muse-spark-1.3',
        stopBoundary: 'No orders, payments, account creation or bookings.',
      });
      let current = await walk.start(run.url);
      const scan = await walk.measurements(current);
      this.store.append(
        run.id,
        'navigator_note',
        'driver',
        {
          kind: 'progress',
          text: 'Initial page captured. Automatic scan results do not establish keyboard or screen-reader operation.',
        },
        [current.id, scan.id],
      );
      if (withVoiceOver) {
        await probe.check(current);
        current = await walk.capture();
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
      await probe.cleanup();
      await walk.close();
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
    const scan = await walk.measurements(current);
    const snap = this.store.snapshot(run.id, 'analyst');
    review();
    this.store.append(run.id, 'coverage', 'runner', {
      criteria: 'Foundation only; this is not the complete fifteen-criterion assessment.',
      analystRead: snap.read.id,
      scan: scan.id,
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
    let current = start;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15 * 60000)]);
    try {
      for (let i = 0; i < 20; i++) {
        walk.assertActive();
        const snap = this.store.snapshot(run.id, 'driver');
        const action = await models.reason(
          run.id,
          'driver',
          snap.records,
          walk.images(snap.records),
          actionSchema,
          false,
          signal,
        );
        this.store.append(
          run.id,
          'navigator_note',
          'driver',
          { kind: 'progress', text: action.note },
          [current.id],
        );
        if (action.kind === 'finish') break;
        if (action.kind === 'voiceover') {
          await probe.check(current);
          current = await walk.capture();
        } else {
          await walk.act(action, current);
          current = await walk.capture();
        }
        if (i % 3 === 2) {
          await walk.measurements(current);
          await this.analyse(models, run, current, walk, signal);
        }
      }
      await this.analyse(models, run, current, walk, signal);
    } finally {
      if (!signal.aborted && this.store.run(run.id).state === 'running') {
        try {
          await this.review(models, run, current, walk, signal, true);
        } catch (e) {
          this.store.append(run.id, 'limit', 'reviewer', {
            reason: safeError(e),
            finalReview: 'incomplete',
          });
        }
      }
    }
  }
  private async analyse(
    models: MetaModels,
    run: Run,
    current: RecordEntry,
    walk: BrowserWalk,
    signal: AbortSignal,
  ) {
    const snapshot = this.store.snapshot(run.id, 'analyst');
    const analysis = await models.reason(
      run.id,
      'analyst',
      snapshot.records,
      walk.images(snapshot.records),
      analysisSchema,
      false,
      signal,
    );
    for (const c of analysis.findings) {
      if (!c.sources.every((id) => snapshot.records.some((r) => r.id === id)))
        throw Error('Analyst cited evidence it did not read.');
      this.store.append(run.id, 'candidate', 'analyst', c, c.sources);
      if (c.targetId && c.sources.includes(current.id)) {
        try {
          await mapElement(this.store, models, run.id, current, c.targetId, signal);
        } catch (e) {
          this.store.append(
            run.id,
            'limit',
            'sam',
            {
              reason: safeError(e),
              captureId: current.id,
              source: 'SAM unavailable; original capture remains available.',
            },
            [current.id],
          );
        }
      }
    }
    this.store.append(run.id, 'coverage', 'analyst', {
      topics: analysis.coverage,
      readSnapshotId: snapshot.read.id,
    });
    if (this.store.usage(run.id).requests.filter((r) => r.role === 'reviewer').length < 3)
      await this.review(models, run, current, walk, signal, false);
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
    if (!candidates.length) return;
    const snapshot = this.store.snapshot(run.id, 'reviewer');
    const result = await models.reason(
      run.id,
      'reviewer',
      snapshot.records,
      walk.images(snapshot.records),
      reviewSchema,
      final,
      signal,
    );
    for (const d of result.decisions) {
      const c = candidates.find((r) => r.id === d.candidateId);
      if (!c || c.hash !== d.candidateHash)
        throw Error('Review does not match the exact candidate.');
      if (!d.sources.every((id) => snapshot.records.some((r) => r.id === id)))
        throw Error('Reviewer cited evidence it did not read.');
      this.store.append(run.id, 'review', 'reviewer', { ...d, readSnapshotId: snapshot.read.id }, [
        ...d.sources,
        c.id,
        snapshot.read.id,
      ]);
    }
  }
}
