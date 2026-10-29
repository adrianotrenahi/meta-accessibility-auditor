import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserWalk } from '../src/browser.js';
import { clearPageBlockers } from '../src/page-blockers.js';
import { exportHostActivity } from '../src/host-activity.js';
import { startServer } from '../server/index.js';

// A controlled travel home page: a promotion rotating faster than a capture,
// a sign-in popup that closes with Escape, and a consent banner below it.
const travelPage = (consentButtons: string, popup = true) =>
  '<html lang="en"><head><title>Controlled travel home</title></head><body>' +
  '<nav><a href="#flights">Flights</a><a href="#hotels">Hotels</a><a href="#cars">Cars</a></nav>' +
  '<main><h1>Search. Book. Travel.</h1><button>Search flights</button>' +
  '<section aria-label="Offers"><p id="promo">Save on flights</p><p id="promoDetail">Today only</p></section></main>' +
  (popup
    ? '<div id="popup" role="dialog" aria-modal="true" aria-label="Sign in for member prices">' +
      '<button>Sign in</button><button aria-label="Close">×</button></div>'
    : '') +
  '<div id="onetrust-banner-sdk" style="position:fixed;bottom:0;left:0;right:0;background:#fff" aria-label="Cookie banner">' +
  `<p>We use cookies.</p>${consentButtons}</div>` +
  '<script>' +
  "let n=0;setInterval(()=>{n++;document.querySelector('#promo').textContent='Offer number '+n;" +
  "document.querySelector('#promoDetail').textContent=n%2?'Hotels too':'Today only';},120);" +
  "addEventListener('keydown',e=>{if(e.key==='Escape')document.querySelector('#popup')?.remove()});" +
  "for(const b of document.querySelectorAll('#onetrust-banner-sdk button'))b.onclick=()=>{" +
  "document.body.dataset.consent=b.dataset.choice;document.querySelector('#onetrust-banner-sdk').remove()};" +
  '</script></body></html>';

async function withWalk(run: (walk: BrowserWalk, app: any, runId: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'page-blockers-'));
  const app = await startServer(0, dir, false);
  const created = app.store.create('Controlled blocker page', app.origin + '/shop/', 'live');
  const walk = new BrowserWalk(app.store, created.id, app.origin, true, 'chromium');
  try {
    await walk.start(created.url);
    await run(walk, app, created.id);
  } finally {
    try {
      await walk.close();
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

test('A rotating promotion no longer prevents a stable first screen or keyboard input', async () => {
  await withWalk(async (walk) => {
    await walk.page.setContent(travelPage('', false));
    await walk.page.evaluate(() => document.querySelector('#onetrust-banner-sdk')?.remove());
    const current = await walk.captureSettled();
    assert.equal(current.payload.stable, true);
    // The decision's original remains usable for input although the promotion keeps changing.
    await walk.page.waitForTimeout(300);
    await walk.act({ kind: 'press', key: 'Tab', note: 'Move focus.' }, current);
    assert.equal((await walk.focus()).name, 'Flights');
  });
});

test('An animated page with unchanged content needs no picture per Tab', async () => {
  await withWalk(async (walk, app, runId) => {
    await walk.page.setContent(
      '<html lang="en"><body><style>@keyframes spin{to{transform:rotate(1turn)}}' +
        '.spinner{width:20px;height:20px;background:#08c;animation:spin 1s linear infinite}</style>' +
        '<div class="spinner"></div><nav><a href="#a">Flights</a><a href="#b">Hotels</a>' +
        '<a href="#c">Cars</a><a href="#d">Help</a></nav><button>Search flights</button></body></html>',
    );
    let current = await walk.captureSettled();
    assert.equal(
      current.payload.screenState,
      undefined,
      'A running animation leaves it incomplete.',
    );
    const captures = () => app.store.records(runId).filter((r: any) => r.kind === 'capture').length;
    const before = captures();
    for (let i = 0; i < 4; i++) {
      const performed = await walk.act({ kind: 'press', key: 'Tab', note: 'Move focus.' }, current);
      current = await walk.observeKeyboardMovement(current, performed);
      assert.equal(current.kind, 'observation', 'An ordinary Tab needs no new screenshot.');
    }
    assert.equal(captures(), before);
    assert.equal(current.payload.focus.name, 'Help');
  });
});

test('Escape closes the popup, then Tab reaches and activates the cookie refusal', async () => {
  await withWalk(async (walk, app, runId) => {
    await walk.page.setContent(
      travelPage(
        '<button data-choice="accepted">Accept all</button><button data-choice="rejected">Reject all</button>',
      ),
    );
    const start = await walk.captureSettled();
    const current = await clearPageBlockers(
      walk,
      app.store,
      runId,
      start,
      new AbortController().signal,
      { arrival: true },
    );
    assert.equal(current.kind, 'capture');
    assert.equal(await walk.page.locator('#popup').count(), 0);
    assert.equal(await walk.page.locator('body').getAttribute('data-consent'), 'rejected');
    const notes = app.store
      .records(runId)
      .filter((r: any) => r.payload.method === 'page_blocker/1')
      .map((r: any) => r.payload);
    assert.deepEqual(
      notes.map((note: any) => note.test),
      ['escape', 'tab_reach', 'activate'],
    );
    assert.equal(notes[0].closed, true);
    assert.equal(notes[1].reachedControl, true);
    assert.equal(notes[1].choice, 'refuse');
    assert.equal(notes[1].tabsPressed > 0, true, 'The refusal was reached by real Tab presses.');
    assert.equal(notes[2].cleared, true);
    const activity = exportHostActivity(app.store.records(runId), runId, false).entries.map(
      (entry) => entry.reason,
    );
    assert(activity.includes('Popup: Escape closed it.'));
    assert(activity.some((line) => /^Cookie banner: Tab reached "Reject all"/.test(line)));
    assert.equal(app.store.usage(runId).requests.length, 0, 'No model request is needed.');
  });
});

test('Acceptance is only chosen when no refusal is offered, and says so', async () => {
  await withWalk(async (walk, app, runId) => {
    await walk.page.setContent(
      travelPage(
        '<button data-choice="settings">Cookie settings</button><button data-choice="accepted">Yes, I accept</button>',
        false,
      ),
    );
    const start = await walk.captureSettled();
    await clearPageBlockers(walk, app.store, runId, start, new AbortController().signal, {
      arrival: true,
    });
    assert.equal(await walk.page.locator('body').getAttribute('data-consent'), 'accepted');
    const reach = app.store
      .records(runId)
      .find((r: any) => r.payload.method === 'page_blocker/1' && r.payload.test === 'tab_reach');
    assert.equal(reach.payload.choice, 'accept_only_offered');
    const activity = exportHostActivity(app.store.records(runId), runId, false).entries;
    assert(activity.some((entry) => /No one-click refusal was offered/.test(entry.reason)));
  });
});

test('A sign-in control inside a popup is never activated to clear it', async () => {
  await withWalk(async (walk, app, runId) => {
    await walk.page.setContent(
      '<html lang="en"><body><h1>Home</h1><div role="dialog" aria-modal="true" aria-label="Members">' +
        '<button onclick="document.body.dataset.signed=1">Sign in</button></div></body></html>',
    );
    const start = await walk.captureSettled();
    await clearPageBlockers(walk, app.store, runId, start, new AbortController().signal, {
      arrival: true,
    });
    assert.equal(await walk.page.locator('body').getAttribute('data-signed'), null);
    const left = app.store
      .records(runId)
      .find((r: any) => r.payload.method === 'page_blocker/1' && r.payload.outcome);
    assert.equal(left.payload.outcome, 'left_for_navigator');
  });
});

test('Mid-journey, a popup the walk opened stays open while a consent banner is still refused', async () => {
  await withWalk(async (walk, app, runId) => {
    await walk.page.setContent(
      '<html lang="en"><body><h1>Results</h1>' +
        '<div id="picker" role="dialog" aria-label="Choose dates"><button aria-label="Close">×</button>' +
        '<button>23 December</button></div>' +
        '<div id="onetrust-banner-sdk" style="position:fixed;bottom:0" aria-label="Cookie banner"><p>Cookies</p>' +
        '<button data-choice="rejected">Reject all</button></div>' +
        "<script>addEventListener('keydown',e=>{if(e.key==='Escape')document.querySelector('#picker')?.remove()});" +
        "document.querySelector('#onetrust-banner-sdk button').onclick=e=>{" +
        "document.body.dataset.consent='rejected';e.target.parentElement.remove()};</script></body></html>",
    );
    const start = await walk.captureSettled();
    await clearPageBlockers(walk, app.store, runId, start, new AbortController().signal, {
      arrival: false,
    });
    assert.equal(await walk.page.locator('#picker').count(), 1, 'The date picker stays open.');
    assert.equal(await walk.page.locator('body').getAttribute('data-consent'), 'rejected');
    const tests = app.store
      .records(runId)
      .filter((r: any) => r.payload.method === 'page_blocker/1')
      .map((r: any) => r.payload.test);
    assert(!tests.includes('escape'), 'No Escape is sent to the journey popup.');
  });
});
