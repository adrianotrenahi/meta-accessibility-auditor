import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server/index.js';
import { assessmentForRun } from '../src/assessment.js';
import { recordIsIntact } from '../src/store.js';

test(
  'The ordinary offline walk retains its reviewed C02 saved example without assessing other criteria',
  { timeout: 90000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'access-walk-offline-criteria-'));
    const app = await startServer(0, dir, false);
    try {
      const run = await app.runner.start({
        mode: 'offline',
        headless: true,
        voiceOver: false,
        engine: 'chromium',
      });
      await app.runner.completion;
      const records = app.store.records(run.id);
      const report = assessmentForRun(app.store, run.id);
      const naming = report.criteria.results.find((criterion) => criterion.id === 'C02')!;
      assert.equal(naming.verdict, 'FAIL', naming.reason);
      assert(naming.checks.some((check) => check.verdict === 'FAIL' && check.reviewed));
      assert.equal(naming.coverageComplete, false, 'Later captured screens remain unassessed.');
      assert.equal(report.criteria.results.length, 15);
      for (const criterion of report.criteria.results.filter((row) => row.id !== 'C02')) {
        assert.equal(criterion.verdict, 'NOT_TESTED', criterion.id);
        assert.equal(criterion.assessedChecks, 0, criterion.id);
      }
      const proposal = records.find((record) => record.kind === 'criterion_proposal')!;
      const review = records.find((record) => record.kind === 'criterion_review')!;
      assert.equal(proposal.author, 'saved-example');
      assert.equal(review.author, 'saved-example');
      assert.equal(review.payload.provenance, 'saved-example');
      assert.equal(review.payload.proposalId, proposal.id);
      assert.equal(review.payload.proposalHash, proposal.hash);
      assert(records.every(recordIsIntact));
      assert(
        records.some(
          (record) => record.kind === 'candidate' && record.author === 'saved_analyst_response',
        ),
      );
      assert(
        records.some(
          (record) => record.kind === 'review' && record.author === 'saved_reviewer_response',
        ),
      );
      assert(
        records.some((record) => record.kind === 'action'),
        'This runs the actual offline keyboard walk.',
      );
      assert.equal(app.store.run(run.id).state, 'partial');
      assert.equal(report.criteria.score, null);
      assert.equal(app.store.usage(run.id).requests.length, 0);
      assert.equal(records.filter((record) => record.kind === 'at_check').length, 0);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
