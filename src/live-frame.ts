import { digest, recordIsIntact } from './store.js';
import type { RecordEntry } from './types.js';

export type LiveFrame = {
  protocol: 'access-walk/frame-v1';
  runId: string;
  sequence: number;
  capturedAt: string;
  width: number;
  height: number;
  imageHash: string;
  captureId: string | null;
  png: string;
};

/** Display-only pixels: never append to the evidence pool or start a browser. */
export class LiveFrames {
  private cached?: LiveFrame;
  private pending?: Promise<LiveFrame>;
  private sequence = 0;
  private closed = false;
  private sampledAt = 0;
  constructor(
    private runId: string,
    private screenshot: () => Promise<Buffer>,
    private assertActive: () => void,
    private captures: () => RecordEntry[],
    private stateStamp: () => Promise<string>,
    private now = Date.now,
    private reviewedCaptureIds: () => ReadonlySet<string> = () => new Set(),
  ) {}
  read(): Promise<LiveFrame> {
    if (this.closed) return Promise.reject(Error('The live browser has closed.'));
    this.assertActive();
    if (this.pending) return this.pending;
    if (this.cached && this.now() - this.sampledAt < 250) return Promise.resolve(this.cached);
    this.pending = this.take().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }
  private async take(): Promise<LiveFrame> {
    const before = await this.stateStamp();
    this.assertActive();
    if (this.closed) throw Error('The live browser has closed.');
    const bytes = await this.screenshot();
    const after = await this.stateStamp();
    this.assertActive();
    if (this.closed) throw Error('The live browser has closed.');
    if (
      bytes.length < 24 ||
      bytes.length > 4 * 1024 * 1024 ||
      bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
    )
      throw Error('The live browser returned an unsupported picture.');
    const width = bytes.readUInt32BE(16),
      height = bytes.readUInt32BE(20);
    if (!width || !height || width > 4096 || height > 4096)
      throw Error('Unsupported live picture dimensions.');
    const imageHash = digest(bytes);
    const matching = this.captures().filter(
      (r) =>
        r.kind === 'capture' &&
        r.runId === this.runId &&
        r.author === 'browser' &&
        recordIsIntact(r) &&
        r.payload.stable === true &&
        before === after &&
        r.payload.stateStamp === after &&
        r.payload.imageHash === imageHash &&
        r.payload.width === width &&
        r.payload.height === height,
    );
    // Repeated observations can share exact pixels and full page state. Keep the
    // reviewed original's identity rather than moving its claim onto a new capture.
    let capture = matching.at(-1);
    if (matching.length > 1)
      try {
        const reviewed = this.reviewedCaptureIds();
        capture = matching.findLast((record) => reviewed.has(record.id)) ?? capture;
      } catch {
        // Review data is optional for display. Keep the ordinary exact-picture
        // match when that lookup fails; this never grants a finding approval.
      }
    this.sampledAt = this.now();
    this.cached = {
      protocol: 'access-walk/frame-v1',
      runId: this.runId,
      sequence: ++this.sequence,
      capturedAt: new Date(this.sampledAt).toISOString(),
      width,
      height,
      imageHash,
      captureId: capture?.id ?? null,
      png: bytes.toString('base64'),
    };
    return this.cached;
  }
  close() {
    this.closed = true;
    this.cached = undefined;
  }
}
