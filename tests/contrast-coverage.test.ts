import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { Store } from '../src/store.js';
import { collectBrowserFacts } from '../src/evidence-checks.js';

test('Real contrast coverage settles supported plain/nested text and preserves unresolved gradients', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'access-walk-contrast-coverage-'));
  const store = new Store(dir);
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const fixtures = [
      {
        name: 'plain',
        count: 4,
        html: '<h1>Heading</h1><p>First paragraph.</p><p>Second paragraph.</p><p>Final paragraph.</p>',
      },
      {
        name: 'nested',
        count: 5,
        html: '<h1>Heading</h1><p>First <span>nested span</span> in a paragraph.</p><p>Second <span>nested span</span> in a paragraph.</p>',
      },
      {
        name: 'bold',
        count: 5,
        html: '<h1>Heading</h1><p>One <strong>bold section</strong> and one <em>emphasized section</em> in a paragraph.</p><p>Another paragraph.</p>',
      },
      {
        name: 'aria-hidden',
        count: 3,
        html: '<h1>Heading</h1><p>Ordinary paragraph.</p><p aria-hidden="true">Rendered text hidden from the accessibility tree.</p>',
      },
      {
        name: 'gradient',
        count: 10,
        html: Array.from(
          { length: 10 },
          (_, n) =>
            `<p id="p${n}"${n >= 8 ? ' style="background:linear-gradient(white,#eeeeee)"' : ''}>Visible paragraph ${n}.</p>`,
        ).join(''),
      },
    ];
    for (const fixture of fixtures) {
      await page.setContent(
        `<!doctype html><html lang="en"><title>Controlled ${fixture.name}</title><style>body{background:#fff;color:#111;font:16px Arial;margin:24px}p{margin:12px 0}h1{font-size:24px}</style><body><main>${fixture.html}</main></body></html>`,
      );
      const run = store.create(
        `Controlled ${fixture.name} contrast fixture`,
        page.url(),
        'offline',
      );
      const image = store.asset(run.id, `capture_${fixture.name}.png`, await page.screenshot());
      const original = store.append(run.id, 'capture', 'browser', {
        stable: true,
        url: page.url(),
        imageFile: image.file,
        imageHash: image.hash,
        width: 1440,
        height: 900,
        elements: [],
        limits: { totalControls: 0 },
      });
      const visibleTextCount = await page.evaluate(
        () =>
          [...document.querySelectorAll('body *')].filter((element) =>
            [...element.childNodes].some(
              (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim(),
            ),
          ).length,
      );
      const axe = await new AxeBuilder({ page }).withRules(['color-contrast']).analyze();
      const facts = await collectBrowserFacts(page, original, axe);
      const measured = facts.contrast.filter((row) => row.state === 'measured');
      const incomplete = facts.contrast.filter((row) => row.state === 'incomplete');
      assert.equal(visibleTextCount, fixture.count, fixture.name);
      assert.equal(facts.contrast.length, visibleTextCount, fixture.name);
      assert.equal(facts.scope.contrastTruncated, false, fixture.name);
      if (fixture.name === 'gradient') {
        assert.equal(measured.length, 8);
        assert.equal(incomplete.length, 2);
        assert(incomplete.every((row) => row.ratio === null));
        assert.equal(facts.scope.contrastIncomplete, true);
      } else {
        assert.equal(measured.length, visibleTextCount, fixture.name);
        assert.equal(incomplete.length, 0, fixture.name);
        assert.equal(facts.scope.contrastIncomplete, false, fixture.name);
        if (fixture.name === 'aria-hidden')
          assert(measured.some((row) => row.selector.includes('aria-hidden')));
      }
      assert.equal(store.records(run.id).filter((record) => record.kind === 'action').length, 0);
      assert.equal(store.usage(run.id).requests.length, 0);
    }
  } finally {
    await browser.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
