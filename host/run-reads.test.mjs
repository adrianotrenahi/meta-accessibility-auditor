import { test } from "node:test";
import assert from "node:assert/strict";
import { RUN_READ_REUSE_MS, recentRunReads } from "./funnel-server.mjs";

// Owner, 31 Oct: "on each step the time is increasing". The run page asks twice a second and
// every fresh answer is built in the program that drives the robot, so a recent one is shared.
test("A running run's recent answer is shared; an ended, stopped or failed one is read again", async () => {
  let clock = 0,
    asked = 0,
    state = "running",
    fail = false;
  const reads = recentRunReads(async () => {
    asked++;
    if (fail) throw Error("engine busy");
    return { snapshot: { run: { state } } };
  }, () => clock);
  const job = { id: "job", engineId: "engine", deleted: false, discarding: false };

  await reads.read(job);
  await Promise.all([reads.read(job), reads.read(job)]);
  assert.equal(asked, 1, "page refreshes inside the window reuse one engine read");
  clock += RUN_READ_REUSE_MS;
  await reads.read(job);
  assert.equal(asked, 2, "an older answer is read again");

  reads.forget(job.id);
  await reads.read(job);
  assert.equal(asked, 3, "Stop or Continue reads the run again at once");

  state = "completed";
  clock += RUN_READ_REUSE_MS;
  await reads.read(job);
  await reads.read(job);
  assert.equal(asked, 5, "an ended run is never shared");

  state = "running";
  fail = true;
  clock += RUN_READ_REUSE_MS;
  await assert.rejects(reads.read(job), /engine busy/);
  fail = false;
  await reads.read(job);
  assert.equal(asked, 7, "a failed read is not reused");

  assert.equal(reads.read({ ...job, discarding: true }), null);
  assert.equal(reads.read({ ...job, deleted: true }), null);
  await reads.read({ ...job, engineId: "another-engine" });
  assert.equal(asked, 8, "a retried Start's new engine run is read afresh");
});
