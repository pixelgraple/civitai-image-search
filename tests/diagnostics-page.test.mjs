import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
const source=fs.readFileSync(new URL('../diagnostics-page.js',import.meta.url),'utf8');
const flush=async()=>{for(let i=0;i<60;i++)await Promise.resolve();};
class Element {
  constructor(){this.children=[];this.events={};this.value='all';this.textContent='';this.hidden=false;}
  append(...nodes){this.children.push(...nodes);} replaceChildren(){this.children=[];}
  addEventListener(name,fn){this.events[name]=fn;} focus(){} select(){} remove(){} click(){this.clicked=true;}
}
function harness({hang=false,copyFails=false}={}) {
  const elements=new Map(),get=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  const rows=[{time:Date.now(),version:'test',context:'worker',level:'error',stage:'import',message:'<img src=x onerror=alert(1)>',details:{}}];
  const recorded=[],timers=new Map(),messages=[],downloads=[];let serial=0,clears=0,copied='',workerReady=false;
  const store={read:async()=>rows.slice(),clear:async()=>{rows.length=0;clears++;}};
  const context={document:{getElementById:get,createElement:()=>new Element(),body:new Element(),hidden:false},
    ISSDiagnostics:{start:()=>({install(){},record:async(...args)=>{recorded.push(args);},state:()=>({memory:[]})}),store:()=>store,clean:String},
    chrome:{runtime:{getManifest:()=>({version:'test'}),lastError:null,sendMessage:(m,cb)=>{
      messages.push(m);if(hang&&!workerReady)return;
      cb(m.type==='getWorkerHealth'?{ok:true,phase:'ready',backgroundVersion:'test'}:{ok:true,counts:{outstanding:40,preparing:0,ready:40,sending:0,paused:0,activeTabs:1}});
    }}},navigator:{clipboard:{writeText:async t=>{if(copyFails)throw new Error('denied');copied=t;}}},
    setTimeout:(fn,ms)=>{timers.set(++serial,{fn,ms});return serial;},clearTimeout:id=>timers.delete(id),setInterval:()=>1,clearInterval(){},addEventListener(){},confirm:()=>true,
    URL:{createObjectURL:b=>{downloads.push(b);return 'blob:test';},revokeObjectURL(){}},Blob};
  vm.runInNewContext(source,context);
  return {get,recorded,messages,timers,rows,downloads,clears:()=>clears,copied:()=>copied,ready:()=>workerReady=true};
}
test('saved logs render immediately even while worker health is unanswered',async()=>{
  const h=harness({hang:true});await flush();assert.equal(h.get('events').children.length,1);
  assert.equal(h.get('events').children[0].children[1].textContent,'<img src=x onerror=alert(1)>');
  const [,t]=[...h.timers].find(([,t])=>t.ms===5000);t.fn();await flush();
  assert.match(h.get('workerStatus').textContent,/5 seconds/);assert.equal(h.get('checkWorker').disabled,false);
  assert.equal(h.recorded[0][1],'manual-health-check');
  h.ready();await h.get('checkWorker').events.click();await flush();assert.match(h.get('workerStatus').textContent,/Connected/);
});
test('copy report contains saved events and compact counts without running a collection',async()=>{
  const h=harness();await flush();await h.get('copy').events.click();
  const report=JSON.parse(h.copied());assert.equal(report.events.length,1);assert.equal(report.counts.ready,40);
  assert.deepEqual(h.messages.map(x=>x.type),['getWorkerHealth','getDiagnosticSnapshot']);
});
test('copy failure gives selectable report text and save creates a JSON artifact',async()=>{
  const h=harness({copyFails:true});await flush();await h.get('copy').events.click();assert.equal(h.get('manualCopy').hidden,false);
  assert.equal(JSON.parse(h.get('report').value).application,'Index Civitai');
  await h.get('download').events.click();assert.equal(h.downloads.length,1);assert.equal(h.downloads[0].type,'application/json');
});
test('clear removes only the dedicated journal and filtering is local',async()=>{
  const h=harness();await flush();h.get('level').value='warning';h.get('level').events.change();
  assert.equal(h.get('events').children[0].textContent,'No matching events yet.');
  await h.get('clear').events.click();assert.equal(h.clears(),1);assert.equal(h.rows.length,0);
  assert.ok(h.messages.every(m=>!m.type.startsWith('clear')));
});
