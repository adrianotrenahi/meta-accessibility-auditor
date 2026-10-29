import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startServer } from '../server/index.js';
import { BrowserWalk, ActionStateChanged } from '../src/browser.js';
import { walkToKeyboardTarget } from '../src/keyboard-target.js';
import {
  keyboardCycleMemory,
  KeyboardCycleMemory,
  MAX_CYCLE_MEMORIES,
} from '../src/keyboard-cycle-memory.js';
import { Runner } from '../src/runner.js';
import { VoiceOverProbe } from '../src/voiceover.js';
import type { Action } from '../src/models.js';
import type { RecordEntry } from '../src/types.js';
import type { Page, ElementHandle } from 'playwright';

test('Page closure during context revalidation cannot return an allowed traversal', async () => {
  let closed = false;
  const page = {
    isClosed: () => closed,
    once() {},
    evaluate: async () => {
      closed = true;
      return 1000;
    },
  } as unknown as Page;
  const memory = new KeyboardCycleMemory();
  try {
    assert.equal((await memory.check(page, {} as ElementHandle)).state, 'unknown');
  } finally {
    await memory.close();
  }
});

const seek: Action = {
  kind: 'focus_target',
  targetRole: 'button',
  targetName: 'Reject optional cookies',
  note: 'Reach the requested original control.',
};
const html = `<!doctype html><style>button,input{margin:8px}:focus{outline:2px solid blue}</style><h1>Controlled page</h1><p id="clock">Clock1</p><input id="query" aria-label="Public search"><button id="outside">Outside control</button><section role="dialog" aria-label="Cookie choices"><button id="reject" onclick="this.dataset.activated='yes'">Reject optional cookies</button></section><section id="offer" role="dialog" aria-label="Optional offer" aria-modal="true"><button id="close">Dismiss offer</button><button id="signin">Sign in</button></section><script>let trap=true;const closeButton=document.getElementById('close'),signButton=document.getElementById('signin');document.addEventListener('keydown',event=>{if(event.key==='Escape'){trap=false;document.getElementById('outside').focus();}else if(trap&&event.key==='Tab'){event.preventDefault();const items=[closeButton,signButton],index=items.indexOf(document.activeElement);items[(index+(event.shiftKey?-1:1)+items.length)%items.length].focus();}});closeButton.onclick=()=>{trap=false;document.getElementById('offer').remove();};closeButton.focus();</script>`;

async function fixture(engine: 'chromium' | 'webkit' = 'chromium') {
  const dir = mkdtempSync(join(tmpdir(), 'keyboard-cycle-'));
  const app = await startServer(0, dir, false);
  const run = app.store.create(
    'Synthetic cycle memory; no models.',
    app.origin + '/shop/',
    'offline',
  );
  const walk = new BrowserWalk(app.store, run.id, app.origin, true, engine);
  await walk.start(run.url);
  await walk.page.setContent(html);
  await walk.page.evaluate(() => document.fonts.ready);
  let current = await walk.captureSettled();
  const controller = new AbortController();
  const step = async (before: RecordEntry, action: Action, guard?: () => Promise<boolean>) => {
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
    controller,
    get current() {
      return current;
    },
    async fresh() {
      current = await walk.captureSettled();
    },
    async macro(decision = seek) {
      const result = await walkToKeyboardTarget(
        walk,
        app.store,
        run.id,
        current,
        decision,
        controller.signal,
        step,
      );
      current = result.current;
      return result;
    },
    async press(key: NonNullable<Action['key']>) {
      const result = await step(current, {
        kind: 'press',
        key,
        note: 'An explicit independent synthetic input.',
      });
      current = result.current;
      assert(result.performed, 'The explicit input must be recorded.');
    },
    pictures() {
      return app.store.records(run.id).filter((record) => record.kind === 'capture').length;
    },
    async close() {
      await walk.close();
      await keyboardCycleMemory(walk).close();
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

for (const engine of ['chromium', 'webkit'] as const)
  test(`${engine}: another decision/capture/direction cannot repeat an unchanged actual focus cycle`, async () => {
    const x = await fixture(engine);
    try {
      const first = await x.macro();
      assert.equal(first.outcome, 'cycle');
      assert.equal(first.actions.length, 2);
      const originalCycle = x.app.store
        .records(x.run.id)
        .filter((record) => record.kind === 'limit')
        .at(-1)!;
      assert.deepEqual(
        originalCycle.payload.cycleEvidence.participants.map((member: any) => member.name),
        ['Dismiss offer', 'Sign in'],
      );
      assert.deepEqual(originalCycle.payload.cycleEvidence.context, {
        kind: 'observed-dialog',
        targetOutside: true,
      });
      await x.walk.page.locator('#clock').evaluate((element) => {
        element.textContent = 'Clock2';
      });
      await x.fresh();
      const before = x.pictures(),
        actions = x.walk.actions;
      const repeated = await x.macro({
        ...seek,
        note: 'Different wording',
        traversalKey: 'Shift+Tab',
      });
      assert.equal(repeated.outcome, 'cycle');
      assert.equal(repeated.actions.length, 0);
      assert.equal(x.pictures(), before);
      assert.equal(x.walk.actions, actions);
      const refusal = x.app.store
        .records(x.run.id)
        .filter((record) => record.kind === 'limit')
        .at(-1)!;
      assert.equal(refusal.payload.previousCycleId, originalCycle.id);
      assert(refusal.sources.includes(originalCycle.id));
      assert.equal(await x.walk.page.locator('#offer').count(), 1);
      await x.press('Enter'); // Only this separate explicit action dismisses the offer.
      assert.equal(await x.walk.page.locator('#offer').count(), 0);
      const reached = await x.macro({ ...seek, activation: 'Enter' });
      assert.equal(reached.outcome, 'activation_sent');
      assert.equal(await x.walk.page.locator('#reject').getAttribute('data-activated'), 'yes');
      assert.equal(x.app.store.usage(x.run.id).requests.length, 0);
    } finally {
      await x.close();
    }
  });

test('An explicit key moving focus outside the remembered cycle permits a fresh bounded path', async () => {
  const x = await fixture();
  try {
    await x.macro();
    await x.press('Escape');
    assert.equal(await x.walk.page.locator('#offer').count(), 1);
    assert.equal((await x.walk.focus()).name, 'Outside control');
    const next = await x.macro({ ...seek, activation: 'Enter' });
    assert.equal(next.outcome, 'activation_sent');
    assert.equal(next.actions.length, 2);
  } finally {
    await x.close();
  }
});

test('The actual Runner callback cites lightweight focus evidence without calling it a screenshot', async () => {
  const x = await fixture();
  try {
    await x.walk.page.locator('#outside').focus();
    await x.fresh();
    await x.walk.page.locator('#close').focus();
    await x.fresh();
    const runner = new Runner(x.app.store, x.app.origin);
    const result = await walkToKeyboardTarget(
      x.walk,
      x.app.store,
      x.run.id,
      x.current,
      seek,
      x.controller.signal,
      (before, action, guard) =>
        (runner as any).targetKeyboardStep(x.run, x.walk, before, action, guard),
    );
    assert.equal(result.outcome, 'cycle');
    assert.equal(result.current.kind, 'observation');
    const cycle = x.app.store
      .records(x.run.id)
      .filter((record) => record.kind === 'limit')
      .at(-1)!;
    assert.equal(cycle.payload.cycleEvidence.sourceId, result.current.id);
    assert.equal(cycle.payload.cycleEvidence.sourceKind, 'observation');
    assert(cycle.sources.includes(result.current.id));
    const original = x.app.store.record(x.run.id, result.current.payload.sourceCaptureId)!;
    assert.equal(original.kind, 'capture');
    assert.notEqual(original.id, result.current.id);
  } finally {
    await x.close();
  }
});

test('An unavailable retained-node read refuses without input and does not erase the previous cycle', async (t) => {
  const x = await fixture();
  try {
    await x.macro();
    const memory = keyboardCycleMemory(x.walk) as any;
    const read = t.mock.method(memory.entries[0].target.handle, 'evaluate', async () => {
      throw Error('Controlled unavailable node read');
    });
    const actions = x.walk.actions,
      pictures = x.pictures();
    const unknown = await x.macro();
    assert.equal(unknown.outcome, 'unavailable');
    assert.equal(x.walk.actions, actions);
    assert.equal(x.pictures(), pictures);
    read.mock.restore();
    const unchanged = await x.macro();
    assert.equal(unchanged.outcome, 'cycle');
    assert.equal(unchanged.actions.length, 0);
  } finally {
    await x.close();
  }
});

test('The same target node can be retried after an observed focusability change', async () => {
  const x = await fixture();
  try {
    await x.macro();
    await x.walk.page
      .locator('#reject')
      .evaluate((element) => element.setAttribute('tabindex', '1'));
    await x.fresh();
    const retry = await x.macro();
    assert.equal(retry.outcome, 'cycle');
    assert.equal(retry.actions.length, 2);
  } finally {
    await x.close();
  }
});

test('Cycle names omit actual typed values and link queries', async () => {
  const x = await fixture();
  try {
    await x.walk.page.locator('#query').focus();
    await x.fresh();
    const typed = await x.walk.act(
      { kind: 'type', text: 'Demo', note: 'Approved synthetic text.' },
      x.current,
    );
    assert.equal(typed.payload.outcome, 'performed');
    await x.walk.page
      .locator('#close')
      .evaluate((element) =>
        element.setAttribute(
          'aria-label',
          'Dismiss Demo https://example.invalid/?state=PRIVATE_QUERY',
        ),
      );
    await x.walk.page.locator('#close').focus();
    await x.fresh();
    await x.macro();
    const evidence = JSON.stringify(
      x.app.store
        .records(x.run.id)
        .filter((record) => record.kind === 'limit')
        .at(-1)!.payload.cycleEvidence,
    );
    for (const value of ['Demo', 'https://', 'PRIVATE_QUERY'])
      assert(!evidence.includes(value), value);
    assert(evidence.includes('[redacted input]'));
    assert(evidence.includes('[link]'));
  } finally {
    await x.close();
  }
});

test('Runner Stop closes cycle memory and retained node handles', async () => {
  const x = await fixture();
  try {
    await x.macro();
    const memory = keyboardCycleMemory(x.walk) as any;
    const retained = [...memory.entries[0].owned];
    const runner = new Runner(x.app.store, x.app.origin);
    runner.active = {
      run: x.run,
      walk: x.walk,
      probe: new VoiceOverProbe(x.walk),
      controller: x.controller,
    };
    runner.completion = Promise.resolve();
    await runner.stop(x.run.id);
    assert.equal(memory.isClosed, true);
    assert.equal(memory.entries.length, 0);
    for (const handle of retained as any[]) await assert.rejects(handle.evaluate(() => true));
    assert.equal(x.app.store.run(x.run.id).state, 'stopped');
  } finally {
    await x.close();
  }
});

test('Memory drains pending reads before close completes and cannot reopen', async (t) => {
  const x = await fixture();
  try {
    await x.macro();
    const memory = keyboardCycleMemory(x.walk) as any;
    const original = memory.entries[0],
      target = await x.walk.page.locator('#reject').elementHandle();
    assert(target);
    const call = original.target.handle.evaluate.bind(original.target.handle);
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => {
        enter = resolve;
      }),
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    const delayed = t.mock.method(original.target.handle, 'evaluate', async (...args: any[]) => {
      enter();
      await gate;
      return call(...args);
    });
    const pending = memory.check(x.walk.page, target);
    await entered;
    let completed = false;
    const closing = memory.close().then(() => {
      completed = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(completed, false);
    assert.equal((await memory.check(x.walk.page, target)).state, 'unknown');
    delayed.mock.restore();
    release();
    await pending;
    await closing;
    assert.equal(memory.entries.length, 0);
    assert.equal(memory.isClosed, true);
    await target.dispose();
  } finally {
    await x.close();
  }
});

test('Retained handle capacity refuses overflow and releases every owned reference', async () => {
  const x = await fixture(),
    memory = new KeyboardCycleMemory() as any;
  try {
    const first = await x.macro();
    const target = await x.walk.page.locator('#reject').elementHandle();
    assert(target);
    const close = await x.walk.page.locator('#close').elementHandle(),
      sign = await x.walk.page.locator('#signin').elementHandle();
    assert(close && sign);
    const input = {
      page: x.walk.page,
      target,
      participants: [
        { handle: close, role: 'button', name: 'Dismiss offer' },
        { handle: sign, role: 'button', name: 'Sign in' },
      ],
      sourceId: x.current.id,
      sourceKind: 'capture' as const,
      actionIds: first.actions.map((action) => action.id),
      redact: (value: string) => value,
    };
    // Mechanical capacity only: these are not additional audit actions or claims.
    for (let i = 0; i < MAX_CYCLE_MEMORIES; i++) assert(await memory.remember(input));
    const retained = memory.entries.flatMap((entry: any) => [...entry.owned]);
    assert.equal(await memory.remember(input), undefined);
    assert.equal(memory.entries.length, MAX_CYCLE_MEMORIES);
    assert.equal((await memory.check(x.walk.page, target)).state, 'unknown');
    await memory.close();
    assert.equal(memory.entries.length, 0);
    for (const handle of retained) await assert.rejects(handle.evaluate(() => true));
    await Promise.all([target.dispose(), close.dispose(), sign.dispose()]);
  } finally {
    await memory.close();
    await x.close();
  }
});
