import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const manifest=JSON.parse(fs.readFileSync(new URL('../manifest.json',import.meta.url)));
const source=fs.readFileSync(new URL('../popup.js',import.meta.url),'utf8');
const flush=async()=>{for(let i=0;i<40;i++)await Promise.resolve();};
function harness(options={}) {
 const elements=new Map(),timers=new Map(),scripts=[],messages=[];let timerId=0,closed=0,restarted=0;
 const get=id=>{if(!elements.has(id))elements.set(id,{textContent:'',hidden:false,disabled:false,events:{},addEventListener(k,fn){this.events[k]=fn;}});return elements.get(id);};
 const chrome={runtime:{getManifest:()=>manifest,lastError:null,reload:()=>restarted++,sendMessage:(message,callback)=>{
  messages.push(message);if(options.worker)options.worker(callback);else callback({ok:true,backgroundVersion:manifest.version});
 }},tabs:{query:()=>options.query?options.query():Promise.resolve([{id:7,url:options.url||'https://civitai.com/images'}])},
 scripting:{executeScript:details=>{scripts.push(details);return options.inject?options.inject():Promise.resolve([{frameId:0,result:{ok:true,panelVersion:manifest.version}}]);}},
 action:{setBadgeText:async()=>{},setTitle:async()=>{}}};
 vm.runInNewContext(source,{chrome,document:{getElementById:get},window:{close:()=>closed++},URL,
  setTimeout(fn,ms){const id=++timerId;timers.set(id,{fn,ms});return id;},clearTimeout(id){timers.delete(id);}});
 return{get,timers,scripts,messages,closed:()=>closed,restarted:()=>restarted,
  timeout(ms){const pair=[...timers].find(([,t])=>t.ms===ms);assert.ok(pair,`Expected ${ms}ms timeout`);timers.delete(pair[0]);pair[1].fn();}};
}
test('manifest uses a browser-owned popup independent of the service-worker click listener',()=>{
 assert.equal(manifest.action.default_popup,'popup.html');
 const html=fs.readFileSync(new URL('../popup.html',import.meta.url),'utf8');
 assert.match(html,/src="popup.js" defer/);assert.match(html,/href="library.html"/);
 assert.ok(!html.includes('onclick='));
});
for(const host of ['civitai.com','civitai.red'])test(`launcher opens ${host} immediately without starting a scan`,async()=>{
 const h=harness({url:`https://${host}/images`});await flush();assert.equal(h.closed(),1);assert.equal(h.scripts.length,1);
 assert.equal(h.scripts[0].target.tabId,7);assert.equal(h.scripts[0].injectImmediately,true);
 assert.equal(h.scripts[0].files.at(-1),'panel.js');assert.deepEqual(h.messages.map(x=>x.type),['getSourceStatus']);assert.equal(h.timers.size,0);
});
for(const url of ['https://example.com/','https://civitai.com.evil.test/images','http://civitai.com/images','https://user@civitai.com/images','https://civitai.com:8443/images'])test(`launcher does not inject into ${url}`,async()=>{
 const h=harness({url});await flush();assert.equal(h.scripts.length,0);assert.equal(h.messages.length,0);assert.equal(h.closed(),0);assert.match(h.get('launcherStatus').textContent,/Open a civitai/);
});
test('failed injection displays its error and enables retry',async()=>{
 let fail=true;const h=harness({inject:()=>fail?Promise.reject(new Error('Page access denied')):Promise.resolve([{frameId:0,result:{ok:true,panelVersion:manifest.version}}])});
 await flush();assert.equal(h.closed(),0);assert.equal(h.get('launcherError').hidden,false);assert.match(h.get('launcherError').textContent,/Page access denied/);
 assert.equal(h.get('retry').disabled,false);fail=false;h.get('retry').events.click();await flush();assert.equal(h.closed(),1);assert.equal(h.timers.size,0);
});
test('a never-finishing injection ends visibly after eight seconds',async()=>{
 let finish;const h=harness({inject:()=>new Promise(resolve=>finish=resolve)});await flush();h.timeout(8000);await flush();
 assert.match(h.get('launcherError').textContent,/8 seconds/);assert.equal(h.get('retry').disabled,false);
 finish([{frameId:0,result:{ok:true,panelVersion:manifest.version}}]);await flush();assert.equal(h.closed(),0);assert.equal(h.messages.length,0);
});
test('a dead collector cannot prevent panel injection or leave a silent popup',async()=>{
 const h=harness({worker:()=>{}});await flush();assert.equal(h.scripts.length,1);h.timeout(5000);await flush();
 assert.match(h.get('launcherStatus').textContent,/panel opened.*collector is unavailable/i);assert.match(h.get('launcherError').textContent,/5 seconds/);
 assert.equal(h.get('restart').hidden,false);assert.equal(h.restarted(),0);assert.equal(h.closed(),0);
 h.get('restart').events.click();assert.equal(h.restarted(),1);
});
test('startup errors and stale worker versions remain visible',async()=>{
 for(const response of [{ok:false,error:'Could not restore saved state'},{ok:true,backgroundVersion:'0.0.1'}]){
  const h=harness({worker:cb=>cb(response)});await flush();assert.equal(h.closed(),0);assert.equal(h.get('launcherError').hidden,false);assert.equal(h.timers.size,0);
 }
});
test('an unresponsive active-tab query has its own deadline',async()=>{
 const h=harness({query:()=>new Promise(()=>{})});await flush();h.timeout(3000);await flush();assert.match(h.get('launcherError').textContent,/active tab/);assert.equal(h.get('retry').disabled,false);
});
test('repeated clicks while opening do not create duplicate injections',async()=>{
 let finish;const h=harness({inject:()=>new Promise(resolve=>finish=resolve)});await flush();h.get('retry').events.click();await flush();assert.equal(h.scripts.length,1);
 finish([{frameId:0,result:{ok:true,panelVersion:manifest.version}}]);await flush();assert.equal(h.closed(),1);
});
