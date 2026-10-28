import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server/index.js';
import { BrowserWalk, ActionStateChanged } from '../src/browser.js';
import { navigationActionSchema, actionSchema } from '../src/models.js';

test('Fresh navigation requests use portable keys while old requested-key records remain readable', () => {
  for (const key of ['Alt+Tab', 'Alt+Shift+Tab']) {
    const action = { kind: 'press', key, note: 'Legacy original' };
    assert(actionSchema.safeParse(action).success);
    assert(!navigationActionSchema.safeParse(action).success);
  }
  assert(navigationActionSchema.safeParse({ kind: 'press', key: 'Tab', note: 'Forward' }).success);
});

for (const engine of ['chromium', 'webkit'] as const) {
  test(`Actual ${engine} refreshes a changing focus observation without repeating input, then completes a controlled search`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'meta-navigation-recovery-'));
    const app = await startServer(0, directory, false);
    const run = app.store.create('Controlled search recovery', app.origin + '/shop/', 'offline');
    const walk = new BrowserWalk(app.store, run.id, app.origin, true, engine);
    try {
      await walk.start(run.url);
      await walk.page.setContent(
        '<form action="/results"><input type="search" name="q" aria-label="Search"><button>Search</button></form>',
      );
      await walk.page.locator('input').focus();
      const before = await walk.captureSettled();
      const typed = await walk.act(
        { kind: 'type', text: 'Demo', note: 'Enter the controlled query' },
        before,
      );
      const screenshot = walk.page.screenshot.bind(walk.page);
      let shots = 0;
      walk.page.screenshot = (async (...args: Parameters<typeof screenshot>) => {
        const picture = await screenshot(...args);
        if (++shots === 1)
          await walk.page
            .locator('input')
            .evaluate((element) => (element.style.outline = '3px solid red'));
        return picture;
      }) as typeof walk.page.screenshot;
      const after = await walk.captureSettled();
      walk.page.screenshot = screenshot;
      assert.equal(shots, 2, 'One unsettled original causes one observation-only retry.');
      const originals = app.store.records(run.id).filter((record) => record.kind === 'capture');
      assert.equal(originals.at(-2)!.payload.stable, false);
      assert.equal(after.payload.stable, true);
      assert.equal(
        app.store.records(run.id).filter((record) => record.kind === 'action').length,
        1,
      );
      assert.equal(await walk.page.locator('input').inputValue(), 'Demo');
      assert.equal(typed.payload.action.text, 'Demo');
      const tab = await walk.act(
        { kind: 'press', key: 'Tab', note: 'Reach the explicit search button' },
        after,
      );
      assert.equal(tab.payload.requestedAction.key, 'Tab');
      assert.equal(tab.payload.action.key, engine === 'webkit' ? 'Alt+Tab' : 'Tab');
      assert.equal((await walk.focus()).name, 'Search');
      const reverse = await walk.act(
        { kind: 'press', key: 'Alt+Shift+Tab', note: 'Legacy reverse key record' },
        await walk.captureSettled(),
      );
      assert.equal(reverse.payload.requestedAction.key, 'Alt+Shift+Tab');
      assert.equal(reverse.payload.action.key, engine === 'webkit' ? 'Alt+Shift+Tab' : 'Shift+Tab');
      assert.equal((await walk.focus()).tag, 'input');
      await walk.act(
        { kind: 'press', key: 'Tab', note: 'Return to the explicit button' },
        await walk.captureSettled(),
      );
      await walk.page.route('**/results?*', (route) =>
        route.fulfill({ contentType: 'text/html', body: '<h1>Results for Demo</h1>' }),
      );
      await walk.act(
        { kind: 'press', key: 'Enter', note: 'Submit the explicit search' },
        await walk.captureSettled(),
      );
      const result = await walk.captureSettled();
      assert.equal(new URL(result.payload.url).searchParams.get('q'), 'Demo');
      assert.match(result.payload.text, /Results for Demo/);
      assert.equal(app.store.usage().requests.length, 0);
    } finally {
      await walk.close();
      await app.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test('Three unsettled originals stop without another input; a stale decision is refused before input', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'meta-navigation-bound-'));
  const app = await startServer(0, directory, false);
  const run = app.store.create('Bounded observation recovery', app.origin + '/shop/', 'offline');
  const walk = new BrowserWalk(app.store, run.id, app.origin, true, 'chromium');
  try {
    const original = await walk.start(run.url);
    const inputCount = walk.actions;
    await walk.page
      .locator('body')
      .evaluate((body) => body.setAttribute('aria-label', 'Changed after capture'));
    await assert.rejects(
      walk.act({ kind: 'press', key: 'Tab', note: 'Stale decision' }, original),
      ActionStateChanged,
    );
    assert.equal(walk.actions, inputCount);
    const screenshot = walk.page.screenshot.bind(walk.page);
    let shots = 0;
    walk.page.screenshot = (async (...args: Parameters<typeof screenshot>) => {
      const picture = await screenshot(...args);
      await walk.page
        .locator('body')
        .evaluate((body, label) => body.setAttribute('aria-label', label), `Changed ${++shots}`);
      return picture;
    }) as typeof walk.page.screenshot;
    await assert.rejects(walk.captureSettled(), /three observations/);
    assert.equal(shots, 3);
    const records = app.store.records(run.id);
    assert(
      records
        .filter((record) => record.kind === 'capture')
        .slice(-3)
        .every((record) => record.payload.stable === false),
    );
    assert.equal(records.filter((record) => record.kind === 'action').length, 0);
    assert.equal(records.at(-1)!.sources.length, 3);
    assert.equal(app.store.usage().requests.length, 0);
  } finally {
    await walk.close();
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
