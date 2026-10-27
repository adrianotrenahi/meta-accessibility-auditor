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
  }) {
    if (this.active) throw Error('Another run is using the browser.');
    if (options.mode === 'live') approval();
    const url = options.url ?? this.origin + '/shop/?case=broken';
    const run = this.store.create(
      options.goal ??
        'Add the canvas bag to the basket and review the form, stopping before any order.',
      url,
      options.mode,
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
    ).finally(() => {
      this.active = undefined;
    });
    return run;
  }
  async stop(id: string) {
    if (this.active?.run.id !== id) throw Error('This run is not active.');
    this.store.finish(id, 'stopped', 'Stopped by the owner.');
    this.active.controller.abort();
    await this.active.probe.cleanup();
    await this.active.walk.close();
    await this.completion;
  }
  private async execute(
    run: Run,
    walk: BrowserWalk,
    probe: VoiceOverProbe,
    controller: AbortController,
    withVoiceOver: boolean,
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
      if (run.mode === 'offline') await this.offline(run, walk, current);
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
  private async offline(run: Run, walk: BrowserWalk, start: RecordEntry) {
    // These are newly written deterministic demonstration responses, not claimed model output.
    let current = start;
    const tab = walk.engine === 'webkit' ? 'Alt+Tab' : 'Tab';
    for (const key of [tab, tab, tab, 'Enter', tab, 'Enter'] as const) {
      walk.assertActive();
      await walk.act(
        {
          kind: 'press',
          key,
          note: 'Saved offline keyboard example; WebKit uses Option-Tab to include links.',
        },
        current,
      );
      current = await walk.capture();
    }
    const scan = await walk.measurements(current);
    const snap = this.store.snapshot(run.id, 'analyst');
    const source = this.store
      .records(run.id)
      .filter((r) => r.kind === 'observation')
      .find((r) => r.payload.violations?.some((v: any) => v.id === 'button-name'));
    if (source) {
      const candidate = this.store.append(
        run.id,
        'candidate',
        'saved_analyst_response',
        {
          title: 'The add-to-basket button has no accessible name',
          detail:
            'The controlled broken example contains an icon-only button with no accessible name. The automatic button-name check supports this scoped naming finding.',
          criterion: 'C02',
          basis: 'measured',
          severity: 'serious',
          recommendation: 'Give this button a useful accessible name, such as Add to basket.',
          sources: [source.id],
        },
        [source.id],
      );
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
            'Saved-response demonstration: the original button-name measurement matches the claim. No keyboard or VoiceOver failure is inferred.',
          sources: [source.id],
          readSnapshotId: read.read.id,
        },
        [source.id, candidate.id, read.read.id],
      );
    }
    this.store.append(run.id, 'coverage', 'runner', {
      criteria:
        'Day 1–2 foundation only; the complete fifteen-criterion assessment is scheduled for Day 3.',
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
