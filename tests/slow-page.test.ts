import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { errors } from 'playwright';
import { BrowserWalk, PageUnreadable, SCREENSHOT_WAIT_MS } from '../src/browser.js';
import { startServer } from '../server/index.js';

// Owner, 31 Oct: after Search, Booking.com's results page took longer than one read allows and
// the audit ended on "locator.ariaSnapshot: Timeout 8000ms exceeded". A slow page is now read
// again until it is readable, within a bounded wait; nothing is pressed again meanwhile.
const timedOut = () => new errors.TimeoutError('locator.ariaSnapshot: Timeout 8000ms exceeded.');
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function slowPage(name: string, body: (walk: BrowserWalk, app: any, run: any) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'slow-page-'));
  const app = await startServer(0, dir, false);
  const run = app.store.create(name, app.origin + '/shop/', 'offline');
  const walk = new BrowserWalk(app.store, run.id, app.origin, true, 'chromium');
  try {
    await walk.start(run.url);
    await body(walk, app, run);
  } finally {
    await walk.close();
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('A page slow to become readable is read again, within a bounded wait', () =>
  slowPage('Slow page', async (walk, app, run) => {
    const limits = (method: string) =>
      app.store.records(run.id).filter((r: any) => r.payload.method === method);
    const real = (walk as any).captureOrWait.bind(walk);
    let failures = 2;
    (walk as any).captureOrWait = async () => {
      if (failures-- > 0) throw timedOut();
      return real();
    };
    const capture = await walk.capture();
    assert.equal(capture.kind, 'capture', 'the page is read once it is readable');
    assert.equal(limits('slow_page_wait').length, 1);
    // How long it really took is saved with the screenshot it led to.
    const readable = limits('slow_page_readable');
    assert.equal(readable.length, 1);
    assert.deepEqual(readable[0].sources, [capture.id]);
    assert(readable[0].payload.waitedMs >= 0);
    assert.equal(app.store.records(run.id).filter((r: any) => r.kind === 'action').length, 0);

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
    const before = app.store.records(run.id).length;
    await assert.rejects(walk.capture(), /browser closed/);
    assert.equal(app.store.records(run.id).length, before);
  }));

// Owner, 1 Nov: on Booking.com the first read alone took about 30 seconds (the wait for the new
// page, then a screenshot over its limit), which used up the old wait before a second look.
test('A first read that outlasts the whole wait still gets its second look', () =>
  slowPage('Slow first read', async (walk) => {
    const real = (walk as any).captureOrWait.bind(walk);
    walk.slowPageWaitMs = 2000;
    let call = 0;
    (walk as any).captureOrWait = async () => {
      if (call++ === 0) {
        await pause(2500);
        throw timedOut();
      }
      return real();
    };
    assert.equal((await walk.capture()).kind, 'capture');
    assert.equal(call, 2, 'the second read ran after the long first one');
  }));

// Codex and Loca, PR 64: the wait is one budget per page reading, checked before every new read.
test('One page reading shares one bounded wait, and the stop names the real error', () =>
  slowPage('Slow page budget', async (walk, app, run) => {
    const real = (walk as any).captureOrWait.bind(walk);
    walk.slowPageWaitMs = 1200;
    // Each read takes 800 ms and runs out of time: no read starts once the wait is used up.
    let starts: number[] = [];
    let begun = performance.now();
    (walk as any).captureOrWait = async () => {
      starts.push(performance.now() - begun);
      await pause(800);
      throw timedOut();
    };
    const stopped = await walk.capture().catch((error) => error);
    assert(stopped instanceof PageUnreadable);
    assert.match(stopped.message, /locator\.ariaSnapshot: Timeout 8000ms exceeded/);
    assert(starts.length >= 2, 'the wait gave a second look');
    // The wait starts at the first failure, about 800 ms in.
    assert(starts.every((at) => at < 800 + 1200), `reads started at ${starts.join(', ')} ms`);
    assert(performance.now() - begun < 800 + 1200 + 800, 'at most the read under way overruns');
    const note = app.store.records(run.id).find((r: any) => r.payload.method === 'slow_page_wait')!;
    assert.equal(note.payload.maximumWaitMs, 1200);

    // The settling check's readings share one wait: a reading that already waited leaves the
    // next reading only what is left, and that reading still gets its one try.
    walk.slowPageWaitMs = 1500;
    const changing = await real();
    changing.payload.stable = false;
    let call = 0;
    starts = [];
    begun = performance.now();
    (walk as any).captureOrWait = async () => {
      starts.push(performance.now() - begun);
      if (call++ === 0) throw timedOut();
      if (call === 2) {
        await pause(1000);
        return changing;
      }
      await pause(100);
      throw timedOut();
    };
    await assert.rejects(walk.captureSettled(), PageUnreadable);
    assert(starts.length >= 3, 'the second reading still made one read');
    // First failure at once, a 1 s pause, a 1 s reading, 0.4 s settle, then the wait is over;
    // a fresh wait per reading would add another 1.5 s.
    assert(performance.now() - begun < 3500, 'one wait for the whole check, not one each');
  }));

// Owner, 1 Nov: Booking.com's results page took longer than 8 seconds to photograph.
test('A screenshot gets its own 20-second limit, not the usual 8', () =>
  slowPage('Slow screenshot', async (walk) => {
    assert.equal(SCREENSHOT_WAIT_MS, 20_000);
    const limits: unknown[] = [];
    const screenshot = walk.page.screenshot.bind(walk.page);
    walk.page.screenshot = (options?: any) => {
      limits.push(options?.timeout);
      return screenshot(options);
    };
    await walk.capture();
    assert(limits.includes(SCREENSHOT_WAIT_MS), `screenshot limits: ${limits.join(', ')}`);
  }));

// Owner, 1 Nov: a Tab on a frozen page used a quicker focus read that had no slow-page wait,
// so it could still end the audit on a raw time-out. It now hands over to the full reading.
test('A Tab on a frozen page gets the slow-page wait, not a raw time-out', () =>
  slowPage('Frozen after Tab', async (walk) => {
    await walk.page.setContent('<button>One</button><button>Two</button><button>Three</button>');
    const tab = async () => {
      const before = await walk.captureSettled();
      const performed = await walk.act({ kind: 'press', key: 'Tab', note: 'Tab' }, before);
      return { before, performed };
    };
    const real = (walk as any).observedState.bind(walk);
    // The quick read times out once; the full reading that takes over then succeeds.
    let step = await tab();
    let failures = 1;
    (walk as any).observedState = async () => {
      if (failures-- > 0) throw timedOut();
      return real();
    };
    const after = await walk.observeKeyboardMovement(step.before, step.performed);
    assert.equal(after.kind, 'capture', 'the full reading recorded the page');
    // A page that stays frozen ends with the plain slow-page reason.
    (walk as any).observedState = real;
    step = await tab();
    walk.slowPageWaitMs = 1200;
    (walk as any).observedState = async () => {
      throw timedOut();
    };
    await assert.rejects(walk.observeKeyboardMovement(step.before, step.performed), PageUnreadable);
  }));
