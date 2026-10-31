import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser } from 'playwright';
import { VISITOR_CHROME_ARGS, launchAuditBrowser, visitorUserAgent } from '../src/browser.js';
import { defaultEngine } from '../src/runner.js';

// A pretend secure page served inside the browser: no website is contacted.
const announce = async (browser: Browser, visitor: boolean) => {
  try {
    const context = await browser.newContext(
      visitor ? { userAgent: await visitorUserAgent(browser) } : {},
    );
    let hints = '';
    await context.route('https://local.test/**', (route) => {
      hints = route.request().headers()['sec-ch-ua'] ?? '';
      return route.fulfill({ contentType: 'text/html', body: '<p>Local page</p>' });
    });
    const page = await context.newPage();
    await page.goto('https://local.test/');
    const seen = await page.evaluate(() => ({
      webdriver: navigator.webdriver,
      ua: navigator.userAgent,
      brands: ((navigator as any).userAgentData?.brands ?? []).map((b: any) => b.brand).join(', '),
    }));
    return { ...seen, hints };
  } finally {
    await browser.close();
  }
};

// Owner, 31 Oct: the robot audits the page a real visitor gets, so real-website audits do not
// announce themselves as automated. The controlled shop keeps Playwright's test browser.
test('Real-website audits use a browser without the automation signal or the headless name', async () => {
  for (const [label, browser] of [
    ['installed Chrome', await launchAuditBrowser('chromium', true, { headless: true })],
    // The fallback when Chrome is not installed: full Chromium, not the cut-down hidden build.
    [
      'Chromium fallback',
      await chromium.launch({ headless: true, channel: 'chromium', args: VISITOR_CHROME_ARGS }),
    ],
  ] as const) {
    const visitor = await announce(browser, true);
    assert.equal(visitor.webdriver, false, label);
    for (const said of [visitor.ua, visitor.brands, visitor.hints])
      assert(!said.includes('Headless'), `${label}: ${said}`);
    assert.match(visitor.ua, /Chrome\/\d+/, label);
  }
  const shop = await announce(
    await launchAuditBrowser('chromium', false, { headless: true }),
    false,
  );
  assert.equal(shop.webdriver, true, 'the controlled shop browser is unchanged');
});

test('Real-website audits default to Chrome; the controlled shop keeps WebKit', () => {
  assert.equal(defaultEngine(true), 'chromium');
  assert.equal(defaultEngine(false), 'webkit');
});
