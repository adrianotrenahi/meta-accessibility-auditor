import type { ElementHandle, Page, JSHandle } from 'playwright';
import { createHash, randomUUID } from 'node:crypto';
import { safeError } from './config.js';
import { LIMITS } from './types.js';

export const MAX_CYCLE_MEMORIES = LIMITS.driver;
export const MAX_CYCLE_MEMBERS = 60;
const dialog = 'dialog,[role="dialog"],[role="alertdialog"],[aria-modal="true"]';
const controls =
  'button,a[href],input:not([type="hidden"]),select,textarea,[tabindex],[role="button"],[role="link"],[role="checkbox"],[role="combobox"],[role="menuitem"],[role="tab"],[role="option"],[role="gridcell"]';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const same = (a: ElementHandle, b: ElementHandle) =>
  a.evaluate((element, other) => element === other, b);
type Member = { handle: ElementHandle; state: string };
type Scope = {
  handle: ElementHandle;
  state: string;
  snapshot: 'complete' | 'identity-only' | 'overflow';
  members: Member[];
} | null;
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
  participantScopes: Scope[];
  targetScope: Scope;
  revalidation: 'complete' | 'unsupported-context';
  owned: Set<JSHandle>;
  redact: (value: string) => string;
  evidence: CycleEvidence;
};
type Decision =
  | { state: 'allow' }
  | { state: 'blocked'; evidence: CycleEvidence }
  | { state: 'unknown'; reason: string; evidence?: CycleEvidence };
class ObservedContextChanged extends Error {}

/** Actual node identity survives a new capture or model decision. This memory
 * permits no input, and is never evidence of a website keyboard barrier. */
export class KeyboardCycleMemory {
  private entries: Entry[] = [];
  private watched = new WeakSet<Page>();
  private closedPages = new WeakSet<Page>();
  private closed = false;
  private closing?: Promise<void>;
  private uncertain = false;
  private unreadDocuments = new Map<Page, number>();
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
        this.unreadDocuments.delete(page);
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
        nativeChecked:
          element instanceof HTMLInputElement && ['checkbox', 'radio'].includes(element.type)
            ? element.checked
            : null,
        nativeIndeterminate:
          element instanceof HTMLInputElement && element.type === 'checkbox'
            ? element.indeterminate
            : null,
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
      throw new ObservedContextChanged('An observed keyboard node is no longer available.');
    return { handle: copy, state: facts.state };
  }
  private async children(parent: ElementHandle, owned: Set<JSHandle>) {
    const list = await parent.evaluateHandle(
      (element, { selector, limit }) => {
        if (!(element instanceof Element)) throw Error('The dialog is not an element.');
        const nodes = element.querySelectorAll(selector);
        return Array.from({ length: Math.min(nodes.length, limit + 1) }, (_, i) => nodes[i]!);
      },
      { selector: controls, limit: MAX_CYCLE_MEMBERS },
    );
    owned.add(list);
    const properties = await list.getProperties();
    const children: ElementHandle[] = [];
    for (const [key, value] of properties) {
      owned.add(value);
      if (/^\d+$/.test(key)) {
        const element = value.asElement();
        if (!element) throw Error('A dialog control could not be read.');
        children.push(element);
      }
    }
    return children;
  }
  private async scope(
    handle: ElementHandle,
    owned: Set<JSHandle>,
    redact: (value: string) => string,
    readMembers = true,
  ): Promise<Scope> {
    const raw = await handle.evaluateHandle(
      (element, selector) => (element as Element).closest(selector),
      dialog,
    );
    owned.add(raw);
    const parent = raw.asElement();
    if (!parent) return null;
    const facts = await this.state(parent, redact);
    if (!facts.connected)
      throw new ObservedContextChanged('The observed dialog is no longer available.');
    // An unsupported full context still has actual node/state evidence. Keep
    // that local refusal until a positive relevant change, rather than making
    // this entire walk permanently uncertain.
    if (!readMembers)
      return { handle: parent, state: facts.state, snapshot: 'identity-only', members: [] };
    const members: Member[] = [];
    const children = await this.children(parent, owned);
    if (children.length > MAX_CYCLE_MEMBERS)
      return { handle: parent, state: facts.state, snapshot: 'overflow', members: [] };
    for (const child of children) {
      const value = await this.state(child, redact);
      if (value.usable) members.push({ handle: child, state: value.state });
    }
    return { handle: parent, state: facts.state, snapshot: 'complete', members };
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
    if (scope.snapshot === 'identity-only') return true;
    const temporary = new Set<JSHandle>();
    try {
      const children = await this.children(scope.handle, temporary);
      if (scope.snapshot === 'overflow') return children.length > MAX_CYCLE_MEMBERS;
      if (children.length > MAX_CYCLE_MEMBERS) return false;
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
      await this.dispose(temporary);
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
      const unreadEpoch = this.unreadDocuments.get(page);
      if (unreadEpoch !== undefined && unreadEpoch !== epoch) this.unreadDocuments.delete(page);
      if (this.unreadDocuments.has(page))
        return {
          state: 'unknown',
          reason:
            'A minimum focus-cycle read failed in this document. A new capture alone cannot clear it; no traversal input was sent.',
        };
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
        // Each distinct observed scope is read once. Unsupported contexts
        // retain only their complete bounded node/state observations.
        const readScopes = new Set<Scope>();
        for (let i = 0; i < entry.participants.length; i++) {
          const participant = entry.participants[i]!,
            scope = entry.participantScopes[i]!;
          unchanged =
            (await this.state(participant.handle, entry.redact)).state === participant.state &&
            unchanged;
          unchanged =
            (await this.scopeUnchanged(
              scope,
              participant.handle,
              entry.redact,
              !readScopes.has(scope),
            )) && unchanged;
          readScopes.add(scope);
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
        if (unchanged)
          return entry.revalidation === 'complete'
            ? { state: 'blocked', evidence: entry.evidence }
            : {
                state: 'unknown',
                reason:
                  'The earlier focus cycle has an unsupported bounded dialog context. Its observed target, controls and dialog states remain unchanged; no traversal input was sent.',
                evidence: entry.evidence,
              };
        await this.remove([entry]);
        if (this.uncertain) throw Error('The changed cycle could not be released.');
        return { state: 'allow' };
      }
      if (this.closed || this.closedPages.has(page) || page.isClosed() || this.uncertain)
        throw Error('The bounded focus-cycle memory is unavailable.');
      if (this.entries.length + this.unreadDocuments.size >= MAX_CYCLE_MEMORIES)
        return {
          state: 'unknown',
          reason:
            'The bounded focus-cycle memory is full. Earlier target histories are retained; no further traversal input was sent.',
        };
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
    if (this.entries.length + this.unreadDocuments.size >= MAX_CYCLE_MEMORIES) return undefined;
    let epoch: number | undefined;
    try {
      if (
        !this.watch(input.page) ||
        this.uncertain ||
        !input.participants.length ||
        input.participants.length > 24
      )
        throw Error('The cycle cannot be retained safely.');
      epoch = await input.page.evaluate(() => performance.timeOrigin);
      const target = await this.member(input.target, owned, input.redact, true);
      const participants: Member[] = [];
      for (const participant of input.participants)
        participants.push(await this.member(participant.handle, owned, input.redact));
      const blocker = await this.scope(participants[0]!.handle, owned, input.redact);
      const participantScopes: Scope[] = [blocker];
      let shared = true;
      for (const participant of participants.slice(1)) {
        const matches = await participant.handle.evaluate(
          (element, { selector, expected }) => (element as Element).closest(selector) === expected,
          { selector: dialog, expected: blocker?.handle ?? null },
        );
        participantScopes.push(
          matches ? blocker : await this.scope(participant.handle, owned, input.redact, false),
        );
        shared = matches && shared;
      }
      const targetScope = await this.scope(target.handle, owned, input.redact);
      const revalidation =
        shared &&
        (!blocker || blocker.snapshot === 'complete') &&
        (!targetScope || targetScope.snapshot === 'complete')
          ? 'complete'
          : 'unsupported-context';
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
          kind: shared && blocker ? 'observed-dialog' : 'no-shared-dialog',
          targetOutside:
            shared && blocker
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
        throw new ObservedContextChanged('The cycle changed while it was retained.');
      this.entries.push({
        page: input.page,
        epoch,
        target,
        participants,
        participantScopes,
        targetScope,
        revalidation,
        owned,
        redact: input.redact,
        evidence,
      });
      return evidence;
    } catch (error) {
      await this.dispose(owned);
      if (
        !this.closed &&
        !this.closedPages.has(input.page) &&
        !input.page.isClosed() &&
        !this.uncertain &&
        !(error instanceof ObservedContextChanged)
      ) {
        if (epoch !== undefined) this.unreadDocuments.set(input.page, epoch);
        else this.uncertain = true;
      }
      return undefined;
    }
  }
  close() {
    if (!this.closing) {
      this.closed = true;
      this.unreadDocuments.clear();
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
