import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { metaOperationEvidence } from '../src/meta-operation-evidence.js';
import { MetaTransportError, postMeta, type MetaRetry } from '../src/meta-transport.js';
import { MetaModels, actionSchema } from '../src/models.js';
import { Store } from '../src/store.js';

const privateText = 'Bearer private-key https://private.invalid/secret 192.0.2.40';
const codes = new Set(['ETIMEDOUT', 'EHOSTUNREACH', 'ECONNRESET', 'ENOTFOUND']);
const leaf = (code: string, syscall?: string) =>
  Object.assign(Error(privateText), {
    code,
    syscall,
    address: privateText,
    hostname: privateText,
    stack: privateText,
  });
const mixed = () =>
  new TypeError(privateText, {
    cause: new AggregateError(
      [leaf('ETIMEDOUT', 'connect'), leaf('EHOSTUNREACH', 'connect')],
      privateText,
    ),
  });

test('Connection details retain only recognised operations and codes, never raw exception text', () => {
  const error = new TypeError(privateText, {
    cause: new AggregateError(
      [
        leaf('ETIMEDOUT', 'connect'),
        leaf('ETIMEDOUT', 'read'),
        leaf('ECONNRESET', 'write'),
        leaf('ENOTFOUND', 'getaddrinfo'),
        leaf(privateText, privateText),
        leaf('ETIMEDOUT', 'connect'),
      ],
      privateText,
    ),
  });
  const result = metaOperationEvidence(error, codes);
  assert.deepEqual(result, {
    causeOperations: [
      { code: 'ETIMEDOUT', operation: 'connect' },
      { code: 'ETIMEDOUT', operation: 'read' },
      { code: 'ECONNRESET', operation: 'write' },
      { code: 'ENOTFOUND', operation: 'lookup' },
      { code: 'OTHER', operation: 'unknown' },
    ],
  });
  assert(!JSON.stringify(result).includes(privateText));
});

test('Missing, circular, oversized and too-deep details remain explicitly incomplete or unknown', () => {
  assert.deepEqual(metaOperationEvidence(Error(privateText), codes), {
    causeOperations: [{ code: 'OTHER', operation: 'unknown' }],
  });
  const circular = Object.assign(Error(privateText), { cause: undefined as unknown });
  circular.cause = circular;
  let deep: Error = leaf('ETIMEDOUT', 'connect');
  for (let i = 0; i < 6; i++) deep = Error(privateText, { cause: deep });
  for (const error of [
    null,
    circular,
    deep,
    new AggregateError(Array(9).fill(mixed()), privateText),
  ]) {
    const result = metaOperationEvidence(error, codes);
    assert.equal(result.causeOperationsIncomplete, true);
    assert(result.causeOperations.length <= 16);
    assert(!JSON.stringify(result).includes(privateText));
  }
});

test('Diagnostic collection does not call exception or nested-array getters', () => {
  let calls = 0;
  const fail = () => {
    calls++;
    throw Error('A diagnostic must not replace the original failure.');
  };
  const error = Error(privateText);
  Object.defineProperties(error, { code: { get: fail }, syscall: { get: fail } });
  assert.equal(metaOperationEvidence(error, codes).causeOperationsIncomplete, true);
  const errors = [error];
  Object.defineProperty(errors, '0', { get: fail });
  const result = metaOperationEvidence(Object.assign(Error(privateText), { errors }), codes);
  assert.equal(calls, 0);
  assert.equal(result.causeOperationsIncomplete, true);
  const revoked = Proxy.revocable([], {});
  revoked.revoke();
  assert.equal(
    metaOperationEvidence(Object.assign(Error(privateText), { errors: revoked.proxy }), codes)
      .causeOperationsIncomplete,
    true,
  );
});

test('Connect-labelled generation failures still make one attempt and retain the full unknown charge', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'meta-operation-evidence-'));
  const store = new Store(dir);
  const run = store.create('Offline connection diagnostics', 'http://127.0.0.1/shop/', 'offline');
  let generations = 0;
  const models = new MetaModels(
    store,
    (async (url) => {
      if (String(url).endsWith('/input_tokens'))
        return new Response(JSON.stringify({ input_tokens: 100 }));
      generations++;
      await wait(15);
      throw mixed();
    }) as typeof fetch,
    () => ({
      approvedBy: 'Adriano',
      maxUsd: 3,
      maxRunUsd: 1,
      approvedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
    () => privateText,
  );
  try {
    await assert.rejects(
      () => models.reason(run.id, 'driver', [], [], actionSchema),
      (error) => error instanceof MetaTransportError && !error.generationNotSent,
    );
    assert.equal(generations, 1, 'Saved operation evidence cannot authorise another generation.');
    const usage = store.usage(run.id);
    assert.equal(usage.requests.length, 1);
    assert.equal(usage.requests[0].status, 'unknown');
    assert.equal(usage.requests[0].actual, null);
    assert.equal(usage.spent, 0);
    assert.equal(usage.reserved, usage.requests[0].reserved);
    const record = store
      .records(run.id)
      .find((r) => r.payload.method === 'meta_connection_failure')!;
    assert(record);
    const d = record.payload.diagnostic;
    assert.equal(d.stage, 'requesting');
    assert.equal(d.attempts, 1);
    assert(Number.isInteger(d.attemptElapsedMs) && d.attemptElapsedMs >= 10);
    assert.deepEqual(d.causeOperations, [
      { code: 'ETIMEDOUT', operation: 'connect' },
      { code: 'EHOSTUNREACH', operation: 'connect' },
    ]);
    assert(!JSON.stringify(record).includes(privateText));
    assert.equal(store.published(run.id).length, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Each count retry and HTTP failure records its own elapsed attempt without inventing operations', async () => {
  let calls = 0;
  const retries: MetaRetry[] = [];
  await assert.rejects(
    () =>
      postMeta({
        phase: 'input_count',
        body: { model: 'offline' },
        apiKey: privateText,
        signal: new AbortController().signal,
        assertActive: () => {},
        fetcher: (async () => {
          calls++;
          return new Response('{}', { status: 503 });
        }) as typeof fetch,
        wait: async () => {},
        onRetry: (retry) => retries.push(retry),
      }),
    (error) => {
      assert(error instanceof MetaTransportError);
      assert.equal(error.diagnostic.attempts, 3);
      assert.equal(error.diagnostic.stage, 'http');
      assert.equal(error.diagnostic.causeOperations, undefined);
      assert(Number.isInteger(error.diagnostic.attemptElapsedMs));
      return true;
    },
  );
  assert.equal(calls, 3);
  assert.equal(retries.length, 2);
  assert(retries.every((r) => Number.isInteger(r.attemptElapsedMs) && r.attemptElapsedMs! >= 0));
});
