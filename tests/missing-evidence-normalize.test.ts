import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { analysisSchema } from '../src/models.js';
import { missingEvidenceSchema } from '../src/evidence-checks.js';

const request = (fields: Record<string, unknown>) => ({
  captureId: 'capture-1',
  criterionId: null,
  reason: 'Check the focused search control.',
  ...fields,
});

test('A stray activation key on a non-activation request no longer ends the analysis', () => {
  // The 29 October eDreams run ended on exactly this shape.
  const parsed = analysisSchema.parse({
    findings: [],
    missingEvidence: [
      request({ method: 'keyboard_focus', activationKey: 'Enter', targetName: 'Search Flights' }),
      request({ method: 'voiceover', activationKey: null, targetName: null }),
    ],
  });
  assert.deepEqual(
    parsed.missingEvidence.map((item) => [item.method, item.activationKey, item.targetName]),
    [
      ['keyboard_focus', undefined, undefined],
      ['voiceover', undefined, undefined],
    ],
  );
});

test('An incomplete activation request is not performed; a complete one is kept intact', () => {
  const parsed = analysisSchema.parse({
    findings: [],
    missingEvidence: [
      request({ method: 'keyboard_activation', targetName: 'Search Flights' }),
      request({ method: 'keyboard_activation', activationKey: 'Enter', targetName: 'Search' }),
      request({ method: 'measurement' }),
    ],
  });
  assert.equal(parsed.missingEvidence.length, 2);
  assert.equal(parsed.missingEvidence[0]!.activationKey, 'Enter');
  assert.equal(parsed.missingEvidence[0]!.targetName, 'Search');
  assert.equal(parsed.missingEvidence[1]!.method, 'measurement');
});

test('Other malformed requests still fail, and the model still sees the same schema', () => {
  assert.throws(() =>
    analysisSchema.parse({ findings: [], missingEvidence: [request({ method: 'guess' })] }),
  );
  const strict = z.object({
    ...analysisSchema.shape,
    missingEvidence: z.array(missingEvidenceSchema).max(2).default([]),
  });
  assert.equal(
    JSON.stringify(z.toJSONSchema(analysisSchema)),
    JSON.stringify(z.toJSONSchema(strict)),
  );
});
