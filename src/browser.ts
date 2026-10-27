import { webkit, chromium, type Browser, type Page } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { Store } from './store.js';
import { LIMITS, type Capture, type RecordEntry } from './types.js';
import type { Action } from './models.js';
import { permittedUrl } from './network.js';
import { randomUUID } from 'node:crypto';
const controls =
  'button,a[href],input:not([type=hidden]),select,textarea,[role=button],[role=link],[role=checkbox],[role=combobox]';
export const isCommitment = (name: string) =>
  /\b(place|confirm|submit|complete)\s+(?:my\s+|your\s+|the\s+)?(order|purchase|booking|reservation)|\b(pay|subscribe|sign\s*up|register|sign\s*in|log\s*in|buy\s*now)\b/i.test(
    name,
  );
export class BrowserWalk {
  browser?: Browser;
  page!: Page;
  actions = 0;
  started = Date.now();
  constructor(
    public store: Store,
    public runId: string,
    public controlledOrigin: string,
    public headless = false,
    public engine: 'webkit' | 'chromium' = 'webkit',
  ) {}
  assertActive() {
    if (this.store.run(this.runId).state !== 'running') throw Error('The run has stopped.');
    if (Date.now() - this.started > LIMITS.minutes * 60000) throw Error('Run time limit reached.');
    if (this.actions >= LIMITS.actions) throw Error('Browser action limit reached.');
  }
  count() {
    this.assertActive();
    this.actions++;
  }
  async start(url: string) {
    this.assertActive();
    const approved = await permittedUrl(url, this.controlledOrigin);
    this.browser = await (this.engine === 'webkit' ? webkit : chromium).launch({
      headless: this.headless,
    });
    const context = await this.browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
      serviceWorkers: 'block',
      acceptDownloads: false,
    });
    await context.route('**/*', async (route) => {
      try {
        const u = new URL(route.request().url());
        if (u.protocol === 'data:') return route.continue();
        await permittedUrl(
          u.href,
          this.controlledOrigin,
          route.request().isNavigationRequest() ? approved.origin : undefined,
        );
        await route.continue();
      } catch {
        await route.abort('blockedbyclient');
      }
    });
    this.page = await context.newPage();
    this.page.setDefaultTimeout(8000);
    this.page.on('dialog', (dialog) => void dialog.dismiss());
    this.page.on('popup', (popup) => void popup.close());
    this.count();
    await this.page.goto(approved.href, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await this.page.bringToFront();
    return this.capture();
  }
  async focus() {
    return this.page.evaluate(() => {
      const e = document.activeElement as HTMLElement | null;
      return {
        tag: e?.tagName.toLowerCase() ?? '',
        text: (e?.textContent ?? '').trim().slice(0, 200),
        name: e?.getAttribute('aria-label') ?? '',
        type: e?.getAttribute('type') ?? '',
      };
    });
  }
  async capture(): Promise<RecordEntry> {
    this.assertActive();
    const elements = [];
    const locators = this.page.locator(controls);
    const count = Math.min(await locators.count(), 60);
    for (let i = 0; i < count; i++) {
      const locator = locators.nth(i);
      if (!(await locator.isVisible().catch(() => false))) continue;
      const box = await locator.boundingBox();
      if (!box) continue;
      const info = await locator.evaluate((e) => ({
        tag: e.tagName.toLowerCase(),
        text: (e.textContent ?? '').trim().slice(0, 200),
        type: e.getAttribute('type') ?? '',
        disabled: e.hasAttribute('disabled'),
      }));
      const aria = await locator.ariaSnapshot({ depth: 1 }).catch(() => '');
      const first = aria.split('\n')[0] ?? '';
      const role = first.match(/^- ([a-z]+)/)?.[1] ?? info.tag;
      const name = first.match(/"((?:\\.|[^"])*)"/)?.[1] ?? '';
      elements.push({ ...info, id: `e${i}`, role, name, box });
    }
    const image = await this.page.screenshot({ type: 'png', animations: 'disabled' });
    const asset = this.store.asset(this.runId, `capture_${randomUUID()}.png`, image);
    const visibleText = await this.page.locator('body').innerText();
    const payload: Capture = {
      url: this.page.url(),
      title: await this.page.title(),
      imageFile: asset.file,
      imageHash: asset.hash,
      width: 1440,
      height: 900,
      elements,
      text: visibleText.slice(0, 16000),
      aria: await this.page.locator('body').ariaSnapshot(),
      focus: await this.focus(),
      limits: {
        totalControls: await locators.count(),
        maximumListedControls: 60,
        visibleTextTruncated: visibleText.length > 16000,
        imageScope: 'viewport',
      },
    };
    return this.store.append(this.runId, 'capture', 'browser', payload);
  }
  async act(action: Action, source: RecordEntry) {
    this.assertActive();
    if (source.payload.url !== this.page.url())
      throw Error('Page changed; capture a fresh observation first.');
    const before = await this.focus();
    const urlBefore = this.page.url();
    let outcome = 'performed';
    if (action.kind === 'press') {
      if (!action.key) throw Error('A keyboard action needs a permitted key.');
      if (['Enter', 'Space'].includes(action.key) && isCommitment(before.name + ' ' + before.text))
        throw Error('Stopped before a purchase, account or payment action.');
      this.count();
      await this.page.keyboard.press(action.key === 'Space' ? 'Space' : action.key);
    } else if (action.kind === 'type') {
      if (before.type === 'password' || before.type === 'file')
        throw Error('Passwords and file inputs are outside this demo.');
      if (
        !action.text ||
        !['test@example.org', 'Demo', 'Visitor', 'Demo Street', '12345'].includes(action.text)
      )
        throw Error('Only the approved synthetic demonstration values may be entered.');
      this.count();
      await this.page.keyboard.type(action.text);
    } else if (action.kind === 'scroll') {
      this.count();
      await this.page.mouse.wheel(0, action.direction === 'up' ? -600 : 600);
    } else if (action.kind === 'back') {
      this.count();
      await this.page.goBack({ waitUntil: 'domcontentloaded' });
    } else if (action.kind === 'wait') {
      this.count();
      await this.page.waitForTimeout(800);
    } else outcome = 'not a browser input';
    await this.page.waitForTimeout(180);
    const after = await this.focus();
    return this.store.append(
      this.runId,
      'action',
      'browser',
      {
        method: 'actual_keyboard_or_browser',
        action,
        before,
        after,
        urlBefore,
        urlAfter: this.page.url(),
        outcome,
        actionCount: this.actions,
      },
      [source.id],
    );
  }
  async measurements(source: RecordEntry) {
    const result = await new AxeBuilder({ page: this.page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    return this.store.append(
      this.runId,
      'observation',
      'axe-core',
      {
        method: 'automatic_accessibility_scan',
        engine: result.testEngine,
        violations: result.violations.map((v) => ({
          id: v.id,
          impact: v.impact,
          description: v.description,
          help: v.help,
          nodes: v.nodes.map((n) => ({
            target: n.target,
            html: n.html,
            failureSummary: n.failureSummary,
          })),
        })),
        incomplete: result.incomplete.map((x) => ({ id: x.id, nodes: x.nodes.length })),
        limit:
          'This scan is not a keyboard or screen-reader test and does not certify the website.',
      },
      [source.id],
    );
  }
  image(record: RecordEntry) {
    return (
      'data:image/png;base64,' +
      this.store.image(this.runId, record.payload.imageFile).toString('base64')
    );
  }
  images(records: RecordEntry[]) {
    return records
      .filter((r) => r.kind === 'capture')
      .map((r) => ({ captureId: r.id, image: this.image(r) }));
  }
  async close() {
    await this.browser?.close();
  }
}
