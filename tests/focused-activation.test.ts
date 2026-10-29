import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server/index.js';
import { BrowserWalk } from '../src/browser.js';
import { FocusedCheckBudget } from '../src/evidence-checks.js';
import { performFocusedCheck } from '../src/focused-checks.js';

test(
  'Actual local follow-ups dismiss the focused offer without moving to Accept and retain commitment/target guards',
  { timeout: 90000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'focused-activation-'));
    const app = await startServer(0, dir, false);
    const run = app.store.create(
      'Synthetic focused activation proof',
      app.origin + '/shop/',
      'offline',
    );
    const walk = new BrowserWalk(app.store, run.id, app.origin, true, 'chromium');
    const controller = new AbortController();
    const perform = (current: any, targetName: string) =>
      performFocusedCheck(
        app.store,
        run.id,
        walk,
        undefined,
        new FocusedCheckBudget(),
        current,
        {
          method: 'keyboard_activation',
          captureId: current.id,
          criterionId: 'C05',
          reason: 'Observe the explicitly requested key on the already focused synthetic control.',
          targetName,
          activationKey: 'Enter',
        },
        controller.signal,
      );
    const actions = () => app.store.records(run.id).filter((record) => record.kind === 'action');
    try {
      await walk.start(run.url);
      await walk.page.setContent(`<!doctype html><title>Controlled offer</title>
      <div role="dialog" aria-label="Offer" id="offer">
        <button id="dismiss" onclick="document.querySelector('#offer').hidden=true">Dismiss offer</button>
        <button id="accept" onclick="document.querySelector('#accepted').textContent='Accepted'">Accept offer</button>
      </div><p id="accepted">No acceptance</p>`);
      await walk.page.locator('#dismiss').focus();
      const original = await walk.captureSettled();
      const countBefore = actions().length;
      const after = await perform(original, 'Dismiss offer');
      assert.equal(await walk.page.locator('#offer').isVisible(), false);
      assert.equal(await walk.page.locator('#accepted').textContent(), 'No acceptance');
      assert.notEqual((await walk.focus()).name, 'Accept offer');
      const actual = actions().slice(countBefore);
      assert.deepEqual(
        actual.map((record) => record.payload.action.key),
        ['Enter'],
      );
      assert.equal(actual[0]!.payload.before.name, 'Dismiss offer');
      assert.equal(app.store.records(run.id).at(-1)?.payload.afterCaptureId, after.id);

      await walk.page.setContent(`<!doctype html><title>Controlled commitment</title>
      <button id="commit" onclick="document.querySelector('#status').textContent='Committed'">Confirm booking</button>
      <p id="status">No commitment</p>`);
      await walk.page.locator('#commit').focus();
      const commitment = await walk.captureSettled();
      const beforeCommitment = actions().length;
      await perform(commitment, 'Confirm booking');
      assert.equal(actions().length, beforeCommitment);
      assert.equal(await walk.page.locator('#status').textContent(), 'No commitment');
      assert.equal(app.store.records(run.id).at(-1)?.payload.state, 'INCONCLUSIVE');

      await walk.page.setContent(`<!doctype html><title>Controlled replacement</title>
      <button id="replace" onclick="document.querySelector('#status').textContent='Activated'">Dismiss replacement</button>
      <p id="status">No activation</p>`);
      await walk.page.locator('#replace').focus();
      const replaced = await walk.captureSettled();
      const beforeReplacement = actions().length;
      const verify = walk.verifyOriginalCapture.bind(walk);
      walk.verifyOriginalCapture = async (source) => {
        await verify(source);
        await walk.page.locator('#replace').evaluate((element) => {
          const replacement = element.cloneNode(true) as HTMLElement;
          element.replaceWith(replacement);
          replacement.focus();
        });
      };
      await perform(replaced, 'Dismiss replacement');
      assert.equal(actions().length, beforeReplacement);
      assert.equal(await walk.page.locator('#status').textContent(), 'No activation');
      assert.equal(app.store.records(run.id).at(-1)?.payload.state, 'INCONCLUSIVE');
      assert.equal(
        app.store.records(run.id).filter((record) => record.kind === 'model_response').length,
        0,
      );
      assert.deepEqual(app.store.published(run.id), []);
    } finally {
      await walk.close();
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
