import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../offscreen.js',import.meta.url),'utf8');
const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
function harness(){
 const timers=new Map(),requests=[];let worker,id=0;
 const context={Worker:class{constructor(){worker=this;}terminate(){}},
  chrome:{runtime:{sendMessage:message=>new Promise((resolve,reject)=>requests.push({message,resolve,reject}))}},
  setTimeout(fn,ms){timers.set(++id,{fn,ms});return id;},clearTimeout(key){timers.delete(key);},addEventListener(){}};
 vm.runInNewContext(source,context);
 return {requests,timers,pulse:()=>worker.onmessage(),timeout(){const entry=[...timers].find(([,v])=>v.ms===5000);assert.ok(entry,'a heartbeat must have a deadline');timers.delete(entry[0]);entry[1].fn();}};
}
test('an unanswered heartbeat releases its slot and the next pulse retries',async()=>{
 const h=harness();await flush();assert.equal(h.requests.length,1);
 await h.pulse();assert.equal(h.requests.length,1);
 h.timeout();await flush();h.pulse();await flush();assert.equal(h.requests.length,2);
 h.requests[1].resolve({ok:true});await flush();assert.equal(h.timers.size,0);
});
test('a late reply from an expired heartbeat cannot release a newer in-flight heartbeat',async()=>{
 const h=harness();await flush();h.timeout();await flush();h.pulse();await flush();
 h.requests[0].resolve({ok:true});await flush();await h.pulse();assert.equal(h.requests.length,2);
 h.requests[1].resolve({ok:true});await flush();h.pulse();await flush();assert.equal(h.requests.length,3);
 h.requests[2].reject(new Error('worker restarted'));await flush();assert.equal(h.timers.size,0);
});
