import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserWalk, MAX_LISTED_CONTROLS } from '../src/browser.js';
import { startServer } from '../server/index.js';

// Owner, 31 Oct: up to 500 controls per screenshot, read in one pass. A control that vanishes
// while the list is being read (a suggestion list closing, a carousel moving) must be left
// out, never fail the screenshot or pair one control's position with another's name.
for (const engine of ['chromium', 'webkit'] as const)
  test(`Actual ${engine}: a control removed mid-read is left out and the screenshot still completes`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'listed-controls-'));
    const app = await startServer(0, dir, false);
    const run = app.store.create('Vanishing controls', app.origin + '/shop/', 'offline');
    const walk = new BrowserWalk(app.store, run.id, app.origin, true, engine);
    try {
      await walk.start(run.url);
      const buttons = Array.from(
        { length: 30 },
        (_, i) => `<button id="b${i}">Button ${i}</button>`,
      ).join('');
      await walk.page.setContent(
        `<html lang="en"><head><title>Vanishing controls</title></head><body>${buttons}` +
          // The moment the robot finishes listing the controls, the page drops two of them:
          // one in the middle (every later position shifts) and the last one.
          `<script>const set = Map.prototype.set; let done = false;
          Map.prototype.set = function (key, value) {
            const result = set.call(this, key, value);
            if (!done && value instanceof Map && [...value.keys()].some((k) => /^e\\d+$/.test(k))) {
              done = true;
              document.getElementById('b10').remove();
              document.getElementById('b29').remove();
            }
            return result;
          };</script></body></html>`,
      );
      const started = Date.now();
      const capture = await walk.capture();
      assert(Date.now() - started < 5000, 'no control waits for the page default timeout');
      const elements = capture.payload.elements as { id: string; name: string }[];
      assert(elements.length > 0);
      for (const element of elements) {
        // Each listed control keeps its own name: no position borrowed from a neighbour.
        assert.equal(element.name, `Button ${element.id.slice(1)}`, element.id);
        assert(!['Button 10', 'Button 29'].includes(element.name));
      }
      assert.equal(capture.payload.limits.maximumListedControls, MAX_LISTED_CONTROLS);
    } finally {
      await walk.close();
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
