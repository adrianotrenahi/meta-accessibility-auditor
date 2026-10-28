import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startServer } from '../server/index.js';
import { BrowserWalk, ActionStateChanged } from '../src/browser.js';
import { recordIsIntact } from '../src/store.js';
import {
  readRecordedFocusHelp,
  recordedFocusHelpRows,
  stripRecordedFocusHelp,
  type RecordedFocusHelp,
} from '../src/focus-help.js';

const help = (text = 'Select your currency'): RecordedFocusHelp => ({
  version: 'recorded-focus-help/1',
  focus: { tag: 'button', domId: 'currency', role: '', describedBy: ['help'] },
  descriptionId: 'help',
  text,
  ariaLine: '- text: ' + text,
  position: 'absolute',
  pointerEvents: 'none',
  verified: {
    uniqueId: true,
    currentFocus: true,
    visible: true,
    noninteractive: true,
    plainText: true,
  },
});

test('Only one complete source-bound plain text leaf is omitted from the local comparison', () => {
  const original =
    '- button "Currency" [expanded]\n- link "Select your currency"\n- text: Fare EUR 48\n- text: Select your currency';
  assert.equal(
    stripRecordedFocusHelp(original, [help()]),
    '- button "Currency" [expanded]\n- link "Select your currency"\n- text: Fare EUR 48',
  );
  for (const metadata of [
    undefined,
    [],
    [{ ...help(), version: 'invented' }],
    [{ ...help(), descriptionId: 'foreign' }],
    [{ ...help(), verified: { ...help().verified, visible: false } }],
    [{ ...help(), pointerEvents: 'auto' }],
    [{ ...help(), text: 'Another text' }],
    [{ ...help(), focus: { ...help().focus, describedBy: ['help', 'help'] } }],
    [help(), help()],
  ])
    assert.equal(stripRecordedFocusHelp(original, metadata), original);
  for (const aria of [
    original + '\n- text: Select your currency',
    '- link "Select your currency"',
    '- link "Support":\n  - text: Select your currency',
    '- text: Select your currency\n  - button "Pay"',
    '- text: Select your currency\n\n  - button "Pay"',
    '- text: Select your currency is EUR 48',
    '- generic:\n  - text: Select your currency',
  ])
    assert.equal(stripRecordedFocusHelp(aria, [help()]), aria);
  const second = {
    ...help(),
    descriptionId: 'other',
    focus: { ...help().focus, describedBy: ['help', 'other'] },
  };
  assert.equal(
    stripRecordedFocusHelp(original, [{ ...help(), focus: second.focus }, second]),
    original,
    'Two descriptions cannot claim the same single text leaf.',
  );
  assert.equal(
    stripRecordedFocusHelp('- text: "Hint: use Tab"', [
      { ...help('Hint: use Tab'), ariaLine: '- text: "Hint: use Tab"' },
    ]),
    '',
  );
});

test('An empty relationship takes one DOM read and never asks for a description snapshot', async () => {
  let reads = 0;
  assert.deepEqual(
    await readRecordedFocusHelp({
      evaluate: async () => {
        reads++;
        return [];
      },
      locator: () => {
        throw Error('No snapshot is needed without a current description.');
      },
    } as any),
    [],
  );
  assert.equal(reads, 1);
});

test('Structurally valid description rows preserve prices and require a separate meaning guard', () => {
  const before = [help('Fare EUR 48')];
  const after = [help('Fare EUR 99')];
  const original = JSON.stringify(before);
  assert.deepEqual(recordedFocusHelpRows(before), before);
  assert.deepEqual(recordedFocusHelpRows(after), after);
  assert.notDeepEqual(recordedFocusHelpRows(before), recordedFocusHelpRows(after));
  assert.equal(recordedFocusHelpRows(before)[0]!.text, 'Fare EUR 48');
  assert.equal(recordedFocusHelpRows(after)[0]!.text, 'Fare EUR 99');
  // The rendering projection removes either line. The retained rows expose the
  // material change that the controller must check before further keys/activation.
  assert.equal(
    stripRecordedFocusHelp('- button "Currency"\n- text: Fare EUR 48', before),
    stripRecordedFocusHelp('- button "Currency"\n- text: Fare EUR 99', after),
  );
  assert.equal(JSON.stringify(before), original);
  const sharedFocus = { ...before[0]!.focus, describedBy: ['help', 'second'] };
  const pair = [
    { ...before[0]!, focus: sharedFocus },
    { ...after[0]!, descriptionId: 'second', focus: sharedFocus },
  ];
  assert.deepEqual(recordedFocusHelpRows(pair), pair);
  assert.deepEqual(
    recordedFocusHelpRows([pair[0], { ...pair[1]!, focus: { ...sharedFocus, domId: 'another' } }]),
    [],
  );
  for (const value of [
    undefined,
    [],
    [...before, ...before],
    [...before, { ...before[0], focus: { ...before[0]!.focus, domId: 'another' } }],
    [{ ...before[0], descriptionId: 'foreign' }],
    [{ ...before[0], version: 'older' }],
  ])
    assert.deepEqual(recordedFocusHelpRows(value), []);
});

const fixture = `<!doctype html><html><head><title>Controlled focus descriptions</title></head><body>
<button id="currency" onfocus="this.setAttribute('aria-describedby','currency-help');document.getElementById('currency-help').hidden=false" onblur="document.getElementById('currency-help').hidden=true">Currency</button>
<button id="language" onfocus="this.setAttribute('aria-describedby','language-help');document.getElementById('language-help').hidden=false" onblur="document.getElementById('language-help').hidden=true">Language</button>
<button id="finish">Finish</button><a href="#ordinary">Select your currency</a><p>Fare EUR 48</p>
<div id="currency-help" hidden style="position:absolute;top:60px;pointer-events:none"><div style="pointer-events:all">Select your currency</div><span hidden aria-hidden="true"></span></div>
<div id="language-help" hidden style="position:fixed;top:90px;pointer-events:none">Select your language</div>
</body></html>`;

for (const engine of ['chromium', 'webkit'] as const) {
  test(`Actual ${engine} captures complete originals and only visible current-focus description metadata`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'recorded-focus-help-'));
    const app = await startServer(0, directory, false);
    const run = app.store.create('Controlled focus descriptions', app.origin + '/shop/', 'offline');
    const walk = new BrowserWalk(app.store, run.id, app.origin, true, engine);
    const tab = engine === 'webkit' ? 'Alt+Tab' : 'Tab';
    try {
      await walk.start(run.url);
      await walk.page.setContent(fixture);
      assert.deepEqual(await readRecordedFocusHelp(walk.page), []);
      await walk.page.keyboard.press(tab);
      assert.equal((await walk.focus()).name, 'Currency');
      const beforeHtml = await walk.page.locator('body').evaluate((node) => node.outerHTML);
      const first = await walk.captureSettled();
      assert.equal(first.payload.stable, true);
      assert.equal(first.payload.focusHelp.length, 1);
      assert.equal(first.payload.focusHelp[0].descriptionId, 'currency-help');
      assert.equal(first.payload.focusHelp[0].ariaLine, '- text: Select your currency');
      assert(first.payload.aria.includes('- text: Select your currency'));
      assert(first.payload.aria.includes('- link "Select your currency"'));
      assert(first.payload.text.includes('Select your currency'));
      assert(recordIsIntact(first));
      const reduced = stripRecordedFocusHelp(first.payload.aria, first.payload.focusHelp);
      assert(!reduced.includes('- text: Select your currency'));
      assert(reduced.includes('- link "Select your currency"'));
      assert(reduced.includes('Fare EUR 48'));
      assert.equal(await walk.page.locator('body').evaluate((node) => node.outerHTML), beforeHtml);
      const observed = await (walk as any).observedState();
      assert.deepEqual(observed.focusHelp, first.payload.focusHelp);
      assert(
        !Object.hasOwn(observed.focus, 'focusHelp'),
        'The normal focus contract stays unchanged.',
      );
      assert.equal(await walk.observationStamp(), first.payload.stateStamp);

      await walk.page.locator('#currency-help').evaluate((node) => {
        (node as HTMLElement).style.pointerEvents = 'auto';
      });
      assert.equal(await walk.page.locator('body').ariaSnapshot(), first.payload.aria);
      assert.notEqual(
        await walk.observationStamp(),
        first.payload.stateStamp,
        'Changed help qualification affects freshness even when raw ARIA stays identical.',
      );
      await assert.rejects(walk.verifyOriginalCapture(first), ActionStateChanged);
      await walk.page.locator('#currency-help').evaluate((node) => {
        (node as HTMLElement).style.pointerEvents = 'none';
      });
      assert.equal(await walk.observationStamp(), first.payload.stateStamp);

      await walk.page.keyboard.press(tab);
      const second = await walk.captureSettled();
      assert.equal(second.payload.focus.name, 'Language');
      assert.equal(second.payload.focusHelp.length, 1);
      assert.equal(second.payload.focusHelp[0].descriptionId, 'language-help');
      assert.notEqual(second.payload.stateStamp, first.payload.stateStamp);
      await assert.rejects(walk.verifyOriginalCapture(first), ActionStateChanged);
      assert(recordIsIntact(first), 'A changed focus never rewrites the earlier original.');
      await walk.page.keyboard.press(tab);
      const neutral = await walk.captureSettled();
      assert.equal(neutral.payload.focus.name, 'Finish');
      assert.deepEqual(neutral.payload.focusHelp, []);
      assert(
        await walk.page.locator('#language-help').count(),
        'Hidden helper retention is allowed.',
      );

      const base = (body: string, attributes = '') =>
        `<button id="control" aria-describedby="hint" ${attributes}>Control</button>${body}`;
      const positioned = 'style="position:absolute;pointer-events:none;top:50px"';
      const refuse = [
        ['hidden retention', base(`<div id="hint" hidden ${positioned}>Hint</div>`)],
        [
          'zero opacity',
          base('<div id="hint" style="position:absolute;pointer-events:none;opacity:0">Hint</div>'),
        ],
        [
          'outside the viewport',
          base(
            '<div id="hint" style="position:absolute;pointer-events:none;left:-10000px">Hint</div>',
          ),
        ],
        ['hidden attribute', base(`<div id="hint" aria-hidden="true" ${positioned}>Hint</div>`)],
        [
          'hidden descendant content',
          base(`<div id="hint" ${positioned}>Hint<span hidden>Actual fact</span></div>`),
        ],
        ['inert', base(`<section inert><div id="hint" ${positioned}>Hint</div></section>`)],
        [
          'hidden ancestor',
          base(
            `<section style="visibility:hidden"><div id="hint" ${positioned}>Hint</div></section>`,
          ),
        ],
        [
          'ambiguous ID',
          base(`<div id="hint" ${positioned}>Hint</div><div id="hint" ${positioned}>Hint</div>`),
        ],
        ['static description', base('<div id="hint" style="pointer-events:none">Hint</div>')],
        [
          'pointer accepts input',
          base('<div id="hint" style="position:absolute;pointer-events:auto">Hint</div>'),
        ],
        [
          'interactive descendant',
          base(`<div id="hint" ${positioned}>Hint<button>Pay</button></div>`),
        ],
        [
          'interactive link ancestor',
          base(`<a href="#support"><div id="hint" ${positioned}>Hint</div></a>`),
        ],
        [
          'programmatic focus ancestor',
          base(`<section tabindex="-1"><div id="hint" ${positioned}>Hint</div></section>`),
        ],
        [
          'programmatic focus descendant',
          base(`<div id="hint" ${positioned}>Hint<span tabindex="-1">More</span></div>`),
        ],
        ['form descendant', base(`<div id="hint" ${positioned}><form>Hint</form></div>`)],
        [
          'editable descendant',
          base(`<div id="hint" ${positioned}><span contenteditable>Hint</span></div>`),
        ],
        [
          'inherited editability',
          base(`<section contenteditable><div id="hint" ${positioned}>Hint</div></section>`),
        ],
        [
          'inline interaction',
          base(`<div id="hint" ${positioned}><span onclick="void 0">Hint</span></div>`),
        ],
        ['live message', base(`<div id="hint" aria-live="polite" ${positioned}>Hint</div>`)],
        ['invalid control', base(`<div id="hint" ${positioned}>Hint</div>`, 'aria-invalid="true"')],
        [
          'error relationship',
          base(`<div id="hint" ${positioned}>Hint</div>`, 'aria-errormessage="hint"'),
        ],
        ['owned panel', base(`<div id="hint" ${positioned}>Hint</div>`, 'aria-controls="hint"')],
        [
          'several semantic leaves',
          base(`<div id="hint" ${positioned}><p>First</p><p>Second</p></div>`),
        ],
        [
          'repeated reference',
          base(`<div id="hint" ${positioned}>Hint</div>`).replace(
            'aria-describedby="hint"',
            'aria-describedby="hint hint"',
          ),
        ],
        [
          'unbounded references',
          base(`<div id="hint" ${positioned}>Hint</div>`).replace(
            'aria-describedby="hint"',
            'aria-describedby="hint h2 h3 h4 h5"',
          ),
        ],
      ];
      for (const [reason, html] of refuse) {
        await walk.page.setContent(html!);
        await walk.page.locator('#control').focus();
        assert.deepEqual(await readRecordedFocusHelp(walk.page), [], reason);
      }
      assert.equal(app.store.usage().requests.length, 0);
    } finally {
      await walk.close();
      await app.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
