import { openSync, writeFileSync, readFileSync, closeSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
export function sessionLock(dir: string) {
  const file = join(dir, 'session.lock'),
    nonce = randomUUID();
  let fd: number;
  try {
    fd = openSync(file, 'wx', 0o600);
  } catch (e: any) {
    if (e.code !== 'EEXIST') throw e;
    const prior = JSON.parse(readFileSync(file, 'utf8'));
    if (!Number.isInteger(prior.pid) || prior.pid <= 0)
      throw Error('The previous session lock needs inspection.');
    try {
      process.kill(prior.pid, 0);
      throw Error('Another process owns this run store.');
    } catch (problem: any) {
      if (problem.code !== 'ESRCH') throw problem;
    }
    unlinkSync(file);
    fd = openSync(file, 'wx', 0o600);
  }
  writeFileSync(fd, JSON.stringify({ pid: process.pid, nonce }));
  closeSync(fd);
  return () => {
    try {
      const prior = JSON.parse(readFileSync(file, 'utf8'));
      if (prior.nonce === nonce) unlinkSync(file);
    } catch {
      /* A released lock needs no further cleanup. */
    }
  };
}
