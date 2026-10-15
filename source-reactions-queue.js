// Small metadata-only updates share one queue across every Civitai tab.
// Missing values stay missing; an observed zero is a valid source count.
globalThis.ISSSourceReactions = (() => {
  const KEYS = ['likeCount', 'heartCount', 'laughCount', 'cryCount', 'buzzCount'];
  const normalize = value => Object.fromEntries(KEYS.filter(key => value?.statsUnknown !== true && Number.isSafeInteger(value?.[key]) && value[key] >= 0)
    .map(key => [key, value[key]]));
  const signature = value => JSON.stringify(normalize(value));
  const creatorName = value => {
    if (typeof value !== 'string') return '';
    const name = value.trim().replace(/^@/, '');
    return name && [...name].length <= 200 && !/[\u0000-\u001f\u007f-\u009f]/u.test(name) ? name : '';
  };
  const itemSignature = item => JSON.stringify([signature(item.reactions), creatorName(item.creatorName)]);
  function create({ post, load = async () => null, save = async () => {}, changed = () => {}, error = () => {},
    cooldownUntil = () => 0, setTimer = setTimeout, clearTimer = clearTimeout, now = () => Date.now() }) {
    const pending = new Map(), sent = new Map();
    let timer = null, busy = false, retryAt = 0, updated = 0, persistChain = Promise.resolve();
    const persist = () => {
      const snapshot = { version: 1, retryAt, pending: [...pending.values()].map(item => ({ ...item, reactions: { ...item.reactions } })) };
      persistChain = persistChain.catch(() => {}).then(() => save(snapshot)).catch(error); changed();
      return persistChain;
    };
    function schedule() {
      if (timer !== null || busy || !pending.size) return;
      timer = setTimer(() => { timer = null; flush().catch(error); }, Math.max(3000, retryAt - now(), cooldownUntil() - now()));
      timer?.unref?.(); // Node harnesses may exit; browser timers are numeric.
    }
    function accept(id, reactions, attempts = 0, observedCreator = '') {
      id = String(id); reactions = normalize(reactions);
      observedCreator = creatorName(observedCreator);
      if (!/^[1-9]\d{0,19}$/.test(id) || !Number.isSafeInteger(Number(id)) || (!Object.keys(reactions).length && !observedCreator)) return false;
      const prior = sent.get(id), old = pending.get(id);
      if (!old && prior && now() - prior.at < 86400000 && (!observedCreator || prior.creatorName === observedCreator) &&
          Object.entries(reactions).every(([key, value]) => prior.reactions[key] === value)) return false;
      if (!old && pending.size >= 600) return false;
      const merged = { ...(old?.reactions || {}), ...reactions };
      const mergedCreator = observedCreator || old?.creatorName || '';
      if (old && signature(old.reactions) === signature(merged) && (old.creatorName || '') === mergedCreator) return false;
      pending.set(id, { id, reactions: merged, ...(mergedCreator ? { creatorName: mergedCreator } : {}),
        attempts: old?.attempts || attempts, retainMissing: old?.retainMissing === true }); return true;
    }
    const initialized = (async () => {
      const saved = await load();
      retryAt = Math.min(now() + 300000, Math.max(0, Number(saved?.retryAt) || 0));
      const items = Array.isArray(saved) ? saved : Array.isArray(saved?.pending) ? saved.pending : [];
      for (const item of items.slice(-600)) {
        accept(item.id, item.reactions, Number(item.attempts) || 0, item.creatorName);
        if (pending.has(String(item.id))) pending.get(String(item.id)).retainMissing = item.retainMissing === true;
      }
      schedule();
    })();
    async function observe(id, reactions, { retainMissing = false, creatorName: observedCreator = '' } = {}) {
      await initialized;
      id = String(id);
      const values = normalize(reactions), prior = sent.get(id); observedCreator = creatorName(observedCreator);
      if (!pending.has(id) && pending.size >= 600 && (Object.keys(values).length || observedCreator) &&
          !(prior && now() - prior.at < 86400000 && (!observedCreator || prior.creatorName === observedCreator) &&
            Object.entries(values).every(([key, value]) => prior.reactions[key] === value)))
        throw Object.assign(new Error('The source reaction update queue is full; enrichment will retry.'), { status: 503, retryAfterMs: 3000 });
      const accepted = accept(id, reactions, 0, observedCreator);
      if (retainMissing && pending.has(id)) pending.get(id).retainMissing = true;
      if (!accepted && !(retainMissing && pending.has(id))) return;
      await persist(); schedule();
    }
    async function flush() {
      await initialized;
      if (busy) return;
      if (now() < Math.max(retryAt, cooldownUntil())) { schedule(); return; }
      const batch = [...pending.values()].slice(0, 60).map(item => ({ ...item, reactions: { ...item.reactions } }));
      if (!batch.length) return;
      busy = true;
      try {
        const result = await post(batch.map(({ id, reactions, creatorName }) => ({ id, reactions, ...(creatorName ? { creatorName } : {}) })));
        const ids = new Set(batch.map(item => item.id));
        const missing = new Set((result?.missingIds || []).map(String));
        if (![...missing].every(id => ids.has(id)) || Number(result?.accepted) + missing.size !== batch.length)
          throw new Error('Source reaction update was incomplete; retaining metadata for retry.');
        for (const item of batch) {
          const current = pending.get(item.id);
          if (missing.has(item.id)) {
            // A DOM count may arrive before that image's prompt insert. Retry
            // briefly, without ever creating a promptless catalog record.
            if (current) { current.attempts++; if (current.attempts >= 10 && !current.retainMissing) pending.delete(item.id); }
            continue;
          }
          const previous = sent.get(item.id);
          sent.delete(item.id); sent.set(item.id, { reactions: { ...previous?.reactions, ...item.reactions },
            creatorName: item.creatorName || previous?.creatorName || '', at: now() }); updated++;
          if (current && itemSignature(current) === itemSignature(item)) pending.delete(item.id);
        }
        while (sent.size > 5000) sent.delete(sent.keys().next().value);
        retryAt = missing.size ? now() + 15000 : 0;
      } catch (cause) {
        retryAt = now() + Math.max(30000, Number(cause?.retryAfterMs) || 0, cause?.status === 429 ? 60000 : 0);
        error(cause);
      } finally { busy = false; await persist(); schedule(); }
    }
    return { initialized, observe, flush,
      discard: async id => { await initialized; pending.delete(String(id)); await persist(); },
      snapshot: () => ({ queued: pending.size, busy, updated }),
      wake: () => { if (timer !== null) { clearTimer(timer); timer = null; } schedule(); } };
  }
  return Object.freeze({ create, normalize, signature, creatorName });
})();
