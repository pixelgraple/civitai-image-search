// Lightweight server-copy checks run independently of prompt uploads. Only a
// verified existing file can skip source metadata and submission work.
globalThis.ISSCatalogChecks = (() => {
  'use strict';
  function validate(ids, result) {
    const expected = new Set(ids), verified = new Set();
    const deferred = result?.deferredIds ?? [];
    if (!Array.isArray(result?.items) || !Array.isArray(deferred) || result.items.length + deferred.length !== ids.length)
      throw new Error('Shared catalog storage check was incomplete. Queued images are retained for retry.');
    for (const item of result.items) {
      if (typeof item?.imageId !== 'string' || !expected.has(item.imageId) || verified.has(item.imageId) ||
          typeof item.exists !== 'boolean' || typeof item.needsDownload !== 'boolean' || item.needsDownload === item.exists ||
          (item.exists && !(item.downloadStatus === 'skipped' && item.skipReason === 'oversize') &&
            (!['ready', 'pending'].includes(item.downloadStatus) || !/^[a-f0-9]{64}$/.test(item.sha256 || ''))))
        throw new Error('Shared catalog returned an invalid storage check. Queued images are retained for retry.');
      verified.add(item.imageId);
    }
    for (const id of deferred) {
      if (typeof id !== 'string' || !expected.has(id) || verified.has(id))
        throw new Error('Shared catalog returned an invalid deferred storage check. Queued images are retained for retry.');
      verified.add(id);
    }
    return result.items;
  }
  function create({ post, changed = () => {}, cooldownUntil = () => 0,
    setTimer = setTimeout, clearTimer = clearTimeout, now = () => Date.now() } = {}) {
    const pending = new Map(), cache = new Map();
    let timer = null, timerAt = 0, busy = false, nextCheckAt = 0;
    const cancelled = () => Object.assign(new Error('Collection was paused.'), { status: 409, code: 'COLLECTION_CANCELLED' });
    const current = async subscriber => { try { return await subscriber.isCurrent() !== false; } catch { return false; } };
    function notify() { try { changed(); } catch {} }
    function cached(id) {
      const value = cache.get(id);
      if (value && value.expires > now()) return value.item;
      cache.delete(id); return null;
    }
    function remember(item) {
      for (const [id, value] of cache) if (value.expires <= now()) cache.delete(id);
      cache.delete(item.imageId);
      cache.set(item.imageId, { item, expires: now() + (item.exists ? 30000 : 10000) });
      while (cache.size > 2000) cache.delete(cache.keys().next().value);
    }
    function schedule() {
      if (busy || !pending.size) return;
      const earliest = Math.min(...[...pending.values()].map(entry => entry.retryAt || 0));
      const wait = Math.max(100, nextCheckAt - now(), cooldownUntil() - now(), earliest - now());
      if (timer !== null && timerAt <= now() + wait) return;
      if (timer !== null) clearTimer(timer);
      timerAt = now() + wait;
      timer = setTimer(() => { timer = null; flush().catch(() => {}); }, wait);
    }
    async function live(entry) {
      for (const subscriber of [...entry.subscribers]) {
        if (!await current(subscriber)) { entry.subscribers.delete(subscriber); subscriber.reject(cancelled()); }
      }
      if (!entry.subscribers.size && pending.get(entry.id) === entry) pending.delete(entry.id);
      return entry.subscribers.size > 0;
    }
    async function flush() {
      if (busy) return;
      if (now() < Math.max(nextCheckAt, cooldownUntil())) { schedule(); return; }
      busy = true; const batch = [];
      try {
        for (const entry of [...pending.values()]) {
          if (!await live(entry)) continue;
          if ((entry.retryAt || 0) > now()) continue;
          entry.checking = true; batch.push(entry);
          if (batch.length === 100) break;
        }
        notify();
        if (!batch.length) return;
        const result = await post(batch.map(entry => entry.id));
        const items = validate(batch.map(entry => entry.id), result);
        const deferred = new Set(result.deferredIds || []);
        const retryDelay = Math.max(1000, Math.min(30000, Number(result.retryAfterMs) || 1000));
        const byId = new Map(items.map(item => [item.imageId, item]));
        for (const entry of batch) {
          if (deferred.has(entry.id)) {
            entry.checking = false; entry.retryAt = now() + retryDelay;
            // Busy files retain their subscribers, but move behind other IDs.
            // A single downloader lock must not stall the whole shared queue.
            if (pending.get(entry.id) === entry) { pending.delete(entry.id); pending.set(entry.id, entry); }
            await live(entry); continue;
          }
          const item = byId.get(entry.id); remember(item);
          if (pending.get(entry.id) === entry) pending.delete(entry.id);
          for (const subscriber of entry.subscribers) {
            if (await current(subscriber)) subscriber.resolve(item); else subscriber.reject(cancelled());
          }
        }
      } catch (error) {
        for (const entry of batch) {
          if (pending.get(entry.id) === entry) pending.delete(entry.id);
          for (const subscriber of entry.subscribers) subscriber.reject(error);
        }
      } finally {
        if (batch.length) nextCheckAt = now() + 1000;
        busy = false; notify(); schedule();
      }
    }
    function check(id, isCurrent = () => true) {
      id = String(id);
      if (!/^[1-9]\d{0,19}$/.test(id) || !Number.isSafeInteger(Number(id))) return Promise.reject(new Error('Invalid queued image ID.'));
      const hit = cached(id);
      if (hit) return current({ isCurrent }).then(valid => { if (!valid) throw cancelled(); return hit; });
      return new Promise((resolve, reject) => {
        let entry = pending.get(id);
        if (!entry) {
          if (pending.size >= 600) { reject(Object.assign(new Error('The shared duplicate-check queue is full.'), { status: 503, retryAfterMs: 1000 })); return; }
          entry = { id, checking: false, retryAt: 0, subscribers: new Set() }; pending.set(id, entry);
        }
        entry.subscribers.add({ isCurrent, resolve, reject }); notify(); schedule();
      });
    }
    return Object.freeze({ check, prime: (ids, isCurrent) => Promise.all([...new Set(ids.map(String))].map(id => check(id, isCurrent))),
      state: id => pending.get(String(id))?.checking ? 'checking' : pending.has(String(id)) ? 'waiting' : null,
      invalidate: id => cache.delete(String(id)),
      snapshot: () => ({ waiting: [...pending.values()].filter(entry => !entry.checking).length,
        checking: [...pending.values()].filter(entry => entry.checking).length, cached: cache.size }),
      wake: () => { if (timer !== null) { clearTimer(timer); timer = null; } schedule(); }
    });
  }
  return Object.freeze({ create, validate });
})();
