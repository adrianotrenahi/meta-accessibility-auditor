import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, digest } from '../src/store.js';
import { earlierPageScan } from '../src/repeat-checkpoint.js';
import { requestEvidence, EvidenceRequestLimit } from '../src/request-evidence.js';
import { imageRecordsForRead } from '../src/image-receipt.js';
import {
  MetaModels,
  navigationActionSchema,
  analysisSchema,
  estimateInputTokens,
  IMAGE_TOKEN_ESTIMATE,
} from '../src/models.js';
import { CAPS } from '../src/types.js';
import { Runner } from '../src/runner.js';

function seeded() {
  const dir = mkdtempSync(join(tmpdir(), 'scan-once-per-page-'));
  const store = new Store(dir);
  const run = store.create('Once per page', 'https://www.booking.com/', 'offline');
  const bytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jYj0AAAAASUVORK5CYII=',
    'base64',
  );
  let n = 0;
  const capture = (url: string) => {
    const image = store.asset(run.id, `capture_${n}.png`, bytes);
    return store.append(run.id, 'capture', 'browser', {
      url,
      stable: true,
      stateStamp: digest(String(n++)),
      imageFile: image.file,
      imageHash: image.hash,
      width: 1,
      height: 1,
      aria: '- link "Vuelos"\n- text: Compara y reserva vuelos',
      text: 'Compara y reserva vuelos',
      elements: [
        {
          id: 'e12',
          role: 'link',
          name: 'Vuelos',
          tag: 'a',
          text: 'Vuelos',
          type: '',
          disabled: false,
          box: { x: 10, y: 20, width: 80, height: 30 },
          selector:
            'html:nth-of-type(1) > body:nth-of-type(1) > div:nth-of-type(1) > a:nth-of-type(2)',
          contextFingerprint: 'c'.repeat(64),
        },
      ],
      limits: { imageScope: 'viewport', visibleTextTruncated: false },
      imageProvenance: { source: 'Browser-rendered page viewport', engineAddedAnnotations: false },
    });
  };
  const scan = (source: ReturnType<typeof capture>) =>
    store.append(
      run.id,
      'observation',
      'axe-core',
      {
        method: 'automatic_accessibility_scan',
        sourceCaptureId: source.id,
        sourceCaptureHash: source.hash,
        stable: true,
      },
      [source.id],
    );
  return {
    store,
    run,
    capture,
    scan,
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// Owner, 31 Oct: "We should keep it but only once per page."
test('The page check runs once per page: a later step on the same page reuses it', () => {
  const x = seeded();
  try {
    const home = x.capture('https://www.booking.com/index.es.html?aid=1&label=a');
    assert.equal(earlierPageScan(x.store.records(x.run.id), home), undefined, 'never measured');
    const first = x.scan(home);
    // Booking's tracking parameters change; it is still the same page.
    const later = x.capture('https://www.booking.com/index.es.html?aid=2&label=b#top');
    assert.equal(earlierPageScan(x.store.records(x.run.id), later)?.id, first.id);
    // A different search or page number is a different page; the order of parameters is not.
    const search = x.capture('https://www.example.com/search?q=flights&page=1&utm_source=x');
    x.scan(search);
    for (const [url, same] of [
      ['https://www.example.com/search?page=1&q=flights', true],
      ['https://www.example.com/search?q=hotels&page=1', false],
      ['https://www.example.com/search?q=flights&page=2', false],
    ] as const) {
      const shot = x.capture(url);
      assert.equal(!!earlierPageScan(x.store.records(x.run.id), shot), same, url);
    }
    const flights = x.capture('https://www.booking.com/flights/index.es.html?aid=2');
    assert.equal(earlierPageScan(x.store.records(x.run.id), flights), undefined, 'a new page');
    // A scan that did not settle does not count as measured.
    x.store.append(
      x.run.id,
      'observation',
      'axe-core',
      {
        method: 'automatic_accessibility_scan',
        sourceCaptureId: flights.id,
        sourceCaptureHash: flights.hash,
        stable: false,
      },
      [flights.id],
    );
    const again = x.capture('https://www.booking.com/flights/index.es.html');
    assert.equal(earlierPageScan(x.store.records(x.run.id), again), undefined);
  } finally {
    x.close();
  }
});

// Owner, 31 Oct: the page's visible text repeats its structure; the navigator reads it once.
test('The navigator is sent the page structure without the repeated visible text', async () => {
  for (const role of ['driver', 'analyst'] as const) {
    const x = seeded();
    try {
      const current = x.capture('https://www.booking.com/index.es.html');
      const packet = requestEvidence(x.store, x.run.id, role, current);
      let sent: any;
      const model = new MetaModels(
        x.store,
        (async (_url, init) => {
          const body = JSON.parse(String(init?.body));
          sent ??= JSON.parse(body.input[0].content[0].text);
          // Refuse at the token count, before any generation is sent or charged.
          return Response.json({ input_tokens: CAPS[role].input + 1 });
        }) as typeof fetch,
        () => ({
          approvedBy: 'Adriano',
          maxUsd: 3,
          maxRunUsd: 3,
          approvedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        }),
        () => 'mock-key-no-provider-access',
      );
      await assert.rejects(
        model.reason(
          x.run.id,
          role,
          packet.records,
          imageRecordsForRead(packet).map((capture) => ({
            captureId: capture.id,
            image:
              'data:image/png;base64,' +
              x.store.image(x.run.id, capture.payload.imageFile).toString('base64'),
          })),
          (role === 'driver' ? navigationActionSchema : analysisSchema) as any,
          false,
          new AbortController().signal,
          packet.read,
        ),
        EvidenceRequestLimit,
      );
      const page = sent.find((record: any) => record.id === current.id).payload;
      assert.equal(page.aria, current.payload.aria, `${role} reads the page structure`);
      const control = page.elements[0];
      assert.deepEqual([control.id, control.role, control.name], ['e12', 'link', 'Vuelos']);
      if (role === 'driver') {
        assert(!('text' in page), 'the navigator skips the repeated text');
        // Owner, 31 Oct: the navigator acts by id or name; it never uses these two.
        assert(!('selector' in control) && !('contextFingerprint' in control));
        assert.deepEqual(control.box, current.payload.elements[0].box);
      } else {
        assert.equal(page.text, current.payload.text, 'the analyst still reads it');
        assert.deepEqual(control, current.payload.elements[0], 'the analyst reads every field');
      }
    } finally {
      x.close();
    }
  }
});

test('The runner skips a second scan of one page, and notes it only for a different screenshot', async () => {
  const x = seeded();
  try {
    const runner = new Runner(x.store, 'http://127.0.0.1:4317');
    const walk = {
      waitForReloadsToStop: async () => true,
      measurements: async () => {
        throw Error('The page was scanned again.');
      },
    };
    const automatic = (source: ReturnType<typeof x.capture>) =>
      (runner as any).automaticMeasurement(x.run, walk, source, new AbortController().signal);
    const notes = () =>
      x.store
        .records(x.run.id)
        .filter((r) => r.kind === 'coverage' && r.payload.method === 'page_scan_reused/1');
    const home = x.capture('https://www.booking.com/index.es.html?aid=1');
    const scan = x.scan(home);
    // New evidence on the same screenshot: still the same page, measured once, and no note
    // claiming an earlier screenshot.
    x.store.append(x.run.id, 'action', 'browser', { method: 'actual_keyboard_or_browser' });
    assert.equal((await automatic(home)).scan.id, scan.id);
    assert.equal(notes().length, 0);
    // A later screenshot of the same page reuses the scan and says so.
    const later = x.capture('https://www.booking.com/index.es.html?aid=2');
    assert.equal((await automatic(later)).scan.id, scan.id);
    assert.equal(notes().length, 1);
    assert.equal(notes()[0]!.payload.sourceCaptureId, later.id);
  } finally {
    x.close();
  }
});

// Owner, 31 Oct: one request per navigator decision instead of two. Audits switch the local
// size estimate on; the analyst still asks Meta for the size first.
test('With the local estimate on, a navigator decision is one request to Meta', async () => {
  for (const role of ['driver', 'analyst'] as const) {
    const x = seeded();
    try {
      const current = x.capture('https://www.booking.com/index.es.html');
      const packet = requestEvidence(x.store, x.run.id, role, current);
      const urls: string[] = [];
      const model = new MetaModels(
        x.store,
        (async (url) => {
          urls.push(String(url));
          if (String(url).endsWith('/input_tokens')) return Response.json({ input_tokens: 1000 });
          return Response.json({
            status: 'completed',
            usage: { input_tokens: 1000, output_tokens: 10 },
            output:
              role === 'driver'
                ? [
                    {
                      type: 'function_call',
                      name: 'return_result',
                      arguments: JSON.stringify({ kind: 'press', key: 'Tab', note: 'Next' }),
                    },
                  ]
                : [],
            output_text: JSON.stringify({ findings: [], coverage: [] }),
          });
        }) as typeof fetch,
        () => ({
          approvedBy: 'Adriano',
          maxUsd: 3,
          maxRunUsd: 3,
          approvedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        }),
        () => 'mock-key-no-provider-access',
      );
      model.estimateNavigatorInput = true;
      await model
        .reason(
          x.run.id,
          role,
          packet.records,
          imageRecordsForRead(packet).map((capture) => ({
            captureId: capture.id,
            image:
              'data:image/png;base64,' +
              x.store.image(x.run.id, capture.payload.imageFile).toString('base64'),
          })),
          (role === 'driver' ? navigationActionSchema : analysisSchema) as any,
          false,
          new AbortController().signal,
          packet.read,
        )
        .catch(() => undefined);
      const counts = urls.filter((url) => url.endsWith('/input_tokens')).length;
      assert.equal(counts, role === 'driver' ? 0 : 1, `${role} size checks`);
      assert.equal(urls.length - counts, 1, `${role} sends one generation`);
      assert.equal(x.store.usage(x.run.id).requests[0]!.role, role, 'money is still set aside');
    } finally {
      x.close();
    }
  }
});

// Codex and Loca, PR 60: one token per three characters is not an upper bound for Chinese,
// Arabic, emoji or long hex hashes. The estimate now counts bytes and allows 10,000 per image.
test('The local size estimate never falls below the text bytes, for any script', () => {
  for (const text of [
    '东京到大阪的航班'.repeat(500),
    'رحلات من الدار البيضاء'.repeat(300),
    '✈️🧳🌍'.repeat(400),
    'e6315e2de573bcf353776c1b4e8dc315a9ba626fc1551b652b443a62bf44673e'.repeat(80),
  ]) {
    const bytes = Buffer.byteLength(text, 'utf8');
    const estimate = estimateInputTokens({ input: [{ content: [{ type: 'input_text', text }] }] });
    assert(estimate >= bytes, `${estimate} < ${bytes}`);
  }
  const withImage = estimateInputTokens({
    input: [{ content: [{ type: 'input_text', text: '' }, { type: 'input_image' }] }],
  });
  assert(withImage >= IMAGE_TOKEN_ESTIMATE);
});

test('A strict estimate over the limit asks Meta, and an overspend leaves a warning', async () => {
  for (const scenario of ['huge page', 'overspend'] as const) {
    const x = seeded();
    try {
      const current =
        scenario === 'huge page'
          ? x.store.append(x.run.id, 'capture', 'browser', {
              ...x.capture('https://www.booking.com/').payload,
              aria: 'x'.repeat(CAPS.driver.input + 10),
            })
          : x.capture('https://www.booking.com/');
      const packet = requestEvidence(x.store, x.run.id, 'driver', current);
      const urls: string[] = [];
      const model = new MetaModels(
        x.store,
        (async (url) => {
          urls.push(String(url));
          if (String(url).endsWith('/input_tokens')) return Response.json({ input_tokens: 5000 });
          return Response.json({
            status: 'completed',
            // The overspend case reports far more than any estimate allowed for.
            usage: { input_tokens: scenario === 'overspend' ? 900_000 : 5000, output_tokens: 10 },
            output: [
              {
                type: 'function_call',
                name: 'return_result',
                arguments: JSON.stringify({ kind: 'press', key: 'Tab', note: 'Next' }),
              },
            ],
          });
        }) as typeof fetch,
        () => ({
          approvedBy: 'Adriano',
          maxUsd: 3,
          maxRunUsd: 3,
          approvedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        }),
        () => 'mock-key-no-provider-access',
      );
      model.estimateNavigatorInput = true;
      await model.reason(
        x.run.id,
        'driver',
        packet.records,
        imageRecordsForRead(packet).map((capture) => ({
          captureId: capture.id,
          image:
            'data:image/png;base64,' +
            x.store.image(x.run.id, capture.payload.imageFile).toString('base64'),
        })),
        navigationActionSchema as any,
        false,
        new AbortController().signal,
        packet.read,
      );
      const asked = urls.filter((url) => url.endsWith('/input_tokens')).length;
      const warned = x.store
        .records(x.run.id)
        .some((r) => r.kind === 'limit' && r.payload.method === 'reservation_exceeded');
      if (scenario === 'huge page') {
        assert.equal(asked, 1, 'too big by the strict count: Meta is asked for the exact size');
        assert(!warned);
      } else {
        assert.equal(asked, 0);
        assert(warned, 'a charge above the money set aside is recorded');
      }
    } finally {
      x.close();
    }
  }
});
