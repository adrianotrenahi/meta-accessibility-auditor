import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { exportHostSnapshot } from '../src/host-export.js';
import { exportKeyboardEvidence, keyboardEvidenceSchema } from '../src/keyboard-evidence.js';
function sample() {
  const dir = mkdtempSync(join(tmpdir(), 'walk-keys-'));
  const store = new Store(dir);
  const run = store.create('Recorded keys', 'https://controlled.example/', 'offline');
  const asset = store.asset(run.id, 'original.png', Buffer.from('original'));
  const capture = store.append(run.id, 'capture', 'browser', {
    imageFile: asset.file,
    imageHash: asset.hash,
    stable: true,
    width: 1440,
    height: 900,
    url: run.url,
    title: 'Shop',
    elements: [],
  });
  const append = (
    key = 'Enter',
    changes: Record<string, unknown> = {},
    sources = [capture.id],
    author = 'browser',
  ) =>
    store.append(
      run.id,
      'action',
      author,
      {
        method: 'actual_keyboard_or_browser',
        sourceCaptureId: sources[0],
        sourceImageHash: sources[0]
          ? store.record(run.id, sources[0])?.payload?.imageHash
          : undefined,
        action: { kind: 'press', key, note: 'PRIVATE_NOTE', text: 'PRIVATE_VALUE' },
        before: { tag: 'button', name: 'Continue', text: 'PRIVATE_EXTRA' },
        after: { name: 'PRIVATE_AFTER' },
        outcome: 'performed',
        ...changes,
      },
      sources,
    );
  return {
    store,
    run,
    capture,
    append,
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test('Keyboard export contains only original browser activation attempts, never values or inferred success', () => {
  const x = sample();
  try {
    const enter = x.append(),
      space = x.append('Space');
    x.append('Tab');
    x.append('Enter', { action: { kind: 'type', text: 'PRIVATE_VALUE' } });
    x.append('Enter', {}, [x.capture.id], 'saved_analyst_response');
    const data = exportKeyboardEvidence(x.run.id, x.store.records(x.run.id));
    assert.deepEqual(
      data.keyPresses.map((a) => a.id),
      [enter.id, space.id],
    );
    assert.deepEqual(data.keyPresses[0], {
      id: enter.id,
      sequence: enter.seq,
      recordHash: enter.hash,
      captureId: x.capture.id,
      imageHash: x.capture.payload.imageHash,
      key: 'Enter',
      control: { tag: 'button', name: 'Continue' },
      result: 'not-confirmed',
      createdAt: enter.createdAt,
    });
    assert(!JSON.stringify(data).includes('PRIVATE_'));
    assert.equal(data.coverage.nativeScreenReader, 'not-established');
    assert.equal(data.coverage.tabOrder, 'not-established');
  } finally {
    x.close();
  }
});
test('Broken, unstable or unrelated sources and rewritten actions are withheld explicitly', () => {
  const x = sample();
  try {
    const rewritten = x.append();
    x.store.db.prepare('UPDATE records SET body=? WHERE id=?').run(
      JSON.stringify({
        method: 'actual_keyboard_or_browser',
        sourceCaptureId: x.capture.id,
        sourceImageHash: x.capture.payload.imageHash,
        action: { kind: 'press', key: 'Enter' },
        before: { tag: 'button', name: 'Invented' },
        outcome: 'performed',
      }),
      rewritten.id,
    );
    x.append('Enter', { outcome: 'refused' });
    x.append('Enter', { before: { tag: 'body', name: '' } });
    x.append('Enter', {}, []);
    x.append('Enter', {}, [rewritten.id]);
    const unstable = x.store.append(x.run.id, 'capture', 'browser', {
      ...x.capture.payload,
      stable: false,
    });
    x.append('Enter', {}, [unstable.id]);
    const data = exportKeyboardEvidence(x.run.id, x.store.records(x.run.id));
    assert.equal(data.keyPresses.length, 0);
    assert.equal(data.limits.length, 6);
    assert.equal(data.limits.filter((reason) => reason.includes('integrity check')).length, 1);
    assert.equal(
      data.limits.filter((reason) => reason.includes('not recorded as performed')).length,
      1,
    );
    assert.equal(data.limits.filter((reason) => reason.includes('unsupported control')).length, 1);
    assert.equal(data.limits.filter((reason) => reason.includes('no verified link')).length, 3);
    assert(!JSON.stringify(data).includes('Invented'));
  } finally {
    x.close();
  }
});
test('Activation-only changes advance the host version, and tampering withdraws exported attempts', () => {
  const x = sample();
  try {
    const first = exportHostSnapshot(x.store, x.run.id);
    const action = x.append();
    const next = exportHostSnapshot(x.store, x.run.id);
    assert(next.snapshot.sequence > first.snapshot.sequence);
    assert.deepEqual(next.snapshot.captures, first.snapshot.captures);
    assert.equal(next.keyboard.keyPresses.length, 1);
    assert.equal(exportHostSnapshot(x.store, x.run.id).snapshot.sequence, next.snapshot.sequence);
    x.store.db.prepare('UPDATE records SET hash=? WHERE id=?').run('a'.repeat(64), action.id);
    const withdrawn = exportHostSnapshot(x.store, x.run.id);
    assert(withdrawn.snapshot.sequence > next.snapshot.sequence);
    assert.equal(withdrawn.keyboard.keyPresses.length, 0);
  } finally {
    x.close();
  }
});
test('Keyboard contract refuses reordered/duplicate identities, unsupported outcomes and extra fields', () => {
  const x = sample();
  try {
    x.append();
    x.append('Space');
    const data = exportHostSnapshot(x.store, x.run.id).keyboard;
    assert.throws(() =>
      keyboardEvidenceSchema.parse({ ...data, keyPresses: [...data.keyPresses].reverse() }),
    );
    assert.throws(() =>
      keyboardEvidenceSchema.parse({
        ...data,
        keyPresses: [data.keyPresses[0], data.keyPresses[0]],
      }),
    );
    assert.throws(() => keyboardEvidenceSchema.parse({ ...data, throughSequence: 0 }));
    assert.throws(() =>
      keyboardEvidenceSchema.parse({
        ...data,
        keyPresses: [{ ...data.keyPresses[0], result: 'works' }],
      }),
    );
    assert.throws(() => keyboardEvidenceSchema.parse({ ...data, privateValue: 'PRIVATE_VALUE' }));
  } finally {
    x.close();
  }
});

test('Repointed source links and legacy inputs without a saved source binding cannot acquire a new picture', () => {
  const x = sample();
  try {
    const other = x.store.append(x.run.id, 'capture', 'browser', {
      ...x.capture.payload,
      title: 'Other state',
    });
    const action = x.append();
    x.store.db
      .prepare('UPDATE records SET sources=? WHERE id=?')
      .run(JSON.stringify([other.id]), action.id);
    x.append('Enter', { sourceCaptureId: undefined, sourceImageHash: undefined });
    const data = exportKeyboardEvidence(x.run.id, x.store.records(x.run.id));
    assert.equal(data.keyPresses.length, 0);
    assert.equal(data.limits.length, 2);
  } finally {
    x.close();
  }
});

test('Text-field Enter and Space remain literal keypresses, never control activations', () => {
  const x = sample();
  try {
    x.append('Space', { before: { tag: 'textarea', name: 'Message' } });
    x.append('Enter', { before: { tag: 'input', name: 'Email', type: 'text' } });
    const data = exportKeyboardEvidence(x.run.id, x.store.records(x.run.id));
    assert.equal('activations' in data, false);
    assert.deepEqual(
      data.keyPresses.map((record) => [record.key, record.control.tag, record.result]),
      [
        ['Space', 'textarea', 'not-confirmed'],
        ['Enter', 'input', 'not-confirmed'],
      ],
    );
    assert.equal(data.limits.length, 0);
  } finally {
    x.close();
  }
});
