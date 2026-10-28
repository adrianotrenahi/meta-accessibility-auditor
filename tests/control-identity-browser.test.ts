import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server/index.js';
import { BrowserWalk } from '../src/browser.js';
import { requestEvidence } from '../src/request-evidence.js';
import { validControlInstance } from '../src/control-identity.js';
import { exportHostSnapshot } from '../src/host-export.js';
import type { Store } from '../src/store.js';
import type { RecordEntry } from '../src/types.js';

function propose(store: Store, runId: string, capture: RecordEntry, detail: string) {
  const target = capture.payload.elements.find((element: any) => element.selector === '#add');
  assert(target);
  const analyst = requestEvidence(store, runId, 'analyst', capture);
  return store.append(
    runId,
    'candidate',
    'saved_analyst_response',
    {
      issueKey: 'controlled_unnamed_add',
      scope: 'element',
      criterion: 'C02',
      title: 'The add button has no usable programmatic name',
      detail,
      visiblePremise: 'The controlled product screen contains a plus button.',
      recommendation: 'Give the add button a meaningful programmatic name.',
      basis: 'measured',
      severity: 'serious',
      targetCaptureId: capture.id,
      targetId: target.id,
      analystReadSnapshotId: analyst.read.id,
      analystReadSnapshotHash: analyst.read.hash,
    },
    [capture.id],
  );
}

function review(store: Store, runId: string, candidate: RecordEntry, latest: RecordEntry) {
  const reader = requestEvidence(store, runId, 'reviewer', latest);
  return store.append(
    runId,
    'review',
    'saved_reviewer_response',
    {
      candidateId: candidate.id,
      candidateHash: candidate.hash,
      verdict: 'keep',
      premise: 'supported',
      title: candidate.payload.title,
      reason:
        'Saved reply instrumentation: the original browser facts expose an empty name. No reader failure is inferred.',
      sources: [candidate.payload.targetCaptureId, latest.id],
      readSnapshotId: reader.read.id,
      readSnapshotHash: reader.read.hash,
      provenance: 'saved-example',
    },
    [candidate.id, candidate.payload.targetCaptureId, latest.id, reader.read.id],
  );
}

for (const engine of ['chromium', 'webkit'] as const) {
  test(`Actual ${engine} unchanged button stays one reviewed finding after Add, with the latest whole original and both histories`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'meta-control-identity-'));
    const app = await startServer(0, directory, false);
    const run = app.store.create(
      'Offline control identity proof',
      app.origin + '/shop/?case=broken',
      'offline',
    );
    const walk = new BrowserWalk(app.store, run.id, app.origin, true, engine);
    try {
      await walk.start(run.url);
      await walk.page.locator('#add').focus();
      const first = await walk.capture();
      const original = first.payload.elements.find((element: any) => element.selector === '#add');
      assert(validControlInstance(original.controlInstance));
      assert.deepEqual(
        first.payload.elements
          .filter((element: any) => 'controlFingerprint' in element)
          .map((element: any) => element.selector),
        ['#add'],
        'Ordinary controls add no identity fields to model input.',
      );
      const html = await walk.page.locator('body').evaluate((body) => body.outerHTML);
      const firstCandidate = propose(app.store, run.id, first, 'First saved accepted wording.');
      await walk.act(
        {
          kind: 'press',
          key: 'Enter',
          note: 'Offline test: activate the focused demo add button.',
        },
        first,
      );
      const later = await walk.capture();
      const current = later.payload.elements.find((element: any) => element.selector === '#add');
      assert.equal(await walk.page.locator('#status').innerText(), 'Added to your basket.');
      assert.notEqual(original.contextFingerprint, current.contextFingerprint);
      assert.notEqual(first.payload.imageHash, later.payload.imageHash);
      assert.equal(original.controlInstance, current.controlInstance);
      assert.equal(original.controlFingerprint, current.controlFingerprint);
      assert.equal(first.payload.stable, true);
      assert.equal(later.payload.stable, true);
      assert(!html.includes('control-v1:'), 'Identity metadata never becomes a DOM attribute.');

      const laterCandidate = propose(app.store, run.id, later, 'Later saved accepted wording.');
      // Both originals receive independent fresh reviews after the newest browser evidence.
      review(app.store, run.id, firstCandidate, later);
      const laterReview = review(app.store, run.id, laterCandidate, later);
      const retained = JSON.stringify(app.store.records(run.id));
      const published = app.store.published(run.id);
      assert.equal(published.length, 1);
      assert.equal(published[0].id, laterCandidate.id);
      assert.equal(published[0].detail, laterCandidate.payload.detail);
      assert.equal(published[0].review.candidateHash, laterCandidate.hash);
      assert.deepEqual(published[0].occurrenceIds, [firstCandidate.id, laterCandidate.id]);
      assert.deepEqual(published[0].evidence, [first.id, later.id]);
      const exported = exportHostSnapshot(app.store, run.id).snapshot;
      assert.equal(exported.findings.length, 1);
      assert.equal(exported.findings[0].candidateHash, laterCandidate.hash);
      assert.equal(exported.findings[0].reviewHash, laterReview.hash);
      assert.equal(exported.findings[0].anchor?.captureId, later.id);
      assert.deepEqual(exported.findings[0].captureIds, [first.id, later.id]);
      const frame = await walk.frames.read();
      assert.equal(frame.captureId, later.id);
      assert.equal(frame.imageHash, later.payload.imageHash);
      assert.deepEqual(
        Buffer.from(frame.png, 'base64'),
        app.store.image(run.id, later.payload.imageFile),
      );
      assert.equal(JSON.stringify(app.store.records(run.id)), retained);

      const imagePath = join(directory, run.id, later.payload.imageFile);
      const imageBytes = app.store.image(run.id, later.payload.imageFile);
      unlinkSync(imagePath);
      try {
        const unavailable = exportHostSnapshot(app.store, run.id).snapshot;
        assert.equal(
          unavailable.findings.length,
          0,
          'A group cannot promise both original histories when one original is unavailable.',
        );
        assert(
          unavailable.limits.some(
            (limit) => limit.includes(later.id) && limit.includes('unavailable'),
          ),
        );
        assert.equal(
          app.store.published(run.id).length,
          1,
          'The raw accepted history stays intact; export reports the missing image explicitly.',
        );
        assert.equal(JSON.stringify(app.store.records(run.id)), retained);
      } finally {
        writeFileSync(imagePath, imageBytes, { flag: 'wx' });
      }

      app.store.append(run.id, 'review', 'saved_reviewer_response', {
        candidateId: laterCandidate.id,
        candidateHash: laterCandidate.hash,
        verdict: 'reject',
        reason: 'Offline withdrawal: the later claim must not borrow an earlier approval.',
      });
      const remaining = app.store.published(run.id);
      assert.equal(remaining.length, 1);
      assert.equal(remaining[0].id, firstCandidate.id);
      assert.deepEqual(remaining[0].occurrenceIds, [firstCandidate.id]);
      assert.deepEqual(remaining[0].evidence, [first.id]);
      assert.equal(app.store.usage().requests.length, 0);
    } finally {
      await walk.close();
      await app.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test(`Actual ${engine} replacement nodes and reloads get fresh IDs without changing page pixels or markup`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'meta-control-replacement-'));
    const app = await startServer(0, directory, false);
    const run = app.store.create(
      'Offline node replacement proof',
      app.origin + '/shop/?case=broken',
      'offline',
    );
    const walk = new BrowserWalk(app.store, run.id, app.origin, true, engine);
    try {
      const first = await walk.start(run.url);
      const target = (capture: RecordEntry) =>
        capture.payload.elements.find((element: any) => element.selector === '#add');
      const html = await walk.page.locator('body').evaluate((body) => body.outerHTML);
      const descriptor = await walk.page.evaluate(() => {
        const property = Object.getOwnPropertyNames(globalThis).find((key) =>
          key.startsWith('__access_walk_control_'),
        )!;
        const d = Object.getOwnPropertyDescriptor(globalThis, property)!;
        const identify = d.value;
        const button = document.querySelector('#add')!;
        const before = identify(button);
        const nativeGet = WeakMap.prototype.get,
          nativeSet = WeakMap.prototype.set;
        let stable, distinct;
        try {
          WeakMap.prototype.get = () => 'forged';
          WeakMap.prototype.set = function () {
            return this;
          };
          stable = identify(button) === before;
          distinct = identify(button.cloneNode(true)) !== before;
        } finally {
          WeakMap.prototype.get = nativeGet;
          WeakMap.prototype.set = nativeSet;
        }
        return {
          enumerable: d.enumerable,
          configurable: d.configurable,
          writable: d.writable,
          stable,
          distinct,
          replacementAccepted: Reflect.set(globalThis, property, () => 'forged'),
        };
      });
      assert.deepEqual(descriptor, {
        enumerable: false,
        configurable: false,
        writable: false,
        stable: true,
        distinct: true,
        replacementAccepted: false,
      });
      await walk.page
        .locator('#add')
        .evaluate((element) => element.replaceWith(element.cloneNode(true)));
      const replacement = await walk.capture();
      assert.equal(target(first).contextFingerprint, target(replacement).contextFingerprint);
      assert.equal(target(first).controlFingerprint, target(replacement).controlFingerprint);
      assert.notEqual(target(first).controlInstance, target(replacement).controlInstance);
      assert.equal(first.payload.imageHash, replacement.payload.imageHash);
      assert.equal(await walk.page.locator('body').evaluate((body) => body.outerHTML), html);
      const originalClaim = propose(app.store, run.id, first, 'First node.');
      const replacementClaim = propose(app.store, run.id, replacement, 'Replacement node.');
      review(app.store, run.id, originalClaim, replacement);
      review(app.store, run.id, replacementClaim, replacement);
      assert.equal(
        app.store.published(run.id).length,
        2,
        'Reusing #add and all original HTML cannot merge a replacement.',
      );
      await walk.page.reload({ waitUntil: 'domcontentloaded' });
      const reloaded = await walk.capture();
      assert(validControlInstance(target(reloaded).controlInstance));
      assert.notEqual(target(reloaded).controlInstance, target(first).controlInstance);
      assert.notEqual(target(reloaded).controlInstance, target(replacement).controlInstance);
      assert.equal(reloaded.payload.imageHash, first.payload.imageHash);
      assert.equal(app.store.usage().requests.length, 0);
    } finally {
      await walk.close();
      await app.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test(`Actual ${engine} button replacement during a screenshot leaves the original unstable`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'meta-control-moving-'));
    const app = await startServer(0, directory, false);
    const run = app.store.create(
      'Offline capture replacement proof',
      app.origin + '/shop/?case=broken',
      'offline',
    );
    const walk = new BrowserWalk(app.store, run.id, app.origin, true, engine);
    try {
      const original = await walk.start(run.url);
      const screenshot = walk.page.screenshot.bind(walk.page);
      let replaced = false;
      walk.page.screenshot = async (options) => {
        const image = await screenshot(options);
        if (!replaced) {
          replaced = true;
          await walk.page
            .locator('#add')
            .evaluate((element) => element.replaceWith(element.cloneNode(true)));
        }
        return image;
      };
      const moving = await walk.capture();
      assert.equal(moving.payload.imageHash, original.payload.imageHash);
      assert.equal(
        moving.payload.stateStamp,
        original.payload.stateStamp,
        'Accessible state alone cannot detect the identical replacement.',
      );
      assert.equal(
        moving.payload.stable,
        false,
        'The before/after node check must refuse grouping from this moving capture.',
      );
      await assert.rejects(
        () =>
          walk.act(
            { kind: 'press', key: 'Tab', note: 'Offline refused moving-source input.' },
            moving,
          ),
        /control changed or disappeared/,
      );
      assert.equal(app.store.usage().requests.length, 0);
    } finally {
      await walk.close();
      await app.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test(`Actual ${engine} disappearing last controls retain an unstable original without waiting for a missing button`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'meta-control-removed-'));
    const app = await startServer(0, directory, false);
    const run = app.store.create(
      'Offline disappearing control proof',
      app.origin + '/shop/?case=broken',
      'offline',
    );
    const walk = new BrowserWalk(app.store, run.id, app.origin, true, engine);
    try {
      await walk.start(run.url);
      walk.page.setDefaultTimeout(200);
      const screenshot = walk.page.screenshot.bind(walk.page);
      walk.page.screenshot = async (options) => {
        const image = await screenshot(options);
        await walk.page.locator('#add').evaluate((element) => {
          element.remove();
          document.querySelector('main > a')?.remove();
        });
        return image;
      };
      const moving = await walk.capture();
      assert.equal(moving.payload.stable, false);
      assert.equal(
        app.store.record(run.id, moving.id)?.hash,
        moving.hash,
        'The moving original is retained, rather than losing the capture to optional metadata.',
      );
      assert.equal(app.store.usage().requests.length, 0);
    } finally {
      await walk.close();
      await app.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  test(`Actual ${engine} nonsemantic button attributes disable grouping without blocking the run`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'meta-control-attributes-'));
    const app = await startServer(0, directory, false);
    const run = app.store.create(
      'Offline attribute-change proof',
      app.origin + '/shop/?case=broken',
      'offline',
    );
    const walk = new BrowserWalk(app.store, run.id, app.origin, true, engine);
    try {
      await walk.start(run.url);
      const screenshot = walk.page.screenshot.bind(walk.page);
      let sequence = 0;
      walk.page.screenshot = async (options) => {
        const image = await screenshot(options);
        await walk.page
          .locator('#add')
          .evaluate((element, n) => element.setAttribute('data-state', String(n)), ++sequence);
        return image;
      };
      const changing = await walk.capture();
      assert.equal(
        changing.payload.stable,
        true,
        'A bookkeeping attribute is not an unstable accessible observation.',
      );
      assert.equal(changing.payload.limits.controlIdentityChanged, undefined);
      const target = changing.payload.elements.find((element: any) => element.selector === '#add');
      assert.equal(target.controlInstance, undefined);
      assert.equal(
        typeof target.controlFingerprint,
        'string',
        'Partial metadata keeps the target capture-bound, without falling back to legacy grouping.',
      );
      await walk.act(
        {
          kind: 'press',
          key: 'Tab',
          note: 'Offline input proves ordinary navigation can continue.',
        },
        changing,
      );
      assert.equal(app.store.usage().requests.length, 0);
    } finally {
      await walk.close();
      await app.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
