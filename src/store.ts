import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { RecordEntry, RecordKind, Role, Run, RunState, Approval } from './types.js';
import { LIMITS, PHASE, CAPS } from './types.js';
import { groupPublished } from './finding-key.js';
import { presentRecordPayload } from './presentation.js';
export const digest = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('hex');
export const recordIsIntact = (record: RecordEntry) =>
  !!record.payload &&
  typeof record.payload === 'object' &&
  !Array.isArray(record.payload) &&
  digest(JSON.stringify(record.payload)) === record.hash &&
  (record.payload._sourcesHash === undefined ||
    record.payload._sourcesHash === digest(JSON.stringify(record.sources)));
export class Store {
  db: DatabaseSync;
  constructor(public dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(dir, 'runs.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS records(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,run_id TEXT NOT NULL REFERENCES runs(id),kind TEXT NOT NULL,author TEXT NOT NULL,body TEXT NOT NULL,sources TEXT NOT NULL,hash TEXT NOT NULL,created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id),role TEXT NOT NULL,reserved INTEGER NOT NULL,actual INTEGER,status TEXT NOT NULL,created TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS records_run ON records(run_id,seq);
      CREATE TABLE IF NOT EXISTS host_starts(request_id TEXT PRIMARY KEY,run_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS host_discarded_starts(request_id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS discard_cleanup(run_id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS discarded_usage(id TEXT PRIMARY KEY,role TEXT NOT NULL,reserved INTEGER NOT NULL,actual INTEGER,status TEXT NOT NULL,created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS host_versions(run_id TEXT PRIMARY KEY REFERENCES runs(id), hash TEXT NOT NULL, version INTEGER NOT NULL);`);
  }
  recoverInterrupted() {
    for (const run of this.runs())
      if (run.state === 'running')
        this.finish(
          run.id,
          'interrupted',
          'Application restarted; review saved evidence before starting a new run.',
        );
    this.db.prepare("UPDATE requests SET status='unknown' WHERE status='sending'").run();
  }
  close() {
    this.db.close();
  }
  create(goal: string, url: string, mode: Run['mode'], requestId?: string): Run {
    requestId = requestId?.toLowerCase();
    const run: Run = {
      id: randomUUID(),
      goal,
      url,
      mode,
      state: 'running',
      createdAt: new Date().toISOString(),
    };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (requestId && this.hostStartDiscarded(requestId))
        throw Error('This start was discarded. A retry cannot recreate it.');
      this.db.prepare('INSERT INTO runs VALUES(?,?)').run(run.id, JSON.stringify(run));
      if (requestId) this.db.prepare('INSERT INTO host_starts VALUES(?,?)').run(requestId, run.id);
      this.db.exec('COMMIT');
      return run;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  run(id: string): Run {
    const row = this.db.prepare('SELECT body FROM runs WHERE id=?').get(id) as any;
    if (!row) throw Error('Run not found.');
    return JSON.parse(row.body);
  }
  runs(): Run[] {
    return (this.db.prepare('SELECT body FROM runs ORDER BY rowid DESC').all() as any[]).map((r) =>
      JSON.parse(r.body),
    );
  }
  hostStart(requestId: string): string | null {
    const row = this.db
      .prepare('SELECT run_id FROM host_starts WHERE request_id=?')
      .get(requestId.toLowerCase()) as { run_id: string } | undefined;
    return row?.run_id ?? null;
  }
  hasRun(id: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM runs WHERE id=?').get(id);
  }
  hostStartDiscarded(requestId: string): boolean {
    return !!this.db
      .prepare('SELECT 1 FROM host_discarded_starts WHERE request_id=?')
      .get(requestId.toLowerCase());
  }
  discardHostStart(requestId: string) {
    this.db
      .prepare('INSERT OR IGNORE INTO host_discarded_starts VALUES(?)')
      .run(requestId.toLowerCase());
    return this.hostStart(requestId);
  }
  discardPending(id: string) {
    return !!this.db.prepare('SELECT 1 FROM discard_cleanup WHERE run_id=?').get(id);
  }
  /** Called only after the runner has stopped all writes for this run. */
  discard(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw Error('Invalid run identity.');
    if (!this.hasRun(id)) {
      if (this.discardPending(id)) this.cleanupDiscard(id);
      return;
    }
    if (this.run(id).state === 'running') throw Error('Stop the run before discarding evidence.');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT OR IGNORE INTO discard_cleanup VALUES(?)').run(id);
      this.db
        .prepare(
          'INSERT OR IGNORE INTO host_discarded_starts SELECT request_id FROM host_starts WHERE run_id=?',
        )
        .run(id);
      this.db
        .prepare(
          'INSERT OR IGNORE INTO discarded_usage SELECT id,role,reserved,actual,status,created FROM requests WHERE run_id=?',
        )
        .run(id);
      this.db.prepare('DELETE FROM requests WHERE run_id=?').run(id);
      this.db.prepare('DELETE FROM host_versions WHERE run_id=?').run(id);
      this.db.prepare('DELETE FROM records WHERE run_id=?').run(id);
      this.db.prepare('DELETE FROM runs WHERE id=?').run(id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    this.cleanupDiscard(id);
  }
  private cleanupDiscard(id: string) {
    rmSync(join(this.dir, id), { recursive: true, force: true });
    this.db.prepare('DELETE FROM host_starts WHERE run_id=?').run(id);
    this.db.prepare('DELETE FROM discard_cleanup WHERE run_id=?').run(id);
  }
  finish(id: string, state: RunState, reason?: string) {
    const r = this.run(id);
    r.state = state;
    r.stopReason = reason;
    this.db.prepare('UPDATE runs SET body=? WHERE id=?').run(JSON.stringify(r), id);
  }
  /** Durable delivery revision covers state/cost changes as well as evidence. */
  hostRevision(runId: string, hash: string): number {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.run(runId);
      const previous = this.db
        .prepare('SELECT hash,version FROM host_versions WHERE run_id=?')
        .get(runId) as { hash: string; version: number } | undefined;
      const version = previous?.hash === hash ? previous.version : (previous?.version ?? 0) + 1;
      this.db
        .prepare(
          'INSERT INTO host_versions VALUES(?,?,?) ON CONFLICT(run_id) DO UPDATE SET hash=excluded.hash,version=excluded.version',
        )
        .run(runId, hash, version);
      this.db.exec('COMMIT');
      return version;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  append(
    runId: string,
    kind: RecordKind,
    author: string,
    payload: any,
    sources: string[] = [],
  ): RecordEntry {
    this.run(runId);
    for (const id of sources)
      if (!this.record(runId, id)) throw Error('Evidence link does not belong to this run.');
    // Bind new originals to their source links, without rewriting earlier retained records.
    payload = { ...payload, _sourcesHash: digest(JSON.stringify(sources)) };
    const id = randomUUID(),
      body = JSON.stringify(payload),
      hash = digest(body),
      createdAt = new Date().toISOString();
    const result = this.db
      .prepare(
        'INSERT INTO records(id,run_id,kind,author,body,sources,hash,created) VALUES(?,?,?,?,?,?,?,?)',
      )
      .run(id, runId, kind, author, body, JSON.stringify(sources), hash, createdAt);
    return {
      id,
      runId,
      seq: Number(result.lastInsertRowid),
      kind,
      author,
      payload,
      sources,
      hash,
      createdAt,
    };
  }
  records(runId: string, after = 0): RecordEntry[] {
    return (
      this.db
        .prepare('SELECT * FROM records WHERE run_id=? AND seq>? ORDER BY seq')
        .all(runId, after) as any[]
    ).map((r) => ({
      id: r.id,
      runId: r.run_id,
      seq: r.seq,
      kind: r.kind,
      author: r.author,
      payload: JSON.parse(r.body),
      sources: JSON.parse(r.sources),
      hash: r.hash,
      createdAt: r.created,
    }));
  }
  record(runId: string, id: string): RecordEntry | undefined {
    const r = this.db
      .prepare('SELECT * FROM records WHERE run_id=? AND id=?')
      .get(runId, id) as any;
    if (!r) return undefined;
    return {
      id: r.id,
      runId: r.run_id,
      seq: r.seq,
      kind: r.kind,
      author: r.author,
      payload: JSON.parse(r.body),
      sources: JSON.parse(r.sources),
      hash: r.hash,
      createdAt: r.created,
    };
  }
  snapshot(runId: string, role: Role, ids?: string[]) {
    const records = this.records(runId).filter(
      (r) =>
        !['read_snapshot', 'model_response'].includes(r.kind) &&
        r.kind !== 'visual_coverage' &&
        !(r.kind === 'coverage' && ['analyst', 'reviewer'].includes(r.author)),
    );
    const wanted = new Set(ids ?? records.map((r) => r.id));
    // The walk and navigator notes are always original records, not another role's digest.
    for (const r of records)
      if (['plan', 'action', 'navigator_note', 'at_check', 'coverage', 'limit'].includes(r.kind))
        wanted.add(r.id);
    const selected = records.filter((r) => wanted.has(r.id));
    const missing = [...wanted].filter((id) => !selected.some((r) => r.id === id));
    if (missing.length) throw Error('Required original evidence is missing.');
    const read = this.append(runId, 'read_snapshot', role, {
      throughSeq: records.at(-1)?.seq ?? 0,
      records: selected.map((r) => ({ id: r.id, hash: r.hash, sources: r.sources })),
      missing,
    });
    return { read, records: selected };
  }
  published(runId: string) {
    const records = this.records(runId),
      out: any[] = [];
    for (const candidate of records.filter((r) => r.kind === 'candidate')) {
      const review = records
        .filter((r) => r.kind === 'review' && r.payload.candidateId === candidate.id)
        .at(-1);
      if (
        !review ||
        review.payload.verdict !== 'keep' ||
        review.payload.candidateHash !== candidate.hash
      )
        continue;
      if (candidate.payload.issueKey && review.payload.premise !== 'supported') continue;
      const read = this.record(runId, review.payload.readSnapshotId);
      if (
        !read ||
        read.kind !== 'read_snapshot' ||
        !Array.isArray(read.payload?.records) ||
        !read.payload.records.some((r: any) => r.id === candidate.id && r.hash === candidate.hash)
      )
        continue;
      if ([candidate, review, read].some((r) => !recordIsIntact(r))) continue;
      if (
        read.payload.records.some((entry: any) => {
          const original = this.record(runId, entry.id);
          return (
            !original ||
            original.hash !== entry.hash ||
            !recordIsIntact(original) ||
            !Array.isArray(entry.sources) ||
            JSON.stringify(entry.sources) !== JSON.stringify(original.sources)
          );
        })
      )
        continue;
      if (!candidate.sources.length || !review.sources.length) continue;
      const pending = [candidate.id, ...candidate.sources, ...review.sources];
      const checked = new Set<string>();
      let originalsSupported = true;
      while (pending.length && originalsSupported) {
        const id = pending.pop()!;
        if (id === read.id || checked.has(id)) continue;
        checked.add(id);
        const original = this.record(runId, id);
        const pin = read.payload.records.find((entry: any) => entry.id === id);
        if (
          !original ||
          !pin ||
          original.payload.stable === false ||
          !recordIsIntact(original) ||
          original.hash !== pin.hash ||
          JSON.stringify(original.sources) !== JSON.stringify(pin.sources)
        ) {
          originalsSupported = false;
          break;
        }
        pending.push(...original.sources);
      }
      if (!originalsSupported) continue;
      if (
        !review.sources.some((id) => {
          const source = this.record(runId, id);
          return source && ['action', 'capture', 'observation', 'at_check'].includes(source.kind);
        })
      )
        continue;
      // New evidence requires a fresh review. Conservative Day 1 rule avoids stale live claims.
      const latestEvidence =
        records
          .filter((r) =>
            ['action', 'capture', 'at_check', 'observation', 'navigator_note'].includes(r.kind),
          )
          .at(-1)?.seq ?? 0;
      if (read.payload.throughSeq < latestEvidence) continue;
      out.push({
        ...presentRecordPayload(candidate.payload),
        id: candidate.id,
        title: review.payload.title || candidate.payload.title,
        review: presentRecordPayload(review.payload),
        reviewProvenance:
          review.payload.provenance === 'saved-example' || review.author.startsWith('saved_')
            ? 'saved-example'
            : 'model',
        evidence: candidate.sources,
      });
    }
    return groupPublished(out, records);
  }
  publicationLimits(runId: string): string[] {
    const records = this.records(runId);
    const historical = records
      .filter((r) => r.kind === 'candidate')
      .some((candidate) => {
        const review = records.findLast(
          (r) => r.kind === 'review' && r.payload.candidateId === candidate.id,
        );
        if (review?.payload.verdict !== 'keep') return false;
        const read = records.find(
          (r) => r.id === review.payload.readSnapshotId && r.kind === 'read_snapshot',
        );
        return (
          !Array.isArray(read?.payload?.records) ||
          read.payload.records.some((r: any) => !Array.isArray(r.sources))
        );
      });
    return historical
      ? [
          'Some saved reviews, including older formats, cannot verify which original evidence links they checked. Their findings are unverified and withheld; original screens and records remain available.',
        ]
      : [];
  }
  usage(runId?: string) {
    const rows = this.db
      .prepare(
        runId
          ? 'SELECT * FROM requests WHERE run_id=?'
          : 'SELECT * FROM requests UNION ALL SELECT id,NULL AS run_id,role,reserved,actual,status,created FROM discarded_usage',
      )
      .all(...(runId ? [runId] : [])) as any[];
    return {
      spent: rows.reduce((n, r) => n + (r.actual ?? 0), 0),
      reserved: rows.reduce((n, r) => n + (r.actual === null ? r.reserved : 0), 0),
      requests: rows,
    };
  }
  reserve(runId: string, role: Role, micros: number, approval: Approval, final = false) {
    if (!Number.isSafeInteger(micros) || micros <= 0)
      throw Error('Request charge cannot be bounded.');
    if (
      approval.approvedBy !== 'Adriano' ||
      !Number.isFinite(Date.parse(approval.expiresAt)) ||
      Date.parse(approval.expiresAt) <= Date.now() ||
      !Number.isFinite(approval.maxUsd) ||
      approval.maxUsd <= 0 ||
      approval.maxUsd > 110 ||
      !Number.isFinite(approval.maxRunUsd) ||
      approval.maxRunUsd > 3 ||
      approval.maxRunUsd <= 0
    )
      throw Error('A valid, bounded owner spending approval is required.');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.run(runId).state !== 'running') throw Error('Run is stopped.');
      const total = this.usage(),
        run = this.usage(runId),
        phase = run.requests.filter((r) => r.role === role);
      if (total.requests.some((r) => r.status === 'sending'))
        throw Error('Another paid request is in progress.');
      if (
        total.spent + total.reserved + micros >
        Math.min(LIMITS.routineMicros, Math.floor(approval.maxUsd * 1e6))
      )
        throw Error('Approved project spending limit reached.');
      if (
        run.spent + run.reserved + micros >
        Math.min(LIMITS.runMicros, Math.floor(approval.maxRunUsd * 1e6))
      )
        throw Error('Run spending limit reached.');
      if (phase.length >= LIMITS[role]) throw Error('Request count limit reached.');
      const charged = (r: any) => r.actual ?? r.reserved;
      const used = phase.reduce((n, r) => n + charged(r), 0);
      const finalReserve = Math.ceil(CAPS.reviewer.input * 1.25 + CAPS.reviewer.output * 4.25);
      if (used + micros + (role === 'reviewer' && !final ? finalReserve : 0) > PHASE[role])
        throw Error('Phase spending limit reached.');
      if (role === 'reviewer' && !final && phase.length >= 3)
        throw Error('Final review slot is reserved.');
      const protectedPhases = (Object.keys(PHASE) as Role[])
        .filter((p) => p !== role)
        .reduce(
          (n, p) =>
            n +
            Math.max(
              0,
              PHASE[p] -
                run.requests.filter((r) => r.role === p).reduce((s, r) => s + charged(r), 0),
            ),
          0,
        );
      if (run.spent + run.reserved + micros + protectedPhases > LIMITS.runMicros)
        throw Error('Other run phases are protected.');
      const id = randomUUID();
      this.db
        .prepare('INSERT INTO requests VALUES(?,?,?,?,?,?,?)')
        .run(id, runId, role, micros, null, 'sending', new Date().toISOString());
      this.db.exec('COMMIT');
      return id;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  settle(id: string, actual: number | null, status: string) {
    if (actual !== null && (!Number.isSafeInteger(actual) || actual < 0))
      throw Error('Invalid reported usage.');
    const updated = this.db
      .prepare('UPDATE requests SET actual=?,status=? WHERE id=?')
      .run(actual, status, id);
    if (!updated.changes)
      this.db
        .prepare('UPDATE discarded_usage SET actual=?,status=? WHERE id=?')
        .run(actual, status, id);
  }
  asset(runId: string, name: string, bytes: Uint8Array) {
    if (!/^[a-zA-Z0-9_-]+\.(png|json)$/.test(name)) throw Error('Invalid asset name.');
    const dir = join(this.dir, runId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, name);
    writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
    return { file: name, hash: digest(bytes) };
  }
  image(runId: string, name: string) {
    this.run(runId);
    if (!/^[a-zA-Z0-9_-]+\.png$/.test(name)) throw Error('Invalid image.');
    const original = this.records(runId).find(
      (r) => r.kind === 'capture' && r.payload.imageFile === name,
    );
    if (!original) throw Error('The original capture record is missing.');
    const bytes = readFileSync(join(this.dir, runId, name));
    if (digest(bytes) !== original.payload.imageHash)
      throw Error('The original image has changed; its evidence cannot be used.');
    return bytes;
  }
}
