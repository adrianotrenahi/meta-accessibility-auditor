import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { requestEvidence } from '../src/request-evidence.js';
import { candidateTarget } from '../src/candidate-target.js';
import { candidateSchema, MetaModels, IncompleteModelResult } from '../src/models.js';
import { Runner } from '../src/runner.js';
import { ActionStateChanged, ObservationUnsettled } from '../src/browser.js';
import { exportHostSnapshot } from '../src/host-export.js';
import type { RecordEntry } from '../src/types.js';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'access-walk-day-two-'));
  const store = new Store(dir);
  const run = store.create('Reach safe review', 'http://127.0.0.1:4317/shop/', 'offline');
  function capture(n: number, selector = '#add', url = run.url) {
    const asset = store.asset(run.id, `capture_${n}.png`, Buffer.from('test-image-' + n));
    return store.append(run.id, 'capture', 'browser', {
      url,
      title: 'Controlled shop',
      imageFile: asset.file,
      imageHash: asset.hash,
      width: 1440,
      height: 900,
      stable: true,
      text: 'Original text '.repeat(700),
      elements: [
        {
          id: 'e0',
          selector,
          contextFingerprint: 'a'.repeat(64),
          tag: 'button',
          role: 'button',
          name: '',
          text: '+',
          type: '',
          box: { x: 10, y: 10, width: 40, height: 40 },
        },
      ],
    });
  }
  function claim(source: RecordEntry, issueKey = 'missing_accessible_name') {
    return candidateSchema.parse({
      issueKey,
      scope: 'element',
      visiblePremise: 'The exposed button name is empty.',
      title: 'The basket button has no accessible name',
      detail: 'The original name is empty.',
      criterion: 'C02',
      basis: 'measured',
      severity: 'serious',
      targetId: 'e0',
      targetCaptureId: source.id,
      sources: [source.id],
      recommendation: 'Give this button a useful accessible name.',
    });
  }
  function keep(candidates: RecordEntry[]) {
    const read = store.snapshot(run.id, 'reviewer');
    for (const c of candidates)
      store.append(
        run.id,
        'review',
        'reviewer',
        {
          candidateId: c.id,
          candidateHash: c.hash,
          verdict: 'keep',
          premise: 'supported',
          title: c.payload.title,
          reason: 'Exact original evidence supports the unchanged claim.',
          readSnapshotId: read.read.id,
        },
        [...c.sources, c.id, read.read.id],
      );
  }
  return {
    store,
    run,
    capture,
    claim,
    keep,
    images: (records: RecordEntry[]) =>
      records
        .filter((record) => record.kind === 'capture')
        .map((record) => ({
          captureId: record.id,
          image:
            'data:image/png;base64,' +
            store.image(run.id, record.payload.imageFile).toString('base64'),
        })),
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('A long walk sends the driver one original screen and keeps every original action and note', () => {
  const x = setup();
  try {
    let current!: RecordEntry;
    for (let n = 0; n < 24; n++) {
      current = x.capture(n);
      const action = x.store.append(x.run.id, 'action', 'browser', { before: n, after: n + 1 }, [
        current.id,
      ]);
      x.store.append(x.run.id, 'navigator_note', 'driver', { text: 'Original note ' + n }, [
        action.id,
      ]);
    }
    const read = requestEvidence(x.store, x.run.id, 'driver', current);
    assert.deepEqual(
      read.records.filter((r) => r.kind === 'capture').map((r) => r.id),
      [current.id],
    );
    assert.equal(read.records.filter((r) => r.kind === 'action').length, 24);
    assert.equal(read.records.filter((r) => r.kind === 'navigator_note').length, 24);
    assert.equal(x.store.records(x.run.id).filter((r) => r.kind === 'capture').length, 24);
    assert(
      JSON.stringify(read.records).length < JSON.stringify(x.store.records(x.run.id)).length / 2,
    );
  } finally {
    x.close();
  }
});

test('Analyst coverage interpretations cannot masquerade as original evidence for the next role', () => {
  const x = setup();
  try {
    const source = x.capture(0);
    const derived = x.store.append(x.run.id, 'coverage', 'analyst', {
      topics: [
        { topic: 'Visual', reason: 'An unsupported interpretation from an earlier model answer.' },
      ],
    });
    const original = x.store.append(
      x.run.id,
      'coverage',
      'browser',
      {
        method: 'real_VoiceOver',
        state: 'NOT_TESTED',
      },
      [source.id],
    );
    const note = x.store.append(
      x.run.id,
      'navigator_note',
      'driver',
      { text: 'Original source-bounded walk note.' },
      [source.id],
    );
    for (const role of ['driver', 'analyst', 'reviewer'] as const) {
      const read = requestEvidence(x.store, x.run.id, role, source);
      assert(!read.records.some((r) => r.id === derived.id));
      assert(read.records.some((r) => r.id === original.id));
      assert(read.records.some((r) => r.id === note.id));
      assert(!x.store.snapshot(x.run.id, role).records.some((r) => r.id === derived.id));
    }
    assert(
      x.store.records(x.run.id).some((r) => r.id === derived.id),
      'Raw model coverage stays retained rather than rewritten or deleted.',
    );
  } finally {
    x.close();
  }
});

test('Review independently retrieves an older claim image, the complete walk and the exact analyst claim', () => {
  const x = setup();
  try {
    const first = x.capture(0);
    const observation = x.store.append(x.run.id, 'observation', 'browser', { name: '' }, [
      first.id,
    ]);
    const action = x.store.append(x.run.id, 'action', 'browser', { kind: 'press' }, [first.id]);
    const note = x.store.append(
      x.run.id,
      'navigator_note',
      'driver',
      { text: 'Keep the original limit.' },
      [action.id],
    );
    const c = x.store.append(x.run.id, 'candidate', 'analyst', x.claim(first), [observation.id]);
    for (let n = 1; n < 15; n++) x.capture(n);
    const current = x.capture(15, '#continue', x.run.url + 'basket');
    const review = requestEvidence(x.store, x.run.id, 'reviewer', current);
    for (const r of [first, observation, action, note, c, current])
      assert(review.records.some((item) => item.id === r.id && item.hash === r.hash));
    assert.equal(review.records.filter((r) => r.kind === 'capture').length, 2);
    x.store.db.prepare('UPDATE records SET body=? WHERE id=?').run('{"rewritten":true}', first.id);
    assert.throws(() => requestEvidence(x.store, x.run.id, 'reviewer', current), /changed/);
  } finally {
    x.close();
  }
});

test('Element claims require their exact stable original target; whole-view judgement remains possible', () => {
  const x = setup();
  try {
    const first = x.capture(0),
      later = x.capture(1, '#continue');
    const c = x.claim(first),
      records = x.store.records(x.run.id);
    assert.equal(candidateTarget(c, records)?.capture.id, first.id);
    assert.throws(
      () => candidateTarget({ ...c, targetCaptureId: later.id }, records),
      /exact target/,
    );
    assert.throws(() => candidateTarget({ ...c, targetId: 'invented' }, records), /exact target/);
    assert.throws(() => candidateTarget({ ...c, scope: 'view' }, records), /invent/);
    assert.equal(
      candidateTarget({ ...c, scope: 'view', targetId: null, targetCaptureId: null }, records),
      null,
    );
    assert.throws(() => candidateSchema.parse({ ...c, targetCaptureId: undefined }));
  } finally {
    x.close();
  }
});

test('Repeated accepted claims group once, retain both originals, and keep different problems and controls separate', () => {
  const x = setup();
  try {
    const first = x.capture(0),
      sameControl = x.capture(1),
      anotherControl = x.capture(2, '#remove');
    const raw = [
      x.claim(first),
      x.claim(sameControl),
      x.claim(first, 'ambiguous_visible_symbol'),
      x.claim(anotherControl),
    ];
    const candidates = raw.map((c) =>
      x.store.append(x.run.id, 'candidate', 'analyst', c, c.sources),
    );
    x.keep(candidates);
    const published = x.store.published(x.run.id);
    assert.equal(published.length, 3);
    assert.equal(published[0].occurrenceIds.length, 2);
    assert.deepEqual(published[0].evidence, [first.id, sameControl.id]);
    assert.equal(x.store.records(x.run.id).filter((r) => r.kind === 'candidate').length, 4);
    const exported = exportHostSnapshot(x.store, x.run.id).snapshot;
    assert.equal(exported.findings.length, 3);
    assert.deepEqual(exported.findings[0].captureIds, [first.id, sameControl.id]);
    assert.equal(exported.findings[0].anchor?.captureId, first.id);
  } finally {
    x.close();
  }
});

test('No supported-premise review, changed original, or changed context can inherit acceptance', () => {
  const x = setup();
  try {
    const first = x.capture(0);
    const c = x.store.append(x.run.id, 'candidate', 'analyst', x.claim(first), [first.id]);
    const read = x.store.snapshot(x.run.id, 'reviewer');
    x.store.append(
      x.run.id,
      'review',
      'reviewer',
      {
        candidateId: c.id,
        candidateHash: c.hash,
        verdict: 'keep',
        premise: 'unverified',
        readSnapshotId: read.read.id,
      },
      [first.id, c.id, read.read.id],
    );
    assert.equal(x.store.published(x.run.id).length, 0);
    x.keep([c]);
    assert.equal(x.store.published(x.run.id).length, 1);
    x.store.db.prepare('UPDATE records SET body=? WHERE id=?').run('{"rewritten":true}', first.id);
    assert.equal(x.store.published(x.run.id).length, 0);
  } finally {
    x.close();
  }
});

test('SAM uses the analyst target original, even after navigation has moved to a different screen', async () => {
  const x = setup();
  try {
    const first = x.capture(0);
    const current = x.capture(1, '#continue', x.run.url + 'basket');
    let samCalls = 0;
    const models = {
      reason: async (_run: string, role: string) =>
        role === 'analyst' ? { findings: [x.claim(first)], coverage: [] } : { decisions: [] },
      sam: async (_run: string, image: string) => {
        samCalls++;
        assert(image.endsWith(Buffer.from('test-image-0').toString('base64')));
        return {
          raw: 'saved SAM example',
          objects: [{ objectId: '1', box: first.payload.elements[0].box }],
        };
      },
    };
    const runner = new Runner(x.store, 'http://127.0.0.1:4317');
    await (runner as any).analyse(
      models,
      x.run,
      current,
      { images: x.images },
      new AbortController().signal,
    );
    assert.equal(samCalls, 1);
    const result = x.store.records(x.run.id).findLast((r) => r.kind === 'sam_mapping');
    assert.equal(result?.payload.captureId, first.id);
    assert.equal(result?.payload.match, 'geometry_matches_target');
  } finally {
    x.close();
  }
});

test('Changing only a finding title cannot approve the rest of an unsupported claim', async () => {
  const x = setup();
  try {
    const first = x.capture(0),
      c = x.store.append(x.run.id, 'candidate', 'analyst', x.claim(first), [first.id]);
    const models = {
      reason: async () => ({
        decisions: [
          {
            candidateId: c.id,
            candidateHash: c.hash,
            verdict: 'keep',
            premise: 'supported',
            title: 'A different title',
            reason: 'Only the title was changed.',
            sources: [first.id],
          },
        ],
      }),
    };
    await (new Runner(x.store, 'http://127.0.0.1:4317') as any).review(
      models,
      x.run,
      first,
      { images: x.images },
      new AbortController().signal,
      true,
    );
    assert.equal(
      x.store.records(x.run.id).findLast((r) => r.kind === 'review')?.payload.verdict,
      'rewrite',
    );
    assert.deepEqual(x.store.published(x.run.id), []);
  } finally {
    x.close();
  }
});

test('An incomplete analysis cannot abort an otherwise safe continuing walk or invent a finding', async () => {
  const x = setup();
  try {
    let decisions = 0,
      analyses = 0,
      captures = 0;
    const original = x.capture(captures++);
    mock.method(MetaModels.prototype, 'reason', async (_id: string, role: string) => {
      if (role === 'driver')
        return {
          kind: ++decisions <= 3 ? 'press' : 'finish',
          key: 'Tab',
          note: 'Original safe action.',
        };
      if (role === 'analyst') {
        if (++analyses === 1) throw new IncompleteModelResult('analyst');
        return { findings: [], coverage: [] };
      }
      throw Error('An empty candidate list must not request a reviewer.');
    });
    const walk = {
      assertActive() {},
      images: x.images,
      act: async (_action: any, source: RecordEntry) =>
        x.store.append(x.run.id, 'action', 'browser', { performed: true }, [source.id]),
      captureSettled: async () => x.capture(captures++),
      measurements: async (source: RecordEntry) =>
        x.store.append(x.run.id, 'observation', 'browser', { measured: true }, [source.id]),
    };
    await (new Runner(x.store, 'http://127.0.0.1:4317') as any).live(
      x.run,
      walk,
      {},
      original,
      new AbortController(),
    );
    assert.equal(decisions, 4);
    assert.equal(analyses, 2);
    assert.equal(x.store.records(x.run.id).filter((r) => r.kind === 'action').length, 3);
    assert(
      x.store
        .records(x.run.id)
        .some(
          (r) => r.kind === 'limit' && r.payload.reason.includes('checkpoint remains incomplete'),
        ),
    );
    assert.deepEqual(x.store.published(x.run.id), []);
    assert.equal(x.store.usage(x.run.id).requests.length, 0);
  } finally {
    mock.restoreAll();
    x.close();
  }
});

test('A stale navigation decision is discarded before input and the next decision reads the refreshed original', async () => {
  const x = setup();
  try {
    const original = x.capture(0),
      fresh = x.capture(1);
    const readIds: string[] = [];
    let decisions = 0,
      attempted = 0,
      captures = 0;
    mock.method(
      MetaModels.prototype,
      'reason',
      async (_id: string, role: string, records: RecordEntry[]) => {
        if (role === 'driver') {
          readIds.push(records.findLast((record) => record.kind === 'capture')!.id);
          return {
            kind: ++decisions === 1 ? 'press' : 'finish',
            key: 'Tab',
            note: 'Controlled decision',
          };
        }
        if (role === 'analyst') return { findings: [], coverage: [] };
        throw Error('No accepted finding needs review.');
      },
    );
    const walk = {
      assertActive() {},
      images: x.images,
      async act() {
        attempted++;
        throw new ActionStateChanged('Changed before input');
      },
      async captureSettled() {
        captures++;
        return fresh;
      },
    };
    await (new Runner(x.store, 'http://127.0.0.1:4317') as any).live(
      x.run,
      walk,
      {},
      original,
      new AbortController(),
    );
    assert.deepEqual(readIds, [original.id, fresh.id]);
    assert.equal(attempted, 1);
    assert.equal(captures, 1);
    assert.equal(x.store.records(x.run.id).filter((record) => record.kind === 'action').length, 0);
  } finally {
    mock.restoreAll();
    x.close();
  }
});

test('Exhausted observation recovery stops before further model work, including final review', async () => {
  const x = setup();
  try {
    const original = x.capture(0);
    const roles: string[] = [];
    mock.method(MetaModels.prototype, 'reason', async (_id: string, role: string) => {
      roles.push(role);
      return { kind: 'press', key: 'Tab', note: 'Controlled input' };
    });
    const runner = new Runner(x.store, 'http://127.0.0.1:4317');
    let reviews = 0;
    (runner as any).review = async () => {
      reviews++;
    };
    const walk = {
      assertActive() {},
      images: x.images,
      async act() {
        return x.store.append(x.run.id, 'action', 'browser', { performed: true }, [original.id]);
      },
      async captureSettled() {
        throw new ObservationUnsettled('Three observations did not settle');
      },
    };
    await assert.rejects(
      (runner as any).live(x.run, walk, {}, original, new AbortController()),
      ObservationUnsettled,
    );
    assert.deepEqual(roles, ['driver']);
    assert.equal(reviews, 0);
    assert.equal(x.store.records(x.run.id).filter((record) => record.kind === 'action').length, 1);
  } finally {
    mock.restoreAll();
    x.close();
  }
});

test('Repeated focus-navigation without progress stops early as a robot limit, not a site finding', async () => {
  const x = setup();
  try {
    let decisions = 0;
    const screen = () =>
      x.store.append(x.run.id, 'capture', 'browser', {
        ...x.capture(decisions + 100).payload,
        stateStamp: 'unchanged-original-state',
      });
    const initial = screen();
    mock.method(MetaModels.prototype, 'reason', async (_id: string, role: string) => {
      if (role === 'driver') {
        decisions++;
        return { kind: 'press', key: 'Tab', note: 'Try forward navigation.' };
      }
      if (role === 'analyst') return { findings: [], coverage: [] };
      throw Error('No finding means no reviewer request.');
    });
    const walk = {
      assertActive() {},
      images: x.images,
      act: async (_action: any, source: RecordEntry) =>
        x.store.append(x.run.id, 'action', 'browser', { performed: true }, [source.id]),
      captureSettled: async () => screen(),
      measurements: async () => {
        throw Error('Repeated blocked navigation should stop before the normal checkpoint.');
      },
    };
    await (new Runner(x.store, 'http://127.0.0.1:4317') as any).live(
      x.run,
      walk,
      {},
      initial,
      new AbortController(),
    );
    assert.equal(decisions, 3);
    assert(
      x.store
        .records(x.run.id)
        .some(
          (r) =>
            r.kind === 'limit' &&
            r.payload.reason.includes('does not establish a website keyboard barrier'),
        ),
    );
    assert.deepEqual(x.store.published(x.run.id), []);
  } finally {
    mock.restoreAll();
    x.close();
  }
});
