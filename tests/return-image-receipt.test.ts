import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Store, digest } from '../src/store.js';
import { Runner } from '../src/runner.js';
import { MetaModels, analysisSchema } from '../src/models.js';
import { candidateTarget } from '../src/candidate-target.js';
import {
  assessmentForRun,
  declareCriterionScopes,
  recordAnalysisDetails,
} from '../src/assessment.js';
import { CRITERIA_VERSION, evaluateCriteria } from '../src/criteria.js';
import { requestEvidence } from '../src/request-evidence.js';
import { imageRecordsForRead, suppliedImageIds } from '../src/image-receipt.js';
import type { RecordEntry } from '../src/types.js';
import { BrowserWalk } from '../src/browser.js';
import { ReturnEvidence } from '../src/journey-evidence.js';

// Four distinct valid PNGs, made here solely as instrumentation, not visual UX evidence.
function png(red: number) {
  const chunk = (name: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(name), data]);
    let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const length = Buffer.alloc(4),
      checksum = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, red, 0, 0, 255]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function fixture(preserved = true) {
  const dir = mkdtempSync(join(tmpdir(), 'access-walk-return-images-'));
  const store = new Store(dir);
  const run = store.create(
    'Controlled return receipt instrumentation',
    'http://127.0.0.1:4317/form',
    'offline',
  );
  let n = 0;
  const capture = (url = run.url) => {
    const image = store.asset(run.id, `capture_${++n}.png`, png(n * 20));
    return store.append(run.id, 'capture', 'browser', {
      stable: true,
      stateStamp: digest('controlled-state-' + n),
      url,
      imageFile: image.file,
      imageHash: image.hash,
      width: 1,
      height: 1,
      text: 'Controlled form. Continue and return.',
      elements: [
        { id: 'email', selector: '#email', tag: 'input', type: 'email', name: 'Email address' },
      ],
      limits: { imageScope: 'viewport', visibleTextTruncated: false },
      imageProvenance: { source: 'Browser-rendered page viewport', engineAddedAnnotations: false },
    });
  };
  const beforeType = capture();
  const typed = store.append(
    run.id,
    'action',
    'browser',
    {
      method: 'actual_keyboard_or_browser',
      outcome: 'performed',
      sourceCaptureId: beforeType.id,
      sourceImageHash: beforeType.payload.imageHash,
      action: { kind: 'type', text: 'test@example.org' },
      before: { id: 'email', tag: 'input', type: 'email' },
    },
    [beforeType.id],
  );
  const entry = capture();
  const baseline = store.append(
    run.id,
    'observation',
    'browser',
    {
      method: 'return_entry_baseline',
      version: 'journey-evidence/1',
      stable: true,
      sourceCaptureId: entry.id,
      typedActionId: typed.id,
      fieldId: 'email',
      baselineRecorded: true,
    },
    [beforeType.id, typed.id, entry.id],
  );
  const beforeBack = capture(run.url + '/review');
  const back = store.append(
    run.id,
    'action',
    'browser',
    {
      method: 'actual_keyboard_or_browser',
      outcome: 'performed',
      sourceCaptureId: beforeBack.id,
      sourceImageHash: beforeBack.payload.imageHash,
      action: { kind: 'back' },
      before: { tag: 'body' },
    },
    [beforeBack.id],
  );
  const current = capture();
  const comparison = store.append(
    run.id,
    'observation',
    'browser',
    {
      method: 'return_preservation',
      version: 'journey-evidence/1',
      stable: true,
      beforeCaptureId: beforeBack.id,
      afterCaptureId: current.id,
      actionId: back.id,
      returned: true,
      entriesCompared: true,
      preserved,
      fieldId: 'email',
      entryCaptureId: entry.id,
      typedActionId: typed.id,
    },
    [beforeBack.id, back.id, current.id, baseline.id, entry.id, typed.id],
  );
  declareCriterionScopes(store, run.id);
  const images = (records: RecordEntry[]) =>
    records
      .filter((r) => r.kind === 'capture')
      .map((r) => ({
        captureId: r.id,
        image:
          'data:image/png;base64,' + store.image(run.id, r.payload.imageFile).toString('base64'),
      }));
  const report = () =>
    evaluateCriteria(store.records(run.id), run.id, {
      imageAvailable(capture) {
        store.image(run.id, capture.payload.imageFile);
        return true;
      },
    });
  const change = (record: RecordEntry, patch: object) => {
    const payload = { ...record.payload, ...patch },
      body = JSON.stringify(payload);
    store.db
      .prepare('UPDATE records SET body=?,hash=? WHERE id=?')
      .run(body, digest(body), record.id);
  };
  return {
    dir,
    store,
    run,
    capture,
    images,
    report,
    change,
    beforeType,
    typed,
    entry,
    baseline,
    beforeBack,
    back,
    current,
    comparison,
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

for (const preserved of [true, false])
  test(`Ordinary C15 ${preserved ? 'preserved' : 'lost'} uses three actual analyst images, four raw captures and independent review`, async () => {
    const x = fixture(preserved);
    try {
      const originals = x.store.records(x.run.id).filter((r) => r.kind !== 'criterion_scope');
      const calls: { role: string; body: any }[] = [];
      const model = new MetaModels(
        x.store,
        (async (url, init) => {
          const body = JSON.parse(String(init?.body)),
            role = body.text.format.name;
          calls.push({ role, body });
          if (String(url).endsWith('/input_tokens')) return Response.json({ input_tokens: 100 });
          let result: any;
          if (role === 'analyst_result')
            result = {
              findings: [],
              coverage: [],
              visualObservations: [],
              missingEvidence: [],
              criterionProposals: [
                {
                  captureId: x.current.id,
                  criterionId: 'C15',
                  verdict: preserved ? 'PASS' : 'FAIL',
                  reason:
                    'The original compared entry was preserved/lost in this controlled fixture.',
                  sources: [x.comparison.id],
                  missingEvidence: [],
                  screenReaderClaimed: false,
                },
              ],
            };
          else {
            assert.equal(
              x
                .report()
                .results.find((r) => r.id === 'C15')!
                .checks.find((c) => c.captureId === x.current.id)!.complete,
              false,
              'No criterion settles before independent review',
            );
            const proposal = x.store
              .records(x.run.id)
              .find((r) => r.kind === 'criterion_proposal')!;
            result = {
              decisions: [],
              criterionDecisions: [
                {
                  proposalId: proposal.id,
                  proposalHash: proposal.hash,
                  verdict: 'keep',
                  premise: 'supported',
                  reason: 'Independently read the exact original comparison and all pictures.',
                  sources: [x.comparison.id],
                },
              ],
            };
          }
          return Response.json({
            status: 'completed',
            usage: { input_tokens: 100, output_tokens: 50 },
            output_text: JSON.stringify(result),
          });
        }) as typeof fetch,
        () => ({
          approvedBy: 'Adriano',
          maxUsd: 3,
          maxRunUsd: 3,
          approvedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
        () => 'mock-key-no-provider-access',
      );
      await (new Runner(x.store, 'http://127.0.0.1:4317') as any).analyseCheckpoint(
        model,
        x.run,
        x.current,
        { images: x.images },
        new AbortController().signal,
      );
      assert.equal(
        calls.length,
        4,
        'One count and one generation per existing analyst/reviewer role',
      );
      for (const [role, imageCount] of [
        ['analyst_result', 3],
        ['reviewer_result', 4],
      ] as const) {
        const body = calls.find((call) => call.role === role)!.body;
        assert.equal(
          body.input[0].content.filter((part: any) => part.type === 'input_image').length,
          imageCount,
        );
        const sent = JSON.parse(body.input[0].content[0].text);
        assert.equal(sent.filter((r: any) => r.kind === 'capture').length, 4);
        for (const original of originals) {
          const record = sent.find((r: any) => r.id === original.id);
          assert.deepEqual(record, original, 'Raw originals, hashes and source pins are unchanged');
        }
      }
      const reads = x.store.records(x.run.id).filter((r) => r.kind === 'read_snapshot');
      const analyst = reads.find((r) => r.author === 'analyst')!;
      assert.equal(analyst.payload.imageReceipt.recordsOnly[0].captureId, x.beforeType.id);
      assert.deepEqual(suppliedImageIds(analyst, x.store.records(x.run.id)), [
        x.entry.id,
        x.beforeBack.id,
        x.current.id,
      ]);
      const check = x
        .report()
        .results.find((r) => r.id === 'C15')!
        .checks.find((c) => c.captureId === x.current.id)!;
      assert.equal(check.verdict, preserved ? 'PASS' : 'FAIL');
      assert.equal(check.complete, true);
      assert.equal(x.report().score, null);
      assert.equal(
        new Set([x.beforeType, x.entry, x.beforeBack, x.current].map((r) => r.payload.imageHash))
          .size,
        4,
        'No image alias or relabel was used',
      );
      assert.equal(x.store.records(x.run.id).filter((r) => r.kind === 'action').length, 2);
      const originalReceipt = analyst.payload.imageReceipt;
      x.change(analyst, { imageReceipt: { ...originalReceipt, version: 'corrupt-receipt' } });
      assert.equal(
        x
          .report()
          .results.find((r) => r.id === 'C15')!
          .checks.find((c) => c.captureId === x.current.id)!.complete,
        false,
        'A changed analyst receipt cannot retain an accepted criterion',
      );
      x.change(analyst, { imageReceipt: originalReceipt });
      const reviewer = reads.find((r) => r.author === 'reviewer')!;
      x.change(reviewer, {
        imageReceipt: {
          ...reviewer.payload.imageReceipt,
          supplied: reviewer.payload.imageReceipt.supplied.slice(1),
        },
      });
      assert.equal(
        x
          .report()
          .results.find((r) => r.id === 'C15')!
          .checks.find((c) => c.captureId === x.current.id)!.complete,
        false,
        'The reviewer must still receive every required image',
      );
      assert.equal(calls.length, 4, 'Receipt failures never request additional reasoning');
    } finally {
      x.close();
    }
  });

test('Only a complete exact approved nonvisual baseline earns the single records-only image', () => {
  for (const damage of [
    'field',
    'typed-value',
    'order',
    'missing-baseline',
    'comparison',
    'image',
    'independent-measurement',
    'visual-target',
    'extra-picture',
  ] as const) {
    const x = fixture();
    try {
      if (damage === 'field') x.change(x.baseline, { fieldId: 'other-field' });
      if (damage === 'typed-value')
        x.change(x.typed, { action: { kind: 'type', text: 'not-approved' } });
      if (damage === 'order')
        x.store.db.prepare('UPDATE records SET seq=0 WHERE id=?').run(x.baseline.id);
      if (damage === 'missing-baseline')
        x.store.db.prepare('DELETE FROM records WHERE id=?').run(x.baseline.id);
      if (damage === 'comparison') x.change(x.comparison, { entriesCompared: false });
      if (damage === 'image')
        writeFileSync(
          join(x.dir, x.run.id, x.beforeType.payload.imageFile),
          Buffer.from('changed image'),
        );
      if (damage === 'independent-measurement')
        x.store.append(
          x.run.id,
          'observation',
          'browser',
          { stable: true, method: 'separate_visual_check' },
          [x.beforeType.id, x.current.id],
        );
      if (damage === 'visual-target')
        x.store.append(
          x.run.id,
          'candidate',
          'analyst',
          { targetCaptureId: x.beforeType.id, basis: 'expert_visual' },
          [x.beforeType.id],
        );
      if (damage === 'extra-picture') {
        const extra = x.capture(x.run.url + '/extra');
        x.store.append(
          x.run.id,
          'observation',
          'browser',
          { stable: true, method: 'other_context' },
          [x.current.id, extra.id],
        );
      }
      assert.throws(
        () => requestEvidence(x.store, x.run.id, 'analyst', x.current),
        (error) => error instanceof Error,
        damage,
      );
      assert.equal(
        x.store.records(x.run.id).filter((r) => r.kind === 'read_snapshot').length,
        0,
        damage,
      );
      assert.equal(x.store.usage(x.run.id).requests.length, 0);
    } finally {
      x.close();
    }
  }
});

test('Legacy reads still require all selected pictures and malformed new receipts cannot imply omission', async () => {
  const x = fixture();
  try {
    const packet = requestEvidence(x.store, x.run.id, 'analyst', x.current);
    const legacy = x.store.snapshot(
      x.run.id,
      'analyst',
      packet.records.map((r) => r.id),
    );
    assert.equal(imageRecordsForRead(legacy).length, 4);
    const model = new MetaModels(
      x.store,
      (async () => {
        throw Error('No request may be sent');
      }) as typeof fetch,
      () => ({
        approvedBy: 'Adriano',
        maxUsd: 3,
        maxRunUsd: 3,
        approvedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
      () => 'mock-key',
    );
    await assert.rejects(
      model.reason(
        x.run.id,
        'analyst',
        legacy.records,
        x.images(imageRecordsForRead(packet)),
        analysisSchema,
        false,
        new AbortController().signal,
        legacy.read,
      ),
      /do not match/,
    );
    for (const damage of [
      'version',
      'missing-image',
      'duplicate',
      'wrong-hash',
      'wrong-baseline',
      'reviewer',
    ] as const) {
      const receipt = structuredClone(packet.read.payload.imageReceipt);
      if (damage === 'version') receipt.version = 'unknown';
      if (damage === 'missing-image') receipt.supplied.pop();
      if (damage === 'duplicate') receipt.supplied.push(receipt.supplied[0]);
      if (damage === 'wrong-hash') receipt.recordsOnly[0].imageHash = '0'.repeat(64);
      if (damage === 'wrong-baseline') receipt.recordsOnly[0].baselineId = 'foreign-baseline';
      const read = x.store.snapshot(
        x.run.id,
        damage === 'reviewer' ? 'reviewer' : 'analyst',
        packet.records.map((r) => r.id),
        receipt,
      );
      assert.throws(
        () => imageRecordsForRead(read),
        (error) => error instanceof Error,
        damage,
      );
    }
    assert.equal(x.store.usage(x.run.id).requests.length, 0);
  } finally {
    x.close();
  }
});

test('Unsupplied baseline images cannot receive a visual finding, observation or criterion assessment', () => {
  const x = fixture();
  try {
    const packet = requestEvidence(x.store, x.run.id, 'analyst', x.current);
    const imageIds = suppliedImageIds(packet.read, packet.records);
    const beforeScope = x.store
      .records(x.run.id)
      .find((r) => r.kind === 'criterion_scope' && r.payload.captureId === x.beforeType.id)!;
    const withScope = x.store.snapshot(
      x.run.id,
      'analyst',
      [...packet.records.map((r) => r.id), beforeScope.id],
      packet.read.payload.imageReceipt,
    );
    recordAnalysisDetails(x.store, x.run.id, withScope, imageIds, {
      coverage: [],
      visualObservations: [
        {
          captureId: x.beforeType.id,
          topic: 'content',
          visiblePremise: 'Not supplied',
          interpretation: 'Not supplied',
          taskConcern: 'Not supplied',
          recommendation: 'Not supplied',
          sources: [x.beforeType.id],
          limits: [],
        },
      ],
      criterionProposals: [
        {
          captureId: x.beforeType.id,
          criterionId: 'C15',
          verdict: 'PASS',
          reason: 'Cannot assess an unsupplied state',
          sources: [x.beforeType.id],
          missingEvidence: [],
          screenReaderClaimed: false,
        },
      ],
    });
    assert.equal(
      x.store
        .records(x.run.id)
        .filter((r) => ['criterion_proposal', 'visual_observation'].includes(r.kind)).length,
      0,
    );
    assert.throws(
      () =>
        candidateTarget(
          {
            scope: 'element',
            targetCaptureId: x.beforeType.id,
            targetId: 'email',
            sources: [x.beforeType.id],
          },
          packet.records,
          imageIds,
        ),
      /exact target/,
    );
  } finally {
    x.close();
  }
});

test('Review feedback can be read as context but can never become a factual finding source', () => {
  const x = fixture();
  try {
    const original = x.store.append(
      x.run.id,
      'candidate',
      'analyst',
      { title: 'Old interpretation' },
      [x.current.id],
    );
    const review = x.store.append(
      x.run.id,
      'review',
      'reviewer',
      {
        candidateId: original.id,
        candidateHash: original.hash,
        verdict: 'rewrite',
        premise: 'unverified',
      },
      [original.id, x.current.id],
    );
    for (const source of [
      original,
      review,
      x.store.append(x.run.id, 'coverage', 'analyst', { topics: [] }, [x.current.id]),
      x.store.snapshot(x.run.id, 'analyst').read,
    ])
      assert.throws(
        () =>
          candidateTarget(
            { scope: 'view', targetCaptureId: null, targetId: null, sources: [source.id] },
            x.store.records(x.run.id),
          ),
        /originals|original evidence/,
      );
    const feedbackPacket = requestEvidence(x.store, x.run.id, 'analyst', x.current);
    assert(feedbackPacket.records.some((record) => record.id === review.id));
    assert.equal(
      imageRecordsForRead(feedbackPacket).length,
      3,
      'Review feedback does not add images or expand an old read graph',
    );
  } finally {
    x.close();
  }
});

test('Final criterion, visual coverage and publication gates cannot revive an unsupplied baseline image', () => {
  const x = fixture();
  try {
    const packet = requestEvidence(x.store, x.run.id, 'analyst', x.current);
    const scope = x.store
      .records(x.run.id)
      .find(
        (record) =>
          record.kind === 'criterion_scope' && record.payload.captureId === x.beforeType.id,
      )!;
    const analyst = x.store.snapshot(
      x.run.id,
      'analyst',
      [...packet.records.map((record) => record.id), scope.id],
      packet.read.payload.imageReceipt,
    );
    // Deliberately bypass the normal binder: the report must enforce the image boundary too.
    const proposal = x.store.append(
      x.run.id,
      'criterion_proposal',
      'analyst',
      {
        version: CRITERIA_VERSION,
        scopeId: scope.id,
        checkId: `${x.beforeType.id}:C15`,
        criterionId: 'C15',
        verdict: 'PASS',
        reason: 'Deliberately invalid assessed image',
        sources: [x.comparison.id],
        missingEvidence: [],
        screenReaderClaimed: false,
        readSnapshotId: analyst.read.id,
        readSnapshotHash: analyst.read.hash,
      },
      [scope.id, x.comparison.id],
    );
    const candidate = x.store.append(
      x.run.id,
      'candidate',
      'analyst',
      {
        issueKey: 'deliberate_unsupplied_target',
        scope: 'element',
        title: 'Deliberate unsupplied target',
        visiblePremise: 'Deliberately bypass the normal image-target binder.',
        detail: 'Negative fixture only.',
        basis: 'measured',
        targetCaptureId: x.beforeType.id,
        targetId: 'email',
        analystReadSnapshotId: analyst.read.id,
        analystReadSnapshotHash: analyst.read.hash,
      },
      [x.beforeType.id],
    );
    const reviewer = requestEvidence(x.store, x.run.id, 'reviewer', x.current);
    x.store.append(
      x.run.id,
      'criterion_review',
      'reviewer',
      {
        proposalId: proposal.id,
        proposalHash: proposal.hash,
        verdict: 'keep',
        premise: 'supported',
        reason: 'A keep cannot supply an image the analyst never saw.',
        sources: [x.comparison.id],
        readSnapshotId: reviewer.read.id,
        readSnapshotHash: reviewer.read.hash,
      },
      [proposal.id, reviewer.read.id, x.comparison.id],
    );
    x.store.append(
      x.run.id,
      'review',
      'reviewer',
      {
        candidateId: candidate.id,
        candidateHash: candidate.hash,
        verdict: 'keep',
        premise: 'supported',
        title: candidate.payload.title,
        sources: [x.beforeType.id],
        readSnapshotId: reviewer.read.id,
        readSnapshotHash: reviewer.read.hash,
      },
      [candidate.id, reviewer.read.id, x.beforeType.id],
    );
    const check = x
      .report()
      .results.find((result) => result.id === 'C15')!
      .checks.find((entry) => entry.captureId === x.beforeType.id)!;
    assert.equal(check.complete, false);
    assert.match(check.reason, /analyst did not receive/);
    assert.equal(x.store.published(x.run.id).length, 0);
    x.store.append(
      x.run.id,
      'visual_coverage',
      'analyst',
      {
        captureId: x.beforeType.id,
        topic: 'content',
        state: 'examined',
        reason: 'Deliberately invalid coverage',
        sources: [x.beforeType.id],
        suppliedImageCaptureIds: [x.beforeType.id],
        readSnapshotId: analyst.read.id,
        readSnapshotHash: analyst.read.hash,
      },
      [x.beforeType.id],
    );
    const coverage = assessmentForRun(x.store, x.run.id).visualCoverage as any[];
    assert.equal(
      coverage.find((row) => row.captureId === x.beforeType.id && row.topic === 'content').state,
      'not_assessed',
    );
  } finally {
    x.close();
  }
});

test('Self-consistent read rewriting or receipt removal cannot change which images supported a finding', () => {
  for (const damage of ['analyst-receipt', 'analyst-remove', 'reviewer-receipt'] as const) {
    const x = fixture();
    try {
      const analyst = requestEvidence(x.store, x.run.id, 'analyst', x.current);
      const candidate = x.store.append(
        x.run.id,
        'candidate',
        'analyst',
        {
          issueKey: 'controlled_current_image',
          scope: 'element',
          title: 'Controlled current-image claim',
          visiblePremise: 'Controlled current-image premise',
          basis: 'measured',
          targetCaptureId: x.current.id,
          targetId: 'email',
          analystReadSnapshotId: analyst.read.id,
          analystReadSnapshotHash: analyst.read.hash,
        },
        [x.current.id],
      );
      const reviewer = requestEvidence(x.store, x.run.id, 'reviewer', x.current);
      x.store.append(
        x.run.id,
        'review',
        'reviewer',
        {
          candidateId: candidate.id,
          candidateHash: candidate.hash,
          verdict: 'keep',
          premise: 'supported',
          title: candidate.payload.title,
          sources: [x.current.id],
          readSnapshotId: reviewer.read.id,
          readSnapshotHash: reviewer.read.hash,
        },
        [candidate.id, reviewer.read.id, x.current.id],
      );
      assert.equal(
        x.store.published(x.run.id).length,
        1,
        'The untouched independent read accepts its scoped fixture',
      );
      const changed = damage === 'reviewer-receipt' ? reviewer.read : analyst.read;
      const selected = changed.payload.records.filter(
        (pin: any) => pin.id === x.current.id || pin.id === candidate.id,
      );
      const receipt = {
        version: 'original-images/1',
        currentCaptureId: x.current.id,
        supplied: [
          {
            captureId: x.current.id,
            captureHash: x.current.hash,
            imageHash: x.current.payload.imageHash,
          },
        ],
        recordsOnly: [],
      };
      x.change(changed, {
        records: selected,
        imageReceipt: damage === 'analyst-remove' ? undefined : receipt,
      });
      const altered = x.store.record(x.run.id, changed.id)!;
      assert.equal(
        suppliedImageIds(altered, x.store.records(x.run.id)).length,
        1,
        'The altered receipt is internally valid, so only the saved read-hash pin prevents reuse',
      );
      assert.equal(x.store.published(x.run.id).length, 0, damage);
    } finally {
      x.close();
    }
  }
});

test(
  'Real controlled kept/lost return observations fit three images without deleting their four originals',
  { timeout: 90000 },
  async () => {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://fixture.local');
      const lost = url.searchParams.get('case') === 'lost';
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(
        `<!doctype html><html lang="en"><title>Controlled return-only fixture</title><body><h1>${url.pathname === '/review' ? 'Review details' : 'Your details'}</h1><label for="email">Email address</label><input id="email" type="email" autocomplete="off">${url.pathname === '/review' ? '' : `<a id="next" href="/review?case=${lost ? 'lost' : 'kept'}">Review details</a>`}<script>const field=document.getElementById('email');${lost ? "addEventListener('pageshow',()=>{field.value='';});" : "field.value=sessionStorage.getItem('controlled-email')||'';field.addEventListener('input',()=>sessionStorage.setItem('controlled-email',field.value));"}</script></body></html>`,
      );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      for (const lost of [false, true]) {
        const dir = mkdtempSync(join(tmpdir(), 'access-walk-real-return-images-'));
        const store = new Store(dir);
        const run = store.create(
          'Controlled return-only browser proof; no criterion verdict inferred',
          origin + `/form?case=${lost ? 'lost' : 'kept'}`,
          'offline',
        );
        const walk = new BrowserWalk(store, run.id, origin, true, 'chromium');
        const returns = new ReturnEvidence(store, run.id);
        try {
          let current = await walk.start(run.url);
          await walk.act(
            { kind: 'press', key: 'Tab', note: 'Controlled focus to email.' },
            current,
          );
          const beforeType = await walk.capture();
          const typed = await walk.act(
            { kind: 'type', text: 'test@example.org', note: 'Approved synthetic fixture value.' },
            beforeType,
          );
          const entry = await walk.capture();
          assert.equal(await returns.rememberTyped(walk, beforeType, typed, entry), true);
          await walk.act(
            { kind: 'press', key: 'Tab', note: 'Controlled focus to safe review link.' },
            entry,
          );
          current = await walk.capture();
          assert.equal(current.payload.focus.id, 'next');
          await walk.act(
            { kind: 'press', key: 'Enter', note: 'Open controlled review page.' },
            current,
          );
          const beforeBack = await walk.capture();
          const back = await walk.act(
            { kind: 'back', note: 'Actually return to the controlled form.' },
            beforeBack,
          );
          const returned = await walk.capture();
          const comparison = await returns.compareAfterBack(walk, beforeBack, back, returned);
          assert.equal(comparison.payload.preserved, !lost);
          declareCriterionScopes(store, run.id);
          const packet = requestEvidence(store, run.id, 'analyst', returned);
          assert.equal(packet.records.filter((record) => record.kind === 'capture').length, 4);
          assert.deepEqual(suppliedImageIds(packet.read, packet.records), [
            entry.id,
            beforeBack.id,
            returned.id,
          ]);
          for (const original of [beforeType, entry, beforeBack, returned]) {
            assert.equal(
              packet.records.find((record) => record.id === original.id)!.hash,
              original.hash,
            );
            store.image(run.id, original.payload.imageFile);
          }
          assert.equal(store.usage(run.id).requests.length, 0);
          assert.equal(
            store.records(run.id).filter((record) => record.kind === 'at_check').length,
            0,
          );
        } finally {
          returns.clear();
          await walk.close();
          store.close();
          rmSync(dir, { recursive: true, force: true });
        }
      }
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);
