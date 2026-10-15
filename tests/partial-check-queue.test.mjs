import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../catalog-check-queue.js',import.meta.url),'utf8');
const flush=async()=>{for(let i=0;i<100;i++)await Promise.resolve();};
const missing=id=>({imageId:id,exists:false,needsDownload:true,sha256:'',downloadStatus:'unknown'});
function harness(post){
  let now=10000,serial=0;const timers=new Map(),calls=[];
  const context=vm.createContext({Promise,Map,Set,Date,setTimeout,clearTimeout});vm.runInContext(source,context);
  const queue=context.ISSCatalogChecks.create({post:async ids=>{calls.push([...ids]);return post(ids,calls.length);},now:()=>now,
    setTimer:(fn,delay)=>{timers.set(++serial,{fn,at:now+delay});return serial;},clearTimer:id=>timers.delete(id)});
  return {queue,calls,validate:context.ISSCatalogChecks.validate,async advance(ms){now+=ms;for(const[id,timer]of[...timers])if(timer.at<=now&&timers.delete(id))timer.fn();await flush();}};
}
test('completed checks resolve immediately while only deferred IDs retry',async()=>{
  const h=harness((ids,n)=>n===1?{items:[missing('1')],deferredIds:['2'],retryAfterMs:2000}:{items:ids.map(missing)});
  let first=false,second=false;
  const a=h.queue.check('1').then(()=>first=true),b=h.queue.check('2').then(()=>second=true);
  await h.advance(100);assert.equal(first,true);assert.equal(second,false);assert.equal(h.queue.state('2'),'waiting');
  await h.advance(1999);assert.equal(h.calls.length,1);await h.advance(1);await Promise.all([a,b]);
  assert.deepEqual(h.calls,[['1','2'],['2']]);assert.equal(h.queue.snapshot().waiting,0);
});
test('busy checks do not prevent unrelated new IDs from progressing',async()=>{
  const h=harness(ids=>({items:ids.filter(id=>id!=='1').map(missing),deferredIds:ids.filter(id=>id==='1'),retryAfterMs:10000}));
  let active=true;const busy=h.queue.check('1',()=>active).catch(error=>error);
  await h.advance(100);const free=h.queue.check('2');await h.advance(1000);
  assert.equal((await free).imageId,'2');assert.deepEqual(h.calls,[['1'],['2']]);
  active=false;await h.advance(10000);assert.equal((await busy).code,'COLLECTION_CANCELLED');
});
test('cancelled deferred subscribers are removed without another server request',async()=>{
  const h=harness(ids=>({items:[],deferredIds:ids}));let active=true;
  const result=h.queue.check('1',()=>active).catch(error=>error);
  await h.advance(100);active=false;await h.advance(1000);
  assert.equal((await result).status,409);assert.equal(h.calls.length,1);assert.equal(h.queue.snapshot().waiting,0);
});
test('partial responses must account for each requested ID exactly once',()=>{
  const h=harness(()=>{});
  for(const response of [{items:[],deferredIds:[]},{items:[missing('1')],deferredIds:['1']},
    {items:[],deferredIds:['1','3']},{items:[],deferredIds:['1','1']},{items:[],deferredIds:[1,'2']}])
    assert.throws(()=>h.validate(['1','2'],response));
  assert.equal(h.validate(['1','2'],{items:[missing('1')],deferredIds:['2']}).length,1);
});
test('deferred results never become cached missing or duplicate answers',async()=>{
  let ready=false;const h=harness(ids=>ready?{items:ids.map(missing)}:{items:[],deferredIds:ids});
  const a=h.queue.check('1');await h.advance(100);const b=h.queue.check('1');assert.equal(h.queue.snapshot().cached,0);
  ready=true;await h.advance(1000);assert.equal((await a).imageId,'1');assert.equal((await b).imageId,'1');assert.equal(h.calls.length,2);
});
