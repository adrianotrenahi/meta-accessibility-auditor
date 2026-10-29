import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserWalk, isCommitment } from '../src/browser.js';
import { startServer } from '../server/index.js';

test('Book now is a commitment while opening search and reviewing remain available', () => {
  for (const name of ['Book now', 'BOOK NOW', 'Book\nnow', 'Buy now', 'Confirm booking'])
    assert.equal(isCommitment(name), true, name);
  for (const name of ['Search flights', 'View availability', 'Continue to review', 'Book details'])
    assert.equal(isCommitment(name), false, name);
});

for (const key of ['Enter', 'Space'] as const)
  test(`A fresh Book now control cannot receive ${key}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'book-now-boundary-'));
    const app = await startServer(0, dir, false);
    const run = app.store.create('Synthetic booking boundary', app.origin + '/shop/', 'offline');
    const walk = new BrowserWalk(app.store, run.id, app.origin, true, 'chromium');
    try {
      await walk.start(run.url);
      await walk.page.setContent(
        '<html lang="en"><head><title>Controlled booking boundary</title></head>' +
          '<body><h1>Controlled booking boundary</h1>' +
          '<button onclick="document.body.dataset.committed=\'yes\'">Book now</button>' +
          '<button onclick="document.body.dataset.searched=\'yes\'">Search flights</button></body></html>',
      );
      let current = await walk.captureSettled();
      await walk.act({ kind: 'press', key: 'Tab', note: 'Reach the synthetic control.' }, current);
      current = await walk.captureSettled();
      assert.equal((await walk.focus()).name, 'Book now');
      const actions = () => app.store.records(run.id).filter((record) => record.kind === 'action');
      const before = actions().length;
      await assert.rejects(
        walk.act(
          { kind: 'press', key, note: 'The booking boundary must refuse this input.' },
          current,
        ),
        /Stopped before a purchase, account or payment action/,
      );
      assert.equal(await walk.page.locator('body').getAttribute('data-committed'), null);
      assert.equal(actions().length, before, 'No activation input is recorded or sent.');
      await walk.act(
        { kind: 'press', key: 'Tab', note: 'Reach the ordinary search control.' },
        current,
      );
      current = await walk.captureSettled();
      assert.equal((await walk.focus()).name, 'Search flights');
      await walk.act(
        { kind: 'press', key, note: 'An ordinary search remains available.' },
        current,
      );
      assert.equal(await walk.page.locator('body').getAttribute('data-searched'), 'yes');
      assert.equal(app.store.usage(run.id).requests.length, 0);
    } finally {
      try {
        await walk.close();
      } finally {
        try {
          await app.close();
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    }
  });
