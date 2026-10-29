import type { Page, BrowserContext } from 'playwright';
import { digest, recordIsIntact } from './store.js';
import type { RecordEntry } from './types.js';
import {
  screenStateSchema,
  verifiedScreenState,
  type StateCapture,
} from './screen-state-contract.js';
export { verifiedScreenState, type ScreenState } from './screen-state-contract.js';

/** A real pointer entering/leaving an element is a different hover state even
 * when an engine's :hover query is not updated synchronously with its paint. */
export async function installPointerState(context: BrowserContext, key: string) {
  await context.addInitScript((property) => {
    let sequence = 0;
    let nextObject = 0;
    const objectIds = new WeakMap<object, number>();
    window.addEventListener(
      'pointerover',
      () => {
        sequence++;
      },
      true,
    );
    window.addEventListener(
      'pointerout',
      () => {
        sequence++;
      },
      true,
    );
    Object.defineProperty(globalThis, property, {
      enumerable: false,
      configurable: false,
      writable: false,
      value: Object.freeze((object?: object) => {
        if (object === undefined) return sequence;
        let id = objectIds.get(object);
        if (id === undefined) {
          id = ++nextObject;
          objectIds.set(object, id);
        }
        return id;
      }),
    });
  }, key);
}

/** Focus decoration is recorded as keyboard facts, not a new page. DOM,
 * accessible content, rendered geometry, scroll and image changes stay strict.
 * Unbounded/animated embedded surfaces conservatively require an image. */
export async function renderedScreenShape(page: Page, pointerKey: string) {
  const pointerEpoch = await page.evaluate((key) => {
    const read = (globalThis as any)[key];
    return typeof read === 'function' ? read() : null;
  }, pointerKey);
  const value = await page.locator('body').evaluate((body, property) => {
    const reader = (globalThis as any)[property];
    const identify = reader;
    const sheets = [...document.styleSheets, ...(document.adoptedStyleSheets ?? [])];
    const seen = new Set<CSSStyleSheet>();
    const styles: unknown[] = [];
    let cssComplete = typeof identify === 'function' && sheets.length <= 64;
    let characters = 0,
      rules = 0;
    while (sheets.length && seen.size < 64) {
      const sheet = sheets.shift()!;
      if (seen.has(sheet)) continue;
      seen.add(sheet);
      const owner = sheet.ownerNode instanceof Element ? sheet.ownerNode : null;
      const attributes = owner ? [...owner.attributes] : [];
      if (attributes.length > 50 || attributes.some((attribute) => attribute.value.length > 2048))
        cssComplete = false;
      const source: Record<string, unknown> = {
        id: typeof identify === 'function' ? identify(sheet) : null,
        href: sheet.href,
        disabled: sheet.disabled,
        media: sheet.media.mediaText,
        owner: owner
          ? {
              tag: owner.tagName,
              attributes: attributes
                .slice(0, 50)
                .map((attribute) => [attribute.name, attribute.value.slice(0, 2048)]),
            }
          : null,
      };
      try {
        const css = sheet.cssRules;
        if (css.length > 5000 - rules) cssComplete = false;
        const text: string[] = [];
        const maximum = Math.min(css.length, 5000 - rules);
        for (let index = 0; index < maximum; index++) {
          const rule = css[index]!;
          const value = rule.cssText;
          if (value.length > 500000 - characters) {
            cssComplete = false;
            break;
          }
          characters += value.length;
          rules++;
          text.push(value);
          if (rule instanceof CSSImportRule && rule.styleSheet) sheets.push(rule.styleSheet);
        }
        source.rules = text;
      } catch {
        // Cross-origin rules cannot be edited through CSSOM by this document.
        // Their native sheet identity and link/media state still cannot change
        // unnoticed; a replacement gets another local identity.
        source.opaque = true;
      }
      styles.push(source);
    }
    if (sheets.length) cssComplete = false;
    const nodes = [body, ...body.querySelectorAll('*')];
    let complete = nodes.length <= 2500 && cssComplete && document.fonts.status === 'loaded';
    const visible = nodes.slice(0, 2500).flatMap((element) => {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (!box.width || !box.height || style.display === 'none' || style.visibility === 'hidden')
        return [];
      if (
        ['CANVAS', 'VIDEO', 'IFRAME', 'OBJECT', 'EMBED'].includes(element.tagName) ||
        element.shadowRoot !== null ||
        element.tagName.includes('-')
      )
        complete = false;
      const image =
        element instanceof HTMLImageElement
          ? {
              source: element.currentSrc,
              complete: element.complete,
              width: element.naturalWidth,
              height: element.naturalHeight,
            }
          : null;
      if (image && (!image.complete || /\.gif(?:[?#]|$)/i.test(image.source))) complete = false;
      return [
        {
          tag: element.tagName,
          hovered: element.matches(':hover'),
          attributes: [...element.attributes].map((attribute) => [attribute.name, attribute.value]),
          value:
            element instanceof HTMLInputElement ||
            element instanceof HTMLTextAreaElement ||
            element instanceof HTMLSelectElement
              ? element.value
              : null,
          box: { x: box.x, y: box.y, width: box.width, height: box.height },
          display: style.display,
          visibility: style.visibility,
          opacity: style.opacity,
          transform: style.transform,
          content: style.content,
          backgroundImage: style.backgroundImage,
          // A control's focus colour/shadow is recorded in focus facts. Paint
          // changes elsewhere and actual hover identity remain meaningful.
          paint: element.closest(
            'button,a[href],input,textarea,select,[role=button],[role=link],[tabindex]',
          )
            ? null
            : [style.color, style.backgroundColor, style.boxShadow],
          font: [style.fontFamily, style.fontSize, style.fontWeight, style.lineHeight],
          image,
        },
      ];
    });
    if (document.getAnimations().some((animation) => animation.playState === 'running'))
      complete = false;
    return { complete, text: (body as HTMLElement).innerText, visible, styles };
  }, pointerKey);
  return {
    complete: value.complete && Number.isSafeInteger(pointerEpoch),
    fingerprint: digest(JSON.stringify({ ...value, pointerEpoch })),
  };
}

export function meaningfulScreenFingerprint(state: any): string | undefined {
  if (state.screenShape?.complete !== true) return;
  const { focus: _focus, ...screen } = state;
  return digest(JSON.stringify(screen));
}

export function exportScreenState(record: RecordEntry, originals: readonly RecordEntry[]) {
  if (!screenStateSchema.safeParse(record.payload.screenState).success) return;
  const row = (item: RecordEntry): StateCapture => ({
    ...item.payload,
    id: item.id,
    sequence: item.seq,
    recordHash: recordIsIntact(item) ? item.hash : undefined,
  });
  return verifiedScreenState(row(record), originals.map(row));
}
