(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const access = window.CivitaiAccess;
  if (!access) return;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const format = value => Math.max(0, Number(value) || 0).toLocaleString();
  const titles = { users:'Popular uploaders', models:'Most-used models', loras:'Most-used LoRAs' };
  const descriptions = {
    users:'At least 50 indexed images, each with 200+ combined Civitai reactions.',
    models:'Checkpoints ranked by how many indexed images use them.',
    loras:'LoRAs ranked by indexed image count. One use per image, even when named more than once.'
  };
  const params = new URL(location.href).searchParams;
  let type = Object.hasOwn(titles, params.get('type')) ? params.get('type') : 'users';
  let started = false, request = 0, controller = null, stopImages = () => {};
  $('popularPg13').checked = params.get('pg13') !== '0';
  const safe = () => $('popularPg13').checked;
  function galleryUrl(name) {
    return '/discovery.php?' + new URLSearchParams({kind:type==='users'?'creators':type,key:name,pg13:safe()?'1':'0'});
  }
  function thumbnail(preview) {
    if (!/^\d{1,20}$/.test(String(preview.id))) return '';
    try {
      const url = new URL(preview.url, location.href);
      if (url.origin !== location.origin || url.pathname !== '/media.php' ||
          url.searchParams.get('variant') !== 'thumb' || url.searchParams.get('id') !== String(preview.id)) return '';
      return '<img data-preview="'+esc(url.href)+'" width="160" height="180" decoding="async" alt="">';
    } catch { return ''; }
  }
  function card(item,index) {
    const images = Array.isArray(item.previews) ? item.previews.slice(0,3).map(thumbnail).filter(Boolean) : [];
    while (images.length<3) images.push('<span class="popular-preview-empty" aria-hidden="true">▧</span>');
    const name = type==='users' ? '@'+item.name : item.name;
    const primary = type==='users' ? item.qualifyingCount : item.imageCount;
    const primaryLabel = type==='users' ? 'images with 200+ reactions' : 'indexed images';
    const secondary = type==='users'
      ? '<span><b>'+format(item.imageCount)+'</b> images indexed</span>'
      : '<span><b>'+format(item.creatorCount)+'</b> indexed creators</span>';
    const reactions = item.reactionImages>0 ? format(item.reactions) : 'Not indexed';
    const kind = type==='users' ? 'Civitai creator' : type==='models' ? 'Checkpoint / model' : 'LoRA';
    return '<article class="popular-card"><a class="popular-card-link" href="'+esc(galleryUrl(item.name))+'">'
      +'<div class="popular-card-images">'+images.join('')+'<span class="popular-rank" aria-label="Rank '+(index+1)+'">'+String(index+1).padStart(2,'0')+'</span></div>'
      +'<div class="popular-card-body"><span class="popular-card-kind">'+kind+'</span><h3>'+esc(name)+'</h3>'
      +'<div class="popular-primary"><strong>'+format(primary)+'</strong><span>'+primaryLabel+'</span></div>'
      +'<div class="popular-card-stats">'+secondary+'<span><b>'+reactions+'</b> recorded reactions</span></div>'
      +'<span class="popular-card-action">Explore profile <span aria-hidden="true">↗</span></span></div></a></article>';
  }
  function syncTabs() {
    $('popularTabs').querySelectorAll('[data-type]').forEach(tab => {
      const active = tab.dataset.type===type;
      tab.setAttribute('aria-selected',String(active)); tab.tabIndex=active?0:-1;
      if (active) $('popularPanel').setAttribute('aria-labelledby',tab.id);
    });
    $('popularTitle').textContent=titles[type];
    $('popularDescription').textContent=descriptions[type];
    document.querySelectorAll('[data-library-nav]').forEach(a=>{const u=new URL(a.href);u.searchParams.set('pg13',safe()?'1':'0');a.href=u;});
    $('imagesNav').href='/?pg13='+(safe()?'1':'0');
    $('popularNav').href='/popular.php?type='+type+'&pg13='+(safe()?'1':'0');
  }
  function resetResults() {
    stopImages(); $('popularResults').replaceChildren();
    $('popularUpdated').textContent=''; $('health').textContent='Community image index';
  }
  async function load() {
    syncTabs();
    if (!access.isVerified()) return;
    const ticket=++request;
    controller?.abort(); controller=new AbortController();
    resetResults();
    $('popularPanel').setAttribute('aria-busy','true');
    $('popularStatus').textContent='Loading rankings…';
    $('popularResults').innerHTML=Array.from({length:8},()=>'<div class="popular-skeleton" aria-hidden="true"></div>').join('');
    const query=new URLSearchParams({action:'popular',type,pg13:safe()?'1':'0'});
    history.replaceState(null,'','/popular.php?type='+type+'&pg13='+(safe()?'1':'0'));
    try {
      const response=await access.fetch('api.php?'+query,{headers:{Accept:'application/json'},cache:'no-store',signal:controller.signal});
      const data=await response.json();
      if (ticket!==request || !access.isVerified()) return;
      if (response.status===429 && data.code==='search_rate_limited') {
        location.replace('access.php?action=search-block'); return;
      }
      if (!response.ok || !data.ok || !Array.isArray(data.items)) throw new Error('Rankings unavailable');
      const mode=safe()?'PG-13 library':'full library';
      $('health').textContent=format(data.catalogImages)+' images · '+mode;
      const date=new Date(Number(data.generatedAt)*1000);
      $('popularUpdated').textContent=(data.stale?'Last snapshot':'Updated')+' '+date.toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
      const noun=type==='users'?'qualifying creators':type==='models'?'indexed models':'indexed LoRAs';
      $('popularStatus').textContent=data.items.length
        ? 'Top '+data.items.length+' of '+format(data.total)+' '+noun+' · '+mode
        : 'No '+(type==='users'?'qualifying creators':'rankings')+' in the '+mode+' yet.';
      $('popularResults').innerHTML=data.items.length ? data.items.map(card).join('')
        : '<div class="popular-empty"><span aria-hidden="true">◇</span><h3>'
          +(type==='users'?'No creators meet this threshold yet':'More resource data is needed')+'</h3><p>'
          +(type==='users'?'A creator needs at least 50 images with 200 or more recorded Civitai reactions each. The threshold also follows your PG-13 filter.'
            :'These rankings appear as contributors index images with model and LoRA names.')
          +'</p><a href="/guide.php">Help index more images ↗</a></div>';
      if (window.CivitaiGalleryImages) stopImages=window.CivitaiGalleryImages.mount($('popularResults'));
      else $('popularResults').querySelectorAll('img[data-preview]').forEach(img=>{img.loading='lazy';img.src=img.dataset.preview;});
      $('popularResults').querySelectorAll('img').forEach(img=>img.addEventListener('error',()=>{
        const replacement=document.createElement('span');
        replacement.className='popular-preview-empty'; replacement.textContent='▧';
        replacement.setAttribute('aria-hidden','true'); img.replaceWith(replacement);
      },{once:true}));
    } catch (error) {
      if (ticket!==request || !access.isVerified() || error.name==='AbortError' || error.name==='AccessRequiredError') return;
      resetResults(); $('popularStatus').textContent='Rankings are temporarily unavailable.';
      $('popularResults').innerHTML='<div class="popular-empty"><h3>Please try again shortly</h3><p>Your filter selection has been kept.</p><button type="button" id="popularRetry">Retry rankings</button></div>';
    } finally {
      if (ticket===request) $('popularPanel').setAttribute('aria-busy','false');
    }
  }
  $('popularTabs').addEventListener('click',event=>{
    const tab=event.target.closest('[data-type]');
    if (!tab || tab.dataset.type===type) return;
    type=tab.dataset.type; load();
  });
  $('popularTabs').addEventListener('keydown',event=>{
    if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
    const tabs=[...$('popularTabs').querySelectorAll('[data-type]')];
    let index=tabs.indexOf(document.activeElement);
    if (index<0) return;
    event.preventDefault();
    index=event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;
    tabs[index].focus(); tabs[index].click();
  });
  $('popularPg13').addEventListener('change',load);
  $('popularResults').addEventListener('click',event=>{if(event.target.closest('#popularRetry')) load();});
  $('searchForm').addEventListener('submit',event=>{
    event.preventDefault();
    location.assign('/?'+new URLSearchParams({q:$('query').value,qMode:$('qMode').value,pg13:safe()?'1':'0'}));
  });
  syncTabs();
  window.addEventListener('civitai-access-change',event=>{
    if (event.detail?.verified) {if(started) load();return;}
    request++; controller?.abort(); resetResults();
    $('popularPanel').setAttribute('aria-busy','false');
    $('popularStatus').textContent='Verify to explore the rankings.';
  });
  access.ready.then(()=>{started=true;load();});
})();
