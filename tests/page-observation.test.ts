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

test('A detached accessibility target is reread in the same document without losing its name', async () => {
  for (const message of [
    'locator.ariaSnapshot: Element is not attached to the DOM',
    'locator.ariaSnapshot: Element is not attached',
  ]) {
    let reads = 0,
      documentWaits = 0,
      pauses = 0;
    const documentEpoch = 123;
    const page = {
      isClosed: () => false,
      waitForLoadState: async () => {
        documentWaits++;
      },
      waitForTimeout: async () => {
        pauses++;
      },
    } as unknown as Page;
    const focus = await readPage(page, async () => {
      if (++reads === 1) throw Error(message);
      return { id: 'replacement', name: 'Continue to review', documentEpoch };
    });
    assert.deepEqual(focus, { id: 'replacement', name: 'Continue to review', documentEpoch });
    assert.equal(reads, 2);
    assert.equal(documentWaits, 0, 'Detachment does not pretend a new document loaded.');
    assert.equal(pauses, 1);
  }
});

test('Detached-target retries stop after three reads; closed pages and other failures stay immediate', async () => {
  let reads = 0;
  const page = {
    isClosed: () => false,
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
  } as unknown as Page;
  await assert.rejects(
    () =>
      readPage(page, async () => {
        reads++;
        throw Error('locator.ariaSnapshot: Element is not attached to the DOM');
      }),
    /not attached/,
  );
  assert.equal(reads, 3);
  for (const message of [
    'Frame was detached',
    'A source is missing',
    'Locator timeout exceeded',
    'Element is not attached to a required account',
  ]) {
    reads = 0;
    await assert.rejects(
      () =>
        readPage(page, async () => {
          reads++;
          throw Error(message);
        }),
      (error) => error instanceof Error && error.message === message,
    );
    assert.equal(reads, 1);
  }
  reads = 0;
  await assert.rejects(
    () =>
      readPage({ ...page, isClosed: () => true } as Page, async () => {
        reads++;
        throw Error('Element is not attached to the DOM');
      }),
    /not attached/,
  );
  assert.equal(reads, 1);
});
