import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicSearchInput } from '../src/browser.js';

const field = (name: string, extra: Record<string, unknown> = {}) => ({
  tag: 'input',
  type: 'text',
  name,
  autocomplete: 'off',
  ...extra,
});

test('Travel search fields accept places and dates', () => {
  // eDreams labels its flight fields only with placeholders like these.
  for (const name of ['Where from?', 'Where to?', 'Departure', 'Return', 'Origen', 'Destino'])
    assert.equal(publicSearchInput(field(name), 'Barcelona'), true, name);
  assert.equal(publicSearchInput(field('Departure'), '23/12/2026'), true);
});

test('Personal, account and payment fields stay refused', () => {
  for (const name of ['Email address', 'Passport number', 'Card number', 'Password', 'Address'])
    assert.equal(publicSearchInput(field(name), 'Barcelona'), false, name);
  assert.equal(publicSearchInput(field('Where from?', { paymentForm: true }), 'Barcelona'), false);
  assert.equal(publicSearchInput(field('Where from?'), 'me@example.org'), false);
  assert.equal(publicSearchInput(field('First name'), 'Barcelona'), false);
});
