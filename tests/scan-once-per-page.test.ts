import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, digest } from '../src/store.js';
import { earlierPageScan } from '../src/repeat-checkpoint.js';
import { requestEvidence, EvidenceRequestLimit } from '../src/request-evidence.js';
import { imageRecordsForRead } from '../src/image-receipt.js';
import { MetaModels, navigationActionSchema, analysisSchema } from '../src/models.js';
import { CAPS } from '../src/types.js';

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
      elements: [],
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
      if (role === 'driver') assert(!('text' in page), 'the navigator skips the repeated text');
      else assert.equal(page.text, current.payload.text, 'the analyst still reads it');
    } finally {
      x.close();
    }
  }
});
