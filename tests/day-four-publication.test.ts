import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Runner } from '../src/runner.js';
import { candidateSchema } from '../src/models.js';
import { exportHostSnapshot } from '../src/host-export.js';
import { makeImageReceipt } from '../src/image-receipt.js';
import { recordAnalysisDetails, visualCandidateSources } from '../src/assessment.js';
import { requestEvidence } from '../src/request-evidence.js';
import { suppliedImageIds } from '../src/image-receipt.js';
import { candidateTarget } from '../src/candidate-target.js';
import { digest } from '../src/store.js';
import type { RecordEntry } from '../src/types.js';

// Saved responses prove the publication contract, not provider authenticity or semantic accuracy.
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'access-walk-day-four-publication-'));
  const store = new Store(dir);
  const run = store.create(
    'Controlled publication contract',
    'http://127.0.0.1:4317/shop/',
    'offline',
  );
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aAZkAAAAASUVORK5CYII=',
    'base64',
  );
  function capture(n: number, text: string) {
    const image = store.asset(run.id, `capture_${n}.png`, png);
    return store.append(run.id, 'capture', 'browser', {
      imageFile: image.file,
      imageHash: image.hash,
      url: run.url,
      title: 'Controlled shop',
      text,
      stable: true,
      width: 1,
      height: 1,
      limits: { imageScope: 'viewport', visibleTextTruncated: false },
      imageProvenance: { source: 'Browser-rendered page viewport', engineAddedAnnotations: false },
      elements: [
        {
          id: 'e0',
          selector: '#add',
          contextFingerprint: 'a'.repeat(64),
          tag: 'button',
          role: 'button',
          name: '',
          text: '+',
          type: '',
          box: { x: 0, y: 0, width: 1, height: 1 },
        },
      ],
    });
  }
  const before = capture(1, 'Canvas bag +');
  const measured = store.append(
    run.id,
    'observation',
    'browser',
    {
      method: 'automatic_accessibility_scan',
      stable: true,
      sourceCaptureId: before.id,
      sourceCaptureHash: before.hash,
      sourceImageHash: before.payload.imageHash,
      facts: {
        schema: 'access-walk/facts-v1',
        captureId: before.id,
        controls: [{ elementId: 'e0', selector: '#add', role: 'button', name: '' }],
      },
    },
    [before.id],
  );
  const action = store.append(
    run.id,
    'action',
    'browser',
    {
      method: 'actual_keyboard_or_browser',
      outcome: 'performed',
      sourceCaptureId: before.id,
      sourceImageHash: before.payload.imageHash,
      action: { kind: 'press', key: 'Enter' },
      before: { id: 'add', tag: 'button', name: '' },
      after: { tag: 'button', name: 'Open basket' },
      waitAfterMs: 180,
    },
    [before.id],
  );
  const after = capture(2, 'Added to your basket.');
  const sources = [before.id, measured.id, action.id, after.id];
  const content = candidateSchema.parse({
    issueKey: 'add_button_no_accessible_name',
    scope: 'element',
    visiblePremise: 'The original browser scan exposes an empty name for the Add button.',
    title: 'The Add button has no programmatic name',
    detail:
      'The original scan exposes an empty name for #add. The recorded Enter action added the bag, so keyboard activation succeeded. Assistive technology may lack a useful label; no native screen-reader announcement was measured.',
    criterion: 'C02',
    basis: 'measured',
    severity: 'serious',
    sources,
    targetCaptureId: before.id,
    targetId: 'e0',
    recommendation: 'Give the button a useful programmatic name such as Add canvas bag to basket.',
  });
  const candidate = (changes: Partial<typeof content> & Record<string, unknown> = {}) => {
    const value = { ...content, ...changes };
    return store.append(run.id, 'candidate', 'analyst', value, value.sources);
  };
  function keepStored(candidate: RecordEntry, changes: Record<string, unknown> = {}) {
    const read = store.snapshot(
      run.id,
      'reviewer',
      undefined,
      makeImageReceipt(store.records(run.id), after.id),
    ).read;
    const originalSources = candidate.sources.filter(
      (id) => store.record(run.id, id)?.kind !== 'visual_observation',
    );
    return store.append(
      run.id,
      'review',
      'reviewer',
      {
        candidateId: candidate.id,
        candidateHash: candidate.hash,
        verdict: 'keep',
        premise: 'supported',
        title: candidate.payload.title,
        reason: 'Direct retained-record validation fixture.',
        sources: originalSources,
        readSnapshotId: read.id,
        readSnapshotHash: read.hash,
        provenance: 'saved-example',
        ...changes,
      },
      [...originalSources, candidate.id, read.id],
    );
  }
  const runner = new Runner(store, 'http://127.0.0.1:4317');
  async function review(
    decide: (candidate: RecordEntry) => { verdict: 'keep' | 'rewrite' | 'reject'; title?: string },
  ) {
    let calls = 0;
    const models = {
      reason: async (
        _id: string,
        role: string,
        records: RecordEntry[],
        images: any[],
        schema: any,
        final: boolean,
      ) => {
        calls++;
        assert.equal(role, 'reviewer');
        assert.equal(final, true);
        for (const original of [before, measured, action, after])
          assert(
            records.some((record) => record.id === original.id && record.hash === original.hash),
          );
        assert.deepEqual(
          new Set(images.map((image) => image.captureId)),
          new Set([before.id, after.id]),
        );
        return schema.parse({
          decisions: records
            .filter((record) => record.kind === 'candidate')
            .map((record) => {
              const decision = decide(record);
              return {
                candidateId: record.id,
                candidateHash: record.hash,
                verdict: decision.verdict,
                premise: 'supported',
                title: decision.title ?? record.payload.title,
                reason:
                  decision.verdict === 'keep'
                    ? 'Saved independent response supports this exact bounded claim and its original sources.'
                    : 'Saved response requires correction: Enter succeeded and no actual speech was recorded.',
                sources,
              };
            }),
          criterionDecisions: [],
        });
      },
    };
    const walk = {
      images: (records: RecordEntry[]) =>
        records
          .filter((record) => record.kind === 'capture')
          .map((record) => ({
            captureId: record.id,
            image: `data:image/png;base64,${store.image(run.id, record.payload.imageFile).toString('base64')}`,
          })),
    };
    await (runner as any).review(models, run, after, walk, AbortSignal.timeout(1000), true);
    assert.equal(calls, 1);
  }
  return {
    store,
    run,
    before,
    after,
    measured,
    action,
    sources,
    content,
    png,
    candidate,
    keepStored,
    review,
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('A corrected finding is a distinct reviewed version before unchanged host-v1 delivery', async () => {
  const x = fixture();
  try {
    const old = x.candidate({
      title: 'The Add button blocks keyboard checkout',
      detail: 'A screen-reader user hears no purpose and keyboard checkout is blocked.',
    });
    const retainedOld = JSON.stringify(old);
    await x.review(() => ({ verdict: 'rewrite' }));
    assert.deepEqual(x.store.published(x.run.id), []);
    assert.deepEqual(exportHostSnapshot(x.store, x.run.id).snapshot.findings, []);

    // Altering a review title cannot remove the old body's unsupported hearing/keyboard words.
    await x.review(() => ({ verdict: 'keep', title: x.content.title }));
    const titleOnly = x.store
      .records(x.run.id)
      .filter((record) => record.kind === 'review')
      .at(-1)!;
    assert.equal(titleOnly.payload.verdict, 'rewrite');
    assert.deepEqual(exportHostSnapshot(x.store, x.run.id).snapshot.findings, []);

    const corrected = x.candidate();
    assert.notEqual(corrected.id, old.id);
    assert.notEqual(corrected.hash, old.hash);
    assert.deepEqual(x.store.published(x.run.id), []);
    await x.review((record) => ({ verdict: record.id === corrected.id ? 'keep' : 'rewrite' }));
    x.store.finish(x.run.id, 'partial', 'Untested criteria remain explicit.');

    const { snapshot, assets } = exportHostSnapshot(x.store, x.run.id);
    assert.equal(snapshot.protocol, 'access-walk/host-v1');
    assert.equal(snapshot.run.state, 'partial');
    assert.equal(snapshot.findings.length, 1);
    const finding = snapshot.findings[0];
    const review = x.store
      .records(x.run.id)
      .filter((record) => record.kind === 'review' && record.payload.candidateId === corrected.id)
      .at(-1)!;
    const read = x.store.record(x.run.id, review.payload.readSnapshotId)!;
    assert.equal(finding.id, corrected.id);
    assert.equal(finding.candidateHash, corrected.hash);
    assert.equal(finding.reviewHash, review.hash);
    assert.equal(finding.reviewProvenance, 'saved-example');
    assert.equal(finding.title, x.content.title);
    assert.equal(finding.detail, x.content.detail);
    assert.deepEqual(finding.sourceIds, x.sources);
    assert.deepEqual(finding.captureIds, [x.before.id, x.after.id]);
    assert.equal(finding.anchor?.captureId, x.before.id);
    assert.equal(finding.anchor?.elementId, 'e0');
    for (const source of x.sources) {
      const original = x.store.record(x.run.id, source)!;
      const pin = read.payload.records.find((entry: any) => entry.id === source);
      assert.equal(pin.hash, original.hash);
      assert.deepEqual(pin.sources, original.sources);
    }
    for (const capture of snapshot.captures) assert.deepEqual(assets.get(capture.imageFile), x.png);
    assert.equal(snapshot.coverage.score, null);
    assert.equal(JSON.stringify(x.store.record(x.run.id, old.id)), retainedOld);
  } finally {
    x.close();
  }
});

test('Later original evidence withdraws a finding until a fresh exact review reads it', async () => {
  const x = fixture();
  try {
    const corrected = x.candidate();
    await x.review(() => ({ verdict: 'keep' }));
    const initial = exportHostSnapshot(x.store, x.run.id).snapshot;
    assert.equal(initial.findings[0].id, corrected.id);
    const raw = JSON.stringify(x.store.record(x.run.id, corrected.id));

    const later = x.store.append(
      x.run.id,
      'navigator_note',
      'driver',
      {
        text: 'A later original walk note must be available to the next reviewer.',
      },
      [x.after.id],
    );
    assert.deepEqual(x.store.published(x.run.id), []);
    const stale = exportHostSnapshot(x.store, x.run.id).snapshot;
    assert.deepEqual(stale.findings, []);
    assert(stale.sequence > initial.sequence);

    await x.review(() => ({ verdict: 'keep' }));
    const fresh = exportHostSnapshot(x.store, x.run.id).snapshot;
    assert.equal(fresh.findings.length, 1);
    assert.equal(fresh.findings[0].id, corrected.id);
    assert.equal(fresh.findings[0].candidateHash, corrected.hash);
    assert.notEqual(fresh.findings[0].reviewHash, initial.findings[0].reviewHash);
    const review = x.store
      .records(x.run.id)
      .filter((record) => record.kind === 'review')
      .at(-1)!;
    const read = x.store.record(x.run.id, review.payload.readSnapshotId)!;
    assert(read.payload.throughSeq >= later.seq);
    assert(read.payload.records.some((pin: any) => pin.id === later.id && pin.hash === later.hash));
    assert.equal(JSON.stringify(x.store.record(x.run.id, corrected.id)), raw);
    assert.equal(x.store.usage(x.run.id).requests.length, 0);
  } finally {
    x.close();
  }
});

test('Publication requires an actual reviewer read while intended legacy saved reviews remain valid', () => {
  for (const withReceipt of [false, true])
    for (const role of ['reviewer', 'analyst'] as const) {
      const x = fixture();
      try {
        const candidate = x.candidate();
        const receipt = withReceipt
          ? makeImageReceipt(x.store.records(x.run.id), x.after.id)
          : undefined;
        const read = x.store.snapshot(x.run.id, role, undefined, receipt).read;
        x.store.append(
          x.run.id,
          'review',
          'saved_reviewer_response',
          {
            candidateId: candidate.id,
            candidateHash: candidate.hash,
            verdict: 'keep',
            premise: 'supported',
            title: candidate.payload.title,
            reason: 'Controlled saved review role-boundary fixture.',
            sources: x.sources,
            readSnapshotId: read.id,
            ...(withReceipt ? { readSnapshotHash: read.hash } : {}),
          },
          [...x.sources, candidate.id, read.id],
        );
        const published = x.store.published(x.run.id);
        assert.equal(
          published.length,
          role === 'reviewer' ? 1 : 0,
          `A ${withReceipt ? 'receipt-pinned' : 'legacy'} ${role} read cannot change roles.`,
        );
        const host = exportHostSnapshot(x.store, x.run.id).snapshot;
        assert.equal(host.findings.length, published.length);
        if (host.findings[0]) assert.equal(host.findings[0].reviewProvenance, 'saved-example');
      } finally {
        x.close();
      }
    }
});

test('An explicit analyst read must pin every original finding dependency, including later measurements and rewritten source links', () => {
  for (const damage of ['missing', 'newer', 'source-rewritten'] as const) {
    const x = fixture();
    try {
      const ids = x.store
        .records(x.run.id)
        .filter((record) => damage === 'source-rewritten' || record.id !== x.measured.id)
        .map((record) => record.id);
      const analyst = x.store.snapshot(
        x.run.id,
        'analyst',
        ids,
        makeImageReceipt(x.store.records(x.run.id), x.after.id),
      ).read;
      let sources = x.sources;
      if (damage === 'newer') {
        const newer = x.store.append(
          x.run.id,
          'observation',
          'browser',
          { stable: true, method: 'later_control_measurement' },
          [x.before.id],
        );
        sources = [x.before.id, newer.id, x.action.id, x.after.id];
      }
      if (damage === 'source-rewritten') {
        const links = [x.before.id, x.after.id];
        const payload = { ...x.measured.payload, _sourcesHash: digest(JSON.stringify(links)) };
        x.store.db
          .prepare('UPDATE records SET body=?,hash=?,sources=? WHERE id=?')
          .run(
            JSON.stringify(payload),
            digest(JSON.stringify(payload)),
            JSON.stringify(links),
            x.measured.id,
          );
      }
      const candidate = x.candidate({
        sources,
        analystReadSnapshotId: analyst.id,
        analystReadSnapshotHash: analyst.hash,
      });
      x.keepStored(candidate);
      assert.equal(x.store.published(x.run.id).length, 0, damage);
      assert.equal(exportHostSnapshot(x.store, x.run.id).snapshot.findings.length, 0, damage);
    } finally {
      x.close();
    }
  }
});

test('An engine-created visual observation may follow its read while its original sources remain exact', async () => {
  const x = fixture();
  try {
    const analyst = requestEvidence(x.store, x.run.id, 'analyst', x.after);
    const images = suppliedImageIds(analyst.read, analyst.records);
    const premise = 'The Add control uses a plus sign beside visible product context.';
    const observations = recordAnalysisDetails(x.store, x.run.id, analyst, images, {
      visualObservations: [
        {
          captureId: x.before.id,
          topic: 'affordances',
          visiblePremise: premise,
          interpretation: 'A written action label could explain the control more clearly.',
          taskConcern: 'The controlled task is to add the canvas bag.',
          recommendation: 'Consider a visible Add to basket label.',
          limits: ['Saved contract fixture only, not model accuracy or a usability study.'],
          sources: [x.before.id, x.measured.id],
        },
      ],
    });
    const value = {
      ...x.content,
      criterion: null,
      basis: 'expert_visual',
      visiblePremise: premise,
      visualTopic: 'affordances',
      visualObservationIndex: 0,
    };
    candidateTarget(value, analyst.records, images);
    const bound = visualCandidateSources(value, observations);
    const candidate = x.candidate({
      ...value,
      sources: bound.sources,
      visualObservationId: bound.visualObservationId,
      analystReadSnapshotId: analyst.read.id,
      analystReadSnapshotHash: analyst.read.hash,
    } as any);
    assert(observations.get(0)!.seq > analyst.read.seq);
    assert(!analyst.read.payload.records.some((pin: any) => pin.id === observations.get(0)!.id));
    await x.review(() => ({ verdict: 'keep' }));
    const published = x.store.published(x.run.id);
    assert.equal(published.length, 1);
    assert.equal(published[0].id, candidate.id);
    assert.equal(
      exportHostSnapshot(x.store, x.run.id).snapshot.findings[0].candidateHash,
      candidate.hash,
    );
  } finally {
    x.close();
  }
});

test('A visual interpretation cannot cite an original absent from its own analyst read', () => {
  const x = fixture();
  try {
    const beforeIds = x.store
      .records(x.run.id)
      .filter((record) => record.id !== x.measured.id)
      .map((record) => record.id);
    const visualRead = x.store.snapshot(
      x.run.id,
      'analyst',
      beforeIds,
      makeImageReceipt(x.store.records(x.run.id), x.after.id),
    ).read;
    const premise = 'The Add control uses a plus sign beside visible product context.';
    const visual = x.store.append(
      x.run.id,
      'visual_observation',
      'analyst',
      {
        captureId: x.before.id,
        topic: 'affordances',
        visiblePremise: premise,
        readSnapshotId: visualRead.id,
        readSnapshotHash: visualRead.hash,
      },
      [x.before.id, x.measured.id],
    );
    const candidateRead = x.store.snapshot(
      x.run.id,
      'analyst',
      undefined,
      makeImageReceipt(x.store.records(x.run.id), x.after.id),
    ).read;
    const candidate = x.candidate({
      visualObservationId: visual.id,
      visualTopic: 'affordances',
      basis: 'expert_visual',
      visiblePremise: premise,
      sources: [...x.sources, visual.id],
      analystReadSnapshotId: candidateRead.id,
      analystReadSnapshotHash: candidateRead.hash,
    });
    x.keepStored(candidate);
    assert.equal(x.store.published(x.run.id).length, 0);
  } finally {
    x.close();
  }
});

test('A direct kept title change cannot replace a new exact finding version, preserving legacy title behavior', () => {
  for (const legacy of [false, true]) {
    const x = fixture();
    try {
      const candidate = x.candidate(legacy ? { issueKey: undefined } : {});
      x.keepStored(candidate, {
        title: 'A different title never present in this candidate version',
      });
      const published = x.store.published(x.run.id);
      assert.equal(published.length, legacy ? 1 : 0);
      if (legacy)
        assert.equal(
          published[0].title,
          'A different title never present in this candidate version',
        );
    } finally {
      x.close();
    }
  }
});
