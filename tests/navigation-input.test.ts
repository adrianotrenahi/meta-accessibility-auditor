import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, digest } from '../src/store.js';
import { requestEvidence, EvidenceRequestLimit } from '../src/request-evidence.js';
import { navigationInput, NAVIGATION_INPUT_VERSION } from '../src/navigation-input.js';
import { MetaModels, actionSchema, analysisSchema, reviewSchema } from '../src/models.js';
import { CAPS } from '../src/types.js';
import { suppliedImageIds } from '../src/image-receipt.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'access-walk-navigation-input-'));
  const store = new Store(dir);
  const run = store.create(
    'Reject cookies and find the flight search',
    'https://example.test/',
    'offline',
  );
  const bytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/h3sAAAAASUVORK5CYII=',
    'base64',
  );
  const asset = store.asset(run.id, 'controlled.png', bytes);
  const capture = store.append(run.id, 'capture', 'browser', {
    url: run.url,
    title: 'Controlled consent screen',
    stable: true,
    imageFile: asset.file,
    imageHash: asset.hash,
    width: 1,
    height: 1,
    stateStamp: digest('controlled-state'),
    elements: [
      {
        id: 'reject',
        name: 'Reject optional cookies',
        role: 'button',
        tag: 'button',
        disabled: false,
      },
    ],
    focus: {
      id: 'reject',
      name: 'Reject optional cookies',
      tag: 'button',
      hasForm: false,
      paymentForm: false,
    },
    text: 'Unabridged original page body. '.repeat(2000),
    aria: 'Unabridged original accessibility tree. '.repeat(3000),
    limits: { totalControls: 300, maximumListedControls: 60, imageScope: 'viewport' },
    futureSafetyInformation: { commitment: true },
  });
  const note = store.append(
    run.id,
    'navigator_note',
    'driver',
    { kind: 'progress', text: 'Original factual note, not a digest.' },
    [capture.id],
  );
  const calls: { url: string; body: any }[] = [];
  const schemaResult = (role: string) =>
    role === 'analyst_result'
      ? {
          findings: [],
          coverage: [],
          visualObservations: [],
          criterionProposals: [],
          missingEvidence: [],
        }
      : { decisions: [], criterionDecisions: [] };
  const model = (count = 100) =>
    new MetaModels(
      store,
      (async (url, init) => {
        const body = JSON.parse(String(init?.body));
        calls.push({ url: String(url), body });
        if (String(url).endsWith('/input_tokens')) return Response.json({ input_tokens: count });
        const driver = !!body.tools;
        const role = body.text?.format.name;
        return Response.json({
          status: 'completed',
          usage: { input_tokens: 100, output_tokens: 20 },
          output: driver
            ? [
                {
                  type: 'function_call',
                  name: 'return_result',
                  arguments: JSON.stringify({
                    kind: 'press',
                    key: 'Enter',
                    note: 'Activate the focused Reject control.',
                  }),
                },
              ]
            : [
                {
                  type: 'message',
                  content: [{ type: 'output_text', text: JSON.stringify(schemaResult(role)) }],
                },
              ],
        });
      }) as typeof fetch,
      () => ({
        approvedBy: 'Adriano',
        maxUsd: 3,
        maxRunUsd: 1,
        approvedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      }),
      () => 'mock-no-provider-key',
    );
  const images = [
    { captureId: capture.id, image: 'data:image/png;base64,' + bytes.toString('base64') },
  ];
  return {
    store,
    run,
    capture,
    note,
    calls,
    model,
    images,
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('Navigation reads a labelled view while preserving complete controls, safety information and original notes', () => {
  const x = fixture();
  try {
    const before = x.store.records(x.run.id);
    const read = requestEvidence(x.store, x.run.id, 'driver', x.capture);
    const view = navigationInput(read.records, x.capture.id);
    const value = JSON.parse(view.text);
    assert.equal(value.version, NAVIGATION_INPUT_VERSION);
    assert.equal(value.scope, 'navigation-only');
    const current = value.records.find((r: any) => r.kind === 'navigation_capture_view');
    assert.equal(current.original.id, x.capture.id);
    assert.equal(current.original.hash, x.capture.hash);
    assert.deepEqual(current.view.elements, x.capture.payload.elements);
    assert.deepEqual(current.view.focus, x.capture.payload.focus);
    assert.deepEqual(current.view.futureSafetyInformation, { commitment: true });
    assert.deepEqual(current.view.limits, x.capture.payload.limits);
    assert.deepEqual(current.omittedOriginalFields, ['text', 'aria']);
    assert(!Object.hasOwn(current.view, 'text') && !Object.hasOwn(current.view, 'aria'));
    assert.match(value.limit, /not supplied/);
    assert.match(value.limit, /not evidence that content is absent/);
    assert.deepEqual(
      value.records.find((r: any) => r.id === x.note.id),
      x.note,
    );
    assert.deepEqual(read.read.payload.navigationView, view.manifest);
    assert.deepEqual(suppliedImageIds(read.read, read.records), [x.capture.id]);
    assert(view.text.length < JSON.stringify(read.records).length / 3);
    for (const original of before)
      assert.deepEqual(x.store.record(x.run.id, original.id), original);
  } finally {
    x.close();
  }
});

test('Counting and generation use the same pinned navigation view and original screenshot', async () => {
  const x = fixture();
  try {
    const read = requestEvidence(x.store, x.run.id, 'driver', x.capture);
    await x
      .model()
      .reason(
        x.run.id,
        'driver',
        read.records,
        x.images,
        actionSchema,
        false,
        undefined,
        read.read,
      );
    assert.equal(x.calls.length, 2);
    assert.deepEqual(x.calls[0].body, x.calls[1].body);
    const text = x.calls[0].body.input[0].content[0].text;
    assert.equal(digest(text), read.read.payload.navigationView.inputHash);
    assert.equal(JSON.parse(text).scope, 'navigation-only');
    assert.equal(x.calls[0].body.input[0].content.at(-1).image_url, x.images[0].image);
    assert.equal(x.store.usage(x.run.id).requests.length, 1);
  } finally {
    x.close();
  }
});

test('Navigation preserves verbatim control states and dialog names with original tree line numbers', () => {
  const x = fixture();
  try {
    const aria =
      '- heading "Unselected prose"\n  - dialog "Cookie preferences"\n    - checkbox "Marketing" [checked]\n    - paragraph "Other original text"\n    - combobox "Destination" [expanded]\n      - option "London" [selected]';
    const current = x.store.append(x.run.id, 'capture', 'browser', { ...x.capture.payload, aria });
    const read = requestEvidence(x.store, x.run.id, 'driver', current);
    const input = JSON.parse(navigationInput(read.records, current.id).text);
    const tree = input.records.find((r: any) => r.kind === 'navigation_capture_view').view
      .navigationTree;
    assert.equal(tree.sourceField, 'aria');
    assert.equal(tree.sourceLineCount, 6);
    assert.deepEqual(tree.lines, [
      { line: 2, text: '  - dialog "Cookie preferences"' },
      { line: 3, text: '    - checkbox "Marketing" [checked]' },
      { line: 5, text: '    - combobox "Destination" [expanded]' },
      { line: 6, text: '      - option "London" [selected]' },
    ]);
    assert.match(tree.limit, /Other tree lines are not supplied/);
    assert.equal(x.store.record(x.run.id, current.id)!.payload.aria, aria);
  } finally {
    x.close();
  }
});

test('Analysis and independent review keep full original text and trees without the navigation projection', async () => {
  for (const role of ['analyst', 'reviewer'] as const) {
    const x = fixture();
    try {
      const read = requestEvidence(x.store, x.run.id, role, x.capture);
      assert.equal(Object.hasOwn(read.read.payload, 'navigationView'), false);
      await x
        .model()
        .reason<unknown>(
          x.run.id,
          role,
          read.records,
          x.images,
          role === 'analyst' ? analysisSchema : reviewSchema,
          false,
          undefined,
          read.read,
        );
      const actual = JSON.parse(x.calls[0].body.input[0].content[0].text);
      assert.deepEqual(actual, read.records);
      const current = actual.find((r: any) => r.id === x.capture.id);
      assert(current);
      assert.equal(current.payload.aria, x.capture.payload.aria);
      assert.equal(current.payload.text, x.capture.payload.text);
    } finally {
      x.close();
    }
  }
});

test('Changed omitted originals, reordered reads and forged navigation manifests refuse before a provider call', async () => {
  for (const mode of ['omitted-original', 'reordered', 'extra-record', 'manifest'] as const) {
    const x = fixture();
    try {
      const read = requestEvidence(x.store, x.run.id, 'driver', x.capture);
      if (mode === 'omitted-original')
        read.records.find((r) => r.id === x.capture.id)!.payload.aria += 'changed';
      if (mode === 'reordered') read.records.reverse();
      if (mode === 'extra-record') {
        read.records.push(
          x.store.append(x.run.id, 'navigator_note', 'driver', {
            text: 'Not in the pinned original read.',
          }),
        );
      }
      if (mode === 'manifest' || mode === 'extra-record') {
        const payload = {
          ...read.read.payload,
          navigationView:
            mode === 'manifest'
              ? { ...read.read.payload.navigationView, inputHash: 'a'.repeat(64) }
              : navigationInput(read.records, x.capture.id).manifest,
        };
        const body = JSON.stringify(payload);
        const hash = digest(body);
        x.store.db
          .prepare('UPDATE records SET body=?,hash=? WHERE id=?')
          .run(body, hash, read.read.id);
        read.read.payload = payload;
        read.read.hash = hash;
      }
      await assert.rejects(
        x
          .model()
          .reason(
            x.run.id,
            'driver',
            read.records,
            x.images,
            actionSchema,
            false,
            undefined,
            read.read,
          ),
      );
      assert.equal(x.calls.length, 0);
      assert.equal(x.store.usage(x.run.id).requests.length, 0);
    } finally {
      x.close();
    }
  }
});

test('An over-limit navigation request still makes no generation or spending reservation', async () => {
  const x = fixture();
  try {
    const read = requestEvidence(x.store, x.run.id, 'driver', x.capture);
    await assert.rejects(
      x
        .model(CAPS.driver.input + 1)
        .reason(
          x.run.id,
          'driver',
          read.records,
          x.images,
          actionSchema,
          false,
          undefined,
          read.read,
        ),
      (error) => error instanceof EvidenceRequestLimit && error.role === 'driver',
    );
    assert.equal(x.calls.length, 1);
    assert(x.calls[0].url.endsWith('/input_tokens'));
    assert.equal(x.store.usage(x.run.id).requests.length, 0);
  } finally {
    x.close();
  }
});

test('A retained legacy driver read keeps its original full input format', async () => {
  const x = fixture();
  try {
    const current = requestEvidence(x.store, x.run.id, 'driver', x.capture);
    const { navigationView: _navigationView, ...legacyPayload } = current.read.payload;
    const legacy = x.store.append(x.run.id, 'read_snapshot', 'driver', legacyPayload);
    await x
      .model()
      .reason(
        x.run.id,
        'driver',
        current.records,
        x.images,
        actionSchema,
        false,
        undefined,
        legacy,
      );
    assert.deepEqual(JSON.parse(x.calls[0].body.input[0].content[0].text), current.records);
    assert.equal(Object.hasOwn(legacy.payload, 'navigationView'), false);
  } finally {
    x.close();
  }
});
