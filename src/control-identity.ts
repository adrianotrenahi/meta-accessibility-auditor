import type { BrowserContext } from 'playwright';

export const validControlInstance = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^control-v1:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:[1-9][0-9]*$/.test(
    value,
  );

/** Mechanical identity only: never a name, target ID, or proof that a control works. */
export async function installControlIdentity(context: BrowserContext, key: string) {
  await context.addInitScript((property) => {
    // Install before page scripts. Keep the actual node map in a closure, outside the DOM.
    // Each document gets a new namespace; a reload or replacement node cannot inherit an ID.
    const uuid = globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
    if (!uuid) return;
    const prefix = 'control-v1:' + uuid() + ':';
    const nodes = new WeakMap<Element, string>();
    const get = nodes.get.bind(nodes);
    const set = nodes.set.bind(nodes);
    let sequence = 0;
    Object.defineProperty(globalThis, property, {
      enumerable: false,
      configurable: false,
      writable: false,
      value: Object.freeze((element: Element) => {
        const previous = get(element);
        if (previous) return previous;
        const identity = prefix + ++sequence;
        set(element, identity);
        return identity;
      }),
    });
  }, key);
}
