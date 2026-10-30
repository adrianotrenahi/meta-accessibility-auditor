import { digest } from '../src/store.js';
import type { SharedRecord, SharedRemote, SharedRequest } from '../src/shared-storage.js';

/** An in-memory stand-in for Neon and R2, so no test touches a real account. */
export class FakeRemote implements SharedRemote {
  runsById = new Map<string, { body: string; discarded_at: string | null }>();
  recordsById = new Map<string, SharedRecord>();
  requestsById = new Map<string, SharedRequest & { run_id: string }>();
  files = new Map<string, { bytes: Uint8Array; hash: string }>();
  offline = false;
  recordBatches = 0;
  ownedWrites = 0;
  hang = false;
  calls = 0;
  private check() {
    this.calls++;
    if (this.offline) throw Error('network unreachable');
  }
  async prepareHang() {
    if (this.hang) await new Promise(() => {});
  }
  async prepare() {
    this.check();
    await this.prepareHang();
  }
  async putRun(id: string, body: string, owned: boolean) {
    this.check();
    const prior = this.runsById.get(id);
    if (owned) this.ownedWrites++;
    if (!prior) this.runsById.set(id, { body, discarded_at: null });
    else if (owned) prior.body = body;
  }
  async markDiscarded(id: string, at: string) {
    this.check();
    const run = this.runsById.get(id);
    if (run) run.discarded_at ??= at;
  }
  async discarded(ids: string[]) {
    this.check();
    return new Set(ids.filter((id) => this.runsById.get(id)?.discarded_at));
  }
  async putRecords(rows: SharedRecord[]) {
    this.check();
    this.recordBatches++;
    for (const row of rows) if (!this.recordsById.has(row.id)) this.recordsById.set(row.id, row);
  }
  async putRequests(runId: string, rows: SharedRequest[]) {
    this.check();
    for (const row of rows) this.requestsById.set(row.id, { ...row, run_id: runId });
  }
  async putObject(runId: string, name: string, bytes: Uint8Array) {
    this.check();
    this.files.set(`${runId}/${name}`, { bytes, hash: digest(bytes) });
  }
  async runs() {
    this.check();
    return [...this.runsById].map(([id, run]) => ({ id, ...run }));
  }
  async records(runId: string, after: number) {
    return [...this.recordsById.values()]
      .filter((row) => row.run_id === runId && row.seq > after)
      .sort((a, b) => a.seq - b.seq);
  }
  async requests(runId: string) {
    return [...this.requestsById.values()].filter((row) => row.run_id === runId);
  }
  async objects(runId: string) {
    return [...this.files]
      .filter(([key]) => key.startsWith(`${runId}/`))
      .map(([key, file]) => ({ name: key.slice(runId.length + 1), hash: file.hash }));
  }
  async object(runId: string, name: string) {
    return this.files.get(`${runId}/${name}`)!.bytes;
  }
  recordsOf(runId: string) {
    return [...this.recordsById.values()].filter((row) => row.run_id === runId);
  }
}
