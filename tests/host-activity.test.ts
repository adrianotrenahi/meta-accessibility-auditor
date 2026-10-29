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
    const initial = x.note(
      'Initial page captured. Automatic scan results do not establish keyboard or screen-reader operation.',
    );
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
    x.note(
      'Initial page captured. Automatic scan results do not establish keyboard or screen-reader operation.',
    );
    const first = exportHostSnapshot(x.store, x.run.id).snapshot;
    const repeat = exportHostSnapshot(x.store, x.run.id).snapshot;
    assert.equal(repeat.sequence, first.sequence);
    for (let i = 0; i < 45; i++)
      x.store.append(x.run.id, 'limit', 'runner', { reason: 'Progress ' + i });
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
    x.store.snapshot(x.run.id, 'driver');
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
    x.store.append(x.run.id, 'limit', 'runner', { reason: 'One' });
    x.store.append(x.run.id, 'limit', 'runner', { reason: 'Two' });
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

test('A note delayed for input scrubbing cannot appear behind a previously published cursor', () => {
  for (const outcome of ['input', 'next-read', 'stopped'] as const) {
    const x = fixture();
    try {
      const asset = x.store.asset(x.run.id, 'source.png', Buffer.from('controlled source'));
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
      x.note(
        'Initial page captured. Automatic scan results do not establish keyboard or screen-reader operation.',
      );
      x.store.append(x.run.id, 'model_response', 'driver', { output: 'PRIVATE_PROVIDER_OUTPUT' });
      const pending = x.store.append(
        x.run.id,
        'navigator_note',
        'driver',
        { kind: 'progress', text: 'Type PRIVATE_QUERY.' },
        [source.id],
      );
      const limit = x.store.append(x.run.id, 'limit', 'runner', {
        reason: 'The original journey context could not be collected.',
      });
      const first = exportHostSnapshot(x.store, x.run.id).snapshot;
      const cursor = first.activity!.entries.at(-1)!.sequence;
      if (outcome === 'input') {
        x.store.append(
          x.run.id,
          'action',
          'browser',
          {
            method: 'actual_keyboard_or_browser',
            sourceCaptureId: source.id,
            action: { kind: 'type', text: 'PRIVATE_QUERY' },
            outcome: 'performed',
          },
          [source.id],
        );
        x.store.snapshot(x.run.id, 'driver');
      } else if (outcome === 'next-read') x.store.snapshot(x.run.id, 'driver');
      else x.store.finish(x.run.id, 'partial', 'Stopped before an input was recorded.');
      const next = exportHostSnapshot(x.store, x.run.id).snapshot;
      const delta = next.activity!.entries.filter((e) => e.sequence > cursor);
      if (outcome === 'input') {
        assert(
          delta.some((e) => e.id === pending.id),
          'The now-safe original note must be delivered after the prior cursor',
        );
        assert(!JSON.stringify(delta).includes('PRIVATE_QUERY'));
      } else assert(!next.activity!.entries.some((e) => e.id === pending.id));
      assert(
        delta.some((e) => e.id === limit.id),
        'The intervening real limit must become visible',
      );
      assert.equal(x.store.usage(x.run.id).requests.length, 0);
    } finally {
      x.close();
    }
  }
});

test('A pending note older than the forty-row window still holds the suffix while run state stays readable', () => {
  const x = fixture();
  try {
    const initial = x.note(
      'Initial page captured. Automatic scan results do not establish keyboard or screen-reader operation.',
    );
    x.store.append(x.run.id, 'model_response', 'driver', { output: 'PRIVATE_RESPONSE' });
    x.note('A generated note without recorded input.');
    for (let i = 0; i < 45; i++)
      x.store.append(x.run.id, 'limit', 'runner', { reason: 'Known limit ' + i });
    const waiting = exportHostSnapshot(x.store, x.run.id).snapshot;
    assert.deepEqual(
      waiting.activity!.entries.map((e) => e.id),
      [initial.id],
    );
    assert.equal(waiting.run.state, 'running');
    x.store.finish(x.run.id, 'partial', 'No input was recorded.');
    const ended = exportHostSnapshot(x.store, x.run.id).snapshot;
    assert.equal(ended.run.state, 'partial');
    assert.equal(ended.run.stopReason, 'No input was recorded.');
    assert.equal(ended.activity!.entries.length, 40);
    assert.equal(ended.activity!.entries.at(-1)!.reason, 'Known limit 44');
    assert(ended.sequence > waiting.sequence);
  } finally {
    x.close();
  }
});

test('A freeform note without a model response waits for the whole input interval and scrubs every typed value', () => {
  const x = fixture();
  try {
    const asset = x.store.asset(x.run.id, 'source.png', Buffer.from('controlled source'));
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
    const initial = x.note(
      'Initial page captured. Automatic scan results do not establish keyboard or screen-reader operation.',
    );
    const note = x.store.append(
      x.run.id,
      'navigator_note',
      'driver',
      { kind: 'progress', text: 'Type PRIVATE_FIRST then PRIVATE_SECOND.' },
      [source.id],
    );
    assert.deepEqual(
      exportHostSnapshot(x.store, x.run.id).snapshot.activity!.entries.map((e) => e.id),
      [initial.id],
      'Unpaired freeform text must not be made public without a prior model response',
    );
    for (const value of ['PRIVATE_FIRST', 'PRIVATE_SECOND']) {
      x.store.append(x.run.id, 'action', 'browser', {
        method: 'actual_keyboard_or_browser',
        sourceCaptureId: source.id,
        action: { kind: 'type', text: value },
        outcome: 'performed',
      });
      assert.deepEqual(
        exportHostSnapshot(x.store, x.run.id).snapshot.activity!.entries.map((e) => e.id),
        [initial.id],
        'The first input must not prematurely close an interval containing another input',
      );
    }
    x.store.snapshot(x.run.id, 'driver');
    const settled = exportHostSnapshot(x.store, x.run.id).snapshot;
    const visible = settled.activity!.entries.find((e) => e.id === note.id)!;
    assert.equal(visible.reason, 'Type [redacted input] then [redacted input].');
    assert(!JSON.stringify(settled.activity).includes('PRIVATE_FIRST'));
    assert(!JSON.stringify(settled.activity).includes('PRIVATE_SECOND'));
    x.store.append(x.run.id, 'action', 'browser', {
      method: 'actual_keyboard_or_browser',
      action: { kind: 'type', text: 'Initial' },
      outcome: 'performed',
    });
    const later = exportHostSnapshot(x.store, x.run.id).snapshot;
    assert.deepEqual(
      later.activity!.entries.find((e) => e.id === initial.id),
      settled.activity!.entries.find((e) => e.id === initial.id),
      'The exact safe initial sentence cannot change after unrelated later typing',
    );
    assert.deepEqual(
      later.activity!.entries.find((e) => e.id === note.id),
      visible,
    );
    assert.doesNotThrow(() => applyHostSnapshot(settled, later));
  } finally {
    x.close();
  }
});

test('Unsupported note sources never establish a verified input relationship', () => {
  const x = fixture();
  try {
    const read = x.store.snapshot(x.run.id, 'driver').read;
    const response = x.store.append(x.run.id, 'model_response', 'driver', { output: 'PRIVATE' });
    const note = x.store.append(
      x.run.id,
      'navigator_note',
      'driver',
      { kind: 'progress', text: 'A note sourced to an unsupported record.' },
      [read.id, response.id],
    );
    const action = x.store.append(x.run.id, 'action', 'browser', {
      method: 'actual_keyboard_or_browser',
      action: { kind: 'press', key: 'Tab' },
      outcome: 'performed',
    });
    const limit = x.store.append(x.run.id, 'limit', 'runner', { reason: 'Known recorded limit.' });
    x.store.snapshot(x.run.id, 'driver');
    x.store.finish(x.run.id, 'partial', 'No verified note-to-input link.');
    const snapshot = exportHostSnapshot(x.store, x.run.id).snapshot;
    assert(!snapshot.activity!.entries.some((e) => e.id === note.id));
    assert(snapshot.activity!.entries.some((e) => e.id === action.id));
    assert(snapshot.activity!.entries.some((e) => e.id === limit.id));
    assert.equal(snapshot.run.stopReason, 'No verified note-to-input link.');
  } finally {
    x.close();
  }
});

test('A live target path publishes each safe actual key before the next model read without leaking its original note', () => {
  const x = fixture();
  try {
    const read = x.store.snapshot(x.run.id, 'driver').read;
    const note = x.store.append(x.run.id, 'navigator_note', 'driver', {
      kind: 'progress',
      progressMode: 'keyboard_target',
      text: 'PRIVATE_FUTURE_VALUE and DO_NOT_EXPORT_ORIGINAL_NOTE',
    });
    const first = exportHostSnapshot(x.store, x.run.id).snapshot;
    assert.deepEqual(
      first.activity!.entries.map((e) => e.id),
      [read.id, note.id],
    );
    assert.match(first.activity!.entries[1].reason, /real keyboard input/);
    let previous = first;
    for (const key of ['Tab', 'ArrowRight', 'Enter']) {
      const input = x.store.append(x.run.id, 'action', 'browser', {
        method: 'actual_keyboard_or_browser',
        action: { kind: 'press', key, note: 'PRIVATE_KEY_NOTE' },
        outcome: 'performed',
      });
      const next = exportHostSnapshot(x.store, x.run.id).snapshot;
      const delta = next.activity!.entries.filter(
        (e) => e.sequence > previous.activity!.entries.at(-1)!.sequence,
      );
      assert.deepEqual(
        delta.map((e) => [e.id, e.action, e.target]),
        [[input.id, 'Input result', key]],
      );
      assert.doesNotThrow(() => applyHostSnapshot(previous, next));
      previous = next;
    }
    const beforeNextRead = previous.activity!.entries;
    x.store.snapshot(x.run.id, 'driver');
    const afterRead = exportHostSnapshot(x.store, x.run.id).snapshot;
    assert.deepEqual(afterRead.activity!.entries.slice(0, beforeNextRead.length), beforeNextRead);
    assert.doesNotThrow(() => applyHostSnapshot(previous, afterRead));
    const visible = JSON.stringify(afterRead.activity);
    for (const secret of [
      'PRIVATE_FUTURE_VALUE',
      'DO_NOT_EXPORT_ORIGINAL_NOTE',
      'PRIVATE_KEY_NOTE',
    ])
      assert(!visible.includes(secret));
    assert.equal(
      x.store.record(x.run.id, note.id)!.payload.text,
      'PRIVATE_FUTURE_VALUE and DO_NOT_EXPORT_ORIGINAL_NOTE',
    );
    assert.equal(x.store.usage().requests.length, 0);
  } finally {
    x.close();
  }
});
