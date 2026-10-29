import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exportHostAnalysis } from '../src/host-analysis.js';
import { applyHostSnapshot, hostSnapshotSchema } from '../src/host-contract.js';
import { digest, Store } from '../src/store.js';
import { exportHostSnapshot } from '../src/host-export.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RecordEntry } from '../src/types.js';

function fixture() {
  const runId = 'analysis-run';
  const make = (
    id: string,
    seq: number,
    kind: RecordEntry['kind'],
    author: string,
    body: any,
  ): RecordEntry => ({
    id,
    seq,
    runId,
    kind,
    author,
    payload: body,
    sources: [],
    hash: digest(JSON.stringify(body)),
    createdAt: '2026-10-29T01:00:00Z',
  });
  const capture = make('capture', 1, 'capture', 'browser', {
    stable: true,
    imageHash: 'a'.repeat(64),
  });
  const imageReceipt = {
    version: 'original-images/2',
    currentCaptureId: capture.id,
    supplied: [
      { captureId: capture.id, captureHash: capture.hash, imageHash: capture.payload.imageHash },
    ],
    recordsOnly: [],
  };
  const read = make('read', 2, 'read_snapshot', 'analyst', {
    records: [{ id: capture.id, hash: capture.hash, sources: [] }],
    imageReceipt,
  });
  const response = make('response', 3, 'model_response', 'analyst', {
    requestId: 'request',
    status: 'completed',
    readSnapshotId: read.id,
    readSnapshotHash: read.hash,
    imageReceipt,
    output: 'PRIVATE_RESPONSE_NEVER_EXPORTED',
  });
  const requests = [
    { id: 'request', run_id: runId, role: 'analyst', status: 'completed', actual: 10 },
  ];
  return { runId, records: [capture, read, response], requests, capture, read, response };
}
function snapshot(x = fixture()) {
  return hostSnapshotSchema.parse({
    protocol: 'access-walk/host-v1',
    provenance: 'saved-engine-records',
    run: {
      id: x.runId,
      url: 'https://controlled.example/',
      goal: 'Fixture only',
      mode: 'live',
      state: 'partial',
      createdAt: '2026-10-29T01:00:00Z',
      stopReason: 'Fixture',
    },
    sequence: 1,
    analysis: exportHostAnalysis(x.records, x.runId, x.requests),
    captures: [
      {
        id: x.capture.id,
        sequence: 1,
        imageHash: 'a'.repeat(64),
        imageAvailable: true,
        imageFile: `images/${'a'.repeat(64)}.png`,
        width: 1440,
        height: 900,
        url: 'https://controlled.example/',
        title: 'Fixture',
        stable: true,
        createdAt: '2026-10-29T01:00:00Z',
      },
    ],
    findings: [],
    coverage: {
      scope: 'limited',
      score: null,
      realVoiceOver: 'not-established',
      sam: 'not-established',
    },
    limits: [],
    cost: { usageEstimateUsd: 0, heldUnknownUsd: 0 },
  });
}

test('A completed actual response is retained independently of zero accepted findings, with exact sources only', () => {
  const x = fixture(),
    result = snapshot(x);
  assert.equal(result.findings.length, 0);
  assert.deepEqual(result.analysis!.completed, [
    {
      id: x.response.id,
      sequence: x.response.seq,
      recordHash: x.response.hash,
      role: 'analyst',
      requestId: 'request',
      readSnapshotId: x.read.id,
      readSnapshotHash: x.read.hash,
      readSnapshotSequence: x.read.seq,
      captureIds: [x.capture.id],
    },
  ]);
  assert(!JSON.stringify(result.analysis).includes('PRIVATE_RESPONSE'));
});

test('Saved examples, driver responses, unreturned and unparsed/invalid provider results cannot establish completed analysis', () => {
  for (const status of [
    'unknown',
    'sending',
    'received',
    'invalid_result',
    'incomplete',
    'not_sent',
  ]) {
    const x = fixture();
    x.requests[0].status = status;
    assert.deepEqual(exportHostAnalysis(x.records, x.runId, x.requests).completed, [], status);
  }
  for (const author of ['saved_analyst_response', 'driver']) {
    const x = fixture();
    x.response.author = author;
    assert.deepEqual(exportHostAnalysis(x.records, x.runId, x.requests).completed, [], author);
  }
  const x = fixture();
  assert.deepEqual(exportHostAnalysis(x.records.slice(0, 2), x.runId, x.requests).completed, []);
  x.response.payload.status = 'incomplete';
  x.response.hash = digest(JSON.stringify(x.response.payload));
  assert.deepEqual(exportHostAnalysis(x.records, x.runId, x.requests).completed, []);
});

test('Changed, missing, foreign, ambiguous or future original reads and request receipts are withheld', () => {
  const mutations: Array<(x: ReturnType<typeof fixture>) => void> = [
    (x) => {
      x.read.payload.records[0].hash = 'b'.repeat(64);
      x.read.hash = digest(JSON.stringify(x.read.payload));
      x.response.payload.readSnapshotHash = x.read.hash;
      x.response.hash = digest(JSON.stringify(x.response.payload));
    },
    (x) => {
      x.records.splice(0, 1);
    },
    (x) => {
      x.read.runId = 'foreign';
    },
    (x) => {
      x.read.hash = 'b'.repeat(64);
    },
    (x) => {
      x.requests[0].run_id = 'foreign';
    },
    (x) => {
      x.requests[0].role = 'reviewer';
    },
    (x) => {
      x.requests.push({ ...x.requests[0] });
    },
    (x) => {
      x.records.push({ ...x.response, id: 'duplicate-response' });
    },
    (x) => {
      x.capture.seq = 4;
    },
  ];
  for (const change of mutations) {
    const x = fixture();
    change(x);
    assert.deepEqual(exportHostAnalysis(x.records, x.runId, x.requests).completed, []);
  }
});

test('Host readers reject foreign/missing-original, duplicate, offline or rewritten completion attribution; older exports remain readable', () => {
  const original = snapshot();
  const old = { ...original };
  delete old.analysis;
  assert(hostSnapshotSchema.safeParse(old).success);
  for (const mutate of [
    (s: any) => {
      s.analysis.runId = 'other';
    },
    (s: any) => {
      s.analysis.completed[0].captureIds = ['missing'];
    },
    (s: any) => {
      s.analysis.completed.push({ ...s.analysis.completed[0] });
    },
    (s: any) => {
      s.run.mode = 'offline';
    },
  ]) {
    const changed = structuredClone(original);
    mutate(changed);
    assert(!hostSnapshotSchema.safeParse(changed).success);
  }
  const changed = structuredClone(original);
  changed.sequence++;
  changed.analysis!.completed[0].recordHash = 'b'.repeat(64);
  assert.throws(() => applyHostSnapshot(original, changed), /cannot be rewritten/);
  assert.equal(applyHostSnapshot(original, original), original);
});

test('A newer snapshot cannot silently lose a previously accepted completion receipt', () => {
  const original = snapshot();
  for (const omitField of [false, true]) {
    const next = structuredClone(original);
    next.sequence++;
    if (omitField) delete next.analysis;
    else next.analysis!.completed = [];
    assert.throws(() => applyHostSnapshot(original, next), /cannot be rewritten|cannot be removed/);
  }
});

test('The actual host export retains all capture rows, including unpublished unstable and unavailable originals', () => {
  const dir = mkdtempSync(join(tmpdir(), 'recorded-analysis-export-'));
  const store = new Store(dir);
  try {
    const run = store.create(
      'Controlled export fixture only',
      'https://controlled.example/',
      'live',
    );
    const asset = store.asset(run.id, 'original.png', Buffer.from('controlled original bytes'));
    const payload = {
      imageFile: asset.file,
      imageHash: asset.hash,
      width: 1440,
      height: 900,
      url: run.url,
      title: 'Controlled export',
      stable: true,
      elements: [],
    };
    const capture = store.append(run.id, 'capture', 'browser', payload);
    const { read } = store.snapshot(run.id, 'analyst');
    store.append(run.id, 'model_response', 'analyst', {
      status: 'completed',
      requestId: 'controlled-request',
      readSnapshotId: read.id,
      readSnapshotHash: read.hash,
      output: 'Saved controlled test value; no model call',
    });
    store.db
      .prepare('INSERT INTO requests VALUES(?,?,?,?,?,?,?)')
      .run('controlled-request', run.id, 'analyst', 10, 10, 'completed', run.createdAt);
    const unavailable = store.append(run.id, 'capture', 'browser', {
      ...payload,
      stable: false,
      imageFile: 'missing.png',
      imageHash: 'b'.repeat(64),
    });
    const exported = exportHostSnapshot(store, run.id).snapshot;
    assert.equal(exported.findings.length, 0);
    assert.deepEqual(
      exported.captures.map((row) => row.id),
      [capture.id, unavailable.id],
    );
    assert.equal(exported.captures[1].stable, false);
    assert.equal(exported.captures[1].imageAvailable, false);
    assert.deepEqual(exported.analysis!.completed[0].captureIds, [capture.id]);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
