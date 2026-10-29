import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { connect } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import {
  publicDestination,
  publicBrowserProxy,
  pinnedLookup,
  connectDestination,
  forwardHeaders,
  PUBLIC_PROXY_REFUSAL_HEADER,
} from '../src/public-network.js';
import { publicTarget, publicEntryLimit } from '../src/public-target.js';
import { isCommitment, publicSearchInput } from '../src/browser.js';
import { Runner } from '../src/runner.js';
import { MetaModels } from '../src/models.js';
import { isPublicAddress } from '../src/network.js';
import { Store } from '../src/store.js';
import { hostRequest } from '../server/host.js';
import { startServer } from '../server/index.js';

const target = () => ({
  url: 'https://8.8.8.8/',
  goal: 'Find dermatology in Barcelona in January 2027. Stop before confirmation.',
  steps: [{ id: 'find', text: 'Find the latest safe appointment step', intent: 'search' }],
});
test('Public targets retain the actual URL, journey and steps and never borrow the local exception', async () => {
  assert.deepEqual(await publicTarget(target()), target());
  for (const url of [
    'http://127.0.0.1:4317/shop',
    'http://10.0.0.1',
    'http://[::1]',
    'https://user:pass@8.8.8.8',
    'file:///tmp/test',
  ])
    await assert.rejects(publicTarget({ ...target(), url }));
  for (const change of [
    { goal: '' },
    { extra: true },
    { steps: [] },
    { steps: [...target().steps, ...target().steps] },
  ])
    await assert.rejects(publicTarget({ ...target(), ...change }));
});
test('Every destination resolves once and refuses empty, private, mixed and reserved answers', async () => {
  let reads = 0;
  const result = await publicDestination('https://public.test/path', async (host) => {
    reads++;
    assert.equal(host, 'public.test');
    return [{ address: '8.8.8.8', family: 4 }];
  });
  assert.equal(reads, 1);
  assert.equal(result.address.address, '8.8.8.8');
  for (const addresses of [
    [],
    [{ address: '127.0.0.1', family: 4 }],
    [
      { address: '8.8.8.8', family: 4 },
      { address: '10.0.0.1', family: 4 },
    ],
    [{ address: '192.0.2.1', family: 4 }],
    [{ address: '203.0.113.1', family: 4 }],
  ])
    await assert.rejects(publicDestination('https://public.test', async () => addresses));
  for (const url of [
    'http://[::ffff:127.0.0.1]',
    'http://169.254.169.254',
    'http://2130706433',
    'https://x:y@8.8.8.8',
  ])
    await assert.rejects(publicDestination(url));
});
test('The HTTP connection lookup returns only the already checked address even for another hostname', () => {
  const lookup = pinnedLookup({ address: '8.8.8.8', family: 4 });
  lookup('rebound.test', {}, (error: any, address: any, family: any) => {
    assert.equal(error, null);
    assert.equal(address, '8.8.8.8');
    assert.equal(family, 4);
  });
  lookup('rebound.test', { all: true }, (_error: any, addresses: any) =>
    assert.deepEqual(addresses, [{ address: '8.8.8.8', family: 4 }]),
  );
});
test('Actual HTTP and CONNECT requests cannot reach private destinations, including a hostname that changes its answer', async () => {
  let calls = 0;
  const proxy = await publicBrowserProxy(async () => {
    calls++;
    return [{ address: '127.0.0.1', family: 4 }];
  });
  try {
    const result = await new Promise<{ status: number; refusal: string | string[] | undefined }>(
      (resolve, reject) => {
        const r = request(proxy.url, { path: 'http://rebound.test:9/private' }, (res) => {
          res.resume();
          resolve({ status: res.statusCode!, refusal: res.headers[PUBLIC_PROXY_REFUSAL_HEADER] });
        });
        r.on('error', reject);
        r.end();
      },
    );
    assert.equal(result.status, 502);
    assert.equal(result.refusal, '1');
    assert.equal(calls, 1);
    const tunnel = await new Promise<string>((resolve, reject) => {
      const socket = connect(Number(new URL(proxy.url).port), '127.0.0.1');
      let data = '';
      socket.setTimeout(2000, () => socket.destroy(Error('timeout')));
      socket.on('error', reject);
      socket.on('data', (chunk) => (data += chunk));
      socket.on('end', () => resolve(data));
      socket.on('connect', () =>
        socket.write('CONNECT rebound.test:443 HTTP/1.1\r\nHost: rebound.test:443\r\n\r\n'),
      );
    });
    assert.match(tunnel, /502 Bad Gateway/);
    assert(tunnel.includes(PUBLIC_PROXY_REFUSAL_HEADER + ': 1'));
    assert.equal(calls, 2);
    await Promise.all([proxy.close(), proxy.close()]);
  } finally {
    await proxy.close();
  }
});
test('Public shutdown while DNS is pending cannot open a late private tunnel', async () => {
  let resolve!: (value: any) => void;
  let observed!: () => void;
  const ready = new Promise<void>((r) => (observed = r));
  const proxy = await publicBrowserProxy(() => {
    observed();
    return new Promise((r) => (resolve = r));
  });
  const socket = connect(Number(new URL(proxy.url).port), '127.0.0.1');
  socket.on('error', () => {});
  socket.on('connect', () =>
    socket.write('CONNECT delayed.test:443 HTTP/1.1\r\nHost: delayed.test\r\n\r\n'),
  );
  await ready;
  await proxy.close();
  resolve([{ address: '8.8.8.8', family: 4 }]);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(socket.destroyed, true);
});
test('Public typing accepts search terms but refuses patient, account, payment and multiline values', () => {
  const focus = { tag: 'input', type: 'search', name: 'Buscar' };
  assert(publicSearchInput(focus, 'Dermatología Barcelona'));
  for (const text of ['person@example.com', 'a\nb', 'x'.repeat(161), ''])
    assert.equal(publicSearchInput(focus, text), false);
  for (const change of [
    { type: 'password' },
    { type: 'email' },
    { name: 'Nombre paciente' },
    { name: 'Número tarjeta' },
    { autocomplete: 'given-name' },
    { paymentForm: true },
    { tag: 'iframe' },
    { type: 'text', name: 'Unknown field' },
  ])
    assert.equal(publicSearchInput({ ...focus, ...change }, 'Barcelona'), false);
  assert(publicSearchInput({ ...focus, type: 'text', name: 'Especialidad' }, 'Dermatología'));
  assert(publicSearchInput({ ...focus, name: 'Search by doctor name' }, 'Public Doctor'));
  assert(publicSearchInput({ ...focus, name: 'Search by name' }, 'Public Product'));
  assert.equal(
    publicSearchInput({ ...focus, name: 'Patient full name' }, 'Private Patient'),
    false,
  );
  for (const label of [
    'Confirmar cita',
    'Finalizar la reserva',
    'Pagar',
    'Iniciar sesión',
    'Confirm booking',
  ])
    assert(isCommitment(label), label);
  for (const label of ['Pedir cita', 'Ver disponibilidad', 'Buscar dermatólogo'])
    assert.equal(isCommitment(label), false, label);
});
test('The public host binds a repeated start to its exact original target and leaves ordinary startup disabled', async () => {
  await assert.rejects(
    startServer(0, '/unused', true, { publicWebsites: true }),
    /separate|configured/,
  );
  const dir = mkdtempSync(join(tmpdir(), 'meta-public-host-'));
  const store = new Store(dir);
  let starts = 0;
  const runner = {
    async start(options: any) {
      starts++;
      const run = store.create(options.goal, options.url, options.mode, options.requestId);
      store.append(run.id, 'plan', 'driver', {
        requestTargetHash: options.requestTargetHash,
        steps: options.steps,
      });
      return run;
    },
  } as any;
  const call = async (method: string, path: string, body?: any, authorized = true) => {
    let status = 0,
      result: any;
    await hostRequest(
      Object.assign(Readable.from(body === undefined ? [] : [JSON.stringify(body)]), {
        method,
        headers: { 'x-session-token': authorized ? 'unit' : 'wrong' },
      }) as any,
      {} as any,
      new URL(path, 'http://127.0.0.1:4317'),
      {
        origin: 'http://127.0.0.1:4317',
        token: 'unit',
        store,
        runner,
        mode: 'live',
        publicWebsites: true,
        json(_res, code, value) {
          status = code;
          result = value;
        },
      },
    );
    return { status, body: result };
  };
  try {
    assert.equal((await call('GET', '/api/host', undefined, false)).status, 403);
    const manifest = (await call('GET', '/api/host')).body;
    assert.equal(manifest.url, null);
    assert.equal(manifest.capabilities.publicWebsites, true);
    const body = { mode: 'live', requestId: randomUUID(), target: target() };
    await assert.rejects(
      call('POST', '/api/host/runs', {
        ...body,
        target: { ...target(), url: 'http://127.0.0.1:4317' },
      }),
    );
    await assert.rejects(call('POST', '/api/host/runs', { ...body, extra: true }));
    assert.equal(starts, 0);
    const created = await call('POST', '/api/host/runs', body);
    assert.equal(created.status, 201);
    assert.equal((await call('POST', '/api/host/runs', body)).status, 200);
    assert.equal(starts, 1);
    for (const change of [
      { url: 'https://8.8.4.4/' },
      { goal: 'Different task' },
      { steps: [{ id: 'other', text: 'Different step' }] },
    ])
      assert.equal(
        (await call('POST', '/api/host/runs', { ...body, target: { ...target(), ...change } }))
          .status,
        409,
      );
    assert.equal(starts, 1);
    const missingPlanId = randomUUID();
    store.create(target().goal, target().url, 'live', missingPlanId);
    const unverifiable = await call('POST', '/api/host/runs', {
      ...body,
      requestId: missingPlanId,
    });
    assert.equal(unverifiable.status, 409);
    assert.match(unverifiable.body.error, /original plan is unavailable/);
    assert.equal(starts, 1);
    assert.equal(store.run(created.body.id).goal, target().goal);
    assert.equal(store.usage().requests.length, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('An explicit denied entry becomes an untested limit, never a finding or a false success', () => {
  for (const title of ['Access Denied', '403 Forbidden', 'Request blocked'])
    assert.match(publicEntryLimit(title)!, /journey was not reached/);
  for (const title of ['Quirónsalud', 'Booking', 'Access denied explained', null])
    assert.equal(publicEntryLimit(title), null);
});

test('An explicit Google traffic challenge needs its actual host, path and text; ordinary pages stay available', () => {
  const text = 'Our systems have detected unusual traffic from your computer network.';
  const url = 'https://www.google.com/sorry/index?continue=search';
  for (const title of ['Google', 'Access Denied', '403 Forbidden', 'Request blocked'])
    assert.match(publicEntryLimit(title, { url, text })!, /automated-traffic challenge/);
  assert.match(
    publicEntryLimit('Google', {
      url: 'https://google.es/sorry/index',
      text: 'Nuestros sistemas han detectado tráfico inusual.',
    })!,
    /automated-traffic challenge/,
  );
  for (const page of [
    { url: 'https://www.google.com/search?q=unusual+traffic', text },
    { url: 'https://google.com.example.org/sorry/index', text },
    { url: 'https://www.google.com/sorry/index', text: 'Ordinary page content' },
    { url: 'invalid', text },
    { text },
    { url },
  ])
    assert.equal(publicEntryLimit('Google', page), null);
});

test('A denied entry retains its original, skips inference and still closes the browser', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'meta-denied-entry-'));
  const store = new Store(dir);
  const run = store.create('Find an appointment; do not confirm it.', 'https://8.8.8.8/', 'live');
  let calls = 0,
    closed = 0;
  const model = mock.method(MetaModels.prototype, 'reason', async () => {
    calls++;
    throw Error('Unexpected model request');
  });
  const capture = store.append(run.id, 'capture', 'browser', {
    title: 'Access Denied',
    url: run.url,
    stable: true,
  });
  const walk = {
    publicWebsite: true,
    engine: 'chromium',
    async start() {
      return capture;
    },
    async close() {
      closed++;
    },
  };
  try {
    await (new Runner(store, 'http://127.0.0.1:4317') as any).execute(
      run,
      walk,
      { async cleanup() {} },
      new AbortController(),
      false,
      false,
    );
    assert.equal(calls, 0);
    assert.equal(closed, 1);
    assert.equal(store.run(run.id).state, 'partial');
    assert.equal(store.record(run.id, capture.id)?.hash, capture.hash);
    assert(store.records(run.id).some((r) => r.kind === 'limit' && r.sources.includes(capture.id)));
    assert.equal(store.published(run.id).length, 0);
  } finally {
    model.mock.restore();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('A traffic challenge reached after input stops before challenge analysis, another driver or final review', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'meta-traffic-challenge-')),
    store = new Store(dir);
  const run = store.create('Perform the public search', 'https://www.google.com/', 'live');
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl7m8kAAAAASUVORK5CYII=',
    'base64',
  );
  const asset = store.asset(run.id, 'source.png', png);
  const first = store.append(run.id, 'capture', 'browser', {
    imageFile: asset.file,
    imageHash: asset.hash,
    width: 1,
    height: 1,
    stable: true,
    url: run.url,
    title: 'Google',
  });
  const roles: string[] = [];
  const reason = mock.method(MetaModels.prototype, 'reason', async (_id: string, role: string) => {
    roles.push(role);
    return { kind: 'press', key: 'Enter', note: 'Submit public search' } as any;
  });
  const walk = {
    publicWebsite: true,
    assertActive() {},
    images() {
      return [];
    },
    async act() {
      return store.append(run.id, 'action', 'browser', { performed: true }, [first.id]);
    },
    async captureSettled() {
      return store.append(run.id, 'capture', 'browser', {
        stable: true,
        title: 'Google',
        url: 'https://www.google.com/sorry/index',
        text: 'Our systems have detected unusual traffic from your computer network.',
      });
    },
  };
  try {
    await (new Runner(store, 'http://127.0.0.1:4317') as any).live(
      run,
      walk,
      {},
      first,
      new AbortController(),
    );
    assert.deepEqual(roles, ['driver']);
    assert.equal(store.run(run.id).state, 'partial');
    assert.match(store.run(run.id).stopReason!, /automated-traffic challenge during the journey/);
    assert.doesNotMatch(store.run(run.id).stopReason!, /no model request/);
    assert.equal(store.records(run.id).filter((r) => r.kind === 'capture').length, 2);
    assert.equal(store.published(run.id).length, 0);
  } finally {
    reason.mock.restore();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CONNECT accepts a public authority on standard or custom ports and rejects URL syntax', async () => {
  const resolve = async () => [{ address: '8.8.8.8', family: 4 }];
  for (const port of [80, 443, 8443])
    assert.equal((await connectDestination('public.test:' + port, resolve)).port, port);
  for (const authority of [
    'public.test:443/',
    'public.test:443/path',
    'public.test:443?q=1',
    'user@public.test:443',
    'https://public.test:443',
    'public.test:0',
    'public.test:65536',
  ])
    await assert.rejects(connectDestination(authority, resolve));
});
test('Public destinations prefer checked IPv4 and refuse transition IPv6 ranges in every spelling', async () => {
  const selected = await publicDestination('https://public.test', async () => [
    { address: '2001:4860:4860::8888', family: 6 },
    { address: '8.8.8.8', family: 4 },
  ]);
  assert.equal(selected.address.family, 4);
  for (const address of [
    '2001::1',
    '2001:0000:0:0:0:0:0:1',
    '2002:7f00:1::',
    '2001:db8::1',
    '3fff::1',
  ])
    assert.equal(isPublicAddress(address), false, address);
  assert.equal(isPublicAddress('2001:4860:4860::8888'), true);
});
test('A denied page after an actual requested input stops before error-page analysis and final review', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'meta-later-denied-')),
    store = new Store(dir);
  const run = store.create('Find the latest safe appointment step', 'https://8.8.8.8/', 'live');
  store.append(run.id, 'plan', 'driver', { goal: run.goal });
  const picture = store.asset(
    run.id,
    'input.png',
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl7m8kAAAAASUVORK5CYII=',
      'base64',
    ),
  );
  const original = store.append(run.id, 'capture', 'browser', {
    imageFile: picture.file,
    imageHash: picture.hash,
    width: 1,
    height: 1,
    title: 'Home',
    url: run.url,
    stable: true,
  });
  const roles: string[] = [];
  const reason = mock.method(MetaModels.prototype, 'reason', async (_id: string, role: string) => {
    roles.push(role);
    return { kind: 'press', key: 'Tab', note: 'Inspect the next control' } as any;
  });
  const walk = {
    publicWebsite: true,
    assertActive() {},
    images() {
      return [];
    },
    async act() {
      return store.append(run.id, 'action', 'browser', { key: 'Tab' }, [original.id]);
    },
    async captureSettled() {
      return store.append(run.id, 'capture', 'browser', {
        title: 'Access Denied',
        url: run.url,
        stable: true,
      });
    },
  };
  try {
    await (new Runner(store, 'http://127.0.0.1:4317') as any).live(
      run,
      walk,
      {},
      original,
      new AbortController(),
    );
    assert.deepEqual(roles, ['driver']);
    assert.equal(store.run(run.id).state, 'partial');
    assert.match(store.run(run.id).stopReason!, /during the journey/);
    assert(!store.run(run.id).stopReason!.includes('no model request'));
    assert.equal(store.records(run.id).filter((r) => r.kind === 'capture').length, 2);
    assert.equal(store.published(run.id).length, 0);
  } finally {
    reason.mock.restore();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Forwarding removes hop headers while preserving content and refusing a family mismatch', () => {
  assert.deepEqual(
    forwardHeaders({
      connection: 'keep-alive, x-private-hop',
      'keep-alive': 'timeout=1',
      'x-private-hop': 'local',
      'transfer-encoding': 'chunked',
      'content-length': '12',
      'content-type': 'text/html',
      [PUBLIC_PROXY_REFUSAL_HEADER]: '1',
    }),
    { 'content-type': 'text/html' },
  );
  assert.deepEqual(forwardHeaders({ 'content-length': '12', 'content-type': 'text/html' }), {
    'content-length': '12',
    'content-type': 'text/html',
  });
  pinnedLookup({ address: '2001:4860:4860::8888', family: 6 })(
    'public.test',
    { family: 4 },
    (error: any) => assert.match(error.message, /does not match/),
  );
});
