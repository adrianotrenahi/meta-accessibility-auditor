import type { Page } from 'playwright';

/** A document replacement is different from a closed page or an unknown scan error. */
export const documentWasReplaced = (error: unknown): error is Error =>
  error instanceof Error &&
  /Execution context was destroyed|Cannot find context with specified id|Document changed during observation/i.test(
    error.message,
  );

/** Retry transient document/target replacement reads; never repeat the triggering input. */
export async function readPage<T>(page: Page, read: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await read();
    } catch (error) {
      const replaced = documentWasReplaced(error);
      const detached =
        error instanceof Error &&
        /\bElement is not attached(?: to the DOM)?(?:\.|\r?\n|$)/i.test(error.message);
      if ((!replaced && !detached) || attempt >= 2 || page.isClosed()) throw error;
      if (replaced) await page.waitForLoadState('domcontentloaded', { timeout: 5000 });
      await page.waitForTimeout(50);
    }
  }
}
