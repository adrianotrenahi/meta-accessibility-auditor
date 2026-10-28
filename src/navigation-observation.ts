import { errors, type Page } from 'playwright';

export const NAVIGATION_OBSERVATION_WAIT_MS = 20_000;
export type PreviousNavigationCapture = { url: string; documentEpoch: number };

/** Only the native, unresolved bare-body locator failure qualifies. */
function missingBodyTimeout(error: unknown): error is InstanceType<typeof errors.TimeoutError> {
  if (!(error instanceof errors.TimeoutError)) return false;
  const message = error.message.replace(/\u001b\[[0-9;]*m/g, '');
  const [first, ...rest] = message.split(/\r?\n/);
  if (
    !/^locator\.(?:ariaSnapshot|innerText|evaluate): Timeout \d+ms exceeded\.?$/.test(first ?? '')
  )
    return false;
  const log = rest.map((line) => line.trim()).filter(Boolean);
  return (
    log.length === 2 &&
    log[0] === 'Call log:' &&
    /^- waiting for locator\((?:'body'|"body")\)$/.test(log[1]!)
  );
}

async function documentIdentity(page: Page, originalError: unknown, timeout: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      page.evaluate(() => ({
        url: location.href,
        documentEpoch: performance.timeOrigin,
        bodyPresent: document.body !== null,
        readyState: document.readyState,
      })),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(originalError), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** One read-only retry for an observed document transition; never repeats its input. */
export async function readNavigationCapture<T>(
  page: Page,
  read: () => Promise<T>,
  previous: PreviousNavigationCapture | undefined,
  active: () => void,
  onWait: () => void,
): Promise<T> {
  active();
  let result: T;
  try {
    result = await read();
  } catch (error) {
    // A stop during the first read takes precedence and cannot become recovery.
    active();
    if (
      !missingBodyTimeout(error) ||
      !previous ||
      typeof previous.url !== 'string' ||
      !previous.url ||
      !Number.isFinite(previous.documentEpoch) ||
      previous.documentEpoch <= 0 ||
      page.isClosed()
    )
      throw error;
    const deadline = performance.now() + NAVIGATION_OBSERVATION_WAIT_MS;
    let current;
    try {
      current = await documentIdentity(page, error, 1000);
    } finally {
      active();
    }
    if (
      page.isClosed() ||
      !current ||
      typeof current.url !== 'string' ||
      !current.url ||
      !Number.isFinite(current.documentEpoch) ||
      current.documentEpoch <= 0 ||
      typeof current.bodyPresent !== 'boolean' ||
      !['loading', 'interactive', 'complete'].includes(current.readyState) ||
      (current.url === previous.url && current.documentEpoch === previous.documentEpoch) ||
      (current.bodyPresent && current.readyState !== 'loading')
    )
      throw error;
    onWait();
    active();
    if (page.isClosed()) throw error;
    const remaining = Math.floor(deadline - performance.now());
    if (remaining <= 0) throw error;
    try {
      await page.waitForLoadState('domcontentloaded', { timeout: remaining });
    } finally {
      active();
    }
    if (page.isClosed()) throw error;
    // This read and its errors are outside the first try block: there is no retry loop.
    try {
      result = await read();
    } finally {
      active();
    }
    return result;
  }
  active();
  return result;
}
