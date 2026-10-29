import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AxeResults } from 'axe-core';
import { Store } from '../src/store.js';
import {
  contrastMeasurements,
  contrastRatio,
  requiredTextContrast,
  spacingException,
  FocusedCheckBudget,
  focusedCheckEligibility,
  missingEvidenceSchema,
  summarizeAxe,
} from '../src/evidence-checks.js';

test('Measured contrast uses exact colours, correct large-text thresholds and no rounded pass', () => {
  assert.equal(contrastRatio('#000000', '#ffffff'), 21);
  assert.equal(contrastRatio('transparent', '#ffffff'), null);
  assert.equal(contrastRatio('#00000080', '#ffffff'), null);
  assert.equal(requiredTextContrast(16, 400), 4.5);
  assert.equal(requiredTextContrast(24, 400), 3);
  assert.equal(requiredTextContrast(18, 700), 4.5);
  assert.equal(requiredTextContrast((14 * 96) / 72, 700), 3);
  assert.equal(requiredTextContrast(NaN, 400), null);
  assert.equal(requiredTextContrast(16, 2000), null);
  assert(
    (contrastRatio('#777777', '#ffffff') ?? 100) < 4.5,
    'A ratio that rounds to 4.5 is still below the normal-text threshold.',
  );
});

function axeFixture(
  data: Record<string, unknown>,
  bucket: 'passes' | 'violations' | 'incomplete' = 'passes',
) {
  const result = { passes: [], violations: [], incomplete: [] } as unknown as AxeResults;
  result[bucket] = [
    {
      id: 'color-contrast',
      nodes: [
        {
          target: ['#text'],
          html: '<input value="not-retained">',
          any: [{ id: 'color-contrast', data }],
          all: [],
          none: [],
        },
      ],
    },
  ] as any;
  return result;
}
const measured = {
  fgColor: '#888888',
  bgColor: '#ffffff',
  fontSize: '18.0pt (24px)',
  fontWeight: 'normal',
  contrastRatio: 3.54,
  expectedContrastRatio: '3:1',
};
test('Only actual simple axe colour and typography measurements create a numerical fact', () => {
  const normal = contrastMeasurements(axeFixture(measured))[0];
  assert.equal(normal.state, 'measured');
  assert.equal(normal.requiredRatio, 3);
  assert((normal.ratio ?? 0) > 3);
  for (const data of [
    { ...measured, bgColor: undefined },
    { ...measured, fgColor: 'rgba(0,0,0,.5)' },
    { ...measured, fontSize: undefined },
    { ...measured, fontWeight: undefined },
    { ...measured, shadowColor: '#000000' },
    { ...measured, messageKey: 'complexTextShadows' },
  ]) {
    const row = contrastMeasurements(axeFixture(data))[0];
    assert.equal(row.state, 'incomplete');
    assert.equal(row.ratio, null);
    assert.equal(row.requiredRatio, null);
  }
  assert.equal(contrastMeasurements(axeFixture(measured, 'incomplete'))[0].state, 'incomplete');
  assert.deepEqual(
    contrastMeasurements({ passes: [], violations: [], incomplete: [] } as unknown as AxeResults),
    [],
  );
});

test('An axe projection retains supported passing and incomplete data without arbitrary page values', () => {
  const source = axeFixture({
    ...measured,
    password: 'synthetic-do-not-copy',
    element: { secret: true },
  });
  const projected = summarizeAxe(source);
  assert.equal(projected.passes.length, 1);
  assert.equal(projected.passes[0].nodes[0].checks[0].data.fgColor, '#888888');
  assert(!JSON.stringify(projected).includes('synthetic-do-not-copy'));
  assert(!JSON.stringify(projected).includes('not-retained'));
  assert.equal(source.passes[0].nodes[0].html, '<input value="not-retained">');
});

test('An undersized target may satisfy spacing, with both small and large neighbours considered', () => {
  const box = { x: 0, y: 0, width: 20, height: 20 };
  assert.equal(
    spacingException(box, [{ box: { x: 24, y: 0, width: 20, height: 20 }, sizeMet: false }], true),
    true,
  );
  assert.equal(
    spacingException(box, [{ box: { x: 20, y: 0, width: 20, height: 20 }, sizeMet: false }], true),
    false,
  );
  assert.equal(
    spacingException(box, [{ box: { x: 21, y: 0, width: 44, height: 44 }, sizeMet: true }], true),
    false,
  );
  assert.equal(
    spacingException(box, [{ box: { x: 24, y: 0, width: 44, height: 44 }, sizeMet: true }], true),
    true,
  );
  assert.equal(
    spacingException(box, [], false),
    null,
    'Truncated neighbours cannot grant an exception.',
  );
  assert.equal(
    spacingException(box, [{ box: { x: NaN, y: 0, width: 20, height: 20 }, sizeMet: false }], true),
    null,
  );
});

test('Native checkpoints and other focused checks share one two-attempt allowance', () => {
  const reserved = new FocusedCheckBudget({ reserveVoiceOver: 2 });
  assert.equal(reserved.claim('measurement').allowed, false);
  assert.equal(reserved.used, 0);
  assert.equal(reserved.claim('voiceover').allowed, true);
  assert.equal(reserved.claim('keyboard_focus').allowed, false);
  assert.equal(reserved.claim('voiceover').allowed, true);
  assert.equal(reserved.claim('voiceover').allowed, false);
  assert.equal(reserved.used, 2);
  assert.equal(reserved.remaining, 0);
  const general = new FocusedCheckBudget();
  assert.equal(general.claim('measurement').allowed, true);
  // An execution failure does not return the claimed slot to the pool.
  assert.equal(general.claim('keyboard_focus').allowed, true);
  assert.equal(general.claim('measurement').allowed, false);
  assert.equal(
    new FocusedCheckBudget({ usedMethods: ['voiceover'], reserveVoiceOver: 1 }).remaining,
    1,
  );
  assert.throws(() => new FocusedCheckBudget({ reserveVoiceOver: 3 }));
  assert.throws(
    () => new FocusedCheckBudget({ usedMethods: ['measurement', 'measurement', 'voiceover'] }),
  );
});

test('Missing-fact requests cannot carry arbitrary actions, text, destinations or criterion identifiers', () => {
  const request = {
    method: 'measurement',
    captureId: 'original',
    criterionId: 'C01',
    reason: 'Check original colours.',
  };
  assert(missingEvidenceSchema.safeParse(request).success);
  for (const extra of [
    { action: 'click' },
    { url: 'https://unapproved.example' },
    { text: 'submit' },
  ])
    assert.equal(missingEvidenceSchema.safeParse({ ...request, ...extra }).success, false);
  assert.equal(missingEvidenceSchema.safeParse({ ...request, criterionId: 'C16' }).success, false);
});

test('Keyboard activation requests require an explicit supported key and focused control name', () => {
  const request = {
    method: 'keyboard_activation',
    captureId: 'original',
    criterionId: 'C05',
    reason: 'Observe dismissal after the requested key.',
    activationKey: 'Enter',
    targetName: 'Dismiss offer',
  };
  assert(missingEvidenceSchema.safeParse(request).success);
  assert(missingEvidenceSchema.safeParse({ ...request, activationKey: 'Space' }).success);
  for (const extra of [
    { activationKey: undefined },
    { activationKey: 'Tab' },
    { activationKey: 'Escape' },
    { targetName: undefined },
    { targetName: '' },
    { method: 'keyboard_focus' },
    { method: 'measurement' },
    { method: 'voiceover' },
  ])
    assert.equal(missingEvidenceSchema.safeParse({ ...request, ...extra }).success, false);
});

test('Only the intact exact original and still-current page state allow a focused check', () => {
  const dir = mkdtempSync(join(tmpdir(), 'access-walk-focused-'));
  const store = new Store(dir);
  try {
    const run = store.create('Controlled focused check', 'http://127.0.0.1:4317/shop/', 'offline');
    const source = store.append(run.id, 'capture', 'browser', {
      stable: true,
      url: run.url,
      imageHash: 'a'.repeat(64),
      stateStamp: 'b'.repeat(64),
    });
    const request = missingEvidenceSchema.parse({
      method: 'keyboard_focus',
      captureId: source.id,
      criterionId: 'C05',
      reason: 'Test the current focus.',
    });
    const context = {
      runId: run.id,
      source,
      storedSource: source,
      current: source,
      actualStateStamp: source.payload.stateStamp,
    };
    assert.equal(focusedCheckEligibility(request, context).allowed, true);
    for (const override of [
      { actualStateStamp: 'changed' },
      { storedSource: undefined },
      { source: { ...source, payload: { ...source.payload, stable: false } } },
      { current: { ...source, id: 'another-capture' } },
      { runId: 'another-run' },
      { storedSource: { ...source, kind: 'observation' as const } },
    ]) {
      const decision = focusedCheckEligibility(request, { ...context, ...override });
      assert.equal(decision.allowed, false);
      assert.equal(decision.state, 'NOT_TESTED');
    }
    assert.equal(
      focusedCheckEligibility({ ...request, captureId: 'another' }, context).allowed,
      false,
    );
    assert.equal(
      store.records(run.id).length,
      1,
      'Eligibility itself writes no evidence or browser action.',
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
