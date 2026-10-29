import type { ElementHandle, Page, JSHandle } from 'playwright';
import { createHash, randomUUID } from 'node:crypto';
import { safeError } from './config.js';

export const MAX_CYCLE_MEMORIES = 20;
export const MAX_CYCLE_MEMBERS = 60;
const dialog = 'dialog,[role="dialog"],[role="alertdialog"],[aria-modal="true"]';
const controls =
  'button,a[href],input:not([type="hidden"]),select,textarea,[tabindex],[role="button"],[role="link"],[role="checkbox"],[role="combobox"],[role="menuitem"],[role="tab"],[role="option"],[role="gridcell"]';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const same = (a: ElementHandle, b: ElementHandle) =>
  a.evaluate((element, other) => element === other, b);
type Member = { handle: ElementHandle; state: string };
type Scope = { handle: ElementHandle; state: string; members: Member[] } | null;
export type CycleEvidence = {
  version: 'keyboard-cycle/1';
  id: string;
  sourceId: string;
  sourceKind: 'capture' | 'observation';
  actionIds: string[];
  participants: { role: string; name: string }[];
  context: { kind: 'observed-dialog' | 'no-shared-dialog'; targetOutside: boolean | null };
};
type Entry = {
  page: Page;
  epoch: number;
  target: Member;
  participants: Member[];
  blocker: Scope;
  targetScope: Scope;
  owned: Set<JSHandle>;
  redact: (value: string) => string;
  evidence: CycleEvidence;
};
type Decision =
  | { state: 'allow' }
  | { state: 'blocked'; evidence: CycleEvidence }
  | { state: 'unknown'; reason: string };

/** Actual node identity survives a new capture or model decision. This memory
 * permits no input, and is never evidence of a website keyboard barrier. */
export class KeyboardCycleMemory {
  private entries: Entry[] = [];
  private watched = new WeakSet<Page>();
  private closedPages = new WeakSet<Page>();
  private closed = false;
  private closing?: Promise<void>;
  private uncertain = false;
  private pending = new Set<Promise<unknown>>();
  get isClosed() {
    return this.closed;
  }
  private track<T>(start: () => Promise<T>) {
    const work = Promise.resolve().then(start);
    this.pending.add(work);
    void work.finally(() => this.pending.delete(work)).catch(() => {});
    return work;
  }

  private watch(page: Page) {
    if (this.closed || this.closedPages.has(page) || page.isClosed()) return false;
    if (!this.watched.has(page)) {
      this.watched.add(page);
      page.once('close', () => {
        this.closedPages.add(page);
        const work = this.remove(this.entries.filter((entry) => entry.page === page));
        this.pending.add(work);
        void work.finally(() => this.pending.delete(work));
      });
    }
    return true;
  }
  private label(value: string, redact: (value: string) => string) {
    return safeError(Error(redact(value)))
      .replace(/\b(?:https?:\/\/|www\.)\S+/gi, '[link]')
      .slice(0, 120);
  }
  private async state(handle: ElementHandle, redact: (value: string) => string) {
    const facts = await handle.evaluate((element) => {
      if (!(element instanceof Element)) throw Error('Keyboard node is not an element.');
      const style = getComputedStyle(element);
      const editable =
        (element as HTMLElement).isContentEditable ||
        element.querySelector(
          'input,textarea,select,[contenteditable]:not([contenteditable="false"])',
        );
      return {
        connected: element.isConnected && element.ownerDocument === document,
        visible:
          element.getClientRects().length > 0 &&
          style.display !== 'none' &&
          style.visibility !== 'hidden',
        tag: element.tagName,
        role: element.getAttribute('role'),
        disabled: element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true',
        inert: !!element.closest('[inert]'),
        hidden: !!element.closest('[hidden],[aria-hidden="true"]'),
        tabindex: (element as HTMLElement).tabIndex,
        modal: element.getAttribute('aria-modal'),
        open: element.tagName === 'DIALOG' ? (element as HTMLDialogElement).open : null,
        expanded: element.getAttribute('aria-expanded'),
        checked: element.getAttribute('aria-checked'),
        selected: element.getAttribute('aria-selected'),
        label: element.getAttribute('aria-label') ?? '',
        text:
          !editable && ['BUTTON', 'A'].includes(element.tagName)
            ? (element.textContent ?? '').slice(0, 200)
            : '',
      };
    });
    return {
      usable: facts.connected && facts.visible && !facts.disabled && !facts.inert && !facts.hidden,
      connected: facts.connected,
      state: hash({
        ...facts,
        label: this.label(facts.label, redact),
        text: this.label(facts.text, redact),
      }),
    };
  }
  private async clone(handle: ElementHandle, owned: Set<JSHandle>) {
    const copy = await handle.evaluateHandle((element) => element);
    owned.add(copy);
    const element = copy.asElement();
    if (!element) throw Error('The observed keyboard node is unavailable.');
    return element;
  }
  private async member(
    handle: ElementHandle,
    owned: Set<JSHandle>,
    redact: (value: string) => string,
    target = false,
  ) {
    const copy = await this.clone(handle, owned);
    const facts = await this.state(copy, redact);
    if (!(target ? facts.connected : facts.usable))
      throw Error('An observed keyboard node is no longer available.');
    return { handle: copy, state: facts.state };
  }
  private async scope(
    handle: ElementHandle,
    owned: Set<JSHandle>,
    redact: (value: string) => string,
  ): Promise<Scope> {
    const raw = await handle.evaluateHandle(
      (element, selector) => (element as Element).closest(selector),
      dialog,
    );
    owned.add(raw);
    const parent = raw.asElement();
    if (!parent) return null;
    const facts = await this.state(parent, redact);
    if (!facts.connected) throw Error('The observed dialog is no longer available.');
    const members: Member[] = [];
    const children = await parent.$$(controls);
    for (const child of children) owned.add(child);
    if (children.length > MAX_CYCLE_MEMBERS)
      throw Error('The observed dialog exceeds the bounded context read.');
    for (const child of children) {
      const value = await this.state(child, redact);
      if (value.usable) members.push({ handle: child, state: value.state });
    }
    return { handle: parent, state: facts.state, members };
  }
  private async scopeUnchanged(
    scope: Scope,
    owner: ElementHandle,
    redact: (value: string) => string,
    readMembers = true,
  ) {
    const matches = await owner.evaluate(
      (element, { selector, expected }) => (element as Element).closest(selector) === expected,
      { selector: dialog, expected: scope?.handle ?? null },
    );
    if (!matches) return false;
    if (!scope || !readMembers) return true;
    if ((await this.state(scope.handle, redact)).state !== scope.state) return false;
    const children = await scope.handle.$$(controls);
    try {
      if (children.length > MAX_CYCLE_MEMBERS)
        throw Error('The dialog context is unavailable within its bound.');
      const visible: Member[] = [];
      for (const child of children) {
        const state = await this.state(child, redact);
        if (state.usable) visible.push({ handle: child, state: state.state });
      }
      if (visible.length !== scope.members.length) return false;
      for (let i = 0; i < visible.length; i++)
        if (
          visible[i]!.state !== scope.members[i]!.state ||
          !(await same(scope.members[i]!.handle, visible[i]!.handle))
        )
          return false;
      return true;
    } finally {
      const disposed = await Promise.allSettled(
        children.map((child) => Promise.resolve().then(() => child.dispose())),
      );
      if (disposed.some((value) => value.status === 'rejected')) this.uncertain = true;
    }
  }
  private async dispose(owned: Set<JSHandle>) {
    const results = await Promise.allSettled(
      [...owned].map((handle) => Promise.resolve().then(() => handle.dispose())),
    );
    owned.clear();
    if (results.some((value) => value.status === 'rejected')) this.uncertain = true;
  }
  private async remove(entries: Entry[]) {
    this.entries = this.entries.filter((entry) => !entries.includes(entry));
    await Promise.all(entries.map((entry) => this.dispose(entry.owned)));
  }
  check(page: Page, target: ElementHandle): Promise<Decision> {
    return this.track(() => this.checkNow(page, target));
  }
  private async checkNow(page: Page, target: ElementHandle): Promise<Decision> {
    if (!this.watch(page) || this.uncertain)
      return {
        state: 'unknown',
        reason:
          'The earlier focus-cycle context cannot be revalidated. No traversal input was sent.',
      };
    try {
      const epoch = await page.evaluate(() => performance.timeOrigin);
      await this.remove(
        this.entries.filter((entry) => entry.page !== page || entry.epoch !== epoch),
      );
      for (const entry of this.entries) {
        if (!(await this.state(entry.target.handle, entry.redact)).connected) {
          await this.remove([entry]);
          if (this.uncertain) throw Error('The disconnected target could not be released.');
          continue;
        }
        if (!(await same(entry.target.handle, target))) continue;
        let unchanged = (await this.state(target, entry.redact)).state === entry.target.state;
        unchanged =
          (await this.scopeUnchanged(entry.targetScope, target, entry.redact)) && unchanged;
        // The shared dialog is read once; each participant still checks its
        // own actual node and nearest-dialog identity below.
        if (entry.blocker)
          unchanged =
            (await this.scopeUnchanged(
              entry.blocker,
              entry.participants[0]!.handle,
              entry.redact,
            )) && unchanged;
        for (const participant of entry.participants) {
          unchanged =
            (await this.state(participant.handle, entry.redact)).state === participant.state &&
            unchanged;
          unchanged =
            (await this.scopeUnchanged(entry.blocker, participant.handle, entry.redact, false)) &&
            unchanged;
        }
        const activeHandle = await page.evaluateHandle(() => document.activeElement);
        try {
          const focus = activeHandle.asElement();
          if (!focus) throw Error('Current keyboard focus could not be read.');
          const placeholder = await focus.evaluate(
            (element) => element === document.body || element === document.documentElement,
          );
          if (!placeholder) {
            let inside = false;
            for (const participant of entry.participants)
              if (await same(participant.handle, focus)) {
                inside = true;
                break;
              }
            if (!inside) unchanged = false;
          }
        } finally {
          await activeHandle.dispose();
        }
        if (this.closed || this.closedPages.has(page) || page.isClosed() || this.uncertain)
          throw Error('The cycle read ended without a current context.');
        if (unchanged) return { state: 'blocked', evidence: entry.evidence };
        await this.remove([entry]);
        if (this.uncertain) throw Error('The changed cycle could not be released.');
        return { state: 'allow' };
      }
      if (
        this.closed ||
        this.closedPages.has(page) ||
        page.isClosed() ||
        this.uncertain ||
        this.entries.length >= MAX_CYCLE_MEMORIES
      )
        throw Error('The bounded focus-cycle memory is unavailable.');
      return { state: 'allow' };
    } catch {
      return {
        state: 'unknown',
        reason:
          'The earlier focus-cycle context cannot be revalidated. No traversal input was sent.',
      };
    }
  }
  remember(input: {
    page: Page;
    target: ElementHandle;
    participants: { handle: ElementHandle; role: string; name: string }[];
    sourceId: string;
    sourceKind: 'capture' | 'observation';
    actionIds: string[];
    redact: (value: string) => string;
  }): Promise<CycleEvidence | undefined> {
    return this.track(() => this.rememberNow(input));
  }
  private async rememberNow(input: {
    page: Page;
    target: ElementHandle;
    participants: { handle: ElementHandle; role: string; name: string }[];
    sourceId: string;
    sourceKind: 'capture' | 'observation';
    actionIds: string[];
    redact: (value: string) => string;
  }): Promise<CycleEvidence | undefined> {
    const owned = new Set<JSHandle>();
    try {
      if (
        !this.watch(input.page) ||
        this.uncertain ||
        this.entries.length >= MAX_CYCLE_MEMORIES ||
        !input.participants.length ||
        input.participants.length > 24
      )
        throw Error('The cycle cannot be retained safely.');
      const epoch = await input.page.evaluate(() => performance.timeOrigin);
      const target = await this.member(input.target, owned, input.redact, true);
      const participants: Member[] = [];
      for (const participant of input.participants)
        participants.push(await this.member(participant.handle, owned, input.redact));
      const blocker = await this.scope(participants[0]!.handle, owned, input.redact);
      for (const participant of participants)
        if (
          !(await participant.handle.evaluate(
            (element, { selector, expected }) =>
              (element as Element).closest(selector) === expected,
            { selector: dialog, expected: blocker?.handle ?? null },
          ))
        )
          throw Error('The cycle did not establish one shared context.');
      const targetScope = await this.scope(target.handle, owned, input.redact);
      const evidence: CycleEvidence = {
        version: 'keyboard-cycle/1',
        id: randomUUID(),
        sourceId: input.sourceId,
        sourceKind: input.sourceKind,
        actionIds: input.actionIds.slice(0, 24),
        participants: input.participants.map((participant) => ({
          role: this.label(participant.role, input.redact),
          name: this.label(participant.name, input.redact),
        })),
        context: {
          kind: blocker ? 'observed-dialog' : 'no-shared-dialog',
          targetOutside: blocker
            ? !(await blocker.handle.evaluate(
                (element, target) => element.contains(target),
                target.handle,
              ))
            : null,
        },
      };
      if (
        this.closed ||
        this.closedPages.has(input.page) ||
        input.page.isClosed() ||
        (await input.page.evaluate(() => performance.timeOrigin)) !== epoch
      )
        throw Error('The cycle changed while it was retained.');
      this.entries.push({
        page: input.page,
        epoch,
        target,
        participants,
        blocker,
        targetScope,
        owned,
        redact: input.redact,
        evidence,
      });
      return evidence;
    } catch {
      this.uncertain = true;
      await this.dispose(owned);
      return undefined;
    }
  }
  close() {
    if (!this.closing) {
      this.closed = true;
      this.closing = (async () => {
        await this.remove([...this.entries]);
        await Promise.allSettled([...this.pending]);
      })();
    }
    return this.closing;
  }
}

const memories = new WeakMap<object, KeyboardCycleMemory>();
export function keyboardCycleMemory(walk: object) {
  let memory = memories.get(walk);
  if (!memory) {
    memory = new KeyboardCycleMemory();
    memories.set(walk, memory);
  }
  return memory;
}
export async function disposeKeyboardCycles(walk: object) {
  await memories.get(walk)?.close();
}
