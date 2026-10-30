import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configuredPublicWebsites,publicBrief,publicPlan,publicPlanSteps,validateSavedPublicTarget } from './public-websites.mjs';
const devices=['desktop_1440_900'];
const brief={url:'https://www.quironsalud.com/',goal:'Find dermatology in Barcelona for January 2027. Stop before confirmation.'};
const proposed=[{id:'specialty',text:'Find dermatology in Barcelona',intent:'search',success:'Dermatology choices in Barcelona are visible.'},{id:'availability',text:'Inspect January 2027 appointment availability',intent:'verify',success:'Availability or its actual limitation is visible; no booking is confirmed.'}];
const body=()=>({url:brief.url,acceptedUsePolicy:true,accountId:'testing-account',plan:{url:brief.url,journey:brief.goal,steps:publicPlanSteps(proposed),draftId:'11111111-1111-4111-8111-111111111111',devices,features:[],maskSensitiveData:false,keyboardJourney:true}});
test('public setup retains the actual website and journey instead of substituting shop instructions',()=>{
  assert.deepEqual(publicBrief({url:brief.url,journey:brief.goal},true),brief);
  const result=publicPlan(body(),devices);assert.equal(result.goal,brief.goal);assert.equal(result.url,brief.url);assert(!JSON.stringify(result).includes('canvas bag'));
  const reordered=body();reordered.plan.steps=reordered.plan.steps.map(s=>Object.fromEntries(Object.entries(s).reverse()));
  assert.equal(JSON.stringify(publicPlan(reordered,devices)),JSON.stringify(result));
});
test('public website mode requires matching explicit startup and actual model mode',()=>{
  assert.equal(configuredPublicWebsites({mode:'offline',capabilities:{}}),false);
  assert.equal(configuredPublicWebsites({mode:'live',capabilities:{publicWebsites:true}},true),true);
  for(const [manifest,enabled] of [[{mode:'offline',capabilities:{publicWebsites:true}},true],[{mode:'live',capabilities:{}},true],[{mode:'live',capabilities:{publicWebsites:true}},false]]) assert.throws(()=>configuredPublicWebsites(manifest,enabled));
});
test('public setup refuses unsupported settings, changed targets, empty journeys and duplicate steps',()=>{
  for(const change of [{url:'https://different.example/'},{keyboardJourney:false},{devices:['phone']},{features:['account']},{journey:''},{steps:[]},{steps:[{id:'same',text:'a'},{id:'same',text:'b'}]},{steps:[{id:'x',text:'a',unsupported:true}]}]){const b=body();Object.assign(b.plan,change);assert.throws(()=>publicPlan(b,devices));}
  assert.throws(()=>publicBrief({url:'https://user:pass@example.org',journey:brief.goal},true));
});
test('saved targets remain validated after reload and discarded runs contain no retained brief',()=>{
  const b=body(),target=publicPlan(b,devices);assert.deepEqual(validateSavedPublicTarget({target,draftId:b.plan.draftId}),target);
  assert.equal(validateSavedPublicTarget({deleted:true}),undefined);
  assert.throws(()=>validateSavedPublicTarget({deleted:true,target}));
  assert.throws(()=>validateSavedPublicTarget({target:{...target,steps:[{id:'x',text:'a',bad:true}]},draftId:b.plan.draftId}));
});

test('a public plan requires actual structured steps, never a generic brief fallback',()=>{
  assert.throws(()=>publicPlanSteps(brief));
  assert.throws(()=>publicPlanSteps([{id:'missing',text:'Choose a doctor'}]));
  assert.throws(()=>publicPlanSteps([proposed[0]]),/at least two/);
  assert.deepEqual(publicPlanSteps(proposed),proposed);
});
