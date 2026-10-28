import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeSavedSamMask, SAM_MASK_LIMITS } from '../src/sam-mask.js';
import { digest } from '../src/store.js';
import { parseSam } from '../src/models.js';
import { boxPrompt } from '../src/segmentation.js';
import type { RecordEntry } from '../src/types.js';
import { DatabaseSync } from 'node:sqlite';
import {
  mkdtempSync,
  mkdirSync,
  chmodSync,
  copyFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { proveSavedSamMasks } from '../scripts/sam-mask-proof.js';

// Deterministic synthetic 5x5 conformance shapes, not new provider responses.
const shape = '!!!!!)dxGCZAKBF',
  empty = '!!!!!&!!!!!';
function record(id: string, kind: RecordEntry['kind'], payload: any, sources: string[] = []) {
  payload = { ...payload, _sourcesHash: digest(JSON.stringify(sources)) };
  return {
    id,
    runId: 'saved-mask-run',
    seq: kind === 'capture' ? 1 : 2,
    kind,
    author: kind === 'capture' ? 'browser' : 'sam',
    payload,
    sources,
    hash: digest(JSON.stringify(payload)),
    createdAt: new Date(0).toISOString(),
  } satisfies RecordEntry;
}
function fixture(payload = shape) {
  // Synthetic header exercises source bounds; the retained real-response proof uses actual PNGs.
  const image = Buffer.alloc(33);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(image);
  image.writeUInt32BE(13, 8);
  image.write('IHDR', 12);
  image.writeUInt32BE(5, 16);
  image.writeUInt32BE(5, 20);
  const target = {
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
  const capture = record('original', 'capture', {
    width: 5,
    height: 5,
    stable: true,
    imageHash: digest(image),
    elements: [target],
  });
  const prompt = boxPrompt(target, 5, 5);
  const raw = `<0f>1<|box;x1=0;y1=0;x2=4;y2=4;w=5;h=5|><|mask;x=0;y=0;data=5,5,${payload}|>`;
  const mapping = record(
    'saved-sam',
    'sam_mapping',
    {
      stage: 'result',
      source: 'SAM 3.1',
      captureId: capture.id,
      captureHash: capture.payload.imageHash,
      targetId: target.id,
      dimensions: { width: 5, height: 5 },
      prompt,
      cacheKey: `sam-3.1:${capture.payload.imageHash}:${prompt}`,
      raw,
      objects: parseSam(raw, { width: 5, height: 5 }),
      match: 'geometry_matches_target',
      matchingObjectId: '1',
    },
    [capture.id],
  );
  return { image, capture, mapping };
}
function pin(record: RecordEntry) {
  record.payload._sourcesHash = digest(JSON.stringify(record.sources));
  record.hash = digest(JSON.stringify(record.payload));
}

test('A complete synthetic shape decodes with exact originals, binary area and a safe local SVG path', () => {
  const x = fixture(),
    before = JSON.stringify(x);
  const result = decodeSavedSamMask(x.mapping, x.capture, x.image);
  assert.equal(result.state, 'decoded');
  assert.equal(result.foregroundPixels, 16);
  assert.equal(result.mappingHash, x.mapping.hash);
  assert.equal(result.captureHash, x.capture.hash);
  assert.equal(result.imageHash, x.capture.payload.imageHash);
  assert.equal(result.svgPathHash, digest(result.svgPath));
  assert.match(result.svgPath, /^M/);
  assert.deepEqual(result.bounds, { x: 0, y: 0, width: 5, height: 5 });
  assert.deepEqual(result.sourceTranslation, { x: 0.5, y: 0.5 });
  assert.match(result.limit, /not autonomous recognition/);
  assert.equal(JSON.stringify(x), before);
});

test('A complete empty mask stays empty rather than inventing an outline', () => {
  const x = fixture(empty),
    result = decodeSavedSamMask(x.mapping, x.capture, x.image);
  assert.equal(result.state, 'empty');
  assert.equal(result.foregroundPixels, 0);
  assert.equal(result.svgPath, '');
});

test('The documented lossless conformance mask also decodes in its original box', () => {
  const x = fixture();
  x.image.writeUInt32BE(320, 16);
  x.image.writeUInt32BE(334, 20);
  Object.assign(x.capture.payload, { width: 320, height: 334, imageHash: digest(x.image) });
  x.capture.payload.elements[0].box = { x: 211, y: 228, width: 60, height: 27 };
  pin(x.capture);
  const prompt = boxPrompt(x.capture.payload.elements[0], 320, 334);
  const payload = "~!!!!M!0c[0o91w?q1!pIH4pPRVp2B3'7`e.ioeAf6-k/#Xd8%dX9x(";
  const raw = `<0f>1<|box;x1=211;y1=228;x2=270;y2=254;w=320;h=334|><|mask;x=0;y=0;data=27,60,${payload}|>`;
  Object.assign(x.mapping.payload, {
    captureHash: digest(x.image),
    dimensions: { width: 320, height: 334 },
    prompt,
    cacheKey: `sam-3.1:${digest(x.image)}:${prompt}`,
    raw,
    objects: parseSam(raw, { width: 320, height: 334 }),
  });
  pin(x.mapping);
  const result = decodeSavedSamMask(x.mapping, x.capture, x.image);
  assert.equal(result.state, 'decoded');
  assert(result.foregroundPixels > 0 && result.foregroundPixels <= 1620);
  assert.deepEqual(result.sourceTranslation, { x: 211.5, y: 228.5 });
});

test('A completed no-match response stays unresolved without a paid retry', () => {
  const x = fixture();
  x.mapping.payload.raw = '';
  x.mapping.payload.objects = [];
  x.mapping.payload.match = 'unresolved';
  delete x.mapping.payload.matchingObjectId;
  pin(x.mapping);
  const result = decodeSavedSamMask(x.mapping, x.capture, x.image);
  assert.equal(result.state, 'unresolved');
  assert(!('svgPath' in result));
});

test('Foreign, changed, unstable, ambiguous and wrongly linked originals refuse decoding even when metadata is repinned', () => {
  const changes: Array<[string, (x: ReturnType<typeof fixture>) => void]> = [
    [
      'foreign run',
      (x) => {
        x.capture.runId = 'another-run';
      },
    ],
    [
      'wrong author',
      (x) => {
        x.mapping.author = 'analyst';
      },
    ],
    [
      'reply before original',
      (x) => {
        x.mapping.seq = 0;
      },
    ],
    [
      'nonbrowser original',
      (x) => {
        x.capture.author = 'analyst';
      },
    ],
    [
      'unstable',
      (x) => {
        x.capture.payload.stable = false;
        pin(x.capture);
      },
    ],
    [
      'wrong source',
      (x) => {
        x.mapping.sources = ['another-original'];
        pin(x.mapping);
      },
    ],
    [
      'wrong capture',
      (x) => {
        x.mapping.payload.captureId = 'another-original';
        pin(x.mapping);
      },
    ],
    [
      'wrong image pin',
      (x) => {
        x.mapping.payload.captureHash = 'f'.repeat(64);
        pin(x.mapping);
      },
    ],
    [
      'wrong target',
      (x) => {
        x.mapping.payload.targetId = 'e1';
        pin(x.mapping);
      },
    ],
    [
      'duplicate target',
      (x) => {
        x.capture.payload.elements.push(structuredClone(x.capture.payload.elements[0]));
        pin(x.capture);
      },
    ],
    [
      'duplicate selector',
      (x) => {
        x.capture.payload.elements.push({ ...x.capture.payload.elements[0], id: 'e1' });
        pin(x.capture);
      },
    ],
    [
      'wrong dimensions',
      (x) => {
        x.mapping.payload.dimensions.width = 6;
        pin(x.mapping);
      },
    ],
    [
      'wrong prompt',
      (x) => {
        x.mapping.payload.prompt = 'another target';
        pin(x.mapping);
      },
    ],
    [
      'wrong cache pin',
      (x) => {
        x.mapping.payload.cacheKey = 'other';
        pin(x.mapping);
      },
    ],
    [
      'changed record',
      (x) => {
        x.mapping.payload.targetId = 'e1';
      },
    ],
    [
      'changed pixels',
      (x) => {
        x.image[32] = 1;
      },
    ],
    [
      'wrong actual PNG dimensions',
      (x) => {
        x.image.writeUInt32BE(6, 16);
        x.capture.payload.imageHash = digest(x.image);
        x.mapping.payload.captureHash = digest(x.image);
        pin(x.capture);
        pin(x.mapping);
      },
    ],
    [
      'forged objects',
      (x) => {
        x.mapping.payload.objects[0].box.x = 1;
        pin(x.mapping);
      },
    ],
  ];
  for (const [name, change] of changes) {
    const x = fixture();
    change(x);
    assert.throws(() => decodeSavedSamMask(x.mapping, x.capture, x.image), name);
  }
});

test('Incomplete or noncanonical encoded masks cannot become decoded outlines', () => {
  for (const payload of [shape.slice(0, -1), shape + '!', shape.slice(1), '!abcde']) {
    const x = fixture(payload);
    assert.throws(() => decodeSavedSamMask(x.mapping, x.capture, x.image), payload);
  }
});

test('Mask, original-image and text quotas are checked before unbounded decoding', () => {
  for (const change of [
    (x: ReturnType<typeof fixture>) => {
      x.mapping.payload.raw += ' '.repeat(SAM_MASK_LIMITS.responseCharacters);
      pin(x.mapping);
    },
    (x: ReturnType<typeof fixture>) => {
      const segment = x.mapping.payload.raw.slice(4);
      x.mapping.payload.raw =
        '<0f>' +
        Array.from({ length: SAM_MASK_LIMITS.objects + 1 }, (_, i) =>
          segment.replace(/^1</, `${i + 1}<`),
        ).join(',');
      x.mapping.payload.objects = parseSam(x.mapping.payload.raw, { width: 5, height: 5 });
      pin(x.mapping);
    },
    (x: ReturnType<typeof fixture>) => {
      x.image = Buffer.concat([x.image, Buffer.alloc(SAM_MASK_LIMITS.imageBytes)]);
      x.capture.payload.imageHash = digest(x.image);
      pin(x.capture);
      x.mapping.payload.captureHash = digest(x.image);
      x.mapping.payload.cacheKey = `sam-3.1:${digest(x.image)}:${x.mapping.payload.prompt}`;
      pin(x.mapping);
    },
    (x: ReturnType<typeof fixture>) => {
      x.capture.payload.width = 2000;
      x.capture.payload.height = 2000;
      pin(x.capture);
    },
    (x: ReturnType<typeof fixture>) => {
      x.mapping.payload.raw = x.mapping.payload.raw.replace('data=5,5,', 'data=4,5,');
      x.mapping.payload.objects = parseSam(x.mapping.payload.raw, { width: 5, height: 5 });
      pin(x.mapping);
    },
  ]) {
    const x = fixture();
    change(x);
    assert.throws(() => decodeSavedSamMask(x.mapping, x.capture, x.image));
  }
});

test('Mask geometry must still intersect the intended original target', () => {
  const x = fixture();
  x.capture.payload.elements[0].box = { x: 0, y: 0, width: 1, height: 1 };
  pin(x.capture);
  x.mapping.payload.prompt = boxPrompt(x.capture.payload.elements[0], 5, 5);
  x.mapping.payload.cacheKey = `sam-3.1:${x.capture.payload.imageHash}:${x.mapping.payload.prompt}`;
  pin(x.mapping);
  assert.throws(() => decodeSavedSamMask(x.mapping, x.capture, x.image), /overlap/);
});

test('A small but extremely complex synthetic shape cannot export an oversized path', () => {
  const x = fixture();
  const size = 150;
  x.image.writeUInt32BE(size, 16);
  x.image.writeUInt32BE(size, 20);
  Object.assign(x.capture.payload, { width: size, height: size, imageHash: digest(x.image) });
  x.capture.payload.elements[0].box = { x: 0, y: 0, width: size, height: size };
  pin(x.capture);
  const prompt = boxPrompt(x.capture.payload.elements[0], size, size);
  // Deterministic 150x150 checkerboard, generated offline; its valid path exceeds 200,000 characters.
  const raw = `<0f>1<|box;x1=0;y1=0;x2=149;y2=149;w=150;h=150|><|mask;x=0;y=0;data=150,150,!!!!!+MW)29&#xM^Oi|>`;
  Object.assign(x.mapping.payload, {
    captureHash: digest(x.image),
    dimensions: { width: size, height: size },
    prompt,
    cacheKey: `sam-3.1:${digest(x.image)}:${prompt}`,
    raw,
    objects: parseSam(raw, { width: size, height: size }),
  });
  pin(x.mapping);
  assert.throws(() => decodeSavedSamMask(x.mapping, x.capture, x.image), /safe shape allowance/);
});

test('The reusable proof reads only saved originals, refuses overwrites/escaped files and exports no shape from bad images', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'meta-mask-proof-'));
  const data = join(temporary, 'data');
  mkdirSync(data);
  const x = fixture();
  x.capture.payload.imageFile = 'original.png';
  pin(x.capture);
  mkdirSync(join(data, x.capture.runId));
  const imageFile = join(data, x.capture.runId, 'original.png');
  writeFileSync(imageFile, x.image);
  const dbFile = join(data, 'runs.sqlite');
  const db = new DatabaseSync(dbFile);
  db.exec(
    'CREATE TABLE records(seq INTEGER,id TEXT,run_id TEXT,kind TEXT,author TEXT,body TEXT,sources TEXT,hash TEXT,created TEXT);CREATE TABLE requests(id TEXT,run_id TEXT);',
  );
  const insert = db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?,?,?)');
  for (const r of [x.capture, x.mapping])
    insert.run(
      r.seq,
      r.id,
      r.runId,
      r.kind,
      r.author,
      JSON.stringify(r.payload),
      JSON.stringify(r.sources),
      r.hash,
      r.createdAt,
    );
  db.close();
  const originalDatabase = digest(readFileSync(dbFile));
  try {
    assert.throws(
      () =>
        proveSavedSamMasks(
          join(temporary, 'missing-data'),
          x.capture.runId,
          join(temporary, 'missing-source-proof'),
        ),
      /Choose an existing saved-data folder/,
    );
    assert.throws(
      () => proveSavedSamMasks(data, x.capture.runId, join(temporary, 'missing-parent', 'proof')),
      /Create the output folder’s parent first/,
    );
    const emptyData = join(temporary, 'empty-data');
    mkdirSync(emptyData);
    assert.throws(
      () =>
        proveSavedSamMasks(emptyData, x.capture.runId, join(temporary, 'missing-database-proof')),
      /Keep runs.sqlite and any matching -wal\/-shm files together/,
    );
    assert(
      !existsSync(join(emptyData, 'runs.sqlite')),
      'A failed read-only open must never create a blank source database.',
    );
    const out = join(temporary, 'proof');
    const proof = proveSavedSamMasks(data, x.capture.runId, out);
    assert.equal(proof.decodedOutlines, 1);
    assert.deepEqual(proof.errors, []);
    assert.equal(proof.providerCalls, 0);
    assert.equal(proof.additionalCredits, 0);
    const svg = readFileSync(
      join(
        out,
        readdirSync(out).find((file) => file.endsWith('.svg'))!,
      ),
      'utf8',
    );
    assert(svg.includes('transform="translate(0.5 0.5)"'));
    assert(!svg.includes('<script'));
    const firstReceipt = readFileSync(join(out, 'result.json'), 'utf8');
    assert.throws(
      () => proveSavedSamMasks(data, x.capture.runId, out),
      /Choose a new proof folder/,
    );
    assert.equal(readFileSync(join(out, 'result.json'), 'utf8'), firstReceipt);
    assert.throws(
      () => proveSavedSamMasks(data, x.capture.runId, join(data, 'do-not-write')),
      /outside/,
    );
    writeFileSync(imageFile, Buffer.from('changed pixels'));
    const damaged = proveSavedSamMasks(data, x.capture.runId, join(temporary, 'damaged'));
    assert.equal(damaged.decodedOutlines, 0);
    assert.equal(damaged.errors.length, 1);
    assert.deepEqual(readdirSync(join(temporary, 'damaged')), ['result.json']);
    const external = join(temporary, 'external.png');
    writeFileSync(external, x.image);
    unlinkSync(imageFile);
    symlinkSync(external, imageFile);
    const escaped = proveSavedSamMasks(data, x.capture.runId, join(temporary, 'escaped'));
    assert.equal(escaped.decodedOutlines, 0);
    assert.equal(escaped.errors.length, 1);
    assert.match(escaped.errors[0].detail, /outside/);
    assert.equal(digest(readFileSync(dbFile)), originalDatabase);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('A complete copied WAL set remains readable without source writes, while the main database alone omits recent originals', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'meta-mask-wal-'));
  const source = join(temporary, 'source'),
    saved = join(temporary, 'saved');
  mkdirSync(source);
  mkdirSync(saved);
  const x = fixture();
  x.capture.payload.imageFile = 'original.png';
  pin(x.capture);
  const db = new DatabaseSync(join(source, 'runs.sqlite'));
  try {
    db.exec(
      'PRAGMA journal_mode=WAL;CREATE TABLE records(seq INTEGER,id TEXT,run_id TEXT,kind TEXT,author TEXT,body TEXT,sources TEXT,hash TEXT,created TEXT);CREATE TABLE requests(id TEXT,run_id TEXT);PRAGMA wal_checkpoint(TRUNCATE);',
    );
    const insert = db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?,?,?)');
    for (const r of [x.capture, x.mapping])
      insert.run(
        r.seq,
        r.id,
        r.runId,
        r.kind,
        r.author,
        JSON.stringify(r.payload),
        JSON.stringify(r.sources),
        r.hash,
        r.createdAt,
      );
    const bare = join(temporary, 'main-only.sqlite');
    copyFileSync(join(source, 'runs.sqlite'), bare);
    const mainOnly = new DatabaseSync(bare, { readOnly: true });
    try {
      assert.equal(
        (mainOnly.prepare('SELECT COUNT(*) AS n FROM records').get() as any).n,
        0,
        'The required original records are still in WAL, not the main file.',
      );
    } finally {
      mainOnly.close();
    }
    const sourceFiles = ['runs.sqlite', 'runs.sqlite-wal', 'runs.sqlite-shm'];
    for (const file of sourceFiles) copyFileSync(join(source, file), join(saved, file));
    mkdirSync(join(saved, x.capture.runId));
    writeFileSync(join(saved, x.capture.runId, 'original.png'), x.image);
    const before = sourceFiles.map((file) => digest(readFileSync(join(saved, file))));
    for (const file of sourceFiles) chmodSync(join(saved, file), 0o444);
    chmodSync(saved, 0o555);
    const proof = proveSavedSamMasks(saved, x.capture.runId, join(temporary, 'proof'));
    assert.equal(proof.decodedOutlines, 1);
    assert.deepEqual(proof.errors, []);
    assert.equal(proof.providerCalls, 0);
    assert.equal(digest(readFileSync(join(saved, 'runs.sqlite'))), before[0]);
    assert.equal(digest(readFileSync(join(saved, 'runs.sqlite-wal'))), before[1]);
  } finally {
    db.close();
    chmodSync(saved, 0o755);
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('The pinned decoder emits only its documented uppercase polygon commands', () => {
  const x = fixture(),
    result = decodeSavedSamMask(x.mapping, x.capture, x.image);
  assert.equal(result.state, 'decoded');
  assert.deepEqual([...new Set(result.svgPath.match(/[A-Za-z]/g))].sort(), ['L', 'M', 'Z']);
  const declared = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const installed = JSON.parse(
    readFileSync(new URL('../node_modules/@meta-sam/parser/package.json', import.meta.url), 'utf8'),
  );
  assert.equal(declared.dependencies['@meta-sam/parser'], '0.1.0');
  assert.equal(installed.version, '0.1.0');
});
