import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { parseSam } from '../src/models.js';
import { boxPrompt } from '../src/segmentation.js';
import { exportHostSnapshot } from '../src/host-export.js';
import { applyHostSnapshot, hostSnapshotSchema } from '../src/host-contract.js';

// Deterministic conformance shape; not a model response or an accuracy result.
function sample(shape = '!!!!!)dxGCZAKBF', resolved = true) {
  const dir = mkdtempSync(join(tmpdir(), 'walk-host-sam-')),
    store = new Store(dir);
  const run = store.create('Name the Add button', 'https://controlled.example/', 'offline');
  const image = Buffer.alloc(33);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(image);
  image.writeUInt32BE(13, 8);
  image.write('IHDR', 12);
  image.writeUInt32BE(5, 16);
  image.writeUInt32BE(5, 20);
  const asset = store.asset(run.id, 'original.png', image);
  const element = {
    id: 'e0',
    selector: '#add',
    tag: 'button',
    role: 'button',
    name: '',
    text: '+',
    type: '',
    disabled: false,
    box: { x: 0, y: 0, width: 5, height: 5 },
  };
  const capture = store.append(run.id, 'capture', 'browser', {
    imageFile: asset.file,
    imageHash: asset.hash,
    width: 5,
    height: 5,
    url: run.url,
    title: 'Product',
    stable: true,
    elements: [element],
  });
  const prompt = boxPrompt(element, 5, 5);
  const raw = `<0f>1<|box;x1=0;y1=0;x2=4;y2=4;w=5;h=5|><|mask;x=0;y=0;data=5,5,${shape}|>`;
  const payload = {
    stage: 'result',
    source: 'SAM 3.1',
    captureId: capture.id,
    captureHash: asset.hash,
    targetId: element.id,
    dimensions: { width: 5, height: 5 },
    prompt,
    cacheKey: `sam-3.1:${asset.hash}:${prompt}`,
    raw,
    objects: parseSam(raw, { width: 5, height: 5 }),
    match: resolved ? 'geometry_matches_target' : 'unresolved',
    ...(resolved ? { matchingObjectId: '1' } : {}),
  };
  const mapping = store.append(run.id, 'sam_mapping', 'sam', payload, [capture.id]);
  const candidate = store.append(
    run.id,
    'candidate',
    'saved_analyst_response',
    {
      title: 'Unnamed Add button',
      detail: 'The original button has no name.',
      recommendation: 'Name the button.',
      criterion: 'C02',
      basis: 'measured',
      severity: 'serious',
      targetId: element.id,
      targetCaptureId: capture.id,
    },
    [capture.id],
  );
  const read = store.snapshot(run.id, 'reviewer');
  store.append(
    run.id,
    'review',
    'saved_reviewer_response',
    {
      candidateId: candidate.id,
      candidateHash: candidate.hash,
      verdict: 'keep',
      title: candidate.payload.title,
      sources: [capture.id],
      readSnapshotId: read.read.id,
    },
    [candidate.id, capture.id, read.read.id],
  );
  return {
    store,
    run,
    capture,
    mapping,
    element,
    payload,
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('A saved SAM match accompanies the exact reviewed anchor without changing its rectangle or coverage', () => {
  const x = sample();
  try {
    const before = JSON.stringify(x.store.records(x.run.id)),
      usage = x.store.usage(x.run.id);
    const snapshot = exportHostSnapshot(x.store, x.run.id).snapshot;
    const anchor = snapshot.findings[0].anchor!;
    assert.deepEqual(anchor.box, x.element.box);
    assert.equal(anchor.sam?.mappingHash, x.mapping.hash);
    assert.equal(anchor.sam?.captureHash, x.capture.hash);
    assert.equal(anchor.sam?.imageHash, x.capture.payload.imageHash);
    assert.equal(anchor.sam?.foregroundPixels, 16);
    assert.equal(snapshot.coverage.sam, 'not-established');
    assert(!JSON.stringify(snapshot).includes('maskToken'));
    assert(!JSON.stringify(snapshot).includes('svgPath'));
    const reloaded = exportHostSnapshot(x.store, x.run.id).snapshot;
    assert.deepEqual(applyHostSnapshot(snapshot, reloaded), snapshot);
    assert.equal(JSON.stringify(x.store.records(x.run.id)), before);
    assert.deepEqual(x.store.usage(x.run.id), usage);
  } finally {
    x.close();
  }
});

for (const [name, shape, resolved] of [
  ['empty', '!!!!!&!!!!!', true],
  ['unresolved', '!!!!!)dxGCZAKBF', false],
] as const)
  test(`${name} saved masks keep the reviewed finding and its ordinary marker without a SAM association`, () => {
    const x = sample(shape, resolved);
    try {
      const snapshot = exportHostSnapshot(x.store, x.run.id).snapshot;
      assert.equal(snapshot.findings.length, 1);
      assert.deepEqual(snapshot.findings[0].anchor?.box, x.element.box);
      assert.equal(snapshot.findings[0].anchor?.sam, undefined);
      assert(snapshot.limits.some((limit) => limit.includes('without SAM')));
    } finally {
      x.close();
    }
  });

test('Ambiguous saved results withhold SAM rather than selecting a reply or changing a reviewed finding', () => {
  const x = sample();
  try {
    x.store.append(x.run.id, 'sam_mapping', 'sam', x.payload, [x.capture.id]);
    const snapshot = exportHostSnapshot(x.store, x.run.id).snapshot;
    assert.equal(snapshot.findings.length, 1);
    assert.deepEqual(snapshot.findings[0].anchor?.box, x.element.box);
    assert.equal(snapshot.findings[0].anchor?.sam, undefined);
  } finally {
    x.close();
  }
});

test('The host boundary refuses a SAM receipt moved to a wrong target, source image or coordinate system', () => {
  const x = sample();
  try {
    const snapshot = exportHostSnapshot(x.store, x.run.id).snapshot;
    const mutations = [
      (s: any) => {
        s.findings[0].anchor.sam.captureId = 'other-original';
      },
      (s: any) => {
        s.findings[0].anchor.sam.targetId = 'other-button';
      },
      (s: any) => {
        s.findings[0].anchor.sam.imageHash = 'a'.repeat(64);
      },
      (s: any) => {
        s.findings[0].anchor.sam.width = 1440;
      },
      (s: any) => {
        s.findings[0].anchor.sam.targetBox.x = 1;
      },
      (s: any) => {
        s.findings[0].anchor.sam.bounds.x = 4;
      },
      (s: any) => {
        s.findings[0].anchor.sam.maskWidth = 4;
      },
      (s: any) => {
        s.findings[0].anchor.sam.foregroundPixels = 26;
      },
      (s: any) => {
        s.findings[0].anchor.sam.svgPath = 'M0 0';
      },
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(snapshot);
      mutate(changed);
      assert.equal(hostSnapshotSchema.safeParse(changed).success, false);
    }
    const legacy = structuredClone(snapshot);
    delete legacy.findings[0].anchor!.sam;
    assert.equal(hostSnapshotSchema.safeParse(legacy).success, true);
  } finally {
    x.close();
  }
});
