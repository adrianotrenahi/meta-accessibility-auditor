import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

test('Initial approval denial is distinct at the actual HTTP boundary; uncertain replies stay uncertain', () => {
  const dir = mkdtempSync(join(tmpdir(), 'model-approval-http-'));
  try {
    const child = spawnSync(
      process.execPath,
      [
        '--import',
        import.meta.resolve('tsx'),
        fileURLToPath(new URL('./fixtures/model-approval-http.mts', import.meta.url)),
      ],
      {
        cwd: dir,
        env: {
          ...process.env,
          META_API_KEY: 'synthetic-offline-approval-test',
          MODEL_API_KEY: 'synthetic-offline-approval-test',
        },
        encoding: 'utf8',
        timeout: 30_000,
      },
    );
    assert.equal(child.status, 0, child.stdout + child.stderr);
    const receipt = JSON.parse(child.stdout.trim().split('\n').at(-1)!);
    assert.equal(receipt.actualProviderCalls, 0);
    assert.equal(receipt.deniedBeforeProvider, true);
    assert.equal(receipt.sameDraftRecovered, true);
    assert.equal(receipt.unknownReplyPreserved, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
