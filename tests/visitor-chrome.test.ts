import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launchAuditBrowser, visitorUserAgent } from '../src/browser.js';

const announce = async (visitorChrome: boolean) => {
  const browser = await launchAuditBrowser('chromium', visitorChrome, { headless: true });
  try {
    const context = await browser.newContext(
      visitorChrome ? { userAgent: await visitorUserAgent(browser) } : {},
    );
    const page = await context.newPage();
    await page.setContent('<p>Local page; no website is contacted.</p>');
    return await page.evaluate(() => ({ webdriver: navigator.webdriver, ua: navigator.userAgent }));
  } finally {
    await browser.close();
  }
};

// Owner, 31 Oct: the robot audits the page a real visitor gets, so real-website audits do not
// announce themselves as automated. The controlled shop keeps Playwright's test browser.
test('Real-website audits use a browser without the automation signal or the headless name', async () => {
  const visitor = await announce(true);
  assert.equal(visitor.webdriver, false);
  assert(!visitor.ua.includes('Headless'), visitor.ua);
  assert.match(visitor.ua, /Chrome\/\d+/);
  const shop = await announce(false);
  assert.equal(shop.webdriver, true, 'the controlled shop browser is unchanged');
});
