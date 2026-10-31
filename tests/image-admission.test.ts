import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, digest } from '../src/store.js';
import { requestEvidence, EvidenceRequestLimit } from '../src/request-evidence.js';
import {
  IMAGE_RECEIPT_VERSION,
  LEGACY_IMAGE_RECEIPT_VERSION,
  PROVIDER_IMAGE_LIMIT,
  makeImageReceipt,
  suppliedImageIds,
  imageRecordsForRead,
} from '../src/image-receipt.js';
import { MetaModels, analysisSchema } from '../src/models.js';
import { recordAnalysisDetails } from '../src/assessment.js';
import { CAPS } from '../src/types.js';

function fixture(count: number) {
  const directory = mkdtempSync(join(tmpdir(), 'meta-required-images-'));
  const store = new Store(directory);
  const run = store.create(
    'Controlled image admission; no quality inference',
    'http://127.0.0.1:4317/search',
    'offline',
  );
  const bytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jYj0AAAAASUVORK5CYII=',
    'base64',
  );
  const captures = Array.from({ length: count }, (_, index) => {
    const image = store.asset(run.id, `capture_${index}.png`, bytes);
    return store.append(run.id, 'capture', 'browser', {
      url: run.url,
      stable: true,
      stateStamp: digest(String(index)),
      imageFile: image.file,
      imageHash: image.hash,
      width: 1,
      height: 1,
      text: `Original controlled state ${index}`,
      elements: [],
      limits: { imageScope: 'viewport', visibleTextTruncated: false },
      imageProvenance: { source: 'Browser-rendered page viewport', engineAddedAnnotations: false },
    });
  });
  const current = captures.at(-1)!;
  const evidence = store.append(
    run.id,
    'observation',
    'browser',
    { stable: true, method: 'controlled_transitive_source_history' },
    captures.map((record) => record.id),
  );
  const note = store.append(
    run.id,
    'navigator_note',
    'driver',
    { text: 'Original walk note, never a summary substitute.' },
    [current.id],
  );
  return {
    directory,
    store,
    run,
    captures,
    current,
    evidence,
    note,
    close() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('Documented fifty-image boundary admits all required originals for analysis and review', () => {
  assert.equal(PROVIDER_IMAGE_LIMIT, 50);
  for (const count of [4, 9, 50]) {
    const x = fixture(count);
    try {
      for (const role of ['analyst', 'reviewer'] as const) {
        const packet = requestEvidence(x.store, x.run.id, role, x.current);
        assert.equal(packet.read.payload.imageReceipt.version, IMAGE_RECEIPT_VERSION);
        assert.deepEqual(packet.read.payload.imageReceipt.recordsOnly, []);
        assert.deepEqual(
          suppliedImageIds(packet.read, packet.records),
          x.captures.map((record) => record.id),
        );
        assert.equal(imageRecordsForRead(packet).length, count);
        for (const original of [...x.captures, x.evidence, x.note])
          assert.deepEqual(
            packet.records.find((record) => record.id === original.id),
            original,
          );
      }
      assert.equal(x.store.usage().requests.length, 0);
    } finally {
      x.close();
    }
  }
});

test('Fifty-one mandatory originals refuse before a read or provider request, without silently dropping one', () => {
  const x = fixture(51);
  try {
    const before = x.store.records(x.run.id);
    for (const role of ['analyst', 'reviewer'] as const)
      assert.throws(
        () => requestEvidence(x.store, x.run.id, role, x.current),
        (error) => error instanceof EvidenceRequestLimit && error.role === role,
      );
    assert.deepEqual(x.store.records(x.run.id), before);
    assert.deepEqual(x.store.usage().requests, []);
    const oversized = x.store.snapshot(
      x.run.id,
      'analyst',
      x.captures.map((record) => record.id),
      makeImageReceipt(x.captures, x.current.id),
    );
    assert.throws(
      () => suppliedImageIds(oversized.read, oversized.records),
      'Even a direct receipt reader enforces the provider limit.',
    );
  } finally {
    x.close();
  }
});

test('Historical receipt ceilings stay strict while the current driver still sees only its current original', () => {
  for (const [role, count] of [
    ['analyst', 4],
    ['reviewer', 9],
    ['driver', 2],
  ] as const) {
    const x = fixture(count);
    try {
      const receipt = {
        ...makeImageReceipt(x.captures, x.current.id),
        version: LEGACY_IMAGE_RECEIPT_VERSION,
      };
      const old = x.store.snapshot(
        x.run.id,
        role,
        x.captures.map((record) => record.id),
        receipt,
      );
      assert.throws(() => suppliedImageIds(old.read, old.records));
      const driver = requestEvidence(x.store, x.run.id, 'driver', x.current);
      assert.deepEqual(suppliedImageIds(driver.read, driver.records), [x.current.id]);
    } finally {
      x.close();
    }
  }
});

test('New receipts refuse omitted, duplicated, changed or records-only original pictures', () => {
  const x = fixture(4);
  try {
    const valid = requestEvidence(x.store, x.run.id, 'analyst', x.current);
    for (const damage of ['missing', 'duplicate', 'hash', 'records-only', 'version'] as const) {
      const receipt = structuredClone(valid.read.payload.imageReceipt);
      if (damage === 'missing') receipt.supplied.shift();
      if (damage === 'duplicate') receipt.supplied.push(receipt.supplied[0]);
      if (damage === 'hash') receipt.supplied[0].imageHash = '0'.repeat(64);
      if (damage === 'version') receipt.version = 'unknown';
      if (damage === 'records-only')
        receipt.recordsOnly.push({
          ...receipt.supplied.shift(),
          reason: 'approved_return_entry_baseline',
          comparisonId: 'not-real',
          baselineId: 'not-real',
          typedActionId: 'not-real',
        });
      const read = x.store.snapshot(
        x.run.id,
        'analyst',
        valid.records.map((record) => record.id),
        receipt,
      );
      assert.throws(
        () => suppliedImageIds(read.read, read.records),
        (error) => error instanceof Error,
        damage,
      );
    }
    assert.deepEqual(x.store.usage().requests, []);
  } finally {
    x.close();
  }
});

test('Additional supplied images do not turn missing visual topics into examinations or criterion passes', () => {
  const x = fixture(50);
  try {
    const packet = requestEvidence(x.store, x.run.id, 'analyst', x.current);
    recordAnalysisDetails(
      x.store,
      x.run.id,
      packet,
      x.captures.map((record) => record.id),
      { coverage: [], visualObservations: [], criterionProposals: [] },
    );
    const rows = x.store.records(x.run.id).filter((record) => record.kind === 'visual_coverage');
    assert.equal(rows.length, 300);
    assert(rows.every((record) => record.payload.state === 'not_assessed'));
    assert(
      x.store
        .records(x.run.id)
        .every((record) => !['criterion_proposal', 'candidate'].includes(record.kind)),
    );
  } finally {
    x.close();
  }
});

test('All fifty actual image attachments still pass exact counting and unchanged money/context admission before generation', async () => {
  for (const count of [100, 700000, CAPS.analyst.input + 1]) {
    const x = fixture(50);
    try {
      const packet = requestEvidence(x.store, x.run.id, 'analyst', x.current);
      const calls: { url: string; body: any }[] = [];
      const model = new MetaModels(
        x.store,
        (async (url, init) => {
          const body = JSON.parse(String(init?.body));
          calls.push({ url: String(url), body });
          assert.equal(
            body.input[0].content.filter((part: any) => part.type === 'input_image').length,
            50,
          );
          assert.equal(body.input[0].content[0].text, JSON.stringify(packet.records));
          assert.match(body.instructions, /at most eighteen visual coverage rows/);
          assert(
            !body.instructions.includes('Return six coverage rows per supplied original viewport'),
          );
          if (String(url).endsWith('/input_tokens')) return Response.json({ input_tokens: count });
          return Response.json({
            status: 'completed',
            usage: { input_tokens: count, output_tokens: 20 },
            output_text: JSON.stringify({
              findings: [],
              coverage: [],
              visualObservations: [],
              criterionProposals: [],
              missingEvidence: [],
            }),
          });
        }) as typeof fetch,
        () => ({
          approvedBy: 'Adriano',
          maxUsd: 3,
          // At the Contributor price 700,000 counted tokens cost about $0.07: beyond the
          // analyst's $0.066 share of a $0.30 run, but within the run itself.
          maxRunUsd: 0.3,
          approvedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        }),
        () => 'mock-key-no-provider-access',
      );
      const reason = () =>
        model.reason(
          x.run.id,
          'analyst',
          packet.records,
          imageRecordsForRead(packet).map((capture) => ({
            captureId: capture.id,
            image:
              'data:image/png;base64,' +
              x.store.image(x.run.id, capture.payload.imageFile).toString('base64'),
          })),
          analysisSchema,
          false,
          new AbortController().signal,
          packet.read,
        );
      if (count === 100) {
        await reason();
        assert.equal(calls.length, 2);
        assert.deepEqual(calls[0].body, calls[1].body);
      } else {
        await assert.rejects(
          reason,
          count > CAPS.analyst.input ? EvidenceRequestLimit : /Phase spending limit/,
        );
        assert.equal(calls.length, 1);
        assert.deepEqual(x.store.usage().requests, []);
      }
    } finally {
      x.close();
    }
  }
});
