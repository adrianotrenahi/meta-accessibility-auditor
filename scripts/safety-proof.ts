import assert from 'node:assert/strict';
import { startServer } from '../server/index.js';
import { BrowserWalk } from '../src/browser.js';
import { mkdirSync, writeFileSync } from 'node:fs';
const app = await startServer(4324, 'data/safety-proof', false),
  results: any[] = [];
try {
  const fixtures = [
    {
      name: 'Native Pay now input',
      markup: '<form><input id="target" type="submit" value="Pay now"></form>',
      key: 'Enter' as const,
      expected: /purchase|payment/,
    },
    {
      name: 'ARIA labelled order button',
      markup:
        '<form><span id="label">Place order</span><button id="target" aria-labelledby="label"></button></form>',
      key: 'Space' as const,
      expected: /purchase|payment/,
    },
    {
      name: 'Implicit form submission',
      markup: '<form><input id="target" type="text"><input type="submit" value="Continue"></form>',
      key: 'Enter' as const,
      expected: /Implicit form submission/,
    },
  ];
  for (const fixture of fixtures) {
    const run = app.store.create(fixture.name, app.origin + '/shop/', 'offline'),
      walk = new BrowserWalk(app.store, run.id, app.origin, true);
    try {
      await walk.start(run.url);
      await walk.page.setContent(
        `<html lang="en"><head><title>Controlled safety test</title></head><body><h1>${fixture.name}</h1>${fixture.markup}<script>window.submits=0;document.querySelector('form').onsubmit=e=>{e.preventDefault();window.submits++}</script></body></html>`,
      );
      let capture = await walk.capture();
      for (let n = 0; n < 8 && (await walk.focus()).id !== 'target'; n++) {
        await walk.act(
          {
            kind: 'press',
            key: 'Alt+Tab',
            note: 'Reach the known controlled safety target with actual keys.',
          },
          capture,
        );
        capture = await walk.capture();
      }
      assert.equal((await walk.focus()).id, 'target');
      await assert.rejects(
        () =>
          walk.act(
            {
              kind: 'press',
              key: fixture.key,
              note: 'This test must refuse the unsafe activation.',
            },
            capture,
          ),
        fixture.expected,
      );
      assert.equal(await walk.page.evaluate(() => (window as any).submits), 0);
      results.push({ case: fixture.name, passed: true });
      app.store.finish(
        run.id,
        'complete',
        'Unsafe activation refused without submitting the controlled form.',
      );
    } finally {
      await walk.close();
      await walk.close();
    }
  }
  const run = app.store.create(
      'Same URL state and source identity',
      app.origin + '/shop/',
      'offline',
    ),
    walk = new BrowserWalk(app.store, run.id, app.origin, true);
  try {
    await walk.start(run.url);
    await walk.page.setContent(
      '<html><body><button>Open</button><dialog><h1>New dialog</h1><button>Close</button></dialog></body></html>',
    );
    const source = await walk.capture();
    await walk.page.locator('dialog').evaluate((e: HTMLDialogElement) => e.showModal());
    await assert.rejects(
      () =>
        walk.act({ kind: 'press', key: 'Tab', note: 'The old state must be rejected.' }, source),
      /Page state changed/,
    );
    const fresh = await walk.capture(),
      other = app.store.create('Other run', run.url, 'offline');
    const foreign = app.store.append(other.id, 'capture', 'browser', fresh.payload);
    await assert.rejects(
      () =>
        walk.act({ kind: 'press', key: 'Tab', note: 'A foreign run must be rejected.' }, foreign),
      /this run/,
    );
    results.push({ case: 'Same-URL changes and foreign-run sources', passed: true });
    app.store.finish(run.id, 'complete', 'Mismatched sources refused.');
    app.store.finish(other.id, 'complete');
  } finally {
    await walk.close();
  }
  mkdirSync('output', { recursive: true });
  writeFileSync(
    'output/safety-proof.json',
    JSON.stringify(
      { at: new Date().toISOString(), results, modelCalls: 0, creditsSpent: 0 },
      null,
      2,
    ),
  );
  console.log(JSON.stringify(results, null, 2));
} finally {
  await app.close();
}
