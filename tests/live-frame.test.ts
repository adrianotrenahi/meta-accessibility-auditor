import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LiveFrames } from '../src/live-frame.js';
import { digest } from '../src/store.js';
import type { RecordEntry } from '../src/types.js';
const png = () => {
  const bytes = Buffer.alloc(24);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes);
  bytes.writeUInt32BE(1440, 16);
  bytes.writeUInt32BE(900, 20);
  return bytes;
};
test('Live reads share in-flight work, limit picture requests and bind only exact original pixels', async () => {
  const bytes = png();
  let time = 1000,
    calls = 0;
  let release!: (value: Buffer) => void;
  const pending = new Promise<Buffer>((resolve) => {
    release = resolve;
  });
  const original = {
    kind: 'capture',
    id: 'original',
    payload: {
      stable: true,
      stateStamp: 'same',
      imageHash: digest(bytes),
      width: 1440,
      height: 900,
    },
  } as RecordEntry;
  const frames = new LiveFrames(
    'run',
    () => {
      calls++;
      return pending;
    },
    () => {},
    () => [original],
    async () => 'same',
    () => time,
  );
  const first = frames.read(),
    second = frames.read();
  assert.equal(first, second);
  release(bytes);
  const a = await first;
  assert.equal(a.captureId, 'original');
  assert.equal(a.sequence, 1);
  assert.equal((await frames.read()).sequence, 1);
  assert.equal(calls, 1);
  time += 251;
  assert.equal((await frames.read()).sequence, 2);
  assert.equal(calls, 2);
  assert.deepEqual(
    Object.keys(a).sort(),
    [
      'protocol',
      'runId',
      'sequence',
      'capturedAt',
      'width',
      'height',
      'imageHash',
      'captureId',
      'png',
    ].sort(),
  );
  frames.close();
  await assert.rejects(frames.read(), /closed/);
});
test('Closing during a picture prevents the late pixels from escaping', async () => {
  let release!: (value: Buffer) => void;
  const frames = new LiveFrames(
    'run',
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
    () => {},
    () => [],
    async () => 'same',
  );
  const pending = frames.read();
  await Promise.resolve();
  frames.close();
  release(png());
  await assert.rejects(pending, /closed/);
});
test('Unsupported pictures fail closed; unmatched live pixels do not inherit an original identity', async () => {
  let bytes = Buffer.from('not a picture');
  const frames = new LiveFrames(
    'run',
    async () => bytes,
    () => {},
    () => [],
    async () => 'same',
  );
  await assert.rejects(frames.read(), /unsupported picture/);
  bytes = png();
  bytes.writeUInt32BE(9000, 16);
  await assert.rejects(frames.read(), /dimensions/);
  bytes = png();
  assert.equal((await frames.read()).captureId, null);
  frames.close();
});

test('Identical pictures cannot inherit an old capture after invisible browser state changes', async () => {
  const bytes = png();
  let stamp = 'before';
  const original = {
    kind: 'capture',
    id: 'original',
    payload: {
      stable: true,
      stateStamp: 'before',
      imageHash: digest(bytes),
      width: 1440,
      height: 900,
    },
  } as RecordEntry;
  const frames = new LiveFrames(
    'run',
    async () => {
      stamp = 'after';
      return bytes;
    },
    () => {},
    () => [original],
    async () => stamp,
  );
  const frame = await frames.read();
  assert.equal(frame.imageHash, digest(bytes));
  assert.equal(frame.captureId, null);
  assert(!JSON.stringify(frame).includes('stateStamp'));
  frames.close();
});
