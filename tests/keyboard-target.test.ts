import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserWalk, ActionStateChanged } from '../src/browser.js';
import { startServer } from '../server/index.js';
import {
  walkToKeyboardTarget,
  traversalPageShape,
  MAX_TARGET_KEYS,
} from '../src/keyboard-target.js';
import { MetaModels, navigationActionSchema, type Action } from '../src/models.js';
import { Runner } from '../src/runner.js';
import { VoiceOverProbe } from '../src/voiceover.js';
import { RoleAllowanceLimit } from '../src/role-allowance.js';
import { PHASE } from '../src/types.js';
import { digest } from '../src/store.js';

async function setup(engine: 'chromium' | 'webkit', html: string) {
  const dir = mkdtempSync(join(tmpdir(), 'keyboard-target-'));
  const app = await startServer(0, dir, false);
  const run = app.store.create(
    'Reach a control with actual keys',
    app.origin + '/shop/',
    'offline',
  );
  const walk = new BrowserWalk(app.store, run.id, app.origin, true, engine);
  await walk.start(run.url);
  await walk.page.setContent(html);
  const observedStates = new Map<string, any>();
  const observedState = (walk as any).observedState.bind(walk);
  let latestState: any;
  (walk as any).observedState = async () => {
    const value = await observedState();
    observedStates.set(digest(JSON.stringify(value)), value);
    latestState = value;
    return value;
  };
  const staleRefusals: any[] = [];
  const current = await walk.captureSettled();
  const signal = new AbortController();
  const verifyOriginal = walk.verifyOriginalCapture.bind(walk);
  walk.verifyOriginalCapture = async (source) => {
    try {
      await verifyOriginal(source);
    } catch (error) {
      if (error instanceof ActionStateChanged) {
        const previous = observedStates.get(source.payload.stateStamp);
        const differences = Object.keys(latestState ?? {})
          .filter((key) => JSON.stringify(previous?.[key]) !== JSON.stringify(latestState[key]))
          .map((key) => ({ key, original: previous?.[key], current: latestState[key] }));
        staleRefusals.push({ sourceId: source.id, stable: source.payload.stable, differences });
        error.message += ` Exact recorded state differences: ${JSON.stringify(differences)}.`;
      }
      throw error;
    }
  };
  const step = async (before: any, action: Action, guard?: () => Promise<boolean>) => {
    try {
      const performed = await walk.act(action, before, guard);
      return { performed, current: await walk.captureSettled() };
    } catch (error) {
      if (!(error instanceof ActionStateChanged)) throw error;
      return { current: await walk.captureSettled() };
    }
  };
  return {
    app,
    run,
    walk,
    current,
    signal,
    step,
    staleRefusals,
    async close() {
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
  note: 'Reach the original control',
} as const;

test('Fresh target decisions need one exact reference and keep activation explicit', () => {
  for (const value of [
    seek,
    { ...seek, targetRole: undefined, targetName: undefined, targetId: 'e2' },
  ])
    assert(navigationActionSchema.safeParse(value).success);
  for (const value of [
    { ...seek, targetRole: undefined },
    { ...seek, targetId: 'e2' },
    { ...seek, key: 'Enter' },
    { ...seek, text: 'typed' },
    { ...seek, targetName: '' },
  ])
    assert(!navigationActionSchema.safeParse(value).success);
});

test('Traversal ignores only plain noninteractive tooltips while retaining changed controls/prices', () => {
  const aria = '- button "A"\n- button "Target"';
  assert.equal(traversalPageShape(aria + '\n- tooltip "Keyboard help"\n  - text: Use Tab'), aria);
  assert.notEqual(traversalPageShape(aria + '\n- tooltip "Actions"\n  - button "Pay"'), aria);
  assert.notEqual(traversalPageShape(aria + '\n- text: EUR 48'), aria);
});

for (const engine of ['chromium', 'webkit'] as const) {
  test(`Actual ${engine} reaches a named control with several original key/screen records and no activation`, async () => {
    const x = await setup(
      engine,
      '<button>A</button><a href="#b">B</a><button id="target" onclick="this.textContent=\'Activated\'">Target</button>',
    );
    try {
      const result = await walkToKeyboardTarget(
        x.walk,
        x.app.store,
        x.run.id,
        x.current,
        seek,
        x.signal.signal,
        x.step,
      );
      assert.equal(result.outcome, 'reached', JSON.stringify(x.staleRefusals));
      assert.equal(result.actions.length, 3);
      assert.equal((await x.walk.focus()).name, 'Target');
      assert.equal(await x.walk.page.locator('#target').textContent(), 'Target');
      assert(
        result.actions.every(
          (r) =>
            r.payload.requestedAction.key === 'Tab' &&
            r.payload.action.key === (engine === 'webkit' ? 'Alt+Tab' : 'Tab') &&
            r.payload.outcome === 'performed',
        ),
      );
      for (const r of result.actions)
        assert(x.app.store.record(x.run.id, r.payload.sourceCaptureId));
      assert.equal(x.app.store.records(x.run.id).filter((r) => r.kind === 'capture').length, 5);
      assert.equal(x.app.store.usage().requests.length, 0);
      const activation: Action = {
        kind: 'press',
        key: 'Enter',
        note: 'Explicit separate activation',
      };
      // A separate decision takes a fresh original; a refused input is never replayed.
      const first = await x.step(await x.walk.captureSettled(), activation);
      if (!first.performed) {
        assert.equal(await x.walk.page.locator('#target').textContent(), 'Target');
        assert.equal((await x.walk.focus()).name, 'Target');
        const refreshed = await x.step(first.current, activation);
        assert(refreshed.performed, 'Fresh separate activation must actually send its input.');
      }
      assert.equal(await x.walk.page.locator('#target').textContent(), 'Activated');
    } finally {
      await x.close();
    }
  });

  test(`Actual ${engine} runner asks once for multiple Tabs and preserves role-budget limits without stopping navigation`, async () => {
    const x = await setup(engine, '<button>A</button><button>B</button><button>Target</button>');
    const runner = new Runner(x.app.store, x.app.origin);
    let decisions = 0;
    const reason = mock.method(MetaModels.prototype, 'reason', async () =>
      ++decisions === 1 ? seek : { kind: 'finish', note: 'Original target is reached.' },
    );
    const analyse = mock.method(runner as any, 'analyse', async () => {
      throw new RoleAllowanceLimit('analyst', 'Phase spending limit reached.');
    });
    const review = mock.method(runner as any, 'review', async () => {});
    try {
      await (runner as any).live(x.run, x.walk, new VoiceOverProbe(x.walk), x.current, x.signal);
      assert.equal(decisions, 2, 'One target decision plus finish, not one decision per Tab.');
      assert.equal(
        x.app.store.records(x.run.id).filter((r) => r.kind === 'action').length,
        3,
        JSON.stringify(x.staleRefusals),
      );
      assert(
        x.app.store
          .records(x.run.id)
          .some((r) => r.kind === 'limit' && r.payload.reason?.includes('Navigation continues')),
      );
      assert.equal((await x.walk.focus()).name, 'Target');
      assert.equal(x.app.store.usage().requests.length, 0);
    } finally {
      reason.mock.restore();
      analyse.mock.restore();
      review.mock.restore();
      await x.close();
    }
  });
}

test('Missing/ambiguous/disabled targets and changed original payload send no keys', async () => {
  const x = await setup(
    'chromium',
    '<button>Target</button><button>Target</button><button disabled>Disabled</button>',
  );
  try {
    for (const targetName of ['Missing', 'Target', 'Disabled']) {
      const r = await walkToKeyboardTarget(
        x.walk,
        x.app.store,
        x.run.id,
        x.current,
        { ...seek, targetName },
        x.signal.signal,
        x.step,
      );
      assert.equal(r.outcome, 'unavailable');
      assert.equal(r.actions.length, 0);
    }
    await assert.rejects(
      walkToKeyboardTarget(
        x.walk,
        x.app.store,
        x.run.id,
        { ...x.current, payload: { ...x.current.payload, aria: 'changed' } },
        seek,
        x.signal.signal,
        x.step,
      ),
      /intact original/,
    );
    assert.equal(x.app.store.records(x.run.id).filter((r) => r.kind === 'action').length, 0);
  } finally {
    await x.close();
  }
});

test('A focus-triggered page change or target replacement ends traversal before another key', async () => {
  for (const change of [
    "document.querySelector('h1').textContent='Changed price EUR 48'",
    "document.querySelector('#target').outerHTML='<button id=target>Target</button>'",
  ]) {
    const x = await setup(
      'chromium',
      `<h1>Original</h1><button onfocus="${change}">A</button><button id="target">Target</button>`,
    );
    try {
      const result = await walkToKeyboardTarget(
        x.walk,
        x.app.store,
        x.run.id,
        x.current,
        seek,
        x.signal.signal,
        x.step,
      );
      assert.equal(result.outcome, 'changed');
      assert.equal(result.actions.length, 1);
      assert.notEqual((await x.walk.focus()).name, 'Target');
    } finally {
      await x.close();
    }
  }
});

test('An unreachable target stops at a focus cycle and never directly focuses it', async () => {
  const x = await setup('chromium', '<button>A</button><button tabindex="-1">Target</button>');
  try {
    const result = await walkToKeyboardTarget(
      x.walk,
      x.app.store,
      x.run.id,
      x.current,
      seek,
      x.signal.signal,
      x.step,
    );
    assert.equal(result.outcome, 'cycle');
    assert(result.actions.length <= 3);
    assert.notEqual((await x.walk.focus()).name, 'Target');
    assert(
      x.app.store
        .records(x.run.id)
        .some(
          (r) => r.kind === 'limit' && r.payload.reason.includes('no website keyboard barrier'),
        ),
    );
  } finally {
    await x.close();
  }
});

test('Cancelled traversal and stale source refuse before a key; physical action allowance remains enforced', async () => {
  const x = await setup('chromium', '<button>A</button><button>Target</button>');
  try {
    x.signal.abort();
    await assert.rejects(
      walkToKeyboardTarget(x.walk, x.app.store, x.run.id, x.current, seek, x.signal.signal, x.step),
    );
    assert.equal(x.app.store.records(x.run.id).filter((r) => r.kind === 'action').length, 0);
    await x.walk.page.locator('body').evaluate((e) => e.setAttribute('aria-label', 'Changed page'));
    await assert.rejects(
      walkToKeyboardTarget(
        x.walk,
        x.app.store,
        x.run.id,
        x.current,
        seek,
        new AbortController().signal,
        x.step,
      ),
      ActionStateChanged,
    );
    const current = await x.walk.captureSettled();
    x.walk.actions = 119;
    await assert.rejects(
      walkToKeyboardTarget(
        x.walk,
        x.app.store,
        x.run.id,
        current,
        { ...seek, targetName: 'A' },
        new AbortController().signal,
        x.step,
      ),
      /action limit/,
    );
    assert.equal(x.app.store.records(x.run.id).filter((r) => r.kind === 'action').length, 1);
    assert.equal(x.walk.actions, 120);
  } finally {
    await x.close();
  }
});

test('A bounded traversal stops after24 real keys when no earlier condition stops it', async () => {
  const x = await setup(
    'chromium',
    Array.from({ length: 28 }, (_, i) => `<button>B${i}</button>`).join('') +
      '<button>Target</button>',
  );
  try {
    const result = await walkToKeyboardTarget(
      x.walk,
      x.app.store,
      x.run.id,
      x.current,
      seek,
      x.signal.signal,
      x.step,
    );
    assert.equal(result.outcome, 'limit');
    assert.equal(result.actions.length, MAX_TARGET_KEYS);
  } finally {
    await x.close();
  }
});

test('The same legacy role budget remains a hard refusal before spending', async () => {
  const x = await setup('chromium', '<button>Target</button>');
  try {
    const approved = {
      approvedBy: 'Adriano' as const,
      maxUsd: 5,
      maxRunUsd: 3,
      approvedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    };
    assert.throws(
      () => x.app.store.reserve(x.run.id, 'analyst', PHASE.analyst + 1, approved),
      RoleAllowanceLimit,
    );
    assert.equal(x.app.store.usage().requests.length, 0);
  } finally {
    await x.close();
  }
});

for (const engine of ['chromium', 'webkit'] as const) {
  test(`Actual ${engine} reaches a roving calendar cell with real arrows, records selection changes and explicitly confirms`, async () => {
    const grid =
      '<button id="dates">Choose dates</button><table aria-label="Calendar"><tr>' +
      [1, 2, 3, 4]
        .map(
          (day) =>
            `<td><span role="checkbox" aria-label="Day ${day}" tabindex="${day === 1 ? 0 : -1}" aria-checked="${day === 1 ? 'true' : 'false'}">${day}</span></td>`,
        )
        .join('') +
      '</tr></table><script>document.querySelectorAll("[role=checkbox]").forEach((cell,i,cells)=>cell.addEventListener("keydown",e=>{if(e.key==="ArrowRight"){e.preventDefault();let next=cells[(i+1)%cells.length];cell.tabIndex=-1;cell.setAttribute("aria-checked","false");next.tabIndex=0;next.setAttribute("aria-checked","true");next.focus();}if(e.key==="Enter"){document.querySelector("#dates").textContent="Selected "+cell.getAttribute("aria-label");document.querySelector("table").remove();}}));</script>';
    const x = await setup(engine, grid);
    try {
      await x.walk.act({ kind: 'press', key: 'Tab', note: 'Reach date button' }, x.current);
      let current = await x.walk.captureSettled();
      await x.walk.act({ kind: 'press', key: 'Tab', note: 'Enter native calendar grid' }, current);
      current = await x.walk.captureSettled();
      assert.equal((await x.walk.focus()).name, 'Day 1');
      const result = await walkToKeyboardTarget(
        x.walk,
        x.app.store,
        x.run.id,
        current,
        {
          ...seek,
          targetRole: 'checkbox',
          targetName: 'Day 4',
          traversalKey: 'ArrowRight',
          activation: 'Enter',
        },
        x.signal.signal,
        x.step,
      );
      assert.equal(
        result.outcome,
        'activation_sent',
        JSON.stringify({
          staleRefusals: x.staleRefusals,
          actions: result.actions.map((row) => row.payload.action.key),
          limits: x.app.store
            .records(x.run.id)
            .filter((row) => row.kind === 'limit')
            .map((row) => row.payload),
        }),
      );
      assert.deepEqual(
        result.actions.map((r) => r.payload.action.key),
        ['ArrowRight', 'ArrowRight', 'ArrowRight', 'Enter'],
      );
      assert.equal(await x.walk.page.locator('#dates').innerText(), 'Selected Day 4');
      assert.equal(await x.walk.page.locator('table').count(), 0);
      assert(
        x.app.store
          .records(x.run.id)
          .filter((r) => r.kind === 'capture')
          .some((r) => r.payload.aria.includes('Day 2" [checked]')),
      );
      assert.equal(x.app.store.usage().requests.length, 0);
    } finally {
      await x.close();
    }
  });
}

test('Exact accessible names retain literal quotes and backslashes for target matching', async () => {
  const x = await setup(
    'chromium',
    '<button>A</button><input role="combobox" aria-label="Arrival city &quot;Anywhere&quot; \\ terminal">',
  );
  try {
    const target = x.current.payload.elements.find((e: any) => e.role === 'combobox');
    assert.equal(target.name, 'Arrival city "Anywhere" \\ terminal');
    const result = await walkToKeyboardTarget(
      x.walk,
      x.app.store,
      x.run.id,
      x.current,
      { ...seek, targetRole: 'combobox', targetName: target.name },
      x.signal.signal,
      x.step,
    );
    assert.equal(result.outcome, 'reached', JSON.stringify(x.staleRefusals));
    assert.equal(result.actions.length, 2);
    assert.equal((await x.walk.focus()).name, target.name);
  } finally {
    await x.close();
  }
});

test('Explicit target activation still refuses booking commitments before Enter', async () => {
  const x = await setup(
    'chromium',
    '<button>A</button><button onclick="document.body.dataset.booked=\'yes\'">Confirm booking</button>',
  );
  try {
    await assert.rejects(
      walkToKeyboardTarget(
        x.walk,
        x.app.store,
        x.run.id,
        x.current,
        { ...seek, targetName: 'Confirm booking', activation: 'Enter' },
        x.signal.signal,
        x.step,
      ),
      /purchase, account or payment/,
    );
    assert.equal(await x.walk.page.locator('body').getAttribute('data-booked'), null);
    assert(
      x.app.store
        .records(x.run.id)
        .filter((r) => r.kind === 'action')
        .every((r) => r.payload.action.key === 'Tab'),
    );
  } finally {
    await x.close();
  }
});

test('Arrow traversal requires focus in the same original native grid', async () => {
  const x = await setup(
    'chromium',
    '<button>A</button><table><tr><td><span role="checkbox" tabindex="0" aria-label="Target">1</span></td></tr></table>',
  );
  try {
    const result = await walkToKeyboardTarget(
      x.walk,
      x.app.store,
      x.run.id,
      x.current,
      { ...seek, targetRole: 'checkbox', traversalKey: 'ArrowRight' },
      x.signal.signal,
      x.step,
    );
    assert.equal(result.outcome, 'unavailable');
    assert.equal(result.actions.length, 0);
  } finally {
    await x.close();
  }
});

test('Runner refreshes a target that changed during the model decision without performing stale input', async () => {
  const x = await setup('chromium', '<h1>Original</h1><button>A</button><button>Target</button>');
  const runner = new Runner(x.app.store, x.app.origin);
  let decisions = 0;
  const reason = mock.method(MetaModels.prototype, 'reason', async () => {
    decisions++;
    if (decisions === 1) {
      await x.walk.page.locator('h1').evaluate((e) => (e.textContent = 'Changed while thinking'));
      return seek;
    }
    return decisions === 2 ? seek : { kind: 'finish', note: 'The fresh target was reached.' };
  });
  const analyse = mock.method(
    runner as any,
    'analyseCheckpoint',
    async (_m: any, _r: any, current: any) => current,
  );
  const review = mock.method(runner as any, 'review', async () => {});
  try {
    await (runner as any).live(x.run, x.walk, new VoiceOverProbe(x.walk), x.current, x.signal);
    assert.equal(decisions, 3);
    assert.equal((await x.walk.focus()).name, 'Target');
    const actions = x.app.store.records(x.run.id).filter((r) => r.kind === 'action');
    assert.equal(actions.length, 2);
    assert(actions.every((r) => r.payload.sourceCaptureId !== x.current.id));
    assert(
      x.app.store
        .records(x.run.id)
        .some((r) => r.kind === 'limit' && r.payload.reason?.includes('No stale target input')),
    );
  } finally {
    reason.mock.restore();
    analyse.mock.restore();
    review.mock.restore();
    await x.close();
  }
});

test('Native grid traversal still stops after an unrelated price change', async () => {
  const html =
    '<p id="price">EUR24</p><table><tr><td><span role="checkbox" aria-label="Day1" tabindex="0" aria-checked="true">1</span></td><td><span role="checkbox" aria-label="Target" tabindex="-1" aria-checked="false">2</span></td></tr></table><script>document.querySelector("[aria-label=Day1]").onkeydown=e=>{if(e.key==="ArrowRight"){document.querySelector("#price").textContent="EUR48";e.preventDefault();}}</script>';
  const x = await setup('chromium', html);
  try {
    await x.walk.act({ kind: 'press', key: 'Tab', note: 'Enter grid' }, x.current);
    const current = await x.walk.captureSettled();
    const result = await walkToKeyboardTarget(
      x.walk,
      x.app.store,
      x.run.id,
      current,
      { ...seek, targetRole: 'checkbox', traversalKey: 'ArrowRight' },
      x.signal.signal,
      x.step,
    );
    assert.equal(result.outcome, 'changed');
    assert.equal(result.actions.length, 1);
  } finally {
    await x.close();
  }
});

test('Explicit target checkbox activation retains original opt-out measurements', async () => {
  const html =
    '<div itemscope itemtype="https://schema.org/Offer" itemprop="addOn"><meta itemprop="sku" content="gift-wrap"><meta itemprop="price" content="5.00"><meta itemprop="priceCurrency" content="EUR"><label><input id="gift" type="checkbox" checked>Gift wrap</label></div>';
  const x = await setup('chromium', html);
  const runner = new Runner(x.app.store, x.app.origin);
  try {
    const result = await walkToKeyboardTarget(
      x.walk,
      x.app.store,
      x.run.id,
      x.current,
      { ...seek, targetRole: 'checkbox', targetName: 'Gift wrap', activation: 'Space' },
      x.signal.signal,
      (before, action, guard) =>
        (runner as any).targetKeyboardStep(x.run, x.walk, before, action, guard),
    );
    assert.equal(result.outcome, 'activation_sent');
    assert.equal(await x.walk.page.locator('#gift').isChecked(), false);
    const observation = x.app.store
      .records(x.run.id)
      .find((r) => r.payload.method === 'optout_context');
    assert(observation, 'Actual opt-out evidence must not disappear in the faster path.');
    assert(observation.sources.includes(result.actions.at(-1)!.id));
  } finally {
    await x.close();
  }
});

test('A named ARIA gridcell uses the same bounded original native-arrow path', async () => {
  const x = await setup(
    'chromium',
    '<div role="grid"><div role="row"><span role="gridcell" tabindex="0" aria-label="Day1">1</span><span role="gridcell" tabindex="-1" aria-label="Target">2</span></div></div><script>document.querySelector("[aria-label=Day1]").onkeydown=e=>{if(e.key==="ArrowRight"){e.preventDefault();document.querySelector("[aria-label=Target]").focus();}}</script>',
  );
  try {
    await x.walk.act({ kind: 'press', key: 'Tab', note: 'Enter grid' }, x.current);
    const current = await x.walk.captureSettled();
    const decision = {
      ...seek,
      targetRole: 'gridcell' as const,
      traversalKey: 'ArrowRight' as const,
    };
    assert(navigationActionSchema.safeParse(decision).success);
    const result = await walkToKeyboardTarget(
      x.walk,
      x.app.store,
      x.run.id,
      current,
      decision,
      x.signal.signal,
      x.step,
    );
    assert.equal(result.outcome, 'reached', JSON.stringify(x.staleRefusals));
    assert.equal(result.actions.length, 1);
  } finally {
    await x.close();
  }
});

test('An identical target replacement during context reads cannot inherit explicit activation', async () => {
  const x = await setup(
    'chromium',
    `<button id="target" onclick="document.body.dataset.activated='old'">Target</button>`,
  );
  const runner = new Runner(x.app.store, x.app.origin);
  let swapped = false;
  try {
    const result = await walkToKeyboardTarget(
      x.walk,
      x.app.store,
      x.run.id,
      x.current,
      { ...seek, activation: 'Enter' },
      x.signal.signal,
      async (before, action, guard) => {
        if (action.key === 'Enter' && !swapped) {
          swapped = true;
          await x.walk.page.locator('#target').evaluate((element) => {
            const next = element.cloneNode(true) as HTMLElement;
            next.setAttribute('onclick', "document.body.dataset.activated='replacement'");
            element.replaceWith(next);
            next.focus();
          });
        }
        return (runner as any).targetKeyboardStep(x.run, x.walk, before, action, guard);
      },
    );
    assert(swapped);
    assert.equal(result.outcome, 'changed');
    assert.equal(await x.walk.page.locator('body').getAttribute('data-activated'), null);
    assert(
      x.app.store
        .records(x.run.id)
        .filter((r) => r.kind === 'action')
        .every((r) => r.payload.action.key === 'Tab'),
    );
  } finally {
    await x.close();
  }
});

test('Loading waits remain bounded without requiring a model call every second', async () => {
  const x = await setup('chromium', '<button>A</button>');
  try {
    for (const waitMs of [0, 799, 10001, NaN]) {
      assert(!navigationActionSchema.safeParse({ kind: 'wait', waitMs, note: 'Loading' }).success);
      await assert.rejects(
        x.walk.act({ kind: 'wait', waitMs, note: 'Loading' }, x.current),
        /loading wait/i,
      );
    }
    assert.equal(x.app.store.records(x.run.id).filter((r) => r.kind === 'action').length, 0);
    const waits: number[] = [];
    const original = x.walk.page.waitForTimeout.bind(x.walk.page);
    x.walk.page.waitForTimeout = async (ms: number) => {
      waits.push(ms);
    };
    try {
      await x.walk.act(
        { kind: 'wait', waitMs: 10000, note: 'Allow the actual results to load' },
        x.current,
      );
    } finally {
      x.walk.page.waitForTimeout = original;
    }
    assert.deepEqual(waits, [10000, 180]);
  } finally {
    await x.close();
  }
});

test('Stop during a target path records the sent key and sends no next key', async () => {
  const x = await setup('chromium', '<button>A</button><button>B</button><button>Target</button>');
  try {
    await assert.rejects(
      walkToKeyboardTarget(
        x.walk,
        x.app.store,
        x.run.id,
        x.current,
        seek,
        x.signal.signal,
        async (before, action, guard) => {
          const result = await x.step(before, action, guard);
          x.signal.abort();
          return result;
        },
      ),
    );
    assert.equal(x.app.store.records(x.run.id).filter((r) => r.kind === 'action').length, 1);
    assert.equal((await x.walk.focus()).name, 'A');
  } finally {
    await x.close();
  }
});

test('Focus-appearance changes refresh one unsent key without another model decision or duplicate input', async () => {
  const x = await setup('chromium', '<button>A</button><button>Target</button>');
  const runner = new Runner(x.app.store, x.app.origin);
  let attempts = 0;
  try {
    const result = await walkToKeyboardTarget(
      x.walk,
      x.app.store,
      x.run.id,
      x.current,
      seek,
      x.signal.signal,
      async (before, action, guard) => {
        if (++attempts === 1)
          await x.walk.page.locator('body').evaluate((e) => (e.style.outline = '3px solid red'));
        return (runner as any).targetKeyboardStep(x.run, x.walk, before, action, guard);
      },
    );
    assert.equal(result.outcome, 'reached', JSON.stringify(x.staleRefusals));
    assert.equal(result.actions.length, 2);
    assert.equal(attempts, 3);
    assert.equal(x.app.store.records(x.run.id).filter((r) => r.kind === 'action').length, 2);
    assert(
      x.app.store
        .records(x.run.id)
        .some((r) => r.payload.method === 'keyboard_target_observation_refresh'),
    );
  } finally {
    await x.close();
  }
});

for (const engine of ['chromium', 'webkit'] as const) {
  test(`Actual ${engine} keeps a first Tab on the page body separate from a visited-control cycle`, async () => {
    const x = await setup(engine, '<button>A</button><button>Target</button>');
    try {
      await x.walk.page.evaluate(() => {
        let first = true;
        document.addEventListener('keydown', (event) => {
          if (event.key === 'Tab' && first) {
            first = false;
            event.preventDefault();
          }
        });
      });
      const result = await walkToKeyboardTarget(
        x.walk,
        x.app.store,
        x.run.id,
        x.current,
        seek,
        x.signal.signal,
        x.step,
      );
      assert.equal(result.outcome, 'reached', JSON.stringify(x.staleRefusals));
      assert.equal(result.actions.length, 3);
      assert.equal(result.actions[0]!.payload.before.tag, 'body');
      assert.equal(result.actions[0]!.payload.after.tag, 'body');
      assert.equal(result.actions[1]!.payload.after.name, 'A');
      assert.equal(result.actions[2]!.payload.after.name, 'Target');
      assert(
        result.actions.every(
          (row) => row.payload.outcome === 'performed' && row.payload.requestedAction.key === 'Tab',
        ),
      );
      assert.equal(x.app.store.usage().requests.length, 0);
    } finally {
      await x.close();
    }
  });
}

for (const engine of ['chromium', 'webkit'] as const) {
  for (const widget of [
    { group: 'menubar', item: 'menuitem', orientation: '', key: 'ArrowRight' },
    { group: 'menu', item: 'menuitem', orientation: '', key: 'ArrowDown' },
    { group: 'tablist', item: 'tab', orientation: 'vertical', key: 'ArrowDown' },
  ]) {
    test(`Actual ${engine} enters ${widget.group} then reaches its inactive item with real ${widget.key}`, async () => {
      const html =
        '<button>Before</button>' +
        `<div role="${widget.group}" ${widget.orientation ? 'aria-orientation="' + widget.orientation + '"' : ''}>` +
        `<button role="${widget.item}" tabindex="0" aria-selected="true">Alojamiento</button>` +
        `<button role="${widget.item}" id="flight-target" tabindex="-1" aria-selected="false" onclick="this.dataset.activated='yes'">Vuelos</button></div>` +
        '<button>After</button>' +
        `<script>const cells=[...document.querySelectorAll('[role="${widget.item}"]')];cells.forEach((cell,i)=>cell.addEventListener('keydown',event=>{if(event.key==='${widget.key}'){event.preventDefault(); const next=cells[(i+1)%cells.length];cell.tabIndex=-1;cell.setAttribute('aria-selected','false');next.tabIndex=0;next.setAttribute('aria-selected','true');next.focus();}}));</script>`;
      const x = await setup(engine, html);
      try {
        const result = await walkToKeyboardTarget(
          x.walk,
          x.app.store,
          x.run.id,
          x.current,
          {
            ...seek,
            targetRole: widget.item as 'menuitem' | 'tab',
            targetName: 'Vuelos',
            activation: 'Enter',
          },
          x.signal.signal,
          x.step,
        );
        assert.equal(result.outcome, 'activation_sent', JSON.stringify(x.staleRefusals));
        assert.deepEqual(
          result.actions.map((row) => row.payload.requestedAction.key),
          ['Tab', 'Tab', widget.key, 'Enter'],
        );
        assert.equal(
          await x.walk.page.locator('#flight-target').getAttribute('data-activated'),
          'yes',
        );
        assert.equal((await x.walk.focus()).name, 'Vuelos');
        assert(result.actions.every((row) => row.payload.outcome === 'performed'));
        for (const row of result.actions)
          assert(x.app.store.record(x.run.id, row.payload.sourceCaptureId));
        assert.equal(x.app.store.usage().requests.length, 0);
      } finally {
        await x.close();
      }
    });
  }
}

test('An explicit menu arrow refuses a target in another native group before input', async () => {
  const x = await setup(
    'chromium',
    '<div role="menubar"><button role="menuitem">Current</button></div><div role="menubar"><button role="menuitem">Vuelos</button></div>',
  );
  try {
    await x.walk.act({ kind: 'press', key: 'Tab', note: 'Enter first actual menubar' }, x.current);
    const source = await x.walk.captureSettled();
    const result = await walkToKeyboardTarget(
      x.walk,
      x.app.store,
      x.run.id,
      source,
      { ...seek, targetRole: 'menuitem', targetName: 'Vuelos', traversalKey: 'ArrowRight' },
      x.signal.signal,
      x.step,
    );
    assert.equal(result.outcome, 'unavailable');
    assert.equal(result.actions.length, 0);
    assert.equal((await x.walk.focus()).name, 'Current');
  } finally {
    await x.close();
  }
});

for (const engine of ['chromium', 'webkit'] as const) {
  test(`Actual ${engine} retains role-less focus help originals while traversing several controls in one intent`, async () => {
    const html =
      '<button id="currency" data-help="currency-help">Currency</button><button id="language" data-help="language-help">Language</button><button>Target</button>' +
      '<a href="#footer">Select your currency</a>' +
      '<div id="currency-help" hidden style="position:absolute;pointer-events:none">Select your currency</div>' +
      '<div id="language-help" hidden style="position:absolute;pointer-events:none">Select your language</div>' +
      '<script>document.querySelectorAll("button[data-help]").forEach(button=>{const help=document.getElementById(button.dataset.help);button.addEventListener("focus",()=>{button.setAttribute("aria-describedby",help.id);help.hidden=false;});button.addEventListener("blur",()=>{help.hidden=true;button.removeAttribute("aria-describedby");});});</script>';
    const x = await setup(engine, html);
    try {
      const result = await walkToKeyboardTarget(
        x.walk,
        x.app.store,
        x.run.id,
        x.current,
        seek,
        x.signal.signal,
        x.step,
      );
      assert.equal(result.outcome, 'reached', JSON.stringify(x.staleRefusals));
      assert.deepEqual(
        result.actions.map((row) => row.payload.requestedAction.key),
        ['Tab', 'Tab', 'Tab'],
      );
      const captures = x.app.store
        .records(x.run.id)
        .filter((row) => row.kind === 'capture' && row.seq >= x.current.seq);
      assert(
        captures.length >= 4,
        'The fixture original and every actual after-state must remain saved.',
      );
      assert(
        captures.some(
          (row) =>
            row.payload.focusHelp?.length === 1 &&
            row.payload.aria.includes('- text: Select your currency'),
        ),
      );
      assert(
        captures.some(
          (row) =>
            row.payload.focusHelp?.length === 1 &&
            row.payload.aria.includes('- text: Select your language'),
        ),
      );
      assert(captures.every((row) => row.payload.aria.includes('link "Select your currency"')));
      assert.equal(x.app.store.usage().requests.length, 0);
    } finally {
      await x.close();
    }
  });
}

test('Recorded focus help cannot hide an unrelated changed price during traversal', async () => {
  const x = await setup(
    'chromium',
    '<p id="price">EUR 48</p><button id="first">First</button><button>Target</button><div id="hint" hidden style="position:absolute;pointer-events:none">Help only</div><script>document.querySelector("#first").addEventListener("focus",event=>{event.target.setAttribute("aria-describedby","hint");document.querySelector("#hint").hidden=false;document.querySelector("#price").textContent="EUR 99";});</script>',
  );
  try {
    const result = await walkToKeyboardTarget(
      x.walk,
      x.app.store,
      x.run.id,
      x.current,
      { ...seek, activation: 'Enter' },
      x.signal.signal,
      x.step,
    );
    assert.equal(result.outcome, 'changed');
    assert.equal(result.actions.length, 1);
    assert.equal(result.current.payload.focusHelp.length, 1);
    assert(result.current.payload.aria.includes('EUR 99'));
    assert.equal((await x.walk.focus()).name, 'First');
    assert(!result.actions.some((row) => row.payload.requestedAction.key === 'Enter'));
  } finally {
    await x.close();
  }
});

const describedButtons =
  '<button id="first">First</button><button id="middle">Middle</button><button id="target" onclick="this.dataset.activated=\'yes\'">Target</button><div id="hint" hidden style="position:absolute;pointer-events:none">Fare EUR 48</div>';

test('A first-seen display-only description permits focus movement but cannot inherit activation', async () => {
  const x = await setup(
    'chromium',
    describedButtons +
      '<script>first.addEventListener("focus",()=>{first.setAttribute("aria-describedby","hint");hint.hidden=false;});first.addEventListener("blur",()=>{hint.hidden=true;first.removeAttribute("aria-describedby");});</script>',
  );
  try {
    const result = await walkToKeyboardTarget(
      x.walk,
      x.app.store,
      x.run.id,
      x.current,
      { ...seek, activation: 'Enter' },
      x.signal.signal,
      x.step,
    );
    assert.equal(result.outcome, 'changed');
    assert.equal(result.actions.length, 3);
    assert.equal((await x.walk.focus()).name, 'Target');
    assert(!result.actions.some((row) => row.payload.requestedAction.key === 'Enter'));
    assert.equal(await x.walk.page.locator('#target').getAttribute('data-activated'), null);
    await x.walk.act(
      {
        kind: 'press',
        key: 'Enter',
        note: 'A new independent decision from the reached current original',
      },
      await x.walk.captureSettled(),
    );
    assert.equal(await x.walk.page.locator('#target').getAttribute('data-activated'), 'yes');
  } finally {
    await x.close();
  }
});

test('A changed recorded price description stops before an unsent key can be refreshed', async () => {
  const x = await setup(
    'chromium',
    describedButtons +
      '<script>first.addEventListener("focus",()=>{first.setAttribute("aria-describedby","hint");hint.hidden=false;});</script>',
  );
  let calls = 0;
  try {
    const result = await walkToKeyboardTarget(
      x.walk,
      x.app.store,
      x.run.id,
      x.current,
      seek,
      x.signal.signal,
      async (before, action, guard) => {
        if (++calls === 2)
          await x.walk.page.locator('#hint').evaluate((node) => (node.textContent = 'Fare EUR 99'));
        return x.step(before, action, guard);
      },
    );
    assert.equal(result.outcome, 'changed');
    assert.equal(result.actions.length, 1);
    assert.equal((await x.walk.focus()).name, 'First');
    assert(result.current.payload.aria.includes('Fare EUR 99'));
    assert(
      x.app.store
        .records(x.run.id)
        .filter((row) => row.kind === 'capture')
        .some((row) => row.payload.aria.includes('Fare EUR 48')),
    );
    assert.equal(calls, 2, 'No refresh of the unsent key after changed description content');
  } finally {
    await x.close();
  }
});

test('Description history survives disappearance and refuses new content when the same ID returns', async () => {
  const x = await setup(
    'chromium',
    describedButtons +
      '<script>first.addEventListener("focus",()=>{first.setAttribute("aria-describedby","hint");hint.hidden=false;});first.addEventListener("blur",()=>{hint.hidden=true;first.removeAttribute("aria-describedby");});target.addEventListener("focus",()=>{target.setAttribute("aria-describedby","hint");hint.textContent="Fare EUR 99";hint.hidden=false;});</script>',
  );
  try {
    const result = await walkToKeyboardTarget(
      x.walk,
      x.app.store,
      x.run.id,
      x.current,
      { ...seek, activation: 'Enter' },
      x.signal.signal,
      x.step,
    );
    assert.equal(result.outcome, 'changed');
    assert.equal(result.actions.length, 3);
    assert.equal((await x.walk.focus()).name, 'Target');
    assert(result.current.payload.aria.includes('Fare EUR 99'));
    assert.equal(await x.walk.page.locator('#target').getAttribute('data-activated'), null);
    assert(
      x.app.store
        .records(x.run.id)
        .filter((row) => row.kind === 'capture')
        .some((row) => row.seq > x.current.seq && row.payload.focusHelp?.length === 0),
    );
  } finally {
    await x.close();
  }
});

test('An unbound plain role-tooltip cannot inherit activation after previously unseen information', async () => {
  const x = await setup(
    'chromium',
    '<button id="first">First</button><button id="target" onclick="this.dataset.activated=\'yes\'">Target</button><script>first.addEventListener("focus",()=>{const hint=document.createElement("div");hint.setAttribute("role","tooltip");hint.textContent="Fare EUR 99";document.body.append(hint);});</script>',
  );
  try {
    const result = await walkToKeyboardTarget(
      x.walk,
      x.app.store,
      x.run.id,
      x.current,
      { ...seek, activation: 'Enter' },
      x.signal.signal,
      x.step,
    );
    assert.equal(result.outcome, 'changed');
    assert.equal((await x.walk.focus()).name, 'Target');
    assert.equal(result.actions.length, 2);
    assert.equal(await x.walk.page.locator('#target').getAttribute('data-activated'), null);
  } finally {
    await x.close();
  }
});

test('Description history includes the normal control name when two owners have no DOM id', async () => {
  const html =
    '<button data-owner="a">Owner A</button><button data-owner="b">Owner B</button><button>Target</button><div id="hint" hidden style="position:absolute;pointer-events:none">Shared description</div><script>document.querySelectorAll("[data-owner]").forEach(button=>{button.addEventListener("focus",()=>{button.setAttribute("aria-describedby","hint");hint.hidden=false;});button.addEventListener("blur",()=>{hint.hidden=true;button.removeAttribute("aria-describedby");});});</script>';
  const x = await setup('chromium', html);
  try {
    const result = await walkToKeyboardTarget(
      x.walk,
      x.app.store,
      x.run.id,
      x.current,
      seek,
      x.signal.signal,
      x.step,
    );
    assert.equal(result.outcome, 'changed');
    assert.equal(result.actions.length, 2);
    assert.equal((await x.walk.focus()).name, 'Owner B');
    const captures = x.app.store
      .records(x.run.id)
      .filter((row) => row.kind === 'capture' && row.payload.focusHelp?.length === 1);
    assert(captures.some((row) => row.payload.focus.name === 'Owner A'));
    assert(captures.some((row) => row.payload.focus.name === 'Owner B'));
    assert(captures.every((row) => row.payload.focusHelp[0].focus.domId === ''));
  } finally {
    await x.close();
  }
});
