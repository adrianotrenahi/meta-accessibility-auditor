import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserWalk, ActionStateChanged } from '../src/browser.js';
import { Runner } from '../src/runner.js';
import { startServer } from '../server/index.js';
import { walkToKeyboardTarget } from '../src/keyboard-target.js';
import { declareCriterionScopes } from '../src/assessment.js';
import { exportScreenState, verifiedScreenState } from '../src/screen-state.js';
import type { Action } from '../src/models.js';
import type { RecordEntry } from '../src/types.js';

async function setup(engine: 'chromium' | 'webkit', html: string) {
  const dir = mkdtempSync(join(tmpdir(), 'meaningful-screen-'));
  const app = await startServer(0, dir, false);
  const run = app.store.create(
    'Reach a button without extra screen rows',
    app.origin + '/shop/',
    'offline',
  );
  const walk = new BrowserWalk(app.store, run.id, app.origin, true, engine);
  await walk.start(run.url);
  const fixtureUrl = app.origin + '/shop/state-fixture';
  await walk.page.route(fixtureUrl, (route) =>
    route.fulfill({ contentType: 'text/html', body: html }),
  );
  await walk.page.goto(fixtureUrl);
  const current = await walk.captureSettled();
  let pictures = 0;
  const screenshot = walk.page.screenshot.bind(walk.page);
  walk.page.screenshot = async (...args: any[]) => {
    pictures++;
    return screenshot(...args);
  };
  const runner = new Runner(app.store, app.origin);
  const step = (before: RecordEntry, action: Action, guard?: () => Promise<boolean>) =>
    (runner as any).targetKeyboardStep(run, walk, before, action, guard);
  return {
    app,
    run,
    walk,
    current,
    step,
    pictures: () => pictures,
    close: async () => {
      await walk.close();
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
const seek = {
  kind: 'focus_target',
  targetRole: 'button',
  targetName: 'Target',
  note: 'Reach Target',
} as const;
const html =
  '<style>button:focus{outline:3px solid blue;box-shadow:0 0 0 2px red}</style><button>A</button><a href="#b">B</a><button id="target">Target</button>';

for (const engine of ['chromium', 'webkit'] as const) {
  test(`${engine}: three real Tab inputs keep focus originals without three screenshots or new criterion scopes`, async () => {
    const x = await setup(engine, html);
    try {
      declareCriterionScopes(x.app.store, x.run.id);
      const before = x.app.store.records(x.run.id);
      const result = await walkToKeyboardTarget(
        x.walk,
        x.app.store,
        x.run.id,
        x.current,
        seek,
        new AbortController().signal,
        x.step,
      );
      assert.equal(result.outcome, 'reached');
      assert.equal(result.actions.length, 3);
      assert.equal(x.pictures(), 0);
      assert.equal((await x.walk.focus()).name, 'Target');
      const records = x.app.store.records(x.run.id);
      const observations = records.filter((r) => r.payload.method === 'keyboard_focus/1');
      assert.equal(observations.length, 3);
      assert.deepEqual(
        observations.map((r) => r.payload.focus.name),
        ['A', 'B', 'Target'],
      );
      assert(
        observations.every(
          (r) =>
            r.payload.sourceCaptureId === x.current.id &&
            r.payload.sourceImageHash === x.current.payload.imageHash &&
            r.payload.imageScope.includes('current-focus-is-recorded-facts-only'),
        ),
      );
      assert(
        result.actions.every(
          (r) =>
            r.payload.outcome === 'performed' &&
            r.payload.requestedAction.key === 'Tab' &&
            r.payload.before &&
            r.payload.after,
        ),
      );
      declareCriterionScopes(x.app.store, x.run.id);
      const after = x.app.store.records(x.run.id);
      assert.equal(
        after.filter((r) => r.kind === 'capture').length,
        before.filter((r) => r.kind === 'capture').length,
      );
      assert.equal(
        after.filter((r) => r.kind === 'criterion_scope').length,
        before.filter((r) => r.kind === 'criterion_scope').length,
      );
      assert.equal(x.app.store.usage().requests.length, 0);
      // A next model/activation needs a new actual image, retained as evidence of
      // the same meaningful page rather than pretending the first image changed focus.
      const original = await x.walk.captureSettled();
      assert.equal(x.pictures(), 1);
      assert.equal(original.payload.focus.name, 'Target');
      assert.equal(original.payload.screenState.purpose, 'same-state-evidence');
      assert.equal(original.payload.screenState.primaryCaptureId, x.current.id);
      assert.equal(original.payload.screenState.primaryCaptureHash, x.current.hash);
      assert(
        exportScreenState(original, after.filter((r) => r.kind === 'capture').concat(original)),
      );
    } finally {
      await x.close();
    }
  });

  test(`${engine}: lightweight focus facts cannot activate a control or survive changed focus`, async () => {
    const x = await setup(engine, html);
    try {
      const next = await x.step(x.current, { kind: 'press', key: 'Tab', note: 'Tab' });
      assert.equal(next.current.kind, 'observation');
      await assert.rejects(
        x.walk.act({ kind: 'press', key: 'Enter', note: 'Not permitted from facts' }, next.current),
        /fresh screenshot/,
      );
      const actions = x.walk.actions;
      await x.walk.page.locator('#target').focus();
      await assert.rejects(
        x.walk.act({ kind: 'press', key: 'Tab', note: 'Stale focus' }, next.current),
        ActionStateChanged,
      );
      assert.equal(x.walk.actions, actions);
      const fresh = await x.walk.captureSettled();
      const performed = await x.walk.act({ kind: 'press', key: 'Shift+Tab', note: 'Back' }, fresh);
      await x.walk.page.locator('#target').focus();
      assert.equal((await x.walk.observeKeyboardMovement(fresh, performed)).kind, 'capture');
      const changed = structuredClone(next.current);
      changed.payload.focus.name = 'Forged';
      await assert.rejects(
        x.walk.act({ kind: 'press', key: 'Tab', note: 'Forged focus' }, changed),
        /intact focus/,
      );
    } finally {
      await x.close();
    }
  });

  for (const [name, body] of [
    [
      'dialog',
      '<button onfocus="document.querySelector(\'dialog\').showModal()">Open</button><dialog><button>Close</button></dialog><button>Target</button>',
    ],
    [
      'CSS menu',
      '<style>.menu{display:none}button:focus+.menu{display:block}</style><button>Open</button><div class="menu" role="menu"><button role="menuitem">Choice</button></div><button>Target</button>',
    ],
    [
      'content',
      "<button onfocus=\"document.querySelector('output').textContent='EUR 85'\">A</button><output>EUR 42</output><button>Target</button>",
    ],
    [
      'non-control colour',
      '<style>button:focus+p{color:red}</style><button>A</button><p>Important information</p><button>Target</button>',
    ],
    ['viewport', '<div style="height:1500px"></div><button>A</button><button>Target</button>'],
    [
      'description popup',
      '<button aria-describedby="help" onfocus="document.querySelector(\'#help\').hidden=false">A</button><span id="help" role="tooltip" hidden>Important terms</span><button>Target</button>',
    ],
  ]) {
    test(`${engine}: a ${name} change takes an actual new screen instead of reusing the earlier image`, async () => {
      const x = await setup(engine, body);
      try {
        const next = await x.step(x.current, { kind: 'press', key: 'Tab', note: 'Tab' });
        assert.equal(next.current.kind, 'capture');
        assert(x.pictures() >= 1);
        assert.notEqual(next.current.payload.screenState?.purpose, 'same-state-evidence');
      } finally {
        await x.close();
      }
    });
  }
  test(`${engine}: a CSSOM control-paint change is a new original even without a DOM attribute change`, async () => {
    const x = await setup(
      engine,
      '<style>button{background:blue}</style><button>A</button><button id="target">Target</button>',
    );
    try {
      await x.walk.page.evaluate(() =>
        document.styleSheets[0]!.insertRule(
          'button{background:rgb(255,0,0)}',
          document.styleSheets[0]!.cssRules.length,
        ),
      );
      assert.equal(
        await x.walk.page.locator('#target').evaluate((el) => getComputedStyle(el).backgroundColor),
        'rgb(255, 0, 0)',
      );
      const next = await x.walk.captureSettled();
      assert.equal(next.payload.screenState?.purpose, 'screen');
      assert.equal(x.pictures(), 1);
    } finally {
      await x.close();
    }
  });

  test(`${engine}: replacing an opaque cross-origin stylesheet cannot reuse the old screen`, async () => {
    const x = await setup(engine, '<button>A</button><button id="target">Target</button>');
    let colour = 'blue';
    try {
      await x.walk.page.route('https://styles.fixture.invalid/test.css', (route) =>
        route.fulfill({ contentType: 'text/css', body: `button{background:${colour}}` }),
      );
      await x.walk.page.setContent(
        '<link rel="stylesheet" href="https://styles.fixture.invalid/test.css"><button>A</button><button id="target">Target</button>',
      );
      await x.walk.page.waitForFunction(
        () =>
          getComputedStyle(document.querySelector('#target')!).backgroundColor === 'rgb(0, 0, 255)',
      );
      assert.equal(
        await x.walk.page.evaluate(() => {
          try {
            document.styleSheets[0]!.cssRules;
            return false;
          } catch {
            return true;
          }
        }),
        true,
      );
      const primary = await x.walk.captureSettled();
      assert.equal(primary.payload.screenState?.purpose, 'screen');
      colour = 'red';
      await x.walk.page.evaluate(() => {
        const old = document.querySelector('link')!;
        const next = old.cloneNode(true);
        old.replaceWith(next);
      });
      await x.walk.page.waitForFunction(
        () =>
          getComputedStyle(document.querySelector('#target')!).backgroundColor === 'rgb(255, 0, 0)',
      );
      const changed = await x.walk.captureSettled();
      assert.equal(changed.payload.screenState?.purpose, 'screen');
    } finally {
      await x.close();
    }
  });

  test(`${engine}: new visible pseudo-element guidance takes a real original`, async () => {
    const x = await setup(
      engine,
      '<style>button:focus::after{content:"Keyboard guidance";position:absolute;left:100px;top:100px}</style><button>A</button><button id="target">Target</button>',
    );
    try {
      const next = await x.step(x.current, {
        kind: 'press',
        key: 'Tab',
        note: 'Reach the first button',
      });
      assert.equal(next.current.kind, 'capture');
      assert.notEqual(next.current.payload.screenState?.purpose, 'same-state-evidence');
      assert(x.pictures() >= 1);
    } finally {
      await x.close();
    }
  });

  for (const mode of ['open', 'closed'] as const) {
    test(`${engine}: ${mode} shadow content stays on the actual-image path`, async () => {
      const x = await setup(
        engine,
        '<x-shadow></x-shadow><button>A</button><button id="target">Target</button>',
      );
      try {
        await x.walk.page.locator('x-shadow').evaluate((element, mode) => {
          const shadow = element.attachShadow({ mode });
          shadow.innerHTML =
            '<style>button{background:blue}</style><button>Shadow control</button>';
        }, mode);
        const original = await x.walk.captureSettled();
        assert.equal(original.payload.screenState, undefined);
        const after = await x.step(original, { kind: 'press', key: 'Tab', note: 'Actual Tab' });
        assert.equal(after.current.kind, 'capture');
        assert.equal(after.current.payload.screenState, undefined);
        assert(x.pictures() >= 2);
        assert.equal(x.app.store.usage().requests.length, 0);
      } finally {
        await x.close();
      }
    });
  }

  test(`${engine}: lightweight focus decoration records its actual current paint separately`, async () => {
    const x = await setup(
      engine,
      '<style>button{background:white;color:black;box-shadow:none}button:focus{background:rgb(255,0,0);box-shadow:0 0 0 3px blue}</style><button>First</button><button id="target">Target</button>',
    );
    try {
      const next = await x.step(x.current, { kind: 'press', key: 'Tab', note: 'Actual Tab' });
      assert.equal(next.current.kind, 'observation');
      assert.equal(next.current.payload.focusAppearance.backgroundColor, 'rgb(255, 0, 0)');
      assert(next.current.payload.focusAppearance.boxShadow.includes('rgb(0, 0, 255)'));
      assert.equal(next.current.payload.sourceImageHash, x.current.payload.imageHash);
      assert.equal(x.pictures(), 0);
    } finally {
      await x.close();
    }
  });
  test(`${engine}: focus changing another control's paint takes a full original`, async () => {
    const x = await setup(
      engine,
      '<style>#first:focus ~ #target {background:red;box-shadow:0 0 0 3px blue}</style><button id="first">First</button><button id="target">Target</button>',
    );
    try {
      const next = await x.step(x.current, { kind: 'press', key: 'Tab', note: 'Actual Tab' });
      assert.equal(next.current.kind, 'capture');
      assert(x.pictures() >= 1);
      assert.notEqual(next.current.payload.screenState?.purpose, 'same-state-evidence');
    } finally {
      await x.close();
    }
  });
  test(`${engine}: a Tab-triggered declared total retains the strict original journey comparison`, async () => {
    const bundle =
      '<section itemscope itemtype="https://schema.org/Offer"><span id="price" itemprop="price">24</span><meta itemprop="priceCurrency" content="EUR"><div itemprop="includesObject" itemscope itemtype="https://schema.org/TypeAndQuantityNode"><meta itemprop="amountOfThisGood" content="1"><div itemprop="typeOfGood" itemscope itemtype="https://schema.org/Product"><meta itemprop="sku" content="bag"></div></div></section>';
    const x = await setup(
      engine,
      bundle +
        '<button onfocus="document.querySelector(\'#price\').textContent=\'48\'">First</button><button id="target">Target</button>',
    );
    try {
      const next = await x.step(x.current, { kind: 'press', key: 'Tab', note: 'Actual Tab' });
      assert.equal(next.current.kind, 'capture');
      const comparison = x.app.store
        .records(x.run.id)
        .find((record) => record.payload.method === 'comparable_totals');
      assert(comparison);
      assert.equal(comparison.payload.comparable, true);
      assert.equal(comparison.payload.beforeTotal, 24);
      assert.equal(comparison.payload.afterTotal, 48);
      assert.equal(comparison.payload.beforeCaptureId, x.current.id);
      assert.equal(comparison.payload.actionId, next.performed!.id);
      assert.equal(x.app.store.usage().requests.length, 0);
    } finally {
      await x.close();
    }
  });
  test(`${engine}: a recorded hover is a new meaningful state even on the same URL`, async () => {
    const x = await setup(
      engine,
      '<style>button:hover{background:red}</style><button>A</button><button id="target">Target</button>',
    );
    try {
      await x.walk.page.locator('#target').hover();
      const after = await x.walk.captureSettled();
      assert.equal(after.payload.screenState?.purpose, 'screen');
      assert.notEqual(
        after.payload.screenState?.fingerprint,
        x.current.payload.screenState?.fingerprint,
      );
      assert.equal(x.pictures(), 1);
    } finally {
      await x.close();
    }
  });
}

test('State grouping refuses foreign, later, changed or unsupported original links', () => {
  const primary = {
    id: 'a',
    sequence: 1,
    recordHash: 'a'.repeat(64),
    url: 'http://127.0.0.1/shop',
    title: 'Shop',
    width: 1440,
    height: 900,
    stable: true,
    screenState: { version: 'meaningful-screen/1', purpose: 'screen', fingerprint: 'f'.repeat(64) },
  };
  const evidence = {
    ...primary,
    id: 'b',
    sequence: 2,
    recordHash: 'b'.repeat(64),
    screenState: {
      version: 'meaningful-screen/1',
      purpose: 'same-state-evidence',
      fingerprint: 'f'.repeat(64),
      primaryCaptureId: 'a',
      primaryCaptureHash: primary.recordHash,
    },
  };
  assert(verifiedScreenState(primary, [primary, evidence]));
  assert(verifiedScreenState(evidence, [primary, evidence]));
  for (const change of [
    { ...evidence, url: 'http://127.0.0.1/basket' },
    { ...evidence, width: 320 },
    { ...evidence, title: 'Other' },
    { ...evidence, sequence: 1 },
    { ...evidence, stable: false },
    { ...evidence, screenState: { ...evidence.screenState, primaryCaptureHash: '0'.repeat(64) } },
    { ...evidence, screenState: { ...evidence.screenState, version: 'future' } },
    { ...evidence, screenState: { ...evidence.screenState, fingerprint: '0'.repeat(64) } },
  ])
    assert.equal(verifiedScreenState(change, [primary, change]), undefined);
  assert.equal(verifiedScreenState(evidence, [evidence]), undefined);
  assert.equal(verifiedScreenState(evidence, [primary, primary, evidence]), undefined);
});
