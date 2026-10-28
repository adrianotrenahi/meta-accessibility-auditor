import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  postMeta,
  MetaTransportError,
  type MetaPhase,
  type MetaRetry,
} from '../src/meta-transport.js';
import { MetaModels, actionSchema } from '../src/models.js';
import { Store } from '../src/store.js';

const privateText = 'untrusted-private-key 203.0.113.99 https://untrusted.invalid/request';
const codeError = (code: string) => Object.assign(Error(privateText), { code });
const mixed = () =>
  new TypeError('fetch failed', {
    cause: new AggregateError([codeError('ETIMEDOUT'), codeError('ECONNRESET')], privateText),
  });
const body = {
  model: 'muse-spark-1.3',
  store: false,
  input: [
    {
      role: 'user',
      content: [
        { type: 'input_text', text: 'Exact saved original' },
        { type: 'input_image', image_url: 'data:image/png;base64,b3JpZ2luYWw=' },
      ],
    },
  ],
};
const response = () => new Response(JSON.stringify({ input_tokens: 123 }));
function transport(phase: MetaPhase, fetcher: typeof fetch, change: Record<string, unknown> = {}) {
  const events: MetaRetry[] = [];
  return {
    events,
    call: () =>
      postMeta({
        phase,
        body,
        apiKey: 'synthetic-private-key',
        signal: new AbortController().signal,
        fetcher,
        assertActive() {},
        wait: async () => {},
        onRetry: (event) => events.push(event),
        ...change,
      }),
  };
}

test('An active input count recovers from aggregate timeout and socket causes with the identical original body', async () => {
  const requests: RequestInit[] = [];
  const x = transport('input_count', (async (url, init) => {
    assert(String(url).endsWith('/responses/input_tokens'));
    requests.push(init!);
    if (requests.length === 1) throw mixed();
    return response();
  }) as typeof fetch);
  assert.deepEqual(await x.call(), { input_tokens: 123 });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].body, requests[1].body);
  assert.deepEqual(JSON.parse(String(requests[1].body)), body);
  assert(requests.every((request) => request.redirect === 'manual'));
  assert.equal(x.events.length, 1);
  assert.equal(x.events[0].code, 'MIXED_CAUSES');
  assert.deepEqual(x.events[0].causeCodes, ['ETIMEDOUT', 'ECONNRESET']);
  assert.equal(x.events[0].generationNotSent, false);
});

test('Known internal count timeouts and cancellation can recover while the parent signal remains live', async () => {
  for (const error of [
    codeError('ETIMEDOUT'),
    codeError('UND_ERR_HEADERS_TIMEOUT'),
    codeError('UND_ERR_BODY_TIMEOUT'),
    codeError('ABORT_ERR'),
    new DOMException(privateText, 'AbortError'),
    new DOMException(privateText, 'TimeoutError'),
  ]) {
    const controller = new AbortController();
    let calls = 0;
    const x = transport(
      'input_count',
      (async () => {
        if (++calls === 1) throw error;
        return response();
      }) as typeof fetch,
      { signal: controller.signal },
    );
    await x.call();
    assert.equal(controller.signal.aborted, false);
    assert.equal(calls, 2);
    assert.equal(x.events.length, 1);
    if (x.events[0].code === 'MIXED_CAUSES')
      assert.deepEqual(x.events[0].causeCodes, ['OTHER', 'ABORT_ERR']);
    else
      assert.equal(x.events[0].causeCodes, undefined, 'Only mixed diagnostics carry a cause list.');
  }
});

test('The same aggregate or internal timeout never earns a generation retry or an unsent claim', async () => {
  for (const error of [
    mixed(),
    codeError('ETIMEDOUT'),
    codeError('UND_ERR_HEADERS_TIMEOUT'),
    codeError('UND_ERR_BODY_TIMEOUT'),
    codeError('ABORT_ERR'),
    new DOMException(privateText, 'AbortError'),
    new DOMException(privateText, 'TimeoutError'),
  ]) {
    let calls = 0;
    const x = transport('generation', (async () => {
      calls++;
      throw error;
    }) as typeof fetch);
    await assert.rejects(
      x.call,
      (error) => error instanceof MetaTransportError && !error.generationNotSent,
    );
    assert.equal(calls, 1);
    assert.deepEqual(x.events, []);
  }
});

test('Mixed count exhaustion stays at three attempts and saves bounded distinct allowlisted causes only', async () => {
  let calls = 0;
  const x = transport('input_count', (async () => {
    calls++;
    throw new TypeError('fetch failed', {
      cause: new AggregateError(
        [
          codeError('ETIMEDOUT'),
          codeError('ECONNRESET'),
          codeError('ECONNRESET'),
          codeError(privateText),
        ],
        privateText,
      ),
    });
  }) as typeof fetch);
  await assert.rejects(x.call, (error) => {
    assert(error instanceof MetaTransportError);
    assert.equal(error.diagnostic.attempts, 3);
    assert.equal(error.diagnostic.code, 'MIXED_CAUSES');
    assert.deepEqual(error.diagnostic.causeCodes, ['ETIMEDOUT', 'ECONNRESET', 'OTHER']);
    assert(error.diagnostic.causeCodes.length <= 16);
    assert(!JSON.stringify(error.diagnostic).includes(privateText));
    return true;
  });
  assert.equal(calls, 3);
  assert.equal(x.events.length, 2);
  assert(x.events.every((event) => event.causeCodes?.length === new Set(event.causeCodes).size));
});

test('Real parent abort, parent deadline and owner Stop still prevent a count reconnect', async () => {
  for (const name of ['AbortError', 'TimeoutError']) {
    const controller = new AbortController();
    let calls = 0;
    const x = transport(
      'input_count',
      (async () => {
        calls++;
        controller.abort(new DOMException('Parent stopped', name));
        throw mixed();
      }) as typeof fetch,
      { signal: controller.signal },
    );
    await assert.rejects(x.call, (error) => error === controller.signal.reason);
    assert.equal(calls, 1);
    assert.deepEqual(x.events, []);
  }
  let active = true,
    calls = 0;
  const stopped = transport(
    'input_count',
    (async () => {
      calls++;
      active = false;
      throw mixed();
    }) as typeof fetch,
    {
      assertActive() {
        if (!active) throw Error('Owner stopped this run');
      },
    },
  );
  await assert.rejects(stopped.call, /Owner stopped/);
  assert.equal(calls, 1);
  assert.deepEqual(stopped.events, []);
});

test('A count timeout while reading its non-generating answer can recover but malformed JSON cannot', async () => {
  let calls = 0;
  const x = transport('input_count', (async () => {
    if (++calls === 1)
      return Object.assign(response(), {
        json: async () => {
          throw codeError('UND_ERR_BODY_TIMEOUT');
        },
      });
    return response();
  }) as typeof fetch);
  await x.call();
  assert.equal(calls, 2);
  assert.equal(x.events[0].stage, 'reading');
  assert.equal(x.events[0].causeCodes, undefined);
  calls = 0;
  const invalid = transport('input_count', (async () => {
    calls++;
    return new Response('not JSON');
  }) as typeof fetch);
  await assert.rejects(invalid.call, MetaTransportError);
  assert.equal(calls, 1);
  assert.deepEqual(invalid.events, []);
});

test('Recovered counts create no reservation and later uncertain generation remains held exactly once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'access-walk-count-timeout-'));
  const store = new Store(dir),
    run = store.create('Offline count recovery proof', 'http://127.0.0.1/shop', 'offline');
  let counts = 0,
    generations = 0;
  const models = new MetaModels(
    store,
    (async (url) => {
      if (String(url).endsWith('input_tokens')) {
        assert.equal(store.usage().requests.length, 0);
        if (++counts === 1) throw mixed();
        return response();
      }
      generations++;
      assert.equal(store.usage().requests.length, 1);
      throw mixed();
    }) as typeof fetch,
    () => ({
      approvedBy: 'Adriano',
      maxUsd: 5,
      maxRunUsd: 3,
      approvedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    }),
    () => 'synthetic-private-key',
  );
  try {
    await assert.rejects(
      () => models.reason(run.id, 'driver', [], [], actionSchema),
      /possible charge remains reserved/,
    );
    assert.equal(counts, 2);
    assert.equal(generations, 1);
    const usage = store.usage();
    assert.equal(usage.requests.length, 1);
    assert.equal(usage.requests[0].status, 'unknown');
    assert.equal(usage.requests[0].actual, null);
    assert(usage.reserved > 0);
    const diagnostics = store
      .records(run.id)
      .filter((record) => record.payload.method?.startsWith('meta_connection_'));
    assert.deepEqual(
      diagnostics.map((record) => record.payload.diagnostic.phase),
      ['input_count', 'generation'],
    );
    assert(
      diagnostics.every(
        (record) =>
          JSON.stringify(record.payload.diagnostic.causeCodes) ===
          JSON.stringify(['ETIMEDOUT', 'ECONNRESET']),
      ),
    );
    assert(!JSON.stringify(diagnostics).includes(privateText));
    assert(!JSON.stringify(diagnostics).includes('synthetic-private-key'));
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
