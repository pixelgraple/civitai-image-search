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
  const capturedPageUrl = (id, value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && ['civitai.com', 'civitai.red'].includes(url.hostname) &&
        !url.username && !url.password && !url.port && !url.search && !url.hash && url.pathname === `/images/${id}`
        ? url.href : '';
    } catch { return ''; }
  };
  const itemSignature = item => JSON.stringify([signature(item.reactions), creatorName(item.creatorName), capturedPageUrl(item.id, item.capturedPageUrl)]);
  function create({ post, load = async () => null, save = async () => {}, backlog, changed = () => {}, error = () => {},
    cooldownUntil = () => 0, setTimer = setTimeout, clearTimer = clearTimeout, now = () => Date.now() }) {
    const pending = new Map(), sent = new Map();
    let timer = null, scheduledAt = 0, busy = false, retryAt = 0, updated = 0, changedRecords = 0, notInLibrary = 0, lastError = '', persistChain = Promise.resolve(), refilling;
    const live = new Map();
    const persist = () => {
      const snapshot = { version: 1, retryAt, pending: [...pending.values()].map(item => ({ ...item, reactions: { ...item.reactions } })) };
      persistChain = persistChain.catch(() => {}).then(() => save(snapshot)); changed();
      return persistChain;
    };
    function schedule() {
      if (busy || (!pending.size && !backlog?.count())) return;
      const first = Math.min(backlog?.count() ? now() + 3000 : Infinity, ...[...pending.values()].map(item => item.retryAt || 0));
      const delay = Math.max(3000, first - now(), retryAt - now(), cooldownUntil() - now());
      if (timer !== null) { if (scheduledAt <= now() + delay) return; clearTimer(timer); }
      scheduledAt = now() + delay;
      timer = setTimer(() => { timer = null; flush().catch(error); }, delay);
      timer?.unref?.(); // Node harnesses may exit; browser timers are numeric.
    }
    function accept(id, reactions, attempts = 0, observedCreator = '', observedPage = '') {
      id = String(id); reactions = normalize(reactions);
      observedCreator = creatorName(observedCreator);
      observedPage = capturedPageUrl(id, observedPage);
      if (!/^[1-9]\d{0,19}$/.test(id) || !Number.isSafeInteger(Number(id)) || (!Object.keys(reactions).length && !observedCreator && !observedPage)) return false;
      const prior = sent.get(id), old = pending.get(id);
      if (!old && prior && now() - prior.at < 86400000 && (!observedCreator || prior.creatorName === observedCreator) &&
          (!observedPage || prior.capturedPageUrl) &&
          Object.entries(reactions).every(([key, value]) => prior.reactions[key] === value)) return false;
      if (!old && pending.size >= 600) return false;
      const merged = { ...(old?.reactions || {}), ...reactions };
      const mergedCreator = observedCreator || old?.creatorName || '';
      const mergedPage = capturedPageUrl(id, old?.capturedPageUrl) || capturedPageUrl(id, prior?.capturedPageUrl) || observedPage;
      if (old && signature(old.reactions) === signature(merged) && (old.creatorName || '') === mergedCreator &&
          (old.capturedPageUrl || '') === mergedPage) return false;
      pending.set(id, { id, reactions: merged, ...(mergedCreator ? { creatorName: mergedCreator } : {}),
        ...(mergedPage ? { capturedPageUrl: mergedPage } : {}),
        attempts: old?.attempts || attempts, retainMissing: old?.retainMissing === true }); return true;
    }
    const initialized = (async () => {
      await backlog?.ready;
      const saved = await load();
      retryAt = Math.min(now() + 300000, Math.max(0, Number(saved?.retryAt) || 0));
      const items = Array.isArray(saved) ? saved : Array.isArray(saved?.pending) ? saved.pending : [];
      for (const item of items.slice(-600)) {
        accept(item.id, item.reactions, Number(item.attempts) || 0, item.creatorName, item.capturedPageUrl);
        if (pending.has(String(item.id))) Object.assign(pending.get(String(item.id)), { retainMissing: item.retainMissing === true, dropMissing: item.dropMissing === true,
          retryAt: Math.min(now() + 300000, Math.max(0, Number(item.retryAt) || 0)) });
      }
      schedule();
    })();
    function refill() {
      if (refilling) return refilling;
      refilling = (async () => {
        if (!backlog?.count() || pending.size >= 600) return;
        const moved = [];
        for (const row of await backlog.peek(600 - pending.size, now())) {
          if (pending.size >= 600) break;
          const item = row.item, current = pending.get(String(item.id));
          if (!current) {
            accept(item.id, item.reactions, Number(item.attempts) || 0, item.creatorName, item.capturedPageUrl);
            const entry = pending.get(String(item.id));
            if (entry) Object.assign(entry, { retainMissing: item.retainMissing === true, dropMissing: item.dropMissing === true, retryAt: item.retryAt || 0 });
          } else {
            current.reactions = { ...normalize(item.reactions), ...current.reactions };
            current.creatorName ||= creatorName(item.creatorName);
            current.capturedPageUrl ||= capturedPageUrl(item.id, item.capturedPageUrl);
            current.retainMissing ||= item.retainMissing === true;
          }
          moved.push({ id: item.id, revision: row.revision });
        }
        if (moved.length) { await persist(); await backlog.removeMany(moved); }
      })().finally(() => { refilling = null; changed(); });
      return refilling;
    }
    async function observe(id, reactions, { retainMissing = false, dropMissing = false, force = false, liveDom = false, creatorName: observedCreator = '', capturedPageUrl: observedPage = '' } = {}) {
      await initialized;
      id = String(id);
      // A freshly hydrated card is newer than the feed/SSR snapshot. Protect
      // its exact fields briefly, while still accepting real count decreases.
      reactions = normalize(reactions);
      if (liveDom && Object.keys(reactions).length) {
        live.delete(id); live.set(id, { reactions, at: now() });
        while (live.size > 5000) live.delete(live.keys().next().value);
      } else if (live.has(id) && now() - live.get(id).at < 60000)
        reactions = { ...reactions, ...live.get(id).reactions };
      if (force) sent.delete(id);
      const values = normalize(reactions), prior = sent.get(id); observedCreator = creatorName(observedCreator);
      observedPage = capturedPageUrl(id, observedPage);
      if (!pending.has(id) && (pending.size >= 600 || backlog?.count()) && (Object.keys(values).length || observedCreator || observedPage) &&
          !(prior && now() - prior.at < 86400000 && (!observedCreator || prior.creatorName === observedCreator) &&
            (!observedPage || prior.capturedPageUrl) &&
            Object.entries(values).every(([key, value]) => prior.reactions[key] === value))) {
        if (!backlog) throw new Error('Reaction backlog storage is unavailable.');
        if (!/^[1-9]\d{0,19}$/.test(id) || !Number.isSafeInteger(Number(id))) return;
        await backlog.put({ id, reactions: values, creatorName: observedCreator, capturedPageUrl: observedPage,
          retainMissing, dropMissing: dropMissing && !retainMissing, attempts: 0, retryAt: 0 });
        changed(); schedule(); return;
      }
      const previousPending = pending.get(id);
      const accepted = accept(id, reactions, 0, observedCreator, observedPage);
      if (retainMissing && pending.has(id)) pending.get(id).retainMissing = true;
      if (pending.has(id)) pending.get(id).dropMissing = dropMissing && !pending.get(id).retainMissing && (!previousPending || previousPending.dropMissing === true);
      if (!accepted && !(retainMissing && pending.has(id))) return;
      await persist(); schedule();
    }
    async function flush() {
      await initialized;
      if (busy) return;
      if (now() < Math.max(retryAt, cooldownUntil())) { schedule(); return; }
      await refill(); if (busy) return;
      const batch = [...pending.values()].filter(item => !(item.retryAt > now())).slice(0, 60).map(item => ({ ...item, reactions: { ...item.reactions } }));
      if (!batch.length) { schedule(); return; }
      busy = true;
      try {
        const result = await post(batch.map(({ id, reactions, creatorName, capturedPageUrl }) => ({ id, reactions,
          ...(creatorName ? { creatorName } : {}), ...(capturedPageUrl ? { capturedPageUrl } : {}) })));
        const ids = new Set(batch.map(item => item.id));
        const missing = new Set((result?.missingIds || []).map(String));
        if (![...missing].every(id => ids.has(id)) || Number(result?.accepted) + missing.size !== batch.length)
          throw new Error('Source reaction update was incomplete; retaining metadata for retry.');
        for (const item of batch) {
          const current = pending.get(item.id);
          if (missing.has(item.id)) {
            // A DOM count may arrive before that image's prompt insert. Retry
            // briefly, without ever creating a promptless catalog record.
            if (current) {
              current.attempts++;
              if (current.dropMissing || (current.attempts >= 10 && !current.retainMissing)) { pending.delete(item.id); notInLibrary++; }
              else {
                const deferred = { ...current, reactions: { ...current.reactions },
                  retryAt: now() + Math.min(300000, 15000 * 2 ** Math.min(5, current.attempts - 1)) };
                if (backlog) {
                  await backlog.put(deferred);
                  // A newer observation arriving during the disk write stays active.
                  if (pending.get(item.id) === current) pending.delete(item.id);
                } else { pending.delete(item.id); pending.set(item.id, deferred); }
              }
            }
            continue;
          }
          const previous = sent.get(item.id);
          sent.delete(item.id); sent.set(item.id, { reactions: { ...previous?.reactions, ...item.reactions },
            creatorName: item.creatorName || previous?.creatorName || '', capturedPageUrl: previous?.capturedPageUrl || item.capturedPageUrl || '', at: now() }); updated++;
          if (current && itemSignature(current) === itemSignature(item)) pending.delete(item.id);
        }
        while (sent.size > 5000) sent.delete(sent.keys().next().value);
        changedRecords += Number(result.updated) || 0; lastError = '';
        retryAt = 0; // Missing images wait individually; existing-image updates keep flowing.
      } catch (cause) {
        lastError = String(cause?.message || cause);
        retryAt = now() + Math.max(30000, Number(cause?.retryAfterMs) || 0, cause?.status === 429 ? 60000 : 0);
        error(cause);
      } finally { busy = false; await persist(); schedule(); }
    }
    return { initialized, observe, flush,
      discard: async id => { await initialized; pending.delete(String(id)); await persist(); await backlog?.remove(String(id)); changed(); schedule(); },
      snapshot: () => ({ queued: pending.size + (backlog?.count() || 0), deferred: backlog?.count() || 0,
        busy, updated, changed: changedRecords, notInLibrary, retryAt, lastError }),
      wake: () => { if (timer !== null) { clearTimer(timer); timer = null; } schedule(); } };
  }
  return Object.freeze({ create, normalize, signature, creatorName, capturedPageUrl });
})();
