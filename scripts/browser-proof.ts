import assert from 'node:assert/strict';
import { startServer } from '../server/index.js';
import { BrowserWalk } from '../src/browser.js';
import { mkdirSync, writeFileSync } from 'node:fs';
if (process.argv.includes('--ui')) {
  await import('./ui-proof.js');
} else if (process.argv.includes('--safety')) {
  await import('./safety-proof.js');
} else {
  const app = await startServer(4321, 'data/browser-proof', false),
    results: any[] = [];
  try {
    for (const broken of [false, true]) {
      const url = app.origin + '/shop/' + (broken ? '?case=broken' : '');
      const run = app.store.create('Controlled keyboard proof', url, 'offline'),
        walk = new BrowserWalk(app.store, run.id, app.origin, true);
      try {
        let capture = await walk.start(url);
        const scan = await walk.measurements(capture);
        const unnamed = scan.payload.violations.some((v: any) => v.id === 'button-name');
        assert.equal(
          unnamed,
          broken,
          'The actual accessibility measurement must distinguish named and unnamed buttons.',
        );
        for (const key of ['Alt+Tab', 'Alt+Tab', 'Alt+Tab'] as const) {
          await walk.act(
            {
              kind: 'press',
              key,
              note: 'Use the Mac WebKit Option-Tab pattern to include links in keyboard traversal.',
            },
            capture,
          );
          capture = await walk.capture();
        }
        assert.equal((await walk.focus()).tag, 'button');
        await walk.act(
          { kind: 'press', key: 'Enter', note: 'Activate the non-purchasing basket action.' },
          capture,
        );
        capture = await walk.capture();
        assert.match(await walk.page.locator('#status').innerText(), /Added/);
        for (const key of ['Alt+Tab', 'Enter'] as const) {
          await walk.act(
            { kind: 'press', key, note: 'Follow the basket link by keyboard.' },
            capture,
          );
          capture = await walk.capture();
        }
        assert.match(walk.page.url(), /basket/);
        for (let n = 0; n < 12 && (await walk.focus()).tag !== 'input'; n++) {
          await walk.act(
            {
              kind: 'press',
              key: 'Alt+Tab',
              note: 'Find the email field using the same recorded Mac WebKit keyboard pattern.',
            },
            capture,
          );
          capture = await walk.capture();
        }
        assert.equal((await walk.focus()).tag, 'input');
        await walk.act(
          { kind: 'type', text: 'test@example.org', note: 'Enter approved synthetic email.' },
          capture,
        );
        capture = await walk.capture();
        for (const key of ['Alt+Tab', 'Enter'] as const) {
          await walk.act(
            { kind: 'press', key, note: 'Open the non-committing review dialog.' },
            capture,
          );
          capture = await walk.capture();
        }
        const focusInside = await walk.page.evaluate(
          () => !!document.querySelector('dialog')?.contains(document.activeElement),
        );
        assert.equal(
          focusInside,
          !broken,
          'The paired dialog examples must distinguish real focus movement.',
        );
        app.store.append(
          run.id,
          'observation',
          'browser-proof',
          {
            method: 'real_keyboard',
            unnamedButton: unnamed,
            dialogFocusInside: focusInside,
            expectedBrokenCase: broken,
          },
          [capture.id],
        );
        app.store.finish(
          run.id,
          'complete',
          'Controlled keyboard proof completed; no model calls or screen-reader claims.',
        );
        results.push({
          case: broken ? 'broken' : 'clean',
          runId: run.id,
          unnamedButton: unnamed,
          dialogFocusInside: focusInside,
          actions: walk.actions,
          result: 'passed',
        });
      } finally {
        await walk.close();
      }
    }
    const feedbackRun = await app.runner.start({
      mode: 'offline',
      url: app.origin + '/shop/?case=broken&extra=1',
      headless: true,
      voiceOver: false,
    });
    await app.runner.completion;
    const feedbackRecords = app.store.records(feedbackRun.id);
    assert(
      feedbackRecords.some(
        (r) =>
          r.kind === 'action' && r.payload.before.id === 'add' && r.payload.action.key === 'Enter',
      ),
      'The saved driver must actually activate the known target despite an extra focusable link.',
    );
    assert(
      feedbackRecords
        .filter((r) => r.kind === 'capture')
        .at(-1)
        ?.payload.url.includes('/basket'),
    );
    assert.equal(app.store.usage(feedbackRun.id).requests.length, 0);
    results.push({
      case: 'Saved driver with an extra focusable link',
      runId: feedbackRun.id,
      result: 'passed',
    });
    mkdirSync('output', { recursive: true });
    writeFileSync(
      'output/browser-proof.json',
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
}
