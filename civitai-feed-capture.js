// Remember this tab's feed timings from document_start. This never intercepts
// fetch/XHR, reads responses, or makes requests. Only an explicit Scan action
// may scroll once to let Civitai load its own next batch.
(() => {
  'use strict';
  const VERSION = '2.8.26', MAX_URLS = 32, MAX_URL_LENGTH = 32768;
  const prior = window.__ISS_FEED_CAPTURE;
  if (prior?.version === VERSION) return;
  prior?.dispose?.();
  let pageUrl = location.href, routeStart = 0, disposed = false, observer = null;
  let pending = null;
  const urls = new Map();
  const now = () => performance.now();

  function cancel() { pending?.finish([]); }
  function syncRoute() {
    if (location.href === pageUrl) return false;
    pageUrl = location.href; routeStart = now(); urls.clear(); cancel();
    return true;
  }
  function feedUrl(entry) {
    if (!entry || !Number.isFinite(entry.startTime) || entry.startTime < routeStart ||
        typeof entry.name !== 'string' || entry.name.length > MAX_URL_LENGTH ||
        (entry.initiatorType && !['fetch', 'xmlhttprequest'].includes(entry.initiatorType))) return null;
    try {
      const page = new URL(pageUrl), url = new URL(entry.name);
      if (page.protocol !== 'https:' || !['civitai.com', 'civitai.red'].includes(page.hostname) ||
          url.origin !== page.origin || url.username || url.password || url.hash ||
          !url.pathname.startsWith('/api/trpc/') || !url.searchParams.has('input')) return null;
      const names = decodeURIComponent(url.pathname.slice('/api/trpc/'.length)).split(',');
      if (!names.some(name => ['image.getInfinite', 'image.getImagesAsPostsInfinite'].includes(name))) return null;
      // The request layer validates and decodes the exact filter envelope.
      // Reject timings with no GET-shaped input before offering a feed to it.
      const input = JSON.parse(url.searchParams.get('input'));
      if (!input || !['object', 'string'].includes(typeof input)) return null;
      return url.href;
    } catch { return null; }
  }
  function remember(entries) {
    if (disposed) return;
    syncRoute();
    for (const entry of entries) {
      const url = feedUrl(entry);
      if (!url) continue;
      const old = urls.get(url);
      if (old !== undefined && old >= entry.startTime) continue;
      urls.set(url, entry.startTime);
    }
    // A delayed observer batch may arrive out of order. Keep the most recent
    // requests last because the feed parser selects its newest valid filters.
    const sorted = [...urls].sort((a, b) => a[1] - b[1]).slice(-MAX_URLS);
    urls.clear(); for (const [url, time] of sorted) urls.set(url, time);
    if (urls.size && pending) pending.finish([...urls.keys()]);
  }
  function snapshot() {
    if (disposed) return [];
    syncRoute();
    try { remember(performance.getEntriesByType('resource')); } catch {}
    return [...urls.keys()];
  }
  function scrollOnce() {
    const root = document.scrollingElement || document.documentElement;
    const candidates = [root];
    // Some Civitai layouts scroll a viewport inside the document. Inspect a
    // small, fixed set of landmarks rather than walking the complete gallery.
    try { candidates.push(...[...document.querySelectorAll('[data-scroll-area-viewport], main, [role="main"]')].slice(0, 12)); } catch {}
    const target = candidates.find(element => element && element.scrollHeight > element.clientHeight + 2 &&
      (element === root || /auto|scroll/.test(getComputedStyle(element).overflowY)));
    if (!target) return;
    const current = Math.max(0, Number(target.scrollTop) || 0);
    const bottom = Math.max(0, target.scrollHeight - target.clientHeight);
    const top = Math.min(bottom, current + 12000);
    if (top <= current) return;
    // One finite scroll only: no scroll loop, animation, retry, or restoration.
    if (typeof target.scrollTo === 'function') target.scrollTo({ top, behavior: 'instant' });
    else if (target === root) window.scrollTo({ top, behavior: 'instant' });
  }
  function capture({ timeoutMs = 8000, signal } = {}) {
    if (disposed || signal?.aborted) return Promise.resolve([]);
    const known = snapshot();
    if (known.length) return Promise.resolve(known);
    if (pending) return pending.promise;
    const timeout = Math.min(15000, Math.max(250, Number(timeoutMs) || 8000));
    let settle;
    const promise = new Promise(resolve => { settle = resolve; });
    const job = { promise, timer: null, poll: null, finish(result) {
      if (pending !== job) return;
      pending = null; clearTimeout(job.timer); clearInterval(job.poll);
      signal?.removeEventListener?.('abort', aborted);
      settle(result);
    } };
    const aborted = () => job.finish([]);
    pending = job;
    signal?.addEventListener?.('abort', aborted, { once: true });
    job.timer = setTimeout(() => job.finish(snapshot()), timeout);
    // PerformanceObserver is preferred, but older browsers can still discover
    // a completed request during this bounded, explicit bootstrap window.
    job.poll = setInterval(() => snapshot(), 250);
    try { scrollOnce(); } catch { /* A missing/detached viewport is harmless. */ }
    return promise;
  }

  try {
    observer = new PerformanceObserver(list => remember(list.getEntries()));
    try { observer.observe({ type: 'resource', buffered: true }); }
    catch { observer.observe({ entryTypes: ['resource'] }); }
  } catch { observer = null; }
  const routeChanged = () => syncRoute();
  window.addEventListener('popstate', routeChanged);
  window.addEventListener('hashchange', routeChanged);
  window.navigation?.addEventListener?.('currententrychange', routeChanged);
  // pushState does not emit popstate. The Navigation API handles it on modern
  // Chromium; polling provides a fallback without replacing page functions.
  const routeTimer = setInterval(routeChanged, 500);
  function dispose() {
    if (disposed) return;
    disposed = true; cancel(); urls.clear(); observer?.disconnect(); clearInterval(routeTimer);
    window.removeEventListener('popstate', routeChanged);
    window.removeEventListener('hashchange', routeChanged);
    window.navigation?.removeEventListener?.('currententrychange', routeChanged);
    if (window.__ISS_FEED_CAPTURE?.dispose === dispose) delete window.__ISS_FEED_CAPTURE;
  }
  window.__ISS_FEED_CAPTURE = Object.freeze({ version: VERSION, snapshot, capture, cancel, dispose });
  snapshot();
})();
