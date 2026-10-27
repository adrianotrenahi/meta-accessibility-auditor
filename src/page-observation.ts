import type { Page } from 'playwright';

/** Retry a read across document replacement; never repeat the triggering input. */
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
      if (!replaced || attempt >= 2 || page.isClosed()) throw error;
      await page.waitForLoadState('domcontentloaded', { timeout: 5000 });
      await page.waitForTimeout(50);
    }
  }
}
