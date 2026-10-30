import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openJourneyDrafts, checkedJourneyPlanReference } from './journey-drafts.mjs';

const owner='a'.repeat(64), other='b'.repeat(64), body={url:'https://www.booking.com',journey:'Find Madrid to London return flights, 23–25 December 2026. Stop at results.'};
const steps=[{id:'flights',text:'Open flight search',intent:'navigate',success:'The flight search is visible.'},{id:'route',text:'Set Madrid and London',intent:'form',success:'Madrid and London are selected.'},{id:'dates',text:'Set 23–25 December 2026',intent:'form',success:'The selected return dates are visible.'},{id:'results',text:'Search and stop at usable results',intent:'verify',success:'Usable results show the chosen route and dates; no flight is selected.'}];
const prepared=()=>({id:randomUUID(),state:'prepared',planId:randomUUID(),planHash:'c'.repeat(64),steps});
async function fixture(t){const dir=await mkdtemp(path.join(tmpdir(),'meta-journey-draft-'));t.after(()=>rm(dir,{recursive:true,force:true}));return path.join(dir,'drafts.json');}

test('persist the server identity before a single concurrent prepare; bind its exact receipt on Start',async t=>{
 const file=await fixture(t), client=randomUUID(), reply=prepared();let calls=0;let release;const hold=new Promise(r=>{release=r;});
 const store=await openJourneyDrafts(file,async request=>{calls++;const saved=JSON.parse(await readFile(file,'utf8'));assert.equal(saved[0].id,request.draftId);assert.notEqual(request.draftId,client);assert.equal(request.ownerHash,owner);assert.equal(request.url,'https://www.booking.com/');await hold;return reply;});
 const first=store.prepare(owner,client,body), second=store.prepare(owner,client,body);release();const [a,b]=await Promise.all([first,second]);assert.deepEqual(a,b);assert.equal(calls,1);
 const ref=store.reference(owner,client,body);assert.equal(ref.planId,reply.planId);assert.equal(ref.planHash,reply.planHash);assert.equal(ref.ownerHash,owner);assert.equal(ref.draftId,JSON.parse(await readFile(file,'utf8'))[0].id);
 const edited=structuredClone(steps);edited[1].text='Choose Madrid MAD and any London airport';assert.notDeepEqual(edited,store.saved(owner,client,body).steps);assert.deepEqual(store.saved(owner,client,body).steps,steps);
 a.steps[0].text='Changed outside';assert.deepEqual(store.saved(owner,client,body).steps,steps);
});

test('owner, draft and canonical brief remain bound across reload and changed retries',async t=>{
 const file=await fixture(t),client=randomUUID(),reply=prepared();let calls=0;let draft;
 let store=await openJourneyDrafts(file,async request=>{calls++;draft=request.draftId;return reply;});await store.prepare(owner,client,body);
 assert.equal(store.saved(other,client,body),null);assert.throws(()=>store.reference(other,client,body));assert.throws(()=>store.saved(owner,client,{...body,journey:'Changed journey'}),/different/);
 await assert.rejects(store.prepare(owner,client,{...body,url:'https://example.com'}),/different/);assert.equal(calls,1);
 store=await openJourneyDrafts(file,async request=>{calls++;assert.equal(request.draftId,draft);return reply;});assert.deepEqual(store.saved(owner,client,body),reply);await store.prepare(owner,client,{...body,url:'https://www.booking.com/'});assert.equal(calls,2);
});

test('an uncertain response retries the same persisted identity and never invents a fresh generation',async t=>{
 const file=await fixture(t),client=randomUUID(),reply=prepared();const generation=new Map();const ids=[];let lose=true;
 const engine=async request=>{ids.push(request.draftId);if(!generation.has(request.draftId))generation.set(request.draftId,reply);if(lose){lose=false;throw Error('Uncertain reply');}return generation.get(request.draftId);};
 let store=await openJourneyDrafts(file,engine);await assert.rejects(store.prepare(owner,client,body),/original request is retained/);assert.equal(store.saved(owner,client,body),null);assert.throws(()=>store.reference(owner,client,body),/Prepare/);
 store=await openJourneyDrafts(file,engine);await store.prepare(owner,client,body);assert.equal(ids[0],ids[1]);assert.equal(generation.size,1);
});

test('planning, unavailable, malformed and changed receipts never become a displayed replacement plan',async t=>{
 const file=await fixture(t),client=randomUUID(),reply=prepared();let response={id:reply.id,state:'planning'};const store=await openJourneyDrafts(file,async()=>response);
 await assert.rejects(store.prepare(owner,client,body),/still being prepared/);assert.equal(store.saved(owner,client,body),null);
 response={id:reply.id,state:'unavailable'};await assert.rejects(store.prepare(owner,client,body),/unavailable/);
 response={...reply,steps:[]};await assert.rejects(store.prepare(owner,client,body));assert.equal(store.saved(owner,client,body),null);
 response=reply;await store.prepare(owner,client,body);response={...reply,planHash:'d'.repeat(64)};await assert.rejects(store.prepare(owner,client,body),/changed/);assert.equal(store.saved(owner,client,body),null);assert.throws(()=>store.reference(owner,client,body));
 response=reply;await store.prepare(owner,client,body);response={...reply,id:randomUUID()};await assert.rejects(store.prepare(owner,client,body),/identity changed/);
});

test('a current engine refusal cannot be hidden by an older cached prepared receipt',async t=>{
 const file=await fixture(t),client=randomUUID(),reply=prepared();let refused=false;const store=await openJourneyDrafts(file,async()=>{if(refused)throw Error('Refused');return reply;});await store.prepare(owner,client,body);refused=true;await assert.rejects(store.prepare(owner,client,body));assert.equal(store.saved(owner,client,body),null);assert.throws(()=>store.reference(owner,client,body));
 const saved=JSON.parse(await readFile(file,'utf8'));assert.deepEqual(saved[0].prepared,reply);
});

test('confirmed discard clears private words but leaves an identity tombstone, never a new paid draft',async t=>{
 const file=await fixture(t),client=randomUUID(),reply=prepared();let calls=0;const store=await openJourneyDrafts(file,async()=>{calls++;return reply;});await store.prepare(owner,client,body);const ref=store.reference(owner,client,body);
 await assert.rejects(store.discard({...ref,planId:randomUUID()},owner),/match/);await store.discard(ref,owner);await store.discard(ref,owner);const saved=await readFile(file,'utf8');assert(!saved.includes('booking'));assert(!saved.includes('Madrid'));assert(!saved.includes('Open flight'));await assert.rejects(store.prepare(owner,client,body),/discarded/);assert.equal(calls,1);
 const reloaded=await openJourneyDrafts(file,async()=>{throw Error('must not call');});assert.throws(()=>reloaded.reference(owner,client,body),/discarded/);
});

test('discard while a request is in flight cannot resurrect the discarded plan',async t=>{
 const file=await fixture(t),client=randomUUID(),reply=prepared();let again=false,release;const hold=new Promise(r=>{release=r;});let entered;const started=new Promise(r=>{entered=r;});const store=await openJourneyDrafts(file,async()=>{if(again){entered();await hold;}return reply;});await store.prepare(owner,client,body);const ref=store.reference(owner,client,body);again=true;const pending=store.prepare(owner,client,body);await started;await store.discard(ref,owner);release();await assert.rejects(pending,/discarded/);assert.throws(()=>store.saved(owner,client,body),/discarded/);const raw=await readFile(file,'utf8');assert(!raw.includes('Madrid'));
});

test('missing or foreign start references and damaged persisted drafts refuse without a generation',async t=>{
 const file=await fixture(t);let calls=0;const store=await openJourneyDrafts(file,async()=>{calls++;return prepared();});const client=randomUUID();assert.throws(()=>store.reference(owner,client,body));assert.throws(()=>checkedJourneyPlanReference({draftId:randomUUID(),ownerHash:other,planId:randomUUID(),planHash:'a'.repeat(64)},owner));assert.equal(calls,0);
 await writeFile(file,JSON.stringify([{id:randomUUID(),ownerHash:owner,clientDraftId:client,briefHash:'a'.repeat(64),url:body.url,goal:body.journey,state:'prepared',createdAt:new Date().toISOString()}]));await assert.rejects(openJourneyDrafts(file,async()=>{calls++;}),/changed|missing/);assert.equal(calls,0);
});

test('a fresh browser draft after reload restores the same unstarted owned proposal durably', async t => {
 const file = await fixture(t), first = randomUUID(), afterReload = randomUUID(), reply = prepared();
 let calls = 0;
 let store = await openJourneyDrafts(file, async () => { calls++; return reply; });
 await store.prepare(owner, first, body);
 const original = store.reference(owner, first, body);
 assert.deepEqual(await store.restore(owner, afterReload, body), reply);
 assert.deepEqual(store.reference(owner, afterReload, body), original);
 assert.equal(calls, 1, 'Reading the saved plan must not generate again.');
 store = await openJourneyDrafts(file, async () => { throw Error('No generation on reload'); });
 assert.deepEqual(store.reference(owner, afterReload, body), original);
 await assert.rejects(store.restore(owner, afterReload, { ...body, journey: 'Changed' }), /different/);
 assert.equal(await store.restore(other, randomUUID(), body), null);
 await store.discard(original, owner);
 await assert.rejects(store.restore(owner, afterReload, body), /discarded/);
 const raw = await readFile(file, 'utf8');
 assert(!raw.includes('Madrid')); assert(!raw.includes('booking'));
});

test('reload after an unknown reply reattaches its identity, and an already started draft is not offered anew', async t => {
 const file = await fixture(t), first = randomUUID(), next = randomUUID(), reply = prepared();
 const ids = [];
 const store = await openJourneyDrafts(file, async request => {
  ids.push(request.draftId);
  if (ids.length === 1) throw Error('Lost synthetic reply');
  return reply;
 });
 await assert.rejects(store.prepare(owner, first, body));
 assert.equal(await store.restore(owner, next, body), null);
 await store.prepare(owner, next, body);
 assert.equal(ids[0], ids[1], 'The engine sees the original uncertain attempt.');
 const ref = store.reference(owner, next, body), fresh = randomUUID();
 assert.equal(await store.restore(owner, fresh, body, new Set([ref.draftId])), null);
 assert.throws(() => store.reference(owner, fresh, body), /Prepare/);
});

test('duplicate persisted reload identities are refused before any planning request', async t => {
 const file = await fixture(t), client = randomUUID(), alias = randomUUID();
 const store = await openJourneyDrafts(file, async () => prepared());
 await store.prepare(owner, client, body);
 await store.restore(owner, alias, body);
 const saved = JSON.parse(await readFile(file, 'utf8'));
 saved[0].clientAliases.push(alias);
 await writeFile(file, JSON.stringify(saved));
 await assert.rejects(openJourneyDrafts(file, async () => { throw Error('Must not generate'); }), /Duplicate/);
});

test('discard during the final saved-plan write cannot return removed plan words', async t => {
 const file = await fixture(t), client = randomUUID(), result = prepared();
 let scheduleDiscard = false, queued = false, discardPromise;
 let store, reference;
 const reply = { ...result };
 Object.defineProperty(reply, 'planHash', { enumerable: true, get() {
  if (scheduleDiscard && !queued) {
   queued = true;
   queueMicrotask(() => { discardPromise = store.discard(reference, owner); });
  }
  return result.planHash;
 } });
 store = await openJourneyDrafts(file, async () => reply);
 await store.prepare(owner, client, body);
 reference = store.reference(owner, client, body);
 scheduleDiscard = true;
 await assert.rejects(store.prepare(owner, client, body), /discarded/);
 await discardPromise;
 const raw = await readFile(file, 'utf8');
 assert(!raw.includes('Madrid')); assert(!raw.includes('booking'));
 assert.throws(() => store.saved(owner, client, body), /discarded/);
});

test('a used proposal reports its saved Start instead of pretending planning failed', async t => {
 const file = await fixture(t), client = randomUUID(), original = prepared();
 let reply = original;
 const store = await openJourneyDrafts(file, async () => reply);
 await store.prepare(owner, client, body);
 reply = { id: original.id, state: 'started', runState: 'running' };
 await assert.rejects(store.prepare(owner, client, body), /Start has already been requested/);
 assert.equal(store.saved(owner, client, body), null);
 const row = JSON.parse(await readFile(file, 'utf8'))[0];
 assert.deepEqual(row.prepared, original);
 assert.equal(row.planningRunId, original.id);
});


test('POST after a lost saved-plan GET reattaches the exact uncertain attempt before contacting the engine', async t => {
 const file = await fixture(t), first = randomUUID(), afterReload = randomUUID(), reply = prepared();
 const ids = [];
 let store = await openJourneyDrafts(file, async request => {
  ids.push(request.draftId);
  if (ids.length === 1) throw Error('Lost synthetic planning reply');
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert(saved[0].clientAliases.includes(afterReload), 'The new alias is durable before outbound work.');
  return reply;
 });
 await assert.rejects(store.prepare(owner, first, body));
 // No restore: the saved-plan GET never arrived at the server.
 await store.prepare(owner, afterReload, body, new Set());
 assert.equal(new Set(ids).size, 1);
 assert.equal(JSON.parse(await readFile(file, 'utf8')).length, 1);
 const reference = store.reference(owner, afterReload, body);
 store = await openJourneyDrafts(file, async () => { throw Error('No reload generation'); });
 assert.deepEqual(store.reference(owner, afterReload, body), reference);
 assert.equal(store.saved(other, afterReload, body), null);
});

test('POST recovery keeps used, discarded, foreign and changed-brief attempts separate', async t => {
 const file = await fixture(t), ids = [], first = randomUUID(), reply = prepared();
 const store = await openJourneyDrafts(file, async request => {
  ids.push(request.draftId);
  return { ...reply, id: randomUUID(), planId: randomUUID() };
 });
 await store.prepare(owner, first, body);
 const used = store.reference(owner, first, body);
 const next = randomUUID();
 await store.prepare(owner, next, body, new Set([used.draftId]));
 const second = store.reference(owner, next, body);
 assert.notEqual(second.draftId, used.draftId);
 await store.discard(second, owner);
 const third = randomUUID();
 await store.prepare(owner, third, body, new Set([used.draftId]));
 assert.notEqual(store.reference(owner, third, body).draftId, second.draftId);
 await store.prepare(other, randomUUID(), body);
 await store.prepare(owner, randomUUID(), { ...body, journey: 'A different synthetic journey.' });
 assert.equal(new Set(ids).size, 5);
 assert.equal(JSON.parse(await readFile(file, 'utf8')).length, 5);
});


test('a discarded removal is saved again after a failed physical write before success is reported', async t => {
 const file = await fixture(t), client = randomUUID(), reply = prepared();
 const store = await openJourneyDrafts(file, async () => reply);
 await store.prepare(owner, client, body);
 const reference = store.reference(owner, client, body);
 await mkdir(file + '.tmp');
 await assert.rejects(store.discard(reference, owner));
 assert((await readFile(file, 'utf8')).includes(body.journey));
 await rm(file + '.tmp', { recursive: true });
 await store.discard(reference, owner);
 const saved = await readFile(file, 'utf8');
 assert(!saved.includes(body.journey), 'Successful retry must physically remove the private words.');
 assert(!saved.includes(steps[0].text));
 const reloaded = await openJourneyDrafts(file, async () => { throw Error('No new generation'); });
 assert.throws(() => reloaded.reference(owner, client, body), /discarded/);
});
