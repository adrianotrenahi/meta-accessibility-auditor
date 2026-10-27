import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import type { AxeResults } from 'axe-core';
import { Store } from '../src/store.js';
import { collectBrowserFacts } from '../src/evidence-checks.js';

test('Real fields distinguish false and absent ARIA invalid states from declared and native invalidity', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'access-walk-field-invalid-'));
  const store = new Store(dir);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.setContent(`<!doctype html><html lang="en"><title>Controlled invalid-state facts</title>
      <style>label{display:block;margin:8px}input{height:28px}</style><body><main>
      <p id="help">Enter your contact name.</p>
      <label>False <input id="false" aria-invalid="false" aria-describedby="help"></label>
      <label>True <input id="true" aria-invalid="true" aria-describedby="help"></label>
      <label>Grammar <input id="grammar" aria-invalid="grammar" aria-describedby="help"></label>
      <label>Spelling <input id="spelling" aria-invalid="spelling" aria-describedby="help"></label>
      <label>Absent <input id="absent" aria-describedby="help"></label>
      <label>Empty <input id="empty" aria-invalid="" aria-describedby="help"></label>
      <label>Unknown <input id="unknown" aria-invalid="unexpected" aria-describedby="help"></label>
      <label>Native valid <input id="native-valid" type="email" value="synthetic@example.test" required aria-describedby="help"></label>
      <label>Native invalid <input id="native-invalid" type="email" value="synthetic-invalid-email" required aria-describedby="help"></label>
      <label>False with native invalid <input id="false-native-invalid" aria-invalid="false" required aria-describedby="help"></label>
      </main></body></html>`);
    const run = store.create('Controlled field-state fixture', page.url(), 'offline');
    const image = store.asset(run.id, 'capture_fields.png', await page.screenshot());
    const original = store.append(run.id, 'capture', 'browser', {
      stable: true,
      url: page.url(),
      imageFile: image.file,
      imageHash: image.hash,
      width: 1440,
      height: 900,
      elements: [],
      limits: { totalControls: 10 },
    });
    const facts = await collectBrowserFacts(page, original, {
      passes: [],
      violations: [],
      incomplete: [],
    } as unknown as AxeResults);
    const fields = new Map(facts.fields.map((field) => [field.selector, field]));
    assert.equal(fields.size, 10);
    assert.deepEqual(
      Object.fromEntries([...fields].map(([selector, field]) => [selector, field.invalid])),
      {
        '#false': false,
        '#true': true,
        '#grammar': true,
        '#spelling': true,
        '#absent': false,
        '#empty': false,
        '#unknown': true,
        '#native-valid': false,
        '#native-invalid': true,
        '#false-native-invalid': true,
      },
    );
    for (const field of facts.fields) {
      assert.equal(typeof field.invalid, 'boolean');
      assert.deepEqual(field.describedBy, ['Enter your contact name.']);
    }
    assert.equal(fields.get('#false')?.ariaInvalid, 'false');
    assert.equal(fields.get('#absent')?.ariaInvalid, null);
    assert.equal(fields.get('#empty')?.ariaInvalid, '');
    assert.equal(fields.get('#native-valid')?.nativeValidityValid, true);
    assert.equal(fields.get('#native-invalid')?.nativeValidityValid, false);
    assert.equal(fields.get('#false-native-invalid')?.nativeValidityValid, false);
    assert(!JSON.stringify(facts).includes('synthetic@example.test'));
    assert(!JSON.stringify(facts).includes('synthetic-invalid-email'));
    assert.equal(store.records(run.id).filter((record) => record.kind === 'action').length, 0);
    assert.equal(store.usage(run.id).requests.length, 0);
  } finally {
    await browser.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
