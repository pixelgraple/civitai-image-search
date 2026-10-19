import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../runtime-request.js',import.meta.url),'utf8');
function harness(){
 const timers=new Map();let callback, id=0;
 const chrome={runtime:{lastError:null,sendMessage:(_,cb)=>{callback=cb;}}};
 const context=vm.createContext({chrome,setTimeout(fn,ms){timers.set(++id,{fn,ms});return id;},clearTimeout(key){timers.delete(key);}});
 vm.runInContext(source,context);
 return {request:()=>context.ISSRuntimeRequest({type:'getState'}),timers,chrome,reply:value=>callback(value),expire:()=>[...timers.values()][0].fn()};
}
test('unanswered control requests time out and later requests can succeed',async()=>{
 const h=harness(),work=h.request();assert.equal([...h.timers.values()][0].ms,10000);
 h.expire();await assert.rejects(work,/10 seconds.*Saved queues/);assert.equal(h.timers.size,0);
 h.reply({ok:true,stale:true});const next=h.request();h.reply({ok:true});assert.equal((await next).ok,true);assert.equal(h.timers.size,0);
});
test('runtime errors and missing replies settle with useful errors',async()=>{
 const h=harness();const first=h.request();h.chrome.runtime.lastError={message:'Extension context invalidated'};h.reply();
 await assert.rejects(first,/context invalidated/);assert.equal(h.timers.size,0);
 h.chrome.runtime.lastError=null;const second=h.request();h.reply();assert.match((await second).error,/no response/);
});
