import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { IDBFactory } from 'fake-indexeddb';
const source=fs.readFileSync(new URL('../diagnostics.js',import.meta.url),'utf8');
const manifest=JSON.parse(fs.readFileSync(new URL('../manifest.json',import.meta.url)));
function setup(extra={}) {
  const ctx=vm.createContext({indexedDB:new IDBFactory(),setTimeout,clearTimeout,URL,chrome:{runtime:{getManifest:()=>manifest}},...extra});
  vm.runInContext(source,ctx);return {ctx,api:ctx.ISSDiagnostics};
}
test('logs survive new readers and concurrent contexts without overwriting events',async()=>{
  const {api}=setup(),a=api.create('launcher'),b=api.create('worker');
  await Promise.all([a.record('error','open','failed'),b.record('info','startup','started')]);
  const rows=await api.createStore().read();assert.equal(rows.length,2);
  assert.deepEqual(new Set(rows.map(r=>r.context)),new Set(['launcher','worker']));
});
test('journal is capped at 500 rows and expires old entries',async()=>{
  const {api}=setup(),store=api.createStore(),now=Date.now();
  await store.append([{...api.entry('worker','info','old','expired'),time:now-api.AGE-1000}]);
  for(let i=0;i<12;i++)await store.append(Array.from({length:60},(_,n)=>api.entry('worker','info','sample','item '+(i*60+n))));
  const rows=await store.read();assert.equal(rows.length,500);assert.equal(rows[0].message,'item 719');
  assert.ok(rows.every(row=>row.message!=='expired'));await store.clear();assert.equal((await store.read()).length,0);
});
test('redaction and detail allowlist remove credentials, bodies and URL query data',()=>{
  const {api}=setup();
  const row=api.entry('panel','error','failed',new Error('Failed https://civitai.com/images/12?token=private password=secret Bearer abcdef cookie: private'),
    {status:503,action:'images',body:{prompt:'private prompt'},prompt:'secret words',headers:{Cookie:'secret'}});
  const text=JSON.stringify(row);assert.doesNotMatch(text,/private|abcdef|secret|token=|prompt|Cookie/);
  assert.equal(row.details.status,503);assert.equal(row.details.action,'images');
  assert.ok(text.includes('redacted'));
});
test('duplicate and burst errors have bounded write work',async()=>{
  const {api}=setup();let now=1000000,writes=0;
  const log=api.create('worker',{now:()=>now,store:{append:async()=>{writes++;}}});
  for(let i=0;i<2000;i++)await log.record('error','request','same failure');
  assert.equal(writes,1);now+=31000;await log.record('error','request','same failure');assert.equal(writes,2);
  for(let i=0;i<500;i++)await log.record('error','request','different '+i);
  assert.ok(writes<=102);assert.ok(log.state().memory.length<=50);
});
test('blocked logging never rejects collection and retries only after its backoff',async()=>{
  const {api}=setup();let calls=0,now=1000000;
  const log=api.create('worker',{now:()=>now,store:{append:async()=>{calls++;throw new Error('disk blocked');}}});
  assert.equal(await log.record('error','first','failed'),false);
  assert.equal(await log.record('error','second','failed differently'),false);assert.equal(calls,1);
  assert.match(log.state().lastError,/disk blocked/);now+=61000;
  await log.record('error','third','retry');assert.equal(calls,2);
});
test('a stuck database open has a deadline and a late open is closed',async()=>{
  const timers=[],request={},db={closed:false,close(){this.closed=true;}};
  const {api}=setup({indexedDB:{open:()=>request},setTimeout:fn=>{timers.push(fn);return timers.length;},clearTimeout(){}});
  const reading=api.createStore().read();const rejected=assert.rejects(reading,/3 seconds/);
  timers[0]();await rejected;request.result=db;request.onsuccess();assert.equal(db.closed,true);
});
test('global exceptions are captured without swallowing the browser error',async()=>{
  const {api}=setup(),events={},saved=[];
  const log=api.create('launcher',{store:{append:async rows=>saved.push(...rows)}});
  log.install({addEventListener:(name,fn)=>events[name]=fn});
  events.error({error:new Error('mount failed'),lineno:42});events.unhandledrejection({reason:new Error('async failed')});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(saved.length,2);assert.equal(saved[0].details.line,42);
});
test('worker bootstrap logs import failures and offers health before collector initialization',async()=>{
  const listeners=[],{ctx,api}=setup();
  ctx.chrome.runtime.id='unit';ctx.chrome.runtime.getURL=p=>'chrome-extension://unit/'+p;
  ctx.chrome.runtime.onMessage={addListener:fn=>listeners.push(fn)};
  ctx.importScripts=name=>{if(name==='background.js')throw new Error('broken dependency');};
  vm.runInContext(fs.readFileSync(new URL('../worker.js',import.meta.url),'utf8'),ctx);
  let reply;listeners[1]({type:'getWorkerHealth'},{id:'unit',url:'chrome-extension://unit/diagnostics.html'},r=>reply=r);
  assert.equal(reply.phase,'error');assert.match(reply.error,/startup failed/);
  await new Promise(resolve=>setTimeout(resolve,30));assert.ok((await api.store().read()).some(row=>row.stage==='worker-import-failed'));
});
test('diagnostic relay rejects other extensions and non-Civitai pages',async()=>{
  const listeners=[],{ctx,api}=setup();ctx.chrome.runtime.id='unit';ctx.chrome.runtime.getURL=p=>'chrome-extension://unit/'+p;
  ctx.chrome.runtime.onMessage={addListener:fn=>listeners.push(fn)};ctx.importScripts=()=>{};
  vm.runInContext(fs.readFileSync(new URL('../worker.js',import.meta.url),'utf8'),ctx);
  for(const sender of [{id:'evil',url:'https://civitai.com/images',frameId:0},{id:'unit',url:'https://evil.test',frameId:0},{id:'unit',url:'https://civitai.com/images',frameId:2}]){
    let result;assert.equal(listeners[0]({type:'index-civitai-diagnostic',entry:{message:'forged'}},sender,r=>result=r),false);assert.equal(result.ok,false);
  }
  await new Promise(resolve=>setTimeout(resolve,20));assert.ok(!(await api.store().read()).some(row=>row.message==='forged'));
});
test('diagnostics remain a direct options page with no new permissions or log uploads',()=>{
  assert.equal(manifest.options_ui.page,'diagnostics.html');assert.equal(manifest.options_ui.open_in_tab,true);
  assert.equal(manifest.background.service_worker,'worker.js');
  assert.ok(!manifest.permissions.includes('downloads'));assert.ok(!manifest.permissions.includes('debugger'));
  const page=fs.readFileSync(new URL('../diagnostics-page.js',import.meta.url),'utf8');
  assert.doesNotMatch(page,/\.innerHTML|fetch\(|chrome\.downloads/);assert.match(page,/textContent/);
});
