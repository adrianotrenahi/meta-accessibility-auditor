import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, NAVIGATOR_RECENT_DECISIONS, navigatorWindowStart } from '../src/store.js';
import { CAPS, MODEL_PRICES, tokenCostMicros } from '../src/types.js';
import { MetaModels, analysisSchema } from '../src/models.js';

// Owner, 1 Nov: "do the cache, it will be meaningful if we change the model". Meta reuses the
// identical opening of a recent request and bills it at a lower rate; only 4% was reused on
// the 1 Nov Booking.com audit.

test('Each request carries its audit and role label; the size check does not', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'prompt-cache-'));
  const store = new Store(dir);
  const run = store.create('Cache label', 'http://127.0.0.1:4317/shop/', 'offline');
  const sent: { url: string; body: any }[] = [];
  const usage = {
    input_tokens: 1000,
    output_tokens: 20,
    input_tokens_details: { cached_tokens: 800 },
  };
  const result = {
    findings: [],
    coverage: [],
    visualObservations: [],
    criterionProposals: [],
    missingEvidence: [],
  };
  const model = new MetaModels(
    store,
    (async (url, init) => {
      sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      const body = String(url).endsWith('/input_tokens')
        ? { input_tokens: 1000 }
        : {
            status: 'completed',
            usage,
            output: [
              {
                id: 'msg',
                type: 'message',
                status: 'completed',
                role: 'assistant',
                content: [{ type: 'output_text', text: JSON.stringify(result), annotations: [] }],
              },
            ],
          };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
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
    await model.reason(run.id, 'analyst', [], [], analysisSchema);
    const count = sent.find((r) => r.url.endsWith('/input_tokens'))!;
    const generation = sent.find((r) => r.url.endsWith('/responses'))!;
    assert(!('prompt_cache_key' in count.body), 'the size check is sent without the label');
    assert(!('stream' in count.body), 'the size check is not streamed');
    assert.equal(generation.body.prompt_cache_key, `analyst:${run.id}`);
    // The reused part is charged at the cached rate, as Meta bills it.
    const model_ = CAPS.analyst.model;
    assert.equal(store.usage(run.id).spent, tokenCostMicros(model_, 1000, 20, 800));
    assert(tokenCostMicros(model_, 1000, 20, 800) < tokenCostMicros(model_, 1000, 20));
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Reused input is priced at the cached rate, never more than was sent', () => {
  const m = 'muse-spark-1.3-contributor' as const;
  assert.equal(MODEL_PRICES[m].cachedInput, 2, '$0.002 per million, dev.meta.ai pricing');
  // 1,000,000 input of which 900,000 reused: 100,000 x 100 + 900,000 x 2 billionths.
  assert.equal(tokenCostMicros(m, 1_000_000, 0, 900_000), 11_800);
  assert.equal(tokenCostMicros(m, 1000, 0, 5000), tokenCostMicros(m, 1000, 0, 1000));
  for (const odd of [undefined, -5, 1.5, Number.NaN])
    assert.equal(tokenCostMicros(m, 1000, 0, odd as any), tokenCostMicros(m, 1000, 0));
});

test('The navigator reads its history in blocks of eight, so its opening repeats', () => {
  const dir = mkdtempSync(join(tmpdir(), 'navigator-blocks-'));
  const store = new Store(dir);
  try {
    const run = store.create('Blocks', 'http://127.0.0.1/', 'offline');
    store.append(run.id, 'plan', 'driver', { steps: [] });
    const notes = [];
    const opened: string[][] = [];
    for (let i = 0; i < 40; i++) {
      notes.push(
        store.append(run.id, 'navigator_note', 'driver', { kind: 'progress', text: `${i}` }),
      );
      store.append(run.id, 'action', 'browser', { action: { kind: 'press', key: 'Tab' } });
      const seen = store.snapshot(run.id, 'driver', []).records;
      const decisions = seen.filter((r) => r.kind === 'navigator_note').length;
      // Always the latest eight at least, and never more than fifteen.
      assert(decisions >= Math.min(notes.length, 8) && decisions <= 15, `${decisions} at ${i}`);
      assert(notes.slice(-Math.min(notes.length, 8)).every((n) => seen.some((r) => r.id === n.id)));
      opened.push(seen.map((r) => r.id));
    }
    // Within a block each request starts exactly like the one before; the window moves 8 at once.
    let repeated = 0;
    for (let i = 1; i < opened.length; i++)
      if (opened[i - 1]!.every((id, k) => opened[i]![k] === id)) repeated++;
    assert(repeated >= 32, `${repeated} of 39 requests began like the previous one`);
    assert.deepEqual([7, 8, 15, 16, 23, 24].map(navigatorWindowStart), [0, 0, 0, 8, 8, 16]);
    assert.equal(NAVIGATOR_RECENT_DECISIONS, 8);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
