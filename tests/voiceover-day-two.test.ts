import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { captureVoiceOverCommand, isVoiceOverRunning, VoiceOverProbe } from '../src/voiceover.js';
import { voiceOver } from '@guidepup/guidepup';

test('VoiceOver running-state lookup is bounded to the current user and exact process name', async () => {
  const running = await isVoiceOverRunning(async (file, args, options) => {
    assert.equal(file, '/usr/bin/pgrep');
    assert.deepEqual(args, ['-u', '501', '-x', 'VoiceOver']);
    assert.equal(options.timeout, 2000);
    return { stdout: '1234\n5678\n' };
  }, 501);
  assert.equal(running, true);
  assert.equal(
    await isVoiceOverRunning(async () => {
      throw { code: 1, signal: null };
    }, 501),
    false,
  );
});

test('A failed or ambiguous process lookup cannot pretend VoiceOver was previously off', async () => {
  for (const failure of [
    { code: 2 },
    { code: 'EACCES' },
    { code: 'ETIMEDOUT', killed: true },
    { code: 1, signal: 'SIGTERM' },
    { code: 1, killed: true },
  ])
    await assert.rejects(
      () =>
        isVoiceOverRunning(async () => {
          throw failure;
        }, 501),
      (error) => error === failure,
    );
  for (const stdout of ['', '\n', '0\n', 'not a process', '1234 5678'])
    await assert.rejects(
      () => isVoiceOverRunning(async () => ({ stdout }), 501),
      /previous state is unknown/,
    );
  await assert.rejects(
    () => isVoiceOverRunning(async () => ({ stdout: '1234' }), -1),
    /current Mac user/,
  );
});

test('A previously running reader is restored exactly once after cleanup', async () => {
  const events: string[] = [];
  const stop = mock.method(voiceOver, 'stop', async () => {
    events.push('stop');
  });
  try {
    const probe = new VoiceOverProbe({} as any, async () => {
      events.push('restore');
    });
    Object.assign(probe, { startedByUs: true, wasRunning: true, starting: Promise.resolve() });
    await Promise.all([probe.cleanup(), probe.cleanup()]);
    assert.deepEqual(events, ['stop', 'restore']);
  } finally {
    stop.mock.restore();
  }
});

test('Switching away during a command withholds foreign-app speech and item text', async () => {
  const phrases = ['Original website speech'];
  let reads = 0,
    itemReads = 0;
  const reader = {
    spokenPhraseLog: async () => {
      reads++;
      return phrases;
    },
    itemText: async () => {
      itemReads++;
      return 'Foreign private item';
    },
  };
  await assert.rejects(
    () =>
      captureVoiceOverCommand(
        async () => {
          phrases.push('Foreign private speech');
        },
        reader,
        async () => {
          throw Error('Foreground changed; result withheld.');
        },
      ),
    /result withheld/,
  );
  assert.equal(reads, 1, 'Only the pre-command website speech was read.');
  assert.equal(itemReads, 0, 'Foreign item text was not read or returned.');
});

test('A switch during result collection is caught before any observed result is returned', async () => {
  const phrases: string[] = [];
  let foreground = true,
    guards = 0;
  const reader = {
    spokenPhraseLog: async () => phrases,
    itemText: async () => {
      foreground = false;
      return 'Foreign item';
    },
  };
  await assert.rejects(
    () =>
      captureVoiceOverCommand(
        async () => {
          phrases.push('Original website speech');
        },
        reader,
        async () => {
          guards++;
          if (!foreground) throw Error('Foreground changed while collecting the result.');
        },
      ),
    /Foreground changed/,
  );
  assert.equal(guards, 2);
});

test('Empty speech entries do not count as actual announcements', async () => {
  const phrases: string[] = [];
  const reader = { spokenPhraseLog: async () => phrases, itemText: async () => 'button' };
  const observed = await captureVoiceOverCommand(async () => {
    phrases.push('', '  ', 'Return to basket');
  }, reader);
  assert.deepEqual(observed.spokenPhrases, ['Return to basket']);
});

test('A VoiceOver command keeps its own speech; later announcements cannot rewrite earlier evidence', async () => {
  const phrases: string[] = ['Earlier unrelated announcement'];
  let item = 'banner';
  const reader = { spokenPhraseLog: async () => phrases, itemText: async () => item };
  const first = await captureVoiceOverCommand(async () => {
    phrases.push('In web content banner');
  }, reader);
  const second = await captureVoiceOverCommand(async () => {
    item = 'Add to basket button';
    phrases.push('Add to basket button');
  }, reader);
  const third = await captureVoiceOverCommand(async () => {
    phrases.push('Added to your basket.');
  }, reader);
  assert.deepEqual(first.spokenPhrases, ['In web content banner']);
  assert.deepEqual(second.spokenPhrases, ['Add to basket button']);
  assert.deepEqual(third.spokenPhrases, ['Added to your basket.']);
  assert.equal(first.itemText, 'banner');
  assert.equal(second.itemText, 'Add to basket button');
});

test('A reset speech log does not manufacture a healthy VoiceOver command', async () => {
  const phrases = ['Original announcement'];
  const reader = { spokenPhraseLog: async () => phrases, itemText: async () => 'button' };
  await assert.rejects(
    () =>
      captureVoiceOverCommand(async () => {
        phrases.length = 0;
        phrases.push('Replacement');
      }, reader),
    /inconclusive/,
  );
});

test('A VoiceOver check refuses a changed original before touching the native reader', async () => {
  const source: any = {
    id: 'original',
    runId: 'run',
    kind: 'capture',
    hash: 'not-a-valid-hash',
    payload: { stable: true, url: 'http://127.0.0.1:4317/shop/' },
  };
  let writes = 0;
  const walk: any = {
    runId: 'run',
    assertActive() {},
    page: { url: () => source.payload.url },
    store: {
      record: () => source,
      append: () => {
        writes++;
      },
    },
  };
  await assert.rejects(() => new VoiceOverProbe(walk).check(source), /exact stable original/);
  assert.equal(writes, 0);
});
