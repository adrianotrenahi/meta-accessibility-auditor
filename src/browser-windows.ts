import type { BrowserContext, ElementHandle, Page, Request } from 'playwright';

export const WINDOW_ARRIVAL_MS = 1500;
const addressKey = (raw: string) => {
  const url = new URL(raw);
  url.hash = '';
  return url.href;
};
type PendingWindow = {
  source: Page;
  sourceCaptureId: string;
  destination: string;
  allowedAddresses: Set<string>;
  expires: number;
  candidate?: Page;
  finish: () => void;
  promise: Promise<void>;
  timer: ReturnType<typeof setTimeout>;
  keyObserved: () => Promise<boolean>;
};

/** A declared link destination grants one short, source-bound window handoff.
 * It never turns arbitrary page scripts or blank measurement pages into navigation.
 */
export class BrowserWindows {
  private pending?: PendingWindow;
  private closed = false;
  private hooked = new WeakSet<Page>();
  private checking = new Set<Page>();
  private refused = new WeakSet<Page>();
  private tasks = new Set<Promise<void>>();
  constructor(
    private kit: {
      context: BrowserContext;
      current: () => Page;
      active: () => void;
      permitted: (raw: string) => Promise<URL>;
      adopted: (page: Page) => void;
      record: (
        outcome: 'adopted' | 'refused' | 'unobserved',
        reason: string,
        sourceCaptureId?: string,
      ) => void;
    },
  ) {
    this.hook(kit.current());
    kit.context.on('page', (page) => {
      this.hook(page);
      // Context-created blank pages can belong to an automatic measurement.
      // They are never adopted. Any real navigation still uses the route guard.
      setTimeout(() => {
        if (
          page !== this.kit.current() &&
          !this.checking.has(page) &&
          page !== this.pending?.candidate &&
          page.url() !== 'about:blank' &&
          !page.isClosed()
        )
          void this.refuse(page, 'A new window had no verified navigation from the current page.');
      }, 0);
    });
  }
  private active() {
    if (this.closed) return false;
    try {
      this.kit.active();
      return true;
    } catch {
      return false;
    }
  }
  private isCurrent(pending: PendingWindow) {
    return (
      this.pending === pending &&
      this.active() &&
      pending.source === this.kit.current() &&
      Date.now() <= pending.expires
    );
  }
  private hook(page: Page) {
    if (this.hooked.has(page)) return;
    this.hooked.add(page);
    page.setDefaultTimeout(8000);
    page.on('dialog', (dialog) => {
      void dialog.dismiss().catch(() => {});
    });
    page.on('popup', (popup) => {
      this.checking.add(popup);
      const task = this.child(page, popup)
        .catch(() =>
          this.refuse(popup, 'The new window could not be verified; no handoff was inferred.'),
        )
        .finally(() => this.checking.delete(popup));
      this.tasks.add(task);
      void task.finally(() => this.tasks.delete(task)).catch(() => {});
    });
    if (this.closed) void page.close().catch(() => {});
  }
  private async refuse(page: Page, reason: string) {
    if (this.active() && !this.refused.has(page))
      this.kit.record('refused', reason, this.pending?.sourceCaptureId);
    this.refused.add(page);
    await page.close().catch(() => {});
  }
  async prepare(source: Page, key: string, sourceCaptureId: string) {
    if (!['Enter', 'Space'].includes(key) || !this.active()) return undefined;
    const active = await source.evaluateHandle(() => document.activeElement);
    const control = active.asElement() as ElementHandle<HTMLElement> | null;
    if (!control) {
      await active.dispose();
      return undefined;
    }
    try {
      const declared = await control.evaluate((element) => {
        if (!(element instanceof HTMLAnchorElement) || element.target.toLowerCase() !== '_blank')
          return null;
        return {
          href: element.href,
          connected: element.isConnected && document.activeElement === element,
        };
      });
      if (!declared?.connected || !declared.href) {
        await control.dispose();
        return undefined;
      }
      let destination: URL;
      try {
        destination = await this.kit.permitted(declared.href);
      } catch {
        this.kit.record(
          'refused',
          'The declared new-window destination is outside the permitted website boundary. No activation was sent.',
          sourceCaptureId,
        );
        throw Error(
          'The declared new-window destination is not permitted; no activation was sent.',
        );
      }
      // This closure is held only by a remote handle. No DOM attribute or
      // page-global state is added, and a script-dispatched key is insufficient.
      const receipt = await control.evaluateHandle(
        (element, expectedKey) => {
          const watcher = {
            seen: false,
            handleEvent(event: KeyboardEvent) {
              if (
                event.isTrusted &&
                event.key === expectedKey &&
                event.target === element &&
                document.activeElement === element
              )
                watcher.seen = true;
            },
            remove() {
              element.removeEventListener('keydown', watcher, true);
            },
          };
          element.addEventListener('keydown', watcher, true);
          return watcher;
        },
        key === 'Space' ? ' ' : 'Enter',
      );
      const keyObserved = () => receipt.evaluate((value) => value.seen).catch(() => false);
      return {
        stillFocused: () =>
          control.evaluate((element) => element.isConnected && document.activeElement === element),
        arm: () => this.arm(source, destination.href, sourceCaptureId, keyObserved),
        dispose: async () => {
          await receipt.evaluate((value) => value.remove()).catch(() => {});
          await receipt.dispose();
          await control.dispose();
        },
      };
    } catch (error) {
      await control.dispose().catch(() => {});
      throw error;
    }
  }
  private arm(
    source: Page,
    destination: string,
    sourceCaptureId: string,
    keyObserved: () => Promise<boolean>,
  ) {
    if (!this.active() || source !== this.kit.current() || this.pending)
      throw Error('The new-window action is no longer current.');
    let complete!: () => void;
    const promise = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const pending: PendingWindow = {
      source,
      sourceCaptureId,
      destination: addressKey(destination),
      allowedAddresses: new Set<string>(),
      expires: Date.now() + WINDOW_ARRIVAL_MS,
      promise,
      keyObserved,
      finish: () => {
        clearTimeout(pending.timer);
        if (this.pending === pending) this.pending = undefined;
        complete();
      },
      timer: undefined as unknown as ReturnType<typeof setTimeout>,
    };
    pending.timer = setTimeout(() => {
      if (this.pending !== pending) return;
      if (this.active())
        this.kit.record(
          'unobserved',
          'The explicitly requested new-window navigation was not verified within its bounded wait. No destination success is inferred.',
          pending.sourceCaptureId,
        );
      pending.finish();
      if (pending.candidate && pending.candidate !== this.kit.current())
        void pending.candidate.close().catch(() => {});
    }, WINDOW_ARRIVAL_MS);
    this.pending = pending;
    return { wait: () => promise, cancel: () => pending.finish() };
  }
  /** The first popup request can arrive before Playwright exposes its frame. */
  async allows(request: Request) {
    if (!request.isNavigationRequest()) return true;
    let page: Page | undefined;
    try {
      page = request.frame().page();
    } catch {
      /* The first child frame may not exist yet. */
    }
    if (page === this.kit.current()) return true;
    const pending = this.pending;
    if (!pending || !this.isCurrent(pending)) return false;
    if (!(await pending.keyObserved()) || !this.isCurrent(pending)) return false;
    if (page) {
      if ((await page.opener().catch(() => null)) !== pending.source) return false;
      if (pending.candidate && pending.candidate !== page) return false;
    }
    if (!this.isCurrent(pending)) return false;
    let first = request;
    for (let i = 0; first.redirectedFrom() && i < 10; i++) first = first.redirectedFrom()!;
    if (addressKey(first.url()) !== pending.destination) return false;
    pending.allowedAddresses.add(addressKey(request.url()));
    return true;
  }
  private async child(source: Page, popup: Page) {
    const pending = this.pending;
    if (
      !pending ||
      !this.isCurrent(pending) ||
      source !== this.kit.current() ||
      source !== pending.source ||
      (pending.candidate && pending.candidate !== popup)
    )
      return this.refuse(
        popup,
        'An unsolicited, sibling or late window was refused; it was not an expected action on the current page.',
      );
    if (!(await pending.keyObserved()) || !this.isCurrent(pending))
      return this.refuse(
        popup,
        'The new window had no current trusted activation key on the checked control.',
      );
    if ((await popup.opener().catch(() => null)) !== source) {
      await this.refuse(popup, 'The new window did not have the verified current source page.');
      return;
    }
    await popup
      .waitForLoadState('domcontentloaded', { timeout: Math.max(1, pending.expires - Date.now()) })
      .catch(() => {});
    if (!this.isCurrent(pending) || popup.isClosed())
      return this.refuse(popup, 'The new window arrived after its verified action ended.');
    const url = await this.kit.permitted(popup.url()).catch(() => null);
    if (!this.isCurrent(pending) || popup.isClosed())
      return this.refuse(
        popup,
        'The verified window action ended before destination checking finished.',
      );
    if (!url || !pending.allowedAddresses.has(addressKey(url.href))) {
      await this.refuse(popup, 'The new window did not reach the declared permitted destination.');
      return;
    }
    await popup.bringToFront();
    if (!this.isCurrent(pending) || source !== this.kit.current())
      return this.refuse(
        popup,
        'The verified window action ended before the new window could be adopted.',
      );
    if (pending.candidate && pending.candidate !== popup)
      return this.refuse(popup, 'Only one matching window may belong to the actual activation.');
    pending.candidate = popup;
    this.kit.adopted(popup);
    this.kit.record(
      'adopted',
      'The actual keyboard activation opened its declared permitted destination in a verified child window.',
      pending.sourceCaptureId,
    );
    pending.finish();
  }
  async close() {
    this.closed = true;
    const pending = this.pending;
    pending?.finish();
    await Promise.allSettled([...this.checking].map((page) => page.close()));
    await Promise.allSettled([...this.tasks]);
  }
}
