import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../server/public/access-gate.js',import.meta.url),'utf8');
const code=source.slice(source.indexOf('  async function protectedFetch('),source.indexOf('  function ensureAccess('));
function harness(mode='pending') {
  const timers=new Map(),requests=new Set();let sequence=0,calls=0;
  const context={URL,Response,TextDecoder,AbortController,Error,generation:1,requests,location:{href:'https://search-civitai.xyz/',origin:'https://search-civitai.xyz'},
    isVerified:()=>true,accessError:()=>Object.assign(new Error('Verify'),{name:'AccessRequiredError'}),lock(){},
    setTimeout(fn,ms){const id=++sequence;timers.set(id,{fn,ms});return id;},clearTimeout(id){timers.delete(id);},
    fetch:async(_url,{signal})=>{calls++;const pending=()=>new Promise((_,reject)=>{const abort=()=>reject(Object.assign(new Error('abort'),{name:'AbortError'}));if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});});
      if(mode==='body')return {status:200,arrayBuffer:pending};
      if(mode==='success')return new Response('{"ok":true}',{status:200});
      return pending();}};
  vm.createContext(context);vm.runInContext(code,context);
  return{context,timers,requests,get calls(){return calls;},run:(options={})=>context.protectedFetch('api.php?action=search',options),expire(){const[id,t]=timers.entries().next().value;assert.equal(t.ms,60000);timers.delete(id);t.fn();}};
}
test('search deadline raises a visible error and clears pending state',async()=>{
  const h=harness();const pending=h.run();h.expire();await assert.rejects(pending,{name:'RequestTimeoutError',message:/60 seconds/});assert.equal(h.requests.size,0);assert.equal(h.timers.size,0);
});
test('deadline also covers a stalled response body',async()=>{
  const h=harness('body');const pending=h.run();await Promise.resolve();h.expire();await assert.rejects(pending,{name:'RequestTimeoutError'});assert.equal(h.requests.size,0);
});
test('user navigation remains a silent cancellation',async()=>{
  const h=harness(),controller=new AbortController();const pending=h.run({signal:controller.signal});controller.abort();await assert.rejects(pending,{name:'AbortError'});assert.equal(h.timers.size,0);
});
test('successful searches clear their deadline',async()=>{
  const h=harness('success');assert.deepEqual(await(await h.run()).json(),{ok:true});assert.equal(h.timers.size,0);assert.equal(h.requests.size,0);
});
test('deadline never bypasses verification or origin protection',async()=>{
  const h=harness();h.context.isVerified=()=>false;await assert.rejects(h.run(),{name:'AccessRequiredError'});assert.equal(h.calls,0);assert.equal(h.timers.size,0);
  h.context.isVerified=()=>true;await assert.rejects(h.context.protectedFetch('https://invalid.example/'),/Only library/);assert.equal(h.calls,0);
});
