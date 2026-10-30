import { readFile, writeFile, rename } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { publicBrief, publicPlanSteps } from './public-websites.mjs';
import { isPlanApprovalFailure } from './plan-failures.mjs';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const hash = /^[a-f0-9]{64}$/;
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const copied = (value) => structuredClone(value);
function identity(ownerHash, clientDraftId) {
  if (!hash.test(ownerHash) || !uuid.test(clientDraftId))
    throw Error('The local journey draft identity is missing. Open a new setup.');
  return `${ownerHash}:${clientDraftId.toLowerCase()}`;
}
export function checkedJourneyPlanReference(reference, ownerHash) {
  if (!reference || Object.keys(reference).sort().join(',') !== 'draftId,ownerHash,planHash,planId' ||
    !uuid.test(reference.draftId) || reference.ownerHash !== ownerHash ||
    !hash.test(reference.ownerHash) || !uuid.test(reference.planId) || !hash.test(reference.planHash))
    throw Error('The saved journey plan does not belong to this local start.');
  return copied(reference);
}
function preparedReply(reply) {
  if (!reply || reply.state !== 'prepared' || !uuid.test(reply.id) ||
    !uuid.test(reply.planId) || !hash.test(reply.planHash))
    throw Error('The Meta planner did not return a verified journey plan.');
  return { id: reply.id, state: 'prepared', planId: reply.planId,
    planHash: reply.planHash, steps: publicPlanSteps(reply.steps) };
}

/** Only local, private draft records are written here. No model implementation,
 * browser creation or Start occurs in this store. */
export async function openJourneyDrafts(file, prepareEngine) {
  const rows = new Map();
  const ids = new Set();
  const clientKeys = new Set();
  try {
    const saved = JSON.parse(await readFile(file, 'utf8'));
    if (!Array.isArray(saved)) throw Error('Invalid saved journey drafts');
    for (const row of saved) {
      const key = identity(row.ownerHash, row.clientDraftId);
      if (Object.keys(row).some((key) => !['id', 'ownerHash', 'clientDraftId', 'clientAliases', 'briefHash', 'url', 'goal', 'state', 'createdAt', 'planningRunId', 'prepared'].includes(key)) ||
        (row.planningRunId !== undefined && !uuid.test(row.planningRunId)) ||
        typeof row.createdAt !== 'string' || !Number.isFinite(Date.parse(row.createdAt)) ||
        rows.has(key) || ids.has(row.id) || !uuid.test(row.id) || !hash.test(row.briefHash) ||
        !['pending', 'prepared', 'unavailable', 'discarded'].includes(row.state))
        throw Error('Invalid saved journey draft');
      if (row.clientAliases !== undefined && (!Array.isArray(row.clientAliases) ||
        row.clientAliases.some((value) => typeof value !== 'string' || !uuid.test(value))))
        throw Error('Invalid saved journey draft aliases');
      for (const clientId of [row.clientDraftId, ...(row.clientAliases ?? [])]) {
        const aliasKey = identity(row.ownerHash, clientId);
        if (clientKeys.has(aliasKey)) throw Error('Duplicate saved journey draft identity');
        clientKeys.add(aliasKey);
      }
      if (row.state !== 'discarded') {
        const brief = publicBrief({ url: row.url, journey: row.goal }, true);
        if (digest(brief) !== row.briefHash) throw Error('The saved journey brief has changed.');
        if (row.prepared) {
          const plan = preparedReply(row.prepared);
          if (JSON.stringify(plan) !== JSON.stringify(row.prepared) ||
            row.planningRunId !== plan.id) throw Error('The saved journey receipt has changed.');
        }
        if (row.state === 'prepared' && !row.prepared) throw Error('The saved journey plan is missing.');
      } else if (row.url || row.goal || row.prepared) throw Error('Discarded journey details remain.');
      rows.set(key, row);
      ids.add(row.id);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  let writes = Promise.resolve();
  const persist = () => {
    const next = writes.catch(() => {}).then(async () => {
      await writeFile(file + '.tmp', JSON.stringify([...rows.values()]), { mode: 0o600 });
      await rename(file + '.tmp', file);
    });
    writes = next;
    return next;
  };
  const inFlight = new Map();
  const lookup = (ownerHash, clientDraftId) => rows.get(identity(ownerHash, clientDraftId)) ??
    [...rows.values()].find((row) => row.ownerHash === ownerHash &&
      row.clientAliases?.includes(clientDraftId.toLowerCase()));
  const find = (ownerHash, clientDraftId, body) => {
    const key = identity(ownerHash, clientDraftId);
    const brief = publicBrief(body, true);
    const row = lookup(ownerHash, clientDraftId);
    if (row?.state === 'discarded') throw Error('This journey draft was discarded. Open a new setup.');
    if (row && row.briefHash !== digest(brief))
      throw Error('This draft belongs to a different website or journey. Open a new setup.');
    return { key, brief, row };
  };
  const attachUnused = (ownerHash, clientDraftId, found, usedDraftIds) => {
    if (found.row) return found.row;
    // A reload creates a new client identity. Both GET and POST must recover
    // the exact unfinished attempt: the GET itself may never have arrived.
    // Only server-owned saved jobs establish which proposals are already used.
    const row = [...rows.values()].reverse().find((candidate) =>
      candidate.ownerHash === ownerHash && candidate.briefHash === digest(found.brief) &&
      candidate.state !== 'discarded' && !usedDraftIds.has(candidate.id));
    if (row) row.clientAliases = [...(row.clientAliases ?? []), clientDraftId.toLowerCase()];
    return row;
  };
  return {
    async restore(ownerHash, clientDraftId, body, usedDraftIds = new Set()) {
      const found = find(ownerHash, clientDraftId, body);
      const row = attachUnused(ownerHash, clientDraftId, found, usedDraftIds);
      if (row && !found.row) await persist();
      await writes;
      return row?.state === 'prepared' && row.prepared ? copied(row.prepared) : null;
    },
    async prepare(ownerHash, clientDraftId, body, usedDraftIds = new Set()) {
      const found = find(ownerHash, clientDraftId, body);
      let row = attachUnused(ownerHash, clientDraftId, found, usedDraftIds);
      if (row && !found.row) await persist();
      if (!row) {
        row = { id: randomUUID(), ownerHash, clientDraftId: clientDraftId.toLowerCase(),
          briefHash: digest(found.brief), ...found.brief, state: 'pending', createdAt: new Date().toISOString() };
        rows.set(found.key, row);
      }
      if (inFlight.has(row.id)) return copied(await inFlight.get(row.id));
      const pending = (async () => {
        // The immutable request identity must survive a lost response.
        await persist();
        try {
          if (row.state === 'discarded') throw Error('This journey draft was discarded. Open a new setup.');
          let reply;
          try {
            reply = await prepareEngine({ draftId: row.id, ownerHash,
              url: row.url, goal: row.goal });
          } catch (error) {
            if (row.state === 'discarded') throw Error('This journey draft was discarded. Open a new setup.', { cause: error });
            if (isPlanApprovalFailure(error)) throw error;
            throw Error('The Meta plan reply could not be confirmed. Its original request is retained; retry this same draft.', { cause: error });
          }
          if (row.state === 'discarded') throw Error('This journey draft was discarded. Open a new setup.');
          if (!reply || !uuid.test(reply.id) ||
            !['prepared', 'planning', 'unavailable', 'started'].includes(reply.state))
            throw Error('The Meta planner returned an incomplete journey reply. Retry this same draft.');
          if (row.planningRunId && row.planningRunId !== reply.id)
            throw Error('The saved planning run identity changed. No new draft was created.');
          row.planningRunId = reply.id;
          if (reply.state === 'started') {
            if (!['running', 'complete', 'partial', 'stopped', 'interrupted'].includes(reply.runState))
              throw Error('The saved Start returned an unsupported run state.');
            row.state = 'unavailable';
            throw Error('Start has already been requested for this plan. Open the saved audit to review its progress; no new browser or generation was started.');
          }
          if (reply.state !== 'prepared') {
            row.state = 'unavailable';
            throw Error(reply.state === 'planning'
              ? 'The Meta journey plan is still being prepared. Retry this same draft.'
              : 'The Meta journey plan is unavailable. Its original request is retained; retry this same draft.');
          }
          const plan = preparedReply(reply);
          if (row.prepared && JSON.stringify(row.prepared) !== JSON.stringify(plan))
            throw Error('The saved Meta journey plan changed. No replacement was accepted.');
          row.prepared = plan;
          row.state = 'prepared';
          await persist();
          if (row.state === 'discarded') throw Error('This journey draft was discarded. Open a new setup.');
          return copied(plan);
        } catch (error) {
          if (row.state !== 'discarded') row.state = 'unavailable';
          await persist();
          throw error;
        }
      })();
      inFlight.set(row.id, pending);
      const clear = () => { if (inFlight.get(row.id) === pending) inFlight.delete(row.id); };
      pending.then(clear, clear);
      return copied(await pending);
    },
    saved(ownerHash, clientDraftId, body) {
      const { row } = find(ownerHash, clientDraftId, body);
      return row?.state === 'prepared' && row.prepared ? copied(row.prepared) : null;
    },
    existingReference(ownerHash, clientDraftId, body) {
      const { row } = find(ownerHash, clientDraftId, body);
      return row?.prepared ? checkedJourneyPlanReference({ draftId: row.id, ownerHash,
        planId: row.prepared.planId, planHash: row.prepared.planHash }, ownerHash) : null;
    },
    reference(ownerHash, clientDraftId, body) {
      const { row } = find(ownerHash, clientDraftId, body);
      if (row?.state !== 'prepared' || !row.prepared)
        throw Error('Prepare and review this journey plan before starting the audit.');
      return checkedJourneyPlanReference({ draftId: row.id, ownerHash,
        planId: row.prepared.planId, planHash: row.prepared.planHash }, ownerHash);
    },
    async discard(reference, ownerHash) {
      checkedJourneyPlanReference(reference, ownerHash);
      const row = [...rows.values()].find((candidate) => candidate.id === reference.draftId && candidate.ownerHash === ownerHash);
      if (!row) return;
      if (row.state === 'discarded') { await persist(); return; }
      if (row.prepared && (row.prepared.planId !== reference.planId || row.prepared.planHash !== reference.planHash))
        throw Error('The saved discard does not match its original journey plan.');
      row.state = 'discarded';
      delete row.url; delete row.goal; delete row.prepared;
      await persist();
    },
  };
}
