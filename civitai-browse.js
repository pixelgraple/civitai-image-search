// Collect and advance only image galleries chosen by the person. No focus changes.
(() => {
  'use strict';
  const VERSION = '2.8.13';
  if (location.protocol !== 'https:' || !['civitai.com', 'civitai.red'].includes(location.hostname)) return;
  if (window.__ISS_BROWSE_OBSERVER?.version === VERSION) return;
  window.__ISS_BROWSE_OBSERVER?.dispose?.();
  const MAX_TRACKED = 1200, MAX_SEEN = 5000, DOM_BUDGET = 1600, DISCOVERY_BATCH = 60, METADATA_BATCH = 12, MAX_OUTSTANDING = 600, STEP_DELAY = 2000;
  const observed = new Map(), seen = new Map(), seenReactions = new Map();
  let nextDataText = '', nextDataReactions = new Map(), nextDataUnknown = new Set(), nextDataCreators = new Map();
  let disposed = false, busy = false, timer = null, lastUrl = location.href, retryAt = 0, lastScrollAt = 0, lastManualScrollKey = null, walker = null, epoch = 0, statusEpoch = 0;
  let status = { enabled: false, active: false, scrollAllowed: false };
  function speed() {
    const value = Number((status.collectionSpeed || status.pipeline?.collectionSpeed)?.multiplier);
    return Number.isFinite(value) ? Math.min(5, Math.max(1, Math.round(value * 2) / 2)) : 1;
  }
  const discoveryBatch = () => Math.min(100, Math.round(DISCOVERY_BATCH * speed()));
  const send = message => chrome.runtime.sendMessage(message);
  const imageId = href => { try { const url = new URL(href, location.href); return url.origin === location.origin ? url.pathname.match(/^\/images\/(\d+)\/?$/)?.[1] || '' : ''; } catch { return ''; } };
  function routeAllowed() {
    const path = location.pathname;
    if (/(?:^|\/)(?:create|edit|upload|settings|generate|train|account)(?:\/|$)/i.test(path)) return false;
    if (/^\/models\/\d+\/wizard\/?$/i.test(path) && new URL(location.href).searchParams.has('step')) return false;
    return /^\/(?:images(?:\/\d+)?|models(?:\/\d+(?:\/[^/]+)?)?|user\/[^/]+(?:\/images)?|collections\/\d+(?:\/[^/]+)?|posts\/\d+)?\/?$/.test(path);
  }
  function preview(image) {
    try { const url = new URL(image?.currentSrc || image?.src || ''); return url.protocol === 'https:' && ['image.civitai.com', 'imagecache.civitai.com'].includes(url.hostname) && /\.(?:png|jpe?g|webp)$/i.test(url.pathname) ? url.href : ''; } catch { return ''; }
  }
  function onscreen(node) {
    const rect = node?.getBoundingClientRect?.();
    if (!(rect && rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth)) return false;
    let parent = node.parentElement;
    for (let depth = 0; parent && depth < 18; depth++, parent = parent.parentElement) {
      if (!/^(auto|scroll|hidden|clip|overlay)$/.test(getComputedStyle(parent).overflowY)) continue;
      const bounds = parent.getBoundingClientRect?.();
      if (bounds && (rect.bottom <= bounds.top || rect.top >= bounds.bottom)) return false;
    }
    return true;
  }
  function cardImage(anchor) {
    let node = anchor;
    for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
      if (node === document.body || node === document.documentElement) return null;
      const scan = document.createTreeWalker(node, 1); let image = null, child, inspected = 0;
      while ((child = scan.nextNode()) && ++inspected <= 80) {
        if (child.tagName !== 'IMG' || !preview(child)) continue;
        if (image && image !== child) return null;
        image = child;
      }
      if (inspected > 80) return null;
      if (image) return image;
    }
    return null;
  }
  const reactionAliases = { likeCount: ['likeCount', 'likeCountAllTime'], heartCount: ['heartCount', 'heartCountAllTime'],
    laughCount: ['laughCount', 'laughCountAllTime'], cryCount: ['cryCount', 'cryCountAllTime'],
    buzzCount: ['buzzCount', 'buzzCountAllTime', 'tippedAmountCountAllTime'] };
  function sourceStats(stats) {
    const result = {};
    if (!stats || stats.statsUnknown === true) return result;
    for (const [key, aliases] of Object.entries(reactionAliases)) {
      const value = aliases.map(alias => stats[alias]).find(value => Number.isSafeInteger(value) && value >= 0);
      if (value !== undefined) result[key] = value;
    }
    return result;
  }
  function sourceCreator(image, post = {}) {
    const name = value => {
      if (typeof value !== 'string') return '';
      const normalized = value.trim().replace(/^@/, '');
      return normalized && [...normalized].length <= 200 && !/[\u0000-\u001f\u007f-\u009f]/u.test(normalized) ? normalized : '';
    };
    return name(image?.user?.username) || name(image?.username) ||
      (Array.isArray(post.images) && post.images.some(item => String(item?.id) === String(image?.id))
        ? name(post.user?.username) || name(post.username) : '');
  }
  function pageStats() {
    const text = document.getElementById?.('__NEXT_DATA__')?.textContent || '';
    if (text === nextDataText) return nextDataReactions;
    nextDataText = text; nextDataReactions = new Map(); nextDataUnknown = new Set(); nextDataCreators = new Map();
    if (!text || text.length > 8 * 1024 * 1024) return nextDataReactions;
    try {
      const state = JSON.parse(text)?.props?.pageProps?.trpcState;
      for (const query of (state?.json?.queries || state?.queries || []).slice(0, 200)) {
        const key = query.queryKey?.[0], data = query.state?.data;
        if (!Array.isArray(key) || key[0] !== 'image' || !data) continue;
        const images = key[1] === 'get' ? [{ image: data }] : ['getInfinite', 'getImagesAsPostsInfinite'].includes(key[1])
          ? (data.items || []).flatMap(post => Array.isArray(post.images) ? post.images.map(image => ({ image, post })) : [{ image: post }]) : [];
        for (const { image: item, post } of images.slice(0, 1000)) {
          if (!item || (item.type && item.type !== 'image') || !Number.isSafeInteger(Number(item.id))) continue;
          // Exact image object ID only. Post stats and a neighboring image's
          // counts must never be assigned to the currently viewed image.
          if (key[1] === 'get' && Number(query.queryKey?.[1]?.input?.id) !== Number(item.id)) continue;
          const creatorName = sourceCreator(item, post);
          if (creatorName) nextDataCreators.set(String(item.id), creatorName);
          if (item.stats?.statsUnknown === true) { nextDataUnknown.add(String(item.id)); continue; }
          const stats = sourceStats(item.stats);
          if (Object.keys(stats).length) nextDataReactions.set(String(item.id), stats);
        }
      }
    } catch { /* A new page format is unknown, never a zero count. */ }
    return nextDataReactions;
  }
  function cardRoot(image, id) {
    let root = image.parentElement;
    for (let depth = 0, parent = root?.parentElement; parent && depth < 6; depth++, parent = parent.parentElement) {
      if (parent === document.body || parent === document.documentElement) break;
      const walk = document.createTreeWalker(parent, 1); let node, count = 0, otherImage = false;
      while ((node = walk.nextNode()) && ++count <= 240) {
        if ((node.tagName === 'A' && imageId(node.href) && imageId(node.href) !== id) ||
            (node.tagName === 'IMG' && node !== image && preview(node))) { otherImage = true; break; }
      }
      if (otherImage || count > 240) break;
      root = parent;
    }
    return root;
  }
  function domReactions(root) {
    const result = {}, conflicts = new Set();
    if (!root) return result;
    const walk = document.createTreeWalker(root, 1); let node, visited = 0;
    while ((node = walk.nextNode()) && ++visited <= 240) {
      if (!['BUTTON', 'SPAN', 'DIV', 'A'].includes(node.tagName)) continue;
      const text = String(node.textContent || '').trim();
      if (text.length > 120) continue;
      const attributes = child => ['aria-label', 'title', 'data-reaction', 'data-testid', 'class']
        .map(name => child.getAttribute?.(name) || '').join(' ');
      let labels = text + ' ' + attributes(node), child, inspected = 0;
      const children = document.createTreeWalker(node, 1);
      while ((child = children.nextNode()) && ++inspected <= 24) labels += ' ' + attributes(child);
      if (inspected > 24) continue;
      const matches = [
        ['likeCount', /👍|\b(?:like(?:s|Count)?|thumb(?:s)?[-_ ]?up)\b/i],
        ['heartCount', /❤|❤️|\b(?:heart(?:s|Count)?|love)\b/i],
        ['laughCount', /😂|😆|\b(?:laugh(?:s|Count)?|mood[-_ ](?:xd|happy|laugh))\b/i],
        ['cryCount', /😢|😭|\b(?:cry(?:Count)?|crying|mood[-_ ](?:cry|sad))\b/i],
        ['buzzCount', /⚡|\b(?:buzz(?:Count)?|bolt|tippedAmountCountAllTime)\b/i]
      ].filter(([, pattern]) => pattern.test(labels));
      if (matches.length !== 1) continue;
      // Rounded abbreviations such as1.2K are not exact observed counts.
      // No count rendered means unknown, including an icon-only button.
      const exactText = String(node.getAttribute?.('data-count') ?? text);
      if (/\d\s*[kmb]\b|\d\.\d/i.test(exactText)) continue;
      const numbers = exactText.match(/\d[\d,]*/g);
      if (!numbers || numbers.length !== 1 || !/^\d+$|^\d{1,3}(?:,\d{3})+$/.test(numbers[0])) continue;
      const value = Number(numbers[0].replaceAll(',', '')), key = matches[0][0];
      if (!Number.isSafeInteger(value) || value < 0 || conflicts.has(key)) continue;
      if (result[key] !== undefined && result[key] !== value) { delete result[key]; conflicts.add(key); }
      else result[key] = value;
    }
    return result;
  }
  function reactionsFor(image, id) {
    // Server-rendered exact metadata is preferred to compact UI text.
    const stats = pageStats();
    if (nextDataUnknown.has(id)) return {};
    return { ...domReactions(cardRoot(image, id)), ...(stats.get(id) || {}) };
  }
  const reactionSignature = (reactions, creatorName = '') => JSON.stringify([Object.keys(reactions).sort().map(key => [key, reactions[key]]), creatorName]);
  function resetPage() {
    if (lastUrl === location.href) return;
    lastUrl = location.href; walker = null; lastManualScrollKey = null; observed.clear(); intersection.disconnect(); epoch++;
  }
  const intersection = new IntersectionObserver(() => schedule(), { rootMargin: '0px', threshold: 0.01 });
  const mutation = new MutationObserver(() => schedule());
  function observeCards() {
    for (const [anchor, image] of observed) {
      if (!anchor.isConnected || !image.isConnected) { observed.delete(anchor); intersection.unobserve(image); }
    }
    if (!walker || (walker.currentNode !== document.documentElement && !walker.currentNode.isConnected)) walker = document.createTreeWalker(document.documentElement, 1);
    let node;
    for (let examined = 0; examined < DOM_BUDGET; examined++) {
      node = walker.nextNode();
      if (!node) { walker = null; break; }
      if (node.tagName !== 'A' || observed.has(node) || !imageId(node.href)) continue;
      const image = cardImage(node); if (!image) continue;
      if (observed.size >= MAX_TRACKED) {
        const stale = [...observed].find(([, candidate]) => !onscreen(candidate));
        if (!stale) break;
        observed.delete(stale[0]); intersection.unobserve(stale[1]);
      }
      observed.set(node, image); intersection.observe(image);
    }
  }
  function collectCards() {
    for (const [id, at] of seen) if (Date.now() - at >= 86400000) { seen.delete(id); seenReactions.delete(id); }
    const found = new Map();
    for (const [anchor, image] of observed) {
      const id = imageId(anchor.href), src = preview(image);
      if (!anchor.isConnected || !id || !src || !onscreen(image)) continue;
      const reactions = reactionsFor(image, id);
      const creatorName = nextDataCreators.get(id) || '';
      if (seen.has(id) && ((!Object.keys(reactions).length && !creatorName) || seenReactions.get(id) === reactionSignature(reactions, creatorName))) continue;
      found.set(id, { id, previewUrl: src, width: image.naturalWidth, height: image.naturalHeight, reactions, creatorName });
      if (found.size >= discoveryBatch()) return [...found.values()];
    }
    const detailId = imageId(location.href);
    if (detailId) {
      const scan = document.createTreeWalker(document.documentElement, 1); let node, image = null, area = 0;
      for (let examined = 0; examined < DOM_BUDGET && (node = scan.nextNode()); examined++) {
        if (node.tagName !== 'IMG' || !preview(node) || !onscreen(node)) continue;
        const rect = node.getBoundingClientRect(), next = rect.width * rect.height;
        if (next > area) { image = node; area = next; }
      }
      if (image) {
        const reactions = reactionsFor(image, detailId);
        const creatorName = nextDataCreators.get(detailId) || '';
        if (!seen.has(detailId) || ((Object.keys(reactions).length || creatorName) && seenReactions.get(detailId) !== reactionSignature(reactions, creatorName)))
          found.set(detailId, { id: detailId, previewUrl: preview(image), width: image.naturalWidth, height: image.naturalHeight, reactions, creatorName });
      }
    }
    return [...found.values()].slice(0, discoveryBatch());
  }
  function enabled() { return !disposed && ((status.enabled ?? status.active) || status.manualPaused) && !status.tabPaused && !status.suspended; }
  function paused() { return status.sourcePaused || Date.now() < Math.max(retryAt, Number(status.retryAt) || 0) || Number(status.pipeline?.outstandingTotal ?? status.outstandingTotal ?? status.pendingTotal) >= MAX_OUTSTANDING; }
  function scrollGallery() {
    if (!enabled() || paused() || !status.scrollAllowed || walker || imageId(location.href) || !routeAllowed() || Date.now() - lastScrollAt < STEP_DELAY / speed()) return false;
    const manualKey = status.manualPaused ? Math.floor((Number(status.manualProgress?.processed) || 0) / METADATA_BATCH) : null;
    if (status.manualPaused && manualKey === lastManualScrollKey) return false;
    const image = [...observed.values()].find(onscreen); if (!image) return false;
    let scrollRoot = null, node = image.parentElement;
    for (let depth = 0; node && depth < 18; depth++, node = node.parentElement) {
      if (node.scrollHeight > node.clientHeight + 4 && node.clientHeight > 100 && /^(auto|scroll|overlay)$/.test(getComputedStyle(node).overflowY)) { scrollRoot = node; break; }
    }
    scrollRoot ||= document.scrollingElement || document.documentElement;
    const height = scrollRoot.clientHeight || innerHeight, amount = Math.max(180, Math.min(900, Math.round(height * 0.72)));
    if (scrollRoot.scrollTop + height >= scrollRoot.scrollHeight - 2) return false;
    scrollRoot.scrollBy({ top: amount, left: 0, behavior: 'instant' }); lastScrollAt = Date.now(); lastManualScrollKey = manualKey; return true;
  }
  function applyStatus(next) {
    if (!next || disposed) return;
    const priorSpeed = speed();
    statusEpoch++;
    status = { ...status, ...next, ...(next.ok === false ? { enabled: false, active: false, scrollAllowed: false } : {}) };
    if (enabled()) {
      mutation.observe(document.documentElement, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['href', 'src', 'srcset', 'aria-label', 'title'] });
      if (priorSpeed !== speed()) { clearTimeout(timer); timer = null; schedule(0); }
    }
    else { clearTimeout(timer); timer = null; mutation.disconnect(); intersection.disconnect(); }
  }
  async function scan(provided) {
    if (disposed || busy) return;
    clearTimeout(timer); timer = null; busy = true;
    try {
      const beforeStatus = statusEpoch;
      const current = provided || await send({ type: 'civitai-auto-status' });
      if (!provided && beforeStatus !== statusEpoch) return;
      applyStatus(current);
      resetPage(); if (!enabled() || paused() || !routeAllowed()) return;
      const scanEpoch = epoch, scanStatusEpoch = statusEpoch, pageUrl = location.href;
      observeCards();
      const cards = collectCards().filter(card => !status.manualPaused || Object.keys(card.reactions).length || card.creatorName);
      if (cards.length) {
        const response = await send({ type: 'civitai-auto-cards', pageUrl, cards, ...(status.manualPaused ? { reactionsOnly: true } : {}) });
        if (disposed || scanEpoch !== epoch || pageUrl !== location.href) return;
        if (!response?.ok) throw new Error(response?.error || 'Automatic collection unavailable.');
        if (scanStatusEpoch === statusEpoch) {
          if (response.status) applyStatus(response.status);
          else if (response.pipeline || Number.isFinite(response.outstandingTotal)) applyStatus({ ...(response.pipeline ? { pipeline: response.pipeline } : {}), ...(Number.isFinite(response.outstandingTotal) ? { outstandingTotal: response.outstandingTotal } : {}) });
        }
        for (const id of response.accepted || []) {
          seen.set(String(id), Date.now());
          const card = cards.find(card => card.id === String(id));
          if (card) seenReactions.set(String(id), reactionSignature(card.reactions, card.creatorName));
        }
        while (seen.size > MAX_SEEN) { const id = seen.keys().next().value; seen.delete(id); seenReactions.delete(id); }
        if (response.active === false && !status.manualPaused) return;
        if (!status.manualPaused && collectCards().length) return;
      }
      retryAt = 0; scrollGallery();
    } catch { retryAt = Date.now() + 30000; }
    finally { busy = false; if (enabled()) schedule(2500 / speed()); }
  }
  function schedule(delay = 1500 / speed()) { if (disposed || !enabled() || timer != null) return; timer = setTimeout(() => scan(), delay); }
  async function refresh() {
    const beforeStatus = statusEpoch;
    try { const next = await send({ type: 'civitai-auto-status' }); if (beforeStatus !== statusEpoch) return; applyStatus(next); if (enabled()) schedule(100); }
    catch { if (beforeStatus === statusEpoch) applyStatus({ enabled: false, active: false }); }
  }
  function runtimeMessage(message) {
    if (message?.type === 'civitai-auto-refresh') refresh();
    if (message?.type === 'civitai-auto-pulse') { applyStatus(message.status); scan(message.status); }
  }
  const onNavigation = () => { resetPage(); schedule(100); };
  const onScroll = () => schedule();
  const onVisibility = () => refresh();
  chrome.runtime.onMessage.addListener(runtimeMessage);
  document.addEventListener('visibilitychange', onVisibility);
  addEventListener('popstate', onNavigation); addEventListener('scroll', onScroll, { passive: true });
  const navigationTimer = setInterval(() => { if (location.href !== lastUrl) onNavigation(); }, 5000);
  function dispose() {
    disposed = true; epoch++; clearTimeout(timer); clearInterval(navigationTimer); mutation.disconnect(); intersection.disconnect(); observed.clear();
    chrome.runtime.onMessage.removeListener(runtimeMessage); document.removeEventListener('visibilitychange', onVisibility);
    removeEventListener('popstate', onNavigation); removeEventListener('scroll', onScroll);
  }
  window.__ISS_BROWSE_OBSERVER = { version: VERSION, dispose };
  refresh();
})();
