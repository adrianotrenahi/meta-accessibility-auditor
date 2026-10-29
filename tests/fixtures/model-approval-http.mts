import assert from 'node:assert/strict';
import { writeFileSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { startServer } from '../../server/index.js';
import { digest } from '../../src/store.js';

const allowance = {
  approvedBy: 'Adriano',
  maxUsd: 5,
  maxRunUsd: 1.4,
  approvedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 300_000).toISOString(),
};
const saveAllowance = (expired = false) =>
  writeFileSync(
    'spend-approval.json',
    JSON.stringify({
      ...allowance,
      expiresAt: expired ? '2000-01-01T00:00:00.000Z' : allowance.expiresAt,
    }),
  );
saveAllowance();
const originalFetch = globalThis.fetch;
let simulatedProviderCalls = 0;
let uncertain = false;
globalThis.fetch = (async (input: any, init: any) => {
  const url = new URL(String(input));
  if (url.hostname === '127.0.0.1') return originalFetch(input, init);
  simulatedProviderCalls++;
  if (url.pathname.endsWith('/input_tokens')) return Response.json({ input_tokens: 10 });
  if (uncertain) throw TypeError('Synthetic incomplete Meta connection.');
  return Response.json({
    status: 'completed',
    usage: { input_tokens: 10, output_tokens: 20 },
    output: [
      {
        type: 'message',
        content: [
          {
            type: 'output_text',
            text: JSON.stringify({
              steps: [
                {
                  id: 'open',
                  text: 'Open the search.',
                  intent: 'navigate',
                  success: 'The form is visible.',
                },
                {
                  id: 'results',
                  text: 'Read the results.',
                  intent: 'verify',
                  success: 'Usable results are visible.',
                },
              ],
            }),
          },
        ],
      },
    ],
  });
}) as typeof fetch;
const app = await startServer(0, 'engine', false, {
  controlledLiveProof: true,
  publicWebsites: true,
});
const brief = () => ({
  draftId: randomUUID(),
  ownerHash: 'a'.repeat(64),
  url: 'https://93.184.216.34/',
  goal: 'Read results without selecting or booking.',
});
const post = async (body: ReturnType<typeof brief>) => {
  const response = await fetch(app.origin + '/api/host/journey-plans', {
    method: 'POST',
    headers: { 'x-session-token': app.token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as any };
};
const view = (body: ReturnType<typeof brief>) =>
  app.store.journeyDraft({
    ...body,
    briefHash: digest(JSON.stringify({ url: body.url, goal: body.goal })),
  })!;
const denied = (reply: Awaited<ReturnType<typeof post>>) => {
  assert.equal(reply.status, 403);
  assert.equal(reply.body.code, 'LOCAL_MODEL_APPROVAL_REQUIRED');
  assert.equal(reply.body.stage, 'before-provider');
};
try {
  saveAllowance(true);
  const original = brief();
  denied(await post(original));
  const originalRun = view(original).run.id;
  denied(await post(original));
  assert.equal(view(original).run.id, originalRun);
  unlinkSync('spend-approval.json');
  denied(await post(brief()));
  writeFileSync('spend-approval.json', '{invalid');
  denied(await post(brief()));
  assert.equal(simulatedProviderCalls, 0);
  assert.equal(app.store.usage().requests.length, 0);

  saveAllowance();
  const restored = await post(original);
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  assert.equal(restored.body.state, 'prepared');
  assert.equal(restored.body.id, originalRun);
  assert.equal(simulatedProviderCalls, 2);
  assert.equal(app.store.usage().requests.length, 1);

  uncertain = true;
  const lost = brief();
  const unknown = await post(lost);
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.code, undefined);
  assert.equal(unknown.body.stage, undefined);
  assert.equal(app.store.usage().requests.at(-1)!.status, 'unknown');
  const calls = simulatedProviderCalls;
  const retained = await post(lost);
  assert.equal(retained.status, 200);
  assert.equal(retained.body.state, 'unavailable');
  assert.equal(simulatedProviderCalls, calls, 'An uncertain generation is never repeated.');
  console.log(
    JSON.stringify({
      actualProviderCalls: 0,
      deniedBeforeProvider: true,
      sameDraftRecovered: true,
      unknownReplyPreserved: true,
    }),
  );
} finally {
  await app.close();
  globalThis.fetch = originalFetch;
}
