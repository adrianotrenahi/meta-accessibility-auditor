import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { planApprovalFailure, isPlanApprovalFailure } from './plan-failures.mjs';
import { openJourneyDrafts } from './journey-drafts.mjs';

const typed = { error: 'Private engine detail must not be displayed.', code: 'LOCAL_MODEL_APPROVAL_REQUIRED', stage: 'before-provider' };
const refusal = () => planApprovalFailure('/api/host/journey-plans', 'POST', 403, typed);
const owner = 'a'.repeat(64);
const brief = { url: 'https://example.com/', journey: 'Read the synthetic result without opening a website.' };
const steps = [{ id: 'open', text: 'Open the synthetic result.', intent: 'navigate', success: 'The result is visible.' },
  { id: 'read', text: 'Read its visible content.', intent: 'verify', success: 'The requested content or actual limitation is visible.' }];
async function fixture(t) {
  const folder = await mkdtemp(path.join(tmpdir(), 'meta-plan-failure-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  return path.join(folder, 'drafts.json');
}

test('only the exact typed local planner denial receives the fixed allowance explanation', () => {
  const error = refusal();
  assert(isPlanApprovalFailure(error));
  assert.match(error.message, /active local test spending allowance/);
  assert.match(error.message, /before contacting Meta/);
  assert.match(error.message, /saved setup is kept/);
  assert(!error.message.includes(typed.error));
  for (const [route, method, status, reply] of [
    ['/api/host/runs', 'POST', 403, typed], ['/api/host/journey-plans', 'GET', 403, typed],
    ['/api/host/journey-plans', 'POST', 400, typed], ['/api/host/journey-plans', 'POST', 502, typed],
    ['/api/host/journey-plans', 'POST', 403, { error: 'A current bounded owner approval is required.' }],
    ['/api/host/journey-plans', 'POST', 403, { ...typed, code: 'OTHER_DENIAL' }],
    ['/api/host/journey-plans', 'POST', 403, { ...typed, stage: 'after-provider' }],
    ['/api/host/journey-plans', 'POST', 403, { ...typed, error: undefined }],
    ['/api/host/journey-plans', 'POST', 403, 'LOCAL_MODEL_APPROVAL_REQUIRED'],
  ]) assert.equal(planApprovalFailure(route, method, status, reply), null);
});

test('a known pre-provider denial preserves the same saved draft and remains explicit after reload', async t => {
  const file = await fixture(t), client = randomUUID(), ids = [];
  let store = await openJourneyDrafts(file, async request => { ids.push(request.draftId); throw refusal(); });
  await assert.rejects(store.prepare(owner, client, brief), /active local test spending allowance/);
  const first = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(first.length, 1); assert.equal(first[0].state, 'unavailable');
  store = await openJourneyDrafts(file, async request => { ids.push(request.draftId); throw refusal(); });
  await assert.rejects(store.prepare(owner, client, brief), /before contacting Meta/);
  assert.equal(new Set(ids).size, 1);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).length, 1);
  assert.throws(() => store.reference(owner, client, brief), /Prepare/);
});

test('genuine uncertainty and text or property lookalikes do not claim that Meta was never contacted', async t => {
  for (const cause of [new Error('Connection lost'), new Error('A current bounded owner approval is required.'),
    Object.assign(new Error('Synthetic SDK error'), { code: typed.code, stage: typed.stage })]) {
    const file = await fixture(t), client = randomUUID(), ids = [];
    let store = await openJourneyDrafts(file, async request => { ids.push(request.draftId); throw cause; });
    await assert.rejects(store.prepare(owner, client, brief), error => {
      assert.match(error.message, /reply could not be confirmed/);
      assert.equal(error.cause, cause);
      assert(!error.message.includes('before contacting Meta'));
      assert(!error.message.includes('active local test spending allowance'));
      return true;
    });
    store = await openJourneyDrafts(file, async request => { ids.push(request.draftId); throw cause; });
    await assert.rejects(store.prepare(owner, client, brief), /original request is retained/);
    assert.equal(new Set(ids).size, 1);
  }
});

test('an explicit retry after allowance recovery reuses the denied draft and original owner binding', async t => {
  const file = await fixture(t), client = randomUUID(), afterReload = randomUUID(), ids = [];
  let allowed = false;
  const response = { id: randomUUID(), state: 'prepared', planId: randomUUID(), planHash: 'b'.repeat(64), steps };
  const store = await openJourneyDrafts(file, async request => {
    ids.push(request.draftId); assert.equal(request.ownerHash, owner);
    if (!allowed) throw refusal();
    return response;
  });
  await assert.rejects(store.prepare(owner, client, brief));
  allowed = true;
  await store.prepare(owner, afterReload, brief);
  assert.equal(new Set(ids).size, 1);
  assert.equal(store.reference(owner, afterReload, brief).planId, response.planId);
  assert.equal(store.saved('b'.repeat(64), afterReload, brief), null);
});


test('a concurrent confirmed discard never becomes an allowance message claiming the setup is kept', async t => {
  const file = await fixture(t), client = randomUUID();
  const response = { id: randomUUID(), state: 'prepared', planId: randomUUID(), planHash: 'b'.repeat(64), steps };
  let deny = false, entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  const store = await openJourneyDrafts(file, async () => {
    if (deny) { entered(); await wait; throw refusal(); }
    return response;
  });
  await store.prepare(owner, client, brief);
  const reference = store.reference(owner, client, brief);
  deny = true;
  const pending = store.prepare(owner, client, brief);
  await started;
  await store.discard(reference, owner);
  release();
  await assert.rejects(pending, /was discarded/);
  const saved = await readFile(file, 'utf8');
  assert(!saved.includes(brief.journey));
  assert.throws(() => store.reference(owner, client, brief), /was discarded/);
});
