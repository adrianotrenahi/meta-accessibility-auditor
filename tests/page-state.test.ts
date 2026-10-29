import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ariaDifference, contentSettled, pageStamp, sameForInput } from '../src/page-state.js';

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
