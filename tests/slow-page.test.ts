import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { errors } from 'playwright';
import { BrowserWalk, PageUnreadable } from '../src/browser.js';
import { startServer } from '../server/index.js';

// Owner, 31 Oct: after Search, Booking.com's results page took longer than one read allows and
// the audit ended on "locator.ariaSnapshot: Timeout 8000ms exceeded". A slow page is now read
// again until it is readable, within a bounded wait; nothing is pressed again meanwhile.
const timedOut = () => new errors.TimeoutError('locator.ariaSnapshot: Timeout 8000ms exceeded.');

test('A page slow to become readable is read again, within a bounded wait', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'slow-page-'));
  const app = await startServer(0, dir, false);
  const run = app.store.create('Slow page', app.origin + '/shop/', 'offline');
  const walk = new BrowserWalk(app.store, run.id, app.origin, true, 'chromium');
  const records = (kind: string) => app.store.records(run.id).filter((r) => r.kind === kind);
  try {
    await walk.start(run.url);
    const real = (walk as any).captureOrWait.bind(walk);
    let failures = 2;
    (walk as any).captureOrWait = async () => {
      if (failures-- > 0) throw timedOut();
      return real();
    };
    const capture = await walk.capture();
    assert.equal(capture.kind, 'capture', 'the page is read once it is readable');
    assert.equal(records('limit').filter((r) => r.payload.method === 'slow_page_wait').length, 1);
    assert.equal(records('action').length, 0, 'no input was sent while waiting');

    // A page that never becomes readable ends the wait with its own, plain reason.
    walk.slowPageWaitMs = 1200;
    (walk as any).captureOrWait = async () => {
      throw timedOut();
    };
    const started = performance.now();
    await assert.rejects(walk.capture(), PageUnreadable);
    assert(performance.now() - started < 5000, 'the wait is bounded');

    // Any other failure is not a slow page: it is not waited for.
    (walk as any).captureOrWait = async () => {
      throw Error('The browser closed.');
    };
    const before = records('limit').length;
    await assert.rejects(walk.capture(), /browser closed/);
    assert.equal(records('limit').length, before);
  } finally {
    await walk.close();
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
