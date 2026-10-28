import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errors, type Page } from 'playwright';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, digest, recordIsIntact } from '../src/store.js';
import { BrowserWalk } from '../src/browser.js';
import {
  readNavigationCapture,
  NAVIGATION_OBSERVATION_WAIT_MS,
  type PreviousNavigationCapture,
} from '../src/navigation-observation.js';

const bodyTimeout = (method = 'ariaSnapshot', log = "  - waiting for locator('body')") =>
  new errors.TimeoutError(`locator.${method}: Timeout 150ms exceeded.\nCall log:\n${log}\n`);

function fixture() {
  const first = bodyTimeout();
  const stoppedError = new Error('The controlled run stopped.');
  const state = {
    previous: { url: 'http://example.test/from', documentEpoch: 100 } as
      PreviousNavigationCapture | undefined,
    identity: {
      url: 'http://example.test/to',
      documentEpoch: 200,
      bodyPresent: false,
      readyState: 'loading',
    } as any,
    first: first as unknown,
    second: undefined as unknown,
    closed: false,
    stopped: false,
    reads: 0,
    probes: 0,
    notifications: 0,
    waits: [] as { phase: string; timeout: number }[],
    probe: undefined as (() => Promise<void> | void) | undefined,
    wait: undefined as (() => Promise<void> | void) | undefined,
    notify: undefined as (() => void) | undefined,
    duringRead: undefined as ((number: number) => void) | undefined,
  };
  const page = {
    isClosed: () => state.closed,
    evaluate: async () => {
      state.probes++;
      await state.probe?.();
      return state.identity;
    },
    waitForLoadState: async (phase: string, options: { timeout: number }) => {
      state.waits.push({ phase, timeout: options.timeout });
      await state.wait?.();
    },
  } as unknown as Page;
  return {
    state,
    first,
    stoppedError,
    run: () =>
      readNavigationCapture(
        page,
        async () => {
          state.reads++;
          state.duringRead?.(state.reads);
          if (state.reads === 1 && state.first) throw state.first;
          if (state.reads === 2 && state.second) throw state.second;
          return 42;
        },
        state.previous,
        () => {
          if (state.stopped) throw stoppedError;
        },
        () => {
          state.notifications++;
          state.notify?.();
        },
      ),
  };
}

test('Normal observation reads once without probing or waiting', async () => {
  const x = fixture();
  x.state.first = undefined;
  assert.equal(await x.run(), 42);
  assert.equal(x.state.reads, 1);
  assert.equal(x.state.probes, 0);
  assert.equal(x.state.notifications, 0);
  assert.deepEqual(x.state.waits, []);
});

test('Only native unresolved body timeouts in a changed document receive one read-only retry', async () => {
  for (const method of ['ariaSnapshot', 'innerText', 'evaluate']) {
    const x = fixture();
    x.state.first = bodyTimeout(method);
    assert.equal(await x.run(), 42);
    assert.equal(x.state.reads, 2);
    assert.equal(x.state.probes, 1);
    assert.equal(x.state.notifications, 1);
    assert.equal(x.state.waits.length, 1);
    assert.equal(x.state.waits[0]!.phase, 'domcontentloaded');
    assert(x.state.waits[0]!.timeout > 0);
    assert(x.state.waits[0]!.timeout <= NAVIGATION_OBSERVATION_WAIT_MS);
  }
  const reload = fixture();
  reload.state.identity.url = reload.state.previous!.url;
  assert.equal(await reload.run(), 42, 'An actual changed epoch permits the same URL to reload.');
  const justAvailable = fixture();
  justAvailable.state.identity.bodyPresent = true;
  assert.equal(
    await justAvailable.run(),
    42,
    'A just-arrived body in a loading transition can settle.',
  );
  const coloured = fixture();
  coloured.state.first = bodyTimeout(
    'ariaSnapshot',
    "\u001b[2m  - waiting for locator('body')\u001b[22m",
  );
  assert.equal(await coloured.run(), 42);
});

test('Unknown, resolved-body, same-document and missing-prior failures stay hard', async () => {
  const cases: [string, (x: ReturnType<typeof fixture>) => void][] = [
    [
      'ordinary error',
      (x) => {
        x.state.first = new Error('body timed out');
      },
    ],
    [
      'name imitation',
      (x) => {
        x.state.first = Object.assign(new Error(x.first.message), { name: 'TimeoutError' });
      },
    ],
    [
      'another locator method',
      (x) => {
        x.state.first = bodyTimeout('click');
      },
    ],
    [
      'another element',
      (x) => {
        x.state.first = bodyTimeout('ariaSnapshot', "  - waiting for locator('#body')");
      },
    ],
    [
      'nested body query',
      (x) => {
        x.state.first = bodyTimeout(
          'ariaSnapshot',
          "  - waiting for locator('body').locator('button')",
        );
      },
    ],
    [
      'resolved body rendering hang',
      (x) => {
        x.state.first = bodyTimeout(
          'ariaSnapshot',
          "  - waiting for locator('body')\n  - locator resolved to <body>…</body>",
        );
      },
    ],
    [
      'missing call log',
      (x) => {
        x.state.first = new errors.TimeoutError('locator.ariaSnapshot: Timeout 150ms exceeded.');
      },
    ],
    [
      'no successful prior original',
      (x) => {
        x.state.previous = undefined;
      },
    ],
    [
      'missing previous epoch',
      (x) => {
        x.state.previous = { url: x.state.previous!.url } as any;
      },
    ],
    [
      'invalid previous epoch',
      (x) => {
        x.state.previous!.documentEpoch = NaN;
      },
    ],
    [
      'zero previous epoch',
      (x) => {
        x.state.previous!.documentEpoch = 0;
      },
    ],
    [
      'missing previous URL',
      (x) => {
        x.state.previous!.url = '';
      },
    ],
    [
      'same unchanged document',
      (x) => {
        x.state.identity.url = x.state.previous!.url;
        x.state.identity.documentEpoch = x.state.previous!.documentEpoch;
      },
    ],
    [
      'present complete body',
      (x) => {
        x.state.identity.bodyPresent = true;
        x.state.identity.readyState = 'complete';
      },
    ],
    [
      'present interactive body',
      (x) => {
        x.state.identity.bodyPresent = true;
        x.state.identity.readyState = 'interactive';
      },
    ],
    [
      'invalid current epoch',
      (x) => {
        x.state.identity.documentEpoch = 0;
      },
    ],
    [
      'invalid probe result',
      (x) => {
        x.state.identity = null;
      },
    ],
    [
      'closed page',
      (x) => {
        x.state.closed = true;
      },
    ],
  ];
  for (const [name, mutate] of cases) {
    const x = fixture();
    mutate(x);
    await assert.rejects(x.run(), (error) => error === x.state.first, name);
    assert.equal(x.state.reads, 1, name);
    assert.equal(x.state.notifications, 0, name);
    assert.deepEqual(x.state.waits, [], name);
  }
});

test('Stops and later failures never become another recovery attempt', async () => {
  const before = fixture();
  before.state.stopped = true;
  await assert.rejects(before.run(), (error) => error === before.stoppedError);
  assert.equal(before.state.reads, 0);

  for (const stage of ['first read', 'probe', 'notification', 'wait', 'retry'] as const) {
    const x = fixture();
    if (stage === 'first read')
      x.state.duringRead = () => {
        x.state.stopped = true;
      };
    if (stage === 'probe')
      x.state.probe = () => {
        x.state.stopped = true;
      };
    if (stage === 'notification')
      x.state.notify = () => {
        x.state.stopped = true;
      };
    if (stage === 'wait')
      x.state.wait = () => {
        x.state.stopped = true;
      };
    if (stage === 'retry')
      x.state.duringRead = (number) => {
        if (number === 2) x.state.stopped = true;
      };
    await assert.rejects(x.run(), (error) => error === x.stoppedError, stage);
    assert.equal(x.state.reads, stage === 'retry' ? 2 : 1, stage);
    assert(x.state.notifications <= 1, stage);
    assert(x.state.waits.length <= 1, stage);
  }
  const probe = fixture(),
    probeError = new Error('The document identity could not be read.');
  probe.state.probe = () => {
    throw probeError;
  };
  await assert.rejects(probe.run(), (error) => error === probeError);
  assert.equal(probe.state.notifications, 0);
  const wait = fixture(),
    waitError = new errors.TimeoutError('page.waitForLoadState: Timeout exceeded.');
  wait.state.wait = () => {
    throw waitError;
  };
  await assert.rejects(wait.run(), (error) => error === waitError);
  assert.equal(wait.state.reads, 1);
  const closed = fixture();
  closed.state.wait = () => {
    closed.state.closed = true;
  };
  await assert.rejects(closed.run(), (error) => error === closed.first);
  assert.equal(closed.state.reads, 1);
  const second = fixture(),
    secondError = bodyTimeout();
  second.state.second = secondError;
  await assert.rejects(second.run(), (error) => error === secondError);
  assert.equal(second.state.reads, 2);
  assert.equal(second.state.notifications, 1);
  assert.equal(second.state.waits.length, 1);
});

test('The probe and load wait share one twenty-second budget, and a hung probe stays hard', async () => {
  assert.equal(NAVIGATION_OBSERVATION_WAIT_MS, 20_000);
  const slow = fixture();
  slow.state.probe = () => new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(await slow.run(), 42);
  assert(slow.state.waits[0]!.timeout <= NAVIGATION_OBSERVATION_WAIT_MS - 30);
  const hung = fixture();
  hung.state.probe = () => new Promise(() => {});
  const started = performance.now();
  await assert.rejects(hung.run(), (error) => error === hung.first);
  assert(performance.now() - started < 5000);
  assert.equal(hung.state.reads, 1);
  assert.equal(hung.state.notifications, 0);
  assert.deepEqual(hung.state.waits, []);
});

async function delayedDocument(sameUrl: boolean) {
  let pending: ServerResponse | undefined, bodyTimer: ReturnType<typeof setTimeout> | undefined;
  let visits = 0;
  const sourcePath = sameUrl ? '/reload' : '/source';
  const nextPath = sameUrl ? sourcePath : '/delayed';
  let headReady!: () => void;
  const head = new Promise<void>((resolve) => {
    headReady = resolve;
  });
  const server = createServer((request, response) => {
    if (request.url === sourcePath && ++visits === 1) {
      response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
      const action = sameUrl ? 'location.reload()' : "location.href='/delayed'";
      response.end(
        `<html><head><title>Original page</title></head><body><button id="next" onclick="${action}">Open the delayed page</button></body></html>`,
      );
    } else if (request.url === nextPath) {
      pending = response;
      response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
      response.write('<!doctype html><html><head><title>Controlled delayed flight form</title>');
      headReady();
    } else response.writeHead(204).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    origin,
    source: origin + sourcePath,
    target: origin + nextPath,
    head,
    releaseBody() {
      assert(pending && !bodyTimer);
      bodyTimer = setTimeout(() => {
        if (!pending!.destroyed)
          pending!.end(
            '</head><body><main><h1>Flight form ready</h1><label>Origin<input name="origin"></label><label>Destination<input name="destination"></label></main></body></html>',
          );
      }, 500);
    },
    async close() {
      clearTimeout(bodyTimer);
      pending?.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

for (const engine of ['chromium', 'webkit'] as const) {
  for (const sameUrl of [false, true]) {
    test(`Actual ${engine} reads a delayed body after one retained Enter and ${sameUrl ? 'same-URL reload' : 'URL change'}`, async () => {
      const web = await delayedDocument(sameUrl);
      const directory = mkdtempSync(join(tmpdir(), 'navigation-observation-'));
      const store = new Store(directory);
      const run = store.create(
        'Controlled read-only navigation observation',
        web.source,
        'offline',
      );
      const walk = new BrowserWalk(store, run.id, web.origin, true, engine);
      try {
        await walk.start(run.url);
        await walk.page.locator('#next').focus();
        const source = await walk.captureSettled();
        const previous = { ...(walk as any).lastOriginal };
        assert.equal(previous.id, source.id);
        assert.equal(
          previous.documentEpoch,
          await walk.page.evaluate(() => performance.timeOrigin),
        );
        const sourceHash = source.hash,
          imageHash = source.payload.imageHash;
        walk.page.setDefaultTimeout(150);
        const action = await walk.act(
          {
            kind: 'press',
            key: 'Enter',
            note: 'One controlled activation, never repeated by observation recovery.',
          },
          source,
        );
        await web.head;
        assert.equal(await walk.page.locator('body').count(), 0);
        const captureOnce = (walk as any).captureOnce.bind(walk);
        let reads = 0,
          firstFailure: unknown;
        // Hold the controlled response in HEAD until the first real missing-body
        // error, then deliver BODY 500ms later. This avoids a busy-machine timing race.
        (walk as any).captureOnce = async () => {
          reads++;
          try {
            return await captureOnce();
          } catch (error) {
            if (reads === 1) {
              firstFailure = error;
              web.releaseBody();
            }
            throw error;
          }
        };
        const arrived = await walk.capture();
        assert(firstFailure instanceof errors.TimeoutError);
        assert.match(firstFailure.message, /^locator\.ariaSnapshot:/);
        assert.equal(reads, 2);
        assert.equal(arrived.payload.url, web.target);
        assert(arrived.payload.text.includes('Flight form ready'));
        assert.equal(arrived.payload.stable, true);
        assert.notEqual(arrived.id, source.id);
        assert.notEqual((walk as any).lastOriginal.documentEpoch, previous.documentEpoch);
        assert.equal(sameUrl, arrived.payload.url === source.payload.url);
        assert.equal(store.record(run.id, source.id)!.hash, sourceHash);
        assert.equal(digest(store.image(run.id, source.payload.imageFile)), imageHash);
        assert(recordIsIntact(source));
        assert(recordIsIntact(arrived));
        const rows = store.records(run.id);
        assert.equal(rows.filter((row) => row.kind === 'action').length, 1);
        assert.equal(action.payload.requestedAction.key, 'Enter');
        const waits = rows.filter(
          (row) => row.kind === 'limit' && row.payload.method === 'navigation_observation_wait',
        );
        assert.equal(waits.length, 1);
        assert.deepEqual(waits[0]!.sources, [source.id]);
        assert.equal(waits[0]!.payload.maximumWaitMs, 20_000);
        assert(
          source.seq < action.seq && action.seq < waits[0]!.seq && waits[0]!.seq < arrived.seq,
        );
        assert.equal(store.usage(run.id).requests.length, 0);
      } finally {
        await walk.close();
        store.close();
        await web.close();
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
}
