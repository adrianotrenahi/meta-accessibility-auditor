import { neon } from '@neondatabase/serverless';
import { AwsClient } from 'aws4fetch';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { root } from './config.js';
import { digest, KEPT_ROWS, type Store } from './store.js';

/** Audits stay saved locally first. A shared copy is optional and never required to run. */
export type SharedConfig = {
  databaseUrl: string;
  r2: { accountId: string; bucket: string; accessKeyId: string; secretAccessKey: string };
};
const NAMES = {
  databaseUrl: 'ACCESS_WALK_DATABASE_URL',
  accountId: 'ACCESS_WALK_R2_ACCOUNT_ID',
  bucket: 'ACCESS_WALK_R2_BUCKET',
  accessKeyId: 'ACCESS_WALK_R2_ACCESS_KEY_ID',
  secretAccessKey: 'ACCESS_WALK_R2_SECRET_ACCESS_KEY',
} as const;
export const defaultSharedFile = () => join(homedir(), '.access-walk', 'storage.env');
const readSettings = (file: string) => {
  const saved: Record<string, string> = {};
  if (existsSync(file))
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (match) saved[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
    }
  return saved;
};

/** Reads the working folder's .env, beside the other keys, when it holds any storage
 * setting; otherwise one file outside every working copy. Git ignores both. One file
 * is never mixed with the other, so a half-filled .env is reported, not patched. */
export function sharedConfig(
  env: Record<string, string | undefined> = process.env,
  file = env.ACCESS_WALK_STORAGE_FILE || defaultSharedFile(),
  dotenv = resolve(root, '.env'),
): SharedConfig | null {
  const local = readSettings(dotenv);
  const fromDotenv = Object.values(NAMES).some((name) => local[name]);
  const saved = fromDotenv ? local : readSettings(file);
  const source = fromDotenv ? dotenv : file;
  const value = (name: string) => env[name] || saved[name] || '';
  const found = Object.fromEntries(
    Object.entries(NAMES).map(([field, name]) => [field, value(name)]),
  ) as Record<keyof typeof NAMES, string>;
  const missing = Object.entries(NAMES)
    .filter(([field]) => !found[field as keyof typeof NAMES])
    .map(([, name]) => name);
  if (missing.length === Object.keys(NAMES).length) return null;
  if (missing.length)
    throw Error(`Shared storage is half set up. Missing: ${missing.join(', ')} (in ${source}).`);
  if (!/^postgres(ql)?:\/\//.test(found.databaseUrl))
    throw Error(`${NAMES.databaseUrl} must be a Postgres connection address.`);
  if (!/^[a-f0-9]{32}$/.test(found.accountId))
    throw Error(`${NAMES.accountId} must be the 32-character Cloudflare account id.`);
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(found.bucket))
    throw Error(`${NAMES.bucket} must be an R2 bucket name.`);
  return {
    databaseUrl: found.databaseUrl,
    r2: {
      accountId: found.accountId,
      bucket: found.bucket,
      accessKeyId: found.accessKeyId,
      secretAccessKey: found.secretAccessKey,
    },
  };
}

export type SharedRecord = {
  id: string;
  run_id: string;
  seq: number;
  kind: string;
  author: string;
  body: string;
  sources: string;
  hash: string;
  created: string;
};
export type SharedRequest = {
  id: string;
  role: string;
  reserved: number;
  actual: number | null;
  status: string;
  created: string;
};
export type SharedRun = { id: string; body: string; discarded_at: string | null };

/** The shared database (text) and the bucket (screenshots), behind one small surface. */
export interface SharedRemote {
  prepare(): Promise<void>;
  putRun(id: string, body: string, owned: boolean): Promise<void>;
  markDiscarded(id: string, at: string): Promise<void>;
  discarded(ids: string[]): Promise<Set<string>>;
  putRecords(rows: SharedRecord[]): Promise<void>;
  putRequests(runId: string, rows: SharedRequest[]): Promise<void>;
  putObject(runId: string, name: string, bytes: Uint8Array): Promise<void>;
  runs(): Promise<SharedRun[]>;
  records(runId: string, after: number): Promise<SharedRecord[]>;
  requests(runId: string): Promise<SharedRequest[]>;
  objects(runId: string): Promise<{ name: string; hash: string }[]>;
  object(runId: string, name: string): Promise<Uint8Array>;
}

const RUN_ID = /^[a-f0-9-]{36}$/;
/** Marks a kept copy already in the shared copy; like KEPT_ROWS, no screenshot can use it. */
export const KEPT_SENT = 'sent.discarded.json';
const OBJECT_NAME = /^[a-zA-Z0-9_-]+\.(png|json)$/;
const objectKey = (runId: string, name: string) => {
  if (!RUN_ID.test(runId) || !OBJECT_NAME.test(name)) throw Error('Invalid shared file name.');
  return `runs/${runId}/${name}`;
};

/** An error never carries a password or key into the engine's log. */
export function redactor(config: SharedConfig) {
  const secrets = [config.databaseUrl, config.r2.secretAccessKey, config.r2.accessKeyId];
  try {
    const password = decodeURIComponent(new URL(config.databaseUrl).password);
    if (password) secrets.push(password);
  } catch {
    // An address that does not parse is still redacted whole.
  }
  return (error: unknown) => {
    let text = error instanceof Error ? error.message : 'The shared copy could not be reached.';
    for (const secret of secrets.filter(Boolean)) text = text.split(secret).join('[redacted]');
    return Error(text.slice(0, 300));
  };
}

export function sharedRemote(config: SharedConfig): SharedRemote {
  const sql = neon(config.databaseUrl);
  const safe = redactor(config);
  const q = async (text: string, params: unknown[] = []) => {
    try {
      return (await sql.query(text, params)) as any[];
    } catch (error) {
      throw safe(error);
    }
  };
  const r2 = new AwsClient({
    accessKeyId: config.r2.accessKeyId,
    secretAccessKey: config.r2.secretAccessKey,
    service: 's3',
    region: 'auto',
  });
  const base = `https://${config.r2.accountId}.r2.cloudflarestorage.com/${config.r2.bucket}`;
  const send = async (key: string, init: RequestInit) => {
    const response = await r2.fetch(`${base}/${key}`, init).catch((error) => {
      throw safe(error);
    });
    if (!response.ok) {
      // R2's short error code (for example AccessDenied) helps setup and holds no secret.
      const code = (await response.text().catch(() => '')).match(/<Code>([A-Za-z]{1,64})<\/Code>/);
      throw Error(
        `The screenshot store answered ${response.status}${code ? ` (${code[1]})` : ''}.`,
      );
    }
    return response;
  };
  return {
    async prepare() {
      for (const statement of [
        'CREATE TABLE IF NOT EXISTS aw_runs(id text PRIMARY KEY, body text NOT NULL, discarded_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now())',
        'CREATE TABLE IF NOT EXISTS aw_records(id text PRIMARY KEY, run_id text NOT NULL, seq bigint NOT NULL, kind text NOT NULL, author text NOT NULL, body text NOT NULL, sources text NOT NULL, hash text NOT NULL, created text NOT NULL)',
        'CREATE INDEX IF NOT EXISTS aw_records_run ON aw_records(run_id, seq)',
        'CREATE TABLE IF NOT EXISTS aw_requests(id text PRIMARY KEY, run_id text NOT NULL, role text NOT NULL, reserved bigint NOT NULL, actual bigint, status text NOT NULL, created text NOT NULL)',
        'CREATE TABLE IF NOT EXISTS aw_objects(run_id text NOT NULL, name text NOT NULL, hash text NOT NULL, PRIMARY KEY(run_id, name))',
      ])
        await q(statement);
    },
    async putRun(id, body, owned) {
      // Only the copy that owns an audit may change its saved state.
      await q(
        owned
          ? 'INSERT INTO aw_runs(id, body) VALUES($1, $2) ON CONFLICT(id) DO UPDATE SET body = excluded.body, updated_at = now()'
          : 'INSERT INTO aw_runs(id, body) VALUES($1, $2) ON CONFLICT(id) DO NOTHING',
        [id, body],
      );
    },
    async markDiscarded(id, at) {
      await q(
        'UPDATE aw_runs SET discarded_at = COALESCE(discarded_at, $2::timestamptz), updated_at = now() WHERE id = $1',
        [id, at],
      );
    },
    async discarded(ids) {
      if (!ids.length) return new Set();
      const rows = await q(
        'SELECT id FROM aw_runs WHERE id = ANY($1::text[]) AND discarded_at IS NOT NULL',
        [ids],
      );
      return new Set(rows.map((row) => row.id));
    },
    async putRecords(rows) {
      if (!rows.length) return;
      const column = (name: keyof SharedRecord) => rows.map((row) => row[name]);
      await q(
        'INSERT INTO aw_records SELECT * FROM unnest($1::text[], $2::text[], $3::bigint[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[]) ON CONFLICT(id) DO NOTHING',
        (
          ['id', 'run_id', 'seq', 'kind', 'author', 'body', 'sources', 'hash', 'created'] as const
        ).map(column),
      );
    },
    async putRequests(runId, rows) {
      for (const row of rows)
        await q(
          'INSERT INTO aw_requests VALUES($1, $2, $3, $4, $5, $6, $7) ON CONFLICT(id) DO UPDATE SET actual = excluded.actual, status = excluded.status',
          [row.id, runId, row.role, row.reserved, row.actual, row.status, row.created],
        );
    },
    async putObject(runId, name, bytes) {
      await send(objectKey(runId, name), {
        method: 'PUT',
        body: new Blob([new Uint8Array(bytes)]),
        headers: { 'content-type': name.endsWith('.png') ? 'image/png' : 'application/json' },
      });
      await q('INSERT INTO aw_objects VALUES($1, $2, $3) ON CONFLICT DO NOTHING', [
        runId,
        name,
        digest(bytes),
      ]);
    },
    runs: () => q('SELECT id, body, discarded_at FROM aw_runs ORDER BY updated_at'),
    records: (runId, after) =>
      q(
        'SELECT id, run_id, seq::int AS seq, kind, author, body, sources, hash, created FROM aw_records WHERE run_id = $1 AND seq > $2 ORDER BY seq',
        [runId, after],
      ),
    requests: (runId) =>
      q(
        'SELECT id, role, reserved::int AS reserved, actual::int AS actual, status, created FROM aw_requests WHERE run_id = $1',
        [runId],
      ),
    objects: (runId) => q('SELECT name, hash FROM aw_objects WHERE run_id = $1', [runId]),
    async object(runId, name) {
      return new Uint8Array(
        await (await send(objectKey(runId, name), { method: 'GET' })).arrayBuffer(),
      );
    },
  };
}

type Kept = {
  run: { body: string };
  records: Omit<SharedRecord, 'run_id'>[];
  requests: SharedRequest[];
  pulled: boolean;
  discardedAt: string;
};

/** Copies every audit this working copy owns, step by step while it runs.
 * The audit never waits for it: a slow or missing connection only delays the copy. */
export class SharedMirror {
  private timer?: ReturnType<typeof setTimeout>;
  private current?: Promise<void>;
  private ready = false;
  private closed = false;
  private lastSignature?: string;
  private lastDiscardCheck = 0;
  lastError?: string;
  constructor(
    private store: Store,
    private remote: SharedRemote,
    private kit: { discard: (id: string) => Promise<void>; log?: (line: string) => void } = {
      discard: async () => {},
    },
    private everyMs = 2000,
    private closeMs = 5000,
    /** Discards made in another copy are checked hourly, so Neon still sleeps between. */
    private discardEveryMs = 3_600_000,
  ) {}
  start() {
    const loop = () => {
      if (this.closed) return;
      this.timer = setTimeout(() => void this.sync().finally(loop), this.everyMs);
    };
    void this.sync().finally(loop);
  }
  /** One pass at a time, so a discard always lands after any copy already in flight. */
  sync() {
    this.current ??= this.pass()
      .then(() => {
        if (this.lastError) this.kit.log?.('Shared storage is copying again.');
        this.lastError = undefined;
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : 'unknown problem';
        if (message !== this.lastError)
          this.kit.log?.(`Shared storage could not copy yet; it will retry: ${message}`);
        this.lastError = message;
      })
      .finally(() => (this.current = undefined));
    return this.current;
  }
  async close() {
    this.closed = true;
    clearTimeout(this.timer);
    // One last pass sends the final steps of an audit stopped by the shutdown,
    // but a slow connection never holds the engine open for more than 5 seconds.
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.sync().then(() => this.sync()),
      new Promise((resolve) => (timer = setTimeout(resolve, this.closeMs))),
    ]);
    clearTimeout(timer);
  }
  /** What this copy holds, read locally. An unchanged copy never contacts Neon,
   * so the database can sleep between audits instead of using the free allowance. */
  private signature() {
    const runs = this.store.db
      .prepare(
        "SELECT id,body,(SELECT max(seq) FROM records WHERE run_id=runs.id) AS seq,(SELECT group_concat(v) FROM (SELECT id||status||coalesce(actual,'') AS v FROM requests WHERE run_id=runs.id ORDER BY id)) AS requests FROM runs WHERE id NOT IN (SELECT run_id FROM shared_pulled) ORDER BY id",
      )
      .all() as { id: string; body: string; seq: number | null; requests: string | null }[];
    const files = (folder: string) => (existsSync(folder) ? readdirSync(folder).length : 0);
    const kept = existsSync(this.store.keptDir()) ? readdirSync(this.store.keptDir()).sort() : [];
    return digest(
      JSON.stringify([
        runs.map((run) => [
          run.id,
          digest(run.body),
          run.seq,
          run.requests,
          files(join(this.store.dir, run.id)),
        ]),
        kept,
      ]),
    );
  }
  private async pass() {
    const signature = this.signature();
    const checkDue = Date.now() - this.lastDiscardCheck >= this.discardEveryMs;
    if (this.ready && signature === this.lastSignature && !checkDue) return;
    if (!this.ready) {
      await this.remote.prepare();
      this.ready = true;
    }
    await this.sendOwn();
    this.lastSignature = signature;
    this.lastDiscardCheck = Date.now();
  }
  private async sendOwn() {
    await this.sendKept();
    const own = this.store.runs().filter((run) => !this.store.pulled(run.id));
    const elsewhere = await this.remote.discarded(own.map((run) => run.id));
    for (const run of own) {
      if (elsewhere.has(run.id)) {
        // Discarded from another working copy: remove it here too (its copy is kept).
        await this.kit.discard(run.id);
        continue;
      }
      if (this.store.hasRun(run.id)) await this.sendRun(run.id);
    }
  }
  private row(sql: string, ...params: (string | number)[]) {
    return this.store.db.prepare(sql).get(...params) as any;
  }
  private async sendRun(id: string) {
    const db = this.store.db;
    db.prepare("INSERT OR IGNORE INTO shared_sync VALUES(?, '', 0, '')").run(id);
    const sync = this.row('SELECT * FROM shared_sync WHERE run_id=?', id);
    const body = this.row('SELECT body FROM runs WHERE id=?', id)?.body as string | undefined;
    if (body === undefined) return;
    if (digest(body) !== sync.body_hash) {
      await this.remote.putRun(id, body, true);
      db.prepare('UPDATE shared_sync SET body_hash=? WHERE run_id=?').run(digest(body), id);
    }
    for (let after = sync.record_seq as number; ;) {
      const rows = db
        .prepare(
          'SELECT id,run_id,seq,kind,author,body,sources,hash,created FROM records WHERE run_id=? AND seq>? ORDER BY seq LIMIT 200',
        )
        .all(id, after) as SharedRecord[];
      if (!rows.length) break;
      await this.remote.putRecords(rows);
      after = rows.at(-1)!.seq;
      db.prepare('UPDATE shared_sync SET record_seq=? WHERE run_id=?').run(after, id);
    }
    const requests = db
      .prepare(
        'SELECT id,role,reserved,actual,status,created FROM requests WHERE run_id=? ORDER BY id',
      )
      .all(id) as SharedRequest[];
    const requestsHash = digest(JSON.stringify(requests));
    if (requestsHash !== sync.requests_hash) {
      await this.remote.putRequests(id, requests);
      db.prepare('UPDATE shared_sync SET requests_hash=? WHERE run_id=?').run(requestsHash, id);
    }
    const folder = join(this.store.dir, id);
    if (existsSync(folder)) await this.sendFiles(id, folder);
  }
  private async sendFiles(id: string, folder: string) {
    for (const name of readdirSync(folder).filter((name) => OBJECT_NAME.test(name))) {
      if (this.row('SELECT 1 FROM shared_objects WHERE run_id=? AND name=?', id, name)) continue;
      let bytes: Uint8Array;
      try {
        bytes = readFileSync(join(folder, name));
      } catch (error) {
        // Only a file a discard moved mid-pass is skipped; the kept copy sends it next.
        // Any other read failure stops the pass, so nothing is marked sent without it.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      await this.remote.putObject(id, name, bytes);
      this.store.db.prepare('INSERT OR IGNORE INTO shared_objects VALUES(?,?)').run(id, name);
    }
  }
  /** A discarded audit's kept copy is sent whole and marked discarded. It also stays
   * on this Mac, so losing the shared copy never loses the evidence. */
  private async sendKept() {
    const root = this.store.keptDir();
    if (!existsSync(root)) return;
    for (const id of readdirSync(root).filter((name) => RUN_ID.test(name))) {
      const folder = this.store.keptDir(id);
      // Only a discard that finished: an unfinished one could still be undone.
      if (
        !existsSync(join(folder, KEPT_ROWS)) ||
        existsSync(join(folder, KEPT_SENT)) ||
        this.store.discardPending(id) ||
        this.store.hasRun(id)
      )
        continue;
      const kept = JSON.parse(readFileSync(join(folder, KEPT_ROWS), 'utf8')) as Kept;
      await this.remote.putRun(id, kept.run.body, !kept.pulled);
      if (!kept.pulled) {
        await this.remote.putRecords(kept.records.map((row) => ({ ...row, run_id: id })));
        await this.remote.putRequests(id, kept.requests);
        await this.sendFiles(id, folder);
      }
      await this.remote.markDiscarded(id, kept.discardedAt);
      const db = this.store.db;
      db.prepare('DELETE FROM shared_sync WHERE run_id=?').run(id);
      db.prepare('DELETE FROM shared_objects WHERE run_id=?').run(id);
      writeFileSync(join(folder, KEPT_SENT), JSON.stringify({ sentAt: new Date().toISOString() }), {
        mode: 0o600,
      });
    }
  }
}

/** Copies audits other working copies share into this one, as read copies.
 * Discarded audits are skipped unless asked for, to investigate what went wrong. */
export async function pullShared(
  store: Store,
  remote: SharedRemote,
  options: { includeDiscarded?: boolean } = {},
) {
  const db = store.db;
  const summary = { added: 0, updated: 0, removed: 0, files: 0, rejected: 0 };
  for (const run of await remote.runs()) {
    if (!RUN_ID.test(run.id)) continue;
    const own = store.hasRun(run.id) && !store.pulled(run.id);
    if (own || existsSync(store.keptDir(run.id))) continue;
    if (run.discarded_at && !options.includeDiscarded) {
      if (store.hasRun(run.id)) {
        await removePulled(store, run.id);
        summary.removed++;
      }
      continue;
    }
    const known = store.hasRun(run.id);
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(
        'INSERT INTO runs VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body',
      ).run(run.id, run.body);
      db.prepare('INSERT OR IGNORE INTO shared_pulled VALUES(?, 0)').run(run.id);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    const pulled = db
      .prepare('SELECT remote_seq FROM shared_pulled WHERE run_id=?')
      .get(run.id) as {
      remote_seq: number;
    };
    const records = await remote.records(run.id, pulled.remote_seq);
    const requests = await remote.requests(run.id);
    db.exec('BEGIN IMMEDIATE');
    try {
      const insert = db.prepare(
        'INSERT OR IGNORE INTO records(id,run_id,kind,author,body,sources,hash,created) VALUES(?,?,?,?,?,?,?,?)',
      );
      for (const row of records)
        insert.run(
          row.id,
          run.id,
          row.kind,
          row.author,
          row.body,
          row.sources,
          row.hash,
          row.created,
        );
      if (records.length)
        db.prepare('UPDATE shared_pulled SET remote_seq=? WHERE run_id=?').run(
          records.at(-1)!.seq,
          run.id,
        );
      db.prepare('DELETE FROM requests WHERE run_id=?').run(run.id);
      const request = db.prepare('INSERT INTO requests VALUES(?,?,?,?,?,?,?)');
      for (const row of requests)
        request.run(row.id, run.id, row.role, row.reserved, row.actual, row.status, row.created);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    const folder = join(store.dir, run.id);
    for (const object of await remote.objects(run.id)) {
      if (!OBJECT_NAME.test(object.name) || existsSync(join(folder, object.name))) continue;
      const bytes = await remote.object(run.id, object.name);
      // A screenshot that does not match its saved fingerprint is never written;
      // it is counted, and every other audit still comes through.
      if (digest(bytes) !== object.hash) {
        summary.rejected++;
        continue;
      }
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      // Written under a temporary name first, so an interrupted pull never leaves half a file.
      const partial = join(folder, `${object.name}.partial`);
      writeFileSync(partial, bytes, { mode: 0o600 });
      renameSync(partial, join(folder, object.name));
      summary.files++;
    }
    summary[known ? 'updated' : 'added']++;
  }
  return summary;
}

/** A read copy whose original was discarded leaves this copy's lists. The original
 * is already kept in the shared copy, so nothing is set aside here. */
async function removePulled(store: Store, id: string) {
  const db = store.db;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const table of ['requests', 'host_versions', 'records'])
      db.prepare(`DELETE FROM ${table} WHERE run_id=?`).run(id);
    db.prepare('DELETE FROM runs WHERE id=?').run(id);
    db.prepare('DELETE FROM shared_pulled WHERE run_id=?').run(id);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  rmSync(join(store.dir, id), { recursive: true, force: true });
}
