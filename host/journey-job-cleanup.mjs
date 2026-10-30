import { checkedJourneyPlanReference } from "./journey-drafts.mjs";
import { publicBrief } from "./public-websites.mjs";

async function confirmed(call, route, body) {
  const reply = await (await call(route, "POST", body)).json();
  if (reply?.discarded !== true)
    throw Error("The local engine did not confirm removal. Retry discard.");
}

/** Keep the exact prepared Start available; recovery never starts or replans it. */
export async function recoverUnstartedJourneyJob(job, found, call) {
  if (job.journeyPlan) checkedJourneyPlanReference(job.journeyPlan, job.owner);
  if (found.id) job.engineId = found.id;
  if (!found.id && !found.discarded && job.journeyPlan) return;
  if (!found.id && !found.discarded)
    await confirmed(call, `/api/host/requests/${job.id}/discard`, {});
  if ((found.discarded || !found.id) && job.journeyPlan) {
    // The ordinary discard path still has the original target needed to
    // remove the public proposal before clearing the private words.
    job.deleted = false;
    job.discarding = true;
  } else {
    job.deleted = found.discarded || !found.id;
    if (job.deleted) {
      delete job.target;
      delete job.briefHash;
    }
  }
  if (found.discardPending) job.discarding = true;
}

/** Both engine deletions must finish before the private draft is tombstoned. */
export async function confirmJourneyJobDiscard(job, call, journeyDrafts) {
  const reference = job.journeyPlan
    ? checkedJourneyPlanReference(job.journeyPlan, job.owner)
    : null;
  const brief = reference
    ? publicBrief({ url: job.target?.url, journey: job.target?.goal }, true)
    : null;
  await confirmed(call, `/api/host/requests/${job.id}/discard`, {});
  if (reference) {
    await confirmed(call, "/api/host/journey-plans/discard", {
      draftId: reference.draftId,
      ownerHash: reference.ownerHash,
      url: brief.url,
      goal: brief.goal,
    });
    if (!journeyDrafts)
      throw Error(
        "The private journey draft could not be cleared. Retry discard.",
      );
    await journeyDrafts.discard(reference, job.owner);
  }
}
