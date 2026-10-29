import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { exportHostActivity } from '../src/host-activity.js';
import { hostActivitySchema } from '../src/host-contract.js';
import type { RecordEntry } from '../src/types.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'browser-window-activity-'));
  const store = new Store(dir);
  const run = store.create('Synthetic window activity only.', 'https://entry.example/', 'offline');
  const source = store.append(run.id, 'capture', 'browser', { stable: true, url: run.url });
  const note = (payload: Record<string, unknown> = {}, sources = [source.id]) =>
    store.append(
      run.id,
      'navigator_note',
      'browser',
      {
        method: 'browser_window',
        outcome: 'adopted',
        sourceCaptureId: source.id,
        text: 'DO_NOT_EXPORT_NOTE_PROSE',
        ...payload,
      },
      sources,
    );
  const input = (payload: Record<string, unknown> = {}, sources = [source.id]) =>
    store.append(
      run.id,
      'action',
      'browser',
      {
        method: 'actual_keyboard_or_browser',
        sourceCaptureId: source.id,
        action: { kind: 'press', key: 'Enter', note: 'DO_NOT_EXPORT_ACTION_NOTE' },
        outcome: 'performed',
        urlBefore: run.url,
        urlAfter: 'https://results.example/?private=DO_NOT_EXPORT_TARGET_URL',
        ...payload,
      },
      sources,
    );
  const activity = (records = store.records(run.id)) => exportHostActivity(records, run.id);
  return {
    store,
    run,
    source,
    note,
    input,
    activity,
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('A window result waits for its actual key and exports bounded result text, not prose or URLs', () => {
  const f = fixture();
  try {
    const note = f.note();
    assert(!f.activity().entries.some((entry) => entry.id === note.id));
    f.input();
    const activity = f.activity();
    assert(hostActivitySchema.safeParse(activity).success);
    const result = activity.entries.find((entry) => entry.id === note.id)!;
    assert(result);
    assert.equal(result.kind, 'action');
    assert.equal(result.action, 'Input result');
    assert.equal(result.target, 'Enter');
    assert.match(result.reason, /new tab/);
    const visible = JSON.stringify(activity);
    for (const privateText of [
      'DO_NOT_EXPORT_NOTE_PROSE',
      'DO_NOT_EXPORT_ACTION_NOTE',
      'DO_NOT_EXPORT_TARGET_URL',
      'https://results.example/',
    ])
      assert(!visible.includes(privateText));
  } finally {
    f.close();
  }
});

test('A window result refuses missing or changed source bindings and non-performed or unrelated inputs', () => {
  const cases = [
    { note: { sourceCaptureId: 'missing' } },
    { noteSources: [] },
    { input: { sourceCaptureId: 'missing' } },
    { inputSources: [] },
    { input: { outcome: 'not performed' } },
    { input: { method: 'model_suggestion' } },
    { input: { urlBefore: 'https://other.example/' } },
    { input: { action: { kind: 'press', key: 'Tab' } } },
    { input: { action: { kind: 'type', text: 'not a key' } } },
  ];
  for (const change of cases) {
    const f = fixture();
    try {
      const note = f.note(change.note, change.noteSources);
      f.input(change.input, change.inputSources);
      assert(!f.activity().entries.some((entry) => entry.id === note.id), JSON.stringify(change));
    } finally {
      f.close();
    }
  }
});

test('Another decision, foreign source, or altered original cannot establish a window result', () => {
  for (const change of ['next-decision', 'foreign-source', 'altered-original'] as const) {
    const f = fixture();
    try {
      let note: RecordEntry;
      if (change === 'foreign-source') {
        const other = f.store.create('Other synthetic run.', f.run.url, 'offline');
        const source = f.store.append(other.id, 'capture', 'browser', {
          stable: true,
          url: f.run.url,
        });
        note = f.note({ sourceCaptureId: source.id });
        f.input({ sourceCaptureId: source.id });
      } else {
        note = f.note();
        if (change === 'next-decision') f.store.snapshot(f.run.id, 'driver');
        f.input();
      }
      const records = f.store.records(f.run.id);
      if (change === 'altered-original')
        records.find((record) => record.id === f.source.id)!.payload.url =
          'https://rewritten.example/';
      assert(!f.activity(records).entries.some((entry) => entry.id === note.id), change);
    } finally {
      f.close();
    }
  }
});
