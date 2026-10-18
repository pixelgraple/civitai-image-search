(() => {
  'use strict';
  const $=id=>document.getElementById(id), access=window.CivitaiAccess;
  if (!access) return;
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const num=v=>Math.max(0,Number(v)||0).toLocaleString();
  const titles={models:'Models',loras:'LoRAs',creators:'Creators',recipes:'Generation recipes',phrases:'Prompt Explorer',tags:'Prompt Explorer'};
  const descriptions={
    models:'Browse checkpoints, their images and the resources people combine with them.',
    loras:'Find a LoRA, explore its examples and discover common checkpoint pairings.',
    creators:'Explore indexed creators and the prompts, models and LoRAs they use.',
    recipes:'Discover checkpoint + LoRA combinations used together in indexed images.',
    phrases:'Explore descriptive phrases found in positive prompts, then browse their examples.',
    tags:'Explore source tags and find images with the same exact tag.'
  };
  let kind='models',key='',query='',page=1,ticket=0,controller=null,started=false,stopImages=()=>{};
  const safe=()=>$('directoryPg13').checked;
  function readLocation() {
    const p=new URL(location.href).searchParams;
    kind=Object.hasOwn(titles,p.get('kind'))?p.get('kind'):'models';
    key=(p.get('key')||'').slice(0,320);query=(p.get('q')||'').slice(0,200);
    page=Math.max(1,Math.min(10000,Number(p.get('page'))||1));
    $('directoryPg13').checked=p.get('pg13')!=='0';
    $('directoryQuery').value=query;$('phraseKind').value=kind==='tags'?'tags':'phrases';
  }
  function url(k=kind,id='',extra={}) {
    return '/discovery.php?'+new URLSearchParams({kind:k,...(id?{key:id}:{}),pg13:safe()?'1':'0',...extra});
  }
  function gallery(item) {
    const p={pg13:safe()?'1':'0',sort:'civitai_reactions'};
    if (item.kind==='recipes') p.recipe=item.key;
    else if (item.kind==='tags') Object.assign(p,{tag:item.name,tagMatch:'exact'});
    else if (item.kind==='phrases') Object.assign(p,{q:'"'+item.name+'"',qScope:'prompt'});
    else { const field={models:'model',loras:'lora',creators:'creator'}[item.kind];p[field]=item.name;p[field+'Match']='exact'; }
    return '/?'+new URLSearchParams(p);
  }
  function imageMarkup(id) {
    return /^\d{1,20}$/.test(String(id))?'<img data-preview="media.php?id='+encodeURIComponent(id)+'&amp;variant=thumb&amp;w=320&amp;pv=1" width="240" height="320" decoding="async" alt="Image #'+esc(id)+'">':'';
  }
  function mount() {
    stopImages();
    const dispose=[];
    for (const node of [$('directoryResults'),$('directoryProfile')]) {
      if (window.CivitaiGalleryImages) dispose.push(window.CivitaiGalleryImages.mount(node));
      else node.querySelectorAll('img[data-preview]').forEach(img=>{img.loading='lazy';img.src=img.dataset.preview;});
    }
    stopImages=()=>dispose.forEach(fn=>fn());
  }
  function card(item) {
    const thumbs=(item.previewIds||[]).slice(0,3).map(imageMarkup);
    while(thumbs.length<3) thumbs.push('<span class="popular-preview-empty" aria-hidden="true">◇</span>');
    const name=(item.kind==='creators'?'@':'')+item.name;
    const detail=item.kind==='recipes'?(item.data.loras||[]).slice(0,3).map(esc).join(' · '):'Explore examples and related resources';
    return '<article class="popular-card"><a class="popular-card-link" href="'+esc(url(item.kind,item.key))+'"><div class="popular-card-images">'+thumbs.join('')+'</div><div class="popular-card-body"><span class="popular-card-kind">'+esc(item.kind==='phrases'?'Positive prompt phrase':item.kind)+'</span><h3>'+esc(name)+'</h3><div class="popular-primary"><strong>'+num(item.imageCount)+'</strong><span>indexed images</span></div><p class="discovery-card-description">'+detail+'</p><div class="popular-card-stats"><span>'+num(item.reactions)+' recorded Civitai reactions</span></div><span class="popular-card-action">Explore '+(item.kind==='recipes'?'recipe':'profile')+' ↗</span></div></a></article>';
  }
  function profile(item,related) {
    const recipe=item.kind==='recipes';
    const resources=recipe?'<div class="profile-resources"><h3>Checkpoint</h3><a href="'+esc(url('models',item.data.model))+'">'+esc(item.data.model)+'</a><h3>LoRAs</h3>'+(item.data.loras||[]).map(n=>'<a href="'+esc(url('loras',n))+'">'+esc(n)+'</a>').join('')+'</div>':'';
    const text=recipe?'These images share this checkpoint and LoRA set. Weights and other generation settings may differ. Open an example to read its captured prompt and available weights.':'Explore indexed images and common resources associated with this '+(item.kind==='creators'?'creator':item.kind==='phrases'?'prompt phrase':item.kind==='tags'?'source tag':'resource')+'.';
    let html='<div class="profile-hero"><div><p class="popular-eyebrow">'+esc(item.kind)+'</p><h2>'+(item.kind==='creators'?'@':'')+esc(item.name)+'</h2><p>'+text+'</p><div class="profile-stats"><div><strong>'+num(item.imageCount)+'</strong><span>indexed images</span></div><div><strong>'+num(item.reactions)+'</strong><span>recorded reactions</span></div></div><a class="discovery-action" href="'+esc(gallery(item))+'">Browse all images ↗</a></div>'+resources+'</div>';
    html+='<h2>Image examples</h2><div class="profile-images">'+(item.previewIds||[]).map(id=>'<a class="profile-image" href="/?'+esc(new URLSearchParams({image:id,pg13:safe()?'1':'0'}).toString())+'" aria-label="Open image '+esc(id)+'">'+imageMarkup(id)+'</a>').join('')+'</div>';
    if (!(item.previewIds||[]).length) html+='<p class="discovery-note">No stored previews are available yet. Browse all images to read indexed prompts.</p>';
    const names={models:'Common checkpoints',loras:'Common LoRAs',creators:'Creators',recipes:'Resource combinations',tags:'Common source tags',phrases:'Common prompt phrases'};
    html+='<h2>Explore connections</h2><p class="discovery-note">Co-occurrences in up to 1,000 indexed examples. Counts here describe this sample, not all of Civitai. Sharing a resource does not guarantee a particular result.</p><div class="discovery-facets">';
    for (const [k,list] of Object.entries(related||{})) {
      if (!list.length) continue;
      html+='<section class="discovery-facet"><h3>'+esc(names[k]||k)+'</h3>'+list.map(e=>'<a href="'+esc(url(e.kind,e.key))+'"><span>'+esc(e.name)+'</span><b>'+num(e.sampleUses)+'</b></a>').join('')+'</section>';
    }
    html+='</div>';
    return html;
  }
  function sync() {
    $('directoryTitle').textContent=titles[kind];$('directoryDescription').textContent=descriptions[kind];
    $('directorySearch').hidden=Boolean(key);$('directoryBack').hidden=!key;$('directoryBack').href=url();
    $('phraseKindLabel').hidden=!['phrases','tags'].includes(kind);
    $('customPhraseForm').hidden=Boolean(key)||!['phrases','tags'].includes(kind);
    $('directoryProfile').hidden=!key;
    const navKind=['tags','phrases'].includes(kind)?'explorer':kind;
    document.querySelectorAll('[data-library-nav]').forEach(a=>{
      const u=new URL(a.href);u.searchParams.set('pg13',safe()?'1':'0');a.href=u;
      if(a.dataset.libraryNav===navKind)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');
    });
    $('directoryNote').textContent='Counts cover this indexed library; missing source metadata and reactions can undercount them. Discovery refreshes every 15 minutes. '+(kind==='recipes'?'Combinations with at least two indexed examples appear in this directory. Recipes group resource names; weights may vary.':kind==='phrases'?'The phrase directory covers common descriptive phrases detected in positive prompts. Use the main search for any other phrase.':'');
  }
  function clear() {
    stopImages();$('directoryResults').replaceChildren();$('directoryProfile').replaceChildren();$('directoryPagination').replaceChildren();$('health').textContent='Community image index';
  }
  async function load(push=false) {
    sync();if(!access.isVerified())return;
    const turn=++ticket;controller?.abort();controller=new AbortController();clear();
    $('directoryResults').setAttribute('aria-busy','true');$('directoryStatus').textContent='Loading '+titles[kind].toLowerCase()+'…';
    if(push)history.pushState(null,'',url(kind,key,{...(query?{q:query}:{}),page:String(page)}));
    try {
      const response=await access.fetch('api.php?'+new URLSearchParams({action:'discovery',kind,key,q:query,page:String(page),pg13:safe()?'1':'0'}),{cache:'no-store',signal:controller.signal});
      const data=await response.json();
      if(turn!==ticket||!access.isVerified())return;
      if(response.status===429 && data.code==='search_rate_limited'){location.assign('access.php?action=search-block');return;}
      if(!response.ok||!data.ok)throw new Error(data.error||'Discovery is temporarily unavailable.');
      page=data.page;
      $('health').textContent='Updated '+new Date(data.generatedAt*1000).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
      $('directoryStatus').textContent=key?(data.items.length?'Profile · '+(safe()?'PG-13':'full')+' library':'This profile is not available under these filters.'):(num(data.total)+' entries · page '+page+' of '+Math.max(1,data.pages));
      if(key&&data.items.length) $('directoryProfile').innerHTML=profile(data.items[0],data.related);
      else if(!key)$('directoryResults').innerHTML=data.items.map(card).join('');
      if(!data.items.length)$('directoryResults').innerHTML='<div class="popular-empty"><h3>No matches in this view</h3><p>Try another name or return to the directory. New profiles appear as metadata is indexed.</p><a href="'+esc(url())+'">Browse directory</a></div>';
      if(!key&&data.pages>1)$('directoryPagination').innerHTML='<button type="button" data-page="'+(page-1)+'"'+(page<=1?' disabled':'')+'>← Previous</button><span>Page '+page+' / '+data.pages+'</span><button type="button" data-page="'+(page+1)+'"'+(page>=data.pages?' disabled':'')+'>Next →</button>';
      mount();
    }catch(error){
      if(turn!==ticket||!access.isVerified()||['AbortError','AccessRequiredError'].includes(error.name))return;
      clear();$('directoryStatus').textContent=error.message;
      $('directoryResults').innerHTML='<div class="popular-empty"><h3>Discovery is temporarily unavailable</h3><button type="button" id="directoryRetry">Retry</button></div>';
    }finally{if(turn===ticket)$('directoryResults').setAttribute('aria-busy','false');}
  }
  $('directorySearch').addEventListener('submit',e=>{e.preventDefault();query=$('directoryQuery').value.trim();page=1;load(true);});
  $('customPhraseForm').addEventListener('submit',e=>{
    e.preventDefault();const phrase=$('customPhrase').value.trim().replace(/"/g,'');
    if(!phrase)return;
    location.assign('/?'+new URLSearchParams({q:'"'+phrase+'"',qScope:'prompt',model:$('phraseModel').value.trim(),pg13:safe()?'1':'0'}));
  });
  $('directoryPg13').addEventListener('change',()=>{page=1;load(true);});
  $('phraseKind').addEventListener('change',()=>{kind=$('phraseKind').value;key='';page=1;load(true);});
  $('directoryPagination').addEventListener('click',e=>{const b=e.target.closest('[data-page]');if(b&&!b.disabled){page=Number(b.dataset.page);load(true);window.scrollTo({top:0});}});
  $('directoryResults').addEventListener('click',e=>{if(e.target.closest('#directoryRetry'))load();});
  $('searchForm').addEventListener('submit',e=>{e.preventDefault();location.assign('/?'+new URLSearchParams({q:$('query').value,qMode:$('qMode').value,pg13:safe()?'1':'0'}));});
  window.addEventListener('popstate',()=>{readLocation();load();});
  window.addEventListener('civitai-access-change',e=>{if(e.detail?.verified){if(started)load();return;}ticket++;controller?.abort();clear();$('directoryStatus').textContent='Verify to explore the library.';});
  readLocation();sync();access.ready.then(()=>{started=true;load();});
})();
