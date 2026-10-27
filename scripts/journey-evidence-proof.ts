import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { once } from 'node:events';
import { BrowserWalk } from '../src/browser.js';
import { Store } from '../src/store.js';
import {
  readJourneyContext,
  compareJourneyTotals,
  recordOptOutContext,
  ReturnEvidence,
} from '../src/journey-evidence.js';
import type { Action } from '../src/models.js';

// The fixture's commerce markup and clean/lost return behaviour are deliberate test conditions.
// No customer site is modified, and these observations do not assign criterion verdicts.
function fixture(path: string) {
  const url = new URL(path, 'http://fixture.local');
  const after = url.pathname === '/review';
  const lost = url.searchParams.get('case') === 'lost';
  const plain = url.pathname === '/plain';
  const privacy = url.pathname === '/read-privacy';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Controlled journey-evidence fixture</title></head><body>
  <p>Controlled proof fixture: declared bundle prices, safe keyboard choice and synthetic email return. No orders.</p>
  <main ${plain ? '' : 'itemscope itemtype="https://schema.org/Offer"'}>
    <h1>${after ? 'Review the demo selection' : 'Your demo selection'}</h1>
    ${
      plain
        ? '<p>€24.00 — ordinary visible text, not a declared bundle total.</p>'
        : `
    <meta itemprop="priceCurrency" content="EUR"><span id="total" itemprop="price" content="${after ? 30 : 24}.00">€${after ? 30 : 24}.00</span>
    <p itemprop="description">${after ? 'Shipping of €6 is included before commitment.' : 'Shipping is shown at review.'}</p>
    <div itemprop="includesObject" itemscope itemtype="https://schema.org/TypeAndQuantityNode">
      <meta itemprop="amountOfThisGood" content="1"><span itemprop="typeOfGood" itemscope itemtype="https://schema.org/Product"><meta itemprop="sku" content="canvas-bag"><span itemprop="name">Canvas bag</span></span>
    </div>
    <div itemprop="addOn" itemscope itemtype="https://schema.org/Offer">
      <meta itemprop="sku" content="gift-wrap"><meta itemprop="price" content="5.00"><meta itemprop="priceCurrency" content="EUR">
      <label><input id="gift" type="checkbox" checked> Gift wrapping · €5</label>
    </div>`
    }
    <label for="email">Email address</label><input id="email" type="email" autocomplete="off">
    ${privacy ? '<label>Private fixture field<input id="password" type="password" value="SYNTHETIC_PRIVATE_SENTINEL"></label><label>Unsafe fixture choice<input id="token" type="checkbox" checked value="SYNTHETIC_PRIVATE_SENTINEL"></label><label>Delivery option<select id="delivery"><option value="SYNTHETIC_PRIVATE_SENTINEL" selected>Default option</option></select></label><label>Unbound quantity<input id="quantity" type="number" itemprop="orderQuantity" value="2"></label>' : ''}
    ${after ? '' : `<p><a id="next" href="/review${lost ? '?case=lost' : ''}">Review demo selection</a></p>`}
  </main><script>
    const email=document.querySelector('#email');
    ${lost ? '' : `email.value=sessionStorage.getItem('controlled-synthetic-email')||'';email.addEventListener('input',()=>sessionStorage.setItem('controlled-synthetic-email',email.value));`}
    const gift=document.querySelector('#gift');
    ${privacy ? 'for(const id of ["password","token"]){Object.defineProperty(document.getElementById(id),"value",{get(){throw new Error("The journey reader must not read this fixture value.")}})}' : ''}
    if(gift)gift.addEventListener('change',()=>{const total=document.querySelector('#total');const value=${after ? 30 : 24}-(gift.checked?0:5);total.setAttribute('content',value.toFixed(2));total.textContent='€'+value.toFixed(2)});
  </script></body></html>`;
}

const server = createServer((request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(fixture(request.url ?? '/'));
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert(address && typeof address !== 'string');
const origin = `http://127.0.0.1:${address.port}`;
mkdirSync('output/playwright', { recursive: true });
const dir = mkdtempSync(join('output/playwright', 'journey-evidence-'));
const store = new Store(dir);
const results: any[] = [];
try {
  for (const lost of [false, true]) {
    const url = origin + '/' + (lost ? '?case=lost' : '');
    const run = store.create('Controlled bundle, opt-out and return evidence', url, 'offline');
    const walk = new BrowserWalk(store, run.id, origin, true, 'chromium');
    const returns = new ReturnEvidence(store, run.id);
    try {
      let current = await walk.start(url);
      const act = async (action: Action) => {
        const before = current;
        const actionRecord = await walk.act(action, before);
        current = await walk.capture();
        return { before, action: actionRecord, after: current };
      };
      const reach = async (id: string) => {
        for (let n = 0; n < 12 && (await walk.focus()).id !== id; n++)
          await act({
            kind: 'press',
            key: 'Tab',
            note: 'Reach the controlled target through actual keyboard traversal.',
          });
        assert.equal((await walk.focus()).id, id);
      };
      await reach('email');
      const typed = await act({
        kind: 'type',
        text: 'test@example.org',
        note: 'Type the approved synthetic value into the known controlled email field.',
      });
      assert.equal(
        await returns.rememberTyped(walk, typed.before, typed.action, typed.after),
        true,
      );
      await reach('next');
      const initial = await readJourneyContext(walk, current);
      assert.equal(initial.payload.stable, true);
      assert.equal(initial.payload.data.commerce.total, 24);
      const next = await act({
        kind: 'press',
        key: 'Enter',
        note: 'Open the non-committing controlled review page.',
      });
      const review = await readJourneyContext(walk, current);
      const totals = compareJourneyTotals(store, run.id, initial, next.action, review);
      assert.equal(totals.payload.comparable, true);
      assert.equal(totals.payload.beforeTotal, 24);
      assert.equal(totals.payload.afterTotal, 30);
      await reach('gift');
      const beforeChoice = await readJourneyContext(walk, current);
      const toggle = await act({
        kind: 'press',
        key: 'Space',
        note: 'Uncheck the explicitly priced controlled gift-wrapping choice.',
      });
      const afterChoice = await readJourneyContext(walk, current);
      const optout = recordOptOutContext(store, run.id, beforeChoice, toggle.action, afterChoice);
      assert.equal(optout.payload.optOutTested, true);
      assert.equal(optout.payload.choiceChanged, true);
      const intentional = compareJourneyTotals(
        store,
        run.id,
        beforeChoice,
        toggle.action,
        afterChoice,
      );
      assert.equal(
        intentional.payload.comparable,
        false,
        'The intentional choice change must not become an unexplained-price comparison.',
      );
      const back = await act({
        kind: 'back',
        note: 'Use an actual bounded back action in the controlled fixture.',
      });
      const preservation = await returns.compareAfterBack(
        walk,
        back.before,
        back.action,
        back.after,
      );
      assert.equal(preservation.payload.entriesCompared, true);
      assert.equal(preservation.payload.preserved, !lost);
      const observations = store.records(run.id).filter((record) => record.kind === 'observation');
      assert(
        observations.every(
          (record) => !JSON.stringify(record.payload).includes('test@example.org'),
        ),
      );
      assert.equal(store.usage(run.id).requests.length, 0);
      const screenshot = join('output/playwright', `journey-return-${lost ? 'lost' : 'kept'}.png`);
      await walk.page.screenshot({ path: screenshot });
      store.finish(
        run.id,
        'complete',
        'Controlled original-evidence proof; no model, full-site or criterion verdict.',
      );
      results.push({
        case: lost ? 'lost' : 'kept',
        runId: run.id,
        passed: true,
        totals: totals.payload,
        optOut: optout.payload,
        returnPreservation: preservation.payload,
        screenshot,
        modelCalls: 0,
        creditsSpent: 0,
      });
    } finally {
      returns.clear();
      await walk.close();
    }
  }
  const run = store.create(
    'Ordinary price text is not a trusted journey total',
    origin + '/plain',
    'offline',
  );
  const walk = new BrowserWalk(store, run.id, origin, true, 'chromium');
  try {
    const source = await walk.start(run.url);
    const observation = await readJourneyContext(walk, source);
    assert.equal(observation.payload.data.commerce, null);
    store.finish(run.id, 'complete', 'Unknown structured commerce correctly retained; no verdict.');
    results.push({
      case: 'ordinary-price-text',
      runId: run.id,
      passed: true,
      commerce: null,
      modelCalls: 0,
    });
  } finally {
    await walk.close();
  }
  const privacyRun = store.create(
    'Read-only private-field exclusion fixture',
    origin + '/read-privacy',
    'offline',
  );
  const privacyWalk = new BrowserWalk(store, privacyRun.id, origin, true, 'chromium');
  try {
    const source = await privacyWalk.start(privacyRun.url);
    const observation = await readJourneyContext(privacyWalk, source);
    assert.equal(observation.payload.stable, true);
    assert.equal(observation.payload.data.commerce.total, 24);
    assert.equal(observation.payload.data.choicesComplete, false);
    assert(!JSON.stringify(observation.payload.data).includes('SYNTHETIC_PRIVATE_SENTINEL'));
    assert(
      !observation.payload.data.choices.some((choice: any) =>
        ['password', 'token'].includes(choice.id),
      ),
    );
    assert(
      observation.payload.data.choices.some(
        (choice: any) => choice.type === 'select' && choice.selectedIndexes[0] === 0,
      ),
    );
    assert(
      observation.payload.data.choices.some(
        (choice: any) => choice.type === 'quantity' && choice.quantity === 2,
      ),
    );
    store.finish(
      privacyRun.id,
      'complete',
      'Permitted state read; unsafe values excluded and unbound choice/quantity context remains incomplete.',
    );
    results.push({
      case: 'private-values-excluded',
      runId: privacyRun.id,
      passed: true,
      choicesComplete: false,
      rawValuesExcluded: true,
      modelCalls: 0,
    });
  } finally {
    await privacyWalk.close();
  }
  writeFileSync(
    'output/playwright/journey-evidence-proof.json',
    JSON.stringify(
      {
        at: new Date().toISOString(),
        passed: true,
        fixture:
          'New controlled test markup; clean/lost persistence and prices are deliberate fixture conditions, not customer findings.',
        recordsDirectory: dir,
        results,
        modelCalls: 0,
        nativeCalls: 0,
        creditsSpent: 0,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      passed: true,
      cases: results.map((result) => result.case),
      modelCalls: 0,
      nativeCalls: 0,
      creditsSpent: 0,
      artifact: 'output/playwright/journey-evidence-proof.json',
    }),
  );
} finally {
  store.close();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
