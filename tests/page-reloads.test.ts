import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { BrowserWalk } from '../src/browser.js';
import { Runner } from '../src/runner.js';

// A page that reloads itself once shortly after arrival, the way Booking.com's
// robot check does (owner, 30 Oct: wait for reloads before measuring; retry if one happens).
async function reloadingSite() {
  const dir = mkdtempSync(join(tmpdir(), 'access-walk-reloads-'));
  const store = new Store(dir);
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    const checked = (req.url ?? '').includes('checked=1');
    res.end(
      `<title>${checked ? 'Checked home' : 'First home'}</title><h1>${checked ? 'Checked home' : 'First home'}</h1>` +
        '<button>Search</button>' +
        (checked ? '' : `<script>setTimeout(() => location.replace('/?checked=1'), 600)</script>`),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const run = store.create('Self-reloading home page', origin + '/', 'offline');
  const walk = new BrowserWalk(store, run.id, origin, true, 'chromium');
  const runner = new Runner(store, origin);
  return {
    store,
    run,
    walk,
    runner,
    origin,
    async close() {
      await walk.close();
      await new Promise((resolve) => server.close(resolve));
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
const destroyed = () =>
  Error('page.evaluate: Execution context was destroyed, most likely because of a navigation');

test(
  'The first screenshot waits until a page has finished reloading itself',
  { timeout: 60000 },
  async () => {
    const site = await reloadingSite();
    try {
      const first = await site.walk.start(site.run.url);
      assert.match(
        first.payload.url,
        /checked=1/,
        'the screenshot shows the page after its own reload',
      );
      assert.match(first.payload.title, /Checked home/);
    } finally {
      await site.close();
    }
  },
);

test(
  'A scan cut short by a reload is measured again on the new page, with no input sent',
  { timeout: 60000 },
  async () => {
    const site = await reloadingSite();
    try {
      const first = await site.walk.start(site.run.url);
      const real = site.walk.measurements.bind(site.walk);
      let calls = 0;
      site.walk.measurements = async (source) => {
        if (++calls === 1) throw destroyed();
        return real(source);
      };
      const actions = site.walk.actions;
      const measured = await (site.runner as any).automaticMeasurement(
        site.run,
        site.walk,
        first,
        new AbortController().signal,
      );
      assert.equal(calls, 2);
      assert.ok(measured.scan, 'the second attempt produced a scan');
      assert.equal(
        measured.scan.sources[0],
        measured.current.id,
        'measured on the fresh observation',
      );
      assert.equal(site.walk.actions, actions, 'retrying sends no input');
      const limit = site.store.records(site.run.id).find((r) => r.kind === 'limit')!;
      assert.equal(limit.payload.attempt, 1);
      assert.equal(limit.payload.state, 'INCONCLUSIVE');
      assert.match(limit.payload.reason, /measures again/);
    } finally {
      await site.close();
    }
  },
);

test(
  'After three reloads in a row the scan stays unknown instead of looping',
  { timeout: 60000 },
  async () => {
    const site = await reloadingSite();
    try {
      const first = await site.walk.start(site.run.url);
      let calls = 0;
      site.walk.measurements = async () => {
        calls++;
        throw destroyed();
      };
      const measured = await (site.runner as any).automaticMeasurement(
        site.run,
        site.walk,
        first,
        new AbortController().signal,
      );
      assert.equal(calls, 3);
      assert.equal(measured.scan, undefined);
      const limits = site.store.records(site.run.id).filter((r) => r.kind === 'limit');
      assert.deepEqual(
        limits.map((r) => r.payload.attempt),
        [1, 2, 3],
      );
      assert.match(limits[2].payload.reason, /remains unknown/);
    } finally {
      await site.close();
    }
  },
);

test(
  'Clearing banners survives a reload: the robot waits and clears again on the new page',
  { timeout: 60000 },
  async () => {
    const site = await reloadingSite();
    try {
      const first = await site.walk.start(site.run.url);
      const page = site.walk.page;
      const real = page.evaluate.bind(page);
      let failed = 0;
      (page as any).evaluate = async (...args: unknown[]) => {
        if (failed++ === 0) throw destroyed();
        return (real as any)(...args);
      };
      const current = await (site.runner as any).clearBlockersAcrossReloads(
        site.run,
        site.walk,
        first,
        new AbortController().signal,
        { arrival: true },
      );
      assert.equal(current.kind, 'capture');
      const limit = site.store.records(site.run.id).find((r) => r.kind === 'limit')!;
      assert.equal(limit.payload.state, 'PAGE_RELOADED');
      assert.equal(limit.payload.attempt, 1);
    } finally {
      await site.close();
    }
  },
);

test(
  'A page that keeps reloading during banner clearing stops the step after three tries',
  { timeout: 60000 },
  async () => {
    const site = await reloadingSite();
    try {
      const first = await site.walk.start(site.run.url);
      (site.walk.page as any).evaluate = async () => {
        throw destroyed();
      };
      await assert.rejects(
        (site.runner as any).clearBlockersAcrossReloads(
          site.run,
          site.walk,
          first,
          new AbortController().signal,
          { arrival: false },
        ),
        /Execution context was destroyed/,
      );
      const limits = site.store.records(site.run.id).filter((r) => r.kind === 'limit');
      assert.deepEqual(
        limits.map((r) => r.payload.attempt),
        [1, 2],
      );
    } finally {
      await site.close();
    }
  },
);

test(
  'A closed page is never mistaken for a reload: it stops at once, with no retry note',
  { timeout: 60000 },
  async () => {
    const site = await reloadingSite();
    try {
      const first = await site.walk.start(site.run.url);
      site.walk.measurements = async () => {
        await site.walk.page.close();
        throw destroyed();
      };
      await assert.rejects(
        (site.runner as any).automaticMeasurement(
          site.run,
          site.walk,
          first,
          new AbortController().signal,
        ),
        /Execution context was destroyed/,
      );
      assert.equal(site.store.records(site.run.id).filter((r) => r.kind === 'limit').length, 0);
    } finally {
      await site.close();
    }
  },
);
