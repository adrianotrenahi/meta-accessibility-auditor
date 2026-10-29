import { RoleAllowanceLimit } from './role-allowance.js';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { RecordEntry, RecordKind, Role, Run, RunState, Approval } from './types.js';
import { LIMITS, PHASE, FINAL_REVIEW_RESERVE_MICROS } from './types.js';
import { groupPublished } from './finding-key.js';
import { presentRecordPayload } from './presentation.js';
import { readHashMatches, suppliedImageIds, type ImageReceipt } from './image-receipt.js';
import { candidateOriginalEvidence } from './candidate-target.js';
import {
  journeyDraftBindingSchema,
  readPlanningSteps,
  type JourneyDraftBinding,
  type JourneyDraftView,
  type ModelRequestPurpose,
} from './journey-drafts.js';
import { journeyPlanSchema } from './journey-steps.js';
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
      CREATE TABLE IF NOT EXISTS host_versions(run_id TEXT PRIMARY KEY REFERENCES runs(id), hash TEXT NOT NULL, version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS journey_drafts(draft_id TEXT PRIMARY KEY,owner_hash TEXT NOT NULL,brief_hash TEXT NOT NULL,run_id TEXT UNIQUE REFERENCES runs(id) ON DELETE SET NULL,planning_request_id TEXT REFERENCES requests(id) ON DELETE SET NULL,plan_id TEXT REFERENCES records(id) ON DELETE SET NULL,plan_hash TEXT);
      CREATE TABLE IF NOT EXISTS journey_draft_discards(draft_id TEXT PRIMARY KEY REFERENCES journey_drafts(draft_id),run_id TEXT NOT NULL);`);
  }
  recoverInterrupted() {
    for (const run of this.runs())
      if (run.state === 'running' || run.state === 'planning')
        this.finish(
          run.id,
          'interrupted',
          run.state === 'planning'
            ? 'Application restarted during planning. No automatic regeneration occurred; any uncertain generation charge remains reserved.'
            : 'Application restarted; review saved evidence before starting a new run.',
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
  /** One durable claim before any awaited planning work; retries only read it. */
  claimJourneyDraft(value: JourneyDraftBinding): JourneyDraftView {
    const binding = journeyDraftBindingSchema.parse(value);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const prior = this.journeyDraft(binding);
      if (prior) {
        this.db.exec('COMMIT');
        return prior;
      }
      const run: Run = {
        id: randomUUID(),
        url: binding.url,
        goal: binding.goal,
        mode: 'live',
        state: 'planning',
        createdAt: new Date().toISOString(),
      };
      this.db.prepare('INSERT INTO runs VALUES(?,?)').run(run.id, JSON.stringify(run));
      this.db
        .prepare('INSERT INTO journey_drafts VALUES(?,?,?,?,NULL,NULL,NULL)')
        .run(binding.draftId, binding.ownerHash, binding.briefHash, run.id);
      const result = this.journeyDraft(binding)!;
      this.db.exec('COMMIT');
      return { ...result, created: true };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  /** Owner/brief identity for cleanup and an already-failed Start. This does not
   * establish that a saved proposal is valid for preparation or execution. */
  ownedJourneyDraftRun(value: JourneyDraftBinding): Run | null {
    const binding = journeyDraftBindingSchema.parse(value);
    const row = this.db
      .prepare('SELECT owner_hash,brief_hash,run_id FROM journey_drafts WHERE draft_id=?')
      .get(binding.draftId) as
      { owner_hash: string; brief_hash: string; run_id: string | null } | undefined;
    if (!row) return null;
    if (row.owner_hash !== binding.ownerHash || row.brief_hash !== binding.briefHash)
      throw Error('This draft belongs to a different owner, website or journey.');
    if (!row.run_id) throw Error('This draft was discarded. A retry cannot recreate it.');
    const run = this.run(row.run_id);
    if (run.url !== binding.url || run.goal !== binding.goal)
      throw Error('The saved draft does not match this website or journey.');
    return run;
  }
  journeyDraft(value: JourneyDraftBinding): JourneyDraftView | null {
    const binding = journeyDraftBindingSchema.parse(value);
    const row = this.db
      .prepare('SELECT * FROM journey_drafts WHERE draft_id=?')
      .get(binding.draftId) as any;
    if (!row) return null;
    if (row.owner_hash !== binding.ownerHash || row.brief_hash !== binding.briefHash)
      throw Error('This draft belongs to a different owner, website or journey.');
    if (!row.run_id) throw Error('This draft was discarded. A retry cannot recreate it.');
    const run = this.run(row.run_id);
    if (run.url !== binding.url || run.goal !== binding.goal)
      throw Error('The saved draft does not match this website or journey.');
    const plan = row.plan_id ? this.record(run.id, row.plan_id) : null;
    if (
      (row.plan_id &&
        (!plan ||
          !recordIsIntact(plan) ||
          plan.hash !== row.plan_hash ||
          plan.kind !== 'plan' ||
          plan.author !== 'driver' ||
          plan.payload.draftId !== binding.draftId ||
          plan.payload.briefHash !== binding.briefHash ||
          plan.payload.planningRequestId !== row.planning_request_id)) ||
      (run.state === 'prepared' && !plan)
    )
      throw Error('The exact saved plan is unavailable. This draft will not generate again.');
    if (plan) {
      journeyPlanSchema.parse({ steps: plan.payload.steps });
      const request = this.usage(run.id).requests.find(
        (item) =>
          item.id === row.planning_request_id &&
          item.role === 'driver' &&
          item.status === 'completed' &&
          Number.isSafeInteger(item.actual) &&
          item.actual >= 0,
      );
      const response = this.records(run.id).find(
        (record) =>
          plan.sources.includes(record.id) &&
          record.kind === 'model_response' &&
          record.author === 'driver' &&
          record.payload.requestId === row.planning_request_id &&
          record.payload.status === 'completed' &&
          recordIsIntact(record),
      );
      if (!request || !response)
        throw Error(
          'The saved plan has no exact completed planning receipt. This draft will not generate again.',
        );
      if (JSON.stringify(readPlanningSteps(response)) !== JSON.stringify(plan.payload.steps))
        throw Error('The saved instructions do not match their recorded planning response.');
    }
    return {
      created: false,
      run,
      plan: plan ?? null,
      draft: {
        draftId: row.draft_id,
        ownerHash: row.owner_hash,
        briefHash: row.brief_hash,
        runId: run.id,
        planningRequestId: row.planning_request_id,
        planId: row.plan_id,
        planHash: row.plan_hash,
      },
    };
  }
  /** An explicit retry may recover a failed count, never a sent or uncertain
   * generation. Keep the same run, failed observations and spending history. */
  retryUnsentJourneyDraft(value: JourneyDraftBinding): JourneyDraftView {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const view = this.journeyDraft(value);
      if (
        !view ||
        view.run.state !== 'interrupted' ||
        view.plan ||
        view.draft.planningRequestId ||
        this.usage(view.run.id).requests.length !== 0
      )
        throw Error('Only an interrupted draft with no generation attempt may retry preparation.');
      const run = { ...view.run, state: 'planning' as const };
      delete run.stopReason;
      this.db.prepare('UPDATE runs SET body=? WHERE id=?').run(JSON.stringify(run), run.id);
      const result = this.journeyDraft(value)!;
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  /** A confirmed local discard keeps only its exact owned retry tombstone. */
  journeyDraftDiscarded(value: JourneyDraftBinding): boolean {
    const binding = journeyDraftBindingSchema.parse(value);
    const row = this.db
      .prepare('SELECT owner_hash,brief_hash,run_id FROM journey_drafts WHERE draft_id=?')
      .get(binding.draftId) as
      { owner_hash: string; brief_hash: string; run_id: string | null } | undefined;
    if (!row) return false;
    if (row.owner_hash !== binding.ownerHash || row.brief_hash !== binding.briefHash)
      throw Error('This draft belongs to a different owner, website or journey.');
    return row.run_id === null;
  }
  /** Opaque cleanup identity only; no discarded brief or evidence is retained. */
  journeyDraftDiscardRun(value: JourneyDraftBinding): string | null {
    const binding = journeyDraftBindingSchema.parse(value);
    if (!this.journeyDraftDiscarded(binding)) return null;
    const row = this.db
      .prepare('SELECT run_id FROM journey_draft_discards WHERE draft_id=?')
      .get(binding.draftId) as { run_id: string } | undefined;
    return row?.run_id ?? null;
  }
  /** The response and its charge already exist; this cannot fabricate a paid attempt. */
  prepareJourneyDraft(
    value: JourneyDraftBinding,
    payload: Record<string, unknown>,
    sources: string[] = [],
  ): JourneyDraftView {
    const binding = journeyDraftBindingSchema.parse(value);
    const planned = journeyPlanSchema.parse({ steps: payload.steps });
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const view = this.journeyDraft(binding);
      if (!view || !['planning', 'prepared'].includes(view.run.state))
        throw Error('This draft is not available for preparation.');
      const request = this.usage(view.run.id).requests.find(
        (item) =>
          item.id === view.draft.planningRequestId &&
          item.role === 'driver' &&
          item.status === 'completed' &&
          Number.isSafeInteger(item.actual) &&
          item.actual >= 0,
      );
      const response =
        request &&
        this.records(view.run.id).find(
          (record) =>
            record.kind === 'model_response' &&
            record.author === 'driver' &&
            record.payload.requestId === request.id &&
            record.payload.status === 'completed' &&
            recordIsIntact(record),
        );
      if (!request || !response)
        throw Error('A completed, recorded planning response and its charge are required.');
      if (JSON.stringify(readPlanningSteps(response)) !== JSON.stringify(planned.steps))
        throw Error('The prepared instructions must match the recorded planning response.');
      const body = {
        ...payload,
        steps: planned.steps,
        draftId: binding.draftId,
        briefHash: binding.briefHash,
        planningRequestId: request.id,
      };
      const links = [...new Set([response.id, ...sources])];
      if (view.plan) {
        const { _sourcesHash: _sources, ...original } = view.plan.payload;
        if (
          JSON.stringify(body) !== JSON.stringify(original) ||
          JSON.stringify(links) !== JSON.stringify(view.plan.sources)
        )
          throw Error('The prepared plan cannot be replaced by a different result.');
        this.db.exec('COMMIT');
        return view;
      }
      const plan = this.append(view.run.id, 'plan', 'driver', body, links);
      this.db
        .prepare('UPDATE journey_drafts SET plan_id=?,plan_hash=? WHERE draft_id=?')
        .run(plan.id, plan.hash, binding.draftId);
      this.db
        .prepare('UPDATE runs SET body=? WHERE id=?')
        .run(JSON.stringify({ ...view.run, state: 'prepared' }), view.run.id);
      const result = this.journeyDraft(binding)!;
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  /** Start consumes the saved preparation, never a new run or spending ledger. */
  activateJourneyDraft(
    value: JourneyDraftBinding,
    options: {
      requestId: string;
      planId: string;
      planHash: string;
      approval: Approval;
    },
  ): JourneyDraftView & { activated: boolean } {
    const binding = journeyDraftBindingSchema.parse(value);
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(options.requestId))
      throw Error('A saved Start request identity is required.');
    const requestId = options.requestId.toLowerCase();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const view = this.journeyDraft(binding);
      if (
        !view ||
        !view.plan ||
        options.planId !== view.plan.id ||
        options.planHash !== view.plan.hash
      )
        throw Error('Start must name the exact prepared plan.');
      if (this.hostStartDiscarded(requestId)) throw Error('This Start was discarded.');
      const prior = this.hostStart(requestId);
      if (prior) {
        if (prior !== view.run.id) throw Error('This Start belongs to a different run.');
        this.db.exec('COMMIT');
        return { ...view, activated: false };
      }
      if (view.run.state !== 'prepared') throw Error('This draft is not waiting for Start.');
      this.assertApproval(options.approval);
      const total = this.usage(),
        runUsage = this.usage(view.run.id);
      if (total.requests.some((request) => request.status === 'sending'))
        throw Error('An active paid request must finish before this preparation can start.');
      if (
        total.spent + total.reserved >=
          Math.min(LIMITS.routineMicros, Math.floor(options.approval.maxUsd * 1e6)) ||
        runUsage.spent + runUsage.reserved >=
          Math.min(LIMITS.runMicros, Math.floor(options.approval.maxRunUsd * 1e6))
      )
        throw Error('The remaining spending allowance is exhausted.');
      this.db.prepare('INSERT INTO host_starts VALUES(?,?)').run(requestId, view.run.id);
      this.db.prepare('UPDATE runs SET body=? WHERE id=?').run(
        JSON.stringify({
          ...view.run,
          state: 'running',
          startedAt: new Date().toISOString(),
        }),
        view.run.id,
      );
      const result = this.journeyDraft(binding)!;
      this.db.exec('COMMIT');
      return { ...result, activated: true };
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
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (['running', 'planning'].includes(this.run(id).state))
        throw Error('Stop the run or planning before discarding evidence.');
      if (this.usage(id).requests.some((request) => request.status === 'sending'))
        throw Error('Wait for the active paid request to settle before discarding evidence.');
      this.db.prepare('INSERT OR IGNORE INTO discard_cleanup VALUES(?)').run(id);
      this.db
        .prepare(
          'INSERT OR IGNORE INTO journey_draft_discards SELECT draft_id,run_id FROM journey_drafts WHERE run_id=?',
        )
        .run(id);
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
      this.db.prepare('UPDATE journey_drafts SET plan_hash=NULL WHERE run_id=?').run(id);
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
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM host_starts WHERE run_id=?').run(id);
      this.db.prepare('DELETE FROM journey_draft_discards WHERE run_id=?').run(id);
      this.db.prepare('DELETE FROM discard_cleanup WHERE run_id=?').run(id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  finish(id: string, state: RunState, reason?: string) {
    const r = this.run(id);
    if (
      state === 'planning' ||
      state === 'prepared' ||
      state === 'running' ||
      (state === 'complete' && ['planning', 'prepared'].includes(r.state))
    )
      throw Error('Planning must use its saved preparation and Start transitions.');
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
    if (typeof id !== 'string' || !id) return undefined;
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
  snapshot(runId: string, role: Role, ids?: string[], imageReceipt?: ImageReceipt) {
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
      ...(imageReceipt ? { imageReceipt } : {}),
    });
    return { read, records: selected };
  }
  published(runId: string) {
    const records = this.records(runId),
      out: any[] = [];
    const originalsWereRead = (read: RecordEntry, originals: RecordEntry[]) =>
      Array.isArray(read.payload.records) &&
      originals
        .filter((original) => original.kind !== 'visual_observation')
        .every(
          (original) =>
            original.seq < read.seq &&
            read.payload.records.some(
              (pin: any) =>
                pin.id === original.id &&
                pin.hash === original.hash &&
                Array.isArray(pin.sources) &&
                JSON.stringify(pin.sources) === JSON.stringify(original.sources),
            ),
        );
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
      if (
        candidate.payload.issueKey &&
        (review.payload.premise !== 'supported' || review.payload.title !== candidate.payload.title)
      )
        continue;
      const read = this.record(runId, review.payload.readSnapshotId);
      if (
        !read ||
        read.kind !== 'read_snapshot' ||
        read.author !== 'reviewer' ||
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
      try {
        if (!readHashMatches(read, review.payload.readSnapshotHash)) continue;
        const reviewerImages = suppliedImageIds(read, records);
        const visual = records.find((r) => r.id === candidate.payload.visualObservationId);
        const analystReadId =
          candidate.payload.analystReadSnapshotId ?? visual?.payload.readSnapshotId;
        const analystRead = analystReadId && records.find((r) => r.id === analystReadId);
        if (analystReadId && (!analystRead || analystRead.author !== 'analyst')) continue;
        if (
          analystRead &&
          !readHashMatches(
            analystRead,
            candidate.payload.analystReadSnapshotHash ?? visual?.payload.readSnapshotHash,
          )
        )
          continue;
        const analystImages = analystRead ? suppliedImageIds(analystRead, records) : undefined;
        const evidence = candidateOriginalEvidence(
          { ...candidate.payload, sources: candidate.sources },
          records,
          analystImages ?? reviewerImages,
        );
        if (
          candidate.payload.analystReadSnapshotId &&
          (!analystRead || !originalsWereRead(analystRead, evidence))
        )
          continue;
        if (
          candidate.payload.visualObservationId &&
          (!visual || !evidence.some((record) => record.id === visual.id))
        )
          continue;
        const visualSourcesRead = evidence
          .filter((record) => record.kind === 'visual_observation')
          .every((observation) => {
            const visualRead = records.find(
              (record) => record.id === observation.payload.readSnapshotId,
            );
            if (
              !visualRead ||
              visualRead.author !== 'analyst' ||
              !readHashMatches(visualRead, observation.payload.readSnapshotHash)
            )
              return false;
            const visualImages = suppliedImageIds(visualRead, records);
            const dependencies = candidateOriginalEvidence(
              { ...candidate.payload, sources: observation.sources },
              records,
              visualImages,
            );
            return (
              visualImages.includes(observation.payload.captureId) &&
              originalsWereRead(visualRead, dependencies) &&
              dependencies
                .filter((record) => record.kind === 'capture')
                .every((capture) => visualImages.includes(capture.id))
            );
          });
        if (!visualSourcesRead) continue;
        const targets = [candidate.payload.targetCaptureId, visual?.payload.captureId].filter(
          Boolean,
        );
        if (
          targets.some(
            (id) => !reviewerImages.includes(id) || (analystImages && !analystImages.includes(id)),
          )
        )
          continue;
      } catch {
        continue;
      }
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
  private assertApproval(approval: Approval) {
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
  }
  reserve(
    runId: string,
    role: Role,
    micros: number,
    approval: Approval,
    final = false,
    purpose: ModelRequestPurpose = 'execution',
  ) {
    if (!Number.isSafeInteger(micros) || micros <= 0)
      throw Error('Request charge cannot be bounded.');
    this.assertApproval(approval);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const state = this.run(runId).state;
      const draft = this.db
        .prepare('SELECT * FROM journey_drafts WHERE run_id=?')
        .get(runId) as any;
      if (purpose === 'planning') {
        if (role !== 'driver' || state !== 'planning' || !draft || draft.planning_request_id)
          throw Error('This draft cannot send another planning generation.');
      } else if (purpose !== 'execution' || state !== 'running') throw Error('Run is stopped.');
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
      if (phase.length >= LIMITS[role])
        throw new RoleAllowanceLimit(role, 'Request count limit reached.');
      const charged = (r: any) => r.actual ?? r.reserved;
      const used = phase.reduce((n, r) => n + charged(r), 0);
      if (
        used + micros + (role === 'reviewer' && !final ? FINAL_REVIEW_RESERVE_MICROS : 0) >
        PHASE[role]
      )
        throw new RoleAllowanceLimit(role, 'Phase spending limit reached.');
      if (role === 'reviewer' && !final && phase.length >= 3)
        throw new RoleAllowanceLimit(role, 'Final review slot is reserved.');
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
      if (purpose === 'planning')
        this.db
          .prepare('UPDATE journey_drafts SET planning_request_id=? WHERE run_id=?')
          .run(id, runId);
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
