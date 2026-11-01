import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MetaTransportError, postMeta } from '../src/meta-transport.js';
import { Store } from '../src/store.js';
import { MetaModels, analysisSchema } from '../src/models.js';

// Owner, 1 Nov: the final Booking.com review was cut at 60.4 s ("UND_ERR_SOCKET", before any
// reply). Meta limits how long a silent answer may take; a streamed answer is exempt.
const final = { status: 'completed', usage: { input_tokens: 10, output_tokens: 2 }, output: [] };
const sse = (events: unknown[]) =>
  events.map((event) => `event: x\ndata: ${JSON.stringify(event)}\n\n`).join('');
function streamed(text: string, pieces = 7) {
  const size = Math.ceil(text.length / pieces);
  let sent = 0;
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (sent >= text.length) return controller.close();
        controller.enqueue(new TextEncoder().encode(text.slice(sent, (sent += size))));
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } },
  );
}
const send = (response: () => Response, seen: Headers[] = []) =>
  postMeta({
    phase: 'generation',
    body: { model: 'm', stream: true },
    apiKey: 'mock-key-no-provider-access',
    signal: new AbortController().signal,
    fetcher: (async (_url: unknown, init: RequestInit) => {
      seen.push(new Headers(init.headers));
      return response();
    }) as typeof fetch,
    assertActive: () => {},
    wait: async () => {},
  });

test('A streamed answer is read in pieces until Meta’s final event, which carries the result', async () => {
  const seen: Headers[] = [];
  const text = sse([
    { type: 'response.created', sequence_number: 0, response: { status: 'in_progress' } },
    { type: 'response.output_text.delta', sequence_number: 1, delta: '{"find' },
    { type: 'response.output_text.delta', sequence_number: 2, delta: 'ings":[]}' },
    { type: 'response.completed', sequence_number: 3, response: final },
  ]);
  assert.deepEqual(await send(() => streamed(text, 13), seen), final);
  assert.equal(seen[0]!.get('accept'), 'text/event-stream');
  // An answer cut short by its space limit is returned as incomplete, not lost.
  const incomplete = { ...final, status: 'incomplete' };
  assert.deepEqual(
    await send(() => streamed(sse([{ type: 'response.incomplete', response: incomplete }]))),
    incomplete,
  );
  // A plain JSON reply (the offline fakes) is still read as before.
  assert.deepEqual(await send(() => Response.json(final)), final);
});

const cutOff = [
  sse([{ type: 'response.created', response: { status: 'in_progress' } }]),
  sse([{ type: 'error', code: 'server_error', message: 'x' }]),
  // Loca and the review-judge, PR 69: a failed answer that carries no cost.
  sse([{ type: 'response.failed', response: { status: 'failed', output: [], error: {} } }]),
];
test('A stream that ends early or reports an error is an uncertain answer, never repeated', async () => {
  for (const text of cutOff) {
    let calls = 0;
    await assert.rejects(
      send(() => {
        calls++;
        return streamed(text);
      }),
      (error: unknown) =>
        error instanceof MetaTransportError &&
        error.diagnostic.stage === 'reading' &&
        error.diagnostic.code === 'STREAM_ENDED' &&
        !error.generationNotSent &&
        // A dropped answer lets the walk continue, as a closed connection always did.
        error.analysisMayContinue,
    );
    assert.equal(calls, 1, 'a possibly charged answer is not asked for twice');
  }
});

// Loca, PR 69: the money set aside stays held through a whole analyst request, not only in
// the connection code, and the audit's walk may carry on.
test('A cut-off streamed answer keeps its money held and lets the walk continue', async () => {
  for (const text of cutOff) {
    const dir = mkdtempSync(join(tmpdir(), 'streamed-answer-'));
    const store = new Store(dir);
    const run = store.create('Streamed answer', 'http://127.0.0.1:4317/shop/', 'offline');
    let generations = 0;
    const models = new MetaModels(
      store,
      (async (url: unknown) => {
        if (String(url).endsWith('/input_tokens')) return Response.json({ input_tokens: 1000 });
        generations++;
        return streamed(text);
      }) as typeof fetch,
      () => ({
        approvedBy: 'Adriano',
        maxUsd: 10,
        maxRunUsd: 3,
        approvedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
      () => 'mock-key-no-provider-access',
    );
    try {
      await assert.rejects(
        models.reason(run.id, 'analyst', [], [], analysisSchema),
        (error: unknown) => error instanceof MetaTransportError && error.analysisMayContinue,
      );
      assert.equal(generations, 1);
      const ledger = store.usage(run.id);
      assert.equal(ledger.requests[0]!.status, 'unknown');
      assert.equal(ledger.spent, 0);
      assert(ledger.reserved > 0);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('A failed answer that carries its cost is recorded as billed and incomplete', async () => {
  const failed = { status: 'failed', usage: { input_tokens: 10, output_tokens: 2 }, output: [] };
  assert.deepEqual(
    await send(() => streamed(sse([{ type: 'response.failed', response: failed }]))),
    failed,
  );
});
