import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, recordIsIntact } from '../src/store.js';
import type { RecordEntry } from '../src/types.js';
import {
  VISUAL_TOPICS,
  VISUAL_EVIDENCE_LIMITS,
  VISUAL_INSPECTION_GUIDANCE,
  visualCoverageSchema,
  visualCoverageListSchema,
  visualObservationSchema,
  normalizeVisualCoverage,
  validateVisualObservation,
} from '../src/visual-inspection.js';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'access-walk-visual-'));
  const store = new Store(dir);
  const run = store.create(
    'Review the bag and safe checkout',
    'http://127.0.0.1:4317/shop/',
    'offline',
  );
  const asset = store.asset(run.id, 'original.png', Buffer.from('saved-original-image-example'));
  const capture = store.append(run.id, 'capture', 'browser', {
    url: run.url,
    stable: true,
    imageFile: asset.file,
    imageHash: asset.hash,
    width: 1440,
    height: 900,
    text: 'Canvas day bag. Durable canvas. €35. Add to basket.',
    limits: { imageScope: 'viewport' },
    imageProvenance: { source: 'Browser-rendered page viewport', engineAddedAnnotations: false },
  });
  return {
    store,
    run,
    capture,
    rows: VISUAL_TOPICS.map((topic) => ({
      captureId: capture.id,
      topic,
      state: 'examined' as const,
      reason: 'Inspected the original viewport in the context of choosing the bag.',
      sources: [capture.id],
    })),
    observation: {
      captureId: capture.id,
      topic: 'affordances' as const,
      visiblePremise: 'The plus icon is shown beside the bag name, description and price.',
      interpretation: 'Its visible meaning is less explicit than an Add to basket label.',
      taskConcern: 'This may make the intended basket action less clear in this captured state.',
      recommendation: 'Use a short visible Add to basket label.',
      limits: [
        'Expert visual judgement of the original viewport; actual activation was not tested.',
      ],
      sources: [capture.id],
    },
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('Each analysed original viewport gets exactly the six declared visual topics without a pass or finding quota', () => {
  const x = setup();
  try {
    const result = normalizeVisualCoverage(x.rows, [x.capture.id], x.store.records(x.run.id), [
      x.capture.id,
    ]);
    assert.deepEqual(
      result.coverage.map((row) => row.topic),
      [...VISUAL_TOPICS],
    );
    assert(result.coverage.every((row) => row.state === 'examined'));
    assert.deepEqual(result.limits, []);
    assert.equal(Object.hasOwn(result, 'score'), false);
    assert.equal(Object.hasOwn(result, 'findings'), false);
    assert(result.coverage.every((row) => !Object.hasOwn(row, 'verdict')));
    assert.equal(visualCoverageListSchema.parse(x.rows).length, 6);
  } finally {
    x.close();
  }
});

test('Missing, excessive or malformed visual coverage stays explicitly unassessed', () => {
  const x = setup();
  try {
    for (const input of [
      undefined,
      null,
      [],
      'examined',
      [...x.rows, ...x.rows, ...x.rows, ...x.rows],
    ]) {
      const result = normalizeVisualCoverage(input, [x.capture.id], x.store.records(x.run.id), [
        x.capture.id,
      ]);
      assert.equal(result.coverage.length, 6);
      assert(result.coverage.every((row) => row.state === 'not_assessed'));
      assert(result.coverage.every((row) => row.reason.length > 0 && row.sources.length === 0));
      assert(result.limits.length > 0);
    }
    const rows = x.rows.map((row, n) => (n === 0 ? { ...row, state: 'PASS' } : row));
    const result = normalizeVisualCoverage(rows, [x.capture.id], x.store.records(x.run.id), [
      x.capture.id,
    ]);
    assert.equal(result.coverage[0].state, 'not_assessed');
    assert(result.coverage.slice(1).every((row) => row.state === 'examined'));
  } finally {
    x.close();
  }
});

test('A duplicate answer cannot win over a conflicting or malformed visual coverage row', () => {
  const x = setup();
  try {
    for (const duplicate of [
      x.rows[0],
      { ...x.rows[0], state: 'not_assessed' },
      { ...x.rows[0], reason: '' },
    ]) {
      const result = normalizeVisualCoverage(
        [...x.rows, duplicate],
        [x.capture.id],
        x.store.records(x.run.id),
        [x.capture.id],
      );
      assert.equal(result.coverage[0].state, 'not_assessed');
      assert.match(result.coverage[0].reason, /duplicate/);
      assert(result.coverage.slice(1).every((row) => row.state === 'examined'));
    }
  } finally {
    x.close();
  }
});

test('Unknown topics and screens do not create extra visual coverage or examinations', () => {
  const x = setup();
  try {
    const result = normalizeVisualCoverage(
      [
        ...x.rows.slice(1),
        { ...x.rows[0], topic: 'conversion_rate' },
        { ...x.rows[0], captureId: 'another-screen' },
      ],
      [x.capture.id, x.capture.id],
      x.store.records(x.run.id),
      [x.capture.id],
    );
    assert.equal(result.coverage.length, 6);
    assert.equal(result.coverage[0].state, 'not_assessed');
    assert(result.coverage.every((row) => row.captureId === x.capture.id));
    assert(result.limits.some((limit) => /outside this analysis scope/.test(limit)));
  } finally {
    x.close();
  }
});

test('Examined and not-applicable rows require the exact supplied original image and a reason', () => {
  const x = setup();
  try {
    for (const state of ['examined', 'not_applicable'] as const) {
      const row = { ...x.rows[0], state };
      assert.throws(() => visualCoverageSchema.parse({ ...row, reason: ' ' }));
      assert.throws(() => visualCoverageSchema.parse({ ...row, sources: [] }));
      for (const supplied of [[], ['another-screen']]) {
        const result = normalizeVisualCoverage(
          [row],
          [x.capture.id],
          x.store.records(x.run.id),
          supplied,
        );
        assert.equal(result.coverage[0].state, 'not_assessed');
        assert.match(result.coverage[0].reason, /not supplied/);
      }
    }
    const notApplicable = {
      ...x.rows[5],
      state: 'not_applicable',
      reason: 'No imagery or repeated pattern is assessed in this original viewport.',
    };
    const result = normalizeVisualCoverage(
      [notApplicable],
      [x.capture.id],
      x.store.records(x.run.id),
      [x.capture.id],
    );
    assert.equal(result.coverage[5].state, 'not_applicable');
    assert.equal(Object.hasOwn(result.coverage[5], 'verdict'), false);
  } finally {
    x.close();
  }
});

test('Cropped, unstable, annotated or provenance-unknown images cannot support an examined topic', () => {
  const x = setup();
  try {
    for (const change of [
      { limits: { imageScope: 'crop' } },
      { stable: false },
      { imageProvenance: undefined },
      { imageProvenance: { engineAddedAnnotations: true } },
      { imageProvenance: { engineAddedAnnotations: false } },
      { imageProvenance: { source: 'Edited inspection image', engineAddedAnnotations: false } },
      { imageFile: undefined },
    ]) {
      const changed = x.store.append(x.run.id, 'capture', 'browser', {
        ...x.capture.payload,
        ...change,
      });
      const rows = x.rows.map((row) => ({ ...row, captureId: changed.id, sources: [changed.id] }));
      const result = normalizeVisualCoverage(rows, [changed.id], x.store.records(x.run.id), [
        changed.id,
      ]);
      assert(result.coverage.every((row) => row.state === 'not_assessed'));
    }
  } finally {
    x.close();
  }
});

test('Visual coverage cannot expand beyond the existing three-image analysis allowance', () => {
  assert.throws(
    () => normalizeVisualCoverage([], ['one', 'two', 'three', 'four'], [], []),
    /three-original-viewport request allowance/,
  );
});

test('Changed records and source links cannot quietly preserve visual examinations', () => {
  const x = setup();
  try {
    const changed = { ...x.capture, payload: { ...x.capture.payload, text: 'Rewritten later' } };
    const changedLinks = { ...x.capture, sources: ['invented-source'] };
    for (const record of [changed, changedLinks]) {
      assert.equal(recordIsIntact(record), false);
      const result = normalizeVisualCoverage(x.rows, [x.capture.id], [record], [x.capture.id]);
      assert(result.coverage.every((row) => row.state === 'not_assessed'));
    }
  } finally {
    x.close();
  }
});

test('A summary, missing source or another run cannot replace an original visual source', () => {
  const x = setup();
  try {
    const summary = x.store.append(
      x.run.id,
      'coverage',
      'analyst',
      { text: 'The page has no context.' },
      [x.capture.id],
    );
    const foreign: RecordEntry = { ...x.capture, id: 'foreign-capture', runId: 'another-run' };
    for (const sources of [
      [summary.id],
      [x.capture.id, summary.id],
      [x.capture.id, 'missing-source'],
      [x.capture.id, foreign.id],
    ]) {
      assert.throws(() =>
        validateVisualObservation(
          { ...x.observation, sources },
          [...x.store.records(x.run.id), foreign],
          [x.capture.id, foreign.id],
        ),
      );
    }
  } finally {
    x.close();
  }
});

test('Related-view visual claims require every cited original image supplied, not another model retelling', () => {
  const x = setup();
  try {
    const other = x.store.append(x.run.id, 'capture', 'browser', {
      ...x.capture.payload,
      text: 'Safe review',
    });
    const observation = {
      ...x.observation,
      topic: 'consistency_imagery',
      sources: [x.capture.id, other.id],
    };
    assert.throws(
      () => validateVisualObservation(observation, x.store.records(x.run.id), [x.capture.id]),
      /not supplied/,
    );
    assert.deepEqual(
      validateVisualObservation(observation, x.store.records(x.run.id), [x.capture.id, other.id]),
      observation,
    );
  } finally {
    x.close();
  }
});

test('An unscored visual observation preserves visible context, interpretation and limits without inventing a criterion result', () => {
  const x = setup();
  try {
    const before = JSON.stringify(x.store.records(x.run.id));
    const observation = validateVisualObservation(x.observation, x.store.records(x.run.id), [
      x.capture.id,
    ]);
    assert.deepEqual(observation, x.observation);
    assert.match(observation.visiblePremise, /name, description and price/);
    assert.match(observation.interpretation, /less explicit/);
    assert.equal(Object.hasOwn(observation, 'criterion'), false);
    assert.equal(Object.hasOwn(observation, 'verdict'), false);
    assert.equal(Object.hasOwn(observation, 'accepted'), false);
    assert.equal(JSON.stringify(x.store.records(x.run.id)), before);
    assert.throws(() => visualObservationSchema.parse({ ...x.observation, contrastRatio: 7 }));
    assert.throws(() => visualObservationSchema.parse({ ...x.observation, keyboardUsable: true }));
    assert.throws(() =>
      visualObservationSchema.parse({ ...x.observation, spokenOutput: 'Add to basket' }),
    );
  } finally {
    x.close();
  }
});

test('Structural source checks do not claim to establish the truth of a model premise', () => {
  const x = setup();
  try {
    const unsupportedPremise = {
      ...x.observation,
      visiblePremise: 'There is no nearby product context.',
    };
    const unreviewed = validateVisualObservation(unsupportedPremise, x.store.records(x.run.id), [
      x.capture.id,
    ]);
    assert.equal(unreviewed.visiblePremise, unsupportedPremise.visiblePremise);
    assert.equal(Object.hasOwn(unreviewed, 'accepted'), false);
    assert.match(
      VISUAL_INSPECTION_GUIDANCE,
      /Nearby labels, product descriptions and prices count as context/,
    );
    assert.match(
      VISUAL_INSPECTION_GUIDANCE,
      /independently checks the original image and the complete claim/,
    );
    assert(VISUAL_EVIDENCE_LIMITS.some((limit) => /neither a pass/.test(limit)));
  } finally {
    x.close();
  }
});
