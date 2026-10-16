(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const access = window.CivitaiAccess;
  if (!access) return;
  const protectedFetch = (url, options) => access.fetch(url, options);
  const skeletonMarkup = $('results').innerHTML;
  let libraryStarted = false;
  let stopGalleryImages = () => {};
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const number = value => Math.max(0, Number(value) || 0);
  const format = value => number(value).toLocaleString();
  const styleNames = { anime: 'Anime', realistic: 'Realistic', uncertain: 'Uncertain' };
  const reactionTypes = [['likeCount', '👍', 'likes'], ['heartCount', '❤️', 'hearts'], ['laughCount', '😂', 'laughs'], ['cryCount', '😭', 'cries'], ['buzzCount', '⚡', 'Buzz']];
  const communityTypes = [['upvote', '↑', 'Upvote'], ['heart', '❤️', 'Love'], ['laugh', '😂', 'Laugh'], ['wow', '😮', 'Wow']];
  const layoutPreview = new URL(location.href).searchParams.get('preview') === 'layout';
  const defaultFilters = { q: '', qMode: 'all', tag: '', tagMode: 'all', tagMatch: 'list', model: '', lora: '', creator: '', creatorMatch: 'contains', category: '', sort: 'newest' };
  const filterControls = { q: 'query', qMode: 'qMode', tag: 'tag', tagMode: 'tagMode', model: 'model', lora: 'lora', creator: 'creator', category: 'category', sort: 'sort' };
  const state = { page: 1, pages: 1, limit: layoutPreview ? 48 : 42, total: 0, items: [], filters: { ...defaultFilters }, pendingFilters: null, request: 0, controller: null, viewerIndex: -1, viewerBusy: false, returnFocus: null, reactionRequest: 0, reactionController: null, community: null };
  const reactionWrites = new Map();

  function mediaUrl(value, id) {
    if (!value || !/^\d{1,20}$/.test(String(id))) return '';
    try {
      const url = new URL(String(value), location.href);
      if (url.origin !== location.origin || !url.pathname.endsWith('/media.php') || url.searchParams.get('id') !== String(id)) return '';
      url.searchParams.set('av', 'captcha1');
      return url.href;
    } catch { return ''; }
  }
  function capturedOrigin(row) {
    return ['https://civitai.red', 'https://civitai.com'].includes(row.sourceOrigin) ? row.sourceOrigin : '';
  }
  function sourceUrl(row) { return `${capturedOrigin(row) || 'https://civitai.red'}/images/${encodeURIComponent(row.id)}`; }
  function creatorLibraryUrl(name) {
    const url = new URL('./', location.href);
    url.search = new URLSearchParams({ creator: name, creatorMatch: 'exact', sort: state.filters.sort }).toString();
    url.hash = '';
    return url.href;
  }
  function creatorProfileUrl(name, origin) {
    return ['https://civitai.red', 'https://civitai.com'].includes(origin) ? `${origin}/user/${encodeURIComponent(name)}/images` : '';
  }
  function creatorMarkup(row) {
    const name = String(row.creatorName || '').trim().replace(/^@+/, '');
    if (!name) return '<p class="creator-missing">Creator not yet indexed.</p>';
    const origin = capturedOrigin(row), profile = creatorProfileUrl(name, origin);
    return `<div class="creator-card"><button type="button" class="creator-search" data-open-creator title="Open the creator profile and indexed images in two new tabs"><span>Creator</span><b>@${esc(name)}</b><span aria-hidden="true">↗</span></button><p class="creator-link-note">Open profile + indexed images in two tabs.</p>${origin ? '' : '<label class="creator-domain-label" for="creatorDomain">Profile site<select id="creatorDomain"><option value="">Choose .red or .com</option><option value="https://civitai.red">civitai.red</option><option value="https://civitai.com">civitai.com</option></select></label><p class="creator-link-note">The original site was not saved for this older image.</p>'}<div class="creator-links"><a id="creatorProfileLink"${profile ? ` href="${esc(profile)}"` : ' hidden'} target="_blank" rel="noopener noreferrer">${origin === 'https://civitai.com' ? 'Civitai.com' : 'Civitai.red'} profile ↗</a><a href="${esc(creatorLibraryUrl(name))}" target="_blank" rel="noopener noreferrer">Indexed images ↗</a></div><p id="creatorFeedback" class="creator-link-note" role="status" aria-live="polite"></p></div>`;
  }
  function openCreatorPages() {
    const row = state.items[state.viewerIndex];
    if (!access.isVerified() || !row) return;
    const name = String(row.creatorName || '').trim().replace(/^@+/, '');
    if (!name) return;
    const origin = capturedOrigin(row) || $('creatorDomain')?.value;
    const profile = creatorProfileUrl(name, origin);
    if (!profile) {
      $('creatorFeedback').textContent = 'Choose the Civitai site below, then click the username.';
      $('creatorDomain')?.focus();
      return;
    }
    let opened = 0;
    for (const url of [profile, creatorLibraryUrl(name)]) {
      try {
        const tab = window.open('about:blank', '_blank');
        if (!tab) continue;
        tab.opener = null;
        tab.location.replace(url);
        opened++;
      } catch { /* The individual links remain usable when a browser blocks a tab. */ }
    }
    $('creatorFeedback').textContent = opened === 2 ? 'Opened the Civitai profile and indexed images.' : 'Your browser blocked a new tab. Use the two links above, or allow pop-ups for this site.';
  }
  function dimensions(row) {
    const width = Math.trunc(number(row.width)), height = Math.trunc(number(row.height));
    return width > 0 && height > 0 && width <= 100000 && height <= 100000 ? ` width="${width}" height="${height}"` : '';
  }
  function reactionMarkup(row, large = false) {
    const values = row.reactions || {};
    const entries = reactionTypes.filter(([key]) => values[key] !== null && values[key] !== undefined && Number.isFinite(Number(values[key])) && Number(values[key]) >= 0);
    const sample = Boolean(row.previewSampleReactions);
    const marker = sample ? '<span class="sample-reaction-label" title="Example counts for this layout preview">Sample</span>' : '';
    return entries.length ? marker + entries.map(([key, emoji, title]) => `<span class="reaction${key === 'buzzCount' ? ' reaction-buzz' : ''}" title="${sample ? 'Sample' : 'Civitai'} ${esc(title)}${sample ? ' for layout preview only' : ' captured while scanning'}" aria-label="${format(values[key])} ${sample ? 'sample' : 'Civitai'} ${esc(title)}"><span aria-hidden="true">${emoji}</span><b>${format(values[key])}</b></span>`).join('') : `<span class="reaction-unavailable">${large ? 'Source reactions were not available when indexed.' : `#${esc(row.id)}`}</span>`;
  }
  function statusText(row) {
    return row.downloadStatus === 'ready' ? 'Stored on server' : row.downloadStatus === 'pending' ? 'Image copy is processing' : 'Image copy is unavailable';
  }
  function cardMarkup(row, index) {
    const preview = mediaUrl(row.previewUrl, row.id);
    const label = `View image ${row.id}${row.modelName ? ` · ${row.modelName}` : ''}`;
    const image = preview ? `<img data-preview="${esc(preview)}"${dimensions(row)} decoding="async" alt="Indexed image ${esc(row.id)}">` : `<span class="image-fallback"><span class="fallback-symbol" aria-hidden="true">▧</span><b>${esc(statusText(row))}</b><small>Prompt and details are available</small></span>`;
    return `<article class="image-card"><div class="card-media"><button type="button" class="gallery-open" data-index="${index}" aria-label="${esc(label)}">${image}</button><a class="source-link" href="${esc(sourceUrl(row))}" target="_blank" rel="noopener noreferrer" aria-label="Open image ${esc(row.id)} on Civitai" title="Open on Civitai"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7 .2l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7-.2l-3 3a5 5 0 0 0 7 7l2-2"></path></svg></a><span class="image-category category-${esc(row.category || 'uncertain')}">${esc(styleNames[row.category] || 'Uncertain')}</span></div><div class="reaction-strip"><span class="card-community-upvotes" data-community-id="${esc(row.id)}" title="${format(row.communityReactions?.upvote)} community upvotes on Search Civitai" aria-label="${format(row.communityReactions?.upvote)} community upvotes"><span aria-hidden="true">↑</span><b>${format(row.communityReactions?.upvote)}</b></span><span class="card-source-reactions" aria-label="Read-only Civitai source reactions">${reactionMarkup(row)}</span></div></article>`;
  }
  function markImageErrors(root) {
    root.querySelectorAll('img').forEach(img => img.addEventListener('error', async () => {
      await access.refresh();
      if (!access.isVerified() || !img.isConnected) return;
      const fallback = document.createElement('span');
      fallback.className = 'image-fallback';
      fallback.textContent = 'Image unavailable. Prompt and details are still available.';
      img.replaceWith(fallback);
    }, { once: true }));
  }
  function currentFilters() {
    const tag = $('tag').value.trim();
    const exactTag = tag !== '' && $('tag').dataset.exactTag === tag;
    const creator = $('creator').value.trim().replace(/^@+/, '');
    return {
      q: $('query').value.trim(), qMode: $('qMode').value === 'any' ? 'any' : 'all',
      tag: exactTag ? tag : tag.split(/[,\r\n]+/).map(value => value.trim()).filter(Boolean).join(', '),
      tagMatch: exactTag ? 'exact' : 'list',
      model: $('model').value.trim(),
      tagMode: $('tagMode').value === 'any' ? 'any' : 'all', lora: $('lora').value.trim(),
      creator, creatorMatch: creator && $('creator').dataset.exactCreator === creator ? 'exact' : 'contains', category: $('category').value,
      sort: ['upvotes', 'civitai_reactions'].includes($('sort').value) ? $('sort').value : 'newest'
    };
  }
  function setControls(filters) {
    Object.entries(filterControls).forEach(([key, id]) => { $(id).value = filters[key] ?? defaultFilters[key]; });
    $('tag').dataset.exactTag = filters.tagMatch === 'exact' ? filters.tag : '';
    $('creator').dataset.exactCreator = filters.creatorMatch === 'exact' ? filters.creator : '';
    syncTagHelp();
  }
  function syncTagHelp() {
    $('tagHelp').textContent = $('tag').dataset.exactTag
      ? 'Searching the complete clicked tag, including any punctuation. Edit this field to enter comma-separated tags.'
      : 'Separate up to 20 exact tags with commas. AND requires every tag; OR accepts any tag.';
  }
  function syncControls(counts = {}) {
    const selected = state.filters.category;
    $('counts').querySelectorAll('[data-category]').forEach(button => {
      const category = button.dataset.category;
      const count = category ? counts[category] : Object.values(counts).reduce((sum, value) => sum + number(value), 0);
      button.innerHTML = `${category ? styleNames[category] : 'All styles'}${count !== undefined ? ` <span>${format(count)}</span>` : ''}`;
      button.classList.toggle('is-active', category === selected);
      button.setAttribute('aria-pressed', String(category === selected));
    });
    $('topics').querySelectorAll('[data-query]').forEach(button => {
      const selectedQuery = state.filters.q.toLowerCase() === button.dataset.query;
      button.classList.toggle('is-active', selectedQuery);
      button.setAttribute('aria-pressed', String(selectedQuery));
    });
    const filters = state.filters;
    const summaries = [
      ['q', filters.q ? `${filters.qMode === 'any' ? 'OR' : 'AND'} words: ${filters.q}` : ''],
      ['tag', filters.tag ? `${filters.tagMatch === 'exact' ? 'Tag' : filters.tagMode === 'any' ? 'OR tags' : 'AND tags'}: ${filters.tag}` : ''],
      ['lora', filters.lora ? `LoRA: ${filters.lora}` : ''],
      ['model', filters.model ? `Model: ${filters.model}` : ''],
      ['creator', filters.creator ? `Creator: @${filters.creator}` : ''],
      ['category', filters.category ? `Style: ${styleNames[filters.category] || filters.category}` : '']
    ].filter(([, label]) => label);
    $('activeFilters').innerHTML = summaries.map(([key, label]) => `<button type="button" class="active-filter" data-clear-filter="${key}" title="Remove ${esc(label)}" aria-label="Remove filter: ${esc(label)}"><span>${esc(label)}</span><span aria-hidden="true">×</span></button>`).join('');
    $('filterCount').textContent = String(summaries.length);
    $('filterCount').hidden = summaries.length === 0;
    $('sortHelp').hidden = filters.sort !== 'civitai_reactions';
    $('searchContext').hidden = summaries.length === 0 && filters.sort !== 'civitai_reactions';
  }
  function pageNumbers() {
    const pages = new Set([1, state.pages]);
    for (let value = Math.max(1, state.page - 2); value <= Math.min(state.pages, state.page + 2); value++) pages.add(value);
    return [...pages].sort((a, b) => a - b);
  }
  function renderPagination() {
    if (state.total === 0) { $('pagination').innerHTML = ''; return; }
    let previous = 0;
    const links = pageNumbers().map(value => {
      const gap = previous && value - previous > 1 ? '<span class="page-gap" aria-hidden="true">…</span>' : '';
      previous = value;
      return `${gap}<button type="button" data-page="${value}"${value === state.page ? ' class="is-active" aria-current="page"' : ''} aria-label="Page ${value}">${value}</button>`;
    }).join('');
    $('pagination').innerHTML = `<button type="button" class="page-direction" data-page="${state.page - 1}"${state.page <= 1 ? ' disabled' : ''}>‹ <span>Previous</span></button>${links}<button type="button" class="page-direction" data-page="${state.page + 1}"${state.page >= state.pages ? ' disabled' : ''}><span>Next</span> ›</button><span class="page-summary">Page ${format(state.page)} of ${format(state.pages)}</span>`;
  }
  async function loadPage(targetPage = 1, options = {}) {
    if (!access.isVerified()) return false;
    const filters = options.filters ? { ...options.filters } : { ...state.filters };
    const request = ++state.request;
    state.controller?.abort();
    const controller = new AbortController(); state.controller = controller;
    state.pendingFilters = filters;
    $('results').setAttribute('aria-busy', 'true');
    $('pagination').querySelectorAll('button').forEach(button => { button.disabled = true; });
    $('resultCount').textContent = 'Searching the library…';
    $('viewerStatus').textContent = options.keepViewer ? 'Loading the next page…' : '';
    const params = new URLSearchParams({ action: 'search', ...filters, page: String(Math.max(1, targetPage)), limit: String(state.limit) });
    try {
      const response = await protectedFetch(`api.php?${params}`, { headers: { Accept: 'application/json' }, cache: 'no-store', signal: controller.signal });
      const data = await response.json();
      if (!response.ok || !data.ok || !Array.isArray(data.items)) {
        const error = new Error(data.error || `The search request failed (${response.status}).`);
        if (response.status === 400) error.name = 'SearchInputError';
        throw error;
      }
      if (request !== state.request || !access.isVerified()) return false;
      if (layoutPreview) {
        const sample = data.items.find(row => row.downloadStatus === 'ready' && mediaUrl(row.previewUrl, row.id));
        if (sample) {
          const sourceReactions = reactionTypes.some(([key]) => sample.reactions?.[key] !== null && sample.reactions?.[key] !== undefined && Number.isFinite(Number(sample.reactions[key])) && Number(sample.reactions[key]) >= 0);
          const sampleReactions = sourceReactions ? sample.reactions : { likeCount: 424, heartCount: 317, laughCount: 29, cryCount: 22, buzzCount: 20 };
          data.items = Array.from({ length: 48 }, () => ({ ...sample, reactions: sampleReactions, previewSampleReactions: !sourceReactions }));
          data.total = 48; data.pages = 1; data.page = 1;
          $('previewDescription').textContent = `48 repeated cards from stored image #${sample.id}. ${sourceReactions ? 'Reaction counts are captured source counts.' : 'Reaction counts labeled Sample are examples.'} The library is unchanged.`;
        } else {
          data.items = []; data.total = 0; data.pages = 0; data.page = 1;
          $('previewDescription').textContent = 'No stored image matches these filters yet. Clear the filters or wait for an image copy. The library is unchanged.';
        }
      }
      const pages = Math.max(1, number(data.pages));
      if (targetPage > pages) return loadPage(pages, options);
      state.page = Math.max(1, number(data.page)); state.pages = pages; state.total = number(data.total); state.items = data.items; state.filters = filters;
      $('resultCount').textContent = layoutPreview ? `${format(state.total)} preview cards${state.total ? ' · 1 real stored image · not library counts' : ''}` : `${format(state.total)} matching image${state.total === 1 ? '' : 's'}${state.total ? ` · ${format((state.page - 1) * state.limit + 1)}–${format((state.page - 1) * state.limit + state.items.length)}` : ''}`;
      stopGalleryImages();
      $('results').innerHTML = state.items.length ? state.items.map(cardMarkup).join('') : '<div class="empty"><span class="empty-symbol" aria-hidden="true">⌕</span><h1>No matching images</h1><p>Try a different prompt keyword or clear your filters. This search covers images already indexed by the community.</p><button type="button" id="emptyReset">Clear search and filters</button></div>';
      $('results').classList.toggle('is-empty', state.items.length === 0);
      markImageErrors($('results')); syncControls(data.categoryCounts || {}); renderPagination();
      if (options.scroll) window.scrollTo({ top: 0, behavior: 'instant' });
      if (window.CivitaiGalleryImages) stopGalleryImages = window.CivitaiGalleryImages.mount($('results'));
      else $('results').querySelectorAll('img[data-preview]').forEach(img => { img.loading = 'lazy'; img.src = img.dataset.preview; });
      if (options.keepViewer && state.items.length) { state.viewerIndex = options.last ? state.items.length - 1 : 0; renderViewer(); }
      return true;
    } catch (error) {
      if (error.name === 'AbortError' || error.name === 'AccessRequiredError' || request !== state.request || !access.isVerified()) return false;
      if (options.keepViewer) { $('viewerStatus').textContent = error.message || 'Unable to load the next page.'; renderPagination(); }
      else {
        stopGalleryImages();
        $('resultCount').textContent = error.name === 'SearchInputError' ? 'Adjust your search' : 'Search unavailable';
        $('results').classList.add('is-empty');
        $('results').innerHTML = `<div class="empty"><h1>${error.name === 'SearchInputError' ? 'Check your search filters' : 'The library is temporarily unavailable'}</h1><p>${esc(error.message)}</p><button type="button" id="retrySearch">Try again</button></div>`;
        $('pagination').innerHTML = '';
      }
      return false;
    } finally {
      if (request === state.request) {
        state.pendingFilters = null;
        $('results').setAttribute('aria-busy', 'false');
      }
    }
  }
  function communityCounts(values = {}) {
    return Object.fromEntries(communityTypes.map(([type]) => [type, Math.trunc(number(values?.[type]))]));
  }
  function currentCommunity(id, request) {
    return access.isVerified() && request === state.reactionRequest && String(state.items[state.viewerIndex]?.id) === String(id) && state.community?.id === String(id);
  }
  function updateCommunityCounts(id, counts) {
    if (!access.isVerified()) return;
    const normalized = communityCounts(counts);
    state.items.forEach(row => { if (String(row.id) === String(id)) row.communityReactions = { ...normalized }; });
    $('results').querySelectorAll('[data-community-id]').forEach(badge => {
      if (badge.dataset.communityId !== String(id)) return;
      badge.querySelector('b').textContent = format(normalized.upvote);
      badge.title = `${format(normalized.upvote)} community upvotes on Search Civitai`;
      badge.setAttribute('aria-label', `${format(normalized.upvote)} community upvotes`);
    });
  }
  function updateCommunityControls() {
    const community = state.community; if (!community) return;
    const locked = layoutPreview || community.loading || community.saving || !community.loaded;
    $('viewerReactions').setAttribute('aria-busy', String(community.loading || community.saving));
    $('viewerReactions').querySelectorAll('[data-reaction]').forEach(button => {
      const type = button.dataset.reaction, active = Boolean(community.mine[type]);
      const label = communityTypes.find(([key]) => key === type)?.[2] || type;
      button.disabled = locked;
      button.setAttribute('aria-pressed', String(active));
      button.setAttribute('aria-label', `${label}: ${format(community.counts[type])}${layoutPreview ? ', read-only layout preview' : active ? ', selected. Click to remove' : '. Click to react'}`);
      button.title = layoutPreview ? 'Reactions are read-only in the layout preview' : `${active ? 'Remove' : 'Add'} ${label.toLowerCase()}`;
      button.querySelector('[data-reaction-count]').textContent = format(community.counts[type]);
    });
    const status = $('communityStatus');
    status.textContent = community.error || (layoutPreview ? 'Layout preview · reactions are read-only' : community.loading ? 'Loading your reactions…' : community.saving ? 'Saving your reaction…' : community.status || 'No account needed · your choices are remembered in this browser');
    status.classList.toggle('is-error', Boolean(community.error));
    $('retryReactions').hidden = !community.error;
    $('retryReactions').disabled = community.loading || community.saving;
  }
  async function requestCommunity(id, options = {}) {
    const controller = options.controller || new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await protectedFetch(`api.php?action=reactions&id=${encodeURIComponent(id)}`, {
        method: options.body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
        ...(options.body ? { body: JSON.stringify(options.body) } : {})
      });
      let data;
      try { data = await response.json(); }
      catch { throw new Error('Reactions are temporarily unavailable. Please try again.'); }
      if (!response.ok || !data.ok) throw new Error(data.error || `Reactions are unavailable (${response.status}).`);
      if (String(data.imageId) !== String(id) || !data.counts || !data.mine || typeof data.csrfToken !== 'string' || !data.csrfToken) throw new Error('Unable to read reactions. Please try again.');
      return data;
    } finally { clearTimeout(timeout); }
  }
  async function loadCommunityReactions() {
    const row = state.items[state.viewerIndex]; if (!access.isVerified() || !row) return;
    const id = String(row.id), request = ++state.reactionRequest;
    state.reactionController?.abort();
    const controller = new AbortController(); state.reactionController = controller;
    state.community = { id, counts: communityCounts(row.communityReactions), mine: {}, csrfToken: '', loaded: false, loading: !layoutPreview, saving: false, error: '', status: '' };
    updateCommunityControls();
    if (layoutPreview) return;
    try {
      // Reopening an image waits for its pending write before fetching a fresh selection.
      const pending = reactionWrites.get(id);
      if (pending) await pending.catch(() => {});
      if (!currentCommunity(id, request)) return;
      const data = await requestCommunity(id, { controller });
      if (!currentCommunity(id, request)) return;
      Object.assign(state.community, { counts: communityCounts(data.counts), mine: data.mine, csrfToken: data.csrfToken, loaded: true, loading: false });
      updateCommunityCounts(id, data.counts);
    } catch (error) {
      if (!currentCommunity(id, request)) return;
      state.community.loading = false;
      state.community.error = error.name === 'AbortError' ? 'Reactions took too long to load. Try again.' : error.message || 'Unable to load reactions. Try again.';
    }
    if (currentCommunity(id, request)) updateCommunityControls();
  }
  function renderCommunityReactions() {
    $('viewerReactions').innerHTML = `<div class="community-reaction-heading"><span>Community reactions</span><span class="community-reaction-brand">Search Civitai</span></div><div class="community-reaction-buttons" role="group" aria-label="React to this image">${communityTypes.map(([type, icon, label]) => `<button type="button" class="community-reaction community-${type}" data-reaction="${type}" aria-pressed="false" disabled><span class="community-reaction-icon" aria-hidden="true">${icon}</span><span class="${type === 'upvote' ? 'community-upvote-label' : 'sr-only'}">${label}</span><b data-reaction-count>0</b></button>`).join('')}</div><div class="community-reaction-feedback"><span id="communityStatus" role="status" aria-live="polite"></span><button type="button" id="retryReactions" hidden>Retry</button></div>`;
    loadCommunityReactions();
  }
  async function toggleCommunityReaction(type) {
    const community = state.community;
    if (!access.isVerified() || layoutPreview || !community || !community.loaded || community.loading || community.saving || !communityTypes.some(([key]) => key === type)) return;
    const id = community.id, request = state.reactionRequest, active = !Boolean(community.mine[type]);
    if (reactionWrites.has(id)) return;
    community.saving = true; community.error = ''; community.status = ''; updateCommunityControls();
    const pending = requestCommunity(id, { body: { id, type, active, csrfToken: community.csrfToken } });
    reactionWrites.set(id, pending);
    try {
      const data = await pending;
      updateCommunityCounts(id, data.counts);
      if (!currentCommunity(id, request)) return;
      Object.assign(community, { counts: communityCounts(data.counts), mine: data.mine, csrfToken: data.csrfToken, status: active ? 'Reaction saved · click again to remove' : 'Reaction removed' });
    } catch (error) {
      if (!currentCommunity(id, request)) return;
      community.loaded = false;
      community.error = error.name === 'AbortError' ? 'Could not confirm your reaction. Retry to refresh.' : error.message || 'Could not save your reaction. Retry to refresh.';
    } finally {
      if (reactionWrites.get(id) === pending) reactionWrites.delete(id);
      if (currentCommunity(id, request)) {
        community.saving = false; updateCommunityControls();
        const button = $('viewerReactions').querySelector(`[data-reaction="${type}"]`);
        if (document.activeElement === document.body || document.activeElement === $('imageViewer')) {
          if (community.error) $('retryReactions').focus(); else button?.focus();
        }
      }
    }
  }
  function renderViewer() {
    const row = state.items[state.viewerIndex]; if (!access.isVerified() || !row) return;
    const absoluteIndex = (state.page - 1) * state.limit + state.viewerIndex;
    const original = mediaUrl(row.downloadUrl, row.id), preview = mediaUrl(row.previewUrl, row.id);
    $('viewerPosition').textContent = `${format(absoluteIndex + 1)} / ${format(state.total)}`;
    $('viewerSource').href = sourceUrl(row);
    $('viewerDownload').hidden = !original;
    $('viewerDownload').href = original || '#';
    $('viewerDownload').setAttribute('download', `civitai-${row.id}`);
    $('viewerMedia').innerHTML = original || preview ? `<img src="${esc(original || preview)}" alt="Indexed image ${esc(row.id)}" decoding="async">` : `<div class="viewer-fallback"><span aria-hidden="true">▧</span><h2>${esc(statusText(row))}</h2><p>You can read the indexed prompt or open the source image on Civitai.</p></div>`;
    markImageErrors($('viewerMedia'));
    renderCommunityReactions();
    const tags = Array.isArray(row.tags) ? row.tags : [], loras = Array.isArray(row.loras) ? row.loras : [];
    $('viewerDetails').innerHTML = `<section class="detail-section detail-identity"><div class="detail-heading"><h1 id="viewerTitle">Image #${esc(row.id)}</h1><span class="detail-style">${esc(styleNames[row.category] || 'Uncertain')}</span></div><p class="detail-meta">${esc(statusText(row))}</p></section>${tags.length ? `<section class="detail-section"><h2>Tags <span>${format(tags.length)}</span></h2><div class="detail-tags">${tags.map(tag => `<button type="button" class="detail-tag" data-tag="${esc(tag)}">${esc(tag)}</button>`).join('')}</div></section>` : ''}<section class="detail-section"><div class="detail-heading"><h2>Prompt</h2>${row.prompt ? '<button type="button" id="copyPrompt" class="copy-button">Copy</button>' : ''}</div><div class="prompt-text">${row.prompt ? esc(row.prompt) : '<span class="muted">No prompt was included in the source metadata.</span>'}</div></section>${row.negativePrompt ? `<details class="detail-section negative-prompt"><summary>Negative prompt</summary><div class="prompt-text">${esc(row.negativePrompt)}</div></details>` : ''}<section class="detail-section"><h2>Generation resources</h2><dl class="resources"><dt>Model</dt><dd>${row.modelName ? `<button type="button" class="resource-name resource-search" data-model="${esc(row.modelName)}" title="Search this model" aria-label="Search images using ${esc(row.modelName)}">${esc(row.modelName)}<span aria-hidden="true">↗</span></button>` : '<span class="muted">Not available</span>'}</dd><dt>LoRAs</dt><dd>${loras.length ? loras.map(name => `<button type="button" class="resource-name resource-search" data-lora="${esc(name)}" title="Search for this LoRA">${esc(name)}<span aria-hidden="true">↗</span></button>`).join('') : '<span class="muted">Not available</span>'}</dd></dl></section><section class="detail-section classification"><h2>Library style</h2><p>${esc(styleNames[row.category] || 'Uncertain')}</p><small>Anime includes fantasy, illustration and animation cues in prompts, tags, model or LoRA names. Other images are sorted as Realistic.</small></section>`;
    $('viewerDetails').querySelectorAll('[data-tag]').forEach(button => {
      const label = `Find all images tagged ${button.dataset.tag}`;
      button.title = label;
      button.setAttribute('aria-label', label);
    });
    $('viewerDetails').querySelector('.detail-identity').insertAdjacentHTML('beforeend', creatorMarkup(row));
    $('viewerDetails').querySelector('.detail-identity').insertAdjacentHTML('afterend', `<section class="detail-section source-reaction-section"><div class="detail-heading"><h2>Civitai source reactions</h2><span class="read-only-label">Read-only</span></div><div class="source-reaction-values">${reactionMarkup(row, true)}</div><p>Last captured while scanning or refreshing Civitai. Community reactions are counted separately on this site.</p></section>`);
    $('viewerPrev').disabled = state.viewerBusy || absoluteIndex <= 0;
    $('viewerNext').disabled = state.viewerBusy || absoluteIndex >= state.total - 1;
    $('viewerStatus').textContent = '';
    $('viewerDetails').scrollTop = 0;
  }
  function openViewer(index, focus) {
    if (!access.isVerified() || !state.items[index]) return;
    state.viewerIndex = index; state.returnFocus = focus || document.activeElement; renderViewer();
    $('imageViewer').showModal(); document.body.classList.add('viewer-open'); $('closeViewer').focus();
  }
  function closeViewer() { if ($('imageViewer').open) $('imageViewer').close(); }
  async function navigateViewer(direction) {
    if (!access.isVerified() || state.viewerBusy || !$('imageViewer').open) return;
    const index = state.viewerIndex + direction;
    if (index >= 0 && index < state.items.length) { state.viewerIndex = index; renderViewer(); return; }
    const target = state.page + direction;
    if (target < 1 || target > state.pages) return;
    state.viewerBusy = true; $('viewerPrev').disabled = true; $('viewerNext').disabled = true;
    const succeeded = await loadPage(target, { keepViewer: true, last: direction < 0 });
    state.viewerBusy = false;
    if (succeeded) renderViewer();
    else {
      const absoluteIndex = (state.page - 1) * state.limit + state.viewerIndex;
      $('viewerPrev').disabled = absoluteIndex <= 0; $('viewerNext').disabled = absoluteIndex >= state.total - 1;
    }
  }
  function search() { if (!access.isVerified()) return; closeViewer(); loadPage(1, { filters: currentFilters() }); }
  function applyFilters() { $('filterPanel').open = false; search(); }
  function clearFilters() { setControls(defaultFilters); applyFilters(); }
  function searchRelated(key, value) {
    setControls({ ...(state.pendingFilters || state.filters), [key]: value });
    applyFilters();
  }
  function searchAllBy(key, value) {
    const name = String(value || '').trim();
    if (!name) return;
    const filters = { ...defaultFilters, [key]: name, sort: (state.pendingFilters || state.filters).sort };
    if (key === 'tag') filters.tagMatch = 'exact';
    setControls(filters);
    $('filterPanel').open = false;
    state.returnFocus = $('resultCount');
    closeViewer();
    loadPage(1, { filters, scroll: true });
  }
  async function loadHealth() {
    if (!access.isVerified()) return;
    const ticket = access.generation;
    try {
      const response = await protectedFetch('api.php?action=health', { headers: { Accept: 'application/json' }, cache: 'no-store' });
      const data = await response.json(); if (!response.ok || !data.ok) throw new Error('Health unavailable');
      if (!access.isVerified() || ticket !== access.generation) return;
      $('health').textContent = `${format(data.counts?.total)} indexed · ${format(data.counts?.ready)} stored`;
    } catch { if (access.isVerified() && ticket === access.generation) $('health').textContent = 'Community image index'; }
  }
  $('searchForm').addEventListener('submit', event => { event.preventDefault(); search(); });
  $('applyFilters').addEventListener('click', applyFilters);
  $('tag').addEventListener('input', () => { delete $('tag').dataset.exactTag; syncTagHelp(); });
  $('creator').addEventListener('input', () => { delete $('creator').dataset.exactCreator; });
  ['tag', 'model', 'lora', 'creator'].forEach(id => $(id).addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); applyFilters(); } }));
  $('qMode').addEventListener('change', search);
  $('sort').addEventListener('change', () => searchRelated('sort', $('sort').value));
  $('clearFilters').addEventListener('click', clearFilters);
  $('counts').addEventListener('click', event => { const button = event.target.closest('[data-category]'); if (button) searchRelated('category', button.dataset.category); });
  $('topics').addEventListener('click', event => { const button = event.target.closest('[data-query]'); if (button) searchRelated('q', button.dataset.query); });
  $('activeFilters').addEventListener('click', event => { const button = event.target.closest('[data-clear-filter]'); if (button) searchRelated(button.dataset.clearFilter, ''); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && $('filterPanel').open && !$('imageViewer').open) { $('filterPanel').open = false; $('filterPanel').querySelector('summary').focus(); } });
  document.addEventListener('click', event => { if ($('filterPanel').open && !event.target.closest('#filterPanel')) $('filterPanel').open = false; });
  $('results').addEventListener('click', event => {
    const button = event.target.closest('.gallery-open');
    if (button) openViewer(Number(button.dataset.index), button);
    else if (event.target.closest('#emptyReset')) clearFilters();
    else if (event.target.closest('#retrySearch')) search();
  });
  $('pagination').addEventListener('click', event => { const button = event.target.closest('[data-page]'); if (button && !button.disabled) loadPage(Number(button.dataset.page), { scroll: true }); });
  $('closeViewer').addEventListener('click', closeViewer);
  $('viewerPrev').addEventListener('click', () => navigateViewer(-1)); $('viewerNext').addEventListener('click', () => navigateViewer(1));
  $('imageViewer').addEventListener('close', () => { document.body.classList.remove('viewer-open'); if (access.isVerified()) state.returnFocus?.focus(); state.viewerIndex = -1; state.reactionRequest++; state.reactionController?.abort(); state.community = null; });
  $('imageViewer').addEventListener('click', event => { if (event.target === $('imageViewer')) closeViewer(); });
  $('imageViewer').addEventListener('keydown', event => {
    if (event.target.closest('input,textarea,select')) return;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); navigateViewer(event.key === 'ArrowLeft' ? -1 : 1); }
  });
  $('viewerDetails').addEventListener('click', async event => {
    const tag = event.target.closest('[data-tag]');
    if (tag) { searchAllBy('tag', tag.dataset.tag); return; }
    const model = event.target.closest('[data-model]');
    if (model) { searchAllBy('model', model.dataset.model); return; }
    const lora = event.target.closest('[data-lora]');
    if (lora) { searchRelated('lora', lora.dataset.lora); return; }
    if (event.target.closest('[data-open-creator]')) { openCreatorPages(); return; }
    const copy = event.target.closest('#copyPrompt'); if (!copy || !access.isVerified()) return;
    try { await navigator.clipboard.writeText(state.items[state.viewerIndex]?.prompt || ''); copy.textContent = 'Copied'; }
    catch { copy.textContent = 'Copy unavailable'; }
  });
  $('viewerReactions').addEventListener('click', event => {
    const button = event.target.closest('[data-reaction]');
    if (button && !button.disabled) toggleCommunityReaction(button.dataset.reaction);
    else if (event.target.closest('#retryReactions')) loadCommunityReactions();
  });
  $('viewerDetails').addEventListener('change', event => {
    if (event.target.id !== 'creatorDomain') return;
    const row = state.items[state.viewerIndex];
    if (!row) return;
    const url = creatorProfileUrl(String(row.creatorName || '').trim().replace(/^@+/, ''), event.target.value);
    const link = $('creatorProfileLink');
    link.hidden = !url;
    if (url) { link.href = url; link.textContent = `${event.target.value.endsWith('.com') ? 'Civitai.com' : 'Civitai.red'} profile ↗`; }
    else link.removeAttribute('href');
    $('creatorFeedback').textContent = '';
  });
  $('layoutPreview').hidden = !layoutPreview;
  const params = new URL(location.href).searchParams;
  const creator = String(params.get('creator') || '').trim().replace(/^@+/, '');
  const initialFilters = { ...defaultFilters };
  if (creator && [...creator].length <= 200 && !creator.includes('\0')) {
    initialFilters.creator = creator;
    initialFilters.creatorMatch = params.get('creatorMatch') === 'exact' ? 'exact' : 'contains';
    if (['newest', 'upvotes', 'civitai_reactions'].includes(params.get('sort'))) initialFilters.sort = params.get('sort');
  }
  setControls(initialFilters);
  function loadUnlockedLibrary() {
    if (!access.isVerified()) return;
    const filters = libraryStarted ? currentFilters() : initialFilters;
    libraryStarted = true; $('layoutPreview').hidden = !layoutPreview; loadHealth(); loadPage(1, { filters });
  }
  window.addEventListener('civitai-access-change', event => {
    if (event.detail?.verified) { if (libraryStarted) loadUnlockedLibrary(); return; }
    state.request++; state.reactionRequest++; state.controller?.abort(); state.reactionController?.abort();
    stopGalleryImages();
    state.returnFocus = null; closeViewer(); state.viewerIndex = -1; state.viewerBusy = false;
    state.items = []; state.community = null; state.pendingFilters = null; state.total = 0; state.page = 1; state.pages = 1;
    $('viewerMedia').replaceChildren(); $('viewerDetails').replaceChildren(); $('viewerReactions').replaceChildren();
    $('viewerSource').href = '#'; $('viewerDownload').href = '#'; $('viewerDownload').hidden = true; $('viewerDownload').removeAttribute('download');
    $('viewerPosition').textContent = ''; $('viewerStatus').textContent = '';
    $('results').innerHTML = skeletonMarkup; $('results').classList.remove('is-empty'); $('results').setAttribute('aria-busy', 'true');
    $('pagination').replaceChildren(); $('health').textContent = 'Community image index'; $('resultCount').textContent = 'Verify to browse the library';
    $('counts').querySelectorAll('span').forEach(span => span.remove());
    $('filterPanel').open = false; $('layoutPreview').hidden = true; $('previewDescription').textContent = '';
  });
  access.ready.then(() => { if (!libraryStarted) loadUnlockedLibrary(); });
})();
