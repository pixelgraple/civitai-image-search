import test from 'node:test';
import assert from 'node:assert/strict';
import {harness} from './background-harness.mjs';

const flush=async()=>{for(let i=0;i<30;i++)await new Promise(resolve=>setImmediate(resolve));};
async function until(predicate,message,timeout=2500){
  const deadline=Date.now()+timeout;
  while(!predicate()&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,5));
  assert.ok(predicate(),message);
}
const sender=(h,id)=>({url:h.tabs.get(id).url,tab:h.tabs.get(id),frameId:0});
const image=id=>({id,type:'image',url:`https://image.civitai.com/key/${id}/width=450/${id}.png`,
  stats:{likeCount:0,heartCount:0,laughCount:0,cryCount:0},
  tags:['landscape'],meta:{prompt:'safe landscape fixture',modelName:'Landscape',resources:[]}});

test('two real feed parsers and passive collection share groups of twelve image jobs',async()=>{
  const h=await harness();
  // Move past the startup passive collector's normal ten-second idle interval.
  h.context.Date=class extends Date {static now(){return Date.now()+11000;}};
  h.tabs.set(8,{id:8,url:'https://civitai.red/models/100'});
  h.tabs.set(9,{id:9,url:'https://civitai.com/images'});
  const timers=[], started=[],requests=[];
  h.context.batchTimer=(callback,delay)=>{timers.push({callback,delay});return timers.length;};
  h.context.markImage=()=>started.push(Date.now());
  h.run(`const realQueue=ISSImageQueue.create({setTimer:batchTimer});
    ISSImageQueue={run:(task,current)=>realQueue.run(()=>{markImage();return task();},current),status:()=>realQueue.status()};
    PromptCatalogDB.forPromptCollection=async items=>({items,skippedIds:[]});
    PromptCatalogDB.upsert=async items=>items;`);
  h.context.sourceFixture=async(tabId,url)=>{
    const parsed=new URL(url), procedure=parsed.pathname.split('/').pop();
    requests.push({tabId,procedure,input:JSON.parse(parsed.searchParams.get('input')).json});
    const payload=procedure==='image.getInfinite'?{items:Array.from({length:12},(_,i)=>image(tabId*100+i)),nextCursor:null}
      :procedure==='image.getDetail'?image(900):{type:'image',meta:{prompt:'safe landscape fixture',modelName:'Landscape'},resources:[]};
    return {result:{data:{json:payload}}};
  };
  h.run('requestCivitaiFeed=(...args)=>sourceFixture(...args)');
  h.context.fetch=async(url,options)=>{
    const body=JSON.parse(options.body);
    return new Response(JSON.stringify(url.endsWith('action=check')?{ok:true,items:body.imageIds.map(imageId=>({imageId,exists:false,sha256:null,downloadStatus:'missing',needsDownload:true}))}:{ok:true,accepted:body.items.length,skipped:0}));
  };
  for(const id of [7,8]){
    const request=new URL('/api/trpc/image.getInfinite',h.tabs.get(id).url);
    request.searchParams.set('input',JSON.stringify({json:{modelId:id,limit:50,browsingLevel:1}}));
    assert.equal((await h.message({type:'start',feedRequestUrls:[request.href]},sender(h,id))).ok,true);
  }
  const manual=h.run('driverPulse()');
  await h.message({type:'civitai-auto-cards',pageUrl:h.tabs.get(9).url,cards:[{id:'900',previewUrl:image(900).url}]},sender(h,9));
  await until(()=>started.length===12&&timers.length===1,'early duplicate checks complete before the first group of prompt readers');
  assert.equal(started.length,12,'all collectors stop after twelve image tasks');
  assert.equal(timers.length,1);assert.equal(timers[0].delay,1000);
  timers.shift().callback();await until(()=>started.length===24&&timers.length===1,'the second twelve-image group completes before its cooldown');
  assert.equal(started.length,24);assert.equal(timers.length,1);assert.equal(timers[0].delay,1000);
  timers.shift().callback();await manual;await flush();
  assert.equal(started.length,25);
  await until(()=>h.run('getPublicState().status.catalogSynced')===24&&h.run('autoBrowseCollector.stats().accepted')===1,'manual and automatic records finish the independent server-submission queue');
  const states=await h.extensionMessage({type:'getState'});
  assert.equal(states.status.catalogSynced,24);
  const browsing=await h.extensionMessage({type:'civitai-auto-status'});
  assert.equal(browsing.synced,1);
  assert.equal(requests.filter(request=>request.procedure==='image.getInfinite').length,2);
  assert.ok(requests.filter(request=>request.procedure==='image.getInfinite').every(request=>request.input.limit===60));
});
