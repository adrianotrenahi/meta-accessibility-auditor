import { MetaModels } from './models.js';
import { Store } from './store.js';
import type { JourneyDraftBinding, JourneyDraftView } from './journey-drafts.js';
import { safeError } from './config.js';

export function journeyPlanView(view: JourneyDraftView) {
  return {
    id: view.run.id,
    state:
      view.run.state === 'prepared'
        ? 'prepared'
        : view.run.state === 'planning'
          ? 'planning'
          : 'unavailable',
    ...(view.run.state === 'prepared' && view.plan
      ? {
          planId: view.plan.id,
          planHash: view.plan.hash,
          steps: view.plan.payload.steps,
        }
      : {}),
    ...(view.run.state !== 'prepared' && view.run.state !== 'planning'
      ? {
          reason:
            view.run.state === 'interrupted' && !view.draft.planningRequestId && !view.plan
              ? 'No generation was sent. Retry this same draft with a current bounded approval.'
              : 'This draft is no longer waiting for Start. Its records and charges are retained; the same draft will not generate again.',
        }
      : {}),
  };
}

/** One durable draft and one in-flight promise. A repeated setup request reads
 * that same attempt; it never silently buys a second generation. */
export class JourneyPlanner {
  private active = new Map<
    string,
    { controller: AbortController; promise: Promise<JourneyDraftView> }
  >();
  private closed = false;
  private closing?: Promise<void>;
  constructor(
    private store: Store,
    private models: Pick<MetaModels, 'plan'> = new MetaModels(store),
    private browserBusy: () => boolean = () => false,
  ) {}
  get isPreparing() {
    return this.active.size > 0;
  }
  get isClosed() {
    return this.closed;
  }

  prepare(binding: JourneyDraftBinding): Promise<JourneyDraftView> {
    if (this.closed)
      return Promise.reject(Error('The local planner has closed. No new request was prepared.'));
    const previous = this.store.journeyDraft(binding);
    if (previous) {
      const pending = this.active.get(previous.run.id);
      if (pending) return pending.promise;
      if (previous.run.state !== 'interrupted' || previous.draft.planningRequestId || previous.plan)
        return Promise.resolve(previous);
    }
    if (this.browserBusy() || this.active.size)
      return Promise.reject(Error('Another local test is using the browser or preparing a plan.'));
    const claimed = previous
      ? this.store.retryUnsentJourneyDraft(binding)
      : this.store.claimJourneyDraft(binding);
    if (!previous && !claimed.created) return Promise.resolve(claimed);
    const controller = new AbortController();
    const promise = this.generate(binding, claimed, controller.signal).finally(() =>
      this.active.delete(claimed.run.id),
    );
    this.active.set(claimed.run.id, { controller, promise });
    return promise;
  }

  private async generate(
    binding: JourneyDraftBinding,
    view: JourneyDraftView,
    signal: AbortSignal,
  ) {
    try {
      const result = await this.models.plan(
        view.run.id,
        AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
      );
      if (signal.aborted || this.store.run(view.run.id).state !== 'planning')
        throw Error('The draft was stopped before its proposal was saved.');
      return this.store.prepareJourneyDraft(binding, {
        proposalVersion: 'journey-proposal/1',
        provenance: 'model-generated-from-unvisited-brief',
        ...result,
      });
    } catch (error) {
      if (this.store.hasRun(view.run.id) && this.store.run(view.run.id).state === 'planning') {
        this.store.append(view.run.id, 'limit', 'planner', {
          method: 'journey_planning_unavailable',
          reason: safeError(error),
          noAutomaticRegeneration: true,
        });
        this.store.finish(
          view.run.id,
          'interrupted',
          'The journey plan is unavailable. Review the recorded attempt before requesting another.',
        );
      }
      throw error;
    }
  }

  async stop(runId: string) {
    const pending = this.active.get(runId);
    if (pending) {
      if (this.store.hasRun(runId) && this.store.run(runId).state === 'planning')
        this.store.finish(runId, 'stopped', 'Planning stopped by the owner.');
      pending.controller.abort();
      await pending.promise.catch(() => {});
    } else if (
      this.store.hasRun(runId) &&
      ['planning', 'prepared'].includes(this.store.run(runId).state)
    )
      this.store.finish(runId, 'stopped', 'Planning stopped by the owner.');
  }

  async close() {
    this.closed = true;
    this.closing ??= Promise.all([...this.active.keys()].map((runId) => this.stop(runId))).then(
      () => {},
    );
    await this.closing;
  }
}
