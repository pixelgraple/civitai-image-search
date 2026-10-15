import test from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './background-harness.mjs';

test('public sync posts catalog metadata in bounded batches without credentials', async () => {
  const h=await harness({civitaiPromptCloud:{apiBase:'https://search-civitai.xyz/api.php',writeToken:'test-writer-key'}});
  const calls=[];
  h.context.fetch=async(url,options)=>{calls.push({url,options});const body=JSON.parse(options.body);
    return new Response(JSON.stringify(url.endsWith('action=check') ? {ok:true,items:body.imageIds.map(imageId=>({imageId,exists:false,sha256:null,downloadStatus:'missing',needsDownload:true}))}
      : {ok:true,accepted:body.items.length,skipped:0}),{status:200});};
  const records=Array.from({length:61},(_,index)=>({id:String(index+1),prompt:'selfie',downloadUrl:'https://image.civitai.com/key/x/original=true/1.png'}));
  await h.run('syncCloudCatalogItems('+JSON.stringify(records)+')');
  assert.equal(calls.length,3);
  assert.equal(calls[0].options.method,'POST');
  assert.equal(calls[0].options.headers.Authorization,undefined);
  assert.equal(h.storage.civitaiPromptCloud.writeToken,undefined);
  assert.equal(JSON.parse(calls[0].options.body).imageIds.length,61);
  assert.equal(JSON.parse(calls[1].options.body).items.length,60);
  assert.equal(JSON.parse(calls[2].options.body).items.length,1);
});

test('fresh installation syncs immediately with no key or saved configuration', async () => {
  const h=await harness();
  const calls=[];h.context.fetch=async(url,options)=>{calls.push(options);return new Response(JSON.stringify(url.endsWith('action=check')?{ok:true,items:[{imageId:'1',exists:false,needsDownload:true,sha256:'',downloadStatus:'unknown'}]}:{ok:true,accepted:1,skipped:0}),{status:200});};
  await h.run("syncCloudCatalogItems([{id:'1',prompt:'landscape',downloadUrl:'https://image.civitai.com/key/image/original=true/1.jpg'}])");
  assert.equal(calls.length,2);
  assert.ok(calls.every(call=>!Object.hasOwn(call.headers,'Authorization') && call.credentials==='omit'));
  assert.equal((await h.message({type:'getConfig'})).configured,true);
});

test('obsolete alternate endpoints and keys are removed; the public server remains pinned', async () => {
  const h=await harness({civitaiPromptCloud:{apiBase:'http://library.example/api.php',writeToken:'key'}});
  const config=await h.message({type:'getConfig'});
  assert.equal(config.apiBase,'https://search-civitai.xyz/api.php');
  assert.equal(config.configured,true);
  assert.equal(h.storage.civitaiPromptCloud.writeToken,undefined);
  assert.equal((await h.extensionMessage({type:'saveConfig',apiBase:'https://evil.example/api.php'})).ok,false);
});

test('legacy catalog image download commands and implementation are removed', async () => {
  const h=await harness({civitaiPromptCloud:{apiBase:'https://search-civitai.xyz/api.php',writeToken:'key'}});
  assert.equal(h.run('typeof startCatalogDownloads'), 'undefined');
  const result=await h.extensionMessage({type:'catalogDownload',items:[{id:'123',url:'https://image.civitai.com/key/x/original=true/123.png'}]});
  assert.equal(result.ok,false);
  assert.equal(h.started.length,0);
});
