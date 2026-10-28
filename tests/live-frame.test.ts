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
function originalCapture(bytes: Buffer, stateStamp: string, id = 'original', runId = 'run') {
  const payload = {
    stable: true,
    stateStamp,
    imageHash: digest(bytes),
    width: 1440,
    height: 900,
    _sourcesHash: digest('[]'),
  };
  return {
    id,
    runId,
    seq: 1,
    kind: 'capture',
    author: 'browser',
    payload,
    sources: [],
    hash: digest(JSON.stringify(payload)),
    createdAt: new Date(0).toISOString(),
  } satisfies RecordEntry;
}
test('Live reads share in-flight work, limit picture requests and bind only exact original pixels', async () => {
  const bytes = png();
  let time = 1000,
    calls = 0;
  let release!: (value: Buffer) => void;
  const pending = new Promise<Buffer>((resolve) => {
    release = resolve;
  });
  const original = originalCapture(bytes, 'same');
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
  const original = originalCapture(bytes, 'before');
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

test('An exact reviewed original wins over a later identical observation without changing either record', async () => {
  const bytes = png(),
    older = originalCapture(bytes, 'same', 'reviewed'),
    newer = originalCapture(bytes, 'same', 'newer');
  let time = 1000;
  const reviewed = new Set([older.id]);
  const originals = JSON.stringify([older, newer]);
  const frames = new LiveFrames(
    'run',
    async () => bytes,
    () => {},
    () => [older, newer],
    async () => 'same',
    () => time,
    () => reviewed,
  );
  assert.equal((await frames.read()).captureId, older.id);
  assert.equal(JSON.stringify([older, newer]), originals);
  reviewed.clear();
  time += 251;
  assert.equal(
    (await frames.read()).captureId,
    newer.id,
    'Withdrawal restores the ordinary latest match.',
  );
  frames.close();
});

test('Review preference cannot bypass original integrity, run, author, pixels, full state or geometry', async () => {
  for (const damage of [
    'integrity',
    'run',
    'author',
    'image',
    'state',
    'geometry',
    'unstable',
  ] as const) {
    const bytes = png(),
      older: RecordEntry = originalCapture(bytes, 'same', 'reviewed'),
      newer = originalCapture(bytes, 'same', 'newer');
    if (damage === 'integrity') older.hash = '0'.repeat(64);
    if (damage === 'run') older.runId = 'foreign-run';
    if (damage === 'author') older.author = 'analyst';
    if (damage === 'image') older.payload.imageHash = '0'.repeat(64);
    if (damage === 'state') older.payload.stateStamp = 'invisibly-changed';
    if (damage === 'geometry') older.payload.width = 900;
    if (damage === 'unstable') older.payload.stable = false;
    if (damage !== 'integrity') older.hash = digest(JSON.stringify(older.payload));
    const frames = new LiveFrames(
      'run',
      async () => bytes,
      () => {},
      () => [older, newer],
      async () => 'same',
      Date.now,
      () => new Set([older.id]),
    );
    assert.equal((await frames.read()).captureId, newer.id, damage);
    frames.close();
  }
});

test('Optional review lookup is skipped without an ambiguous match and cannot break live pixels', async () => {
  const bytes = png(),
    older = originalCapture(bytes, 'same', 'older'),
    newer = originalCapture(bytes, 'same', 'newer');
  for (const captures of [[], [newer], [older, newer]]) {
    let calls = 0;
    const frames = new LiveFrames(
      'run',
      async () => bytes,
      () => {},
      () => captures,
      async () => 'same',
      Date.now,
      () => {
        calls++;
        throw Error('The optional review lookup is unavailable.');
      },
    );
    const frame = await frames.read();
    assert.equal(frame.captureId, captures.length ? newer.id : null);
    assert.equal(frame.imageHash, digest(bytes));
    assert.equal(calls, captures.length > 1 ? 1 : 0);
    frames.close();
  }
});
