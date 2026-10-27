import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server/index.js';
const dir = mkdtempSync(join(tmpdir(), 'walk-controls-'));
const app = await startServer(0, dir, false);
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, options) => {
  const value = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  assert.equal(
    new URL(value).origin,
    app.origin,
    'No remote model or service request is permitted',
  );
  return originalFetch(input, options);
};
const request = async (path: string, method = 'GET', body?: unknown) => {
  const res = await fetch(app.origin + path, {
    method,
    headers: { 'x-session-token': app.token, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json() };
};
async function waiting(id: string) {
  for (let n = 0; n < 200; n++) {
    const x = await request('/api/host/runs/' + id);
    if (x.body.waiting || x.body.snapshot?.run.state !== 'running') return x.body;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw Error('The controlled checkpoint did not arrive');
}
try {
  assert.equal((await fetch(app.origin + '/api/host')).status, 403);
  const manifest = await request('/api/host');
  assert.equal(manifest.body.mode, 'offline');
  const cancelledStart = randomUUID();
  assert.equal(
    (await request(`/api/host/requests/${cancelledStart}/discard`, 'POST', {})).status,
    200,
  );
  assert.equal(
    (await request('/api/host/runs', 'POST', { mode: 'offline', requestId: cancelledStart }))
      .status,
    409,
  );
  assert.equal(app.store.runs().length, 0, 'A delayed start cannot recreate a discarded request');
  const run = (
    await request('/api/host/runs', 'POST', {
      mode: 'offline',
      requestId: randomUUID().toUpperCase(),
    })
  ).body;
  const requestId = app.store.db
    .prepare('SELECT request_id FROM host_starts WHERE run_id=?')
    .get(run.id) as { request_id: string };
  assert.equal(
    (await request('/api/host/runs', 'POST', { mode: 'offline', requestId: requestId.request_id }))
      .body.id,
    run.id,
  );
  assert.equal(
    (await request(`/api/host/requests/${requestId.request_id.toUpperCase()}`)).body.id,
    run.id,
  );
  let current = await waiting(run.id);
  assert.equal(current.snapshot.findings.length, 1);
  assert(current.snapshot.findings[0].anchor);
  const image = current.snapshot.captures[0].imageHash;
  const recordCount = app.store.records(run.id).length,
    actionCount = app.runner.active!.walk.actions;
  const fresh = (await request(`/api/host/runs/${run.id}/frame`)).body;
  assert.equal((await fetch(`${app.origin}/api/host/runs/${run.id}/frame`)).status, 403);
  assert.equal(fresh.protocol, 'access-walk/frame-v1');
  assert.equal(fresh.imageHash, image);
  assert.equal(fresh.captureId, current.snapshot.captures[0].id);
  const page = app.runner.active!.walk.page;
  await page.locator('#add').evaluate((el) => el.setAttribute('aria-label', 'Add to basket'));
  await new Promise((resolve) => setTimeout(resolve, 300));
  const renamed = (await request(`/api/host/runs/${run.id}/frame`)).body;
  assert.equal(
    renamed.imageHash,
    fresh.imageHash,
    'An accessible-name change can leave the picture identical',
  );
  assert.equal(renamed.captureId, null, 'A changed accessible name must withhold the old live pin');
  await page.locator('#add').evaluate((el) => el.removeAttribute('aria-label'));
  await page.evaluate(() => {
    const marker = document.createElement('div');
    marker.id = 'live-proof-marker';
    marker.style.cssText =
      'position:fixed;left:0;top:0;width:80px;height:80px;background:rgb(255,0,0);z-index:999999';
    document.body.append(marker);
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const changed = (await request(`/api/host/runs/${run.id}/frame`)).body;
  assert(changed.sequence > fresh.sequence);
  assert.notEqual(changed.imageHash, fresh.imageHash);
  assert.equal(changed.captureId, null);
  assert.equal(app.store.records(run.id).length, recordCount);
  assert.equal(app.runner.active!.walk.actions, actionCount);
  await page.evaluate(() => document.getElementById('live-proof-marker')?.remove());
  for (let n = 0; current.waiting && n < 25; n++) {
    assert.equal(
      (
        await request('/api/host/runs/' + run.id + '/advance', 'POST', {
          sequence: current.snapshot.sequence,
        })
      ).status,
      200,
    );
    const previousSequence = current.snapshot.sequence;
    current = await waiting(run.id);
    assert.notEqual(
      (
        await request('/api/host/runs/' + run.id + '/advance', 'POST', {
          sequence: previousSequence,
        })
      ).status,
      200,
    );
  }
  assert.equal(current.snapshot.run.state, 'partial');
  assert.match(current.snapshot.captures.at(-1).url, /basket/);
  assert.equal(current.snapshot.findings.length, 1);
  assert.equal(app.store.usage(run.id).requests.length, 0);
  const original = app.store.records(run.id).find((r) => r.kind === 'capture')!;
  const originalBytes = app.store.image(run.id, original.payload.imageFile);
  const duplicate = app.store.asset(run.id, 'intact-duplicate.png', originalBytes);
  const intact = app.store.append(run.id, 'capture', 'browser', {
    ...original.payload,
    imageFile: duplicate.file,
  });
  rmSync(join(dir, run.id, original.payload.imageFile));
  const exportWithMissing = (await request('/api/host/runs/' + run.id)).body.snapshot;
  assert.equal(
    exportWithMissing.captures.find((c: any) => c.id === original.id).imageAvailable,
    false,
  );
  assert.equal(
    exportWithMissing.captures.find((c: any) => c.id === intact.id).imageAvailable,
    true,
  );
  const intactResponse = await fetch(`${app.origin}/api/host/runs/${run.id}/assets/${image}.png`, {
    headers: { 'x-session-token': app.token },
  });
  assert.equal(intactResponse.status, 200);
  assert.deepEqual(Buffer.from(await intactResponse.arrayBuffer()), originalBytes);
  await request('/api/host/runs/' + run.id + '/discard', 'POST', {});
  assert.equal((await request('/api/host/runs/' + run.id)).status, 404);
  assert.equal(
    (
      await fetch(app.origin + '/api/host/runs/' + run.id + '/assets/' + image + '.png', {
        headers: { 'x-session-token': app.token },
      })
    ).status,
    404,
  );
  assert.equal(existsSync(join(dir, run.id)), false);
  assert.equal(
    (await request('/api/host/runs', 'POST', { mode: 'offline', requestId: requestId.request_id }))
      .status,
    409,
  );
  const upperDiscard = randomUUID().toUpperCase();
  assert.equal(
    (await request(`/api/host/requests/${upperDiscard}/discard`, 'POST', {})).status,
    200,
  );
  assert.equal(
    (
      await request('/api/host/runs', 'POST', {
        mode: 'offline',
        requestId: upperDiscard.toLowerCase(),
      })
    ).status,
    409,
  );
  const next = (
    await request('/api/host/runs', 'POST', { mode: 'offline', requestId: randomUUID() })
  ).body;
  await waiting(next.id);
  await request('/api/host/runs/' + next.id + '/stop', 'POST', {});
  assert.equal((await request('/api/host/runs/' + next.id)).body.snapshot.run.state, 'stopped');
  assert.equal((await request(`/api/host/runs/${next.id}/frame`)).status, 409);
  assert(existsSync(join(dir, next.id)));
  const nextRequest = app.store.db
    .prepare('SELECT request_id FROM host_starts WHERE run_id=?')
    .get(next.id) as { request_id: string };
  const cleanup = (app.store as any).cleanupDiscard;
  (app.store as any).cleanupDiscard = () => {
    throw Error('Simulated unavailable image cleanup');
  };
  assert.equal(
    (await request(`/api/host/requests/${nextRequest.request_id}/discard`, 'POST', {})).status,
    400,
  );
  const pendingDiscard = (await request(`/api/host/requests/${nextRequest.request_id}`)).body;
  assert.equal(pendingDiscard.discarded, false);
  assert.equal(pendingDiscard.discardPending, true);
  assert.equal(pendingDiscard.id, next.id);
  (app.store as any).cleanupDiscard = cleanup;
  assert.equal(
    (await request(`/api/host/requests/${nextRequest.request_id}/discard`, 'POST', {})).status,
    200,
  );
  assert.equal(existsSync(join(dir, next.id)), false);
  assert.equal(
    (await request(`/api/host/requests/${nextRequest.request_id}`)).body.discarded,
    true,
  );
  assert.equal(app.store.records(next.id).length, 0);
  console.log(
    JSON.stringify({
      passed: true,
      freshBrowserRun: true,
      discardedOriginals: true,
      ordinaryStopRetains: true,
      livePictures: true,
      noEvidenceOnView: true,
      modelCalls: 0,
      creditsSpent: 0,
    }),
  );
} finally {
  globalThis.fetch = originalFetch;
  await app.close();
  rmSync(dir, { recursive: true, force: true });
}
