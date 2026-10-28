import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server/index.js';
import { BrowserWalk } from '../src/browser.js';
import { requestEvidence } from '../src/request-evidence.js';

test('Actual browser frames retain the reviewed original after an identical later capture', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'meta-live-binding-browser-'));
  const app = await startServer(0, directory, false);
  const run = app.store.create(
    'Saved-reply live-binding instrumentation',
    app.origin + '/shop/?case=broken',
    'offline',
  );
  const walk = new BrowserWalk(app.store, run.id, app.origin, true, 'chromium');
  try {
    const original = await walk.start(run.url);
    assert.equal(original.payload.stable, true);
    const target = original.payload.elements.find((element: any) => element.selector === '#add');
    assert(target);
    assert.equal(target.name, '');
    const analyst = requestEvidence(app.store, run.id, 'analyst', original);
    const title = 'The add button has no usable programmatic name';
    const candidate = app.store.append(
      run.id,
      'candidate',
      'saved_analyst_response',
      {
        issueKey: 'controlled_unnamed_add',
        scope: 'element',
        criterion: 'C02',
        title,
        detail:
          'Saved reply instrumentation: the original browser facts expose an empty control name.',
        visiblePremise: 'The original controlled product view contains a plus button.',
        recommendation: 'Give the add button a meaningful programmatic name.',
        basis: 'measured',
        severity: 'serious',
        targetCaptureId: original.id,
        targetId: target.id,
        analystReadSnapshotId: analyst.read.id,
        analystReadSnapshotHash: analyst.read.hash,
      },
      [original.id],
    );
    const repeated = await walk.capture();
    assert.notEqual(repeated.id, original.id);
    assert.equal(repeated.payload.imageHash, original.payload.imageHash);
    assert.equal(repeated.payload.stateStamp, original.payload.stateStamp);
    const reviewer = requestEvidence(app.store, run.id, 'reviewer', repeated);
    app.store.append(
      run.id,
      'review',
      'saved_reviewer_response',
      {
        candidateId: candidate.id,
        candidateHash: candidate.hash,
        verdict: 'keep',
        premise: 'supported',
        title,
        reason:
          'Saved reply: this exact original has an empty browser-reported name; no keyboard or reader failure is inferred.',
        sources: [original.id, repeated.id],
        readSnapshotId: reviewer.read.id,
        readSnapshotHash: reviewer.read.hash,
        provenance: 'saved-example',
      },
      [candidate.id, original.id, repeated.id, reviewer.read.id],
    );
    assert.equal(app.store.published(run.id).length, 1);
    const before = JSON.stringify(app.store.records(run.id));
    const frame = await walk.frames.read();
    assert.equal(frame.captureId, original.id);
    assert.equal(frame.imageHash, original.payload.imageHash);
    assert.deepEqual(
      Buffer.from(frame.png, 'base64'),
      app.store.image(run.id, original.payload.imageFile),
    );
    assert.equal(JSON.stringify(app.store.records(run.id)), before);
    assert.equal(app.store.records(run.id).filter((record) => record.kind === 'capture').length, 2);
    await walk.page
      .locator('#add')
      .evaluate((element) => element.setAttribute('aria-label', 'Named later'));
    await new Promise((resolve) => setTimeout(resolve, 260));
    const changed = await walk.frames.read();
    assert.equal(
      changed.imageHash,
      original.payload.imageHash,
      'The invisible change preserves the pixels.',
    );
    assert.equal(
      changed.captureId,
      null,
      'A reviewed preference cannot override changed accessible state.',
    );
    assert.equal(JSON.stringify(app.store.records(run.id)), before);
    await walk.page.locator('#add').evaluate((element) => element.setAttribute('aria-label', ''));
    await new Promise((resolve) => setTimeout(resolve, 260));
    assert.equal((await walk.frames.read()).captureId, original.id);
    app.store.append(run.id, 'review', 'saved_reviewer_response', {
      candidateId: candidate.id,
      candidateHash: candidate.hash,
      verdict: 'reject',
      reason: 'Saved withdrawal instrumentation, without a model call.',
    });
    await new Promise((resolve) => setTimeout(resolve, 260));
    assert.equal(app.store.published(run.id).length, 0);
    assert.equal((await walk.frames.read()).captureId, repeated.id);
    assert.equal(app.store.usage().requests.length, 0);
  } finally {
    await walk.close();
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
