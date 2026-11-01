import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  MetaTransportError,
  postMeta,
  waitForMetaRetry,
  type MetaPhase,
  type MetaRetry,
} from '../src/meta-transport.js';
import { MetaModels, actionSchema } from '../src/models.js';
import { Store } from '../src/store.js';
const fakeKey = 'mock-private-key-no-provider';
const body = {
  model: 'muse-spark-1.3',
  store: false,
  input: [
    {
      role: 'user',
      content: [
        { type: 'input_text', text: 'Original retained input' },
        { type: 'input_image', image_url: 'data:image/png;base64,b3JpZ2luYWw=' },
      ],
    },
  ],
};
const response = (value: any = { input_tokens: 123 }, status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(value), { status, headers });
const network = (code?: string, cause?: unknown) =>
  new TypeError('fetch failed', {
    cause: code
      ? Object.assign(Error('untrusted hostname/Bearer/private-key'), {
          code,
          ...(cause ? { cause } : {}),
        })
      : cause,
  });
const approved = () => ({
  approvedBy: 'Adriano' as const,
  maxUsd: 10,
  maxRunUsd: 3,
  approvedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60000).toISOString(),
});
const answer = { kind: 'press', key: 'Tab', note: 'Move through the actual keyboard controls.' };
const completed = {
  status: 'completed',
  usage: { input_tokens: 123, output_tokens: 20 },
  output: [{ type: 'function_call', name: 'return_result', arguments: JSON.stringify(answer) }],
};
function transport(phase: MetaPhase, fetcher: typeof fetch, changes: Record<string, unknown> = {}) {
  const events: MetaRetry[] = [];
  let activeChecks = 0;
  const call = () =>
    postMeta({
      phase,
      body,
      apiKey: fakeKey,
      signal: new AbortController().signal,
      fetcher,
      assertActive: () => {
        activeChecks++;
      },
      onRetry: (event) => events.push(event),
      wait: async () => {},
      ...changes,
    });
  return { call, events, activeChecks: () => activeChecks };
}
function setupModel(fetcher: typeof fetch) {
  const dir = mkdtempSync(join(tmpdir(), 'access-walk-meta-transport-'));
  const store = new Store(dir);
  const run = store.create('Offline transport failure proof', 'http://127.0.0.1/shop/', 'offline');
  const models = new MetaModels(store, fetcher, approved, () => fakeKey);
  return {
    store,
    run,
    models,
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('An input-count connection glitch retries the exact body and never invokes generation', async () => {
  const requests: RequestInit[] = [];
  const x = transport('input_count', (async (url, init) => {
    assert.equal(String(url), 'https://api.meta.ai/v1/responses/input_tokens');
    requests.push(init!);
    if (requests.length === 1) throw network('ECONNRESET');
    return response();
  }) as typeof fetch);
  assert.deepEqual(await x.call(), { input_tokens: 123 });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].body, requests[1].body);
  assert.deepEqual(JSON.parse(String(requests[1].body)), body);
  assert(requests.every((r) => r.redirect === 'manual'));
  assert.equal(x.events.length, 1);
  assert.equal(x.events[0].code, 'ECONNRESET');
});

test('Count failures stop after three attempts with scrubbed stage diagnostics', async () => {
  let calls = 0;
  const x = transport('input_count', (async () => {
    calls++;
    throw network();
  }) as typeof fetch);
  await assert.rejects(
    x.call,
    (error) =>
      error instanceof MetaTransportError &&
      error.diagnostic.attempts === 3 &&
      error.diagnostic.phase === 'input_count' &&
      error.diagnostic.code === 'CONNECTION_UNKNOWN',
  );
  assert.equal(calls, 3);
  assert.equal(x.events.length, 2);
  assert(!JSON.stringify(x.events).includes(fakeKey));
});

test('Only documented transient count statuses retry, respecting bounded Retry-After', async () => {
  for (const status of [408, 429, 500, 502, 503, 504]) {
    let calls = 0;
    const x = transport('input_count', (async () =>
      ++calls === 1
        ? response({}, status, { 'retry-after': '0.01' })
        : response()) as typeof fetch);
    await x.call();
    assert.equal(calls, 2);
    assert.equal(x.events[0].delayMs, 10);
  }
  for (const [status, header] of [
    [400, undefined],
    [401, undefined],
    [403, undefined],
    [302, undefined],
    [413, undefined],
    [429, '60'],
  ] as const) {
    let calls = 0;
    const x = transport('input_count', (async () => {
      calls++;
      return response({}, status, header ? { 'retry-after': header } : {});
    }) as typeof fetch);
    await assert.rejects(x.call, MetaTransportError);
    assert.equal(calls, 1);
    assert.deepEqual(x.events, []);
  }
});

test('Generation retries only proved pre-connect errors before any response exists', async () => {
  for (const code of ['ENOTFOUND', 'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT']) {
    let calls = 0;
    const x = transport('generation', (async (_url, init) => {
      assert.equal(init?.redirect, 'manual');
      if (++calls === 1) throw network(code);
      return response(completed);
    }) as typeof fetch);
    assert.deepEqual(await x.call(), completed);
    assert.equal(calls, 2);
    assert.equal(x.events.length, 1);
    assert.equal(x.events[0].code, code);
  }
});

test('Repeated proved pre-connect failures stop at two generation attempts', async () => {
  let calls = 0;
  const x = transport('generation', (async () => {
    calls++;
    throw network('ECONNREFUSED');
  }) as typeof fetch);
  await assert.rejects(
    x.call,
    (error) => error instanceof MetaTransportError && error.diagnostic.attempts === 2,
  );
  assert.equal(calls, 2);
  assert.equal(x.events.length, 1);
});

test('Ambiguous generation failures, mixed causes and resets are never replayed', async () => {
  const failures = [
    network(),
    network('ECONNRESET'),
    network('EPIPE'),
    network('UND_ERR_SOCKET'),
    network('ETIMEDOUT'),
    network('UND_ERR_HEADERS_TIMEOUT'),
    network('UND_ERR_BODY_TIMEOUT'),
    network('ENOTFOUND', Object.assign(Error('nested ambiguous failure'), { code: 'ECONNRESET' })),
    network('ENOTFOUND', Error('nested failure with no documented code')),
    network('ENOTFOUND', {}),
    new TypeError('fetch failed', {
      cause: new AggregateError([
        Object.assign(Error(), { code: 'ENOTFOUND' }),
        Error('another failure with no documented code'),
      ]),
    }),
    network(
      'ENOTFOUND',
      Object.assign(Error('nested unknown failure'), { code: 'UNKNOWN_PRIVATE_VALUE' }),
    ),
    new TypeError('fetch failed', {
      cause: new AggregateError([
        Object.assign(Error(), { code: 'ENOTFOUND' }),
        Object.assign(Error(), { code: 'ECONNRESET' }),
      ]),
    }),
  ];
  for (const error of failures) {
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

test('No generation HTTP response or malformed JSON earns a retry', async () => {
  for (const status of [302, 400, 401, 408, 429, 500, 503]) {
    let calls = 0;
    const x = transport('generation', (async () => {
      calls++;
      return response({}, status);
    }) as typeof fetch);
    await assert.rejects(x.call, MetaTransportError);
    assert.equal(calls, 1);
  }
  for (const phase of ['input_count', 'generation'] as const) {
    let calls = 0;
    const x = transport(phase, (async () => {
      calls++;
      return new Response('not JSON');
    }) as typeof fetch);
    await assert.rejects(
      x.call,
      (error) =>
        error instanceof MetaTransportError &&
        error.diagnostic.stage === 'reading' &&
        error.diagnostic.code === 'INVALID_JSON',
    );
    assert.equal(calls, 1);
  }
});

test('A pre-connect-looking error while reading generation output is not retried', async () => {
  let calls = 0;
  const x = transport('generation', (async () => {
    calls++;
    return Object.assign(response(), {
      json: async () => {
        throw network('ENOTFOUND');
      },
    });
  }) as typeof fetch);
  await assert.rejects(
    x.call,
    (error) => error instanceof MetaTransportError && error.diagnostic.stage === 'reading',
  );
  assert.equal(calls, 1);
  assert.deepEqual(x.events, []);
});

test('Stop and abort before another attempt forbid reconnecting or generation', async () => {
  let active = true,
    calls = 0;
  const x = transport(
    'input_count',
    (async () => {
      calls++;
      throw network();
    }) as typeof fetch,
    {
      assertActive: () => {
        if (!active) throw Error('Run stopped');
      },
      wait: async () => {
        active = false;
      },
    },
  );
  await assert.rejects(x.call, /Run stopped/);
  assert.equal(calls, 1);
  const controller = new AbortController();
  calls = 0;
  const y = transport(
    'generation',
    (async () => {
      calls++;
      throw network('ENOTFOUND');
    }) as typeof fetch,
    {
      signal: controller.signal,
      wait: async () => {
        controller.abort();
      },
    },
  );
  await assert.rejects(y.call);
  assert.equal(calls, 1);
  calls = 0;
  const z = transport(
    'input_count',
    (async () => {
      calls++;
      return response();
    }) as typeof fetch,
    { signal: controller.signal },
  );
  await assert.rejects(z.call);
  assert.equal(calls, 0);
  const deadline = new AbortController();
  let timedCalls = 0;
  const timed = transport(
    'input_count',
    (async () => {
      timedCalls++;
      deadline.abort(new DOMException('deadline', 'TimeoutError'));
      throw deadline.signal.reason;
    }) as typeof fetch,
    { signal: deadline.signal },
  );
  await assert.rejects(timed.call);
  assert.equal(timedCalls, 1);
  assert.deepEqual(timed.events, []);
});

test('Backoff can be aborted without leaving a retry timer alive', async () => {
  const controller = new AbortController();
  const waiting = waitForMetaRetry(10000, controller.signal);
  controller.abort();
  await assert.rejects(waiting);
});

test('Count reconnects stay before one reservation; generation reconnects reuse only that reservation', async () => {
  const requests: { url: string; body: any }[] = [];
  let counts = 0,
    generations = 0;
  const x = setupModel((async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    if (String(url).endsWith('input_tokens')) {
      if (++counts === 1) throw network('ECONNRESET');
      assert.equal(x.store.usage().requests.length, 0);
      return response();
    }
    generations++;
    const ledger = x.store.usage(x.run.id);
    assert.equal(ledger.requests.length, 1);
    assert(ledger.reserved > 0);
    if (generations === 1) throw network('ECONNREFUSED');
    return response(completed);
  }) as typeof fetch);
  try {
    assert.deepEqual(await x.models.reason(x.run.id, 'driver', [], [], actionSchema), answer);
    assert.equal(counts, 2);
    assert.equal(generations, 2);
    assert.equal(x.store.usage().requests.length, 1);
    assert.equal(x.store.usage().requests[0].status, 'completed');
    assert.equal(x.store.usage().reserved, 0);
    // Owner, 1 Nov: generations add only the prompt-cache label to the counted request.
    const unlabelled = ({ prompt_cache_key: _key, stream: _stream, ...body }: any) => JSON.stringify(body);
    assert(requests.every((r) => unlabelled(r.body) === unlabelled(requests[0].body)));
    const retryRecords = x.store
      .records(x.run.id)
      .filter((r) => r.payload.method === 'meta_connection_retry');
    assert.deepEqual(
      retryRecords.map((r) => r.payload.diagnostic.phase),
      ['input_count', 'generation'],
    );
    assert.deepEqual(
      retryRecords.map((r) => r.payload.diagnostic.code),
      ['ECONNRESET', 'ECONNREFUSED'],
    );
    assert.match(
      retryRecords[0].payload.reason,
      /prepare this same request.*No new model generation/,
    );
    assert.match(retryRecords[1].payload.reason, /before any request could reach Meta/);
  } finally {
    x.close();
  }
});

test('An unknown generation charge stays held exactly once and safe limits omit secrets', async () => {
  let generations = 0;
  const x = setupModel((async (url) => {
    if (String(url).endsWith('input_tokens')) return response();
    generations++;
    throw network('ECONNRESET');
  }) as typeof fetch);
  try {
    await assert.rejects(
      () => x.models.reason(x.run.id, 'driver', [], [], actionSchema),
      /possible charge remains reserved/,
    );
    assert.equal(generations, 1);
    const ledger = x.store.usage();
    assert.equal(ledger.requests.length, 1);
    assert.equal(ledger.requests[0].status, 'unknown');
    assert.equal(ledger.spent, 0);
    assert(ledger.reserved > 0);
    const saved = x.store
      .records(x.run.id)
      .find((r) => r.payload.method === 'meta_connection_failure')!;
    assert.equal(saved.payload.diagnostic.code, 'ECONNRESET');
    const text = JSON.stringify(saved);
    assert(!text.includes(fakeKey));
    assert(!text.includes('untrusted hostname'));
    assert(!text.includes('Bearer/private-key'));
    assert.equal(x.store.published(x.run.id).length, 0);
  } finally {
    x.close();
  }
});

test('Permanent count failure cannot create a paid reservation or generation', async () => {
  let calls = 0;
  const x = setupModel((async () => {
    calls++;
    return response({}, 401);
  }) as typeof fetch);
  try {
    await assert.rejects(
      () => x.models.reason(x.run.id, 'driver', [], [], actionSchema),
      /No new model generation/,
    );
    assert.equal(calls, 1);
    assert.deepEqual(x.store.usage().requests, []);
  } finally {
    x.close();
  }
});

async function listen(server: Server, port = 0) {
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as { port: number }).port;
}
async function close(server: Server) {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

test('Actual Node refused connection reconnects once without sending a duplicate HTTP request', async () => {
  const placeholder = createServer();
  const port = await listen(placeholder);
  await close(placeholder);
  let acceptedRequests = 0,
    calls = 0;
  const server = createServer((_req, res) => {
    acceptedRequests++;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(completed));
  });
  const x = transport('generation', (async (_url, init) => {
    calls++;
    if (calls === 2) await listen(server, port);
    return fetch(`http://127.0.0.1:${port}/responses`, init);
  }) as typeof fetch);
  try {
    assert.deepEqual(await x.call(), completed);
    assert.equal(calls, 2);
    assert.equal(acceptedRequests, 1);
    assert.equal(x.events[0].code, 'ECONNREFUSED');
    assert.deepEqual(x.events[0].causeOperations, [{ code: 'ECONNREFUSED', operation: 'connect' }]);
    assert(Number.isInteger(x.events[0].attemptElapsedMs));
  } finally {
    if (server.listening) await close(server);
  }
});

test('A real HTTP redirect cannot hide a delivered generation before a later connection error', async () => {
  const paths: string[] = [];
  const server = createServer((req, res) => {
    paths.push(req.url!);
    res.writeHead(302, { location: '/redirected' });
    res.end();
  });
  const port = await listen(server);
  const x = transport('generation', (async (_url, init) =>
    fetch(`http://127.0.0.1:${port}/original`, init)) as typeof fetch);
  try {
    await assert.rejects(
      x.call,
      (error) => error instanceof MetaTransportError && error.diagnostic.status === 302,
    );
    assert.deepEqual(paths, ['/original']);
    assert.deepEqual(x.events, []);
  } finally {
    await close(server);
  }
});

test('Proved-unsent exhaustion releases only its new logical reservation for navigation and SAM', async () => {
  for (const operation of ['driver', 'sam'] as const) {
    let generations = 0;
    const x = setupModel((async (url) => {
      if (String(url).endsWith('input_tokens')) return response();
      generations++;
      throw network('ECONNREFUSED');
    }) as typeof fetch);
    try {
      const old = x.store.create(
        'Earlier unknown model outcome',
        'http://127.0.0.1/shop/',
        'offline',
      );
      x.store.db
        .prepare('INSERT INTO requests VALUES(?,?,?,?,?,?,?)')
        .run(
          'historical-unknown',
          old.id,
          'driver',
          78087,
          null,
          'unknown',
          new Date().toISOString(),
        );
      x.store.finish(old.id, 'partial', 'Earlier uncertain request remains held.');
      await assert.rejects(() =>
        operation === 'driver'
          ? x.models.reason(x.run.id, 'driver', [], [], actionSchema)
          : x.models.sam(x.run.id, 'data:image/png;base64,b3JpZ2luYWw=', 'original target', {
              width: 1,
              height: 1,
            }),
      );
      assert.equal(generations, 2);
      const current = x.store.usage(x.run.id);
      assert.equal(current.requests.length, 1);
      assert.equal(current.requests[0].status, 'not_sent');
      assert.equal(current.requests[0].actual, 0);
      assert.equal(current.reserved, 0);
      const oldCharge = x.store.usage(old.id);
      assert.equal(oldCharge.reserved, 78087);
      assert.equal(oldCharge.requests[0].status, 'unknown');
      assert.equal(oldCharge.requests[0].actual, null);
    } finally {
      x.close();
    }
  }
});

test('A proved-unsent first attempt cannot release a later ambiguous generation hold', async () => {
  let generations = 0;
  const x = setupModel((async (url) => {
    if (String(url).endsWith('input_tokens')) return response();
    throw network(++generations === 1 ? 'ECONNREFUSED' : 'ECONNRESET');
  }) as typeof fetch);
  try {
    await assert.rejects(() => x.models.reason(x.run.id, 'driver', [], [], actionSchema));
    assert.equal(generations, 2);
    assert.equal(x.store.usage().requests[0].status, 'unknown');
    assert.equal(x.store.usage().requests[0].actual, null);
    assert(x.store.usage().reserved > 0);
  } finally {
    x.close();
  }
});

test('Mixed connection causes are diagnosed as mixed rather than an address-lookup failure', async () => {
  const x = transport('generation', (async () => {
    throw network('ENOTFOUND', Object.assign(Error(), { code: 'ECONNRESET' }));
  }) as typeof fetch);
  await assert.rejects(
    x.call,
    (error) => error instanceof MetaTransportError && error.diagnostic.code === 'MIXED_CAUSES',
  );
  assert.deepEqual(x.events, []);
});
