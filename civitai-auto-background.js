// Observed Civitai cards share the global image pipeline. Metadata stays in the
// durable queue until the server accepts its batch; image bytes stay on server.
globalThis.ISSBrowseCollector = (() => {
  const STORAGE_KEY = 'civitaiBrowseCollectorV1';
  const MAX_PENDING = 600, MAX_SEEN = 2000, MAX_BATCH = 12, SEEN_TTL_MS = 86400000;
  const speed = () => globalThis.ISSCollectionSpeed?.get() || { metadataConcurrency: 12, discoveryBatchSize: 60, imageCooldownMs: 1000 };
  const LEGACY_CANCELLED_MESSAGE = 'This image collection was stopped before it started.';
  const reactions = value => Object.fromEntries(['likeCount', 'heartCount', 'laughCount', 'cryCount', 'buzzCount']
    .filter(key => value?.statsUnknown !== true && Number.isSafeInteger(value?.[key]) && value[key] >= 0).map(key => [key, value[key]]));
  const creatorName = value => {
    if (typeof value !== 'string') return '';
    const name = value.trim().replace(/^@/, '');
    return name && [...name].length <= 200 && !/[\u0000-\u001f\u007f-\u009f]/u.test(name) ? name : '';
  };
  function page(value) {
    try { const url = new URL(value); return url.protocol === 'https:' &&
      ['civitai.com', 'civitai.red'].includes(url.hostname) && !url.username && !url.password ? url : null; }
    catch { return null; }
  }
  function card(value) {
    const id = String(value?.id || '');
    if (!/^\d+$/.test(id) || !Number.isSafeInteger(Number(id)) || Number(id) <= 0) return null;
    try {
      const preview = new URL(value.previewUrl);
      if (preview.protocol !== 'https:' || !['image.civitai.com', 'imagecache.civitai.com'].includes(preview.hostname) ||
          preview.username || preview.password || !/\.(?:png|jpe?g|webp)$/i.test(preview.pathname)) return null;
      return { id, previewUrl: preview.href, reactions: reactions(value.reactions), creatorName: creatorName(value.creatorName),
        ...(Number.isSafeInteger(value.width) && value.width > 0 ? { width: value.width } : {}),
        ...(Number.isSafeInteger(value.height) && value.height > 0 ? { height: value.height } : {}) };
    } catch { return null; }
  }
  function create(deps) {
    let saved = { version: 1, publicMode: true, pending: [], seen: [], tabs: {}, pausedTabs: [],
      suspended: false, synced: 0, processed: 0, skipped: 0, skippedPromptless: 0, skippedOversize: 0, skippedInvalid: 0, lastError: '', retryAt: 0 };
    let busy = false, generation = 0, retryAt = 0, nextPulseAt = 0;
    const tabEpochs = new Map(), inFlight = new Set(), submitting = new Set(), drainingManual = new Set();
    const retiredOwners = new Map(), duplicateChecks = new WeakMap();
    const checkpoint = ISSStateCheckpoint.create({
      capture: () => {
        const value = structuredClone(saved);
        const owned = new Set(value.pending.map(entry => `${entry.tabId}:${entry.card.id}`));
        const retired = [...retiredOwners.values()].filter(owner => !owned.has(`${owner.tabId}:${owner.id}`));
        return { value, retired };
      },
      write: snapshot => deps.save(STORAGE_KEY, snapshot.value),
      committed: (snapshot, latest) => {
        if (latest) for (const owner of snapshot.retired) if (!saved.pending.some(entry => entry.card.id === owner.id && entry.tabId === owner.tabId)) {
          deps.release?.(owner.id, owner.tabId); retiredOwners.delete(`${owner.tabId}:${owner.id}`);
        }
      }
    });
    const persist = () => { deps.changed?.(); return checkpoint.request(); };
    const tabEpoch = id => tabEpochs.get(id) || 0;
    const invalidateTab = id => tabEpochs.set(id, tabEpoch(id) + 1);
    const paused = id => Number.isInteger(id) && saved.pausedTabs.includes(id);
    const freshTab = () => ({ discovered: 0, processed: 0, submitted: 0, alreadyStored: 0, skippedPromptless: 0, skippedOversize: 0, skippedInvalid: 0,
      phase: 'waiting for images', lastActivityAt: 0, lastError: '' });
    const tabState = id => saved.tabs[String(id)] ||= freshTab();
    const touch = (id, phase) => {
      const state = tabState(id); state.lastActivityAt = Date.now(); if (phase) state.phase = phase;
      if (state.lastError === LEGACY_CANCELLED_MESSAGE) state.lastError = '';
      if (saved.lastError === LEGACY_CANCELLED_MESSAGE) saved.lastError = '';
      deps.changed?.();
    };
    const pruneSeen = () => { saved.seen = saved.seen.filter(entry => Date.now() - entry.at < SEEN_TTL_MS).slice(-MAX_SEEN); };
    const markSeen = id => { saved.seen = saved.seen.filter(entry => entry.id !== id); saved.seen.push({ id, at: Date.now() }); pruneSeen(); };
    const configured = async () => { const config = await deps.config(); return config?.apiBase === 'https://search-civitai.xyz/api.php' && config.autoBrowse !== false; };
    const retire = entry => retiredOwners.set(`${entry.tabId}:${entry.card.id}`, { id: entry.card.id, tabId: entry.tabId });
    const remove = entry => { saved.pending = saved.pending.filter(value => value !== entry); retire(entry); };
    const manualDeferred = tabId => deps.manualBusy(tabId) && !deps.capacityBlocked?.();
    function markProcessed(entry) {
      if (entry.processed) return;
      entry.processed = true; saved.processed++; tabState(entry.tabId).processed++; deps.changed?.();
    }
    async function skipOversize(entry) {
      await deps.discardOversizeReactions?.(entry.card.id);
      markProcessed(entry); remove(entry); markSeen(entry.card.id); saved.skippedOversize++;
      tabState(entry.tabId).skippedOversize++; touch(entry.tabId, 'skipped image over 9 MP or 4096 pixels');
      await persist();
    }
    async function init() {
      const value = await deps.load(STORAGE_KEY);
      if (value?.version === 1) saved = { ...saved, ...value,
        pending: (Array.isArray(value.pending) ? value.pending : []).filter(entry => Number.isInteger(entry.tabId) && page(entry.pageUrl) && card(entry.card)).slice(-MAX_PENDING),
        seen: (Array.isArray(value.seen) ? value.seen : []).map(entry => typeof entry === 'string' ? { id: entry, at: Date.now() } : entry)
          .filter(entry => /^\d+$/.test(entry?.id) && Number.isFinite(entry?.at)).slice(-MAX_SEEN),
        pausedTabs: (Array.isArray(value.pausedTabs) ? value.pausedTabs : []).filter(Number.isInteger).slice(-100),
        tabs: value.tabs && typeof value.tabs === 'object' && !Array.isArray(value.tabs) ? value.tabs : {} };
      for (const [id, state] of Object.entries(saved.tabs)) {
        if (!/^\d+$/.test(id) || !state || typeof state !== 'object') { delete saved.tabs[id]; continue; }
        saved.tabs[id] = { ...freshTab(), ...state };
        for (const field of ['discovered', 'processed', 'submitted', 'alreadyStored', 'skippedPromptless', 'skippedOversize', 'skippedInvalid', 'lastActivityAt'])
          saved.tabs[id][field] = Math.max(0, Number(saved.tabs[id][field]) || 0);
        saved.tabs[id].phase = 'waiting to resume';
      }
      for (const entry of saved.pending) {
        if (entry.record) {
          const capturedPageUrl = deps.validCapture?.(entry.card.id, entry.record.capturedPageUrl) || deps.capturePage?.(entry.card.id, entry.pageUrl);
          if (capturedPageUrl) Object.assign(entry.record, { capturedPageUrl, pageUrl: capturedPageUrl });
        }
      }
      saved.processed = Math.max(Number(saved.processed) || 0, Number(saved.synced) || 0);
      saved.publicMode = true; pruneSeen();
      retryAt = Math.max(0, Math.min(Number(saved.retryAt) || 0, Date.now() + 300000)); saved.retryAt = retryAt;
      const queueFull = message => /^The (reaction enrichment|source reaction update) queue is full;/.test(message || '');
      if (queueFull(saved.lastError)) { saved.lastError = ''; retryAt = saved.retryAt = 0; }
      for (const state of Object.values(saved.tabs)) if (queueFull(state.lastError)) state.lastError = '';
      // Earlier versions presented ordinary queue handoff cancellation as an
      // error. Clear that exact marker, while retaining any persisted cooldown.
      let clearedCancellation = false;
      if (saved.lastError === LEGACY_CANCELLED_MESSAGE) { saved.lastError = ''; clearedCancellation = true; }
      for (const state of Object.values(saved.tabs)) if (state.lastError === LEGACY_CANCELLED_MESSAGE) {
        state.lastError = ''; clearedCancellation = true;
      }
      if (clearedCancellation) await persist();
      if (value && !value.publicMode && saved.suspended) {
        saved.suspended = false; saved.lastError = ''; retryAt = saved.retryAt = 0; await persist();
      }
      if (!await configured()) { saved.pending = []; await persist(); }
      for (const entry of saved.pending) deps.admit?.(entry.card.id, entry.tabId, true, deps.checkQueued ? 'waitingDuplicateCheck' : entry.record ? 'readyUpload' : 'waitingMetadata');
    }
    const initialized = init();
    async function status(tabId) {
      await initialized;
      const enabled = await configured(), scoped = Number.isInteger(tabId), state = scoped ? tabState(tabId) : null;
      const pending = scoped ? saved.pending.filter(entry => entry.tabId === tabId).length : saved.pending.length;
      const manualPaused = !!deps.manualBusy(tabId), tabPaused = paused(tabId);
      const active = enabled && !saved.suspended && !tabPaused;
      const phase = !enabled ? 'off' : tabPaused ? 'paused on this tab' : saved.suspended ? 'paused after server rejection'
        : manualPaused ? 'selected feed collecting' : Date.now() < retryAt ? 'waiting to retry'
        : scoped ? state.phase : busy ? 'reading image metadata' : pending ? 'waiting for image worker' : 'waiting for images';
      return { ok: true, enabled, suspended: !!saved.suspended, active,
        busy: scoped ? [...inFlight].some(entry => entry.tabId === tabId) : busy,
        pending, pendingTotal: saved.pending.length,
        pendingRunnableTotal: saved.pending.filter(entry => !paused(entry.tabId) && !manualDeferred(entry.tabId)).length,
        processed: scoped ? state.processed : saved.processed,
        submitted: scoped ? state.submitted : saved.synced, synced: scoped ? state.submitted : saved.synced,
        alreadyStored: scoped ? state.alreadyStored : saved.skipped,
        skippedPromptless: scoped ? state.skippedPromptless : saved.skippedPromptless,
        skippedInvalid: scoped ? state.skippedInvalid : saved.skippedInvalid,
        skippedOversize: scoped ? state.skippedOversize : saved.skippedOversize,
        lastError: scoped ? state.lastError || saved.lastError : saved.lastError,
        manualPaused, tabPaused, phase,
        lastActivityAt: scoped ? state.lastActivityAt : Math.max(0, ...Object.values(saved.tabs).map(value => value.lastActivityAt || 0)),
        retryAt: retryAt > Date.now() ? retryAt : 0 };
    }
    async function accept(message, sender) {
      await initialized;
      const source = page(sender?.url || sender?.tab?.url), reported = page(message?.pageUrl), tabId = sender?.tab?.id;
      if (!Number.isInteger(tabId) || (sender.frameId != null && sender.frameId !== 0) ||
          !source || !reported) return { ok: false, error: 'Auto collection requires the current Civitai page.' };
      // Content-script sender URLs can lag a Civitai client-side navigation.
      // Chrome's current tab URL is authoritative; reported URLs still match exactly.
      const current = page((await deps.tab(tabId))?.url);
      if (!current || current.href !== reported.href) return { ok: false, error: 'Auto collection requires the current Civitai page.' };
      if (deps.statsOnly?.(tabId, reported.href)) message = { ...message, reactionsOnly: true };
      if (!await configured() || saved.suspended || paused(tabId)) return { ok: true, active: false, accepted: [] };
      // A selected feed owns discovery for its tab. Its visual scroll may run,
      // but reporting the same cards must not build a second metadata queue.
      if (deps.manualBusy(tabId) && message.reactionsOnly !== true) return { ok: true, active: true, manualPaused: true, accepted: [] };
      pruneSeen(); const accepted = [], newlyQueued = [];
      for (const value of (Array.isArray(message.cards) ? message.cards : []).slice(0, speed().discoveryBatchSize)) {
        const item = card(value); if (!item) continue;
        if (Object.keys(item.reactions).length || item.creatorName || deps.capturePage?.(item.id, reported.href)) {
          // Already stored/seen images still contribute newly observed counts.
          // This shared metadata queue never requests an image download.
          const queued = saved.pending.find(entry => entry.card.id === item.id);
          if (message.reactionsOnly === true || saved.seen.some(entry => entry.id === item.id) || (queued && submitting.has(queued)))
            await deps.observeReactions?.(item.id, item.reactions, item.creatorName, reported.href);
          if (queued) {
            queued.card.reactions = { ...(queued.card.reactions || {}), ...item.reactions };
            if (queued.record) queued.record.reactions = { ...(queued.record.reactions || {}), ...item.reactions };
            if (item.creatorName) {
              queued.card.creatorName = item.creatorName;
              if (queued.record) queued.record.creatorName = item.creatorName;
            }
          }
        }
        if (message.reactionsOnly === true) { accepted.push(item.id); continue; }
        if (saved.seen.some(entry => entry.id === item.id) || saved.pending.some(entry => entry.card.id === item.id)) { accepted.push(item.id); continue; }
        if (saved.pending.length >= MAX_PENDING) break;
        if (deps.admit && !deps.admit(item.id, tabId, false, deps.checkQueued ? 'waitingDuplicateCheck' : 'waitingMetadata')) break;
        const entry = { tabId, pageUrl: reported.href, card: item };
        saved.pending.push(entry); newlyQueued.push(entry); accepted.push(item.id);
        tabState(tabId).discovered++;
      }
      if (accepted.length) touch(tabId, 'queued for metadata');
      await persist(); startQueuedChecks(newlyQueued); deps.wake?.();
      const pipeline = deps.pipeline?.(tabId);
      return { ok: true, active: true, accepted, pending: saved.pending.filter(entry => entry.tabId === tabId).length, pendingTotal: saved.pending.length,
        ...(pipeline ? { pipeline, outstandingTotal: pipeline.outstandingTotal } : {}) };
    }
    async function dropTab(tabId, nextUrl) {
      await initialized; const next = page(nextUrl); invalidateTab(tabId);
      saved.pending = saved.pending.filter(entry => {
        if (entry.tabId !== tabId) return true;
        if (!next || page(entry.pageUrl)?.origin !== next.origin) { retire(entry); return false; }
        entry.pageUrl = next.href; return true;
      });
      if (!next) saved.pausedTabs = saved.pausedTabs.filter(id => id !== tabId);
      touch(tabId, next ? 'waiting for images' : 'tab closed'); await persist();
    }
    async function pauseTab(tabId) {
      await initialized; invalidateTab(tabId);
      if (!saved.pausedTabs.includes(tabId)) saved.pausedTabs.push(tabId);
      touch(tabId, 'paused on this tab'); await persist();
    }
    async function acknowledgeManual(records) {
      await initialized;
      const ids = new Set((Array.isArray(records) ? records : []).map(record => String(record?.id || '')).filter(id => /^\d+$/.test(id)));
      if (!ids.size) return;
      saved.pending = saved.pending.filter(entry => { if (!ids.has(entry.card.id)) return true; retire(entry); return false; });
      for (const id of ids) markSeen(id);
      await persist();
    }
    async function resumeTab(tabId) {
      await initialized; invalidateTab(tabId);
      saved.pausedTabs = saved.pausedTabs.filter(id => id !== tabId);
      for (const entry of saved.pending) if (entry.tabId === tabId) deps.admit?.(entry.card.id, tabId, false, deps.checkQueued ? 'waitingDuplicateCheck' : entry.record ? 'readyUpload' : 'waitingMetadata');
      if (saved.suspended) { saved.suspended = false; saved.lastError = ''; retryAt = saved.retryAt = 0; }
      touch(tabId, 'waiting for images'); await persist();
      startQueuedChecks(saved.pending.filter(entry => entry.tabId === tabId)); deps.wake?.();
    }
    async function reconfigure() {
      await initialized; generation++; retryAt = saved.retryAt = 0; nextPulseAt = 0;
      saved.suspended = false; saved.lastError = '';
      if (!await configured()) { for (const entry of saved.pending) retire(entry); saved.pending = []; }
      await persist(); deps.wake?.(); return status();
    }
    async function currentEntry(entry, epoch, entryEpoch) {
      if (epoch !== generation || entryEpoch !== tabEpoch(entry.tabId) || paused(entry.tabId) ||
          !await configured() || saved.suspended || (manualDeferred(entry.tabId) && !drainingManual.has(entry))) return false;
      const tab = await deps.tab(entry.tabId);
      return epoch === generation && entryEpoch === tabEpoch(entry.tabId) && !paused(entry.tabId) &&
        (!manualDeferred(entry.tabId) || drainingManual.has(entry)) && !!tab && page(tab.url)?.href === entry.pageUrl && saved.pending.includes(entry);
    }
    function startQueuedChecks(entries) {
      if (!deps.checkQueued || saved.suspended || Date.now() < retryAt) return;
      const epoch = generation;
      const selected = entries.filter(entry => {
        const checked = duplicateChecks.get(entry);
        return saved.pending.includes(entry) && !inFlight.has(entry) && !submitting.has(entry) && !paused(entry.tabId) &&
          (!manualDeferred(entry.tabId) || drainingManual.has(entry)) &&
          !(checked?.epoch === epoch && checked.entryEpoch === tabEpoch(entry.tabId));
      });
      if (!selected.length) return;
      const stillOwned = () => epoch === generation && !saved.suspended && selected.some(entry =>
        saved.pending.includes(entry) && !paused(entry.tabId) && (!manualDeferred(entry.tabId) || drainingManual.has(entry)));
      // Prime the whole discovery group, independently of metadata concurrency
      // and upload pacing. Per-entry waits reuse the root coalescer's results.
      try { Promise.resolve(deps.primeChecks?.(selected.map(entry => entry.card.id), stillOwned)).catch(() => {}); } catch {}
      const failedTabs = new Set();
      for (const entry of selected) {
        const entryEpoch = tabEpoch(entry.tabId);
        checkEntry(entry, epoch, entryEpoch).catch(async error => {
          if (failedTabs.has(entry.tabId)) return;
          failedTabs.add(entry.tabId); await noteFailure(error, entry, epoch, entryEpoch);
        }).catch(error => deps.debug?.('civitai-auto-error', String(error?.message || error)));
      }
    }
    function checkEntry(entry, epoch, entryEpoch) {
      if (!deps.checkQueued) return Promise.resolve(null);
      const existing = duplicateChecks.get(entry);
      if (existing?.epoch === epoch && existing.entryEpoch === entryEpoch) return existing.work;
      const current = () => currentEntry(entry, epoch, entryEpoch);
      const work = (async () => {
        if (!await current()) return null;
        deps.stage?.(entry.card.id, entry.tabId, 'waitingDuplicateCheck');
        touch(entry.tabId, 'checking server duplicates');
        const result = await deps.checkQueued(entry.card.id, current);
        if (!await current() || epoch !== generation || entryEpoch !== tabEpoch(entry.tabId) ||
            !saved.pending.includes(entry) || paused(entry.tabId)) return null;
        if (result?.exists === true) {
          if (result.downloadStatus === 'skipped' && result.skipReason === 'oversize') {
            await skipOversize(entry); return result;
          }
          await deps.observeReactions?.(entry.card.id, entry.card.reactions, entry.card.creatorName,
            result.sourcePageMissing === false ? '' : entry.pageUrl);
          if (deps.needsReactionRefresh?.(entry.card.reactions)) await deps.deferReactions?.(entry);
          // A verified original can still be pending its thumbnail repair. Its
          // source metadata and original transfer do not need to be repeated.
          markProcessed(entry); remove(entry); markSeen(entry.card.id);
          saved.synced++; saved.skipped++;
          const state = tabState(entry.tabId); state.submitted++; state.alreadyStored++; state.lastError = '';
          touch(entry.tabId, 'skipped image already stored on server');
          if (Date.now() >= retryAt) { saved.lastError = ''; retryAt = saved.retryAt = 0; }
          await persist();
        } else deps.stage?.(entry.card.id, entry.tabId, entry.record ? 'readyUpload' : 'waitingMetadata');
        return result;
      })();
      duplicateChecks.set(entry, { epoch, entryEpoch, work });
      const cleanup = () => { if (duplicateChecks.get(entry)?.work === work) duplicateChecks.delete(entry); };
      // A successful missing result belongs to this admission/epoch. Keep it
      // while metadata waits; the uploader and server verify storage again.
      // Withdrawn/failed checks may be retried, never mistaken for a missing ID.
      work.then(value => { if (value == null) cleanup(); }, cleanup); return work;
    }
    async function prepare(entry, epoch, entryEpoch) {
      const current = () => currentEntry(entry, epoch, entryEpoch);
      const tab = await deps.tab(entry.tabId);
      if (!tab || page(tab.url)?.href !== entry.pageUrl) { remove(entry); await persist(); return null; }
      if (!await current()) return null;
      const checked = await checkEntry(entry, epoch, entryEpoch);
      if (checked?.exists === true || !await current()) return null;
      deps.stage?.(entry.card.id, entry.tabId, entry.record ? 'readyUpload' : 'waitingMetadata');
      if (entry.record?.id === entry.card.id && String(entry.record.prompt || '').trim()) {
        const capturedPageUrl = deps.validCapture?.(entry.card.id, entry.record.capturedPageUrl) || deps.capturePage?.(entry.card.id, entry.pageUrl);
        if (capturedPageUrl) Object.assign(entry.record, { capturedPageUrl, pageUrl: capturedPageUrl });
        if (deps.oversize?.(entry.record)) { await skipOversize(entry); return null; }
        return { entry, record: entry.record, current };
      }
      return (deps.processImage || (task => task()))(async () => {
        deps.stage?.(entry.card.id, entry.tabId, 'readingPrompts');
        touch(entry.tabId, 'reading image details');
        const detail = await deps.metadata(entry, 'image.getDetail', current);
        if (!await current()) return null;
        if (!detail || (detail.type && detail.type !== 'image')) { markProcessed(entry); remove(entry); await persist(); return null; }
        // Gallery cards expose thumbnail dimensions. Only original dimensions
        // from source metadata can reject the original before it is downloaded.
        if (deps.oversize?.(detail)) { await skipOversize(entry); return null; }
        touch(entry.tabId, 'reading prompts');
        const generationData = await deps.metadata(entry, 'image.getGenerationData', current);
        if (!await current()) return null;
        let record = deps.record({ ...detail, reactions: entry.card.reactions, id: Number(entry.card.id), type: 'image', url: detail.url || entry.card.previewUrl,
          width: detail.width || entry.card.width, height: detail.height || entry.card.height }, { generation: generationData, detail }, entry.pageUrl);
        if (!record) { markProcessed(entry); remove(entry); await persist(); return null; }
        if (!record.creatorName) record.creatorName = creatorName(entry.card.creatorName);
        if (deps.oversize?.(record)) { await skipOversize(entry); return null; }
        if (!String(record.prompt || '').trim()) {
          const existing = await deps.existing?.(record.id);
          if (!await current()) return null;
          if (String(existing?.prompt || '').trim()) record = { ...record, prompt: existing.prompt };
          else {
            markProcessed(entry); remove(entry); markSeen(entry.card.id); saved.skippedPromptless++;
            tabState(entry.tabId).skippedPromptless++; touch(entry.tabId, 'skipped image without prompt'); await persist(); return null;
          }
        }
        if (deps.deferReactions && (!['likeCount', 'heartCount', 'laughCount', 'cryCount'].every(key =>
          Number.isSafeInteger(record.reactions?.[key]) && record.reactions[key] >= 0) ||
          ['likeCount', 'heartCount', 'laughCount', 'cryCount'].every(key => record.reactions?.[key] === 0))) {
          await deps.deferReactions(entry, record);
          if (!await current()) return null;
        }
        markProcessed(entry); entry.record = record; deps.stage?.(entry.card.id, entry.tabId, 'readyUpload'); touch(entry.tabId, 'prompt ready to submit');
        await persist(); return { entry, record, current };
      }, current);
    }
    async function noteFailure(error, entry, epoch, entryEpoch) {
      // A queued image may be withdrawn by a manual handoff, Stop, navigation,
      // or another collector accepting it. Its old work cannot fail a new run.
      if (epoch !== generation || entryEpoch !== tabEpoch(entry.tabId) || !saved.pending.includes(entry) ||
          error?.code === 'COLLECTION_CANCELLED' || Number(error?.status) === 409) return;
      const tabId = entry.tabId;
      saved.lastError = String(error?.message || 'Auto collection failed.').slice(0, 500);
      if (Number.isInteger(tabId)) { tabState(tabId).lastError = saved.lastError; touch(tabId, 'waiting to retry'); }
      if ([401, 403].includes(Number(error?.status))) { saved.suspended = true; deps.notice?.(); }
      retryAt = Math.max(retryAt, Date.now() + Math.max(30000, Math.min(300000, Number(error?.retryAfterMs) || 30000)));
      saved.retryAt = retryAt; await persist(); deps.debug?.('civitai-auto-error', saved.lastError);
    }
    async function pulse() {
      await initialized;
      if (busy || saved.suspended || Date.now() < Math.max(retryAt, nextPulseAt) || !await configured()) return;
      startQueuedChecks(saved.pending);
      const pulseEpochs = new Map(saved.pending.map(entry => [entry.tabId, tabEpoch(entry.tabId)]));
      const eligible = entry => (!pulseEpochs.has(entry.tabId) || pulseEpochs.get(entry.tabId) === tabEpoch(entry.tabId)) &&
        !inFlight.has(entry) && !submitting.has(entry) && !manualDeferred(entry.tabId) && !paused(entry.tabId);
      if (!saved.pending.some(eligible) || busy) return;
      busy = true; const epoch = generation; nextPulseAt = Date.now() + speed().imageCooldownMs;
      const entries = new Set(), entryEpochs = new Map(), touchedTabs = new Set();
      try {
        await new Promise(resolve => {
          let active = 0, finished = false, unsubscribe;
          const pump = () => {
            if (finished) return;
            if (epoch === generation && !saved.suspended && Date.now() >= retryAt) {
              for (const entry of saved.pending) {
                if (active >= speed().metadataConcurrency) break;
                if (!eligible(entry)) continue;
                if (!pulseEpochs.has(entry.tabId)) pulseEpochs.set(entry.tabId, tabEpoch(entry.tabId));
                if (deps.admit && !deps.admit(entry.card.id, entry.tabId, false, deps.checkQueued ? 'waitingDuplicateCheck' : entry.record ? 'readyUpload' : 'waitingMetadata')) continue;
                entries.add(entry); touchedTabs.add(entry.tabId); entryEpochs.set(entry, tabEpoch(entry.tabId)); active++;
                if (deps.manualBusy(entry.tabId)) drainingManual.add(entry);
                inFlight.add(entry); deps.changed?.();
                (async () => {
                  try {
                    const prepared = await prepare(entry, epoch, entryEpochs.get(entry));
                    if (!prepared || !await prepared.current()) return;
                    // Stream ready records immediately to the paced uploader.
                    submitting.add(entry); touch(entry.tabId, 'prompt ready to submit');
                    submitPrepared(prepared, epoch, entryEpochs.get(entry)).finally(() => {
                      submitting.delete(entry); drainingManual.delete(entry); deps.changed?.();
                    });
                  } catch (error) { await noteFailure(error, entry, epoch, entryEpochs.get(entry)); }
                  finally { active--; entries.delete(entry); entryEpochs.delete(entry); inFlight.delete(entry); deps.changed?.(); pump(); }
                })();
              }
            }
            if (!active) { finished = true; unsubscribe?.(); resolve(); }
          };
          unsubscribe = globalThis.ISSCollectionSpeed?.subscribe(pump); pump();
        });
      } finally {
        busy = false; entries.forEach(entry => { inFlight.delete(entry); if (!submitting.has(entry)) drainingManual.delete(entry); }); deps.changed?.();
        if (epoch === generation) {
          for (const tabId of touchedTabs) {
            if (!paused(tabId) && !manualDeferred(tabId) && Date.now() >= retryAt)
              tabState(tabId).phase = saved.pending.some(entry => entry.tabId === tabId) ? 'waiting for image worker' : 'waiting for images';
          }
          await persist();
        }
      }
    }
    async function submitPrepared({ entry, record, current }, epoch, entryEpoch) {
      try {
        await deps.upsert([record]); if (!await current()) return;
        const result = await deps.sync([record], { required: true, tabId: entry.tabId, isCurrent: current });
        if (!await current()) return;
        if (Number(result?.skippedInvalid)>0) {
          markProcessed(entry);remove(entry);markSeen(entry.card.id);
          saved.skippedInvalid++;tabState(entry.tabId).skippedInvalid++;
          touch(entry.tabId,'invalid metadata set aside; continuing');await persist();return;
        }
        if (Number(result?.skippedOversize) > 0) { await skipOversize(entry); return; }
        const stored = Number(result?.alreadyStored) || 0;
        remove(entry); markSeen(entry.card.id); saved.synced++; saved.skipped += stored;
        tabState(entry.tabId).submitted++; tabState(entry.tabId).alreadyStored += stored; tabState(entry.tabId).lastError = '';
        touch(entry.tabId, 'submitted to server');
        if (Date.now() >= retryAt) { saved.lastError = ''; retryAt = saved.retryAt = 0; }
        await persist();
      } catch (error) { await noteFailure(error, entry, epoch, entryEpoch); }
    }
    function stats(tabId) {
      const values = Number.isInteger(tabId) ? [tabState(tabId)] : Object.values(saved.tabs);
      return values.reduce((result, value) => ({ discovered: result.discovered + (value.discovered || 0),
        accepted: result.accepted + (value.submitted || 0), alreadyStored: result.alreadyStored + (value.alreadyStored || 0),
        skippedInvalid: result.skippedInvalid + (value.skippedInvalid || 0),
        skippedOversize: result.skippedOversize + (value.skippedOversize || 0) }),
      { discovered: 0, accepted: 0, alreadyStored: 0, skippedOversize: 0, skippedInvalid: 0 });
    }
    return { status, stats, accept, pulse, dropTab, reconfigure, initialized, pauseTab, resumeTab, acknowledgeManual,
      isPaused: tabId => paused(tabId) || saved.suspended,
      speedChanged: () => { nextPulseAt = 0; deps.wake?.(); },
      pauseForManual: tabId => { if (Number.isInteger(tabId)) invalidateTab(tabId); else generation++; } };
  }
  return { create, page, card, STORAGE_KEY, MAX_BATCH };
})();
