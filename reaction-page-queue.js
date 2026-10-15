// Optional source-page enrichment is durable and independent of prompt uploads.
globalThis.ISSReactionPages = (() => {
  function create({ load, save, read, observe, changed = () => {}, report = () => {},
    setTimer = setTimeout, clearTimer = clearTimeout, now = () => Date.now() }) {
    const pending = new Map(), seen = new Map();
    let timer = null, busy = false, saving = Promise.resolve(), lastError = '', nextAt = 0;
    const persist = () => {
      const snapshot = { version: 1, pending: [...pending.values()].map(item => ({ ...item })) };
      saving = saving.catch(() => {}).then(() => save(snapshot)); changed(); return saving;
    };
    function validate(item) {
      try {
        const id = String(item?.id || ''), url = new URL(item.pageUrl);
        if (!/^[1-9]\d{0,19}$/.test(id) || !Number.isSafeInteger(Number(id)) || !Number.isInteger(item.tabId) ||
            url.protocol !== 'https:' || !['civitai.com', 'civitai.red'].includes(url.hostname) || url.username || url.password) return null;
        return { id, tabId: item.tabId, pageUrl: url.origin + '/images/' + id,
          attempts: Math.max(0, Number(item.attempts) || 0), retryAt: Math.max(0, Number(item.retryAt) || 0) };
      } catch { return null; }
    }
    function schedule() {
      if (timer !== null || busy || !pending.size) return;
      const first = Math.min(...[...pending.values()].map(item => item.retryAt));
      timer = setTimer(() => { timer = null; flush().catch(report); }, Math.max(1000, first - now(), nextAt - now()));
      timer?.unref?.();
    }
    const initialized = (async () => {
      const value = await load();
      for (const saved of Array.isArray(value?.pending) ? value.pending.slice(-600) : []) {
        const item = validate(saved); if (item) pending.set(item.id, item);
      }
      schedule();
    })();
    async function enqueue(value) {
      await initialized; const item = validate(value); if (!item) throw new Error('Invalid source reaction page.');
      if (pending.has(item.id) || (seen.has(item.id) && now() - seen.get(item.id) < 86400000)) return;
      if (pending.size >= 600) throw Object.assign(new Error('The reaction enrichment queue is full; prepared prompts are retained until it has room.'), { status: 503, retryAfterMs: 3000 });
      pending.set(item.id, item); await persist(); schedule();
    }
    async function flush() {
      await initialized; if (busy) return;
      const item = [...pending.values()].find(item => item.retryAt <= now());
      if (!item || nextAt > now()) { schedule(); return; }
      busy = true; changed();
      try {
        const reactions = await read(item);
        if (pending.get(item.id) !== item) return;
        if (!Object.keys(reactions || {}).length) throw Object.assign(new Error('Image page reactions are not currently available.'), { retryAfterMs: 300000 });
        await observe(item.id, reactions);
        pending.delete(item.id); seen.set(item.id, now());
        while (seen.size > 5000) seen.delete(seen.keys().next().value);
        lastError = '';
      } catch (error) {
        item.attempts++; item.retryAt = now() + Math.max(30000, Number(error?.retryAfterMs) || Math.min(300000, 15000 * 2 ** Math.min(5, item.attempts)));
        lastError = String(error?.message || error); report(error);
      } finally { busy = false; nextAt = now() + 1000; await persist(); schedule(); }
    }
    return { initialized, enqueue, flush,
      discard: async id => {
        await initialized; id = String(id); pending.delete(id); seen.set(id, now());
        while (seen.size > 5000) seen.delete(seen.keys().next().value);
        await persist();
      },
      snapshot: () => ({ queued: pending.size, active: busy ? 1 : 0, lastError }),
      wake: () => { if (timer !== null) { clearTimer(timer); timer = null; } schedule(); } };
  }
  return { create };
})();
