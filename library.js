(() => {
  'use strict';
  const VERSION = '2.8.27', API = 'https://search-civitai.xyz/api.php';
  const $ = id => document.getElementById(id);
  $('panelOpenError').hidden = typeof location === 'undefined' || new URL(location.href).searchParams.get('panelError') !== '1';
  let settingsOpen = false, saving = false, refreshing = false, healthBusy = false, preferenceLoaded = false, preferenceDirty = false, renderedPreference = true;
  let latest = null, revision = 0, statusPort = null, portReady = false, reconnectTimer = null, handshakeTimer = null, reconnectAttempts = 0, disposed = false;
  const count = value => Math.max(0, Number(value) || 0).toLocaleString();
  const amount = value => Math.max(0, Number(value) || 0);
  const message = (text, error = false) => { $('settingsMessage').textContent = text; $('settingsMessage').classList.toggle('error', error); };
  const send = payload => ISSRuntimeRequest(payload);
  function createSpeedControl(onApplied) {
    let applied = 1, requested = null, sending = null, failed = null, profile = null, pending = false, editing = false, supported = false;
    let debounce = null, protectUntil = 0, error = '', changed = false;
    const valid = value => Number.isFinite(Number(value)) && Number(value) >= 1 && Number(value) <= 5 && Number(value) * 2 === Math.round(Number(value) * 2);
    const label = value => `${Number(value).toLocaleString()}×`;
    function render() {
      const target = requested ?? failed ?? sending ?? applied;
      if (!editing) $('collectionSpeed').value = String(target);
      $('collectionSpeed').disabled = !supported;
      $('collectionSpeed').setAttribute('aria-valuetext', `${target} times normal speed`);
      $('speedValue').textContent = label(editing ? $('collectionSpeed').value : target);
      $('speedRetry').hidden = failed === null; $('speedRetry').disabled = !supported || pending;
      $('speedReset').disabled = !supported;
      $('speedStatus').textContent = error || (pending || requested !== null ? `Applying ${label(target)} across all tabs…` : !supported ? 'Checking collection speed…' : changed ? `Applied ${label(applied)} across all tabs.` : `${label(applied)} active across all tabs. Changes apply automatically.`);
      $('speedStatus').classList.toggle('error', Boolean(error));
      $('speedEffective').textContent = profile ? `Prompt readers: ${profile.metadataConcurrency} concurrent · up to ${profile.sourceStartLimit || profile.sourceConcurrency || 1} Civitai starts per ${(profile.sourceIntervalMs / 1000).toLocaleString()}s, ${profile.sourceConcurrency || 1} active maximum · ${profile.outstandingLimit} shared queue limit. Record uploads: up to ${profile.uploadBatchSize} records per batch, ${(profile.uploadIntervalMs / 1000).toLocaleString()}-second pause. Smaller batches are sent when fewer records are ready.` : 'Reading effective collection limits…';
    }
    async function apply() {
      if (disposed || pending || requested === null) return;
      const value = requested; requested = null; sending = value; pending = true; error = ''; render();
      try {
        const result = await send({ type: 'setCollectionSpeed', speedMultiplier: value });
        if (disposed) return;
        const response = result?.config, actual = response?.speedMultiplier ?? result?.collectionSpeed?.multiplier;
        if (!result?.ok || !valid(actual)) throw new Error(result?.error || 'Could not apply collection speed.');
        applied = Number(actual); profile = response?.collectionSpeed || result.collectionSpeed || profile;
        protectUntil = Date.now() + 1000; changed = true; onApplied();
      } catch (failure) {
        if (!disposed && requested === null) { failed = value; error = `Speed was not changed: ${failure.message || 'Try again.'}`; }
      } finally {
        pending = false; sending = null;
        if (!disposed) { render(); if (requested !== null && debounce === null) apply(); }
      }
    }
    function choose(value) {
      if (!supported || !valid(value)) return;
      requested = Number(value); failed = null; error = ''; clearTimeout(debounce);
      debounce = setTimeout(() => { debounce = null; apply(); }, 180); render();
    }
    $('collectionSpeed').addEventListener('input', () => choose($('collectionSpeed').value));
    $('collectionSpeed').addEventListener('pointerdown', () => { editing = true; });
    for (const event of ['change', 'pointerup', 'pointercancel', 'blur']) $('collectionSpeed').addEventListener(event, () => { editing = false; render(); });
    $('speedReset').addEventListener('click', () => { editing = false; choose(1); });
    $('speedRetry').addEventListener('click', () => choose(failed));
    render();
    return {
      accept(config, effective, compatible) {
        const value = config?.speedMultiplier ?? effective?.multiplier;
        supported = compatible && valid(value);
        if (supported && !pending && requested === null && failed === null && !editing && !(Date.now() < protectUntil && Number(value) !== applied)) {
          applied = Number(value); profile = config?.collectionSpeed || effective || profile;
        }
        render();
      },
      dispose() { clearTimeout(debounce); debounce = null; }
    };
  }
  const speedControl = createSpeedControl(() => { revision++; });
  const sourceControl = ISSSourceControl.create({ root: document, send, onApplied(result) { revision++; speedControl.accept(result.config, result.collectionSpeed, true); } });
  function showSettings(open) { settingsOpen = open; $('settingsView').hidden = !open; $('settingsToggle').setAttribute('aria-expanded', String(open)); (open ? $('settingsClose') : $('settingsToggle')).focus?.(); }
  $('settingsToggle').addEventListener('click', () => showSettings(!settingsOpen));
  $('settingsClose').addEventListener('click', () => showSettings(false));
  document.addEventListener?.('keydown', event => { if (event.key === 'Escape' && settingsOpen) { showSettings(false); event.preventDefault?.(); } });
  const downloadControl = ISSDownloadControl.create({ root: document, send, chooseTab: true });
  async function request(action) {
    const headers = { Accept: 'application/json' };
    const response = await fetch(`${API}?action=${action}`, { headers, cache: 'no-store', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(15000) });
    let data;
    try { data = await response.json(); } catch { throw new Error('The server did not return a valid response. Try again shortly.'); }
    if (!response.ok || !data.ok) throw new Error(data.error || `The server returned HTTP ${response.status}.`);
    return data;
  }
  function renderSnapshot(snapshot) {
      $('workerRecovery').hidden = true;
      const { config, browse: status, state: scans, source } = snapshot;
      const pipeline = scans.pipeline || status.pipeline || null;
      const compatible = snapshot.backgroundVersion === VERSION && snapshot.statusProtocol === 1;
      $('connectionStatus').textContent = compatible ? `Background ${snapshot.backgroundVersion} · ${portReady ? 'Live activity updates' : reconnectAttempts >= 5 && !statusPort ? 'Polling activity · live updates unavailable' : 'Polling activity · reconnecting live updates'}` : `This page is v${VERSION}; background ${snapshot.backgroundVersion || 'version unknown (older build)'}. Reload Index Civitai on your browser’s Extensions page, then reopen Browsing & activity. Your Civitai tabs can stay open.`;
      $('connectionStatus').classList.toggle('error', !compatible);
      if (preferenceLoaded && $('autoBrowse').checked !== renderedPreference) preferenceDirty = true;
      if (!preferenceDirty && !saving) { renderedPreference = config.autoBrowse !== false; $('autoBrowse').checked = renderedPreference; preferenceLoaded = true; }
      for (const [id, field, scanField] of [['syncedCount', 'synced', 'catalogSynced'], ['storedCount', 'alreadyStored', 'catalogStoredSkipped'], ['promptlessCount', 'skippedPromptless', 'catalogPromptlessSkipped']]) {
        $(id).textContent = count(amount(status?.[field]) + amount(scans?.status?.[scanField]));
      }
      if (pipeline) { $('syncedCount').textContent = count(pipeline.accepted); $('storedCount').textContent = count(pipeline.alreadyStored); }
      for (const [id, field] of [['discoveredCount', 'discovered'], ['waitingDuplicateCheckCount', 'waitingDuplicateCheck'], ['checkingDuplicatesCount', 'checkingDuplicates'], ['waitingMetadataCount', 'waitingMetadata'], ['readingPromptsCount', 'readingPrompts'], ['readyUploadCount', 'readyUpload'], ['uploadingCount', 'uploading']]) $(id).textContent = pipeline ? count(pipeline[field]) : '—';
      const passivePending = amount(status?.pendingTotal ?? status?.pending), manualPending = amount(scans?.status?.pending);
      $('pendingCount').textContent = pipeline ? `${count(pipeline.outstandingTotal)} / ${count(pipeline.outstandingLimit || 600)}` : count(passivePending + manualPending);
      const shared = pipeline?.globalStages;
      $('sharedQueueStatus').hidden = !shared;
      $('sharedQueueStatus').textContent = shared ? `Shared queue: ${count(amount(shared.waitingDuplicateCheck) + amount(shared.checkingDuplicates) + amount(shared.waitingMetadata) + amount(shared.readingPrompts))} preparing (checks/prompts) · ${count(shared.readyUpload)} ready to send · ${count(shared.uploading)} sending. ${count(pipeline.paused)} paused (included in these counts).${amount(pipeline.recoveringUploads) ? ` ${count(pipeline.recoveringUploads)} saved records are finishing automatically after their source tabs closed or changed.` : ''}` : '';
      $('queueBreakdown').textContent = pipeline ? `${count(pipeline.waitingDuplicateCheck)} waiting for duplicate check · ${count(pipeline.checkingDuplicates)} checking duplicates · ${count(pipeline.waitingMetadata)} waiting to read prompts · ${count(pipeline.readingPrompts)} reading prompts · ${count(pipeline.readyUpload)} records ready to send · ${count(pipeline.uploading)} records being sent. ${amount(pipeline.outstandingTotal) >= 600 ? `Selected gallery scrolling is paused until space is free.${amount(pipeline.paused) > 0 ? ` ${count(pipeline.paused)} images are queued on paused tabs. Resume a paused tab to drain its queue.` : ''}` : 'The 600-image limit is shared across every tab.'}` : `${count(passivePending)} automatic · ${count(manualPending)} feed images waiting or in progress`;
      const activeTabs = amount(scans?.activeTabs);
      $('activeTabCount').textContent = count(activeTabs);
      $('browseState').textContent = !compatible ? 'Reload extension' : activeTabs ? 'Feeds active' : status.suspended ? 'Collection paused' : status.enabled ? 'On' : 'Off';
      const scanStatus = activeTabs ? `${count(activeTabs)} feed ${activeTabs === 1 ? 'tab is' : 'tabs are'} scanning. ` : '';
      $('browseStatus').textContent = scanStatus + (status.suspended ? `Automatic collection paused: ${status.lastError || 'Collection is temporarily unavailable.'}` : status.enabled ? `Visible images are collected as you browse. Only galleries started with Scan this tab scroll automatically, including inactive tabs.${status.lastError ? ` Retrying: ${status.lastError}` : ''}` : 'Automatic browsing collection is off. Start a feed scan from a Civitai tab’s panel.');
      const remaining = Math.max(0, Math.ceil((Math.max(source?.blockedUntil || 0, status?.retryAt || 0) - Date.now()) / 1000));
      const sourceActive = Number(source?.activeCount ?? (source?.active ? 1 : 0)), sourceQueued = Number(source?.queued || 0);
      const catalogWait = Math.max(0, Math.ceil((Number(status?.catalog?.retryAt || 0) - Date.now()) / 1000));
      const sourceWait = Math.max(0, Math.ceil((Number(source?.blockedUntil || 0) - Date.now()) / 1000));
      $('sourceStatus').textContent = `Civitai: ${sourceActive} / ${Number(source?.maxActive || 1)} requests active · ${sourceQueued} waiting for a source turn.` +
        ` ${count(source?.completedLastMinute)} successful requests in the last minute · peak ${count(source?.peakActiveCount)} active this session.` +
        (sourceWait ? ` Civitai cooldown: ${sourceWait}s.` : source?.pauseReason ? ` ${source.pauseReason}` : '') +
        (status?.catalog?.lastError ? ` Server: ${status.catalog.lastError}${catalogWait ? ` Retry in ${catalogWait}s.` : ' Retrying when queued work is ready.'}` :
          remaining && !sourceWait ? ` Collection retry in ${remaining}s.` : '');
      const last = Math.max(Number(status?.lastActivityAt) || 0, Number(scans?.status?.lastActivityAt) || 0);
      $('activityDetails').textContent = `${count(amount(scans?.status?.processed) + amount(status?.processed))} processed · ${count(pipeline ? pipeline.accepted : amount(scans?.status?.catalogSynced) + amount(status?.synced))} accepted · ${count(amount(scans?.status?.catalogOversizeSkipped) + amount(status?.skippedOversize))} oversized skipped (max 9 MP, 4096 pixels per side) · ${String(status?.phase || 'waiting for gallery images').replace(/[-_]/g, ' ')}${last ? ` · last activity ${count(Math.floor(Math.max(0, Date.now() - last) / 1000))}s ago` : ''}`;
      $('activityDetails').textContent += ' · '+count(amount(scans?.status?.catalogRejected)+amount(status?.skippedInvalid))+' invalid metadata set aside';
      const enrichment = status?.reactionEnrichment, stats = status?.sourceReactions;
      if (enrichment) $('activityDetails').textContent += ` · Reaction page lookups: ${count(enrichment.queued)} pending, ${count(enrichment.active)} active, ${count(enrichment.deferred)} in saved backlog. Stats updates: ${count(stats?.queued)} queued, ${count(stats?.deferred)} in saved backlog. Prompt uploads run independently.`;
      const runs = Array.isArray(scans?.runs) ? scans.runs : [];
      $('feedSummary').hidden = !runs.length;
      $('feedRuns').textContent = runs.map(run => {
        let page = 'Civitai';
        try { const url = new URL(run.pageUrl); page = url.hostname + url.pathname + url.search; } catch {}
        const state = run.status?.running ? 'Scanning' : run.recoveringUploads ? 'Sending saved records · source scan paused' : run.feed?.done ? 'Finished' : run.canResume ? 'Paused' : 'Stopped';
        return `Tab ${String(run.tabId)} · ${page}\n${state} · ${count(run.status?.catalogSynced)} records accepted · ${count(run.status?.pending)} queued · ${count(run.status?.processed)} processed${run.status?.phase ? ' · ' + String(run.status.phase) : ''}${run.status?.lastError ? ' · ' + String(run.status.lastError) : ''}`;
      }).join('\n\n');
  }
  function applySnapshot(snapshot) {
    latest = snapshot; revision++;
    sourceControl.accept(snapshot.config, snapshot.state?.pipeline?.collectionSpeed || snapshot.browse?.collectionSpeed, snapshot.backgroundVersion === VERSION && snapshot.statusProtocol === 1);
    speedControl.accept(snapshot.config, snapshot.state?.pipeline?.collectionSpeed || snapshot.browse?.collectionSpeed, snapshot.backgroundVersion === VERSION && snapshot.statusProtocol === 1);
    downloadControl.accept(snapshot.transfers, snapshot.backgroundVersion === VERSION && snapshot.statusProtocol === 1);
    renderSnapshot(snapshot);
  }
  const record = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
  function validSnapshot(value) {
    return value?.type === 'index-civitai-status' && typeof value.backgroundVersion === 'string' && /^\d+\.\d+\.\d+$/.test(value.backgroundVersion) && value.statusProtocol === 1 &&
      record(value.state) && record(value.state.status) && record(value.browse) && record(value.source) && record(value.config);
  }
  function reconnect() {
    if (disposed || reconnectTimer || reconnectAttempts >= 5) return;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connectStatus(); }, Math.min(16000, 1000 * 2 ** reconnectAttempts++));
  }
  function disconnectStatus(port, local = false) {
    if (!port || statusPort !== port) return;
    statusPort = null; portReady = false; clearTimeout(handshakeTimer); handshakeTimer = null;
    if (local) { try { port.disconnect(); } catch {} }
    if (!disposed) { if (latest) renderSnapshot(latest); refreshStatus(); reconnect(); }
  }
  function connectStatus() {
    if (disposed || statusPort) return;
    try {
      const port = chrome.runtime.connect({ name: 'index-civitai-status-v1' }); statusPort = port; portReady = false;
      let portRevision = -1;
      handshakeTimer = setTimeout(() => { if (statusPort === port && !portReady) disconnectStatus(port, true); }, 5000);
      port.onMessage.addListener(value => {
        if (disposed || statusPort !== port || !validSnapshot(value)) return;
        if (Number.isFinite(value.revision)) { if (value.revision <= portRevision) return; portRevision = value.revision; }
        clearTimeout(handshakeTimer); handshakeTimer = null; portReady = true; reconnectAttempts = 0; applySnapshot(value);
      });
      port.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        disconnectStatus(port);
      });
    } catch { statusPort = null; portReady = false; reconnect(); }
  }
  async function refreshStatus() {
    if (disposed || refreshing) return; refreshing = true;
    const before = revision;
    try {
      const [config, status, scans, source, transfers] = await Promise.all([send({ type: 'getConfig' }), send({ type: 'civitai-auto-status' }), send({ type: 'getState' }), send({ type: 'getSourceStatus' }), send({ type: 'getDownloadTabs' })]);
      if (config?.ok === false || status?.ok === false || scans?.ok === false || source?.ok === false) throw new Error(config?.error || status?.error || scans?.error || source?.error || 'Could not read extension status.');
      if (disposed || revision !== before) return;
      applySnapshot({ config, browse: status, state: scans, source, transfers: transfers?.transfers, backgroundVersion: config.backgroundVersion || scans.backgroundVersion || status.backgroundVersion || '', statusProtocol: config.statusProtocol || scans.statusProtocol || status.statusProtocol || 0 });
    } catch (error) { if (!disposed && revision === before) { $('browseState').textContent = 'Unavailable'; $('browseStatus').textContent = error.message; $('workerRecovery').hidden = false; } }
    finally { refreshing = false; }
  }
  async function checkHealth() {
    if (disposed || healthBusy) return; healthBusy = true;
    try {
      const data = await request('health');
      if (disposed) return;
      $('libraryHealth').textContent = `${count(data.counts?.total)} records indexed · ${count(data.counts?.ready)} image files stored`;
      $('serverIndexedCount').textContent = count(data.counts?.total); $('serverStoredCount').textContent = count(data.counts?.ready); $('serverPendingCount').textContent = count(data.counts?.pending);
      $('serverStatus').textContent = 'Shared server totals · refreshes every 10 seconds. The server worker downloads image files from Civitai separately from prompt reading. Accepted records may still have a pending image file.';
    }
    catch (error) { if (!disposed) { $('libraryHealth').textContent = `Library unavailable: ${error.message}`; $('serverStatus').textContent = `Server totals could not refresh: ${error.message}`; } }
    finally { healthBusy = false; }
  }
  function setBusy(value) { saving = value; $('saveSettings').disabled = value; $('autoBrowse').disabled = value; }
  $('browseForm').addEventListener('submit', async event => {
    event.preventDefault(); if (saving) return;
    const autoBrowse = $('autoBrowse').checked;
    setBusy(true); message('Saving browsing preference…');
    try {
      const result = await send({ type: 'saveConfig', autoBrowse });
      if (!result?.ok) throw new Error(result?.error || 'Could not save browsing preference.');
      preferenceDirty = false; renderedPreference = autoBrowse;
      await refreshStatus();
      message(autoBrowse ? 'Saved. Visible-image collection is on. Start Scan this tab in each gallery you want to scroll automatically.' : 'Saved. Automatic browsing collection is off. Your feed scans keep running.');
    } catch (error) { message(error.message || 'Could not save browsing preference.', true); }
    finally { setBusy(false); }
  });
  $('pauseAll').addEventListener('click', async () => {
    $('pauseAll').disabled = true;
    try {
      const result = await send({ type: 'pauseAll' });
      if (!result?.ok) throw new Error(result?.error || 'Could not stop collection.');
      $('autoBrowse').checked = false;
      preferenceDirty = false; renderedPreference = false;
      await refreshStatus(); $('collectionMessage').textContent = 'All collection stopped. Saved scan positions are retained.'; $('collectionMessage').classList.toggle('error', false);
    } catch (error) { $('collectionMessage').textContent = error.message; $('collectionMessage').classList.toggle('error', true); }
    finally { $('pauseAll').disabled = false; }
  });
  $('autoBrowse').addEventListener('change', () => { preferenceDirty = true; });
  $('retryCollector').addEventListener('click', () => refreshStatus());
  $('restartCollector').addEventListener('click', () => {
    $('restartCollector').disabled = true;
    $('browseStatus').textContent = 'Restarting the collector. Reopen Browsing & activity afterwards. Saved queues are retained.';
    try { chrome.runtime.reload(); }
    catch (error) { $('restartCollector').disabled = false; $('browseStatus').textContent = error.message; }
  });
  connectStatus(); refreshStatus(); checkHealth();
  const pollTimer = setInterval(() => { if (!portReady) refreshStatus(); else if (latest) renderSnapshot(latest); downloadControl.tick(); }, 2000);
  const healthTimer = setInterval(checkHealth, 10000);
  globalThis.addEventListener?.('pagehide', () => { disposed = true; speedControl.dispose(); sourceControl.dispose(); downloadControl.dispose(); clearInterval(pollTimer); clearInterval(healthTimer); clearTimeout(reconnectTimer); clearTimeout(handshakeTimer); disconnectStatus(statusPort, true); });
})();
