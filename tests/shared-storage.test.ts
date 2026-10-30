import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest, KEPT_ROWS, Store } from '../src/store.js';
import {
  pullShared,
  redactor,
  SharedMirror,
  sharedConfig,
  type SharedRecord,
  type SharedRemote,
  type SharedRequest,
} from '../src/shared-storage.js';

/** An in-memory stand-in for Neon and R2, so no test touches a real account. */
class FakeRemote implements SharedRemote {
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

const folders: string[] = [];
const freshStore = () => {
  const dir = mkdtempSync(join(tmpdir(), 'access-walk-shared-'));
  folders.push(dir);
  return new Store(dir);
};
test.after(() => folders.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** A run with one screenshot and its capture record, as the robot saves them. */
const audit = (store: Store) => {
  const run = store.create('Find a flight', 'https://example.org', 'offline');
  const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
  const asset = store.asset(run.id, 'capture_one.png', bytes);
  store.append(run.id, 'capture', 'browser', { imageFile: asset.file, imageHash: asset.hash });
  return { run, bytes };
};
const mirrorFor = (store: Store, remote: SharedRemote) =>
  new SharedMirror(store, remote, { discard: async (id) => store.discard(id) });

test('Shared storage is off unless all five settings exist, and never echoes a value', () => {
  const dir = mkdtempSync(join(tmpdir(), 'access-walk-config-'));
  folders.push(dir);
  const file = join(dir, 'storage.env');
  assert.equal(sharedConfig({}, file), null);
  writeFileSync(file, 'ACCESS_WALK_DATABASE_URL=postgresql://user:sekret@host/db\n');
  assert.throws(
    () => sharedConfig({}, file),
    (error: Error) =>
      error.message.includes('ACCESS_WALK_R2_BUCKET') && !error.message.includes('sekret'),
  );
  writeFileSync(
    file,
    [
      'ACCESS_WALK_DATABASE_URL="postgresql://user:sekret@host/db"',
      `ACCESS_WALK_R2_ACCOUNT_ID=${'a'.repeat(32)}`,
      'ACCESS_WALK_R2_BUCKET=access-walk-screenshots',
      'ACCESS_WALK_R2_ACCESS_KEY_ID=key',
      'ACCESS_WALK_R2_SECRET_ACCESS_KEY=secret',
    ].join('\n'),
  );
  const config = sharedConfig({ ACCESS_WALK_R2_BUCKET: 'from-environment' }, file)!;
  assert.equal(config.databaseUrl, 'postgresql://user:sekret@host/db');
  assert.equal(config.r2.bucket, 'from-environment');
});

test('Each new step reaches the shared copy, and only new steps are sent again', async () => {
  const store = freshStore();
  const remote = new FakeRemote();
  const { run, bytes } = audit(store);
  const mirror = mirrorFor(store, remote);
  await mirror.sync();
  assert.equal(remote.recordsOf(run.id).length, 1);
  assert.deepEqual(new Uint8Array(remote.files.get(`${run.id}/capture_one.png`)!.bytes), bytes);
  assert.equal(JSON.parse(remote.runsById.get(run.id)!.body).state, 'running');
  const batches = remote.recordBatches;
  await mirror.sync();
  assert.equal(remote.recordBatches, batches, 'nothing new means nothing is resent');
  store.append(run.id, 'observation', 'browser', { note: 'Tab moved to Search' });
  store.finish(run.id, 'complete');
  await mirror.sync();
  assert.equal(remote.recordsOf(run.id).length, 2);
  assert.equal(JSON.parse(remote.runsById.get(run.id)!.body).state, 'complete');
  store.close();
});

test('A lost connection never stops an audit; the copy catches up afterwards', async () => {
  const store = freshStore();
  const remote = new FakeRemote();
  remote.offline = true;
  const logs: string[] = [];
  const mirror = new SharedMirror(store, remote, {
    discard: async (id) => store.discard(id),
    log: (line) => logs.push(line),
  });
  const { run } = audit(store);
  await mirror.sync();
  await mirror.sync();
  assert.equal(logs.length, 1, 'the same problem is reported once, not every pass');
  assert.match(mirror.lastError!, /network unreachable/);
  store.append(run.id, 'observation', 'browser', { note: 'still saving locally' });
  remote.offline = false;
  await mirror.sync();
  assert.equal(remote.recordsOf(run.id).length, 2);
  assert.equal(mirror.lastError, undefined);
  store.close();
});

test('Discard removes the audit from every list but keeps its evidence for investigation', async () => {
  const store = freshStore();
  const { run, bytes } = audit(store);
  store.append(run.id, 'observation', 'browser', { note: 'Search button never took focus' });
  store.finish(run.id, 'stopped');
  store.discard(run.id);
  assert.equal(store.hasRun(run.id), false);
  assert.equal(existsSync(join(store.dir, run.id)), false);
  const kept = JSON.parse(readFileSync(join(store.keptDir(run.id), KEPT_ROWS), 'utf8'));
  assert.equal(kept.records.length, 2);
  assert.equal(JSON.parse(kept.run.body).state, 'stopped');
  assert.deepEqual(
    new Uint8Array(readFileSync(join(store.keptDir(run.id), 'capture_one.png'))),
    bytes,
  );
  store.close();
});

test('A discarded audit reaches the shared copy whole, even when discarded while offline', async () => {
  const store = freshStore();
  const remote = new FakeRemote();
  const mirror = mirrorFor(store, remote);
  const { run } = audit(store);
  await mirror.sync();
  remote.offline = true;
  store.append(run.id, 'observation', 'browser', { note: 'saved after the connection dropped' });
  store.finish(run.id, 'stopped');
  store.discard(run.id);
  await mirror.sync();
  assert.ok(existsSync(store.keptDir(run.id)), 'kept on this Mac until the copy is confirmed');
  remote.offline = false;
  await mirror.sync();
  assert.equal(remote.recordsOf(run.id).length, 2);
  assert.ok(remote.runsById.get(run.id)!.discarded_at);
  assert.ok(remote.files.has(`${run.id}/capture_one.png`));
  assert.equal(existsSync(store.keptDir(run.id)), false, 'left only in the shared copy');
  store.close();
});

test('Another copy pulls a shared audit whole, with screenshots that pass their checks', async () => {
  const owner = freshStore();
  const remote = new FakeRemote();
  const { run, bytes } = audit(owner);
  await mirrorFor(owner, remote).sync();
  const reader = freshStore();
  assert.deepEqual(await pullShared(reader, remote), {
    added: 1,
    updated: 0,
    removed: 0,
    files: 1,
  });
  assert.equal(reader.records(run.id).length, 1);
  assert.deepEqual(new Uint8Array(reader.image(run.id, 'capture_one.png')), bytes);
  // Still running on the owner's Mac: a restart here must not mark it interrupted.
  reader.recoverInterrupted();
  assert.equal(reader.run(run.id).state, 'running');
  // A read copy is never sent back over the owner's saved state.
  const writes = remote.ownedWrites;
  await mirrorFor(reader, remote).sync();
  assert.equal(remote.ownedWrites, writes);
  owner.append(run.id, 'observation', 'browser', { note: 'next step' });
  await mirrorFor(owner, remote).sync();
  assert.deepEqual(await pullShared(reader, remote), {
    added: 0,
    updated: 1,
    removed: 0,
    files: 0,
  });
  assert.equal(reader.records(run.id).length, 2);
  owner.close();
  reader.close();
});

test('Discarded audits are skipped by default and pulled only to investigate', async () => {
  const owner = freshStore();
  const remote = new FakeRemote();
  const mirror = mirrorFor(owner, remote);
  const { run } = audit(owner);
  await mirror.sync();
  const reader = freshStore();
  await pullShared(reader, remote);
  owner.finish(run.id, 'stopped');
  owner.discard(run.id);
  await mirror.sync();
  assert.equal((await pullShared(reader, remote)).removed, 1);
  assert.equal(reader.hasRun(run.id), false);
  const investigator = freshStore();
  await pullShared(investigator, remote, { includeDiscarded: true });
  assert.equal(investigator.records(run.id).length, 1);
  owner.close();
  reader.close();
  investigator.close();
});

test('Discarding a read copy removes the audit everywhere, and every copy is kept', async () => {
  const owner = freshStore();
  const remote = new FakeRemote();
  const { run } = audit(owner);
  owner.finish(run.id, 'complete');
  await mirrorFor(owner, remote).sync();
  const reader = freshStore();
  await pullShared(reader, remote);
  reader.discard(run.id);
  await mirrorFor(reader, remote).sync();
  assert.ok(remote.runsById.get(run.id)!.discarded_at);
  await mirrorFor(owner, remote).sync();
  assert.equal(owner.hasRun(run.id), false, 'the owner applies the discard too');
  await mirrorFor(owner, remote).sync();
  assert.equal(remote.recordsOf(run.id).length, 1, 'the shared copy keeps the evidence');
  assert.ok(remote.files.has(`${run.id}/capture_one.png`));
  owner.close();
  reader.close();
});

test('A shared screenshot that changed, or a file name escaping the folder, is never written', async () => {
  const owner = freshStore();
  const remote = new FakeRemote();
  const { run } = audit(owner);
  await mirrorFor(owner, remote).sync();
  const escape = new Uint8Array([1]);
  remote.files.set(`${run.id}/../../escape.png`, { bytes: escape, hash: digest(escape) });
  const reader = freshStore();
  assert.equal((await pullShared(reader, remote)).files, 1, 'only the real screenshot');
  assert.equal(existsSync(join(reader.dir, '..', 'escape.png')), false);
  const second = freshStore();
  remote.files.get(`${run.id}/capture_one.png`)!.bytes = new Uint8Array([9, 9, 9]);
  await assert.rejects(pullShared(second, remote), /did not match/);
  assert.equal(existsSync(join(second.dir, run.id, 'capture_one.png')), false);
  owner.close();
  reader.close();
  second.close();
});

test('An unchanged copy never contacts the shared database, so it can sleep', async () => {
  const store = freshStore();
  const remote = new FakeRemote();
  const { run } = audit(store);
  const mirror = mirrorFor(store, remote);
  await mirror.sync();
  const calls = remote.calls;
  await mirror.sync();
  await mirror.sync();
  assert.equal(remote.calls, calls);
  store.append(run.id, 'observation', 'browser', { note: 'one more step' });
  await mirror.sync();
  assert.ok(remote.calls > calls);
  assert.equal(remote.recordsOf(run.id).length, 2);
  store.close();
});

test('A discard that did not finish is never sent as a discard', async () => {
  const store = freshStore();
  const remote = new FakeRemote();
  const { run } = audit(store);
  const mirror = mirrorFor(store, remote);
  await mirror.sync();
  // Rows set aside, but the saving step afterwards failed: the audit still exists.
  mkdirSync(store.keptDir(run.id), { recursive: true });
  writeFileSync(
    join(store.keptDir(run.id), KEPT_ROWS),
    JSON.stringify({
      run: { body: JSON.stringify(store.run(run.id)) },
      records: [],
      requests: [],
      pulled: false,
      discardedAt: new Date().toISOString(),
    }),
  );
  await mirror.sync();
  assert.equal(remote.runsById.get(run.id)!.discarded_at, null);
  assert.equal(store.hasRun(run.id), true);
  store.close();
});

test('Stopping the engine never waits more than a moment for a stuck connection', async () => {
  const store = freshStore();
  const remote = new FakeRemote();
  remote.hang = true;
  audit(store);
  const mirror = new SharedMirror(store, remote, { discard: async () => {} }, 2000, 50);
  void mirror.sync();
  const started = Date.now();
  await mirror.close();
  assert.ok(Date.now() - started < 1000);
  store.close();
});

test('A connection error never shows the database password or the screenshot key', () => {
  const safe = redactor({
    databaseUrl: 'postgresql://walker:p%40ss-word@ep-example.eu-central-1.aws.neon.tech/neondb',
    r2: {
      accountId: 'a'.repeat(32),
      bucket: 'b-1',
      accessKeyId: 'AKID123',
      secretAccessKey: 'SK456',
    },
  });
  const text = safe(
    Error(
      'failed postgresql://walker:p%40ss-word@ep-example.eu-central-1.aws.neon.tech/neondb p@ss-word AKID123 SK456',
    ),
  ).message;
  for (const secret of ['p@ss-word', 'p%40ss-word', 'AKID123', 'SK456'])
    assert.ok(!text.includes(secret));
});
