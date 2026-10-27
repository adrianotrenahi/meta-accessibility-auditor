import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
const browser = await chromium.launch({ headless: true }),
  context = await browser.newContext({ viewport: { width: 1440, height: 1100 } }),
  page = await context.newPage(),
  origin = 'http://127.0.0.1:4317',
  results: any[] = [];
try {
  await page.goto(origin);
  await page.getByRole('heading', { name: 'Find the barriers. Keep the evidence.' }).waitFor();
  const session = await (await page.request.get(origin + '/api/session')).json();
  const response = await page.request.post(origin + '/api/runs', {
    headers: { 'X-Session-Token': session.token },
    data: { mode: 'offline', headless: true, voiceOver: false },
  });
  assert.equal(response.status(), 201);
  const run = await response.json();
  // Select the run deliberately; reconnecting and opening evidence must never start work.
  await page.reload();
  await page
    .getByRole('button', { name: /Controlled shop/ })
    .first()
    .click();
  await page
    .getByRole('heading', { name: 'The add-to-basket button has no accessible name' })
    .waitFor({ timeout: 45000 });
  await page.getByRole('button', { name: 'Show original captured page' }).click();
  const chosen = await page.locator('select').inputValue();
  const originalReport = await (await page.request.get(origin + '/api/runs/' + run.id)).json();
  assert.equal(
    chosen,
    originalReport.records.find((r: any) => r.kind === 'capture').id,
    'A finding must open its own original screenshot, not the latest basket state.',
  );
  for (const width of [1440, 320]) {
    await page.setViewportSize({ width, height: 1100 });
    await page.screenshot({ path: `output/viewer-${width}.png`, fullPage: true });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    assert.equal(overflow, false, `No page overflow at ${width}px`);
    const scan = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    results.push({
      width,
      violations: scan.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) })),
    });
    assert.equal(scan.violations.length, 0, JSON.stringify(results.at(-1)));
  }
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.keyboard.press('Tab');
  assert(await page.locator(':focus').count());
  const runsBefore = await (await page.request.get(origin + '/api/runs')).json();
  await page.getByText('Read page information as text').click();
  await page.reload();
  const runsAfter = await (await page.request.get(origin + '/api/runs')).json();
  assert.equal(runsBefore.length, runsAfter.length);
  const report = await (await page.request.get(origin + '/api/runs/' + run.id)).json();
  assert.equal(report.usage.requests.length, 0);
  assert(
    report.records.every((r: any) => !['candidate', 'model_response', 'review'].includes(r.kind)),
    'Raw candidate accusations must not reach the viewer.',
  );
  assert.equal(report.score, null);
  const denied = await page.request.post(origin + '/api/runs', {
    headers: { Origin: 'https://unrelated.example' },
    data: { mode: 'offline' },
  });
  assert.equal(denied.status(), 403);
  const unsafe = await page.request.post(origin + '/api/runs', {
    headers: { 'X-Session-Token': session.token },
    data: { mode: 'live' },
  });
  assert.equal(unsafe.status(), 400);
  // Deliberately break a real control, prove the checker catches it, then reload.
  await page.getByRole('button', { name: /Start saved demo/ }).evaluate((e) => e.replaceChildren());
  const broken = await new AxeBuilder({ page }).withRules(['button-name']).analyze();
  assert(broken.violations.some((v) => v.id === 'button-name'));
  await page.reload();
  mkdirSync('output', { recursive: true });
  writeFileSync(
    'output/ui-proof.json',
    JSON.stringify(
      {
        at: new Date().toISOString(),
        runId: run.id,
        results,
        creditsSpent: 0,
        modelCalls: 0,
        reloadStartsNoRun: true,
        rawClaimsStayInternal: true,
        deliberateBreakCaught: 'removed a button name; button-name failed; reload restored it',
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({ runId: run.id, results, modelCalls: 0, deliberateBreakCaught: true }, null, 2),
  );
} finally {
  await browser.close();
}
