import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readPage } from '../src/page-observation.js';
import type { Page } from 'playwright';

test('Document replacement retries only the observation and then reads the new page', async () => {
  let reads = 0,
    waits = 0;
  const page = {
    isClosed: () => false,
    waitForLoadState: async () => {
      waits++;
    },
    waitForTimeout: async () => {},
  } as unknown as Page;
  const result = await readPage(page, async () => {
    if (++reads === 1)
      throw Error(
        'page.evaluate: Execution context was destroyed, most likely because of a navigation',
      );
    return { focus: 'new-page-control' };
  });
  assert.deepEqual(result, { focus: 'new-page-control' });
  assert.equal(reads, 2);
  assert.equal(waits, 1);
});

test('Repeated replacement, a closed page and unrelated errors remain bounded failures', async () => {
  let reads = 0;
  const page = {
    isClosed: () => false,
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
  } as unknown as Page;
  await assert.rejects(() =>
    readPage(page, async () => {
      reads++;
      throw Error('Document changed during observation');
    }),
  );
  assert.equal(reads, 3);
  reads = 0;
  await assert.rejects(
    () =>
      readPage(page, async () => {
        reads++;
        throw Error('A source is missing');
      }),
    /source/,
  );
  assert.equal(reads, 1);
  reads = 0;
  await assert.rejects(() =>
    readPage({ ...page, isClosed: () => true } as Page, async () => {
      reads++;
      throw Error('Document changed during observation');
    }),
  );
  assert.equal(reads, 1);
});
