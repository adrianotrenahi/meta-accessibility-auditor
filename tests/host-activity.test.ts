import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { exportHostSnapshot } from '../src/host-export.js';
import { applyHostSnapshot, hostSnapshotSchema } from '../src/host-contract.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'access-walk-activity-'));
  const store = new Store(dir);
  const run = store.create('Recorded progress test', 'https://controlled.example/', 'offline');
  const note = (text: string) =>
    store.append(run.id, 'navigator_note', 'driver', { kind: 'progress', text });
  return {
    store,
    run,
    note,
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('Original preparation and a stopped-before-generation limit are public without invented decisions', () => {
  const x = fixture();
  try {
    const initial = x.note('Initial page captured.');
    const preparation = x.store.snapshot(x.run.id, 'driver').read;
    const limit = x.store.append(x.run.id, 'limit', 'runner', {
      reason: 'Page information exceeded the navigation allowance.',
    });
    const snapshot = exportHostSnapshot(x.store, x.run.id).snapshot;
    assert.deepEqual(
      snapshot.activity?.entries.map((e) => e.id),
      [initial.id, preparation.id, limit.id],
    );
    assert.equal(snapshot.activity?.entries[1].action, 'Preparing next action');
    assert.match(snapshot.activity!.entries[1].reason, /No decision is established/);
    assert.equal(snapshot.activity!.entries[2].reason, limit.payload.reason);
    assert.equal(snapshot.activity!.entries[2].recordHash, limit.hash);
    assert.equal(snapshot.activity!.entries[2].sequence, limit.seq);
    assert.equal(x.store.usage(x.run.id).requests.length, 0);
    assert.equal(snapshot.findings.length, 0);
  } finally {
    x.close();
  }
});

test('Activity-only revisions retain stable source rows and use a bounded original sequence', () => {
  const x = fixture();
  try {
    x.note('Recorded before typing.');
    const first = exportHostSnapshot(x.store, x.run.id).snapshot;
    const repeat = exportHostSnapshot(x.store, x.run.id).snapshot;
    assert.equal(repeat.sequence, first.sequence);
    for (let i = 0; i < 45; i++) x.note('Progress ' + i);
    const next = exportHostSnapshot(x.store, x.run.id).snapshot;
    assert(next.sequence > first.sequence);
    assert.equal(next.activity!.entries.length, 40);
    assert.equal(next.activity!.entries[0].reason, 'Progress 5');
    assert.equal(next.activity!.entries.at(-1)!.reason, 'Progress 44');
    assert.deepEqual(applyHostSnapshot(first, next), next);
    assert.equal(applyHostSnapshot(next, first), next);
    assert.equal(next.captures.length, 0);
    assert.equal(x.store.usage(x.run.id).requests.length, 0);
  } finally {
    x.close();
  }
});

test('Generated notes wait for actual input and never export typed values, keys or response internals', () => {
  const x = fixture(),
    previous = process.env.META_API_KEY;
  process.env.META_API_KEY = 'activity-fixture-secret';
  try {
    const asset = x.store.asset(x.run.id, 'original.png', Buffer.from('controlled original bytes'));
    const source = x.store.append(x.run.id, 'capture', 'browser', {
      stable: true,
      imageFile: asset.file,
      imageHash: asset.hash,
      width: 1440,
      height: 900,
      url: x.run.url,
      title: 'Controlled input',
      elements: [],
    });
    x.store.append(x.run.id, 'model_response', 'driver', {
      output: 'DO_NOT_EXPORT_PRIVATE_RESPONSE',
    });
    const note = x.store.append(
      x.run.id,
      'navigator_note',
      'driver',
      {
        kind: 'progress',
        text: 'Type PRIVATE_QUERY using activity-fixture-secret and Bearer private-token.',
      },
      [source.id],
    );
    assert.equal(exportHostSnapshot(x.store, x.run.id).snapshot.activity!.entries.length, 0);
    x.store.append(
      x.run.id,
      'action',
      'browser',
      {
        method: 'actual_keyboard_or_browser',
        sourceCaptureId: source.id,
        action: { kind: 'type', text: 'PRIVATE_QUERY', note: 'DO_NOT_EXPORT_ACTION_NOTE' },
        outcome: 'performed',
      },
      [source.id],
    );
    const snapshot = exportHostSnapshot(x.store, x.run.id).snapshot;
    const visible = JSON.stringify(snapshot.activity);
    assert(snapshot.activity!.entries.some((e) => e.id === note.id));
    for (const secret of [
      'PRIVATE_QUERY',
      'activity-fixture-secret',
      'private-token',
      'DO_NOT_EXPORT_PRIVATE_RESPONSE',
      'DO_NOT_EXPORT_ACTION_NOTE',
    ])
      assert(!visible.includes(secret), secret);
    assert(visible.includes('[redacted input]'));
    assert(
      snapshot.activity!.entries.some((e) => e.kind === 'action' && e.action === 'Input result'),
    );
    const before = snapshot.activity!.entries[0];
    x.store.snapshot(x.run.id, 'driver');
    x.store.append(x.run.id, 'action', 'browser', {
      method: 'actual_keyboard_or_browser',
      action: { kind: 'type', text: 'Type' },
      outcome: 'performed',
    });
    const later = exportHostSnapshot(x.store, x.run.id).snapshot;
    assert.deepEqual(
      later.activity!.entries.find((e) => e.id === before.id),
      before,
      'Unrelated later typing does not rewrite an old row',
    );
    assert.doesNotThrow(() => applyHostSnapshot(snapshot, later));
  } finally {
    if (previous === undefined) delete process.env.META_API_KEY;
    else process.env.META_API_KEY = previous;
    x.close();
  }
});

test('Old snapshots remain valid; foreign, duplicate, reordered and rewritten activity stays refused', () => {
  const x = fixture();
  try {
    x.note('One');
    x.note('Two');
    const snapshot = exportHostSnapshot(x.store, x.run.id).snapshot;
    const { activity, ...legacy } = snapshot;
    assert(hostSnapshotSchema.safeParse(legacy).success);
    for (const altered of [
      { ...activity, runId: 'other-run' },
      { ...activity, version: 'unknown' },
      { ...activity, entries: [activity!.entries[0], activity!.entries[0]] },
      { ...activity, entries: [...activity!.entries].reverse() },
      { ...activity, entries: [{ ...activity!.entries[0], privatePrompt: 'never' }] },
      { ...activity, entries: [{ ...activity!.entries[0], kind: 'preparing' }] },
    ])
      assert(!hostSnapshotSchema.safeParse({ ...snapshot, activity: altered }).success);
    const rewritten = structuredClone(snapshot);
    rewritten.sequence++;
    rewritten.activity!.entries[0].reason = 'Changed original note';
    assert.throws(() => applyHostSnapshot(snapshot, rewritten), /cannot be rewritten/);
    assert.throws(
      () =>
        applyHostSnapshot(snapshot, {
          ...snapshot,
          sequence: snapshot.sequence + 1,
          run: { ...snapshot.run, id: 'foreign' },
        }),
      /different run/,
    );
  } finally {
    x.close();
  }
});
