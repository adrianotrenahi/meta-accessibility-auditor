import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AnalysisTrack } from '../src/analysis-track.js';
import { Store } from '../src/store.js';
import { requestEvidence } from '../src/request-evidence.js';
import type { RecordEntry } from '../src/types.js';

const screen = { id: 'capture-a', seq: 1 } as RecordEntry;

test('The analysis track checks screens one at a time, in the order they were reached', async () => {
  const track = new AnalysisTrack();
  const order: string[] = [];
  let release!: () => void;
  const first = new Promise<void>((resolve) => (release = resolve));
  track.add(screen, 1, async () => {
    order.push('first started');
    await first;
    order.push('first finished');
  });
  track.add(screen, 2, async () => {
    order.push('second started');
  });
  assert.equal(track.pending, 2);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['first started'], 'the second waits for the first');
  release();
  await track.drain();
  assert.deepEqual(order, ['first started', 'first finished', 'second started']);
  assert.equal(track.pending, 0);
  assert.deepEqual(track.last, { captureId: screen.id, throughSeq: 2 });
});

test('A failed check stops later checks and is reported to the robot, never swallowed', async () => {
  const track = new AnalysisTrack();
  let later = false;
  track.add(screen, 1, async () => {
    throw Error('Synthetic hard failure.');
  });
  track.add(screen, 2, async () => {
    later = true;
  });
  await track.settle();
  assert.equal(later, false, 'no further paid check starts after a hard failure');
  assert.throws(() => track.rethrow(), /Synthetic hard failure/);
  await assert.rejects(track.drain(), /Synthetic hard failure/);
});

test('Each focused check the analyst asks for is handed to the robot exactly once', () => {
  const track = new AnalysisTrack();
  const request = {
    method: 'keyboard_focus' as const,
    captureId: screen.id,
    criterionId: null,
    reason: 'Synthetic request.',
  };
  track.ask(request);
  assert.deepEqual(track.takeRequests(), [request]);
  assert.deepEqual(track.takeRequests(), []);
});

test('A check on the track reads the walk as it stood when its screen was handed over', () => {
  const dir = mkdtempSync(join(tmpdir(), 'analysis-track-'));
  const store = new Store(dir);
  try {
    const run = store.create('Bounded evidence', 'http://127.0.0.1/a', 'offline');
    const shot = (url: string) => {
      const asset = store.asset(
        run.id,
        `capture_${Math.random().toString(36).slice(2)}.png`,
        Buffer.from(url),
      );
      return store.append(run.id, 'capture', 'browser', {
        url,
        title: url,
        imageFile: asset.file,
        imageHash: asset.hash,
        width: 1440,
        height: 900,
        stable: true,
      });
    };
    const handedOver = shot('http://127.0.0.1/a');
    const throughSeq = store.records(run.id).at(-1)!.seq;
    // The robot walks on while the check waits for its turn, and measures a control Tab
    // never reaches on the next page.
    store.append(run.id, 'action', 'browser', { method: 'actual_keyboard_or_browser' }, [
      handedOver.id,
    ]);
    const later = shot('http://127.0.0.1/b');
    store.append(run.id, 'observation', 'browser', { method: 'keyboard_reach/1', reached: false }, [
      later.id,
    ]);
    const images = (through?: number) =>
      new Set(
        requestEvidence(store, run.id, 'analyst', handedOver, through)
          .records.filter((record) => record.kind === 'capture')
          .map((record) => record.id),
      );
    assert.deepEqual(images(throughSeq), new Set([handedOver.id]));
    assert(images().has(later.id), 'without the bound the later screen would have been read');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
