import { randomUUID } from 'node:crypto';
import type { BrowserWalk } from './browser.js';
import { ActionStateChanged } from './browser.js';
import type { Store } from './store.js';
import type { RecordEntry } from './types.js';

/**
 * Consent banners and promotional popups block every real journey before it
 * starts. Clearing them needs no model decision, and how a keyboard user gets
 * through them is itself evidence: whether Tab reaches the banner, whether
 * Escape closes a popup. Every key goes through the ordinary recorded walk.
 */
export const BLOCKER_LIMITS = { rounds: 3, tabs: 20, lateMs: 3000, afterDismissMs: 2000 } as const;

// Independent label lists. Refusal is always preferred; acceptance only when the
// banner offers no one-click refusal (the owner's brief: reject "where available").
export const ACCEPT_WHEN_NO_REFUSAL = true;
const rejectLabel =
  /\b(reject|decline|refuse|deny|disagree)\b|\b(only|just)\s+(essential|necessary|required)\b|\b(essential|necessary|required)(\s+cookies)?\s+only\b|continue\s+without\s+(accepting|agreeing)|rechaz|denegar|no\s+acepto|s[oó]lo\s+(las\s+)?(necesarias|esenciales|imprescindibles)|continuar\s+sin\s+aceptar|ablehnen|refuser|rifiut/i;
const acceptLabel =
  /^\s*((yes|s[ií]),?\s+)?(i\s+)?(acepto|aceptar|accept|agree|allow|permitir|de\s+acuerdo|entendido|got\s+it|ok)\b/i;
const closeLabel =
  /^\s*(close|dismiss|no,?\s*thanks|not\s+now|maybe\s+later|skip|cerrar|ahora\s+no|no,?\s*gracias|omitir|ignorar|x)\b|^\s*[×✕]|\b(close|cerrar|dismiss|ignorar)\s+(dialog|di[aá]logo|popup|ventana|modal|banner)|ignorar informaci[oó]n/i;

export interface BlockerFound {
  kind: 'consent' | 'dialog';
  name: string;
  control: { role: string; name: string } | null;
  choice: 'refuse' | 'accept_only_offered' | 'close' | null;
}

/** Finds one blocker and keeps its live element references under a private page key. */
async function locateBlocker(
  walk: BrowserWalk,
  key: string,
  popups: boolean,
): Promise<BlockerFound | null> {
  // TypeScript tooling may wrap named in-page helpers with __name; the page has no such helper.
  await walk.page.evaluate('globalThis.__name ??= (target) => target');
  return walk.page.evaluate(
    ({ key, reject, accept, close, popups }) => {
      const rejectRe = new RegExp(reject, 'i');
      const acceptRe = accept ? new RegExp(accept, 'i') : null;
      const closeRe = new RegExp(close, 'i');
      const visible = (element: Element) => {
        const box = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return (
          box.width > 0 &&
          box.height > 0 &&
          style.visibility !== 'hidden' &&
          style.display !== 'none' &&
          style.opacity !== '0'
        );
      };
      const label = (element: Element) =>
        (
          element.getAttribute('aria-label') ||
          (element as HTMLElement).innerText ||
          element.getAttribute('title') ||
          ''
        )
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 120);
      const controls = (container: Element) =>
        [
          ...container.querySelectorAll(
            'button,a[href],[role=button],input[type=button],input[type=submit]',
          ),
        ].filter(visible);
      const remember = (
        kind: 'consent' | 'dialog',
        container: Element,
        control: Element | undefined,
        choice: 'refuse' | 'accept_only_offered' | 'close' | null,
      ) => {
        (globalThis as any)[key] = { container, control };
        return {
          kind,
          name: (
            container.getAttribute('aria-label') ||
            container.querySelector('h1,h2,h3')?.textContent ||
            container.id ||
            ''
          )
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 120),
          control: control
            ? {
                role: control.getAttribute('role') ?? control.tagName.toLowerCase(),
                name: label(control),
              }
            : null,
          choice: control ? choice : null,
        };
      };
      const consentLike = (element: Element) =>
        /cookie|consent|didomi|onetrust|cookiebot|usercentrics|cmp/i.test(
          element.id + ' ' + String((element as HTMLElement).className),
        ) || /cookie|consent|consentimiento/i.test((element as HTMLElement).innerText ?? '');
      const vendor = [
        '#onetrust-banner-sdk',
        '#didomi-host',
        '#CybotCookiebotDialog',
        '.qc-cmp2-container',
        '#cookie-banner',
        '#cookieConsent',
        '[aria-label*=cookie i]',
        '[id*=cookie i][role=dialog]',
      ];
      const dialogs = [
        ...document.querySelectorAll(
          '[role=dialog],[role=alertdialog],dialog[open],[aria-modal=true]',
        ),
      ].filter(visible);
      // A popup on top traps focus, so it is cleared before any consent banner below it.
      for (const dialog of popups ? dialogs : []) {
        if (consentLike(dialog)) continue;
        const control = controls(dialog).find((item) => closeRe.test(label(item)));
        return remember('dialog', dialog, control, 'close');
      }
      const candidates = [
        ...vendor.flatMap((selector) => [...document.querySelectorAll(selector)]),
        // Only popups that read as consent: mid-journey, an "Add insurance? Decline"
        // popup is the navigator's choice, never a cookie banner to refuse.
        ...dialogs.filter(consentLike),
        ...[...document.querySelectorAll('div,section,aside,form')].filter((element) => {
          const position = getComputedStyle(element).position;
          return (position === 'fixed' || position === 'sticky') && consentLike(element);
        }),
      ].filter(visible);
      for (const container of candidates) {
        const control = controls(container).find((item) => rejectRe.test(label(item)));
        if (control) return remember('consent', container, control, 'refuse');
      }
      for (const container of acceptRe ? candidates.filter(consentLike) : []) {
        const control = controls(container).find((item) => acceptRe!.test(label(item)));
        if (control) return remember('consent', container, control, 'accept_only_offered');
      }
      const unanswered = candidates.find(consentLike);
      return unanswered ? remember('consent', unanswered, undefined, null) : null;
    },
    {
      key,
      popups,
      reject: rejectLabel.source,
      accept: ACCEPT_WHEN_NO_REFUSAL ? acceptLabel.source : null,
      close: closeLabel.source,
    },
  );
}

async function stillOpen(walk: BrowserWalk, key: string) {
  return walk.page
    .evaluate((key) => {
      const found = (globalThis as any)[key];
      const element: Element | undefined = found?.container;
      if (!element?.isConnected) return false;
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return (
        box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
      );
    }, key)
    .catch(() => false);
}

async function focusIs(walk: BrowserWalk, key: string) {
  return walk.page.evaluate((key) => {
    let active = document.activeElement;
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
    const found = (globalThis as any)[key];
    return {
      control: !!found?.control && active === found.control,
      inside: !!found?.container && !!active && found.container.contains(active),
    };
  }, key);
}

/**
 * Clears consent banners and popups that cover the page. Returns the newest
 * original; never activates acceptance, sign-in or anything but refusal/close.
 */
export async function clearPageBlockers(
  walk: BrowserWalk,
  store: Store,
  runId: string,
  start: RecordEntry,
  signal: AbortSignal,
  // At arrival, popups are promotions; later a popup may be the journey's own
  // date picker or menu, so mid-journey clearing handles consent banners only.
  { arrival }: { arrival: boolean },
): Promise<RecordEntry> {
  const key = '__access_walk_blocker_' + randomUUID();
  let current = start;
  let dismissed = false;
  const capture = async () =>
    current.kind === 'capture' ? current : (current = await walk.captureSettled());
  const note = (payload: Record<string, unknown>) =>
    store.append(runId, 'observation', 'browser', { method: 'page_blocker/1', ...payload }, [
      (current.kind === 'capture' ? current.id : current.payload.sourceCaptureId) as string,
    ]);
  const press = async (input: 'Tab' | 'Enter' | 'Escape', expected?: () => Promise<boolean>) => {
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      const source = input === 'Tab' ? current : await capture();
      let performed: RecordEntry;
      try {
        performed = await walk.act(
          { kind: 'press', key: input, note: 'Clear page blocker' },
          source,
          expected,
        );
      } catch (error) {
        // Nothing was sent. A banner still sliding in gets one fresh original, never a stale key.
        if (!(error instanceof ActionStateChanged) || attempt > 0) throw error;
        current = await walk.captureSettled();
        continue;
      }
      current =
        input === 'Tab' && performed.payload.after
          ? await walk.observeKeyboardMovement(source, performed)
          : await walk.captureSettled();
      return performed;
    }
  };
  try {
    for (let round = 0; round < BLOCKER_LIMITS.rounds; round++) {
      let blocker = await locateBlocker(walk, key, arrival);
      // Late banners: look again briefly; a banner found this way needs a fresh original.
      for (let waited = 0; !blocker && arrival && round === 0 && waited < BLOCKER_LIMITS.lateMs;) {
        await walk.page.waitForTimeout(500);
        waited += 500;
        blocker = await locateBlocker(walk, key, arrival);
        if (blocker) current = await walk.captureSettled();
      }
      if (!blocker) break;
      if (blocker.kind === 'dialog') {
        // Escape is the first thing a keyboard or screen-reader user tries.
        await press('Escape');
        const closed = !(await stillOpen(walk, key));
        note({ blocker: 'dialog', name: blocker.name, test: 'escape', closed });
        if (closed) continue;
      }
      if (!blocker.control) {
        note({
          blocker: blocker.kind,
          name: blocker.name,
          outcome: 'left_for_navigator',
          reason:
            blocker.kind === 'consent'
              ? 'Neither a refusal nor an acceptance control was identified.'
              : 'Escape did not close this popup and no close control was identified.',
        });
        break;
      }
      // Real keyboard path first: does Tab reach the control at all?
      let tabs = 0;
      let reached = await focusIs(walk, key);
      let enteredAfter = reached.inside ? 0 : null;
      while (!reached.control && tabs < BLOCKER_LIMITS.tabs) {
        await press('Tab');
        tabs++;
        reached = await focusIs(walk, key);
        if (reached.inside && enteredAfter === null) enteredAfter = tabs;
      }
      note({
        blocker: blocker.kind,
        name: blocker.name,
        control: blocker.control,
        choice: blocker.choice,
        test: 'tab_reach',
        tabsPressed: tabs,
        maximumTabs: BLOCKER_LIMITS.tabs,
        reachedContainerAfterTabs: enteredAfter,
        reachedControl: reached.control,
      });
      if (!reached.control) {
        // Not a keyboard path: recorded as a robot limit so no keyboard claim relies on it.
        await walk.page.evaluate((key) => (globalThis as any)[key]?.control?.focus(), key);
        current = await walk.captureSettled();
        store.append(
          runId,
          'limit',
          'browser',
          {
            method: 'page_blocker/1',
            reason: `The ${blocker.kind === 'consent' ? 'cookie banner' : 'popup'} control "${blocker.control.name}" was not reached in ${tabs} Tab presses. The robot moved focus to it directly to continue; that move is not a keyboard path.`,
          },
          [current.id],
        );
      }
      await press('Enter', async () => (await focusIs(walk, key)).control);
      const cleared = !(await stillOpen(walk, key));
      note({ blocker: blocker.kind, name: blocker.name, test: 'activate', cleared });
      if (!cleared) break;
      dismissed = true;
    }
    if (dismissed) {
      // Some sites reload after a consent choice (Booking adds a challenge marker to the
      // address). The navigator's first decision must not read a page that is about to go.
      await walk.page.waitForTimeout(BLOCKER_LIMITS.afterDismissMs);
      await walk.page.waitForLoadState('load', { timeout: 8000 }).catch(() => undefined);
      current = await walk.captureSettled();
    }
  } catch (error) {
    // A moving page or a refused key ends clearing; the navigator continues from a fresh original.
    if (
      !(error instanceof ActionStateChanged) &&
      !(error instanceof Error && /Stopped before|cannot safely/.test(error.message))
    )
      throw error;
    store.append(runId, 'limit', 'browser', {
      method: 'page_blocker/1',
      reason:
        'Clearing a cookie banner or popup stopped early; the navigator continues from a fresh screen.',
    });
    current = await walk.captureSettled();
  } finally {
    await walk.page.evaluate((key) => delete (globalThis as any)[key], key).catch(() => undefined);
  }
  return capture();
}
