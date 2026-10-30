import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ariaDifference,
  contentSettled,
  pageStamp,
  sameForInput,
  sameForScan,
} from '../src/page-state.js';

const page = (lines: string[]) => lines.join('\n');
const ordinary = Array.from({ length: 236 }, (_, index) => `- link "Destination ${index}"`);

test('A rotating promotion is ordinary drift, not a different screen', () => {
  const before = page([
    ...ordinary,
    '- text: Save up to €100s on flights',
    '- button "Discover Prime"',
  ]);
  const after = page([...ordinary, '- text: Save up to €270 on hotels', '- button "Book now"']);
  assert.equal(ariaDifference(before, after).length, 4);
  assert.equal(contentSettled(before, after), true);
  assert.equal(contentSettled(before, before), true);
});

test('A popup opening or closing is never tolerated as drift', () => {
  const before = page(ordinary);
  const opened = page([...ordinary, '- dialog "Sign in for member prices":', '  - button "Close"']);
  assert.equal(contentSettled(before, opened), false);
  assert.equal(contentSettled(opened, before), false);
  assert.equal(
    contentSettled(before, page([...ordinary, '- alertdialog "Session ending"'])),
    false,
  );
});

test('A substantially different page is not drift', () => {
  const results = Array.from({ length: 60 }, (_, index) => `- link "Flight ${index}"`);
  assert.equal(contentSettled(page(ordinary), page([...ordinary.slice(60), ...results])), false);
  // Small pages still allow a few changing lines.
  assert.equal(
    contentSettled(page(['- heading "A"', '- text: 1']), page(['- heading "A"', '- text: 2'])),
    true,
  );
});

test('Repeated lines are compared as counts, not as a set', () => {
  const one = page(['- button "Add"', '- text: Bag']);
  const many = page([...Array(30).fill('- button "Add"'), '- text: Bag']);
  assert.equal(ariaDifference(one, many).length, 29);
  assert.equal(contentSettled(one, many), false);
});

test('Missing snapshots are never settled', () => {
  assert.equal(contentSettled(undefined, page(ordinary)), false);
  assert.equal(contentSettled(page(ordinary), null), false);
});

test('The page stamp ignores focus but not address, scroll or dialogs', () => {
  const base = {
    documentEpoch: 1,
    url: 'https://example.test/',
    focus: { name: 'Flights' },
    focusHelp: [],
    scroll: { x: 0, y: 0 },
    dialogs: [],
  };
  assert.equal(pageStamp(base), pageStamp({ ...base, focus: { name: 'Hotels' } }));
  assert.notEqual(pageStamp(base), pageStamp({ ...base, scroll: { x: 0, y: 600 } }));
  assert.notEqual(pageStamp(base), pageStamp({ ...base, url: 'https://example.test/results' }));
  assert.notEqual(
    pageStamp(base),
    pageStamp({ ...base, dialogs: [{ role: 'dialog', name: 'Cookies' }] }),
  );
});

test('With nothing focused, rotating page copy is not a focus change', () => {
  const state = (focusText: string, name = '') => ({
    documentEpoch: 1,
    url: 'https://example.test/',
    aria: '- link "Flights"',
    focus: { tag: 'body', text: focusText, name },
    focusHelp: [],
    scroll: { x: 0, y: 0 },
    dialogs: [],
  });
  const saved = { ...state('Save on flights'), pageStamp: pageStamp(state('Save on flights')) };
  assert.equal(sameForInput(saved, state('Offer number 7')), true);
  const button = (text: string) => ({ ...state(''), focus: { tag: 'button', text, name: text } });
  const savedButton = { ...button('Search'), pageStamp: pageStamp(button('Search')) };
  assert.equal(sameForInput(savedButton, button('Book now')), false);
  // Records saved before page-state/1 keep their exact comparison.
  assert.equal(sameForInput({ stateStamp: 'old' }, state('Save on flights')), false);
});

test('An empty snapshot never counts as the same page', () => {
  assert.equal(contentSettled('', page(['- heading "Flights"', '- button "Search"'])), false);
  assert.equal(contentSettled(page(['- heading "Flights"']), ''), false);
  assert.equal(contentSettled('', ''), true);
});

test("eDreams' measured carousel drift (23 differing lines of 286) is settled; results are not", () => {
  const home = Array.from({ length: 286 }, (_, index) => `- text: Home line ${index}`);
  const slides = (count: number) => Array.from({ length: count }, (_, i) => `- text: Slide ${i}`);
  // 12 lines replaced by 11 others: 23 differing lines, the largest drift measured.
  const drifted = [...home.slice(0, 274), ...slides(11)];
  assert.equal(ariaDifference(page(home), page(drifted)).length, 23);
  assert.equal(contentSettled(page(home), page(drifted)), true);
  const results = Array.from({ length: 200 }, (_, index) => `- link "Flight option ${index}"`);
  assert.equal(contentSettled(page(home), page([...home.slice(0, 100), ...results])), false);
});

test('A scan accepts rotating copy on the same screen and names the differing lines', () => {
  const state = {
    documentEpoch: 1,
    url: 'https://example.test/',
    aria: page([...ordinary, '- text: Save up to €100s on flights']),
    focus: { tag: 'body' },
    focusHelp: null,
    scroll: { x: 0, y: 0 },
    dialogs: [],
  };
  const saved = { pageStamp: pageStamp(state), aria: state.aria };
  assert.deepEqual(sameForScan(saved, state), []);
  // Focus moving does not matter to a scan.
  assert.deepEqual(sameForScan(saved, { ...state, focus: { tag: 'a', name: 'Flights' } }), []);
  const rotated = { ...state, aria: page([...ordinary, '- text: Save up to €270 on hotels']) };
  assert.deepEqual(sameForScan(saved, rotated)?.sort(), [
    '- text: Save up to €100s on flights',
    '- text: Save up to €270 on hotels',
  ]);
  // A different screen never qualifies.
  assert.equal(sameForScan(saved, { ...state, scroll: { x: 0, y: 400 } }), null);
  assert.equal(sameForScan(saved, { ...state, url: 'https://example.test/results' }), null);
  assert.equal(
    sameForScan(saved, { ...state, dialogs: [{ role: 'dialog', name: 'Sign in' }] }),
    null,
  );
  assert.equal(
    sameForScan(saved, { ...state, aria: page([...ordinary, '- dialog "Sign in"']) }),
    null,
  );
  const replaced = Array.from({ length: 236 }, (_, index) => `- link "Result ${index}"`);
  assert.equal(sameForScan(saved, { ...state, aria: page(replaced) }), null);
  // Records saved before page-state/1 have no page stamp: the exact stamp decides alone.
  assert.equal(sameForScan({ aria: state.aria }, state), null);
});

test('A scan on a small page refuses a swapped main section that a key press would tolerate', () => {
  const state = (lines: string[]) => ({
    documentEpoch: 1,
    url: 'https://example.test/step',
    aria: page(lines),
    focus: { tag: 'body' },
    focusHelp: null,
    scroll: { x: 0, y: 0 },
    dialogs: [],
  });
  const frame = Array.from({ length: 24 }, (_, i) => `- link "Menu ${i}"`);
  const product = (name: string) =>
    Array.from({ length: 6 }, (_, i) => `- text: ${name} detail ${i}`);
  const before = state([...frame, ...product('Blue jumper')]);
  const after = state([...frame, ...product('Red jumper')]);
  // 12 of 30 lines differ: within the key-press floor, beyond the scan's.
  assert.equal(ariaDifference(before.aria, after.aria).length, 12);
  assert.equal(contentSettled(before.aria, after.aria), true);
  const saved = { pageStamp: pageStamp(before), aria: before.aria };
  assert.equal(sameForScan(saved, after), null);
  // Two rotated lines on the same small page still qualify.
  const small = state([...frame, ...product('Blue jumper').slice(0, 5), '- text: Offer A']);
  const rotated = state([...frame, ...product('Blue jumper').slice(0, 5), '- text: Offer B']);
  assert.equal(sameForScan({ pageStamp: pageStamp(small), aria: small.aria }, rotated)?.length, 2);
});

test("eDreams' largest measured drift still keeps a scan", () => {
  const home = Array.from({ length: 286 }, (_, index) => `- text: Home line ${index}`);
  const slides = Array.from({ length: 11 }, (_, i) => `- text: Slide ${i}`);
  const state = (lines: string[]) => ({
    documentEpoch: 1,
    url: 'https://www.edreams.com/',
    aria: page(lines),
    focus: null,
    focusHelp: null,
    scroll: { x: 0, y: 0 },
    dialogs: [],
  });
  const before = state(home);
  const after = state([...home.slice(0, 274), ...slides]);
  assert.equal(sameForScan({ pageStamp: pageStamp(before), aria: before.aria }, after)?.length, 23);
});
