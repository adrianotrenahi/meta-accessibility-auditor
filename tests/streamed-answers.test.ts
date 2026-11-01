import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MetaTransportError, postMeta } from '../src/meta-transport.js';

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

test('A stream that ends early or reports an error is an uncertain answer, never repeated', async () => {
  for (const text of [
    sse([{ type: 'response.created', response: { status: 'in_progress' } }]),
    sse([{ type: 'error', code: 'server_error', message: 'x' }]),
  ]) {
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
