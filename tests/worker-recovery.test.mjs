import test from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './background-harness.mjs';
const key='aiImageDatasetScraperStateV6';
const flush=async()=>{for(let i=0;i<100;i++)await Promise.resolve();};
const config={civitaiPromptCloud:{apiBase:'https://search-civitai.xyz/api.php',autoBrowse:false}};
function savedRun(){return {version:3,sessionTabId:7,settings:{serverCopies:true,pageUrl:'https://civitai.red/models/99'},
 status:{running:true,scanning:true,stopped:false},catalogSyncedIds:['100'],catalogIds:['100'],catalogDiscoveredIds:['100','101'],
 outstandingIds:['101'],preparedRecords:{'101':{id:'101',prompt:'landscape fixture',downloadUrl:'https://image.civitai.com/key/test/original=true/101.jpg'}},
 feed:{site:'civitai',pageUrl:'https://civitai.red/models/99',endpoint:'image.getInfinite',filters:{modelId:99},cursor:'saved-cursor',pages:22,done:false}};}
test('launcher health and heartbeat acknowledge while saved-state loading is stalled',async()=>{
 let release;
 const h=await harness(config,{awaitReady:false,setupContext:ctx=>{
  const get=ctx.chrome.storage.local.get;
  ctx.chrome.storage.local.get=(name,cb)=>name===key ? release=()=>cb({}):get(name,cb);
 }});
 const health=await h.extensionMessage({type:'getWorkerHealth'});
 assert.equal(health.ok,true);assert.equal(health.phase,'restoring');
 const pulse=await h.message({type:'driverPulse'},{id:'test-extension',url:'chrome-extension://test-extension/offscreen.html'});
 assert.equal(pulse.ok,false);assert.equal(pulse.phase,'restoring');
 release();await h.run('ready');assert.equal((await h.extensionMessage({type:'getWorkerHealth'})).phase,'ready');
});
test('worker health is restricted to this extension UI',async()=>{
 const h=await harness(config);
 assert.equal((await h.message({type:'getWorkerHealth'},{id:'other-extension',url:'chrome-extension://test-extension/popup.html'})).ok,false);
 assert.equal((await h.message({type:'getWorkerHealth'})).ok,false);
});
test('an older clock-error pause resumes on the same tab without resetting saved work',async()=>{
 const run=savedRun();run.status={running:false,scanning:false,stopped:true,stopReason:'clock-error',lastError:'temporary renderer failure'};
 const h=await harness({...config,[key]:{version:3,runs:[run]}});
 assert.equal(h.run('sessions.get(7).status.running'),true);assert.equal(h.run('sessions.get(7).status.stopped'),false);
 assert.equal(h.run('sessions.get(7).feed.cursor'),'saved-cursor');assert.equal(h.run('sessions.get(7).outstandingIds[0]'),'101');
 run.status.stopReason='user';const paused=await harness({...config,[key]:{version:3,runs:[run]}});
 assert.equal(paused.run('sessions.get(7).status.running'),false);
});
test('large saved counters restore alongside queued prompts without resetting totals',async()=>{
 const run=savedRun();run.status.running=false;run.status.scanning=false;
 run.catalogSyncedIds=run.catalogIds=run.catalogDiscoveredIds=run.catalogProcessedIds=Array.from({length:70000},(_,i)=>String(i+1000));
 const h=await harness({...config,[key]:{version:3,runs:[run]}});
 assert.equal(h.run('sessions.get(7).catalogSyncedIds.length'),70000);
 assert.equal(h.run('sessions.get(7).preparedRecords["101"].prompt'),'landscape fixture');
 assert.equal(h.storage[key].runs[0].historyLengths.catalogSyncedIds,70000);
 assert.equal(h.storage[key].runs[0].catalogSyncedIds.length,0);
 const again=await harness(structuredClone(h.storage));
 assert.equal(again.run('sessions.get(7).catalogSyncedIds.length'),70000);
 assert.equal(again.run('sessions.get(7).preparedRecords["101"].prompt'),'landscape fixture');
});
test('a failed clock setup preserves active scans and an alarm repairs the clock',async()=>{
 let fail=true,creates=0,exists=false;
 const h=await harness({...config,[key]:{version:3,runs:[savedRun()]}},{setupContext:ctx=>{
  ctx.chrome.tabs.query=(_,cb)=>cb([{id:7,url:'https://civitai.red/models/99'}]);
  ctx.chrome.runtime.getContexts=async()=>exists?[{}]:[];
  ctx.chrome.offscreen.createDocument=async()=>{creates++;if(fail)throw new Error('temporary renderer failure');exists=true;};
  ctx.chrome.scripting.executeScript=async()=>[];
 }});
 await flush();assert.equal(h.run('sessions.get(7).status.running'),true);assert.equal(exists,false);
 h.run('collectionClockPulse=()=>{}');fail=false;
 await h.emit('alarm',{name:'civitai-auto-browse'});await h.run('clockTasks.get("ticker-recovery")');
 assert.equal(exists,true);assert.equal(creates,2);
 assert.equal(h.run('sessions.get(7).feed.cursor'),'saved-cursor');
 assert.equal(h.run('sessions.get(7).preparedRecords["101"].prompt'),'landscape fixture');
 assert.equal(h.storage[key].runs[0].status.running,true);
});
test('the offscreen clock starts before a frozen gallery injection and that injection has a deadline',async()=>{
 const h=await harness(config);let exists=false,created=0;const timers=new Map();let serial=0;
 h.context.chrome.tabs.query=(_,cb)=>cb([...h.tabs.values()]);
 h.context.chrome.runtime.getContexts=async()=>exists?[{}]:[];
 h.context.chrome.offscreen.createDocument=async()=>{exists=true;created++;};
 h.context.chrome.scripting.executeScript=()=>{assert.equal(exists,true);return new Promise(()=>{});};
 h.context.setTimeout=(fn,delay)=>{timers.set(++serial,{fn,delay});return serial;};h.context.clearTimeout=id=>timers.delete(id);
 h.run('needsOffscreenTicker=async()=>true');
 const refresh=h.run('refreshAutoBrowseTabs()');await flush();assert.equal(created,1);
 const deadline=[...timers].find(([,v])=>v.delay===10000);assert.ok(deadline);
 timers.delete(deadline[0]);deadline[1].fn();await refresh;
});
