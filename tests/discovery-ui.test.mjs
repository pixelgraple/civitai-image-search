import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../server/public/discovery.js',import.meta.url),'utf8');
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
function harness(verified=true){
 const elements=new Map(),requests=[],timers=new Map();let timerId=0;
 const get=id=>{if(!elements.has(id))elements.set(id,{value:'',checked:true,hidden:false,textContent:'',innerHTML:'',attributes:{},events:{},
  setAttribute(k,v){this.attributes[k]=v;},replaceChildren(){this.innerHTML='';},querySelectorAll(){return[];},addEventListener(k,fn){this.events[k]=fn;}});return elements.get(id);};
 const access={ready:Promise.resolve(),isVerified:()=>verified,fetch:(url,{signal})=>new Promise((resolve,reject)=>{
  requests.push({url,resolve,reject,signal});signal.addEventListener('abort',()=>reject(Object.assign(new Error('Aborted'),{name:'AbortError'})),{once:true});
 })};
 vm.runInNewContext(source,{document:{getElementById:get,querySelectorAll:()=>[]},window:{CivitaiAccess:access,addEventListener(){},scrollTo(){}},
  location:{href:'https://search-civitai.xyz/discovery.php?kind=creators'},history:{pushState(){}},URL,URLSearchParams,AbortController,
  setTimeout(fn,ms){const id=++timerId;timers.set(id,{fn,ms});return id;},clearTimeout(id){timers.delete(id);}});
 return{get,requests,timers,timeout(){const[id,timer]=timers.entries().next().value;timers.delete(id);timer.fn();}};
}
const response=()=>({ok:true,status:200,json:async()=>({ok:true,items:[],total:0,page:1,pages:0,generatedAt:1})});
test('a stalled discovery request ends after twenty seconds and offers Retry',async()=>{
 const h=harness();await flush();assert.equal(h.requests.length,1);assert.equal([...h.timers.values()][0].ms,20000);
 h.timeout();await flush();assert.equal(h.requests[0].signal.aborted,true);assert.equal(h.get('directoryResults').attributes['aria-busy'],'false');
 assert.match(h.get('directoryStatus').textContent,/Loading took too long/);assert.match(h.get('directoryResults').innerHTML,/directoryRetry/);
 h.get('directoryResults').events.click({target:{closest:()=>true}});await flush();assert.equal(h.requests.length,2);
 h.requests[1].resolve(response());await flush();assert.equal(h.timers.size,0);assert.match(h.get('directoryStatus').textContent,/0 entries/);
});
test('a replaced request cannot clear a newer directory or leave its timeout running',async()=>{
 const h=harness();await flush();h.get('directoryQuery').value='model';h.get('directorySearch').events.submit({preventDefault(){}});await flush();
 assert.equal(h.requests[0].signal.aborted,true);assert.equal(h.requests.length,2);assert.equal(h.timers.size,1);
 assert.match(h.get('directoryStatus').textContent,/Loading creators/);h.requests[1].resolve(response());await flush();assert.equal(h.timers.size,0);
});
test('unverified visitors never start a discovery request or its timer',async()=>{
 const h=harness(false);await flush();assert.equal(h.requests.length,0);assert.equal(h.timers.size,0);
});
