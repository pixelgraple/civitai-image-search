import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { harness } from './background-harness.mjs';

const key = 'aiImageDatasetScraperStateV6';
const pageUrl = 'https://civitai.red/models/99';
const record = { id: '55', prompt: 'Landscape fixture', downloadUrl: 'https://image.civitai.com/key/55/original=true/55.png' };
function installRun(h) {
  h.context.fixtureRecord = record;
  h.run(`{
    const run=freshState({sessionTabId:7,pageUrl:${JSON.stringify(pageUrl)}});
    run.status.running=run.status.scanning=true;
    run.feed={site:'civitai',pageUrl:run.settings.pageUrl,endpoint:'image.getInfinite',filters:{modelId:99},cursor:'saved-cursor',done:false,pages:2};
    run.preparedRecords={'55':fixtureRecord}; run.outstandingIds=['55'];
    sessions.set(7,run); const driver=newDriver();driver.enabled=true;drivers.set(7,driver);
  }`);
}

test('connection failures retry after five seconds even after three failed uploads; work survives', async () => {
  const h=await harness();installRun(h);
  h.run('syncCloudCatalogItems=async()=>{throw new TypeError("Failed to fetch")};');
  for(let attempt=0;attempt<5;attempt++) {
    h.run('sessions.get(7).uploadRetryAt=0');
    const before=Date.now();
    await assert.rejects(h.run('ensureManualSubmission(sessions.get(7),fixtureRecord)'),/Failed to fetch/);
    assert.equal(h.run('sessions.get(7).status.running'),true);
    assert.ok(h.run('sessions.get(7).uploadRetryAt')>=before+5000);
    assert.ok(h.run('sessions.get(7).uploadRetryAt')<=Date.now()+5000);
    assert.equal(h.run('sessions.get(7).preparedRecords["55"].prompt'),record.prompt);
    assert.equal(h.run('sessions.get(7).feed.cursor'),'saved-cursor');
  }
  h.run('sessions.get(7).uploadRetryAt=0;syncCloudCatalogItems=async()=>acceptManualRecords(sessions.get(7),[fixtureRecord],[{imageId:"55",exists:false}]);');
  await h.run('ensureManualSubmission(sessions.get(7),fixtureRecord)');
  assert.equal(h.run('sessions.get(7).catalogSyncedIds.includes("55")'),true);
  assert.equal(h.run('sessions.get(7).preparedRecords["55"]'),undefined);
});

test('source connection failures preserve the cursor and do not stop after three attempts', async () => {
  const h=await harness();installRun(h);
  h.run('sessions.get(7).preparedRecords={};ISSFeed.next=async()=>{throw Object.assign(new Error("The Civitai feed request timed out."),{status:0})};');
  for(let attempt=0;attempt<5;attempt++) {
    const before=Date.now();
    await h.run('backgroundFeedPulse(7)');
    assert.equal(h.run('sessions.get(7).status.running'),true);
    assert.equal(h.run('sessions.get(7).feed.cursor'),'saved-cursor');
    assert.ok(h.run('sessions.get(7).feed.retryAt')>=before+5000);
    assert.ok(h.run('sessions.get(7).feed.retryAt')<=Date.now()+5000);
    h.run('sessions.get(7).feed.retryAt=0');
  }
});

test('catalog transport errors name the destination and apply a shared five second cooldown', async () => {
  const h=await harness();h.context.fetch=async()=>{throw new TypeError('Failed to fetch')};
  await assert.rejects(h.run('postCatalog("images",{items:[]})'),/Shared catalog network connection failed \(images\)/);
  assert.ok(h.run('uploadCooldownUntil')>=Date.now()+4800);
  assert.ok(h.run('nextUploadAt')>=h.run('uploadCooldownUntil'));
  h.context.fetch=async()=>new Response(JSON.stringify({ok:true}),{status:200});
  await h.run('postCatalog("images",{items:[]})');
  assert.equal(h.run('catalogStatus.lastError'),'');
});

test('rate-limit and server Retry-After delays remain authoritative', async () => {
  const h=await harness();
  assert.equal(h.run('ISSRetryPolicy.delay({status:429,retryAfterMs:900000})'),900000);
  assert.equal(h.run('ISSRetryPolicy.delay({status:503,retryAfterMs:120000})'),120000);
  for(const status of [400,401,403,404,409]) assert.equal(h.run(`ISSRetryPolicy.isTransient({status:${status},message:'Failed to fetch'})`),false);
  assert.equal(h.run('ISSRetryPolicy.isTransient(new Error("Invalid record"))'),false);
});

test('upgrade recovers only connection-failed runs on unchanged open tabs', async () => {
  const first=await harness();installRun(first);await first.run('persistState()');
  const initial=structuredClone(first.storage);
  for(const reason of ['upload-error','feed-error','user','source-tab-closed']) {
    const saved=structuredClone(initial);Object.assign(saved[key].runs[0].status,{running:false,scanning:false,stopped:true,stopReason:reason,lastError:'Failed to fetch'});
    const h=await harness(saved);
    assert.equal(h.run('sessions.get(7).status.running'),['upload-error','feed-error'].includes(reason));
    assert.equal(h.run('sessions.get(7).preparedRecords["55"].prompt'),record.prompt);
  }
  const denied=structuredClone(initial);Object.assign(denied[key].runs[0].status,{running:false,scanning:false,stopped:true,stopReason:'feed-error',lastError:'Civitai returned HTTP 403.'});
  assert.equal((await harness(denied)).run('sessions.get(7).status.running'),false);
  const moved=structuredClone(initial);Object.assign(moved[key].runs[0].status,{running:false,scanning:false,stopped:true,stopReason:'upload-error',lastError:'Failed to fetch'});
  assert.equal((await harness(moved,{tabs:[{id:7,url:'https://civitai.com/images'}]})).run('sessions.get(7).status.running'),false);
});

test('manual Stop during retry remains stopped and preserves the queued record', async () => {
  const h=await harness();installRun(h);
  h.run('syncCloudCatalogItems=async()=>{throw new TypeError("Failed to fetch")};');
  await assert.rejects(h.run('ensureManualSubmission(sessions.get(7),fixtureRecord)'));
  await h.run('stopSession(7,"user")');
  await h.run('collectionClockPulse()');
  assert.equal(h.run('sessions.get(7).status.running'),false);
  assert.equal(h.run('sessions.get(7).status.stopReason'),'user');
  assert.equal(h.run('sessions.get(7).preparedRecords["55"].prompt'),record.prompt);
});

test('reaction submission and page lookup queues retry connections after five seconds', async () => {
  for(const kind of ['updates','pages']) {
    let now=100000,calls=0,fail=true;
    const context=vm.createContext({URL});
    for(const file of ['retry-policy.js',kind==='updates'?'source-reactions-queue.js':'reaction-page-queue.js'])
      vm.runInContext(fs.readFileSync(new URL('../'+file,import.meta.url),'utf8'),context);
    const request=async()=>{calls++;if(fail)throw new TypeError('Failed to fetch');return kind==='updates'?{accepted:1,updated:1,missingIds:[]}:{likeCount:2}};
    const factory=kind==='updates'?context.ISSSourceReactions:context.ISSReactionPages;
    const queue=factory.create({now:()=>now,load:async()=>null,save:async()=>{},setTimer:()=>1,clearTimer:()=>{},
      post:request,read:request,observe:async()=>{}});
    await queue.initialized;
    if(kind==='updates')await queue.observe('55',{likeCount:2});else await queue.enqueue({id:'55',tabId:7,pageUrl});
    await queue.flush();assert.equal(calls,1);assert.equal(queue.snapshot().queued,1);
    now+=4999;await queue.flush();assert.equal(calls,1);
    now++;fail=false;await queue.flush();assert.equal(calls,2);assert.equal(queue.snapshot().queued,0);
  }
});
