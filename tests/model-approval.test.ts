import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MetaModels } from '../src/models.js';
import { Store, digest } from '../src/store.js';
import type { Approval } from '../src/types.js';
import {
  ModelApprovalRequiredError,
  modelApprovalDenial,
  requireCurrentModelApproval,
} from '../src/model-approval.js';

const valid = (): Approval => ({
  approvedBy: 'Adriano',
  approvedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  maxUsd: 5,
  maxRunUsd: 1.4,
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'initial-model-approval-'));
  const store = new Store(dir);
  const url = 'https://example.com/',
    goal = 'Read results without buying.';
  const view = store.claimJourneyDraft({
    draftId: randomUUID(),
    ownerHash: 'a'.repeat(64),
    url,
    goal,
    briefHash: digest(JSON.stringify({ url, goal })),
  });
  return {
    store,
    run: view.run,
    close: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('Invalid initial allowances stop before key lookup, provider contact or reservation', async () => {
  const cases: (() => Approval)[] = [
    () => {
      throw Error('DO_NOT_EXPOSE_APPROVAL_FILE_DETAILS');
    },
    () => null as unknown as Approval,
    () => ({ ...valid(), approvedBy: 'Someone else' }) as unknown as Approval,
    () => ({ ...valid(), expiresAt: 'invalid' }),
    () => ({ ...valid(), expiresAt: '2000-01-01T00:00:00.000Z' }),
    () => ({ ...valid(), maxUsd: 0 }),
    () => ({ ...valid(), maxUsd: 111 }),
    () => ({ ...valid(), maxRunUsd: 0 }),
    () => ({ ...valid(), maxRunUsd: 3.01 }),
  ];
  for (const read of cases) {
    const x = fixture();
    let keyReads = 0,
      providerCalls = 0;
    try {
      const models = new MetaModels(
        x.store,
        (async () => {
          providerCalls++;
          throw Error('No provider contact is allowed.');
        }) as typeof fetch,
        read,
        () => {
          keyReads++;
          return 'synthetic-key';
        },
      );
      await assert.rejects(models.plan(x.run.id), (error: unknown) => {
        assert(error instanceof ModelApprovalRequiredError);
        const denied = modelApprovalDenial(error)!;
        assert.equal(denied.status, 403);
        assert.equal(denied.body.stage, 'before-provider');
        assert.equal(JSON.stringify(denied).includes('DO_NOT_EXPOSE'), false);
        return true;
      });
      assert.equal(keyReads, 0);
      assert.equal(providerCalls, 0);
      assert.equal(x.store.usage().requests.length, 0);
    } finally {
      x.close();
    }
  }
  const original = Object.freeze({ ...valid(), maxUsd: 110, maxRunUsd: 3 });
  assert.equal(
    requireCurrentModelApproval(() => original),
    original,
  );
});

test('Allowance failure after input counting cannot claim that Meta was not contacted', async () => {
  const x = fixture(),
    approved = valid();
  let providerCalls = 0;
  try {
    const models = new MetaModels(
      x.store,
      (async (input: any) => {
        providerCalls++;
        assert.match(String(input), /\/input_tokens$/);
        approved.expiresAt = '2000-01-01T00:00:00.000Z';
        return Response.json({ input_tokens: 10 });
      }) as typeof fetch,
      function (this: MetaModels) {
        assert.equal(this, models, 'The existing approval-reader receiver is preserved.');
        return approved;
      },
      () => 'synthetic-key',
    );
    await assert.rejects(models.plan(x.run.id), (error: unknown) => {
      assert.equal(error instanceof ModelApprovalRequiredError, false);
      assert.equal(modelApprovalDenial(error), null);
      return true;
    });
    assert.equal(providerCalls, 1);
    assert.equal(x.store.usage().requests.length, 0);
  } finally {
    x.close();
  }
});

test('Message text and lookalike properties cannot forge the trusted denial marker', () => {
  for (const error of [
    Error('A current bounded owner approval is required before preparing any model request.'),
    { code: 'LOCAL_MODEL_APPROVAL_REQUIRED', stage: 'before-provider', status: 403 },
    Object.assign(Error('An uncertain response.'), {
      name: 'ModelApprovalRequiredError',
      code: 'LOCAL_MODEL_APPROVAL_REQUIRED',
      stage: 'before-provider',
    }),
  ])
    assert.equal(modelApprovalDenial(error), null);
  const trusted = new ModelApprovalRequiredError();
  trusted.message = 'DO_NOT_EXPOSE_CHANGED_ERROR_DETAILS';
  assert.equal(JSON.stringify(modelApprovalDenial(trusted)).includes('DO_NOT_EXPOSE'), false);
});
