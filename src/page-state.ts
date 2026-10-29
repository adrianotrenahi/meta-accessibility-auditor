import type { Page } from 'playwright';
import { digest } from './store.js';

/**
 * Real websites rotate promotions, tick counters and swap banner copy while
 * nobody touches them. Those changes must not stop a keyboard walk, but a
 * popup opening or closing, a new document, moved focus or scroll always do.
 */
export const CONTENT_DRIFT = { minimumLines: 12, share: 0.05 } as const;

const dialogLine = /^\s*- (?:dialog|alertdialog)\b/;

function lineCounts(aria: string) {
  const counts = new Map<string, number>();
  for (const line of aria.split('\n')) counts.set(line, (counts.get(line) ?? 0) + 1);
  return counts;
}

/** Lines present in only one of the two accessibility snapshots (as a multiset). */
export function ariaDifference(before: string, after: string) {
  const a = lineCounts(before);
  const b = lineCounts(after);
  const changed: string[] = [];
  for (const [line, count] of a) for (let i = b.get(line) ?? 0; i < count; i++) changed.push(line);
  for (const [line, count] of b) for (let i = a.get(line) ?? 0; i < count; i++) changed.push(line);
  return changed;
}

/** Ordinary content drift, not a different screen. Opening or closing a dialog never qualifies. */
export function contentSettled(before: unknown, after: unknown) {
  if (typeof before !== 'string' || typeof after !== 'string') return false;
  if (before === after) return true;
  const changed = ariaDifference(before, after);
  if (changed.some((line) => dialogLine.test(line))) return false;
  const lines = Math.max(before.split('\n').length, after.split('\n').length);
  return changed.length <= Math.max(CONTENT_DRIFT.minimumLines, lines * CONTENT_DRIFT.share);
}

/** The page apart from keyboard focus and its copy: same document, address, scroll and dialogs. */
export function pageStamp(state: Record<string, unknown>) {
  const { focus: _focus, focusHelp: _help, aria: _aria, ...page } = state;
  return digest(JSON.stringify(page));
}

/** With nothing focused, the page body's text is page copy, not a focus fact. */
function focusKey(focus: unknown) {
  const value = focus as { tag?: unknown; text?: unknown } | null | undefined;
  return digest(JSON.stringify(value?.tag === 'body' ? { ...value, text: undefined } : focus));
}

/**
 * Whether a saved observation still describes the page closely enough to send
 * the next key. Only the walk uses this; scans and journey evidence keep the
 * exact state stamp. Records saved before page-state/1 keep exact comparison.
 */
export function sameForInput(
  saved: {
    stateStamp?: unknown;
    pageStamp?: unknown;
    focus?: unknown;
    focusHelp?: unknown;
    aria?: unknown;
  },
  state: Record<string, unknown>,
) {
  if (typeof saved.pageStamp !== 'string')
    return saved.stateStamp === digest(JSON.stringify(state));
  return (
    saved.pageStamp === pageStamp(state) &&
    focusKey(saved.focus) === focusKey(state.focus) &&
    digest(JSON.stringify(saved.focusHelp)) === digest(JSON.stringify(state.focusHelp)) &&
    contentSettled(saved.aria, state.aria)
  );
}

/** Visible modal surfaces and consent banners. Their arrival or removal is always a new screen. */
export async function openDialogs(page: Page) {
  return page.evaluate(() => {
    const selectors =
      '[role=dialog],[role=alertdialog],dialog[open],[aria-modal=true],#onetrust-banner-sdk,#didomi-host,#CybotCookiebotDialog,#usercentrics-root,.qc-cmp2-container';
    const seen = new Set<Element>();
    const result: { role: string; name: string }[] = [];
    for (const element of document.querySelectorAll(selectors)) {
      if (result.length >= 6) break;
      if ([...seen].some((outer) => outer.contains(element))) continue;
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (!box.width || !box.height || style.visibility === 'hidden' || style.display === 'none')
        continue;
      seen.add(element);
      const labelledBy = element.getAttribute('aria-labelledby');
      const name =
        element.getAttribute('aria-label') ??
        (labelledBy ? document.getElementById(labelledBy.split(' ')[0]!)?.textContent : null) ??
        element.querySelector('h1,h2,h3')?.textContent ??
        element.id;
      result.push({
        role: element.getAttribute('role') ?? element.tagName.toLowerCase(),
        name: (name ?? '').replace(/\s+/g, ' ').trim().slice(0, 120),
      });
    }
    return result;
  });
}
