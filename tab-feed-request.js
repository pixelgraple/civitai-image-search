// Invoked by the extension's background clock, inside the original Civitai tab.
// This is a same-origin, read-only site request, not a spoofed Origin/Referer.
// Browser-managed cookies remain in the browser and are never returned here.
async function requestCivitaiFeedInTab(requestUrl, expectedOrigin, requestDeadline = Date.now() + 20000) {
  try {
    const remainingMs = Math.min(20000, requestDeadline - Date.now());
    if (!Number.isFinite(remainingMs) || remainingMs <= 0) return {
      ok: false, status: 0, message: 'The source tab did not become available before this request expired.'
    };
    const target = new URL(requestUrl);
    const imagePageId = target.pathname.match(/^\/images\/([1-9]\d{0,19})\/?$/)?.[1];
    if (location.origin !== expectedOrigin || target.origin !== location.origin ||
        target.protocol !== 'https:' || !/^civitai\.(com|red)$/.test(target.hostname) || target.username || target.password ||
        (!(imagePageId && Number.isSafeInteger(Number(imagePageId)) && !target.search && !target.hash) &&
        !['/api/trpc/image.getInfinite', '/api/trpc/image.getImagesAsPostsInfinite',
          '/api/trpc/image.getGenerationData', '/api/trpc/image.getDetail'].includes(target.pathname))) {
      return { ok: false, status: 409, message: 'Keep the original Civitai tab open on Civitai while this run is collecting.' };
    }
    if (['/api/trpc/image.getGenerationData', '/api/trpc/image.getDetail'].includes(target.pathname)) {
      let input;
      try { input = JSON.parse(target.searchParams.get('input'))?.json; } catch {}
      if (target.searchParams.has('batch') || !input || Object.keys(input).length !== 1 ||
          !Number.isSafeInteger(input.id) || input.id <= 0) {
        return { ok: false, status: 409, message: 'Invalid page-scoped image metadata request.' };
      }
    }
    const response = await fetch(target.href, {
      method: 'GET', credentials: 'same-origin', mode: 'same-origin',
      redirect: 'error', cache: 'no-store', headers: { Accept: imagePageId ? 'text/html' : 'application/json' },
      // Browser timeout rather than a throttled page setTimeout callback.
      signal: AbortSignal.timeout(Math.max(1, Math.floor(remainingMs)))
    });
    let data = null;
    try {
      if (!imagePageId) data = await response.json();
      else {
        const html = await response.text();
        if (html.length <= 8 * 1024 * 1024) {
          // Read inert JSON only. Never render the returned page or execute its scripts.
          const text = html.match(/<script\b(?=[^>]*\bid=["']__NEXT_DATA__["'])[^>]*>([\s\S]*?)<\/script>/i)?.[1];
          const state = text ? JSON.parse(text)?.props?.pageProps?.trpcState : null;
          for (const query of (state?.json?.queries || state?.queries || []).slice(0, 200)) {
            const key = query.queryKey?.[0], image = query.state?.data;
            if (key?.[0] === 'image' && key?.[1] === 'get' && Number(query.queryKey?.[1]?.input?.id) === Number(imagePageId) &&
                Number(image?.id) === Number(imagePageId) && (!image.type || image.type === 'image')) {
              data = { id: String(imagePageId), stats: image.stats || {} }; break;
            }
          }
        }
      }
    } catch {}
    return {
      ok: response.ok, status: response.status, data,
      retryAfter: response.headers.get('retry-after'),
      message: !data ? imagePageId ? 'The image page did not include matching reaction metadata. Check the source tab for a site notice.'
        : 'The Civitai tab received a non-JSON response. Check it for a site notice or connection error.' : ''
    };
  } catch (error) {
    return { ok: false, status: 0, message: ['AbortError', 'TimeoutError'].includes(error.name)
      ? 'The Civitai feed request timed out.' : 'The Civitai tab could not reach its feed. Check the connection.' };
  }
}

// Every manual and passive collector shares this queue. Several open tabs must
// not multiply the source site's request rate. A source rejection drains queued
// work immediately; the callers keep their cursors for a later retry.
const ISSCivitaiSourceQueue = (() => {
  const STORAGE_KEY = 'indexCivitaiSourceGuardV1';
  const pending = [];
  const lastServed = new Map();
  let turn = 0;
  const notify = () => { try { globalThis.indexCivitaiStatusChanged?.(); } catch {} };
  const MAX_ACTIVE = 2;
  let initialized, saving = Promise.resolve(), active = 0, timer = null;
  let nextAt = 0, lastStartedAt = 0, cooldownUntil = 0, authStatus = 0, reason = '';
  const speed = () => globalThis.ISSCollectionSpeed?.get() || { sourceIntervalMs: 2000, metadataConcurrency: 12 };
  const pendingLimit = () => Math.max(32, speed().metadataConcurrency + 8,
    (globalThis.ISSImageQueue?.status().active || 0) + 8);
  const storage = () => typeof chrome !== 'undefined' ? chrome.storage?.local : undefined;
  function initialize() {
    if (!initialized) initialized = new Promise(resolve => {
      const local = storage();
      if (!local) { resolve(); return; }
      try { local.get(STORAGE_KEY, value => {
        const saved = value?.[STORAGE_KEY];
        if (saved && typeof saved === 'object') {
          cooldownUntil = Number.isFinite(saved.cooldownUntil) ? Math.max(0, saved.cooldownUntil) : 0;
          authStatus = [401, 403].includes(saved.authStatus) ? saved.authStatus : 0;
          reason = String(saved.reason || '').slice(0, 500);
        }
        void chrome.runtime?.lastError; resolve();
      }); } catch { resolve(); }
    });
    return initialized;
  }
  function persist() {
    const snapshot = { cooldownUntil, authStatus, reason };
    saving = saving.catch(() => {}).then(() => new Promise(resolve => {
      const local = storage();
      if (!local) { resolve(); return; }
      try { local.set({ [STORAGE_KEY]: snapshot }, () => { void chrome.runtime?.lastError; resolve(); }); }
      catch { resolve(); }
    }));
    return saving;
  }
  function blocked() {
    if (authStatus) return Object.assign(new Error(
      `Civitai returned HTTP ${authStatus}. All extension requests to Civitai are paused. Check the site, then deliberately start or resume a scan.`
    ), { status: authStatus, sourcePaused: true });
    const remaining = cooldownUntil - Date.now();
    if (remaining > 0) return Object.assign(new Error(
      `Civitai asked collection to wait. All tabs will wait at least ${Math.ceil(remaining / 1000)} seconds before another source request.`
    ), { status: 429, retryAfterMs: remaining, sourcePaused: true });
    return null;
  }
  function drain(error) {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    for (const entry of pending.splice(0)) entry.reject(error);
    lastServed.clear(); notify();
  }
  async function rejectSource(error) {
    if ([401, 403].includes(error.status)) authStatus = error.status;
    else if (error.status === 429 || (error.status >= 500 && error.status <= 599)) {
      const requested = Number(error.retryAfterMs);
      const delay = Math.max(60000, Number.isFinite(requested) ? requested : 0);
      cooldownUntil = Math.max(cooldownUntil, Date.now() + delay);
      error.retryAfterMs = cooldownUntil - Date.now();
    } else return;
    reason = String(error.message || '').slice(0, 500);
    drain(blocked() || error);
    await persist();
  }
  function pump() {
    if (active >= MAX_ACTIVE || timer !== null || !pending.length) return;
    const stopped = blocked();
    if (stopped) { drain(stopped); return; }
    const delay = nextAt - Date.now();
    if (delay > 0) {
      timer = setTimeout(() => { timer = null; pump(); }, Math.min(delay, 2147483647));
      return;
    }
    // Keep each tab's requests ordered, but give another waiting tab its turn.
    // A page with twelve metadata reads must not hide a new tab's first feed
    // request behind its entire batch. Global pacing remains unchanged.
    const owners = new Set(pending.map(entry => entry.owner));
    for (const owner of lastServed.keys()) if (!owners.has(owner)) lastServed.delete(owner);
    let index = 0;
    for (let candidate = 1; candidate < pending.length; candidate++) {
      if ((lastServed.get(pending[candidate].owner) || 0) < (lastServed.get(pending[index].owner) || 0)) index = candidate;
    }
    const [entry] = pending.splice(index, 1); active++;
    lastStartedAt = Date.now(); nextAt = lastStartedAt + speed().sourceIntervalMs;
    lastServed.set(entry.owner, ++turn); notify();
    Promise.resolve().then(async () => {
      if (!await entry.isCurrent()) throw Object.assign(new Error('This tab stopped collecting before its source request ran.'), { status: 409, sourceCancelled: true });
      const stopped = blocked(); if (stopped) throw stopped;
      return await entry.task();
    }).then(entry.resolve, async error => {
      await rejectSource(error); entry.reject(error);
    }).finally(() => { active--; notify(); pump(); });
    pump();
  }
  globalThis.ISSCollectionSpeed?.subscribe(() => {
    nextAt = lastStartedAt ? lastStartedAt + speed().sourceIntervalMs : 0;
    if (timer !== null) { clearTimeout(timer); timer = null; }
    notify(); pump();
  });
  return {
    initialize,
    async enqueue(task, isCurrent = () => true, owner = null) {
      await initialize();
      const stopped = blocked(); if (stopped) throw stopped;
      if (pending.length >= pendingLimit()) throw Object.assign(new Error('The shared Civitai source queue is full. This feed will retry later.'), { status: 503, retryAfterMs: speed().sourceIntervalMs });
      return new Promise((resolve, reject) => { pending.push({ task, isCurrent, resolve, reject, owner: Number.isInteger(owner) ? owner : null }); notify(); pump(); });
    },
    async resume() {
      await initialize();
      // Manual Start can retry a rejected login/challenge after the user checks
      // the site. It never shortens a server-requested rate-limit cooldown.
      authStatus = 0; reason = ''; await persist(); notify();
      return this.status();
    },
    status() { return { active: active > 0, activeCount: active, maxActive: MAX_ACTIVE, queued: pending.length, intervalMs: speed().sourceIntervalMs, pendingLimit: pendingLimit(), authStatus,
      blockedUntil: cooldownUntil, retryAfterMs: Math.max(0, cooldownUntil - Date.now()),
      pauseReason: authStatus ? `Civitai returned HTTP ${authStatus}. Check the site, then start or resume a scan.`
        : cooldownUntil > Date.now() ? reason || 'Civitai requested a collection cooldown.' : '' }; }
  };
})();

async function resumeCivitaiSourceRequests() { return ISSCivitaiSourceQueue.resume(); }
async function getCivitaiSourceRequestState() { await ISSCivitaiSourceQueue.initialize(); return ISSCivitaiSourceQueue.status(); }
function civitaiRetryAfterMs(value) {
  if (value == null || String(value).trim() === '') return 0;
  const text = String(value).trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const seconds = Number(text);
    return Number.isFinite(seconds) ? Math.min(Number.MAX_SAFE_INTEGER - Date.now(), seconds * 1000) : 0;
  }
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : 0;
}

async function requestCivitaiFeed(tabId, url, pageUrl, isCurrent = () => true) {
  if (!Number.isInteger(tabId)) throw Object.assign(new Error('The original Civitai tab is unavailable. Start from that tab again.'), { status: 409 });
  return ISSCivitaiSourceQueue.enqueue(() => requestCivitaiFeedDirect(tabId, url, pageUrl), isCurrent, tabId);
}

async function requestCivitaiFeedDirect(tabId, url, pageUrl) {
  if (!Number.isInteger(tabId)) throw Object.assign(new Error('The original Civitai tab is unavailable. Start from that tab again.'), { status: 409 });
  let result, timeout;
  try {
    const sourceRequest = chrome.scripting.executeScript({
      target: { tabId }, world: 'MAIN', func: requestCivitaiFeedInTab,
      args: [url, new URL(pageUrl).origin, Date.now() + 20000]
    });
    // A frozen renderer may never invoke the function above. Bound the API
    // wait as well as fetch; its absolute deadline forbids a later stale fetch.
    const results = await Promise.race([sourceRequest, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(Object.assign(new Error('The Civitai source tab did not respond within 20 seconds. Check that the tab is still loaded.'), {
        status: 0, sourceTimeout: true
      })), 21000);
    })]);
    result = results?.[0]?.result;
  } catch (error) {
    if (error?.sourceTimeout) throw error;
    throw Object.assign(new Error('Could not reach the original Civitai tab. Keep it open, then start again.'), { status: 409 });
  } finally { if (timeout !== undefined) clearTimeout(timeout); }
  if (!result?.ok || !result.data || result.data.error) {
    let detail = result?.message || '';
    let trpcError;
    if (result?.data?.error) {
      try { trpcError = ISSFeed.decode(result.data.error); detail = trpcError?.message || detail; } catch {}
    }
    const status = trpcError?.data?.httpStatus || trpcError?.httpStatus ||
      ({ TOO_MANY_REQUESTS: 429, UNAUTHORIZED: 401, FORBIDDEN: 403 }[trpcError?.data?.code]) || result?.status || 0;
    throw Object.assign(new Error(detail || `Civitai returned HTTP ${status}. Check the original tab for the site's explanation.`), {
      status, trpcCode: trpcError?.data?.code,
      retryAfterMs: civitaiRetryAfterMs(result?.retryAfter)
    });
  }
  return result.data;
}
