import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { MetaModels, parseSam } from '../src/models.js';
import { boxPrompt, mapElement } from '../src/segmentation.js';
import type { ElementInfo } from '../src/types.js';

const target: ElementInfo = {
  id: 'e1',
  selector: '#add',
  tag: 'button',
  role: 'button',
  name: 'Add to basket',
  text: 'Add',
  type: '',
  disabled: false,
  box: { x: 10, y: 20, width: 10, height: 10 },
};
const lane =
  '<0f>1<|box;x1=10;y1=20;x2=19;y2=29;w=100;h=80;c=0.9|><|mask;x=0;y=0;c=0.9;data=10,10,!abc|>';
const dimensions = { width: 100, height: 80 };

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'access-walk-sam-'));
  const store = new Store(dir);
  const run = store.create('Inspect a controlled target', 'http://127.0.0.1:4317/shop/', 'offline');
  function capture(n: number) {
    const asset = store.asset(run.id, `capture_${n}.png`, Buffer.from('same-source-pixels'));
    return store.append(run.id, 'capture', 'browser', {
      ...dimensions,
      url: run.url,
      imageFile: asset.file,
      imageHash: asset.hash,
      stable: true,
      elements: [target],
    });
  }
  return {
    dir,
    store,
    run,
    capture,
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('SAM source pixels use inclusive corners, including a one-pixel edge target', () => {
  assert.equal(boxPrompt(target, 100, 80), '<0f>1<|box;x1=10;y1=20;x2=19;y2=29;w=100;h=80|>');
  const edge = { ...target, box: { x: 99, y: 79, width: 1, height: 1 } };
  assert.equal(boxPrompt(edge, 100, 80), '<0f>1<|box;x1=99;y1=79;x2=99;y2=79;w=100;h=80|>');
  const parsed = parseSam(lane, dimensions)[0];
  assert.deepEqual(parsed.box, target.box);
  assert.equal(parsed.maskPixels, 'not-decoded');
  assert.equal(parsed.maskToken, '<|mask;x=0;y=0;c=0.9;data=10,10,!abc|>');
  for (const box of [
    { x: 100, y: 1, width: 1, height: 1 },
    { x: 1, y: 1, width: 0, height: 1 },
    { x: NaN, y: 1, width: 1, height: 1 },
  ])
    assert.throws(() => boxPrompt({ ...target, box }, 100, 80));
});

test('A still-image result rejects foreign frames, partial records, duplicates and trailing content', () => {
  assert.deepEqual(parseSam(' \n ', dimensions), []);
  for (const raw of [
    lane.replace('<0f>', '<1f>'),
    lane + '\n' + lane,
    lane + ',1' + lane.slice(5),
    lane + ',01' + lane.slice(5),
    lane + ',broken',
    lane + ',',
    lane + ' explanatory text',
    'explanation ' + lane,
    lane.slice(0, -2),
    '<0f>',
  ])
    assert.throws(() => parseSam(raw, dimensions), raw);
});

test('SAM validates source bounds, mask structure and paired confidence before showing geometry', () => {
  for (const raw of [
    lane.replace('x2=19', 'x2=100'),
    lane.replace('w=100', 'w=101'),
    lane.replace('data=10,10', 'data=0,10'),
    lane.replace('data=10,10', 'data=81,10'),
    lane.replace('mask;x=0', 'mask;x=1'),
    lane.replace(';c=0.9;data', ';c=0.8;data'),
    lane.replace(';c=0.9;data', ';data'),
    lane.replaceAll('c=0.9', 'c=1.1'),
    lane.replace('!abc', '?abc'),
    lane.replace('!abc', '!'),
  ])
    assert.throws(() => parseSam(raw, dimensions), raw);
});

test('SAM reuse stays with one exact original capture, even when another capture has identical pixels', async () => {
  const x = setup();
  try {
    let calls = 0;
    const models = {
      sam: async () => {
        calls++;
        return { source: 'Saved SAM example', raw: lane, objects: parseSam(lane, dimensions) };
      },
    } as unknown as MetaModels;
    const first = x.capture(1),
      second = x.capture(2),
      signal = new AbortController().signal;
    const a = await mapElement(x.store, models, x.run.id, first, target.id, signal);
    assert.equal(a.payload.match, 'geometry_matches_target');
    assert.match(a.payload.limit, /not been decoded or validated/);
    assert.equal((await mapElement(x.store, models, x.run.id, first, target.id, signal)).id, a.id);
    assert.equal(calls, 1);
    const b = await mapElement(x.store, models, x.run.id, second, target.id, signal);
    assert.equal(b.payload.captureId, second.id);
    assert.notEqual(a.id, b.id);
    assert.equal(calls, 2);
    writeFileSync(join(x.dir, x.run.id, first.payload.imageFile), 'changed pixels');
    await assert.rejects(
      () => mapElement(x.store, models, x.run.id, first, target.id, signal),
      /image has changed/,
    );
    assert.equal(calls, 2);
  } finally {
    x.close();
  }
});

test('A failed SAM attempt cannot silently send the same original target again', async () => {
  const x = setup();
  try {
    let calls = 0;
    const models = {
      sam: async () => {
        calls++;
        throw Error('Saved provider failure; request outcome is unconfirmed.');
      },
    } as unknown as MetaModels;
    const original = x.capture(1),
      signal = new AbortController().signal;
    await assert.rejects(
      () => mapElement(x.store, models, x.run.id, original, target.id, signal),
      /Saved provider failure/,
    );
    for (let repeat = 0; repeat < 2; repeat++)
      await assert.rejects(
        () => mapElement(x.store, models, x.run.id, original, target.id, signal),
        /prior SAM attempt.*not be silently retried/,
      );
    assert.equal(calls, 1, 'One provider attempt is retained across repeated mapping requests.');
    assert.equal(x.store.records(x.run.id).filter((r) => r.kind === 'sam_mapping').length, 1);
  } finally {
    x.close();
  }
});

test('A completed empty SAM result stays unresolved and is reused without another request', async () => {
  const x = setup();
  try {
    let calls = 0;
    const models = {
      sam: async () => {
        calls++;
        return { source: 'Saved empty SAM example', raw: '', objects: [] };
      },
    } as unknown as MetaModels;
    const original = x.capture(1),
      signal = new AbortController().signal;
    const result = await mapElement(x.store, models, x.run.id, original, target.id, signal);
    assert.equal(result.payload.match, 'unresolved');
    assert.equal(
      (await mapElement(x.store, models, x.run.id, original, target.id, signal)).id,
      result.id,
    );
    assert.equal(calls, 1);
  } finally {
    x.close();
  }
});

test('A changed capture or cached result cannot quietly trigger another SAM request', async () => {
  const x = setup();
  try {
    let calls = 0;
    const models = {
      sam: async () => {
        calls++;
        return { source: 'Saved example', raw: lane, objects: parseSam(lane, dimensions) };
      },
    } as unknown as MetaModels;
    const first = x.capture(1),
      signal = new AbortController().signal;
    const result = await mapElement(x.store, models, x.run.id, first, target.id, signal);
    x.store.db.prepare('UPDATE records SET body=? WHERE id=?').run('{"rewritten":true}', result.id);
    // Restoring the cache selectors but changing the result still fails its saved fingerprint.
    x.store.db
      .prepare('UPDATE records SET body=? WHERE id=?')
      .run(JSON.stringify({ ...result.payload, match: 'invented' }), result.id);
    await assert.rejects(
      () => mapElement(x.store, models, x.run.id, first, target.id, signal),
      /saved SAM result changed/,
    );
    x.store.db.prepare('UPDATE records SET body=? WHERE id=?').run('{"rewritten":true}', first.id);
    await assert.rejects(
      () => mapElement(x.store, models, x.run.id, first, target.id, signal),
      /exact original/,
    );
    assert.equal(calls, 1);
  } finally {
    x.close();
  }
});

test('SAM request format is supported and malformed returned geometry retains its known charge', async () => {
  for (const raw of [lane, '', lane.replace('<0f>', '<2f>')]) {
    const x = setup();
    try {
      let requests = 0;
      const model = new MetaModels(
        x.store,
        (async (_url, init) => {
          requests++;
          const body = JSON.parse(String(init?.body));
          assert.equal(body.model, 'sam-3.1');
          assert.equal(body.stream, false);
          assert.deepEqual(body.metadata, { mask_encoding: 'one_bit', include_confidence: 'true' });
          return new Response(JSON.stringify({ status: 'completed', output_text: raw }), {
            status: 200,
          });
        }) as typeof fetch,
        () => ({
          approvedBy: 'Adriano',
          maxUsd: 10,
          maxRunUsd: 3,
          approvedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
        () => 'fake-test-key',
      );
      const result = () =>
        model.sam(x.run.id, 'data:image/png;base64,c2F2ZWQ=', 'button', dimensions);
      if (raw.includes('<2f>')) await assert.rejects(result, /frame zero/);
      else assert.equal((await result()).objects.length, raw ? 1 : 0);
      assert.equal(requests, 1);
      const usage = x.store.usage(x.run.id);
      assert.equal(usage.spent, 2500);
      assert.equal(usage.reserved, 0);
      assert.equal(usage.requests[0].status, raw.includes('<2f>') ? 'invalid_result' : 'completed');
    } finally {
      x.close();
    }
  }
});
