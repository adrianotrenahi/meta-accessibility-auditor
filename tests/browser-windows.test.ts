import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { BrowserWalk } from '../src/browser.js';
import { BrowserWindows } from '../src/browser-windows.js';

test('An expected-window route cannot outlive its deadline while checking the key receipt', async (t) => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const source = { setDefaultTimeout() {}, on() {} };
  const windows = new BrowserWindows({
    context: { on() {} } as any,
    current: () => source as any,
    active() {},
    permitted: async (raw) => new URL(raw),
    adopted() {},
    record() {},
  });
  (windows as any).pending = {
    source,
    destination: 'https://example.com/results',
    expires: 1001,
    allowedAddresses: new Set(),
    keyObserved: async () => {
      now = 1002;
      return true;
    },
    finish() {},
  };
  const allowed = await windows.allows({
    isNavigationRequest: () => true,
    frame() {
      throw Error('The first popup request has no frame yet.');
    },
    redirectedFrom: () => null,
    url: () => 'https://example.com/results',
  } as any);
  assert.equal(allowed, false);
  await windows.close();
});

for (const boundary of ['destination', 'foreground'] as const)
  test(`An expected-window handoff cannot outlive its deadline during ${boundary} verification`, async (t) => {
    let now = 1000;
    t.mock.method(Date, 'now', () => now);
    const source = { setDefaultTimeout() {}, on() {} };
    let adopted = false;
    let foregrounded = 0;
    const windows = new BrowserWindows({
      context: { on() {} } as any,
      current: () => source as any,
      active() {},
      permitted: async (raw) => {
        if (boundary === 'destination') now = 1002;
        return new URL(raw);
      },
      adopted() {
        adopted = true;
      },
      record() {},
    });
    (windows as any).pending = {
      source,
      destination: 'https://example.com/results',
      expires: 1001,
      allowedAddresses: new Set(['https://example.com/results']),
      keyObserved: async () => true,
      finish() {},
    };
    const popup = {
      opener: async () => source,
      waitForLoadState: async () => {},
      isClosed: () => false,
      url: () => 'https://example.com/results',
      bringToFront: async () => {
        foregrounded++;
        if (boundary === 'foreground') now = 1002;
      },
      close: async () => {},
    };
    await (windows as any).child(source, popup);
    assert.equal(adopted, false);
    assert.equal(foregrounded, boundary === 'destination' ? 0 : 1);
    await windows.close();
  });

async function fixture(engine: 'chromium' | 'webkit') {
  const dir = mkdtempSync(join(tmpdir(), 'browser-windows-'));
  const store = new Store(dir);
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url ?? '');
    if (req.url === '/broken') {
      res.destroy();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(
      req.url === '/results'
        ? '<title>Controlled results</title><h1>Results page</h1><button>Inspect results</button><a id="next" target="_blank" href="/final">Continue results</a>'
        : req.url === '/final'
          ? '<title>Final results</title><h1>Final results</h1>'
          : '<title>Controlled entry</title><h1>Entry page</h1><a id="next" target="_blank" href="/results">Open results</a>',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + (server.address() as any).port;
  const run = store.create(
    'Synthetic expected new-tab journey; no models.',
    origin + '/',
    'offline',
  );
  const walk = new BrowserWalk(store, run.id, origin, true, engine);
  await walk.start(run.url);
  return {
    store,
    run,
    walk,
    origin,
    requests,
    async close() {
      await walk.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

for (const engine of ['chromium', 'webkit'] as const)
  test(`Actual ${engine} follows the explicitly activated target-blank link and binds its original action`, async () => {
    const f = await fixture(engine);
    try {
      await f.walk.page.locator('#next').focus();
      const source = await f.walk.captureSettled();
      const originalPage = f.walk.page;
      const result = await f.walk.act(
        { kind: 'press', key: 'Enter', note: 'Open the actual focused results link.' },
        source,
      );
      assert.equal(f.walk.page.url(), f.origin + '/results');
      assert.notEqual(f.walk.page, originalPage);
      assert.equal(result.payload.sourceCaptureId, source.id);
      assert.deepEqual(result.sources, [source.id]);
      assert.equal(result.payload.urlBefore, f.origin + '/');
      assert.equal(result.payload.urlAfter, f.origin + '/results');
      const after = await f.walk.captureSettled();
      assert.equal(after.payload.url, f.origin + '/results');
      assert(after.payload.text.includes('Results page'));
    } finally {
      await f.close();
    }
  });

for (const engine of ['chromium', 'webkit'] as const) {
  test(`Actual ${engine} keeps an unverified broken destination separate from a followed results tab`, async () => {
    const f = await fixture(engine);
    try {
      const source = f.walk.page;
      await source.locator('#next').evaluate((element) => element.setAttribute('href', '/broken'));
      await source.locator('#next').focus();
      await f.walk.act(
        { kind: 'press', key: 'Enter', note: 'Synthetic destination with no HTTP response.' },
        await f.walk.captureSettled(),
      );
      assert.equal(f.walk.page, source);
      assert.equal(
        f.store
          .records(f.run.id)
          .filter(
            (record) =>
              record.payload.method === 'browser_window' && record.payload.outcome === 'adopted',
          ).length,
        0,
      );
    } finally {
      await f.close();
    }
  });

  test(`Actual ${engine} refuses a timer popup without changing the tracked page or contacting its destination`, async () => {
    const f = await fixture(engine);
    try {
      const source = f.walk.page;
      const popup = source.waitForEvent('popup', { timeout: 2000 });
      await source.evaluate(() => {
        setTimeout(() => window.open('/advertisement', '_blank'), 0);
      });
      const refused = await popup;
      if (!refused.isClosed()) await refused.waitForEvent('close', { timeout: 2000 });
      assert.equal(f.walk.page, source);
      assert(!f.requests.includes('/advertisement'));
      assert(
        f.store
          .records(f.run.id)
          .some(
            (record) =>
              record.payload.method === 'browser_window' && record.payload.outcome === 'refused',
          ),
      );
    } finally {
      await f.close();
    }
  });

  test(`Actual ${engine} refuses an unrelated popup during an armed link without losing the intended destination`, async (t) => {
    const f = await fixture(engine);
    try {
      const source = f.walk.page;
      await source.locator('#next').focus();
      const original = await f.walk.captureSettled();
      const press = source.keyboard.press.bind(source.keyboard);
      t.mock.method(source.keyboard, 'press', async (...args: Parameters<typeof press>) => {
        const observed = source.waitForEvent('popup', { timeout: 2000 });
        await source.evaluate(() => window.open('/advertisement', '_blank'));
        const other = await observed;
        if (!other.isClosed()) await other.waitForEvent('close', { timeout: 2000 });
        return press(...args);
      });
      await f.walk.act(
        { kind: 'press', key: 'Enter', note: 'Activate the declared results link only.' },
        original,
      );
      assert.equal(f.walk.page.url(), f.origin + '/results');
      assert(!f.requests.includes('/advertisement'));
    } finally {
      await f.close();
    }
  });

  test(`Actual ${engine} refuses a matching timer window before the real activation key`, async (t) => {
    const f = await fixture(engine);
    try {
      const source = f.walk.page;
      await source.locator('#next').focus();
      const original = await f.walk.captureSettled();
      const manager = (f.walk as any).windows;
      const record = manager.kit.record;
      let observed!: () => void;
      const decided = new Promise<void>((resolve) => {
        observed = resolve;
      });
      t.mock.method(manager.kit, 'record', (...args: any[]) => {
        record(...args);
        observed();
      });
      let premature: any;
      const press = source.keyboard.press.bind(source.keyboard);
      t.mock.method(source.keyboard, 'press', async (...args: Parameters<typeof press>) => {
        const event = source.waitForEvent('popup', { timeout: 2000 });
        await source.evaluate(() => {
          document.activeElement?.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
          );
          window.open('/results', '_blank');
        });
        premature = await event;
        await decided;
        return press(...args);
      });
      await f.walk.act(
        { kind: 'press', key: 'Enter', note: 'Only the real current activation may open results.' },
        original,
      );
      assert.equal(f.walk.page.url(), f.origin + '/results');
      assert.notEqual(f.walk.page, premature);
      assert.equal(premature.isClosed(), true);
    } finally {
      await f.close();
    }
  });

  test(`Actual ${engine} refuses an old sibling opener while following the current page's declared next tab`, async (t) => {
    const f = await fixture(engine);
    try {
      const sibling = f.walk.page;
      await sibling.locator('#next').focus();
      await f.walk.act(
        { kind: 'press', key: 'Enter', note: 'Open results.' },
        await f.walk.captureSettled(),
      );
      const current = f.walk.page;
      await current.locator('#next').focus();
      const source = await f.walk.captureSettled();
      const press = current.keyboard.press.bind(current.keyboard);
      t.mock.method(current.keyboard, 'press', async (...args: Parameters<typeof press>) => {
        const event = sibling.waitForEvent('popup', { timeout: 2000 });
        await sibling.evaluate(() => window.open('/final', '_blank'));
        const other = await event;
        if (!other.isClosed()) await other.waitForEvent('close', { timeout: 2000 });
        return press(...args);
      });
      const action = await f.walk.act(
        { kind: 'press', key: 'Enter', note: 'Follow the current results page only.' },
        source,
      );
      assert.equal(f.walk.page.url(), f.origin + '/final');
      assert.notEqual(f.walk.page, current);
      assert.notEqual(f.walk.page, sibling);
      assert.equal(action.payload.sourceCaptureId, source.id);
      assert.equal(action.payload.urlBefore, f.origin + '/results');
      assert.equal(action.payload.urlAfter, f.origin + '/final');
      assert.equal(f.walk.page.context().pages().length, 3);
    } finally {
      await f.close();
    }
  });

  test(`Actual ${engine} refuses forbidden declared destinations before sending a key`, async () => {
    const f = await fixture(engine);
    try {
      const original = f.walk.page;
      const actionCount = f.walk.actions;
      for (const href of [
        'http://127.0.0.2:9/refused',
        'http://10.0.0.1/refused',
        'https://user:password@93.184.216.34/refused',
        'javascript:window.open("/results")',
      ]) {
        await original
          .locator('#next')
          .evaluate((element, value) => element.setAttribute('href', value), href);
        await original.locator('#next').focus();
        const source = await f.walk.captureSettled();
        await assert.rejects(
          f.walk.act(
            { kind: 'press', key: 'Enter', note: 'Synthetic forbidden destination.' },
            source,
          ),
          /not permitted/,
        );
        assert.equal(f.walk.page, original);
        assert.equal(f.walk.actions, actionCount);
        const refusal = f.store.records(f.run.id).at(-1)!;
        assert.equal(refusal.payload.outcome, 'refused');
        assert.deepEqual(refusal.sources, [source.id]);
      }
      assert.equal(original.context().pages().length, 1);
      assert.equal(
        f.store.records(f.run.id).filter((record) => record.kind === 'action').length,
        0,
      );
    } finally {
      await f.close();
    }
  });

  test(`Actual ${engine} cannot adopt a late verified child after Stop and close`, async (t) => {
    const f = await fixture(engine);
    let release!: () => void;
    const delayed = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const observed = new Promise<void>((resolve) => {
      entered = resolve;
    });
    try {
      const sourcePage = f.walk.page;
      await sourcePage.locator('#next').focus();
      const source = await f.walk.captureSettled();
      const manager = (f.walk as any).windows;
      const permitted = manager.kit.permitted;
      let calls = 0;
      t.mock.method(manager.kit, 'permitted', async (raw: string) => {
        const result = await permitted(raw);
        if (++calls === 2) {
          entered();
          await delayed;
        }
        return result;
      });
      const action = f.walk
        .act(
          { kind: 'press', key: 'Enter', note: 'Synthetic navigation stopped during arrival.' },
          source,
        )
        .catch((error) => error);
      await observed;
      f.store.finish(f.run.id, 'stopped', 'Synthetic owner Stop.');
      const closing = f.walk.close();
      release();
      await closing;
      await action;
      assert.equal(f.walk.page, sourcePage);
      assert.equal(f.store.run(f.run.id).state, 'stopped');
      assert.equal(
        f.store
          .records(f.run.id)
          .filter(
            (record) =>
              record.payload.method === 'browser_window' && record.payload.outcome === 'adopted',
          ).length,
        0,
      );
      await assert.rejects(f.walk.frames.read());
    } finally {
      release();
      await f.close();
    }
  });

  test(`Actual ${engine} keeps dialog hooks and live pictures on the adopted page`, async () => {
    const f = await fixture(engine);
    try {
      await f.walk.page.locator('#next').focus();
      await f.walk.act(
        { kind: 'press', key: 'Enter', note: 'Open the declared results page.' },
        await f.walk.captureSettled(),
      );
      assert.equal(
        await f.walk.page.evaluate(() => {
          alert('Synthetic results dialog');
          return 'dismissed';
        }),
        'dismissed',
      );
      const capture = await f.walk.captureSettled();
      const frame = await f.walk.frames.read();
      assert.equal(capture.payload.url, f.origin + '/results');
      assert.equal(frame.captureId, capture.id);
      assert.equal(frame.imageHash, capture.payload.imageHash);
      const screenCount = f.store
        .records(f.run.id)
        .filter((record) => record.kind === 'capture').length;
      const movement = await f.walk.act(
        { kind: 'press', key: 'Tab', note: 'Inspect focus on the adopted results page.' },
        capture,
      );
      const observation = await f.walk.observeKeyboardMovement(capture, movement);
      assert.equal(observation.kind, 'observation');
      assert.equal(observation.payload.method, 'keyboard_focus/1');
      assert.equal(observation.payload.sourceCaptureId, capture.id);
      assert.equal(observation.payload.sourceImageHash, capture.payload.imageHash);
      assert.equal(observation.payload.focus.name, 'Inspect results');
      assert.equal(
        f.store.records(f.run.id).filter((record) => record.kind === 'capture').length,
        screenCount,
      );
    } finally {
      await f.close();
    }
  });

  test(`Actual ${engine} does not treat DOM modal dismissal or ordinary Tab as a browser window`, async (t) => {
    const f = await fixture(engine);
    try {
      const page = f.walk.page;
      const armed = t.mock.method((f.walk as any).windows, 'arm');
      await f.walk.act(
        { kind: 'press', key: 'Tab', note: 'Ordinary focus movement.' },
        await f.walk.captureSettled(),
      );
      await page.setContent(
        '<dialog open id="offer"><button id="close" onclick="document.querySelector(\'#offer\').close()">Dismiss offer</button></dialog>',
      );
      await page.locator('#close').focus();
      await f.walk.act(
        { kind: 'press', key: 'Enter', note: 'Dismiss the DOM offer.' },
        await f.walk.captureSettled(),
      );
      assert.equal(await page.locator('#offer').isVisible(), false);
      assert.equal(f.walk.page, page);
      assert.equal(page.context().pages().length, 1);
      assert.equal(armed.mock.calls.length, 0);
      assert.equal(
        f.store.records(f.run.id).filter((record) => record.payload.method === 'browser_window')
          .length,
        0,
      );
    } finally {
      await f.close();
    }
  });

  test(
    `Actual ${engine} ends an unobserved expected-window wait and refuses a later popup`,
    { timeout: 10000 },
    async () => {
      const f = await fixture(engine);
      try {
        const page = f.walk.page;
        await page
          .locator('#next')
          .evaluate((element) =>
            element.addEventListener('click', (event) => event.preventDefault()),
          );
        await page.locator('#next').focus();
        const source = await f.walk.captureSettled();
        await f.walk.act(
          { kind: 'press', key: 'Enter', note: 'Synthetic prevented new-tab activation.' },
          source,
        );
        assert.equal(f.walk.page, page);
        assert(
          f.store
            .records(f.run.id)
            .some(
              (record) =>
                record.payload.method === 'browser_window' &&
                record.payload.outcome === 'unobserved' &&
                record.sources.includes(source.id),
            ),
        );
        const event = page.waitForEvent('popup', { timeout: 2000 });
        await page.evaluate(() => window.open('/results', '_blank'));
        const late = await event;
        if (!late.isClosed()) await late.waitForEvent('close', { timeout: 2000 });
        assert.equal(f.walk.page, page);
        assert.equal(
          f.store
            .records(f.run.id)
            .filter(
              (record) =>
                record.payload.method === 'browser_window' && record.payload.outcome === 'adopted',
            ).length,
          0,
        );
      } finally {
        await f.close();
      }
    },
  );
}
