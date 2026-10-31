import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { Store, digest } from '../src/store.js';
import { EvidenceRequestLimit } from '../src/request-evidence.js';
import {
  CAPS,
  MODEL_CONTEXT_TOKENS,
  FINAL_REVIEW_RESERVE_MICROS,
  PHASE,
  tokenCostMicros,
} from '../src/types.js';
import {
  MetaModels,
  IncompleteModelResult,
  analysisSchema,
  reviewSchema,
  actionSchema,
} from '../src/models.js';

const analysisResult = {
  findings: [],
  coverage: [],
  visualObservations: [],
  criterionProposals: [],
  missingEvidence: [],
};
const reviewerResult = { decisions: [], criterionDecisions: [] };
const usage = { input_tokens: 100, output_tokens: 20 };
const expectedCost = (role: 'driver' | 'analyst' | 'reviewer') =>
  tokenCostMicros(CAPS[role].model, usage.input_tokens, usage.output_tokens);
const message = (text: string) => ({
  id: 'msg_mock_result',
  type: 'message',
  status: 'completed',
  role: 'assistant',
  content: [{ type: 'output_text', text, annotations: [] }],
});

function setup(response: any, inputTokens = 100, spending = { maxUsd: 10, maxRunUsd: 3 }) {
  const dir = mkdtempSync(join(tmpdir(), 'access-walk-structured-results-'));
  const store = new Store(dir);
  const run = store.create(
    'Mocked constrained result adapter',
    'http://127.0.0.1:4317/shop/',
    'offline',
  );
  const requests: { url: string; body: any }[] = [];
  const model = new MetaModels(
    store,
    (async (url, init) => {
      const requestUrl = String(url);
      requests.push({ url: requestUrl, body: JSON.parse(String(init?.body)) });
      return new Response(
        JSON.stringify(
          requestUrl.endsWith('/input_tokens') ? { input_tokens: inputTokens } : response,
        ),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    }) as typeof fetch,
    () => ({
      approvedBy: 'Adriano',
      ...spending,
      approvedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
    () => 'mock-key-no-provider-access',
  );
  return {
    store,
    run,
    requests,
    model,
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('Analyst and reviewer send constrained JSON and pin the exact transmitted instructions', async () => {
  for (const role of ['analyst', 'reviewer'] as const) {
    const result = role === 'analyst' ? analysisResult : reviewerResult;
    const schema = role === 'analyst' ? analysisSchema : reviewSchema;
    const output = [message(JSON.stringify(result))];
    const x = setup({ status: 'completed', usage, output });
    try {
      assert.deepEqual(await x.model.reason<unknown>(x.run.id, role, [], [], schema), result);
      assert.equal(x.requests.length, 2);
      assert(x.requests[0].url.endsWith('/responses/input_tokens'));
      assert(x.requests[1].url.endsWith('/responses'));
      const body = x.requests[1].body;
      assert.deepEqual(
        x.requests[0].body,
        body,
        'Counting and generation use the same constrained request.',
      );
      assert.equal(body.text.format.type, 'json_schema');
      assert.equal(body.text.format.name, `${role}_result`);
      assert.deepEqual(body.text.format.schema, z.toJSONSchema(schema));
      assert.equal(Object.hasOwn(body, 'tools'), false);
      assert.equal(Object.hasOwn(body, 'tool_choice'), false);
      assert.equal(Object.hasOwn(body, 'parallel_tool_calls'), false);
      assert.equal(body.model, CAPS[role].model);
      assert.equal(body.reasoning.effort, role === 'analyst' ? 'low' : 'medium');
      assert.equal(body.max_output_tokens, 8192);
      assert.equal(body.store, false);
      assert.match(body.instructions, /Return only the schema-constrained JSON result/);
      assert(!body.instructions.includes('Use return_result.'));
      const record = x.store.records(x.run.id).find((entry) => entry.kind === 'model_response')!;
      assert.equal(record.payload.instructionHash, digest(body.instructions));
      assert.deepEqual(record.payload.output, output, 'Original provider messages remain intact.');
      assert.equal(x.store.usage(x.run.id).spent, expectedCost(role));
      assert.equal(x.store.usage(x.run.id).reserved, 0);
      assert.equal(x.store.usage(x.run.id).requests[0].status, 'completed');
    } finally {
      x.close();
    }
  }
});

test('Completed provider message content parses output_text fragments without requiring a function call', async () => {
  const text = JSON.stringify(analysisResult);
  const split = Math.floor(text.length / 2);
  const output = [
    { type: 'reasoning', summary: [] },
    {
      ...message(''),
      content: [
        { type: 'output_text', text: text.slice(0, split), annotations: [] },
        { type: 'output_text', text: text.slice(split), annotations: [] },
      ],
    },
  ];
  const x = setup({ status: 'completed', usage, output });
  try {
    assert.deepEqual(
      await x.model.reason(x.run.id, 'analyst', [], [], analysisSchema),
      analysisResult,
    );
    assert.equal(x.requests.filter((request) => request.url.endsWith('/responses')).length, 1);
    assert.deepEqual(
      x.store.records(x.run.id).find((entry) => entry.kind === 'model_response')!.payload.output,
      output,
    );
  } finally {
    x.close();
  }
});

test('An incomplete response is never parsed even when its text is valid schema JSON', async () => {
  for (const role of ['analyst', 'reviewer'] as const) {
    const result = role === 'analyst' ? analysisResult : reviewerResult;
    const base = role === 'analyst' ? analysisSchema : reviewSchema;
    let parseCalls = 0;
    const schema = new Proxy(base, {
      get(target, property, receiver) {
        if (property === 'parse')
          return (value: unknown) => {
            parseCalls++;
            return target.parse(value);
          };
        return Reflect.get(target, property, receiver);
      },
    });
    const output = [message(JSON.stringify(result))];
    const x = setup({
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      usage,
      output,
    });
    try {
      await assert.rejects(
        () => x.model.reason<unknown>(x.run.id, role, [], [], schema),
        IncompleteModelResult,
      );
      assert.equal(
        parseCalls,
        0,
        'Incomplete content cannot enter result validation or publication.',
      );
      assert.equal(x.requests.length, 2, 'No automatic request retry.');
      assert.equal(x.store.usage(x.run.id).spent, expectedCost(role));
      assert.equal(x.store.usage(x.run.id).reserved, 0);
      assert.equal(x.store.usage(x.run.id).requests[0].status, 'incomplete');
      assert.deepEqual(x.store.published(x.run.id), []);
      assert(x.store.records(x.run.id).every((entry) => entry.kind === 'model_response'));
      assert.deepEqual(x.store.records(x.run.id)[0].payload.output, output);
    } finally {
      x.close();
    }
  }
});

test('Malformed, schema-invalid and refusal results retain known charges without retry or publication', async () => {
  const refusal = { type: 'refusal', refusal: 'The provider declined this requested result.' };
  const valid = message(JSON.stringify(analysisResult));
  const responses = [
    { output: [message('{not valid JSON')] },
    { output: [message(JSON.stringify({ findings: 'not an array' }))] },
    { output: [{ ...valid, content: [refusal] }] },
    { output: [{ ...valid, content: [refusal, ...valid.content] }] },
    { output_text: JSON.stringify(analysisResult), output: [{ ...valid, content: [refusal] }] },
    {
      output: [
        { type: 'function_call', name: 'return_result', arguments: JSON.stringify(analysisResult) },
      ],
    },
  ];
  for (const result of responses) {
    const x = setup({ status: 'completed', usage, ...result });
    try {
      await assert.rejects(() => x.model.reason(x.run.id, 'analyst', [], [], analysisSchema));
      assert.equal(x.requests.length, 2, 'A failed constrained result is not silently retried.');
      const recorded = x.store.usage(x.run.id);
      assert.equal(recorded.spent, expectedCost('analyst'));
      assert.equal(recorded.reserved, 0);
      assert.equal(recorded.requests[0].status, 'invalid_result');
      assert.deepEqual(x.store.published(x.run.id), []);
      assert(x.store.records(x.run.id).every((entry) => entry.kind === 'model_response'));
    } finally {
      x.close();
    }
  }
});

test('The driver keeps its automatic function-call contract while structured jobs use text', async () => {
  const result = { kind: 'finish', note: 'The controlled safe boundary is reached.' };
  const output = [
    { type: 'function_call', name: 'return_result', arguments: JSON.stringify(result) },
  ];
  const x = setup({ status: 'completed', usage, output });
  try {
    assert.deepEqual(await x.model.reason(x.run.id, 'driver', [], [], actionSchema), result);
    const body = x.requests[1].body;
    assert.equal(body.tool_choice, 'auto');
    assert.equal(body.tools.length, 1);
    assert.equal(body.tools[0].name, 'return_result');
    assert.equal(Object.hasOwn(body, 'text'), false);
    assert.equal(body.max_output_tokens, 4096);
    assert.equal(x.store.usage(x.run.id).requests[0].status, 'completed');
  } finally {
    x.close();
  }
});

test('Oversized role inputs produce the existing typed limit without generation or reservation', async () => {
  for (const role of ['driver', 'analyst', 'reviewer'] as const) {
    const schema =
      role === 'driver' ? actionSchema : role === 'analyst' ? analysisSchema : reviewSchema;
    const x = setup({ status: 'completed', usage, output: [] }, CAPS[role].input + 1);
    try {
      await assert.rejects(
        () => x.model.reason<unknown>(x.run.id, role, [], [], schema),
        (error) => error instanceof EvidenceRequestLimit && error.role === role,
      );
      assert.equal(x.requests.length, 1, 'Only the input-count request is sent.');
      assert(x.requests[0].url.endsWith('/responses/input_tokens'));
      assert.equal(x.requests.filter((request) => request.url.endsWith('/responses')).length, 0);
      const recorded = x.store.usage(x.run.id);
      assert.equal(recorded.spent, 0);
      assert.equal(recorded.reserved, 0);
      assert.deepEqual(recorded.requests, []);
      assert.deepEqual(x.store.records(x.run.id), []);
    } finally {
      x.close();
    }
  }
});

test('Invalid negative or fractional provider counts remain errors rather than recoverable evidence limits', async () => {
  for (const role of ['analyst', 'reviewer'] as const) {
    const schema = role === 'analyst' ? analysisSchema : reviewSchema;
    for (const inputTokens of [-1, 0.5]) {
      const x = setup({ status: 'completed', usage, output: [] }, inputTokens);
      try {
        await assert.rejects(
          () => x.model.reason<unknown>(x.run.id, role, [], [], schema),
          (error) =>
            error instanceof Error &&
            !(error instanceof EvidenceRequestLimit) &&
            /valid evidence input count/.test(error.message),
        );
        assert.equal(x.requests.length, 1);
        assert(x.requests[0].url.endsWith('/responses/input_tokens'));
        assert.deepEqual(x.store.usage(x.run.id).requests, []);
        assert.equal(x.store.usage(x.run.id).spent, 0);
        assert.equal(x.store.usage(x.run.id).reserved, 0);
        assert.deepEqual(x.store.records(x.run.id), []);
      } finally {
        x.close();
      }
    }
  }
});

test('All roles share the documented model window with unchanged output allowances', () => {
  assert.equal(MODEL_CONTEXT_TOKENS, 1_048_576);
  assert.deepEqual(
    Object.values(CAPS).map(({ input, output }) => [input + output, output]),
    [
      [1_048_576, 4096],
      [1_048_576, 8192],
      [1_048_576, 8192],
    ],
  );
});

test('Simulated counts above the old role ceilings retain full selected originals in count and generation', async () => {
  for (const role of ['driver', 'analyst', 'reviewer'] as const) {
    const result =
      role === 'driver'
        ? { kind: 'finish', note: 'The safe boundary is reached.' }
        : role === 'analyst'
          ? analysisResult
          : reviewerResult;
    const schema =
      role === 'driver' ? actionSchema : role === 'analyst' ? analysisSchema : reviewSchema;
    // Simulated counts test admission and unchanged bodies, not real tokenization.
    // Character/byte length cannot stand in for the provider's multimodal count.
    const count = role === 'driver' ? 34655 : 60001;
    const output =
      role === 'driver'
        ? [{ type: 'function_call', name: 'return_result', arguments: JSON.stringify(result) }]
        : [message(JSON.stringify(result))];
    const x = setup(
      { status: 'completed', usage: { input_tokens: count, output_tokens: 20 }, output },
      count,
    );
    try {
      const plan = x.store.append(x.run.id, 'plan', 'owner', {
        goal: 'Find a flight without booking.',
      });
      const capture = x.store.append(x.run.id, 'capture', 'browser', {
        text: 'Complete original body text '.repeat(3000),
        aria: 'Original nested control state '.repeat(3000),
        focus: { tag: 'button', name: 'Reject optional cookies', text: 'Reject optional cookies' },
        elements: [{ name: 'Flight search', checked: false, expanded: true, selected: false }],
      });
      const note = x.store.append(
        x.run.id,
        'navigator_note',
        'driver',
        { note: 'The banner is still open.' },
        [capture.id],
      );
      const originals = [plan, capture, note];
      const originalText = JSON.stringify(originals);
      assert.deepEqual(
        await x.model.reason<unknown>(x.run.id, role, originals, [], schema),
        result,
      );
      assert.equal(x.requests.length, 2);
      assert.deepEqual(x.requests[0].body, x.requests[1].body);
      // Owner, 31 Oct: the navigator skips the page's visible text, which its page structure
      // already holds; every other field and record reaches it unchanged.
      const { text: _text, ...withoutText } = capture.payload;
      assert.equal(
        x.requests[1].body.input[0].content[0].text,
        role === 'driver'
          ? JSON.stringify([plan, { ...capture, payload: withoutText }, note])
          : originalText,
      );
      assert.equal(JSON.stringify(x.store.records(x.run.id).slice(0, 3)), originalText);
      assert.equal(x.store.usage(x.run.id).reserved, 0);
    } finally {
      x.close();
    }
  }
});

test('A request inside the model window cannot exceed owner run or aggregate money limits', async () => {
  for (const spending of [
    // The 34,655-token navigator request reserves $0.004286 at the Contributor price.
    { maxUsd: 2, maxRunUsd: 0.004 },
    { maxUsd: 0.004, maxRunUsd: 1 },
  ]) {
    const x = setup({ status: 'completed', usage, output: [] }, 34655, spending);
    try {
      await assert.rejects(
        () => x.model.reason(x.run.id, 'driver', [], [], actionSchema),
        /spending limit/,
      );
      assert.equal(x.requests.length, 1, 'Count only; no generation may precede budget admission.');
      assert.deepEqual(x.store.usage().requests, []);
      assert.equal(x.store.usage().reserved, 0);
    } finally {
      x.close();
    }
  }
});

test('The complete context still refuses a request beyond its unchanged phase money allowance', async () => {
  for (const role of ['analyst', 'reviewer'] as const) {
    // A full-context Contributor request costs about $0.106: inside a $0.30 run, beyond the
    // analyst's or reviewer's $0.066 share of it.
    const x = setup({ status: 'completed', usage, output: [] }, CAPS[role].input, {
      maxUsd: 10,
      maxRunUsd: 0.3,
    });
    try {
      await assert.rejects(
        () =>
          x.model.reason<unknown>(
            x.run.id,
            role,
            [],
            [],
            role === 'analyst' ? analysisSchema : reviewSchema,
          ),
        /Phase spending limit/,
      );
      assert.equal(x.requests.length, 1);
      assert.deepEqual(x.store.usage().requests, []);
    } finally {
      x.close();
    }
  }
});

test('The existing final-review money reserve stays available independently of context capacity', () => {
  assert.equal(FINAL_REVIEW_RESERVE_MICROS, 109816);
  const x = setup({});
  const approved = {
    approvedBy: 'Adriano' as const,
    maxUsd: 10,
    maxRunUsd: 3,
    approvedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  };
  try {
    assert.throws(
      () =>
        x.store.reserve(
          x.run.id,
          'reviewer',
          PHASE.reviewer - FINAL_REVIEW_RESERVE_MICROS + 1,
          approved,
        ),
      /Phase spending limit/,
    );
    const first = x.store.reserve(
      x.run.id,
      'reviewer',
      PHASE.reviewer - FINAL_REVIEW_RESERVE_MICROS,
      approved,
    );
    x.store.settle(first, PHASE.reviewer - FINAL_REVIEW_RESERVE_MICROS, 'completed');
    const final = x.store.reserve(
      x.run.id,
      'reviewer',
      FINAL_REVIEW_RESERVE_MICROS,
      approved,
      true,
    );
    x.store.settle(final, FINAL_REVIEW_RESERVE_MICROS, 'completed');
    assert.equal(x.store.usage().spent, PHASE.reviewer);
  } finally {
    x.close();
  }
});

test('A driver request at the exact context boundary is admitted only when its money allowance fits', async () => {
  const count = CAPS.driver.input;
  const result = { kind: 'finish', note: 'The safe boundary is reached.' };
  const output = [
    { type: 'function_call', name: 'return_result', arguments: JSON.stringify(result) },
  ];
  // The full-context Contributor request costs $0.105268: inside $3, outside $0.10.
  for (const maxRunUsd of [3, 0.1]) {
    const x = setup(
      { status: 'completed', usage: { input_tokens: count, output_tokens: 20 }, output },
      count,
      { maxUsd: 10, maxRunUsd },
    );
    try {
      if (maxRunUsd === 3) {
        assert.deepEqual(await x.model.reason(x.run.id, 'driver', [], [], actionSchema), result);
        assert.equal(x.requests.length, 2);
        assert.equal(x.requests[1].body.max_output_tokens + count, MODEL_CONTEXT_TOKENS);
        const charge = x.store.usage(x.run.id);
        assert.equal(charge.requests[0].reserved, 105268);
        assert.equal(charge.spent, tokenCostMicros(CAPS.driver.model, count, 20));
        assert.equal(charge.reserved, 0);
      } else {
        await assert.rejects(
          () => x.model.reason(x.run.id, 'driver', [], [], actionSchema),
          /Run spending limit/,
        );
        assert.equal(
          x.requests.length,
          1,
          'The same full-context request cannot bypass a smaller owner budget.',
        );
        assert.deepEqual(x.store.usage().requests, []);
      }
    } finally {
      x.close();
    }
  }
});

test('Navigator, analyst and reviewer each call Contributor mode and are charged its price', async () => {
  // Owner decision, 31 October: all three roles use muse-spark-1.3-contributor.
  for (const role of ['driver', 'analyst', 'reviewer'] as const) {
    assert.equal(CAPS[role].model, 'muse-spark-1.3-contributor');
    const output =
      role === 'driver'
        ? [
            {
              type: 'function_call',
              name: 'return_result',
              arguments: JSON.stringify({ kind: 'finish', note: 'Done.' }),
            },
          ]
        : [message(JSON.stringify(role === 'analyst' ? analysisResult : reviewerResult))];
    const schema =
      role === 'driver' ? actionSchema : role === 'analyst' ? analysisSchema : reviewSchema;
    const x = setup({ status: 'completed', usage, output });
    try {
      await x.model.reason<unknown>(x.run.id, role, [], [], schema);
      for (const request of x.requests)
        assert.equal(request.body.model, 'muse-spark-1.3-contributor');
      // 100 input tokens at $0.10 and 20 output tokens at $0.20 per million: 14 millionths
      // of a dollar, where the Standard price would have charged 210.
      assert.equal(x.store.usage(x.run.id).spent, 14);
    } finally {
      x.close();
    }
  }
});
