import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, digest } from '../src/store.js';
import {
  CRITERIA,
  CRITERIA_VERSION,
  VERDICTS,
  criterionProposalSchema,
  criterionReviewSchema,
  criterionScopeSchema,
  evaluateCriteria,
  makeCriterionScope,
  type CriterionId,
  type CriterionVerdict,
} from '../src/criteria.js';
import type { RecordEntry } from '../src/types.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'access-walk-criteria-'));
  const store = new Store(dir);
  const run = store.create(
    'Complete the controlled task',
    'http://127.0.0.1:4317/shop/',
    'offline',
  );
  let n = 0;
  function capture(changes: any = {}) {
    const image = store.asset(
      run.id,
      `capture_${++n}.png`,
      Buffer.from(`Controlled unit-test image ${n}`),
    );
    return store.append(run.id, 'capture', 'browser', {
      imageFile: image.file,
      imageHash: image.hash,
      stable: true,
      width: 1440,
      height: 900,
      url: run.url,
      text: 'Profile settings. Continue to review.',
      title: 'Profile settings',
      focus: { tag: 'button', name: 'Continue to review', text: 'Continue to review' },
      elements: [
        {
          id: 'e1',
          selector: '#continue',
          tag: 'button',
          role: 'button',
          name: 'Continue to review',
          text: 'Continue to review',
          type: '',
        },
      ],
      limits: {
        totalControls: 1,
        maximumListedControls: 60,
        visibleTextTruncated: false,
        imageScope: 'viewport',
      },
      ...changes,
    });
  }
  function scope(capture: RecordEntry) {
    return store.append(run.id, 'criterion_scope', 'runner', makeCriterionScope(capture.id), [
      capture.id,
    ]);
  }
  function facts(capture: RecordEntry, changes: any = {}) {
    const complete = Object.fromEntries(
      ['controls', 'fields', 'images', 'headings', 'targets', 'contrast', 'colourMessages'].flatMap(
        (family) => [
          [family + 'Incomplete', false],
          [family + 'Truncated', false],
        ],
      ),
    );
    return store.append(
      run.id,
      'observation',
      'browser',
      {
        method: 'automatic_accessibility_scan',
        stable: true,
        sourceCaptureId: capture.id,
        sourceCaptureHash: capture.hash,
        sourceImageHash: capture.payload.imageHash,
        facts: {
          schema: 'access-walk/facts-v1',
          captureId: capture.id,
          imageHash: capture.payload.imageHash,
          url: capture.payload.url,
          scope: { viewportOnly: true, ...complete },
          controls: [
            {
              elementId: 'e1',
              selector: '#continue',
              name: 'Continue to review',
              role: 'button',
              tag: 'button',
            },
          ],
          fields: [
            {
              selector: '#email',
              visibleLabels: ['Email address'],
              programmaticLabels: ['Email address'],
              required: true,
              invalid: false,
              describedBy: [],
            },
          ],
          images: [
            {
              selector: '#bag',
              alt: 'Canvas bag',
              role: 'img',
              programmaticLabels: [],
              contextText: 'Canvas bag product photograph',
            },
          ],
          targets: [
            {
              elementId: 'e1',
              selector: '#continue',
              box: { x: 10, y: 10, width: 48, height: 48 },
              sizeMet: true,
              spacingException: null,
              otherExceptions: 'not-assessed',
            },
          ],
          headings: {
            title: 'Profile settings',
            items: [{ level: 1, text: 'Profile settings', selector: 'h1' }],
          },
          contrast: [
            {
              selector: 'h1',
              foreground: '#000000',
              background: '#ffffff',
              ratio: 21,
              fontSizePx: 16,
              fontWeight: 400,
              requiredRatio: 4.5,
              source: 'axe-core',
              state: 'measured',
            },
          ],
          colourMessages: [
            {
              selector: '#status',
              text: 'Your changes are ready',
              color: 'rgb(0,0,0)',
              role: 'status',
              describedBy: [],
            },
          ],
          ...changes,
        },
      },
      [capture.id],
    );
  }
  function action(before: RecordEntry, key = 'Enter', changes: any = {}) {
    return store.append(
      run.id,
      'action',
      'browser',
      {
        method: 'actual_keyboard_or_browser',
        sourceCaptureId: before.id,
        sourceImageHash: before.payload.imageHash,
        action: { kind: 'press', key },
        before: { tag: 'button', name: 'Continue to review' },
        after: { tag: 'button', name: 'Return to settings' },
        outcome: 'performed',
        waitAfterMs: 180,
        ...changes,
      },
      [before.id],
    );
  }
  function proposal(
    scope: RecordEntry,
    criterionId: CriterionId,
    sources: string[],
    verdict: CriterionVerdict = 'PASS',
    changes: any = {},
    readId?: string,
  ) {
    const read = readId ?? store.snapshot(run.id, 'analyst').read.id;
    const payload = criterionProposalSchema.parse({
      version: CRITERIA_VERSION,
      scopeId: scope.id,
      checkId: `${scope.payload.captureId}:${criterionId}`,
      criterionId,
      verdict,
      reason: 'The original evidence supports this scoped assessment.',
      sources,
      missingEvidence: [],
      ...changes,
    });
    return store.append(
      run.id,
      'criterion_proposal',
      'analyst',
      { ...payload, readSnapshotId: read },
      [scope.id, ...sources],
    );
  }
  function review(proposal: RecordEntry, changes: any = {}, readId?: string) {
    const read = readId ?? store.snapshot(run.id, 'reviewer').read.id;
    const payload = criterionReviewSchema.parse({
      proposalId: proposal.id,
      proposalHash: proposal.hash,
      verdict: 'keep',
      premise: 'supported',
      reason: 'Independently read originals support the exact complete assessment.',
      sources: proposal.payload.sources,
      readSnapshotId: read,
      ...changes,
    });
    return store.append(run.id, 'criterion_review', 'reviewer', payload, [
      proposal.id,
      read,
      ...payload.sources,
    ]);
  }
  function approve(
    scope: RecordEntry,
    criterionId: CriterionId,
    sources: string[],
    verdict: CriterionVerdict = 'PASS',
    changes: any = {},
  ) {
    const p = proposal(scope, criterionId, sources, verdict, changes);
    review(p);
    return p;
  }
  const report = (analysedCaptureIds?: ReadonlySet<string>) =>
    evaluateCriteria(store.records(run.id), run.id, {
      analysedCaptureIds,
      imageAvailable: (capture) => {
        store.image(run.id, capture.payload.imageFile);
        return true;
      },
    });
  return {
    dir,
    store,
    run,
    capture,
    scope,
    facts,
    action,
    proposal,
    review,
    approve,
    report,
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
const row = (report: ReturnType<typeof evaluateCriteria>, id: CriterionId) =>
  report.results.find((r) => r.id === id)!;

test('The public version defines exactly fifteen criteria and the five fixed final verdicts', () => {
  assert.equal(CRITERIA.length, 15);
  assert.equal(new Set(CRITERIA.map((c) => c.id)).size, 15);
  assert.deepEqual(VERDICTS, ['PASS', 'FAIL', 'INCONCLUSIVE', 'NOT_TESTED', 'NOT_APPLICABLE']);
  const s = makeCriterionScope('original-screen');
  assert.equal(s.checks.length, 15);
  assert.throws(() => criterionScopeSchema.parse({ ...s, checks: s.checks.slice(0, -1) }));
  assert.throws(() =>
    criterionScopeSchema.parse({ ...s, checks: s.checks.map(() => s.checks[0]) }),
  );
});

test('Old runs, empty findings and bare browser facts never become a pass or complete score', () => {
  const x = fixture();
  try {
    const c = x.capture();
    x.facts(c);
    let report = x.report();
    assert.equal(report.counts.NOT_TESTED, 15);
    assert.equal(report.score, null);
    x.scope(c);
    report = x.report();
    assert.equal(report.counts.PASS, 0);
    assert.equal(report.coverage.requiredChecks, 15);
    assert.equal(report.score, null);
  } finally {
    x.close();
  }
});

test('A scoped pass needs the exact independent review and verified original image bytes', () => {
  const x = fixture();
  try {
    const c = x.capture(),
      s = x.scope(c),
      f = x.facts(c),
      p = x.proposal(s, 'C02', [c.id, f.id]);
    assert.equal(row(x.report(), 'C02').verdict, 'INCONCLUSIVE');
    x.review(p);
    assert.equal(row(x.report(), 'C02').verdict, 'PASS');
    assert.equal(x.report().score, null);
    assert.equal(
      row(evaluateCriteria(x.store.records(x.run.id), x.run.id), 'C02').verdict,
      'INCONCLUSIVE',
    );
    writeFileSync(join(x.dir, x.run.id, c.payload.imageFile), 'changed bytes');
    assert.equal(row(x.report(), 'C02').verdict, 'INCONCLUSIVE');
  } finally {
    x.close();
  }
});

test('Integrity and image checks are fresh on each report, including unrelated read pins', () => {
  for (const damage of ['fact-body', 'unused-pin', 'source-edge', 'image'] as const) {
    const x = fixture();
    try {
      const c = x.capture(),
        s = x.scope(c),
        f = x.facts(c),
        note = x.store.append(x.run.id, 'navigator_note', 'navigator', {
          note: 'Original walk note',
        });
      x.approve(s, 'C02', [c.id, f.id]);
      const records = x.store.records(x.run.id);
      let available = true;
      const options = { imageAvailable: () => available };
      assert.equal(row(evaluateCriteria(records, x.run.id, options), 'C02').verdict, 'PASS');
      if (damage === 'fact-body')
        records.find((r) => r.id === f.id)!.payload.facts.controls[0].name = 'Changed';
      if (damage === 'source-edge') records.find((r) => r.id === f.id)!.sources.push(note.id);
      if (damage === 'unused-pin') {
        const changed = records.find((r) => r.id === note.id)!;
        changed.payload.note = 'Changed but still internally intact';
        changed.hash = digest(JSON.stringify(changed.payload));
      }
      if (damage === 'image') available = false;
      const report = evaluateCriteria(records, x.run.id, options);
      assert.equal(row(report, 'C02').verdict, 'INCONCLUSIVE');
      assert.equal(report.score, null);
    } finally {
      x.close();
    }
  }
});

test('An image callback invalidates integrity already checked during the same report', () => {
  const x = fixture();
  try {
    const c = x.capture(),
      s = x.scope(c),
      f = x.facts(c);
    x.approve(s, 'C01', [c.id, f.id]);
    x.approve(s, 'C02', [c.id, f.id]);
    const records = x.store.records(x.run.id);
    let callbacks = 0;
    const report = evaluateCriteria(records, x.run.id, {
      imageAvailable: () => {
        if (++callbacks === 2)
          records.find((r) => r.id === f.id)!.payload.facts.controls[0].name =
            'Changed by callback';
        return true;
      },
    });
    assert(callbacks >= 2);
    assert.equal(row(report, 'C01').verdict, 'PASS');
    assert.equal(row(report, 'C02').verdict, 'INCONCLUSIVE');
    assert.equal(report.score, null);
  } finally {
    x.close();
  }
});

test('A demonstrated failure survives incomplete coverage but cannot create a partial overall score', () => {
  const x = fixture();
  try {
    const a = x.capture(),
      sa = x.scope(a),
      fa = x.facts(a);
    x.approve(sa, 'C02', [a.id, fa.id]);
    const b = x.capture(),
      sb = x.scope(b),
      fb = x.facts(b, { controls: [{ name: '', role: 'button' }] });
    x.approve(sb, 'C02', [b.id, fb.id], 'FAIL');
    const c = x.capture();
    x.scope(c);
    const r = row(x.report(), 'C02');
    assert.equal(r.verdict, 'FAIL');
    assert.equal(r.coverageComplete, false);
    assert.equal(r.requiredChecks, 3);
    assert.equal(r.assessedChecks, 2);
    assert.equal(x.report().score, null);
  } finally {
    x.close();
  }
});

test('New unreviewed, rejected or same-read duplicate proposals cannot reuse an earlier pass', () => {
  const x = fixture();
  try {
    const c = x.capture(),
      s = x.scope(c),
      f = x.facts(c);
    x.approve(s, 'C02', [c.id, f.id]);
    const newer = x.proposal(s, 'C02', [c.id, f.id]);
    assert.equal(row(x.report(), 'C02').verdict, 'INCONCLUSIVE');
    x.review(newer, { verdict: 'reject', premise: 'contradicted' });
    assert.equal(row(x.report(), 'C02').verdict, 'INCONCLUSIVE');
    const read = x.store.snapshot(x.run.id, 'analyst').read.id;
    const one = x.proposal(s, 'C02', [c.id, f.id], 'PASS', {}, read),
      two = x.proposal(s, 'C02', [c.id, f.id], 'FAIL', {}, read);
    x.review(one);
    x.review(two);
    assert.match(row(x.report(), 'C02').checks[0].reason, /conflicting/i);
  } finally {
    x.close();
  }
});

test('Changed, foreign and source-rewritten evidence cannot keep a criterion accepted', () => {
  for (const damage of ['body', 'sources', 'foreign', 'unstable'] as const) {
    const x = fixture();
    try {
      const c = x.capture(),
        s = x.scope(c),
        f = x.facts(c);
      x.approve(s, 'C02', [c.id, f.id]);
      assert.equal(row(x.report(), 'C02').verdict, 'PASS');
      if (damage === 'body')
        x.store.db
          .prepare('UPDATE records SET body=? WHERE id=?')
          .run(JSON.stringify({ ...f.payload, facts: { ...f.payload.facts, controls: [] } }), f.id);
      if (damage === 'sources')
        x.store.db.prepare('UPDATE records SET sources=? WHERE id=?').run('[]', f.id);
      if (damage === 'foreign')
        x.store.db
          .prepare('UPDATE records SET run_id=? WHERE id=?')
          .run(x.store.create('Other', 'http://127.0.0.1:4317/shop/', 'offline').id, f.id);
      if (damage === 'unstable')
        x.store.db
          .prepare('UPDATE records SET body=? WHERE id=?')
          .run(JSON.stringify({ ...c.payload, stable: false }), c.id);
      assert.notEqual(row(x.report(), 'C02').verdict, 'PASS');
      assert.equal(x.report().score, null);
    } finally {
      x.close();
    }
  }
});

test('A required scope created after analysis, missing source pins or wrong review hash stays unverified', () => {
  for (const damage of ['late-scope', 'legacy-read', 'review-hash'] as const) {
    const x = fixture();
    try {
      const c = x.capture(),
        earlyRead = x.store.snapshot(x.run.id, 'analyst').read.id,
        s = x.scope(c),
        f = x.facts(c);
      const p = x.proposal(
        s,
        'C02',
        [c.id, f.id],
        'PASS',
        {},
        damage === 'late-scope' ? earlyRead : undefined,
      );
      if (damage === 'legacy-read') {
        const old = x.store.record(x.run.id, p.payload.readSnapshotId)!;
        const legacy = x.store.append(x.run.id, 'read_snapshot', 'analyst', {
          ...old.payload,
          records: old.payload.records.map(({ sources, ...pin }: any) => pin),
        });
        const bad = x.store.append(
          x.run.id,
          'criterion_proposal',
          'analyst',
          { ...p.payload, readSnapshotId: legacy.id },
          p.sources,
        );
        x.review(bad);
      } else x.review(p, damage === 'review-hash' ? { proposalHash: 'f'.repeat(64) } : {});
      assert.equal(row(x.report(), 'C02').verdict, 'INCONCLUSIVE');
      assert.equal(x.report().score, null);
    } finally {
      x.close();
    }
  }
});

test('Contrast uses the original text-size threshold and never treats an incomplete measurement as passed', () => {
  for (const large of [false, true]) {
    const x = fixture();
    try {
      const c = x.capture(),
        s = x.scope(c),
        f = x.facts(c, {
          contrast: [
            {
              selector: 'h1',
              foreground: '#888888',
              background: '#ffffff',
              ratio: 3.544886,
              fontSizePx: large ? 24 : 16,
              fontWeight: 400,
              requiredRatio: large ? 3 : 4.5,
              source: 'axe-core',
              state: 'measured',
            },
          ],
        });
      x.approve(s, 'C01', [c.id, f.id]);
      assert.equal(row(x.report(), 'C01').verdict, large ? 'PASS' : 'INCONCLUSIVE');
    } finally {
      x.close();
    }
  }
  const x = fixture();
  try {
    const c = x.capture(),
      s = x.scope(c),
      f = x.facts(c, { contrast: [{ state: 'incomplete', ratio: null }] });
    x.approve(s, 'C01', [c.id, f.id]);
    assert.notEqual(row(x.report(), 'C01').verdict, 'PASS');
  } finally {
    x.close();
  }
});

test('An undersized target without assessed exceptions never becomes an automatic failure', () => {
  for (const spacing of [true, false, null]) {
    const x = fixture();
    try {
      const c = x.capture(),
        s = x.scope(c),
        f = x.facts(c, {
          targets: [{ sizeMet: false, spacingException: spacing, otherExceptions: 'not-assessed' }],
        });
      x.approve(s, 'C08', [c.id, f.id], spacing === true ? 'PASS' : 'FAIL');
      assert.equal(row(x.report(), 'C08').verdict, spacing === true ? 'PASS' : 'INCONCLUSIVE');
    } finally {
      x.close();
    }
  }
});

test('Tab alone, a missing aftermath or an interrupted focus read cannot invent functional keyboard success', () => {
  for (const mode of ['tab', 'no-after', 'functional'] as const) {
    const x = fixture();
    try {
      const before = x.capture(),
        s = x.scope(before),
        a = x.action(before, mode === 'tab' ? 'Tab' : 'Enter');
      const sources = [before.id, a.id];
      if (mode !== 'no-after') {
        const after = x.capture();
        x.scope(after);
        sources.push(after.id);
      }
      x.approve(s, 'C05', sources);
      assert.equal(
        row(x.report(), 'C05').checks[0].verdict,
        mode === 'functional' ? 'PASS' : mode === 'tab' ? 'NOT_TESTED' : 'INCONCLUSIVE',
      );
    } finally {
      x.close();
    }
  }
});

// Codex, PR 61: a dropdown choice that sent real key presses is functional keyboard evidence;
// one with no presses is not.
test('A dropdown choice with real key presses counts as a functional keyboard action', () => {
  for (const presses of [3, 0]) {
    const x = fixture();
    try {
      const before = x.capture(),
        s = x.scope(before),
        a = x.action(before, '2', {
          action: { kind: 'choose_option', option: '22, Tuesday', key: '2', presses },
          before: { tag: 'select', name: 'Day and date of departure' },
          after: { tag: 'select', name: 'Day and date of departure' },
        }),
        after = x.capture();
      x.scope(after);
      x.approve(s, 'C05', [before.id, a.id, after.id]);
      assert.equal(row(x.report(), 'C05').checks[0].verdict, presses ? 'PASS' : 'NOT_TESTED');
    } finally {
      x.close();
    }
  }
});

test('Keyboard focus and action feedback require actual input, captured state and recorded wait', () => {
  const x = fixture();
  try {
    const before = x.capture();
    x.scope(before);
    const a = x.action(before, 'Enter', { waitAfterMs: 0 }),
      after = x.capture(),
      s = x.scope(after);
    x.approve(s, 'C06', [before.id, a.id, after.id]);
    x.approve(s, 'C14', [before.id, a.id, after.id]);
    assert.equal(row(x.report(), 'C06').checks.find((c) => c.scopeId === s.id)?.verdict, 'PASS');
    assert.equal(
      row(x.report(), 'C14').checks.find((c) => c.scopeId === s.id)?.verdict,
      'INCONCLUSIVE',
    );
  } finally {
    x.close();
  }
});

test('The criterion gate does not let later omitted actions impersonate an earlier input result', () => {
  const x = fixture();
  try {
    const before = x.capture(),
      s = x.scope(before),
      first = x.action(before),
      middle = x.capture();
    x.scope(middle);
    const second = x.action(middle),
      after = x.capture();
    x.scope(after);
    x.approve(s, 'C05', [before.id, first.id, after.id]);
    assert.equal(row(x.report(), 'C05').checks[0].verdict, 'INCONCLUSIVE');
    assert(second.seq > first.seq);
  } finally {
    x.close();
  }
});

test('Missing labels or control names cannot be invented by a supported review', () => {
  const x = fixture();
  try {
    const c = x.capture(),
      s = x.scope(c),
      f = x.facts(c, {
        controls: [{ name: '', role: 'button' }],
        fields: [{ visibleLabels: [], programmaticLabels: ['Email'] }],
        images: [
          { alt: null, role: 'img', programmaticLabels: [], contextText: 'Product photograph' },
        ],
      });
    for (const id of ['C02', 'C03', 'C04'] as const) {
      x.approve(s, id, [c.id, f.id]);
      assert.equal(row(x.report(), id).verdict, 'INCONCLUSIVE');
    }
  } finally {
    x.close();
  }
});

test('An observed aria-label is a valid image alternative only with exact independent review', () => {
  for (const ariaLabel of ['Canvas bag with two shoulder straps', null, '', '   ', 42]) {
    const x = fixture();
    try {
      const c = x.capture(),
        s = x.scope(c),
        f = x.facts(c, {
          images: [
            {
              selector: '#product-image',
              tag: 'div',
              alt: null,
              role: 'img',
              ariaLabel,
              programmaticLabels: [],
              contextText: 'Canvas bag product photograph',
            },
          ],
        }),
        p = x.proposal(s, 'C04', [c.id, f.id]);
      assert.equal(row(x.report(), 'C04').verdict, 'INCONCLUSIVE');
      x.review(p);
      assert.equal(
        row(x.report(), 'C04').verdict,
        typeof ariaLabel === 'string' && ariaLabel.trim() ? 'PASS' : 'INCONCLUSIVE',
      );
      assert.equal(x.report().score, null);
    } finally {
      x.close();
    }
  }
});

test('An actually measured empty title can retain a reviewed failure without invented heading evidence', () => {
  for (const scenario of [
    { title: '', verdict: 'FAIL', expected: 'FAIL' },
    { title: '', verdict: 'PASS', expected: 'INCONCLUSIVE' },
    { title: 'Profile settings', verdict: 'FAIL', expected: 'INCONCLUSIVE' },
    { title: undefined, verdict: 'FAIL', expected: 'INCONCLUSIVE' },
    { title: '', verdict: 'FAIL', expected: 'INCONCLUSIVE', incomplete: true },
    { title: '', verdict: 'FAIL', expected: 'INCONCLUSIVE', truncated: true },
  ] as const) {
    const x = fixture();
    try {
      const c = x.capture(),
        s = x.scope(c),
        f = x.facts(c, {
          headings: { title: scenario.title, items: [] },
          scope: {
            viewportOnly: true,
            headingsIncomplete: 'incomplete' in scenario,
            headingsTruncated: 'truncated' in scenario,
          },
        });
      x.approve(s, 'C09', [c.id, f.id], scenario.verdict);
      assert.equal(row(x.report(), 'C09').verdict, scenario.expected);
      assert.equal(x.report().score, null);
    } finally {
      x.close();
    }
  }
});

test('Truncated observation lists cannot justify a pass or absence-based exclusion', () => {
  const x = fixture();
  try {
    const c = x.capture(),
      s = x.scope(c),
      f = x.facts(c);
    const bad = x.store.append(
      x.run.id,
      'observation',
      'browser',
      {
        ...f.payload,
        facts: {
          ...f.payload.facts,
          controls: [],
          scope: { ...f.payload.facts.scope, controlsTruncated: true },
        },
      },
      [c.id],
    );
    x.approve(s, 'C02', [c.id, bad.id], 'NOT_APPLICABLE');
    assert.equal(row(x.report(), 'C02').verdict, 'INCONCLUSIVE');
  } finally {
    x.close();
  }
});

test('Unknown or mixed versions and unscoped captured states block a complete score', () => {
  const x = fixture();
  try {
    const a = x.capture();
    x.scope(a);
    const b = x.capture();
    x.store.append(
      x.run.id,
      'criterion_scope',
      'runner',
      { ...makeCriterionScope(b.id), version: 'future-unimplemented-version' },
      [b.id],
    );
    const report = x.report();
    assert.equal(report.score, null);
    assert.equal(report.recordedVersions.length, 2);
    assert(report.limits.some((l) => /versions|version/.test(l)));
    assert.equal(
      report.coverage.requiredChecks,
      30,
      'An unsupported scope cannot drop its captured state from required coverage.',
    );
    assert.equal(row(report, 'C02').requiredChecks, 2);
  } finally {
    x.close();
  }
});

// Owner, 1 Nov: a Booking.com audit owed 15 checks on all 34 screenshots (510) while the analyst
// read 8 screens; only 2 checks passed. Only screens an analyst read now owe checks.
test('Only analysed screens owe checks; the others are noted, not counted', () => {
  const x = fixture();
  try {
    const read = x.capture(),
      s = x.scope(read),
      f = x.facts(read);
    for (let i = 0; i < 3; i++) x.scope(x.capture());
    x.approve(s, 'C02', [read.id, f.id]);
    const everything = x.report();
    assert.equal(everything.coverage.requiredChecks, 60, 'without the list, every screenshot owes');
    const analysed = x.report(new Set([read.id]));
    assert.equal(analysed.coverage.requiredChecks, 15);
    assert.equal(row(analysed, 'C02').requiredChecks, 1);
    assert.equal(row(analysed, 'C02').verdict, 'PASS');
    assert.equal(row(analysed, 'C02').coverageComplete, true);
    assert(analysed.limits.some((l) => /^3 original screenshots were not analysed/.test(l)));
    // The note alone never blocks a result: a fully settled analysed screen is still complete.
    const none = x.report(new Set());
    assert.equal(none.coverage.requiredChecks, 0);
    assert.equal(none.coverage.complete, false);
  } finally {
    x.close();
  }
});

test('Complete reviewed coverage scores criteria, excluding genuine N/A, independently of finding grouping', () => {
  const x = fixture();
  try {
    const one = x.capture(),
      s1 = x.scope(one),
      a1 = x.action(one),
      two = x.capture(),
      s2 = x.scope(two);
    const back = x.action(two, 'Enter', { action: { kind: 'back' } }),
      three = x.capture(),
      s3 = x.scope(three),
      a3 = x.action(three),
      four = x.capture(),
      s4 = x.scope(four);
    const captures = [one, two, three, four],
      scopes = [s1, s2, s3, s4],
      actions = [a1, back, a3];
    const observations = captures.map((c) =>
      x.facts(c, {
        fields: [
          { visibleLabels: [], programmaticLabels: ['Email'], invalid: false, describedBy: [] },
        ],
        headings: { title: 'Page', items: [{ level: 1, text: 'Page', selector: 'h1' }] },
        contrast: [
          {
            selector: 'h1',
            foreground: '#cccccc',
            background: '#ffffff',
            ratio: 1.6059,
            fontSizePx: 16,
            fontWeight: 400,
            requiredRatio: 4.5,
            source: 'axe-core',
            state: 'measured',
          },
        ],
      }),
    );
    const returned = x.store.append(
      x.run.id,
      'observation',
      'browser',
      {
        method: 'return_preservation',
        version: 'journey-evidence/1',
        stable: true,
        beforeCaptureId: two.id,
        afterCaptureId: three.id,
        actionId: back.id,
        returned: true,
        entriesCompared: true,
        preserved: true,
        fieldId: 'email',
      },
      [two.id, back.id, three.id],
    );
    const sources = [...captures, ...actions, ...observations, returned].map((r) => r.id);
    const analyst = x.store.snapshot(x.run.id, 'analyst').read.id;
    const proposals: RecordEntry[] = [];
    for (const scope of scopes)
      for (const c of CRITERIA) {
        let verdict: CriterionVerdict = ['C01', 'C03', 'C09'].includes(c.id)
          ? 'FAIL'
          : ['C07', 'C11', 'C12'].includes(c.id)
            ? 'NOT_APPLICABLE'
            : 'PASS';
        if (
          (scope.id === s1.id && ['C06', 'C14'].includes(c.id)) ||
          (scope.id === s3.id && c.id === 'C06')
        )
          verdict = 'NOT_APPLICABLE';
        proposals.push(x.proposal(scope, c.id, sources, verdict, {}, analyst));
      }
    const review = x.store.snapshot(x.run.id, 'reviewer').read.id;
    for (const p of proposals) x.review(p, {}, review);
    const report = x.report();
    assert.equal(
      report.score,
      75,
      JSON.stringify(
        report.results.map((r) => ({
          id: r.id,
          verdict: r.verdict,
          checks: r.checks.filter((c) => !c.complete),
        })),
      ),
    );
    assert.deepEqual(report.counts, {
      PASS: 9,
      FAIL: 3,
      INCONCLUSIVE: 0,
      NOT_TESTED: 0,
      NOT_APPLICABLE: 3,
    });
    assert.equal(report.coverage.complete, true);
    assert.equal(report.coverage.requiredChecks, 60);
    assert.equal(report.coverage.remainingChecks, 0);
    x.store.append(
      x.run.id,
      'candidate',
      'analyst',
      { title: 'Unscored visual concern', criterion: null },
      [one.id],
    );
    assert.equal(x.report().score, 75, 'A finding never changes the criterion denominator.');
    // Owner, 1 Nov: a later screenshot nobody analysed is noted, and the result stands.
    x.scope(x.capture());
    const analysed = x.report(new Set(captures.map((c) => c.id)));
    assert.equal(analysed.coverage.complete, true);
    assert.equal(analysed.score, 75);
    assert(analysed.limits.some((l) => /^1 original screenshot was not analysed/.test(l)));
    assert.equal(x.report().coverage.complete, false, 'without the list it is owed');
  } finally {
    x.close();
  }
});

test('Error-quality assessment needs an actual trigger and the captured field/message context', () => {
  for (const attempted of [false, true]) {
    const x = fixture();
    try {
      const before = x.capture();
      x.scope(before);
      const action = attempted ? x.action(before) : null;
      const after = x.capture(),
        scope = x.scope(after),
        facts = x.facts(after, {
          fields: [
            {
              invalid: true,
              describedBy: ['Enter a valid email address'],
              visibleLabels: ['Email'],
              programmaticLabels: ['Email'],
            },
          ],
          colourMessages: [{ role: 'alert', text: 'Enter a valid email address' }],
        });
      const sources = [before.id, after.id, facts.id, ...(action ? [action.id] : [])];
      x.approve(scope, 'C07', sources);
      assert.equal(
        row(x.report(), 'C07').checks.find((c) => c.scopeId === scope.id)?.verdict,
        attempted ? 'PASS' : 'NOT_TESTED',
      );
    } finally {
      x.close();
    }
  }
});

test('Legacy ARIA invalid tokens distinguish valid fields from real error states', () => {
  for (const invalid of [
    false,
    'false',
    'FALSE',
    '',
    true,
    'true',
    'grammar',
    'spelling',
    'unexpected',
    undefined,
    null,
    42,
  ]) {
    const x = fixture();
    try {
      const c = x.capture(),
        s = x.scope(c),
        f = x.facts(c, {
          fields: [
            {
              invalid,
              describedBy: ['Ordinary field help'],
              visibleLabels: ['Email'],
              programmaticLabels: ['Email'],
            },
          ],
          colourMessages: [],
        });
      x.approve(s, 'C07', [c.id, f.id], 'NOT_APPLICABLE');
      assert.equal(
        row(x.report(), 'C07').verdict,
        invalid === false ||
          invalid === '' ||
          (typeof invalid === 'string' && invalid.toLowerCase() === 'false')
          ? 'NOT_APPLICABLE'
          : 'INCONCLUSIVE',
      );
    } finally {
      x.close();
    }
  }
});

test('A false invalid token cannot turn an ordinary action and help text into a tested error', () => {
  for (const invalid of [
    false,
    'false',
    '',
    true,
    'true',
    'grammar',
    'spelling',
    'unexpected',
    undefined,
  ]) {
    const x = fixture();
    try {
      const before = x.capture();
      x.scope(before);
      const action = x.action(before),
        after = x.capture(),
        s = x.scope(after),
        f = x.facts(after, {
          fields: [
            {
              invalid,
              describedBy: ['A captured field explanation'],
              visibleLabels: ['Email'],
              programmaticLabels: ['Email'],
            },
          ],
          colourMessages: [],
        });
      x.approve(s, 'C07', [before.id, action.id, after.id, f.id]);
      const settled =
        invalid === true ||
        (typeof invalid === 'string' && invalid !== '' && invalid.toLowerCase() !== 'false');
      assert.equal(
        row(x.report(), 'C07').checks.find((check) => check.scopeId === s.id)?.verdict,
        settled ? 'PASS' : 'INCONCLUSIVE',
      );
    } finally {
      x.close();
    }
  }
});

test('Price comparisons need matching selections/currency and cannot approve an unexplained change', () => {
  for (const scenario of ['missing', 'different-selection', 'unexplained', 'explained'] as const) {
    const x = fixture();
    try {
      const before = x.capture(),
        scope = x.scope(before),
        action = x.action(before),
        after = x.capture();
      x.scope(after);
      const sources = [before.id, action.id, after.id];
      if (scenario !== 'missing') {
        const comparison = x.store.append(
          x.run.id,
          'observation',
          'browser',
          {
            method: 'comparable_totals',
            version: 'journey-evidence/1',
            stable: true,
            beforeCaptureId: before.id,
            afterCaptureId: after.id,
            actionId: action.id,
            comparable: scenario !== 'different-selection',
            selectionSame: scenario !== 'different-selection',
            currency: 'GBP',
            beforeTotal: 79,
            afterTotal: 89,
            disclosure: scenario === 'explained' ? 'Includes stated delivery charge' : null,
          },
          sources,
        );
        sources.push(comparison.id);
      }
      x.approve(scope, 'C11', sources);
      assert.equal(
        row(x.report(), 'C11').checks[0].verdict,
        scenario === 'explained' ? 'PASS' : scenario === 'missing' ? 'NOT_TESTED' : 'INCONCLUSIVE',
      );
    } finally {
      x.close();
    }
  }
});

test('One opt-out cannot settle a view containing additional untested paid choices', () => {
  for (const count of [1, 2]) {
    const x = fixture();
    try {
      const before = x.capture(),
        scope = x.scope(before);
      const context = x.store.append(
        x.run.id,
        'observation',
        'browser',
        {
          method: 'journey_context',
          version: 'journey-evidence/1',
          stable: true,
          sourceCaptureId: before.id,
          data: {
            choicesComplete: true,
            choices: Array.from({ length: count }, (_, n) => ({
              id: `extra-${n}`,
              checked: true,
              extra: { id: `paid-${n}`, price: 5, currency: 'GBP' },
            })),
          },
        },
        [before.id],
      );
      const action = x.action(before, 'Space'),
        after = x.capture();
      x.scope(after);
      const comparison = x.store.append(
        x.run.id,
        'observation',
        'browser',
        {
          method: 'optout_context',
          version: 'journey-evidence/1',
          stable: true,
          beforeCaptureId: before.id,
          afterCaptureId: after.id,
          actionId: action.id,
          fieldId: 'extra-0',
          initialChoiceKnown: true,
          priceKnown: true,
          optOutTested: true,
          choiceChanged: true,
        },
        [before.id, context.id, action.id, after.id],
      );
      x.approve(scope, 'C12', [before.id, context.id, action.id, after.id, comparison.id]);
      assert.equal(row(x.report(), 'C12').checks[0].verdict, count === 1 ? 'PASS' : 'INCONCLUSIVE');
    } finally {
      x.close();
    }
  }
});

test('Return preservation cannot be inferred from an address or a successful back action alone', () => {
  for (const measured of [false, true]) {
    const x = fixture();
    try {
      const before = x.capture(),
        scope = x.scope(before),
        action = x.action(before, 'Enter', { action: { kind: 'back' } }),
        after = x.capture();
      x.scope(after);
      const sources = [before.id, action.id, after.id];
      if (measured) {
        const comparison = x.store.append(
          x.run.id,
          'observation',
          'browser',
          {
            method: 'return_preservation',
            version: 'journey-evidence/1',
            stable: true,
            beforeCaptureId: before.id,
            afterCaptureId: after.id,
            actionId: action.id,
            returned: true,
            entriesCompared: true,
            preserved: false,
            fieldId: 'email',
          },
          sources,
        );
        sources.push(comparison.id);
      }
      x.approve(scope, 'C15', sources);
      assert.equal(
        row(x.report(), 'C15').checks[0].verdict,
        measured ? 'INCONCLUSIVE' : 'NOT_TESTED',
      );
    } finally {
      x.close();
    }
  }
});

test('A screen-reader assertion needs healthy spoken output on its exact original screen', () => {
  for (const state of ['missing', 'item-only', 'unhealthy', 'other-screen', 'observed'] as const) {
    const x = fixture();
    try {
      const capture = x.capture(),
        scope = x.scope(capture),
        facts = x.facts(capture),
        sources = [capture.id, facts.id];
      if (state !== 'missing') {
        const source = state === 'other-screen' ? x.capture() : capture;
        if (source.id !== capture.id) x.scope(source);
        const at = x.store.append(
          x.run.id,
          'at_check',
          'voiceover',
          {
            method: 'real_VoiceOver',
            state: state === 'unhealthy' ? 'INCONCLUSIVE' : 'observed',
            captureHealthy: state !== 'unhealthy',
            os: 'darwin',
            browser: 'webkit',
            commands: [
              {
                command: 'Read controlled example',
                control: 'VoiceOver AppleScript',
                outcome: 'completed',
                at: '2026-10-27T12:00:00.000Z',
                finishedAt: '2026-10-27T12:00:01.000Z',
                itemText: 'Continue to review, button',
                spokenPhrases: state === 'item-only' ? [] : ['Continue to review, button'],
              },
            ],
          },
          [source.id],
        );
        sources.push(at.id);
        if (source.id !== capture.id) sources.push(source.id);
      }
      x.approve(scope, 'C02', sources, 'PASS', { screenReaderClaimed: true });
      const result = row(x.report(), 'C02').checks.find((c) => c.scopeId === scope.id)!;
      assert.equal(
        result.verdict,
        state === 'observed'
          ? 'PASS'
          : state === 'missing' || state === 'other-screen'
            ? 'NOT_TESTED'
            : 'INCONCLUSIVE',
      );
    } finally {
      x.close();
    }
  }
});

test('Null or array criterion payloads stay unknown without throwing or reviving an older pass', () => {
  for (const recordKind of ['criterion_scope', 'criterion_proposal', 'criterion_review'] as const)
    for (const corrupted of [null, []]) {
      const x = fixture();
      try {
        const capture = x.capture(),
          scope = x.scope(capture),
          facts = x.facts(capture);
        const proposal = x.approve(scope, 'C02', [capture.id, facts.id]);
        assert.equal(row(x.report(), 'C02').verdict, 'PASS');
        let target = scope;
        if (recordKind === 'criterion_proposal')
          target = x.proposal(scope, 'C02', [capture.id, facts.id]);
        if (recordKind === 'criterion_review') target = x.review(proposal);
        const body = JSON.stringify(corrupted);
        x.store.db
          .prepare('UPDATE records SET body=?,hash=? WHERE id=?')
          .run(body, digest(body), target.id);
        const report = x.report();
        assert.equal(report.score, null);
        assert.notEqual(row(report, 'C02').verdict, 'PASS');
        assert.notEqual(row(report, 'C02').verdict, 'NOT_APPLICABLE');
        assert(report.limits.some((limit) => /scope|changed|verified/.test(limit)));
      } finally {
        x.close();
      }
    }
});
