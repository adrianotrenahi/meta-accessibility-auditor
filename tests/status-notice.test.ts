import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { showsStatusBox } from '../host/ui/notice.js';

const base = { publicSites: true, history: true, pendingStarts: 0, error: null, readError: null };

test('The real-website audits list shows no standing notice', () => {
  assert.equal(showsStatusBox(base), false);
});

test('The box still appears on the list for an unconfirmed Start or an error', () => {
  assert.equal(showsStatusBox({ ...base, pendingStarts: 1 }), true);
  assert.equal(showsStatusBox({ ...base, error: 'The saved Start could not be confirmed.' }), true);
  assert.equal(
    showsStatusBox({ ...base, readError: 'This local proof run is unavailable.' }),
    true,
  );
});

test('Run pages, the new-audit page and the controlled example keep their notice', () => {
  assert.equal(showsStatusBox({ ...base, history: false }), true);
  assert.equal(showsStatusBox({ ...base, publicSites: false }), true);
});

test('The audits page uses that rule, has no list notice text, and clears run errors on the way back', () => {
  const source = readFileSync(new URL('../host/ui/funnel-client.tsx', import.meta.url), 'utf8');
  assert.match(
    source,
    /\{showsStatusBox\(\{ publicSites, history, pendingStarts: pendingStarts\.length, error, readError \}\) && \(/,
  );
  assert.doesNotMatch(source, /Meta test history/);
  assert.match(
    source,
    /if \(!jobId\) \{\s*setJob\(null\);[^}]*setError\(null\);\s*setReadError\(null\);\s*return;/,
  );
});
