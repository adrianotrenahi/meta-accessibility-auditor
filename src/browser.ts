import { originalAriaName } from './aria-name.js';
import { webkit, chromium, type Browser, type ElementHandle, type Page } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { Store, digest, recordIsIntact } from './store.js';
import { LIMITS, type Capture, type RecordEntry } from './types.js';
import type { Action } from './models.js';
import { permittedUrl, isPublicAddress } from './network.js';
import { isIP } from 'node:net';
import { BrowserWindows } from './browser-windows.js';
import { randomUUID } from 'node:crypto';
import { LiveFrames } from './live-frame.js';
import { documentWasReplaced, readPage } from './page-observation.js';
import { readNavigationCapture } from './navigation-observation.js';
import { safeError } from './config.js';
import { collectBrowserFacts, summarizeAxe } from './evidence-checks.js';
import { installControlIdentity } from './control-identity.js';
import { publicBrowserProxy } from './public-network.js';
import { readRecordedFocusHelp, type RecordedFocusHelp } from './focus-help.js';
import {
  ariaDifference,
  contentSettled,
  openDialogs,
  pageStamp,
  sameForInput,
  sameForScan,
} from './page-state.js';
import {
  meaningfulScreenFingerprint,
  renderedScreenShape,
  installPointerState,
  type ScreenState,
} from './screen-state.js';
const controls =
  'button,a[href],input:not([type=hidden]),select,textarea,[role=button],[role=link],[role=checkbox],[role=combobox]';
export const isCommitment = (name: string) =>
  /\b(place|confirm|submit|complete)\s+(?:my\s+|your\s+|the\s+)?(order|purchase|booking|reservation)|\b(pay|subscribe|sign\s*up|register|sign\s*in|log\s*in|(?:buy|book)\s*now)\b|\b(confirmar|finalizar|completar|reservar)\s+(?:(?:la|mi|tu|el|su|una)\s+)?(?:cita|reserva|pedido|compra)\b|\b(pagar|registrarse|iniciar sesi[oó]n|crear cuenta)\b/i.test(
    name,
  );
/** An intact original no longer describes the page; this is an observation limit. */
/** Real websites often load a new document right after arrival: a robot check,
 * a consent or language redirect. The robot measures only after the page has gone
 * this long without loading a new document (owner, 30 Oct). */
/** Controls each screenshot lists for the navigator (owner, 31 Oct: up to 500, was 60). */
export const MAX_LISTED_CONTROLS = 500;
/** Accessible role/name readings sent to the browser side by side. */
const ARIA_READS_AT_ONCE = 25;
export const ARRIVAL_QUIET_MS = 2500;
/** After the journey's own steps, a shorter quiet moment; no wait when nothing loaded recently. */
export const RELOAD_QUIET_MS = 1000;
/** The wait never exceeds this; a page still reloading is then measured with retries. */
export const RELOAD_WAIT_MAX_MS = 10000;
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
    /\b(search|buscar|b[uú]squeda|especialidad|specialty|ciudad|city)\b/i.test(label) ||
    // Travel search fields: places and dates, never personal details (refused above).
    /\bwhere\s+(from|to)\b|\b(origin|destination|airport|departure|return|dates?|check.?in|check.?out|desde|hacia|origen|destino|aeropuerto|salida|llegada|ida|vuelta|fechas?)\b/i.test(
      label,
    )
  );
}
export class BrowserWalk {
  browser?: Browser;
  private closing?: Promise<void>;
  private launching?: Promise<Browser>;
  private closingRequested = false;
  private publicProxy?: Awaited<ReturnType<typeof publicBrowserProxy>>;
  private windows?: BrowserWindows;
  page!: Page;
  actions = 0;
  started = Date.now();
  readonly frames: LiveFrames;
  private lastOriginal?: { id: string; url: string; documentEpoch: number };
  /** When the current tab last loaded a new document (a reload, redirect or navigation). */
  private lastDocumentAt = 0;
  private lastScreenState?: { fingerprint: string; original: RecordEntry };
  private readonly controlIdentityKey = '__access_walk_control_' + randomUUID();
  private readonly pointerStateKey = '__access_walk_pointer_' + randomUUID();
  /** Page-side registry of the exact controls each original listed (no DOM change). */
  private readonly stampKey = '__access_walk_stamp_' + randomUUID();
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
    await installPointerState(context, this.pointerStateKey);
    // WebKit can report one document's timeOrigin 1 ms apart on later reads, which
    // looked like a new document. Read it once per document and keep that value.
    await context.addInitScript(() => {
      const origin = performance.timeOrigin;
      Object.defineProperty(performance, 'timeOrigin', { value: origin, configurable: false });
    });
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
        if (this.windows && !(await this.windows.allows(route.request())))
          throw Error('This window has no expected navigation from the current page.');
        await route.continue();
      } catch {
        await route.abort('blockedbyclient');
      }
    });
    this.page = await context.newPage();
    this.watchDocuments(this.page);
    this.windows = new BrowserWindows({
      context,
      current: () => this.page,
      active: () => this.assertActive(),
      viaPublicProxy: Boolean(this.publicProxy),
      permitted: async (raw) => {
        const url = new URL(raw);
        const host = url.hostname.replace(/^\[|\]$/g, '');
        if (
          !['http:', 'https:'].includes(url.protocol) ||
          url.username ||
          url.password ||
          (this.publicWebsite && isIP(host) && !isPublicAddress(host)) ||
          (!this.publicWebsite && ![controlledOrigin, approved.origin].includes(url.origin))
        )
          throw Error('The new-window destination is outside the public website boundary.');
        // The original context route and pinned public proxy still authorize
        // the actual request. Window selection adds no DNS or network path.
        return url;
      },
      adopted: (page) => {
        this.page = page;
        this.watchDocuments(page);
        this.lastOriginal = undefined;
      },
      record: (outcome, reason, sourceCaptureId) => {
        if (
          this.closingRequested ||
          !this.store.hasRun(this.runId) ||
          this.store.run(this.runId).state !== 'running'
        )
          return;
        const sources =
          sourceCaptureId && this.store.record(this.runId, sourceCaptureId)
            ? [sourceCaptureId]
            : [];
        this.store.append(
          this.runId,
          outcome === 'adopted' ? 'navigator_note' : 'limit',
          'browser',
          {
            method: 'browser_window',
            outcome,
            reason,
            ...(outcome === 'adopted' ? { kind: 'progress', text: reason } : {}),
            sourceCaptureId: sourceCaptureId ?? null,
          },
          sources,
        );
      },
    });
    this.count();
    await this.page.goto(approved.href, { waitUntil: 'domcontentloaded', timeout: 20000 });
    // Consent banners and popups usually arrive after the document itself.
    await this.page.waitForLoadState('load', { timeout: 8000 }).catch(() => undefined);
    await this.waitForReloadsToStop(this.publicWebsite ? ARRIVAL_QUIET_MS : RELOAD_QUIET_MS);
    await this.page.bringToFront();
    return this.capture();
  }
  private watchDocuments(page: Page) {
    this.lastDocumentAt = Date.now();
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame() && page === this.page) this.lastDocumentAt = Date.now();
    });
  }
  /** Waits until the page has gone `quietMs` without loading a new document, at most
   * `maxMs`; returns at once when nothing loaded recently. True when it went quiet. */
  async waitForReloadsToStop(quietMs = RELOAD_QUIET_MS, maxMs = RELOAD_WAIT_MAX_MS) {
    const deadline = Date.now() + maxMs;
    for (;;) {
      this.assertActive();
      const quietFor = Date.now() - this.lastDocumentAt;
      if (quietFor >= quietMs) break;
      if (Date.now() >= deadline) return false;
      await this.page.waitForTimeout(Math.min(quietMs - quietFor, deadline - Date.now()));
    }
    await this.page
      .waitForLoadState('domcontentloaded', { timeout: Math.max(1000, deadline - Date.now()) })
      .catch(() => undefined);
    return true;
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
      dialogs: await openDialogs(this.page),
    };
  }
  private async meaningfulObservation(state: Awaited<ReturnType<BrowserWalk['observedState']>>) {
    return {
      ...state,
      title: await this.page.title(),
      screenShape: await renderedScreenShape(this.page, this.pointerStateKey),
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
      if (current.payload.stable === true && current.payload.contentDrift?.settled !== false)
        return current;
      if (attempt < 2) {
        await this.page.waitForTimeout(400);
        current = await this.capture();
      }
    }
    // Same page, focus and popups, but its copy kept changing (a live ticker, a
    // carousel). The latest original is used; nothing is inferred from the drift.
    if (current.payload.stable === true) {
      this.store.append(
        this.runId,
        'limit',
        'browser',
        {
          method: 'content_still_changing',
          reason:
            'Page text kept changing across three observations while address, focus and popups stayed the same. The latest original is used.',
        },
        attempts.map((item) => item.id),
      );
      return current;
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
    const screenBefore = await this.meaningfulObservation(before);
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
    // Real sites put many hidden menu links before their search form. Choose the first
    // MAX_LISTED_CONTROLS visible controls, those on screen first; ids keep the page position.
    const stampToken = randomUUID();
    const listed = await locators.evaluateAll(
      (targets, { key, token, limit }) => {
        const onScreen: number[] = [];
        const offScreen: number[] = [];
        targets.forEach((target, index) => {
          const box = target.getBoundingClientRect();
          const style = getComputedStyle(target);
          if (
            !box.width ||
            !box.height ||
            style.visibility === 'hidden' ||
            style.display === 'none'
          )
            return;
          const shown =
            box.bottom > 0 && box.top < innerHeight && box.right > 0 && box.left < innerWidth;
          (shown ? onScreen : offScreen).push(index);
        });
        const chosen = [...onScreen, ...offScreen].slice(0, limit).sort((a, b) => a - b);
        // Each original keeps live references to the exact controls it listed, so a
        // decision naming e69 reaches that element even when its name is repeated.
        const registry: Map<string, Map<string, Element>> = ((globalThis as any)[key] ??=
          new Map());
        registry.set(token, new Map(chosen.map((index) => ['e' + index, targets[index]!])));
        for (const old of [...registry.keys()].slice(0, -8)) registry.delete(old);
        return chosen;
      },
      { key: this.stampKey, token: stampToken, limit: MAX_LISTED_CONTROLS },
    );
    // One read for every listed control (owner, 31 Oct: up to 500 controls without slower
    // screenshots). Only the accessible role and name need Playwright's own reading; those
    // run side by side instead of one control at a time.
    const details = await locators.evaluateAll(
      (targets, { indices, identityKey }) =>
        indices.map((index) => {
          const e = targets[index]!;
          const rect = e.getBoundingClientRect();
          const style = getComputedStyle(e);
          if (!rect.width || !rect.height || style.visibility === 'hidden') return null;
          let controlInstance: string | undefined;
          const identityEligible = e.tagName === 'BUTTON' && !!e.id;
          try {
            const identify = (globalThis as any)[identityKey];
            if (identityEligible && typeof identify === 'function') controlInstance = identify(e);
          } catch {
            // Missing optional identity only disables cross-screen grouping.
          }
          const parts: string[] = [];
          let current: Element | null = e;
          while (current) {
            if (current.id) {
              parts.unshift('#' + CSS.escape(current.id));
              break;
            }
            const tag = current.tagName.toLowerCase();
            const siblings = current.parentElement
              ? [...current.parentElement.children].filter((s) => s.tagName === current!.tagName)
              : [current];
            parts.unshift(tag + ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')');
            current = current.parentElement;
          }
          return {
            box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            controlInstance,
            controlMarkup: identityEligible ? e.outerHTML : undefined,
            info: {
              selector: parts.join(' > '),
              tag: e.tagName.toLowerCase(),
              text: (e.textContent ?? '').trim().slice(0, 200),
              type: e.getAttribute('type') ?? '',
              disabled: e.hasAttribute('disabled'),
            },
          };
        }),
      { indices: listed, identityKey: this.controlIdentityKey },
    );
    const arias: string[] = [];
    for (let from = 0; from < listed.length; from += ARIA_READS_AT_ONCE)
      arias.push(
        ...(await Promise.all(
          listed
            .slice(from, from + ARIA_READS_AT_ONCE)
            .map((i) => locators.nth(i).ariaSnapshot({ depth: 1 })),
        )),
      );
    for (const [position, i] of listed.entries()) {
      const detail = details[position];
      if (!detail) continue;
      const { box, controlMarkup, controlInstance, info } = detail;
      const aria = arias[position]!;
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
    const screenAfter = await this.meaningfulObservation(state);
    if (before.documentEpoch !== state.documentEpoch)
      throw Error('Document changed during observation');
    const asset = this.store.asset(this.runId, `capture_${randomUUID()}.png`, image);
    // A rotating promotion is not an unsettled page; a popup, scroll or focus change is.
    const contentDrift =
      before.aria === state.aria ? 0 : ariaDifference(before.aria, state.aria).length;
    const stable =
      identitiesStable && sameForInput({ ...before, pageStamp: pageStamp(before) }, state);
    const settled = contentSettled(before.aria, state.aria);
    const beforeFingerprint = meaningfulScreenFingerprint(screenBefore);
    const fingerprint =
      stable && beforeFingerprint && beforeFingerprint === meaningfulScreenFingerprint(screenAfter)
        ? beforeFingerprint
        : undefined;
    const primary =
      fingerprint && this.lastScreenState?.fingerprint === fingerprint
        ? this.lastScreenState.original
        : undefined;
    const screenState: ScreenState | undefined = fingerprint
      ? primary
        ? {
            version: 'meaningful-screen/1',
            purpose: 'same-state-evidence',
            fingerprint,
            primaryCaptureId: primary.id,
            primaryCaptureHash: primary.hash,
          }
        : { version: 'meaningful-screen/1', purpose: 'screen', fingerprint }
      : undefined;
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
      dialogs: state.dialogs,
      stateStamp: digest(JSON.stringify(state)),
      pageStamp: pageStamp(state),
      stable,
      ...(contentDrift ? { contentDrift: { changedLines: contentDrift, settled } } : {}),
      stampToken,
      ...(screenState ? { screenState } : {}),
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
    this.lastScreenState = fingerprint ? { fingerprint, original: primary ?? original } : undefined;
    return original;
  }
  /** The exact element an original listed as `id`, while it is still on the page.
   * Read from a page-side registry; nothing is added to the page itself. */
  async listedControl(
    source: RecordEntry,
    id: string,
  ): Promise<ElementHandle<HTMLElement | SVGElement> | null> {
    if (typeof source.payload.stampToken !== 'string' || !/^e\d+$/.test(id)) return null;
    const found = await this.page.evaluateHandle(
      ({ key, token, id }) => {
        const element = (globalThis as any)[key]?.get(token)?.get(id) as Element | undefined;
        return element?.isConnected ? element : null;
      },
      { key: this.stampKey, token: source.payload.stampToken, id },
    );
    const element = found.asElement();
    if (!element) await found.dispose();
    return element as ElementHandle<HTMLElement | SVGElement> | null;
  }
  /** Ordinary Tab movement gets original focus facts, not another screenshot.
   * A changed/uncertain rendered state still takes the ordinary full image. */
  async observeKeyboardMovement(source: RecordEntry, performed: RecordEntry): Promise<RecordEntry> {
    this.assertActive();
    if (
      source.runId !== this.runId ||
      !recordIsIntact(source) ||
      this.store.record(this.runId, source.id)?.hash !== source.hash ||
      source.payload.stable !== true ||
      !(
        source.kind === 'capture' ||
        (source.kind === 'observation' && source.payload.method === 'keyboard_focus/1')
      ) ||
      performed.runId !== this.runId ||
      performed.kind !== 'action' ||
      !recordIsIntact(performed) ||
      this.store.record(this.runId, performed.id)?.hash !== performed.hash ||
      performed.payload.outcome !== 'performed' ||
      performed.payload.action?.kind !== 'press' ||
      !['Tab', 'Shift+Tab', 'Alt+Tab', 'Alt+Shift+Tab'].includes(performed.payload.action.key) ||
      performed.sources.length !== 1 ||
      performed.sources[0] !== source.id ||
      source.seq >= performed.seq
    )
      throw Error('A lightweight focus observation needs its exact performed Tab.');
    const originalId = source.kind === 'capture' ? source.id : source.payload.sourceCaptureId;
    const original = this.store.record(this.runId, originalId);
    if (!original || original.kind !== 'capture' || !recordIsIntact(original))
      throw Error('The lightweight focus observation lost its original screen.');
    const state = await readPage(this.page, () => this.observedState());
    const fingerprint = meaningfulScreenFingerprint(await this.meaningfulObservation(state));
    const previous =
      source.kind === 'capture'
        ? source.payload.screenState?.fingerprint
        : source.payload.screenStateFingerprint;
    // A complete rendered fingerprint keeps the final say: any visible change after
    // the key takes a real original. Most commercial pages animate something, so
    // that fingerprint is often unavailable; then the original's document, address,
    // scroll and dialogs must match, and the accessibility snapshot may differ only
    // within the bounded drift (page-state/1, owner decision 29 October). A larger
    // change takes a real original; the drift that remains is recorded below.
    const sameScreen = !!fingerprint && !!previous && fingerprint === previous;
    const samePage =
      (!fingerprint || !previous) &&
      typeof original.payload.pageStamp === 'string' &&
      original.payload.pageStamp === pageStamp(state) &&
      contentSettled(original.payload.aria, state.aria);
    if (
      !(sameScreen || samePage) ||
      digest(JSON.stringify(state.focus)) !== digest(JSON.stringify(performed.payload.after))
    )
      return this.captureSettled();
    const after = await readPage(this.page, () => this.observedState());
    const afterShape = await this.meaningfulObservation(after);
    if (
      digest(JSON.stringify(state)) !== digest(JSON.stringify(after)) ||
      (sameScreen
        ? meaningfulScreenFingerprint(afterShape) !== fingerprint
        : !contentSettled(original.payload.aria, after.aria))
    )
      return this.captureSettled();
    return this.store.append(
      this.runId,
      'observation',
      'browser',
      {
        method: 'keyboard_focus/1',
        stable: true,
        sourceCaptureId: original.id,
        sourceCaptureHash: original.hash,
        sourceImageHash: original.payload.imageHash,
        // This original image predates the newly recorded focus. It is not a picture of it.
        imageScope: 'earlier-screen-original; current-focus-is-recorded-facts-only',
        url: after.url,
        aria: after.aria,
        focus: after.focus,
        focusAppearance: afterShape.screenShape.focusAppearance,
        focusHelp: after.focusHelp,
        stateStamp: digest(JSON.stringify(after)),
        ...(sameScreen
          ? { screenStateFingerprint: fingerprint }
          : {
              pageStamp: pageStamp(after),
              comparison: 'page-state-and-bounded-content-drift',
              ...(after.aria !== original.payload.aria
                ? {
                    contentDrift: {
                      changedLines: ariaDifference(original.payload.aria, after.aria).length,
                    },
                  }
                : {}),
            }),
      },
      [source.id, performed.id],
    );
  }
  private async verifyKeyboardObservation(source: RecordEntry) {
    this.assertActive();
    const original = this.store.record(this.runId, source.payload.sourceCaptureId);
    if (
      source.kind !== 'observation' ||
      source.author !== 'browser' ||
      source.payload.method !== 'keyboard_focus/1' ||
      source.payload.stable !== true ||
      source.runId !== this.runId ||
      !recordIsIntact(source) ||
      this.store.record(this.runId, source.id)?.hash !== source.hash ||
      !original ||
      original.kind !== 'capture' ||
      !recordIsIntact(original) ||
      original.payload.stable !== true ||
      original.seq >= source.seq ||
      original.hash !== source.payload.sourceCaptureHash ||
      original.payload.imageHash !== source.payload.sourceImageHash ||
      (typeof source.payload.screenStateFingerprint === 'string'
        ? original.payload.screenState?.fingerprint !== source.payload.screenStateFingerprint
        : typeof source.payload.pageStamp !== 'string' ||
          original.payload.pageStamp !== source.payload.pageStamp)
    )
      throw Error('Keyboard input needs an intact focus observation and original screen.');
    const state = await this.observedState();
    if (
      typeof source.payload.screenStateFingerprint === 'string'
        ? source.payload.stateStamp !== digest(JSON.stringify(state)) ||
          source.payload.screenStateFingerprint !==
            meaningfulScreenFingerprint(await this.meaningfulObservation(state))
        : !sameForInput(source.payload, state)
    )
      throw new ActionStateChanged('The recorded focus changed before input; refresh first.');
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
    if (!source.payload.stable || !sameForInput(source.payload, await this.observedState()))
      throw new ActionStateChanged(
        'Page state changed; capture a fresh observation before acting.',
      );
  }
  /** Completing an instruction claims what its original shows, so a page whose
   * content was replaced since (same address, scroll, popups and focus) refuses it.
   * A page already known to keep changing is not refused for that drift alone. */
  async verifyCompletionCapture(source: RecordEntry) {
    await this.verifyOriginalCapture(source);
    if (source.payload.contentDrift?.settled === false) return;
    const state = await this.observedState();
    if (!contentSettled(source.payload.aria, state.aria))
      throw new ActionStateChanged('The page content changed; capture a fresh observation first.');
  }
  async act(action: Action, source: RecordEntry, expectedTarget?: () => Promise<boolean>) {
    if (source.kind === 'observation' && source.payload.method === 'keyboard_focus/1') {
      if (
        action.kind !== 'press' ||
        !['Tab', 'Shift+Tab', 'Alt+Tab', 'Alt+Shift+Tab'].includes(action.key ?? '')
      )
        throw Error('A fresh screenshot is required before activation or another action.');
      await this.verifyKeyboardObservation(source);
    } else await this.verifyOriginalCapture(source);
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
      const preparedWindow =
        before.tag === 'a' && before.href && ['Enter', 'Space'].includes(action.key)
          ? await this.windows?.prepare(this.page, action.key, source.id)
          : undefined;
      try {
        if (preparedWindow) {
          await this.verifyOriginalCapture(source);
          if (
            !(await preparedWindow.stillFocused()) ||
            (expectedTarget && !(await expectedTarget()))
          )
            throw new ActionStateChanged(
              'The original new-window control changed; no activation was sent.',
            );
        }
        this.count();
        const pendingWindow = preparedWindow?.arm();
        try {
          await this.page.keyboard.press(action.key === 'Space' ? 'Space' : action.key);
          await pendingWindow?.wait();
        } finally {
          pendingWindow?.cancel();
        }
      } finally {
        await preparedWindow?.dispose().catch(() => {});
      }
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
        sourceCaptureId: source.kind === 'capture' ? source.id : source.payload.sourceCaptureId,
        sourceImageHash:
          source.kind === 'capture' ? source.payload.imageHash : source.payload.sourceImageHash,
        ...(source.kind === 'observation' ? { sourceObservationId: source.id } : {}),
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
  /** The page facts a scan is compared on when its exact state stamp no longer matches. */
  async scanState() {
    this.assertActive();
    return readPage(this.page, () => this.observedState());
  }
  /**
   * Most commercial pages rotate copy while a scan runs, so an exact stamp rarely
   * holds there. A page-state/1 original still counts when the same document,
   * address, scroll and popups remain and the copy differs only within the bounded
   * drift; the larger differing set is kept in `drift` and saved with the scan.
   */
  private async scanStillMatches(source: RecordEntry, drift: { lines: string[] }) {
    if (typeof source.payload.pageStamp !== 'string') return false;
    const changed = sameForScan(source.payload, await this.scanState());
    if (!changed) return false;
    // Keep the larger of the before/after differences, counted like the drift bound.
    if (changed.length > drift.lines.length) drift.lines = changed;
    return true;
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
      const drift = { lines: [] as string[] };
      const before = await this.observationStamp();
      if (source.payload.stateStamp !== before && !(await this.scanStillMatches(source, drift)))
        throw new MeasurementStateChanged(source.id, 'before');
      stage = 'during';
      const result = await new AxeBuilder({ page: this.page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
        .analyze();
      // Measurements bind to the exact controls this original listed, never by position
      // alone: a slider inserting or reordering buttons must not move a size to another id.
      const facts = await collectBrowserFacts(
        this.page,
        source,
        result,
        typeof source.payload.stampToken === 'string'
          ? { key: this.stampKey, token: source.payload.stampToken }
          : undefined,
      );
      const exact =
        source.payload.stateStamp === before &&
        source.payload.stateStamp === (await this.observationStamp());
      const stable = exact || (await this.scanStillMatches(source, drift));
      const observation = this.store.append(
        this.runId,
        'observation',
        'axe-core',
        {
          method: 'automatic_accessibility_scan',
          sourceCaptureId: source.id,
          sourceCaptureHash: source.hash,
          sourceImageHash: source.payload.imageHash,
          stable,
          // The scan read the live page, so copy that differed from the original's
          // snapshot is named here; the screenshot may not show those lines.
          ...(stable && !exact
            ? {
                comparison: 'page-state-and-bounded-content-drift',
                contentDrift: {
                  changedLines: drift.lines.length,
                  lines: drift.lines.slice(0, 40).map((line) => line.slice(0, 200)),
                  linesTruncated: drift.lines.length > 40,
                },
              }
            : {}),
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
        await this.windows?.close();
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
