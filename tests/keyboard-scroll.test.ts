import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserWalk, InputRefused, keyboardScrollChangesValue } from '../src/browser.js';
import { navigationActionSchema } from '../src/models.js';
import { startServer } from '../server/index.js';

// Owner, 1 Nov: "scroll with arrows?" A keyboard user reads more of a page with Page Down and
// Page Up, so scroll presses those keys instead of turning a mouse wheel. Inside a field, a
// dropdown or a list the same keys change the value, so the robot refuses there.
const page =
  '<html lang="en"><head><title>Controlled long page</title></head><body>' +
  '<a href="#top">Top link</a>' +
  '<div style="height:4000px">Long content</div>' +
  '<label>Size <select id="size"><option>S</option><option selected>M</option><option>L</option><option>XL</option></select></label>' +
  '<input aria-label="Search">' +
  '</body></html>';

for (const engine of ['chromium', 'webkit'] as const)
  test(`Actual ${engine}: scroll presses Page Down and refuses inside a dropdown`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'keyboard-scroll-'));
    const app = await startServer(0, dir, false);
    const run = app.store.create('Keyboard scroll', app.origin + '/shop/', 'offline');
    const walk = new BrowserWalk(app.store, run.id, app.origin, true, engine);
    const scroll = async (direction: 'up' | 'down') =>
      walk.act(
        navigationActionSchema.parse({ kind: 'scroll', direction, note: 'Read more' }),
        await walk.captureSettled(),
      );
    try {
      await walk.start(run.url);
      await walk.page.setContent(page);
      await walk.page.focus('a');
      const down = await scroll('down');
      assert.equal(down.payload.action.key, 'PageDown');
      assert.equal(down.payload.requestedAction.key, undefined, 'the navigator asked for scroll');
      assert(Number(await walk.page.evaluate(() => window.scrollY)) > 0, 'the page moved');
      assert.equal((await scroll('up')).payload.action.key, 'PageUp');
      await walk.page.focus('#size');
      await assert.rejects(scroll('down'), InputRefused);
      assert.equal(
        await walk.page.evaluate(
          () => (document.getElementById('size') as HTMLSelectElement).selectedOptions[0]!.text,
        ),
        'M',
        'the dropdown kept its value',
      );
    } finally {
      await walk.close();
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

test('Page Down is refused only where it would change a value', () => {
  const refused = (tag: string, type = '', role = '') =>
    keyboardScrollChangesValue({ tag, type, role });
  for (const [tag, type, role] of [
    ['select', '', ''],
    ['textarea', '', ''],
    ['input', '', ''],
    ['input', 'search', ''],
    ['input', 'radio', ''],
    ['div', '', 'listbox'],
    ['div', '', 'combobox'],
    ['div', '', 'slider'],
    ['td', '', 'gridcell'],
    ['div', '', 'menu'],
  ])
    assert.equal(refused(tag!, type, role), true, `${tag} ${type} ${role}`);
  for (const [tag, type, role] of [
    ['a', '', ''],
    ['button', '', ''],
    ['body', '', ''],
    ['input', 'checkbox', ''],
    ['input', 'submit', ''],
    ['div', '', 'dialog'],
    ['', '', ''],
  ])
    assert.equal(refused(tag!, type, role), false, `${tag} ${type} ${role}`);
  // The navigator itself never sends these keys with press; scroll is how it asks.
  assert(!navigationActionSchema.safeParse({ kind: 'press', key: 'PageDown', note: 'x' }).success);
});
