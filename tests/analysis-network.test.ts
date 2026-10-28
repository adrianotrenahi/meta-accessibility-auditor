import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { postMeta, MetaTransportError } from '../src/meta-transport.js';
import {
  optionalAnalysisRequest,
  AnalysisNetworkUnavailable,
  analysisNetworkDeferred,
} from '../src/analysis-network.js';
import { MetaModels, analysisSchema } from '../src/models.js';
import { Store } from '../src/store.js';
import { Runner } from '../src/runner.js';
import { ObservationUnsettled } from '../src/browser.js';
import { assessmentForRun } from '../src/assessment.js';
import type { RecordEntry } from '../src/types.js';

const privateText = 'untrusted secret 203.0.113.100 https://untrusted.invalid';
const coded = (code: string) => Object.assign(Error(privateText), { code });
const network = (errors: Error[] = [coded('ETIMEDOUT'), coded('ENETUNREACH')]) =>
  new TypeError('fetch failed', { cause: new AggregateError(errors, privateText) });
async function transportError(error: unknown, status?: number) {
  let calls = 0;
  try {
    await postMeta({
      phase: 'generation',
      body: { original: true },
      apiKey: 'synthetic-private-key',
      signal: new AbortController().signal,
      assertActive() {},
      wait: async () => {},
      fetcher: (async () => {
        calls++;
        if (status) return new Response('{}', { status });
        throw error;
      }) as typeof fetch,
    });
    throw Error('Expected a controlled transport failure.');
  } catch (failure) {
    assert(failure instanceof MetaTransportError);
    return { error: failure, calls };
  }
}

test('Only actual bounded known network trees or transient HTTP replies mark analysis continuation eligible', async () => {
  for (const error of [
    network(),
    network([coded('ETIMEDOUT'), coded('EHOSTUNREACH')]),
    coded('ECONNRESET'),
    coded('ENETUNREACH'),
    coded('EHOSTUNREACH'),
    new DOMException(privateText, 'TimeoutError'),
  ]) {
    const failure = await transportError(error);
    assert.equal(failure.calls, 1);
    assert.equal(failure.error.analysisMayContinue, true);
    assert.equal(failure.error.generationNotSent, false);
    assert(!JSON.stringify(failure.error.diagnostic).includes(privateText));
  }
  const repeated = coded('ETIMEDOUT');
  const repeatedFailure = await transportError(network([repeated, repeated]));
  assert.deepEqual(repeatedFailure.error.diagnostic.causeCodes, ['ETIMEDOUT', 'OTHER']);
  assert.equal(
    repeatedFailure.error.analysisMayContinue,
    true,
    'A repeated known object is not an unknown leaf.',
  );
  for (const error of [
    network([coded('ETIMEDOUT'), coded('ERR_TLS_CERT_ALTNAME_INVALID')]),
    network([coded('ETIMEDOUT'), Error(privateText)]),
    network([coded('ETIMEDOUT'), coded('UNKNOWN_PRIVATE_CODE')]),
    new SyntaxError(privateText),
    new TypeError('fetch failed'),
  ]) {
    assert.equal((await transportError(error)).error.analysisMayContinue, false);
  }
  for (const status of [408, 429, 500, 502, 503, 504])
    assert.equal((await transportError(undefined, status)).error.analysisMayContinue, true);
  for (const status of [302, 400, 401, 403, 413, 422])
    assert.equal((await transportError(undefined, status)).error.analysisMayContinue, false);
  const lossy = new MetaTransportError({
    version: 'meta-transport/1',
    phase: 'generation',
    stage: 'requesting',
    attempts: 1,
    code: 'MIXED_CAUSES',
    causeCodes: ['ETIMEDOUT', 'OTHER'],
  });
  assert.equal(
    lossy.analysisMayContinue,
    false,
    'A saved category cannot invent the trusted flag.',
  );
  await assert.rejects(
    () =>
      optionalAnalysisRequest('analyst', async () => {
        throw lossy;
      }),
    (error) => error === lossy,
  );
  await assert.rejects(
    () =>
      optionalAnalysisRequest('sam' as any, async () => {
        throw repeatedFailure.error;
      }),
    /Only analysis or review/,
  );
});

function fixture(
  options: {
    failedRole?: 'analyst' | 'reviewer' | 'driver';
    pending?: boolean;
    nextInput?: boolean;
    failRefresh?: 'ordinary' | 'unsettled' | 'abort';
    stopAtFailure?: boolean;
    stopStateOnly?: boolean;
    finalReviewOnly?: boolean;
    hardHTTP?: number;
    abortAtFailure?: boolean;
    hardError?: unknown;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'access-walk-analysis-network-'));
  const store = new Store(dir),
    run = store.create('Controlled continuing navigation', 'http://127.0.0.1/shop/', 'live');
  const old = store.create('Earlier unknown synthetic request', run.url, 'offline');
  store.db
    .prepare('INSERT INTO requests VALUES(?,?,?,?,?,?,?)')
    .run('historical-unknown', old.id, 'driver', 78087, null, 'unknown', new Date().toISOString());
  store.finish(old.id, 'partial');
  if (options.finalReviewOnly)
    for (let n = 0; n < 3; n++)
      store.db
        .prepare('INSERT INTO requests VALUES(?,?,?,?,?,?,?)')
        .run(
          'earlier-review-' + n,
          run.id,
          'reviewer',
          1,
          1,
          'completed',
          new Date().toISOString(),
        );
  const previous = store.usage(old.id),
    controller = new AbortController();
  const roles: { role: string; captureId?: string; recordIds: string[]; through: number }[] = [];
  let captureCount = 0,
    inputCount = 0,
    capturesAfterInput = 0,
    generations = 0;
  const image = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jA1cAAAAASUVORK5CYII=',
    'base64',
  );
  function capture() {
    const n = captureCount++,
      asset = store.asset(run.id, `capture_${n}.png`, image);
    return store.append(run.id, 'capture', 'browser', {
      url: run.url,
      title: 'Controlled original',
      imageFile: asset.file,
      imageHash: asset.hash,
      width: 1,
      height: 1,
      stable: true,
      stateStamp: `original-state-${n}`,
      elements: [],
      text: 'Original controlled page.',
      aria: '- document',
      focus: { tag: 'button', text: 'Next', name: 'Next' },
    });
  }
  const walk = {
    engine: 'chromium',
    publicWebsite: false,
    async start() {
      const first = capture();
      if (options.pending || options.failedRole === 'reviewer')
        store.append(
          run.id,
          'candidate',
          'analyst',
          {
            issueKey: 'pending',
            scope: 'view',
            visiblePremise: 'A pending test claim.',
            title: 'Pending test claim',
            detail: 'No independent verdict exists.',
            recommendation: 'Inspect the original.',
            basis: 'expert_visual',
            severity: 'minor',
            criterion: null,
            targetId: null,
            targetCaptureId: null,
          },
          [first.id],
        );
      return first;
    },
    assertActive() {
      if (controller.signal.aborted || store.run(run.id).state !== 'running')
        throw Error('Owner stopped this run.');
    },
    images: (records: RecordEntry[]) =>
      records
        .filter((record) => record.kind === 'capture')
        .map((record) => ({
          captureId: record.id,
          image:
            'data:image/png;base64,' +
            store.image(run.id, record.payload.imageFile).toString('base64'),
        })),
    async act(action: any, source: RecordEntry) {
      inputCount++;
      return store.append(
        run.id,
        'action',
        'browser',
        {
          method: 'actual_keyboard_or_browser',
          performed: true,
          outcome: 'performed',
          sourceCaptureId: source.id,
          sourceImageHash: source.payload.imageHash,
          action,
          requestedAction: action,
        },
        [source.id],
      );
    },
    async captureSettled() {
      if (++capturesAfterInput === 4 && options.failRefresh) {
        if (options.failRefresh === 'abort') controller.abort();
        if (options.failRefresh === 'unsettled')
          throw new ObservationUnsettled('Controlled observation could not settle.');
        throw Error('Controlled fresh observation failed.');
      }
      return capture();
    },
    async measurements(source: RecordEntry) {
      return store.append(run.id, 'observation', 'browser', { measured: true }, [source.id]);
    },
    async close() {},
  };
  const actualReason = MetaModels.prototype.reason;
  const networkModels = new MetaModels(
    store,
    (async (url) => {
      if (String(url).endsWith('input_tokens'))
        return new Response(JSON.stringify({ input_tokens: 123 }));
      generations++;
      if (options.stopAtFailure || options.stopStateOnly)
        store.finish(run.id, 'stopped', 'Stopped by owner.');
      if (options.stopAtFailure || options.abortAtFailure) controller.abort();
      if (options.hardHTTP) return new Response('{}', { status: options.hardHTTP });
      if (generations === 1 || !options.nextInput) throw network();
      return new Response(
        JSON.stringify({
          status: 'completed',
          usage: { input_tokens: 123, output_tokens: 20 },
          output: [],
          output_text: JSON.stringify({ findings: [], coverage: [] }),
        }),
      );
    }) as typeof fetch,
    () => ({
      approvedBy: 'Adriano',
      maxUsd: 5,
      maxRunUsd: 3,
      approvedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    }),
    () => 'synthetic-private-key',
  );
  mock.method(MetaModels.prototype, 'reason', async (...args: any[]) => {
    const role = args[1],
      records = args[2] as RecordEntry[];
    roles.push({
      role,
      captureId: records.findLast((record) => record.kind === 'capture')?.id,
      recordIds: records.map((record) => record.id),
      through: Math.max(0, ...records.map((record) => record.seq)),
    });
    if (role === (options.failedRole ?? 'analyst')) {
      if (options.hardError) throw options.hardError;
      return (actualReason as any).apply(networkModels, args);
    }
    if (role === 'driver')
      return {
        kind: inputCount < (options.nextInput ? 4 : 3) ? 'press' : 'finish',
        key: 'Tab',
        note: 'Controlled safe progress.',
      };
    if (role === 'analyst') return { findings: [], coverage: [] };
    return { decisions: [] };
  });
  return {
    dir,
    store,
    run,
    old,
    previous,
    controller,
    roles,
    walk,
    generations: () => generations,
    inputCount: () => inputCount,
    captureCount: () => captureCount,
    execute: () =>
      (new Runner(store, 'http://127.0.0.1:4317') as any).execute(
        run,
        walk,
        { cleanup: async () => {} },
        controller,
        false,
        false,
      ),
    close() {
      mock.restoreAll();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('Actual Runner continues to a fresh driver decision after an uncertain analyst answer without replaying it', async () => {
  const x = fixture();
  try {
    await x.execute();
    assert.deepEqual(
      x.roles.map((row) => row.role),
      ['driver', 'driver', 'driver', 'analyst', 'driver'],
    );
    assert.equal(x.inputCount(), 3);
    assert.equal(x.generations(), 1);
    const failed = x.roles.find((row) => row.role === 'analyst')!,
      next = x.roles.at(-1)!;
    assert.notEqual(next.captureId, failed.captureId, 'The next driver reads a fresh original.');
    const priorWalk = x.store
      .records(x.run.id)
      .filter(
        (record) =>
          ['action', 'navigator_note'].includes(record.kind) && record.seq <= next.through,
      );
    assert.equal(priorWalk.filter((record) => record.kind === 'action').length, 3);
    assert(priorWalk.filter((record) => record.kind === 'navigator_note').length >= 4);
    assert(
      priorWalk.every((record) => next.recordIds.includes(record.id)),
      'The next driver retains the original walk and notes, not a cut summary.',
    );
    assert.equal(x.store.records(x.run.id).filter((record) => record.kind === 'capture').length, 5);
    const usage = x.store.usage(x.run.id);
    assert.equal(usage.requests.length, 1);
    assert.equal(usage.requests[0].role, 'analyst');
    assert.equal(usage.requests[0].status, 'unknown');
    assert.equal(usage.requests[0].actual, null);
    assert(usage.reserved > 0);
    assert.deepEqual(x.store.usage(x.old.id), x.previous);
    assert.deepEqual(x.store.published(x.run.id), []);
    assert.equal(assessmentForRun(x.store, x.run.id).criteria.score, null);
    assert(
      x.store
        .records(x.run.id)
        .some(
          (record) =>
            record.kind === 'limit' &&
            record.author === 'analyst' &&
            record.payload.method === 'analysis_network_unavailable' &&
            record.payload.checkpointState === 'unknown',
        ),
    );
  } finally {
    x.close();
  }
});

test('A failed reviewer cannot accept a claim or retry at final review without another browser input', async () => {
  const x = fixture({ failedRole: 'reviewer' });
  try {
    await x.execute();
    assert.equal(x.roles.filter((row) => row.role === 'reviewer').length, 1);
    assert.equal(x.generations(), 1);
    assert.equal(x.inputCount(), 3);
    assert.equal(x.store.records(x.run.id).filter((record) => record.kind === 'review').length, 0);
    assert.deepEqual(x.store.published(x.run.id), []);
    assert.equal(assessmentForRun(x.store, x.run.id).criteria.score, null);
    assert.equal(x.store.usage(x.run.id).requests[0].status, 'unknown');
    assert.deepEqual(x.store.usage(x.old.id), x.previous);
  } finally {
    x.close();
  }
});

test('Only a later actual input permits a different analysis checkpoint, retaining the earlier unknown charge', async () => {
  const x = fixture({ nextInput: true });
  try {
    await x.execute();
    assert.equal(x.inputCount(), 4);
    assert.equal(x.generations(), 2);
    const analyses = x.roles.filter((row) => row.role === 'analyst');
    assert.equal(analyses.length, 2);
    assert.notEqual(analyses[0].captureId, analyses[1].captureId);
    const usage = x.store.usage(x.run.id);
    assert.deepEqual(
      usage.requests.map((row) => row.status),
      ['unknown', 'completed'],
    );
    assert.equal(usage.requests[0].actual, null);
    assert.deepEqual(x.store.usage(x.old.id), x.previous);
    assert.deepEqual(x.store.published(x.run.id), []);
  } finally {
    x.close();
  }
});

test('Driver network failures stay hard and cannot start final review', async () => {
  const x = fixture({ failedRole: 'driver', pending: true });
  try {
    await x.execute();
    assert.deepEqual(
      x.roles.map((row) => row.role),
      ['driver'],
    );
    assert.equal(x.inputCount(), 0);
    assert.equal(x.generations(), 1);
    assert.equal(x.store.run(x.run.id).state, 'partial');
    assert.equal(x.store.usage(x.run.id).requests[0].status, 'unknown');
  } finally {
    x.close();
  }
});

test('Parent abort, owner Stop and failed observation refresh stop before another driver or review request', async () => {
  for (const options of [
    { stopAtFailure: true },
    { stopStateOnly: true },
    { abortAtFailure: true },
    { failRefresh: 'ordinary' },
    { failRefresh: 'unsettled' },
    { failRefresh: 'abort' },
  ] as const) {
    const x = fixture({ ...options, pending: true });
    try {
      await x.execute();
      assert.deepEqual(
        x.roles.map((row) => row.role),
        ['driver', 'driver', 'driver', 'analyst'],
      );
      assert.equal(x.inputCount(), 3);
      assert.equal(x.generations(), 1);
      assert.equal(
        x.store.run(x.run.id).state,
        options.stopAtFailure || options.stopStateOnly ? 'stopped' : 'partial',
      );
      assert.equal(x.store.usage(x.run.id).requests[0].status, 'unknown');
      assert.deepEqual(x.store.published(x.run.id), []);
      if (options.stopAtFailure || options.stopStateOnly || options.abortAtFailure)
        assert(
          !x.store
            .records(x.run.id)
            .some((record) => record.payload.method === 'analysis_network_unavailable'),
        );
    } finally {
      x.close();
    }
  }
});

test('Permanent, unclassified, malformed, schema and money failures cannot become analysis continuation', async () => {
  const permanent = (await transportError(undefined, 401)).error;
  const tls = (
    await transportError(network([coded('ETIMEDOUT'), coded('ERR_TLS_CERT_ALTNAME_INVALID')]))
  ).error;
  const syntax = (await transportError(new SyntaxError(privateText))).error;
  const schemaError = (() => {
    try {
      analysisSchema.parse({});
    } catch (error) {
      return error;
    }
  })();
  for (const hardError of [
    permanent,
    tls,
    syntax,
    schemaError,
    Error('No Meta API key is available.'),
    Error('Run spending limit reached.'),
    Error('Approved project spending limit reached.'),
  ]) {
    const x = fixture({ hardError, pending: true });
    try {
      await x.execute();
      assert.deepEqual(
        x.roles.map((row) => row.role),
        ['driver', 'driver', 'driver', 'analyst'],
      );
      assert.equal(x.inputCount(), 3);
      assert.equal(x.generations(), 0);
      assert.equal(x.store.run(x.run.id).state, 'partial');
      assert(
        !x.store
          .records(x.run.id)
          .some((record) => record.payload.method === 'analysis_network_unavailable'),
      );
      assert.deepEqual(x.store.usage(x.old.id), x.previous);
    } finally {
      x.close();
    }
  }
});

test('Final review keeps temporary failure unknown but propagates permanent rejection without accepting a claim', async () => {
  for (const status of [503, 401]) {
    const x = fixture({ failedRole: 'reviewer', finalReviewOnly: true, hardHTTP: status });
    try {
      await x.execute();
      assert.equal(x.roles.filter((row) => row.role === 'reviewer').length, 1);
      assert.equal(x.generations(), 1);
      assert.equal(x.store.usage(x.run.id).requests.at(-1)!.status, 'unknown');
      assert.deepEqual(x.store.published(x.run.id), []);
      assert.equal(assessmentForRun(x.store, x.run.id).criteria.score, null);
      const records = x.store.records(x.run.id);
      assert.equal(
        records.some((record) => record.payload.method === 'analysis_network_unavailable'),
        status === 503,
      );
      const workflowLimits = records.filter(
        (record) =>
          record.kind === 'limit' &&
          record.author === 'reviewer' &&
          (record.payload.method === 'analysis_network_unavailable' ||
            record.payload.finalReview === 'incomplete'),
      );
      assert.equal(
        workflowLimits.length,
        status === 503 ? 1 : 0,
        'One final network interruption must produce one workflow note.',
      );
      if (status === 503) assert.equal(workflowLimits[0].payload.finalReview, 'incomplete');
      if (status === 401) assert.match(x.store.run(x.run.id).stopReason!, /status 401/);
      assert.deepEqual(x.store.usage(x.old.id), x.previous);
    } finally {
      x.close();
    }
  }
});

test('Observation, wait and fabricated/mutated records cannot reopen an interrupted role', () => {
  const dir = mkdtempSync(join(tmpdir(), 'access-walk-analysis-defer-')),
    store = new Store(dir);
  try {
    const run = store.create('Controlled defer policy', 'http://127.0.0.1/shop', 'offline');
    store.append(run.id, 'limit', 'analyst', {
      method: 'analysis_network_unavailable',
      checkpointState: 'unknown',
    });
    const source = store.append(run.id, 'capture', 'browser', {
      original: true,
      stable: true,
      imageHash: 'a'.repeat(64),
    });
    store.append(
      run.id,
      'action',
      'browser',
      {
        method: 'actual_keyboard_or_browser',
        outcome: 'performed',
        sourceCaptureId: source.id,
        sourceImageHash: source.payload.imageHash,
        action: { kind: 'wait' },
      },
      [source.id],
    );
    assert(analysisNetworkDeferred(store.records(run.id), 'analyst'));
    store.append(
      run.id,
      'action',
      'browser',
      {
        method: 'actual_keyboard_or_browser',
        outcome: 'not performed',
        sourceCaptureId: source.id,
        sourceImageHash: source.payload.imageHash,
        action: { kind: 'press', key: 'Tab' },
      },
      [source.id],
    );
    store.append(run.id, 'action', 'browser', {
      method: 'actual_keyboard_or_browser',
      outcome: 'performed',
      action: { kind: 'press', key: 'Tab' },
    });
    assert(
      analysisNetworkDeferred(store.records(run.id), 'analyst'),
      'Unperformed or unbound records cannot reopen the role.',
    );
    const input = store.append(
      run.id,
      'action',
      'browser',
      {
        method: 'actual_keyboard_or_browser',
        outcome: 'performed',
        sourceCaptureId: source.id,
        sourceImageHash: source.payload.imageHash,
        action: { kind: 'press', key: 'Tab' },
      },
      [source.id],
    );
    assert.equal(analysisNetworkDeferred(store.records(run.id), 'analyst'), false);
    store.db.prepare('UPDATE records SET body=? WHERE id=?').run(
      JSON.stringify({
        method: 'actual_keyboard_or_browser',
        action: { kind: 'press', key: 'Enter' },
      }),
      input.id,
    );
    assert.throws(
      () => analysisNetworkDeferred(store.records(run.id), 'analyst'),
      /original input changed/,
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('A deferred role cannot bypass the original capture hash guard', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'access-walk-deferred-source-')),
    store = new Store(dir);
  try {
    const run = store.create(
      'Controlled changed source refusal',
      'http://127.0.0.1/shop',
      'offline',
    );
    const asset = store.asset(run.id, 'capture.png', Buffer.from('original controlled image'));
    const capture = store.append(run.id, 'capture', 'browser', {
      url: run.url,
      stable: true,
      imageFile: asset.file,
      imageHash: asset.hash,
      elements: [],
      text: 'Original text',
    });
    store.append(
      run.id,
      'limit',
      'analyst',
      { method: 'analysis_network_unavailable', checkpointState: 'unknown' },
      [capture.id],
    );
    store.db
      .prepare('UPDATE records SET body=? WHERE id=?')
      .run(JSON.stringify({ ...capture.payload, text: 'Changed source' }), capture.id);
    let calls = 0;
    const models = {
      reason: async () => {
        calls++;
        throw Error('No model request may occur.');
      },
    };
    const walk = {
      images: () => [],
      assertActive() {},
      captureSettled: async () => {
        throw Error('No observation should disguise the changed source.');
      },
    };
    await assert.rejects(
      () =>
        (new Runner(store, 'http://127.0.0.1:4317') as any).analyseCheckpoint(
          models,
          run,
          capture,
          walk,
          new AbortController().signal,
        ),
      /original evidence is missing or changed/,
    );
    assert.equal(calls, 0);
    assert.equal(store.usage().requests.length, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
