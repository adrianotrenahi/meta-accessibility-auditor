import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { openJourneyDrafts } from "./journey-drafts.mjs";
import {
  recoverUnstartedJourneyJob,
  confirmJourneyJobDiscard,
} from "./journey-job-cleanup.mjs";

const owner = "a".repeat(64);
const brief = {
  url: "https://93.184.216.34/",
  journey: "Synthetic private journey words to remove.",
};
const steps = [
  {
    id: "open",
    text: "Read synthetic private screen.",
    intent: "navigate",
    success: "The screen is visible.",
  },
  {
    id: "read",
    text: "Inspect the synthetic result without selecting it.",
    intent: "verify",
    success: "The result or its actual limitation is visible.",
  },
];
async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "journey-job-cleanup-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "drafts.json");
  let generations = 0;
  const draftId = randomUUID();
  const reply = {
    id: randomUUID(),
    state: "prepared",
    planId: randomUUID(),
    planHash: "b".repeat(64),
    steps,
  };
  const drafts = await openJourneyDrafts(file, async () => {
    generations++;
    return reply;
  });
  await drafts.prepare(owner, draftId, brief);
  const job = {
    id: randomUUID(),
    engineId: null,
    owner,
    draftId,
    deleted: false,
    discarding: false,
    target: { url: brief.url, goal: brief.journey, steps },
    briefHash: "c".repeat(64),
    journeyPlan: drafts.reference(owner, draftId, brief),
  };
  return { file, drafts, job, generations: () => generations };
}

test("Prepared Start recovery preserves the exact proposal and never starts, replans or tombstones it automatically", async (t) => {
  const f = await fixture(t);
  const before = JSON.stringify(f.job),
    calls = [];
  await recoverUnstartedJourneyJob(
    f.job,
    { id: null, discarded: false, discardPending: false },
    async (...args) => {
      calls.push(args);
      throw Error("No recovery action may be sent.");
    },
  );
  assert.equal(JSON.stringify(f.job), before);
  assert.deepEqual(calls, []);
  assert.deepEqual(
    f.drafts.reference(owner, f.job.draftId, brief),
    f.job.journeyPlan,
  );
  assert.equal(f.generations(), 1);
});

test("Legacy missing-Start recovery still makes it unavailable and removes its private target", async () => {
  const job = {
    id: randomUUID(),
    engineId: null,
    owner,
    deleted: false,
    discarding: false,
    target: { url: brief.url, goal: brief.journey, steps },
    briefHash: "d".repeat(64),
  };
  const calls = [];
  await recoverUnstartedJourneyJob(
    job,
    { id: null, discarded: false },
    async (...args) => {
      calls.push(args);
      return Response.json({ discarded: true });
    },
  );
  assert.equal(job.deleted, true);
  assert.equal(job.target, undefined);
  assert.equal(job.briefHash, undefined);
  assert.deepEqual(calls, [
    [`/api/host/requests/${job.id}/discard`, "POST", {}],
  ]);
});

test("Confirmed cancellation waits for request cleanup then proposal cleanup before clearing private words", async (t) => {
  const f = await fixture(t);
  const calls = [];
  let release, entered;
  const wait = new Promise((resolve) => {
    release = resolve;
  });
  const publicCalled = new Promise((resolve) => {
    entered = resolve;
  });
  const call = async (route, method, body) => {
    calls.push({ route, method, body });
    if (route === "/api/host/journey-plans/discard") {
      entered();
      await wait;
    }
    return Response.json({ discarded: true });
  };
  const pending = confirmJourneyJobDiscard(f.job, call, f.drafts);
  await publicCalled;
  assert((await readFile(f.file, "utf8")).includes(brief.journey));
  assert.equal(f.job.deleted, false);
  assert.equal(f.job.target.goal, brief.journey);
  release();
  await pending;
  assert.deepEqual(
    calls.map((item) => item.route),
    [
      `/api/host/requests/${f.job.id}/discard`,
      "/api/host/journey-plans/discard",
    ],
  );
  assert.deepEqual(calls[1].body, {
    draftId: f.job.journeyPlan.draftId,
    ownerHash: owner,
    url: brief.url,
    goal: brief.journey,
  });
  const saved = await readFile(f.file, "utf8");
  assert(!saved.includes(brief.journey));
  assert(!saved.includes(steps[0].text));
  await assert.rejects(
    f.drafts.prepare(owner, f.job.draftId, brief),
    /discarded/,
  );
  await confirmJourneyJobDiscard(f.job, call, f.drafts);
  assert.equal(f.generations(), 1);
});

test("Unconfirmed cleanup preserves private words for retry and cannot silently mark the draft discarded", async (t) => {
  for (const failedStage of ["request", "proposal"]) {
    const f = await fixture(t),
      calls = [];
    await assert.rejects(
      confirmJourneyJobDiscard(
        f.job,
        async (route) => {
          calls.push(route);
          const stage = route.includes("/requests/") ? "request" : "proposal";
          return Response.json({ discarded: stage !== failedStage });
        },
        f.drafts,
      ),
      /confirm removal/,
    );
    assert((await readFile(f.file, "utf8")).includes(brief.journey));
    assert.equal(f.job.deleted, false);
    assert.equal(calls.length, failedStage === "request" ? 1 : 2);
    assert.deepEqual(
      f.drafts.reference(owner, f.job.draftId, brief),
      f.job.journeyPlan,
    );
    await confirmJourneyJobDiscard(
      f.job,
      async () => Response.json({ discarded: true }),
      f.drafts,
    );
    assert(!(await readFile(f.file, "utf8")).includes(brief.journey));
  }
});

test("Recovered discarded Start retains its words only until explicit proposal cleanup confirms", async (t) => {
  const f = await fixture(t);
  await recoverUnstartedJourneyJob(
    f.job,
    { id: null, discarded: true, discardPending: false },
    async () => {
      throw Error("Recovery defers the deletion to the ordinary discard flow.");
    },
  );
  assert.equal(f.job.deleted, false);
  assert.equal(f.job.discarding, true);
  assert.equal(f.job.target.goal, brief.journey);
  await confirmJourneyJobDiscard(
    f.job,
    async () => Response.json({ discarded: true }),
    f.drafts,
  );
  assert(!(await readFile(f.file, "utf8")).includes(brief.journey));
  assert.equal(f.generations(), 1);
});

test("Recovery preserves an existing engine identity and pending cleanup; foreign plan references send nothing", async (t) => {
  const f = await fixture(t),
    engineId = randomUUID();
  await recoverUnstartedJourneyJob(
    f.job,
    { id: engineId, discarded: false, discardPending: true },
    async () => {
      throw Error("No automatic action is needed.");
    },
  );
  assert.equal(f.job.engineId, engineId);
  assert.equal(f.job.discarding, true);
  let calls = 0;
  await assert.rejects(
    confirmJourneyJobDiscard(
      {
        ...f.job,
        journeyPlan: { ...f.job.journeyPlan, ownerHash: "f".repeat(64) },
      },
      async () => {
        calls++;
        return Response.json({ discarded: true });
      },
      f.drafts,
    ),
  );
  assert.equal(calls, 0);
});
