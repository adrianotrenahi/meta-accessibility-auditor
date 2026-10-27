import type { Page } from 'playwright';

/** Retry transient document/target replacement reads; never repeat the triggering input. */
export async function readPage<T>(page: Page, read: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await read();
    } catch (error) {
      const replaced =
        error instanceof Error &&
        /Execution context was destroyed|Cannot find context with specified id|Document changed during observation/i.test(
          error.message,
        );
      const detached =
        error instanceof Error &&
        /\bElement is not attached(?: to the DOM)?(?:\.|\r?\n|$)/i.test(error.message);
      if ((!replaced && !detached) || attempt >= 2 || page.isClosed()) throw error;
      if (replaced) await page.waitForLoadState('domcontentloaded', { timeout: 5000 });
      await page.waitForTimeout(50);
    }
  }
}
