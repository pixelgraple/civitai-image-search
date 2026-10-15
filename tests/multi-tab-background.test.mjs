import test from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './background-harness.mjs';

const key='aiImageDatasetScraperStateV6';
const config={civitaiPromptCloud:{apiBase:'https://search-civitai.xyz/api.php',writeToken:'private-test-key'}};
const sender=(h,id)=>({url:h.tabs.get(id).url,tab:h.tabs.get(id),frameId:0});
function addTab(h,id,model=id) { h.tabs.set(id,{id,url:`https://civitai.red/models/${model}`}); }
function start(h,id,type='start') {
  const pageUrl=h.tabs.get(id).url, url=new URL('/api/trpc/image.getInfinite',pageUrl);
  url.searchParams.set('input',JSON.stringify({json:{modelId:Number(new URL(pageUrl).pathname.split('/').pop()),sort:'Newest',browsingLevel:1}}));
  return h.message({type,settings:{pageUrl},feedRequestUrls:[url.href]},sender(h,id));
}
const state=(h,id)=>JSON.parse(h.run(`JSON.stringify(getPublicState(${id}))`));
const aggregate=h=>JSON.parse(h.run('JSON.stringify(getPublicState())'));
// Feed cursors now advance after durable queuing; uploads drain independently.
const submissions=h=>h.run('Promise.all([...sessions.values()].flatMap(run => [...(manualSubmissionTasks.get(run)?.values() || [])]))');
function page(id,cursor='next-'+id) {
  const record={id:String(id),prompt:'safe landscape fixture',downloadUrl:`https://image.civitai.com/key/test/original=true/${id}.jpg`};
  return {items:[{url:record.downloadUrl}],catalogItems:[record],cursor,done:false};
}
function install(h) {
  h.context.nextFeed=async feed=>page(feed.filters.modelId);
  h.run('ISSFeed.next = (...args) => nextFeed(...args); PromptCatalogDB.forPromptCollection = async items => ({items,skippedIds:[]}); PromptCatalogDB.upsert = async items => items;');
  const calls=[];
  h.context.fetch=async (url,options)=>{
    const data=JSON.parse(options.body); calls.push({url,data,options});
    return new Response(JSON.stringify(url.endsWith('action=check')?{ok:true,items:data.imageIds.map(imageId=>({imageId,exists:false,needsDownload:true,downloadStatus:'unknown',sha256:''}))}:{ok:true,accepted:data.items.length,skipped:0}),{status:200});
  };
  return calls;
}

test('two Civitai tabs keep independent source filters, cursors, counters, and controls',async()=>{
  const h=await harness(config); addTab(h,8,101); const calls=install(h);
  assert.equal((await start(h,7)).ok,true); assert.equal((await start(h,8)).ok,true);
  assert.equal(aggregate(h).activeTabs,2);
  await h.run('driverPulse()');
  assert.equal(state(h,7).feed.cursor,'next-99'); assert.equal(state(h,8).feed.cursor,'next-101');
  await submissions(h);
  assert.equal(state(h,7).status.catalogSynced,1); assert.equal(state(h,8).status.catalogSynced,1);
  assert.equal(aggregate(h).status.catalogSynced,2);
  assert.equal(calls.length,2); assert.equal(h.started.length,0);
  await h.message({type:'stop'},sender(h,7));
  assert.equal(state(h,7).status.running,false); assert.equal(state(h,8).status.running,true);
  assert.equal(aggregate(h).activeTabs,1);
  assert.equal(h.storage[key].runs.length,2);
});

test('fresh install starts two independent scans with no key, configuration, or login step',async()=>{
  const h=await harness();addTab(h,8,101);const calls=install(h);
  assert.equal((await start(h,7)).ok,true);assert.equal((await start(h,8)).ok,true);
  await h.run('driverPulse()');
  await submissions(h);
  assert.equal(aggregate(h).activeTabs,2);assert.equal(aggregate(h).status.catalogSynced,2);
  assert.ok(calls.every(call=>call.options.headers.Authorization===undefined));
});

test('Stop all collection stops every feed and disables passive collection without losing cursors',async()=>{
  const h=await harness();addTab(h,8,101);install(h);
  await start(h,7);await start(h,8);await h.run('driverPulse()');
  assert.equal((await h.extensionMessage({type:'pauseAll'})).ok,true);
  assert.equal(aggregate(h).activeTabs,0);assert.equal(state(h,7).feed.cursor,'next-99');
  assert.equal(state(h,8).feed.cursor,'next-101');assert.equal(h.storage.civitaiPromptCloud.autoBrowse,false);
  assert.equal((await h.message({type:'civitai-auto-status'},sender(h,7))).enabled,false);
  assert.equal((await h.message({type:'pauseAll'},sender(h,7))).ok,false);
});

test('stopping a tab during a source read cancels only that tab and never submits its late response',async()=>{
  const h=await harness(config); addTab(h,8,101); const calls=install(h); let release;
  h.context.nextFeed=feed=>feed.filters.modelId===99?new Promise(resolve=>{release=resolve;}):Promise.resolve(page(101));
  await start(h,7); await start(h,8);
  const scanning=h.run('driverPulse()'); await h.flush();
  assert.equal(typeof release,'function');
  await h.message({type:'stop'},sender(h,7)); release(page(99)); await scanning;
  await submissions(h);
  assert.equal(state(h,7).status.catalogSynced,0); assert.equal(state(h,8).status.catalogSynced,1);
  assert.equal(state(h,8).status.running,true);
  assert.ok(calls.every(call=>!JSON.stringify(call.data).includes('"99"')));
});

test('a source tab cannot start or stop a different tab or change contributor settings',async()=>{
  const h=await harness(config); addTab(h,8); install(h); await start(h,8);
  assert.equal((await h.message({type:'stop',tabId:8},sender(h,7))).ok,false);
  assert.equal((await h.message({type:'start',tabId:8},sender(h,7))).ok,false);
  assert.equal((await h.message({type:'saveConfig',writeToken:'stolen'},sender(h,7))).ok,false);
  assert.equal(state(h,8).status.running,true);
  assert.equal(h.storage.accessLevel,'TRUSTED_CONTEXTS');
  assert.ok(!JSON.stringify(await h.message({type:'getConfig'},sender(h,7))).includes('private-test-key'));
  assert.ok(!JSON.stringify(await h.message({type:'getState'},sender(h,7))).includes('private-test-key'));
});

test('source work uses at most three parallel feeds while all tabs retain their own queue',async()=>{
  const h=await harness(config); install(h); const releases=[]; let concurrent=0,peak=0;
  h.context.nextFeed=feed=>new Promise(resolve=>{peak=Math.max(peak,++concurrent);releases.push(()=>{concurrent--;resolve(page(feed.filters.modelId));});});
  for (const id of [7,8,9,10,11]) { if(id!==7)addTab(h,id); await start(h,id); }
  const first=h.run('driverPulse()'); await h.flush();
  assert.equal(releases.length,3); await h.run('driverPulse()'); assert.equal(releases.length,3);
  for(const release of releases.splice(0))release(); await first;
  const second=h.run('driverPulse()'); await h.flush(); assert.equal(releases.length,2);
  for(const release of releases.splice(0))release(); await second;
  await submissions(h);
  assert.equal(peak,3); assert.equal(aggregate(h).status.catalogSynced,5); assert.equal(aggregate(h).activeTabs,5);
});

test('duplicate checks and record uploads use independent serial lanes with paced upload batches',async()=>{
  const h=await harness(config); install(h);
  const inFlight={check:0,images:0},peak={check:0,images:0},calls=[];
  h.run('uploadIntervalMs = 20');
  h.context.fetch=async(url,options)=>{
    const action=new URL(url).searchParams.get('action'),body=JSON.parse(options.body);
    peak[action]=Math.max(peak[action],++inFlight[action]);
    const call={action,body,startedAt:Date.now()};calls.push(call);
    await new Promise(resolve=>setTimeout(resolve,5));inFlight[action]--;call.finishedAt=Date.now();
    return new Response(JSON.stringify(action==='check'?{ok:true,items:body.imageIds.map(imageId=>({imageId,exists:false,needsDownload:true,sha256:'',downloadStatus:'unknown'}))}:{ok:true,accepted:body.items.length,skipped:0}),{status:200});
  };
  await Promise.all([h.run(`syncCloudCatalogItems(${JSON.stringify(Array.from({length:100},(_,index)=>page(index+1).catalogItems[0]))})`),h.run(`syncCloudCatalogItems(${JSON.stringify(Array.from({length:21},(_,index)=>page(index+101).catalogItems[0]))})`)]);
  assert.deepEqual(peak,{check:1,images:1});
  const checks=calls.filter(call=>call.action==='check'),uploads=calls.filter(call=>call.action==='images');
  assert.deepEqual(checks.map(call=>call.body.imageIds.length),[100,21],'duplicate checks coalesce separately into up to100 IDs');
  assert.ok(uploads.every(call=>call.body.items.length>0&&call.body.items.length<=60),'record uploads have a60-record maximum with partial batches allowed');
  assert.deepEqual(uploads.flatMap(call=>call.body.items.map(item=>Number(item.id))).sort((a,b)=>a-b),Array.from({length:121},(_,index)=>index+1));
  for(let index=1;index<uploads.length;index++)assert.ok(uploads[index].startedAt-uploads[index-1].finishedAt>=19,'upload rest is measured after the previous upload finishes');
});

test('early duplicate-check rate limiting preserves the unread source cursor and shares its cooldown',async()=>{
  const h=await harness(config); install(h);let metadataReads=0;
  h.context.nextFeed=async(_feed,_request,_queue,progress)=>{
    await progress({phase:'metadata',ids:['99'],completed:0,total:1});
    await progress({phase:'metadata-admit',id:'99'});
    metadataReads++;return page(99);
  };
  h.context.fetch=async()=>new Response('{}',{status:429,headers:{'Retry-After':'75'}});
  await start(h,7); await h.run('driverPulse()');
  assert.equal(state(h,7).status.running,true); assert.equal(state(h,7).feed.cursor,null);
  assert.equal(metadataReads,0);assert.deepEqual(h.storage[key].runs[0].preparedRecords,{});
  assert.ok(h.run('nextUploadAt')>=Date.now()+74000);
  assert.ok(h.storage[key].runs[0].feed.retryAt>=Date.now()+74000);
});

test('record-upload rate limiting retains prepared records after durable cursor advancement',async()=>{
  const h=await harness(config);install(h);const actions=[];
  h.context.fetch=async(url,options)=>{
    const action=new URL(url).searchParams.get('action');actions.push(action);
    if(action==='images')return new Response('{}',{status:429,headers:{'Retry-After':'75'}});
    const {imageIds}=JSON.parse(options.body);
    return new Response(JSON.stringify({ok:true,items:imageIds.map(imageId=>({imageId,exists:false,needsDownload:true,downloadStatus:'unknown',sha256:''}))}));
  };
  await start(h,7);await h.run('driverPulse()');
  await assert.rejects(submissions(h),/HTTP 429/);await h.persist();
  assert.deepEqual(actions,['check','images']);assert.equal(state(h,7).status.running,true);
  assert.equal(state(h,7).feed.cursor,'next-99');assert.equal(state(h,7).status.catalogSynced,0);
  assert.equal(h.storage[key].runs[0].preparedRecords['99'].prompt,'safe landscape fixture');
  assert.ok(h.storage[key].runs[0].uploadRetryAt>=Date.now()+74000);
  assert.equal(h.storage[key].runs[0].feed.retryAt,0);assert.ok(h.run('nextUploadAt')>=Date.now()+74000);
});

test('browser restart restores matching source tabs and parks replaced tab IDs safely',async()=>{
  const h=await harness(config); addTab(h,8,101); install(h); await start(h,7);await start(h,8);await h.run('driverPulse()');
  const saved=structuredClone(h.storage);
  const orphan=saved[key].runs.find(run=>run.sessionTabId===7);
  orphan.catalogSyncedIds=[];orphan.preparedRecords={'99':page(99).catalogItems[0]};
  orphan.outstandingIds=['99','199','299'];orphan.feed.cursor='unfinished-page-99';
  const restored=await harness(saved,{tabs:[{id:7,url:'https://civitai.red/models/500'},{id:8,url:'https://civitai.red/models/101'},{id:40,url:'https://civitai.red/models/99'}]});install(restored);
  assert.equal(state(restored,7).status.running,false);assert.equal(state(restored,8).status.running,true);
  const parked=restored.storage[key].runs.find(run=>run.sessionTabId===7);
  assert.deepEqual(parked.outstandingIds,['99']);assert.equal(parked.preparedRecords['99'].prompt,'safe landscape fixture');
  assert.equal(restored.run('outstandingImages.has("199") || outstandingImages.has("299")'),false);
  assert.equal(restored.run('outstandingImages.get("99").owners.has("manual:7")'),true);
  assert.equal((await restored.message({type:'getState'},sender(restored,40))).canResume,true);
  assert.equal((await start(restored,40,'resume')).ok,true);
  assert.equal(state(restored,40).feed.cursor,'unfinished-page-99');assert.equal(state(restored,8).feed.cursor,'next-101');
  assert.equal(restored.run('sessions.get(40).preparedRecords["99"].prompt'),'safe landscape fixture');
  assert.equal(restored.run('sessions.has(7)'),false);
});

test('two tabs cannot claim the same orphaned saved scan concurrently',async()=>{
  const h=await harness(config);install(h);await start(h,7);await h.run('driverPulse()');
  const restored=await harness(structuredClone(h.storage),{tabs:[{id:40,url:'https://civitai.red/models/99'},{id:41,url:'https://civitai.red/models/99'}]});install(restored);
  const results=await Promise.all([start(restored,40,'resume'),start(restored,41,'resume')]);
  assert.equal(results.filter(result=>result.ok).length,1);assert.equal(aggregate(restored).activeTabs,1);
});

test('a paused scan in an open tab is not borrowed by a second tab with the same URL',async()=>{
  const h=await harness(config);install(h);addTab(h,8,99);await start(h,7);await h.message({type:'stop'},sender(h,7));
  assert.equal((await h.message({type:'getState'},sender(h,8))).canResume,false);
  assert.equal((await start(h,8,'resume')).ok,false);
  assert.equal((await start(h,8)).ok,true);
});

test('Stop cancels a pending Start for only the calling tab',async()=>{
  const h=await harness(config);install(h);let release;
  h.context.chrome.runtime.getContexts=async()=>[];
  h.context.chrome.offscreen.createDocument=()=>new Promise(resolve=>{release=resolve;});
  const starting=start(h,7);await h.flush();assert.equal(typeof release,'function');
  const stopping=h.message({type:'stop'},sender(h,7));release();await stopping;
  assert.equal((await starting).ok,false);assert.equal(aggregate(h).activeTabs,0);
});

test('page navigation and closed tabs leave other source scans running',async()=>{
  const h=await harness(config);install(h);addTab(h,8);await start(h,7);await start(h,8);
  h.context.preparedSeven=page(7001).catalogItems[0];h.context.preparedEight=page(8001).catalogItems[0];
  h.run(`for (const [tabId,prepared,unread,record] of [[7,'7001','7002',preparedSeven],[8,'8001','8002',preparedEight]]) {
    const run=sessions.get(tabId);run.outstandingIds=[prepared,unread];run.preparedRecords[prepared]=record;
    reserveOutstanding(prepared,'manual',tabId,'readyUpload');reserveOutstanding(unread,'manual',tabId,'waitingMetadata');
  }`);
  await h.run('persistState()');
  h.tabs.get(7).url='https://civitai.red/models/500';
  await h.emit('tabUpdated',7,{url:h.tabs.get(7).url},h.tabs.get(7));
  assert.equal(state(h,7).status.running,false);assert.equal(state(h,8).status.running,true);
  assert.deepEqual(h.storage[key].runs.find(run=>run.sessionTabId===7).outstandingIds,['7001']);
  assert.equal(h.run('outstandingImages.has("7002")'),false);assert.equal(h.run('outstandingImages.has("8002")'),true);
  h.tabs.delete(8);await h.emit('tabRemoved',8);assert.equal(aggregate(h).activeTabs,0);
  assert.deepEqual(h.storage[key].runs.find(run=>run.sessionTabId===8).outstandingIds,['8001']);
  assert.equal(h.run('outstandingImages.has("8002")'),false);
  assert.equal(h.run('sessions.get(7).preparedRecords["7001"].prompt'),'safe landscape fixture');
  assert.equal(h.run('sessions.get(8).preparedRecords["8001"].prompt'),'safe landscape fixture');
});

test('turning passive browsing off preserves manual tabs and obsolete download commands remain rejected',async()=>{
  const h=await harness(config);install(h);addTab(h,8);await start(h,7);await start(h,8);
  assert.equal((await h.extensionMessage({type:'saveConfig',writeToken:'',autoBrowse:false})).ok,true);
  assert.equal(aggregate(h).activeTabs,2);
  assert.equal((await h.message({type:'civitai-auto-status'},sender(h,7))).enabled,false);
  for(const type of ['enqueue','catalogDownload','exportCsv','download'])assert.equal((await h.message({type},sender(h,7))).ok,false);
  assert.equal(h.started.length,0);
});

test('legacy local-download state migrates to a paused server-only cursor without reviving file queues',async()=>{
  const h=await harness(config);install(h);await start(h,7);
  const legacy=structuredClone(h.storage[key].runs[0]);legacy.version=1;legacy.settings.serverCopies=false;
  legacy.queue=[{url:'https://image.civitai.com/key/test/original=true/99.jpg',status:'pending'}];
  const restored=await harness({...config,[key]:legacy});install(restored);
  assert.equal(state(restored,7).status.running,false);assert.equal(state(restored,7).settings.serverCopies,true);
  assert.equal(state(restored,7).canResume,true);assert.deepEqual(state(restored,7).queue,[]);
  assert.equal(restored.started.length,0);assert.equal((await start(restored,7,'resume')).ok,true);
});

test('untrusted origins and Civitai subframes cannot invoke extension controls',async()=>{
  const h=await harness(config);
  for(const source of [{url:'https://evil.example',tab:{id:7,url:'https://evil.example'},frameId:0},{...sender(h,7),frameId:1}]) {
    assert.equal((await h.message({type:'getConfig'},source)).ok,false);
    assert.equal((await h.message({type:'stop'},source)).ok,false);
  }
});

test('a paused tab navigation makes recovery available until that source page returns',async()=>{
  const h=await harness(config);install(h);addTab(h,8,99);await start(h,7);await h.message({type:'stop'},sender(h,7));
  h.tabs.get(7).url='https://civitai.red/models/500';await h.emit('tabUpdated',7,{url:h.tabs.get(7).url},h.tabs.get(7));
  assert.equal((await h.message({type:'getState'},sender(h,8))).canResume,true);
  h.tabs.get(7).url='https://civitai.red/models/99';await h.emit('tabUpdated',7,{url:h.tabs.get(7).url},h.tabs.get(7));
  assert.equal((await h.message({type:'getState'},sender(h,8))).canResume,false);
});

test('offscreen heartbeat acknowledges a slow feed while other tabs observe without scrolling', async () => {
  const h = await harness(); addTab(h, 8); install(h);
  let release, entered; const started = new Promise(resolve => { entered = resolve; });
  h.context.nextFeed = () => new Promise(resolve => { entered(); release = resolve; });
  const pulses = [];
  h.context.chrome.tabs.query = (_query, callback) => callback([...h.tabs.values()]);
  h.context.chrome.tabs.sendMessage = async (tabId, message) => { if (message.type === 'civitai-auto-pulse') pulses.push({ tabId, status: message.status }); };
  await start(h, 7);
  h.run('nextAutoTabPulseAt = 0');
  const response = await h.message({ type: 'driverPulse' }, { url: 'chrome-extension://test-extension/offscreen.html' });
  assert.equal(response.ok, true); await started;
  await h.run('clockTasks.get("scroll")');
  assert.equal(pulses.some(pulse => pulse.tabId === 8 && pulse.status.scrollAllowed), false);
  assert.equal(pulses.some(pulse => pulse.tabId === 7 && pulse.status.manualPaused), true);
  const before = pulses.filter(pulse => pulse.tabId === 8).length;
  h.run('nextAutoTabPulseAt = 0'); await h.message({ type: 'driverPulse' }, { url: 'chrome-extension://test-extension/offscreen.html' });
  await h.run('clockTasks.get("scroll")');
  assert.equal(pulses.filter(pulse => pulse.tabId === 8).length, before + 1);
  release(page(99)); await h.flush(); await new Promise(resolve => setTimeout(resolve, 0));
});

test('enabled automatic tabs keep an offscreen clock without a manual scan; disable closes it', async () => {
  const h = await harness(); let exists = false, creates = 0, closes = 0;
  h.context.chrome.tabs.query = (_query, callback) => callback([...h.tabs.values()]);
  h.context.chrome.runtime.getContexts = async () => exists ? [{}] : [];
  h.context.chrome.offscreen.createDocument = async () => { exists = true; creates++; };
  h.context.chrome.offscreen.closeDocument = async () => { exists = false; closes++; };
  await h.run('reconcileOffscreenTicker()');
  assert.equal(creates, 1); assert.equal(aggregate(h).activeTabs, 0);
  await h.extensionMessage({ type: 'saveConfig', autoBrowse: false });
  assert.equal(exists, false); assert.equal(closes, 1);
});

test('Stop tab pauses automatic collection; passive resume does not authorize scrolling', async () => {
  const h = await harness(); addTab(h, 8); install(h);
  assert.equal((await h.message({ type: 'stop' }, sender(h, 7))).ok, true);
  let stopped = await h.message({ type: 'civitai-auto-status' }, sender(h, 7));
  assert.equal(stopped.tabPaused, true); assert.equal(stopped.scrollAllowed, false);
  assert.equal((await h.message({ type: 'civitai-auto-status' }, sender(h, 8))).scrollAllowed, false);
  assert.equal((await h.message({ type: 'civitai-auto-resume-tab' }, sender(h, 7))).ok, true);
  stopped = await h.message({ type: 'civitai-auto-status' }, sender(h, 7));
  assert.equal(stopped.tabPaused, false); assert.equal(stopped.scrollAllowed, false);
  await h.message({ type: 'stop' }, sender(h, 8)); await start(h, 7);
  assert.equal((await h.message({ type: 'civitai-auto-status' }, sender(h, 8))).tabPaused, true);
});

test('global Stop all remains off after worker restart and tab resume cannot silently reenable it', async () => {
  const h = await harness(); await h.extensionMessage({ type: 'pauseAll' });
  const restored = await harness(structuredClone(h.storage));
  const status = await restored.message({ type: 'civitai-auto-status' }, sender(restored, 7));
  assert.equal(status.enabled, false); assert.equal(status.scrollAllowed, false);
  const resumed = await restored.message({ type: 'civitai-auto-resume-tab' }, sender(restored, 7));
  assert.equal(resumed.ok, false); assert.match(resumed.error, /Turn on automatic browsing/);
});

test('source cooldown and source auth pause block automatic scrolling with live reason and retry time', async () => {
  const h = await harness();
  h.context.sourceStatus = { authStatus: 0, blockedUntil: Date.now() + 120000, pauseReason: 'Civitai asked us to wait.' };
  h.run('getCivitaiSourceRequestState = async () => sourceStatus');
  const cooldown = await h.message({ type: 'civitai-auto-status' }, sender(h, 7));
  assert.equal(cooldown.sourcePaused, true); assert.equal(cooldown.scrollAllowed, false);
  assert.ok(cooldown.retryAt > Date.now()); assert.match(cooldown.phase, /cooldown/);
  h.context.sourceStatus = { authStatus: 403, blockedUntil: 0, pauseReason: 'Check the site.' };
  const rejected = await h.message({ type: 'civitai-auto-status' }, sender(h, 7));
  assert.equal(rejected.scrollAllowed, false); assert.equal(rejected.phase, 'Civitai needs attention');
});

test('a delayed source-status read cannot revive a tab stopped while its clock pulse was waiting', async () => {
  const h = await harness(); let release;
  h.context.sourceWait = new Promise(resolve => { release = resolve; });
  h.run('getCivitaiSourceRequestState = () => sourceWait');
  const pending = h.run('getBrowseStatus(7)'); await h.flush();
  await h.run('autoBrowseCollector.pauseTab(7)');
  release({ authStatus: 0, blockedUntil: 0 });
  const status = await pending;
  assert.equal(status.tabPaused, true); assert.equal(status.active, false); assert.equal(status.scrollAllowed, false);
});

test('manual metadata progress appears before server submission and stays scoped to its tab', async () => {
  const h = await harness(); addTab(h, 8); install(h);
  let release, entered; const started = new Promise(resolve => { entered = resolve; });
  h.context.nextFeed = async (_feed, _request, _queue, progress) => {
    await progress({ phase: 'metadata', completed: 0, total: 12 });
    await progress({ phase: 'metadata-complete', id: '99', completed: 1, total: 12 });
    entered(); await new Promise(resolve => { release = resolve; });
    for(let index=1;index<12;index++)await progress({phase:'metadata-complete',id:String(99+index),completed:index+1,total:12});
    return {...page(99),done:true};
  };
  await start(h, 7); const work = h.run('backgroundFeedPulse(7)'); await started;
  assert.equal(state(h, 7).status.processed, 1); assert.equal(state(h, 7).status.pending, 11);
  assert.equal(state(h, 7).status.submitted, 0); assert.ok(state(h, 7).status.lastActivityAt > 0);
  assert.equal(state(h, 8).status.processed, 0);
  release(); await work;
  await submissions(h);
  assert.equal(state(h, 7).status.submitted, 1); assert.equal(state(h, 7).status.pending, 0);assert.equal(state(h,7).status.processed,12);
});

test('a large passive backlog cannot freeze its selected scan or authorize another tab to scroll', async () => {
  const pending = Array.from({ length: 151 }, (_, index) => ({ tabId: 7, pageUrl: 'https://civitai.red/models/99',
    card: { id: String(index + 1), previewUrl: `https://image.civitai.com/key/test/width=450/${index + 1}.jpg` } }));
  const original = await harness(); install(original); await start(original, 7);
  const saved = structuredClone(original.storage);
  saved.civitaiBrowseCollectorV1 = { version: 1, publicMode: true, pending, seen: [], tabs: {}, pausedTabs: [] };
  const h = await harness(saved, { tabs: [{ id: 7, url: 'https://civitai.red/models/99' }, { id: 8, url: 'https://civitai.red/models/101' }] });
  install(h);
  const first = await h.message({ type: 'civitai-auto-status' }, sender(h, 7));
  const other = await h.message({ type: 'civitai-auto-status' }, sender(h, 8));
  assert.equal(first.pending, 151); assert.equal(first.manualPaused, true); assert.equal(first.scrollAllowed, true);
  assert.equal(other.pendingTotal, 151); assert.equal(other.pendingRunnableTotal, 0); assert.equal(other.scrollAllowed, false);
  await h.run('backgroundFeedPulse(7)');
  await submissions(h);
  assert.equal((await h.message({ type: 'civitai-auto-status' }, sender(h, 7))).pending, 150);
  assert.ok(h.storage.civitaiBrowseCollectorV1.seen.some(entry => entry.id === '99'));
});
