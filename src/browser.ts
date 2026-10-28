import { originalAriaName } from './aria-name.js';
import { webkit, chromium, type Browser, type Page } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { Store, digest, recordIsIntact } from './store.js';
import { LIMITS, type Capture, type RecordEntry } from './types.js';
import type { Action } from './models.js';
import { permittedUrl } from './network.js';
import { randomUUID } from 'node:crypto';
import { LiveFrames } from './live-frame.js';
import { documentWasReplaced, readPage } from './page-observation.js';
import { readNavigationCapture } from './navigation-observation.js';
import { safeError } from './config.js';
import { collectBrowserFacts, summarizeAxe } from './evidence-checks.js';
import { installControlIdentity } from './control-identity.js';
import { publicBrowserProxy } from './public-network.js';
import { readRecordedFocusHelp, type RecordedFocusHelp } from './focus-help.js';
const controls =
  'button,a[href],input:not([type=hidden]),select,textarea,[role=button],[role=link],[role=checkbox],[role=combobox]';
export const isCommitment = (name: string) =>
  /\b(place|confirm|submit|complete)\s+(?:my\s+|your\s+|the\s+)?(order|purchase|booking|reservation)|\b(pay|subscribe|sign\s*up|register|sign\s*in|log\s*in|buy\s*now)\b|\b(confirmar|finalizar|completar|reservar)\s+(?:(?:la|mi|tu|el|su|una)\s+)?(?:cita|reserva|pedido|compra)\b|\b(pagar|registrarse|iniciar sesi[oó]n|crear cuenta)\b/i.test(
    name,
  );
/** An intact original no longer describes the page; this is an observation limit. */
export class MeasurementStateChanged extends Error {
  constructor(
    public captureId: string,
    public stage: 'before' | 'during',
    public observationId?: string,
  ) {
    super(
      stage === 'before'
        ? 'The original page state is no longer stable/current; no scan was attempted.'
        : observationId
          ? 'The page changed during measurement; its saved raw result remains untrusted.'
          : 'The page changed during measurement; no usable scan result was saved.',
    );
  }
}
/** No input has been sent: the decision's original no longer matches the page. */
export class ActionStateChanged extends Error {}
export class ObservationUnsettled extends Error {}
export function publicSearchInput(
  focus: {
    tag: string;
    type: string;
    role?: string;
    name: string;
    fieldName?: string;
    autocomplete?: string;
    searchForm?: boolean;
    paymentForm?: boolean;
  },
  text: string,
) {
  if (
    !text.trim() ||
    text.length > 160 ||
    /[\r\n@]/.test(text) ||
    focus.paymentForm ||
    !['input', 'textarea'].includes(focus.tag) ||
    !['', 'text', 'search'].includes(focus.type) ||
    (focus.autocomplete && !['off', 'on'].includes(focus.autocomplete))
  )
    return false;
  const label = focus.name + ' ' + (focus.fieldName ?? '');
  if (
    /\b(patient|paciente|dni|nie|passport|email|tel[eé]fono|address|direcci[oó]n|card|tarjeta|password|contrase[nñ]a)\b/i.test(
      label,
    )
  )
    return false;
  if (
    /\b(name|nombre|apellido)\b/i.test(label) &&
    !/\b(doctor|m[eé]dico|specialist|especialista|product|producto|business|empresa)\b|search by name|buscar por nombre/i.test(
      label,
    )
  )
    return false;
  return (
    focus.type === 'search' ||
    focus.role === 'searchbox' ||
    focus.searchForm === true ||
    /\b(search|buscar|b[uú]squeda|especialidad|specialty|ciudad|city)\b/i.test(label)
  );
}
export class BrowserWalk {
  browser?: Browser;
  private closing?: Promise<void>;
  private launching?: Promise<Browser>;
  private closingRequested = false;
  private publicProxy?: Awaited<ReturnType<typeof publicBrowserProxy>>;
  page!: Page;
  actions = 0;
  started = Date.now();
  readonly frames: LiveFrames;
  private lastOriginal?: { id: string; url: string; documentEpoch: number };
  private readonly controlIdentityKey = '__access_walk_control_' + randomUUID();
  constructor(
    public store: Store,
    public runId: string,
    public controlledOrigin: string,
    public headless = false,
    public engine: 'webkit' | 'chromium' = 'webkit',
    public publicWebsite = false,
  ) {
    this.frames = new LiveFrames(
      runId,
      () => this.page.screenshot({ type: 'png', timeout: 5000 }),
      () => this.assertActive(),
      () => this.store.records(this.runId),
      async () => digest(JSON.stringify(await this.observedState())),
      Date.now,
      () =>
        new Set(
          this.store
            .published(this.runId)
            .map((finding) => finding.targetCaptureId)
            .filter((id): id is string => typeof id === 'string'),
        ),
    );
  }
  assertActive() {
    if (this.closingRequested) throw Error('The browser is closing; no further action is allowed.');
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
    const controlledOrigin = this.publicWebsite ? '' : this.controlledOrigin;
    const approved = await permittedUrl(url, controlledOrigin);
    if (this.publicWebsite) {
      const proxy = await publicBrowserProxy();
      if (this.closingRequested) {
        await proxy.close();
        throw Error('The browser is closing.');
      }
      this.publicProxy = proxy;
    }
    this.assertActive();
    this.launching = (this.engine === 'webkit' ? webkit : chromium).launch({
      headless: this.headless,
      ...(this.publicProxy
        ? { proxy: { server: this.publicProxy.url, bypass: '<-loopback>' } }
        : {}),
    });
    this.browser = await this.launching;
    this.assertActive();
    const context = await this.browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
      serviceWorkers: 'block',
      acceptDownloads: false,
    });
    await installControlIdentity(context, this.controlIdentityKey);
    await context.route('**/*', async (route) => {
      try {
        const u = new URL(route.request().url());
        if (u.protocol === 'data:') return route.continue();
        if (this.publicWebsite) {
          // The proxy resolves once and pins the actual socket. Do not resolve resources again here.
          if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password)
            throw Error('Invalid public website request.');
        } else
          await permittedUrl(
            u.href,
            controlledOrigin,
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
    return readPage(this.page, () => this.readFocus());
  }
  private async readFocus() {
    const details = await this.page.evaluate(() => {
      const e = document.activeElement as HTMLElement | null;
      const form = (e as HTMLInputElement | null)?.form;
      const inputButton =
        e?.tagName === 'INPUT' &&
        ['submit', 'button', 'reset', 'image'].includes((e as HTMLInputElement).type);
      const style = e ? getComputedStyle(e) : null;
      return {
        documentEpoch: performance.timeOrigin,
        id: e?.id ?? '',
        tag: e?.tagName.toLowerCase() ?? '',
        text: (e?.textContent ?? '').trim().slice(0, 200),
        labelHint:
          e?.getAttribute('aria-label') ?? (inputButton ? (e as HTMLInputElement).value : ''),
        href: e?.getAttribute('href') ?? '',
        type: e?.getAttribute('type') ?? '',
        role: e?.getAttribute('role') ?? '',
        autocomplete: e?.getAttribute('autocomplete') ?? '',
        fieldName: e?.getAttribute('name') ?? '',
        searchForm: form?.getAttribute('role') === 'search',
        hasForm: !!form,
        paymentForm: !!form?.querySelector('[autocomplete^="cc-"],input[name*="card" i]'),
        appearance: style
          ? {
              outlineColor: style.outlineColor,
              outlineStyle: style.outlineStyle,
              outlineWidth: style.outlineWidth,
              outlineOffset: style.outlineOffset,
            }
          : null,
      };
    });
    const active = this.page.locator(':focus').first();
    const aria = (await active.count()) ? await active.ariaSnapshot({ depth: 1 }) : '';
    const name = originalAriaName(aria, details.labelHint);
    if (details.documentEpoch !== (await this.page.evaluate(() => performance.timeOrigin)))
      throw Error('Document changed during observation');
    const { documentEpoch: _epoch, ...focus } = details;
    return { ...focus, name };
  }
  private async observedState() {
    return {
      documentEpoch: await this.page.evaluate(() => performance.timeOrigin),
      url: this.page.url(),
      aria: await this.page.locator('body').ariaSnapshot(),
      focus: await this.focus(),
      focusHelp: await readRecordedFocusHelp(this.page),
      scroll: await this.page.evaluate(() => ({ x: scrollX, y: scrollY })),
    };
  }
  async capture(): Promise<RecordEntry> {
    const previous = this.lastOriginal;
    return readNavigationCapture(
      this.page,
      () => readPage(this.page, () => this.captureOnce()),
      previous,
      () => this.assertActive(),
      () => {
        this.store.append(
          this.runId,
          'limit',
          'browser',
          {
            method: 'navigation_observation_wait',
            reason:
              'The new document has not supplied its page body yet. Wait once for a fresh original; the earlier input remains saved and is not repeated.',
            maximumWaitMs: 20000,
          },
          previous ? [previous.id] : [],
        );
      },
    );
  }
  /**
   * Stable during capture, not a promise that the page stays unchanged afterwards.
   * Actions and measurements must still check freshness. Never repeat input.
   */
  async captureSettled(first?: RecordEntry): Promise<RecordEntry> {
    if (
      first &&
      (first.kind !== 'capture' ||
        first.runId !== this.runId ||
        !recordIsIntact(first) ||
        this.store.record(this.runId, first.id)?.hash !== first.hash)
    )
      throw Error('Observation recovery needs an intact original capture from this run.');
    const attempts: RecordEntry[] = [];
    let current = first ?? (await this.capture());
    for (let attempt = 0; attempt < 3; attempt++) {
      this.assertActive();
      attempts.push(current);
      if (current.payload.stable === true) return current;
      if (attempt < 2) {
        await this.page.waitForTimeout(200);
        current = await this.capture();
      }
    }
    const reason =
      'The page did not settle across three observations. No input was repeated; the journey remains incomplete.';
    this.store.append(
      this.runId,
      'limit',
      'browser',
      { reason },
      attempts.map((item) => item.id),
    );
    throw new ObservationUnsettled(reason);
  }
  private async captureOnce(): Promise<RecordEntry> {
    this.assertActive();
    const before = await this.observedState();
    const contextFingerprint = await this.page.locator('body').evaluate(async (body) => {
      // A nested form/wrapper can omit the product title or image. Use the whole original body.
      // Only its local fingerprint is retained, never additional raw context HTML.
      const html = body.outerHTML;
      if (!globalThis.crypto?.subtle) return undefined;
      const bytes = new TextEncoder().encode(html);
      try {
        const fingerprint = await crypto.subtle.digest('SHA-256', bytes);
        return [...new Uint8Array(fingerprint)]
          .map((byte) => byte.toString(16).padStart(2, '0'))
          .join('');
      } catch {
        // Optional grouping metadata cannot abort a useful observation.
        return undefined;
      }
    });
    const elements = [];
    const locators = this.page.locator(controls);
    const count = Math.min(await locators.count(), 60);
    for (let i = 0; i < count; i++) {
      const locator = locators.nth(i);
      if (!(await locator.isVisible().catch(() => false))) continue;
      const box = await locator.boundingBox();
      if (!box) continue;
      const { controlMarkup, controlInstance, ...info } = await locator.evaluate(
        (e, identityKey) => {
          let controlInstance: string | undefined;
          const identityEligible = e.tagName === 'BUTTON' && !!e.id;
          try {
            const identify = (globalThis as any)[identityKey];
            if (identityEligible && typeof identify === 'function') controlInstance = identify(e);
          } catch {
            // Missing optional identity only disables cross-screen grouping.
          }
          return {
            controlInstance,
            controlMarkup: identityEligible ? e.outerHTML : undefined,
            selector: (() => {
              const parts: string[] = [];
              let current: Element | null = e;
              while (current) {
                if (current.id) {
                  parts.unshift('#' + CSS.escape(current.id));
                  break;
                }
                const tag = current.tagName.toLowerCase();
                const siblings = current.parentElement
                  ? [...current.parentElement.children].filter(
                      (s) => s.tagName === current!.tagName,
                    )
                  : [current];
                parts.unshift(tag + ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')');
                current = current.parentElement;
              }
              return parts.join(' > ');
            })(),
            tag: e.tagName.toLowerCase(),
            text: (e.textContent ?? '').trim().slice(0, 200),
            type: e.getAttribute('type') ?? '',
            disabled: e.hasAttribute('disabled'),
          };
        },
        this.controlIdentityKey,
      );
      const aria = await locator.ariaSnapshot({ depth: 1 });
      const first = aria.split('\n')[0] ?? '';
      const role = first.match(/^- ([a-z]+)/)?.[1] ?? info.tag;
      const name = originalAriaName(aria);
      elements.push({
        ...info,
        // Only unnamed native buttons with their own ID need this extra bookkeeping.
        // Keep ordinary controls and model input size unchanged.
        ...(role === 'button' && name === '' && controlMarkup !== undefined
          ? { controlInstance, controlFingerprint: digest(controlMarkup) }
          : {}),
        contextFingerprint,
        id: `e${i}`,
        role,
        name,
        box,
      });
    }
    const image = await this.page.screenshot({ type: 'png', animations: 'disabled' });
    const visibleText = await this.page.locator('body').innerText();
    let identitiesStable = true;
    const identified = elements.filter((element) => element.controlFingerprint);
    // One immediate read: a removed control is a mismatch, never an awaited locator.
    const currentIdentities = identified.length
      ? await locators.evaluateAll(
          (targets, { indices, identityKey }) =>
            indices.map((index) => {
              const e = targets[index];
              if (!e) return null;
              let identity: string | undefined;
              try {
                const identify = (globalThis as any)[identityKey];
                if (typeof identify === 'function') identity = identify(e);
              } catch {
                // Optional metadata failures cannot abort an otherwise useful capture.
              }
              return { identity, markup: e.outerHTML };
            }),
          {
            indices: identified.map((element) => Number(element.id.slice(1))),
            identityKey: this.controlIdentityKey,
          },
        )
      : [];
    for (const [index, element] of identified.entries()) {
      const current = currentIdentities[index];
      if (!current || current.identity !== element.controlInstance) identitiesStable = false;
      else if (digest(current.markup) !== element.controlFingerprint)
        // Same actual control, but grouping cannot rely on the earlier markup.
        // Keep the otherwise stable observation and withhold optional identity only.
        element.controlInstance = undefined;
    }
    const state = await this.observedState();
    if (before.documentEpoch !== state.documentEpoch)
      throw Error('Document changed during observation');
    const asset = this.store.asset(this.runId, `capture_${randomUUID()}.png`, image);
    const payload: Capture & { focusHelp: RecordedFocusHelp[] } = {
      url: this.page.url(),
      title: await this.page.title(),
      imageFile: asset.file,
      imageHash: asset.hash,
      width: 1440,
      height: 900,
      elements,
      text: visibleText.slice(0, 16000),
      aria: state.aria,
      focus: state.focus,
      focusHelp: state.focusHelp,
      stateStamp: digest(JSON.stringify(state)),
      stable: identitiesStable && digest(JSON.stringify(before)) === digest(JSON.stringify(state)),
      limits: {
        ...(!identitiesStable ? { controlIdentityChanged: true } : {}),
        totalControls: await locators.count(),
        maximumListedControls: 60,
        visibleTextTruncated: visibleText.length > 16000,
        imageScope: 'viewport',
      },
      imageProvenance: {
        source: 'Browser-rendered page viewport',
        engineAddedAnnotations: false,
        focusOutline: 'Rendered page/browser styling, not an audit or test overlay',
        animations: 'Disabled for the saved screenshot',
      },
    };
    const original = this.store.append(this.runId, 'capture', 'browser', payload);
    this.lastOriginal = { id: original.id, url: payload.url, documentEpoch: state.documentEpoch };
    return original;
  }
  async verifyOriginalCapture(source: RecordEntry) {
    this.assertActive();
    if (
      !recordIsIntact(source) ||
      !this.store.record(this.runId, source.id) ||
      !recordIsIntact(this.store.record(this.runId, source.id)!) ||
      source.kind !== 'capture' ||
      source.runId !== this.runId ||
      this.store.record(this.runId, source.id)?.hash !== source.hash
    )
      throw Error('The action needs an original capture from this run.');
    if (source.payload.url !== this.page.url())
      throw new ActionStateChanged('Page changed; capture a fresh observation first.');
    if (source.payload.limits?.controlIdentityChanged)
      throw new ActionStateChanged(
        'A control changed or disappeared while this screen was captured; capture a fresh observation before acting.',
      );
    if (
      !source.payload.stable ||
      source.payload.stateStamp !== digest(JSON.stringify(await this.observedState()))
    )
      throw new ActionStateChanged(
        'Page state changed; capture a fresh observation before acting.',
      );
  }
  async act(action: Action, source: RecordEntry, expectedTarget?: () => Promise<boolean>) {
    await this.verifyOriginalCapture(source);
    if (action.kind === 'focus_target')
      throw Error('A target traversal must record its individual keyboard inputs.');
    const before = await this.focus();
    const urlBefore = this.page.url();
    const requestedAction = action;
    if (
      action.kind === 'press' &&
      ['Tab', 'Shift+Tab', 'Alt+Tab', 'Alt+Shift+Tab'].includes(action.key ?? '')
    ) {
      const backwards = action.key!.includes('Shift');
      action = {
        ...action,
        key:
          this.engine === 'webkit'
            ? backwards
              ? 'Alt+Shift+Tab'
              : 'Alt+Tab'
            : backwards
              ? 'Shift+Tab'
              : 'Tab',
      };
    }
    let outcome = 'performed';
    if (action.kind === 'press') {
      if (!action.key) throw Error('A keyboard action needs a permitted key.');
      if (['Enter', 'Space'].includes(action.key) && isCommitment(before.name + ' ' + before.text))
        throw Error('Stopped before a purchase, account or payment action.');
      if (
        ['Enter', 'Space'].includes(action.key) &&
        (before.tag === 'iframe' || before.paymentForm)
      )
        throw Error('The focused context cannot safely be activated in this demo.');
      if (
        action.key === 'Enter' &&
        before.hasForm &&
        before.tag === 'input' &&
        !['submit', 'button', 'reset', 'image'].includes(before.type)
      )
        throw Error(
          'Implicit form submission is outside the safe action boundary; use an explicitly checked control.',
        );
      if (
        ['Enter', 'Space'].includes(action.key) &&
        before.tag === 'input' &&
        ['submit', 'image'].includes(before.type) &&
        !before.name
      )
        throw Error('The submit input has no verified name; it cannot be activated safely.');
      if (expectedTarget && !(await expectedTarget()))
        throw new ActionStateChanged(
          'The original target changed before activation; no activation was sent.',
        );
      this.count();
      await this.page.keyboard.press(action.key === 'Space' ? 'Space' : action.key);
    } else if (action.kind === 'type') {
      if (before.type === 'password' || before.type === 'file')
        throw Error('Passwords and file inputs are outside this demo.');
      if (
        !action.text ||
        !(this.publicWebsite
          ? publicSearchInput(before, action.text)
          : ['test@example.org', 'Demo', 'Visitor', 'Demo Street', '12345'].includes(action.text))
      )
        throw Error(
          this.publicWebsite
            ? 'Only a short search term in an identified search field can be entered; patient, account and payment details are outside this run.'
            : 'Only the approved synthetic demonstration values may be entered.',
        );
      this.count();
      await this.page.keyboard.type(action.text);
    } else if (action.kind === 'scroll') {
      this.count();
      await this.page.mouse.wheel(0, action.direction === 'up' ? -600 : 600);
    } else if (action.kind === 'back') {
      this.count();
      await this.page.goBack({ waitUntil: 'domcontentloaded' });
    } else if (action.kind === 'wait') {
      if (
        action.waitMs !== undefined &&
        (!Number.isSafeInteger(action.waitMs) || action.waitMs < 800 || action.waitMs > 10000)
      )
        throw Error('A loading wait must remain between 800 and 10000 milliseconds.');
      this.count();
      await this.page.waitForTimeout(action.waitMs ?? 800);
    } else outcome = 'not a browser input';
    await this.page.waitForTimeout(180);
    let after: Awaited<ReturnType<BrowserWalk['focus']>> | null = null;
    let afterLimit: string | undefined;
    try {
      after = await this.focus();
    } catch (error) {
      afterLimit = safeError(error);
    }
    const record = this.store.append(
      this.runId,
      'action',
      'browser',
      {
        method: 'actual_keyboard_or_browser',
        sourceCaptureId: source.id,
        sourceImageHash: source.payload.imageHash,
        action,
        requestedAction,
        before,
        after,
        urlBefore,
        urlAfter: this.page.url(),
        outcome,
        waitAfterMs: 180,
        actionCount: this.actions,
      },
      [source.id],
    );
    if (afterLimit)
      this.store.append(
        this.runId,
        'limit',
        'browser',
        {
          reason:
            'The input was sent, but its immediate focus result could not be read. This is an observation limit, not evidence that the website action failed.',
          observationError: afterLimit,
        },
        [record.id],
      );
    return record;
  }
  async observationStamp() {
    this.assertActive();
    return readPage(this.page, async () => digest(JSON.stringify(await this.observedState())));
  }
  async measurements(source: RecordEntry) {
    this.assertActive();
    const original = this.store.record(this.runId, source.id);
    if (
      source.kind !== 'capture' ||
      source.runId !== this.runId ||
      !original ||
      original.hash !== source.hash ||
      !recordIsIntact(original) ||
      !recordIsIntact(source) ||
      typeof source.payload.stable !== 'boolean' ||
      typeof source.payload.stateStamp !== 'string'
    )
      throw Error('The measurement needs an original capture from this run.');
    if (source.payload.stable !== true) throw new MeasurementStateChanged(source.id, 'before');
    let stage: 'before' | 'during' = 'before';
    try {
      const before = await this.observationStamp();
      if (source.payload.stateStamp !== before)
        throw new MeasurementStateChanged(source.id, 'before');
      stage = 'during';
      const result = await new AxeBuilder({ page: this.page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
        .analyze();
      const facts = await collectBrowserFacts(this.page, source, result);
      const observation = this.store.append(
        this.runId,
        'observation',
        'axe-core',
        {
          method: 'automatic_accessibility_scan',
          sourceCaptureId: source.id,
          sourceCaptureHash: source.hash,
          sourceImageHash: source.payload.imageHash,
          stable:
            source.payload.stateStamp === before &&
            source.payload.stateStamp === (await this.observationStamp()),
          engine: result.testEngine,
          ...summarizeAxe(result),
          facts,
          limit:
            'This scan is not a keyboard or screen-reader test and does not certify the website.',
        },
        [source.id],
      );
      if (observation.payload.stable !== true)
        throw new MeasurementStateChanged(source.id, 'during', observation.id);
      return observation;
    } catch (error) {
      if (!documentWasReplaced(error) || this.page.isClosed()) throw error;
      this.assertActive();
      // Let the runner refresh its observation once; never retry this scan or its input.
      throw new MeasurementStateChanged(source.id, stage);
    }
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
    this.closingRequested = true;
    this.frames.close();
    if (!this.closing)
      this.closing = (async () => {
        const browser = this.browser ?? (await this.launching?.catch(() => undefined));
        try {
          await browser?.close();
        } finally {
          await this.publicProxy?.close();
        }
      })();
    await this.closing;
  }
}
