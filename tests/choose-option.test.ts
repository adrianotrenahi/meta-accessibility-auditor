import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserWalk, InputRefused } from '../src/browser.js';
import { navigationActionSchema } from '../src/models.js';
import { startServer } from '../server/index.js';

// Owner, 31 Oct: "do the choose a date". Booking.com picks dates with day and month dropdowns.
// One decision now chooses an option by keyboard: on a Mac the arrow keys open a closed
// dropdown instead of stepping through it, so the robot presses the option's first character
// until the dropdown shows it ("2": 20, 21, 22), checking after every press.
const days = Array.from(
  { length: 31 },
  (_, i) =>
    `<option>${i + 1}, ${['Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday', 'Monday'][i % 7]}</option>`,
).join('');
const page =
  '<html lang="en"><head><title>Controlled dates</title></head><body>' +
  '<label>Month of departure <select id="month"><option disabled>-</option>' +
  '<option>November - 2026</option><option selected>December - 2026</option>' +
  '<option>January - 2027</option></select></label>' +
  `<label>Day and date of departure <select id="day" onchange="window.changes=(window.changes||0)+1"><option disabled>-</option>${days}</select></label>` +
  '<input aria-label="Search">' +
  '</body></html>';

for (const engine of ['chromium', 'webkit'] as const)
  test(`Actual ${engine}: one decision chooses a dropdown option by keyboard`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'choose-option-'));
    const app = await startServer(0, dir, false);
    const run = app.store.create('Choose a date', app.origin + '/shop/', 'offline');
    const walk = new BrowserWalk(app.store, run.id, app.origin, true, engine);
    const choose = async (option: string) => {
      const current = await walk.captureSettled();
      const action = navigationActionSchema.parse({ kind: 'choose_option', option, note: 'Date' });
      return walk.act(action, current);
    };
    const shown = (id: string) =>
      walk.page.evaluate(
        (selector) =>
          (document.getElementById(selector) as HTMLSelectElement).selectedOptions[0]!.text,
        id,
      );
    try {
      await walk.start(run.url);
      await walk.page.setContent(page);
      await walk.page.selectOption('#day', { index: 5 });
      await walk.page.focus('#day');
      for (const target of ['22, Tuesday', '3, Thursday', '11, Friday', '12, Saturday']) {
        const record = await choose(target);
        assert.equal(record.payload.outcome, 'performed', target);
        assert.equal(await shown('day'), target);
        assert(record.payload.action.presses >= 1, 'real key presses were sent');
      }
      assert(
        Number(await walk.page.evaluate(() => (window as any).changes)) >= 4,
        'the page heard each choice',
      );
      await walk.page.focus('#month');
      assert.equal((await choose('January - 2027')).payload.outcome, 'performed');
      assert.equal(await shown('month'), 'January - 2027');
      // An option the dropdown does not offer, or no dropdown focused, is refused: nothing pressed.
      await assert.rejects(choose('February - 2027'), InputRefused);
      await walk.page.focus('input');
      await assert.rejects(choose('12, Saturday'), InputRefused);
    } finally {
      await walk.close();
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

test('choose_option carries only the option text', () => {
  const ok = { kind: 'choose_option', option: '12, Saturday', note: 'Departure day' };
  assert(navigationActionSchema.safeParse(ok).success);
  assert(!navigationActionSchema.safeParse({ ...ok, option: undefined }).success);
  assert(!navigationActionSchema.safeParse({ ...ok, text: '12' }).success);
  assert(!navigationActionSchema.safeParse({ ...ok, targetId: 'e142' }).success);
  assert(
    !navigationActionSchema.safeParse({ kind: 'press', key: 'Tab', option: '12', note: 'x' })
      .success,
  );
});
