import assert from 'node:assert/strict';
import test from 'node:test';
import { metaReportScreens } from '../host/ui/lib/metaScreenState.js';

// Owner, 31 Oct: the Findings tab showed 23 screens for a Booking.com audit whose strip
// showed 3. The report now uses the strip's screens, with the picture the analyst read.
const capture = (n: number, url: string, extra: { screenState?: unknown } = {}) => ({
  id: `c${n}`,
  sequence: n,
  url,
  title: url,
  width: 1440,
  height: 900,
  stable: true,
  ...extra,
});
const home = 'https://www.booking.com/index.es.html';
const flights = 'https://www.booking.com/flights/index.es.html';
const key = (c: { url: string }) => c.url;

test('A page visit is one report screen, shown with the picture the analyst read', () => {
  const captures = [
    capture(1, home),
    capture(2, home),
    capture(3, home),
    capture(4, home),
    capture(5, flights),
    capture(6, flights),
    capture(7, flights),
  ];
  const screens = metaReportScreens(
    {
      captures,
      analysis: {
        completed: [
          { role: 'analyst', captureIds: ['c2'] },
          { role: 'reviewer', captureIds: ['c3'] },
          { role: 'analyst', captureIds: ['c6'] },
        ],
      },
      findings: [],
    },
    key,
  );
  assert.deepEqual(
    screens.map((s) => [s.primary.id, s.originals.map((c) => c.id), s.analysed]),
    [
      ['c2', ['c2'], true],
      ['c6', ['c6'], true],
    ],
  );
  // Every original stays with its screen, so finding pins and evidence still resolve.
  assert.deepEqual(
    screens.map((s) => s.captures.map((c) => c.id)),
    [
      ['c1', 'c2', 'c3', 'c4'],
      ['c5', 'c6', 'c7'],
    ],
  );
});

test('A screen nobody analysed shows its latest picture, as the strip does', () => {
  const screens = metaReportScreens(
    { captures: [capture(1, home), capture(2, home), capture(3, flights)], findings: [] },
    key,
  );
  assert.deepEqual(
    screens.map((s) => [s.primary.id, s.analysed]),
    [
      ['c2', false],
      ['c3', false],
    ],
  );
});

test('A popup keeps its own screen, and a finding keeps its picture visible', () => {
  const popup = { version: 'meaningful-screen/1', fingerprint: 'a'.repeat(64), purpose: 'screen' };
  const screens = metaReportScreens(
    {
      captures: [capture(1, home, { screenState: popup }), capture(2, home), capture(3, home)],
      findings: [{ captureIds: ['c3'], anchor: null }],
    },
    key,
  );
  assert.deepEqual(
    screens.map((s) => [s.primary.id, s.captures.map((c) => c.id)]),
    [
      ['c1', ['c1']],
      ['c3', ['c2', 'c3']],
    ],
  );
});

test('Returning to a page after another one is a new screen, as on the strip', () => {
  const screens = metaReportScreens(
    { captures: [capture(1, home), capture(2, flights), capture(3, home)], findings: [] },
    key,
  );
  assert.deepEqual(
    screens.map((s) => s.primary.id),
    ['c1', 'c2', 'c3'],
  );
});

test('Two analysed pictures of one page are two screens: the cookie banner and the home page', () => {
  const screens = metaReportScreens(
    {
      captures: [capture(1, home), capture(2, home), capture(3, home), capture(4, home)],
      analysis: { completed: [{ role: 'analyst', captureIds: ['c2', 'c4'] }] },
      findings: [],
    },
    key,
  );
  assert.deepEqual(
    screens.map((s) => [s.primary.id, s.originals.map((c) => c.id), s.captures.map((c) => c.id)]),
    [
      ['c2', ['c2'], ['c1', 'c2']],
      ['c4', ['c4'], ['c3', 'c4']],
    ],
  );
});
