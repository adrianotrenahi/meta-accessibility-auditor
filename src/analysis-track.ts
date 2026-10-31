import type { MissingEvidenceRequest } from './evidence-checks.js';
import type { RecordEntry } from './types.js';

/**
 * The analyst and reviewer check saved screens on their own track while the robot keeps
 * walking (owner, 30 Oct). Checks run one at a time, in the order the screens were reached.
 * The track never touches the browser: a focused check the analyst asks for is handed back
 * to the robot, which performs it at its next safe point only if the page still matches.
 */
export class AnalysisTrack {
  private queue: Promise<void> = Promise.resolve();
  private failure: { error: unknown } | undefined;
  private waiting = 0;
  /** The screenshot most recently handed over, and the last saved record at that moment. */
  last?: { captureId: string; throughSeq: number };
  private requests: MissingEvidenceRequest[] = [];

  /** Queues one screen's check; returns at once. */
  add(capture: RecordEntry, throughSeq: number, check: () => Promise<void>) {
    this.last = { captureId: capture.id, throughSeq };
    this.waiting++;
    this.queue = this.queue.then(async () => {
      try {
        if (!this.failure) await check();
      } catch (error) {
        this.failure ??= { error };
      } finally {
        this.waiting--;
      }
    });
  }
  /** Checks still queued or running. */
  get pending() {
    return this.waiting;
  }
  /** A check that failed outright stops the robot at its next step, as it did inline. */
  rethrow() {
    if (this.failure) throw this.failure.error;
  }
  /** Waits for every queued check, then reports a failure. */
  async drain() {
    await this.queue;
    this.rethrow();
  }
  /** Waits for every queued check without reporting; used while a run is already ending. */
  async settle() {
    await this.queue;
  }
  /** A focused check the analyst asked for; the request names its own screenshot. */
  ask(request: MissingEvidenceRequest) {
    this.requests.push(request);
  }
  /** Focused checks the analyst asked for, oldest first; each is handed out once. */
  takeRequests() {
    return this.requests.splice(0);
  }
}
