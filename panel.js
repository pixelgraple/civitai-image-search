// Civitai controls run in an isolated world. Public indexing needs no setup.
(() => {
  'use strict';
  const VERSION = '2.8.14', ROOT_ID = '__iss_panel_root';
  if (window.__ISS_PANEL_VERSION === VERSION) { window.__ISS_TOGGLE_PANEL?.(); return; }
  window.__ISS_DISPOSE_PANEL?.();
  document.getElementById(ROOT_ID)?.remove();
  window.__ISS_PANEL_VERSION = VERSION;
  let state = null, browse = null, source = null, message = '', messageError = false;
  let starting = false, refreshing = false, disposed = false;
  let startEpoch = 0, captureController = null;
  let backgroundVersion = '', statusProtocol = 0, workerChecked = false, statusPort = null, portReady = false, reconnectTimer = null, handshakeTimer = null, reconnectAttempts = 0, revision = 0;
  const root = document.createElement('div'); root.id = ROOT_ID;
  const panel = root.attachShadow({ mode: 'open' });
  panel.innerHTML = `
    <style>
      :host{all:initial;position:fixed;top:16px;right:16px;z-index:2147483647;width:min(360px,calc(100vw - 32px));color-scheme:dark}
      *{box-sizing:border-box}.shell{font:13px/1.5 "Segoe UI",system-ui,sans-serif;color:#e9edf5;background:#191b20;border:1px solid #41454f;border-radius:12px;box-shadow:0 18px 60px #0009;overflow:hidden;max-height:calc(100dvh - 32px);overflow-y:auto}
      header{display:flex;gap:10px;align-items:center;padding:16px;border-bottom:1px solid #30343b}.mark{width:34px;height:34px;border:1px solid #375d82;border-radius:8px;background:#203348;color:#7dc0ff;display:grid;place-items:center;font-size:20px}h2{margin:0;font-size:16px;line-height:1.3}small{font-size:11px;color:#a0a7b5}.close{margin-left:auto;border:0;background:transparent;color:#b5bdcc;font-size:22px;padding:0 7px}
      main{padding:15px 16px}p{margin:0 0 12px}.hint{font-size:11px;color:#a0a7b5}.state{display:flex;gap:7px;align-items:center;color:#a6c4e4;font-size:12px}.dot{width:7px;height:7px;background:#6b7484;border-radius:50%}.dot.on{background:#77d4a4}.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin:14px 0}.stat{background:#121419;border:1px solid #30343b;padding:10px 4px;border-radius:7px;text-align:center}.stat b{display:block;font-size:20px;font-variant-numeric:tabular-nums}.stat span{font-size:10px;color:#a0a7b5}.status{font-size:12px;color:#c2c9d6;overflow-wrap:anywhere;min-height:36px}.error{color:#ffb7c0}.browse{border-top:1px solid #30343b;padding-top:12px;font-size:11px;color:#a0a7b5}.actions{display:flex;gap:8px;padding:0 16px 15px}.actions button{flex:1}.links{display:flex;justify-content:space-between;gap:8px;padding:12px 16px;border-top:1px solid #30343b;background:#15171c}
      button,a{font:inherit;cursor:pointer}button{border:1px solid #444a56;border-radius:7px;padding:9px 10px;background:#282c34;color:#e9edf5}button.primary{background:#1976c4;border-color:#398bd0;color:white;font-weight:600}button:disabled{opacity:.45;cursor:not-allowed}.links button{font-size:11px;padding:6px 9px}.links a{color:#91caff;font-size:12px;text-decoration:none;align-self:center}:is(button,a):focus-visible{outline:2px solid #91caff;outline-offset:3px}[hidden]{display:none!important}
      .speed-wrap{padding:0 16px 15px}.speed-control{margin-top:0;padding-top:14px;border-top:1px solid #30343b}.speed-heading{display:flex;align-items:center;justify-content:space-between;font-weight:600}.speed-heading output{color:#8ac9ff;font-size:18px;font-variant-numeric:tabular-nums}.speed-control input[type=range]{display:block;width:100%;height:30px;margin:6px 0 0;accent-color:#3198ed;cursor:pointer}.speed-scale{display:flex;justify-content:space-between;font-size:10px;color:#a0a7b5;margin-bottom:10px}.speed-actions{display:flex;gap:7px}.speed-actions button{font-size:11px;padding:6px 9px}.speed-control .hint{margin-bottom:8px}.speed-control .error{color:#ffb7c0}.speed-control input:focus-visible{outline:2px solid #91caff;outline-offset:3px}
    </style>
    <section class="shell" role="region" aria-label="Index Civitai">
      <header><span class="mark" aria-hidden="true">⌗</span><div><h2>Index Civitai</h2><small>This tab · server collection · v${VERSION}</small></div><button id="close" class="close" aria-label="Hide Index Civitai" title="Hide panel; indexing continues">×</button></header>
      <main><p class="state"><i id="dot" class="dot"></i><span id="runState">Ready to index</span></p><p id="connectionStatus" class="hint" role="status"></p><div class="stats"><div class="stat"><b id="synced">0</b><span>Records accepted</span></div><div class="stat"><b id="stored">0</b><span>Copies skipped</span></div><div class="stat"><b id="promptless">0</b><span>No prompt</span></div></div><p id="queueStatus" class="hint" role="status"></p><p id="pipelineStats" class="hint" role="status"></p><p id="status" class="status" role="status" aria-live="polite"></p><p id="sourceNotice" class="hint" role="status"></p><p id="activity" class="hint" role="status"></p><p id="sourceStatus" class="hint" role="status"></p><p class="hint">This tab’s automatic and feed counts are combined above. The server downloads image files after records are accepted. Shared file counts are in Browsing &amp; activity. Images without a positive prompt are skipped.</p><div id="browse" class="browse">Checking automatic scrolling…</div></main>
      <div class="speed-wrap"><section class="speed-control" aria-labelledby="speedHeading"><div class="speed-heading"><label id="speedHeading" for="collectionSpeed">Collection speed</label><output id="speedValue" for="collectionSpeed">1×</output></div><input id="collectionSpeed" type="range" min="1" max="5" step="0.5" value="1" disabled aria-describedby="speedHelp speedEffective"><div class="speed-scale" aria-hidden="true"><span>1× Normal</span><span>3×</span><span>5×</span></div><p id="speedHelp" class="hint">Adjusts discovery, scrolling, and prompt reading across all Civitai tabs. Speed is a target, not guaranteed throughput. Server/CDN image downloads run separately.</p><p id="speedEffective" class="hint">Reading effective collection limits…</p><p id="speedStatus" class="hint" role="status" aria-live="polite">Checking collection speed…</p><div class="speed-actions"><button id="speedReset" type="button">Restore 1×</button><button id="speedRetry" type="button" hidden>Retry speed change</button></div></section></div>
      <div class="speed-wrap"><section class="speed-control" aria-labelledby="downloadHeading"><div class="speed-heading"><label id="downloadHeading" for="downloadConcurrency">Server image transfers for this tab</label><output id="downloadValue" for="downloadConcurrency">32</output></div><input id="downloadConcurrency" type="range" min="4" max="32" step="1" value="32" disabled aria-describedby="downloadHelp downloadStatus"><div class="speed-scale" aria-hidden="true"><span>4</span><span>16</span><span>32</span></div><p id="downloadHelp" class="hint">Up to 32 simultaneous image transfers per tab. All tabs and contributors share 32 server slots, so actual transfers may be lower. This is independent of collection speed. Tab counts cover records submitted with this version; older queued images appear only in shared totals.</p><p id="downloadActivity" class="hint" role="status"></p><p id="downloadStatus" class="hint" role="status" aria-live="polite"></p><button id="downloadRetry" type="button" hidden>Retry transfer setting</button></section></div>
      <div class="actions"><button id="start" class="primary">Scan this tab</button><button id="resume" hidden>Resume tab</button><button id="stop" disabled>Stop tab</button></div>
      <div class="links"><a href="https://search-civitai.xyz/" target="_blank" rel="noopener noreferrer">Open shared library ↗</a><button id="settings">Browsing &amp; activity</button></div>
    </section>`;
  document.documentElement.appendChild(root);
  const $ = id => panel.getElementById(id);
  const count = value => Math.max(0, Number(value) || 0).toLocaleString();
  const send = payload => new Promise(resolve => {
    try { chrome.runtime.sendMessage(payload, response => { const error = chrome.runtime.lastError; resolve(error ? { ok: false, error: error.message } : response || { ok: false }); }); }
    catch { resolve({ ok: false, error: 'Extension updated. Refresh this Civitai tab.' }); }
  });
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
      $('speedEffective').textContent = profile ? `Prompt readers: ${profile.metadataConcurrency} concurrent · ${(profile.sourceIntervalMs / 1000).toLocaleString()}s between source requests · ${profile.outstandingLimit} shared queue limit. Record uploads: up to ${profile.uploadBatchSize} records per batch, ${(profile.uploadIntervalMs / 1000).toLocaleString()}-second pause. Smaller batches are sent when fewer records are ready.` : 'Reading effective collection limits…';
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
  const downloadControl = ISSDownloadControl.create({ root: panel, send });
  const compatible = () => backgroundVersion === VERSION && statusProtocol === 1;
  const updateWarning = () => `Panel v${VERSION}; background ${backgroundVersion || 'version unknown (older build)'}. Reload Index Civitai on your browser’s Extensions page, then reopen this panel. Your Civitai tabs can stay open.`;
  function workerMetadata(value) { backgroundVersion = String(value?.backgroundVersion || ''); statusProtocol = Number(value?.statusProtocol) || 0; workerChecked = true; }
  function render() {
    const s = state?.status || {}, busy = starting || !!s.running, complete = !!state?.feed?.done;
    const pipeline = state?.pipeline || browse?.pipeline || null;
    const autoRunning = !!browse?.enabled && !browse?.tabPaused && !browse?.suspended;
    const total = (manual, automatic) => count((Number(manual) || 0) + (Number(automatic) || 0));
    $('synced').textContent = total(s.catalogSynced, browse?.synced); $('stored').textContent = total(s.catalogStoredSkipped, browse?.alreadyStored); $('promptless').textContent = total(s.catalogPromptlessSkipped, browse?.skippedPromptless);
    if (pipeline) { $('synced').textContent = count(pipeline.accepted); $('stored').textContent = count(pipeline.alreadyStored); }
    $('dot').classList.toggle('on', busy || autoRunning);
    $('runState').textContent = starting ? 'Starting this tab’s feed…' : s.running ? 'Scanning this tab’s feed' : browse?.tabPaused ? 'This tab is paused' : complete ? `This tab’s feed finished${autoRunning ? ' · auto collection on' : ''}` : autoRunning ? 'Automatic scrolling & collection' : s.stopped ? 'This tab’s scan stopped' : 'Ready to index';
    $('start').disabled = busy; $('start').textContent = starting ? 'Connecting…' : s.running ? 'Scanning…' : 'Scan this tab';
    $('stop').disabled = !busy && !autoRunning; $('resume').hidden = (!state?.canResume && !browse?.tabPaused) || busy; $('resume').disabled = busy;
    $('status').textContent = message || s.lastError || browse?.lastError || (s.running ? `Feed page ${count(state?.feed?.pages || s.driverBatch || 1)} · ${state?.driver?.phase || s.driverPhase || 'indexing prompts'}` : browse?.tabPaused ? 'Automatic scrolling and collection are stopped for this tab. Resume tab to continue.' : complete ? `This tab’s feed reached the end.${autoRunning ? ' Automatic collection stays on for new gallery images.' : ' Scan this tab to start again.'}` : autoRunning ? 'This gallery scrolls automatically, including in an inactive tab. Keep it open. Detail images and creator/edit pages do not scroll.' : state?.canResume ? 'This tab’s feed is paused. Resume its saved position, or start a fresh scan here.' : s.stopped ? 'This tab’s scan stopped. Start a fresh scan from the selected page.' : 'Scan this page’s selected feed. You can run other Civitai tabs at the same time. Keep each source tab open.');
    $('status').classList.toggle('error', messageError || !!s.lastError || !!browse?.lastError);
    const remaining = Math.max(0, Math.ceil((Math.max(source?.blockedUntil || 0, browse?.retryAt || 0) - Date.now()) / 1000));
    const sourceActive = Number(source?.activeCount ?? (source?.active ? 1 : 0)), sourceQueued = Number(source?.queued || 0);
    const catalogWait = Math.max(0, Math.ceil((Number(browse?.catalog?.retryAt || 0) - Date.now()) / 1000));
    const sourceWait = Math.max(0, Math.ceil((Number(source?.blockedUntil || 0) - Date.now()) / 1000));
    $('sourceStatus').textContent = `Civitai: ${sourceActive} / ${Number(source?.maxActive || 2)} requests active · ${sourceQueued} waiting for a source turn.` +
      (sourceWait ? ` Civitai cooldown: ${sourceWait}s.` : source?.pauseReason ? ` ${source.pauseReason}` : '') +
      (browse?.catalog?.lastError ? ` Server: ${browse.catalog.lastError}${catalogWait ? ` Retry in ${catalogWait}s.` : ' Retrying when queued work is ready.'}` :
        remaining && !sourceWait ? ` Collection retry in ${remaining}s.` : '');
    const phase = String((s.running ? s.phase : '') || browse?.phase || 'waiting for gallery images').replace(/[-_]/g, ' ');
    const last = Number(browse?.lastActivityAt) || 0;
    $('activity').textContent = `${total(s.processed, browse?.processed)} processed · ${total(s.pending, browse?.pending)} queued on this tab · ${total(s.catalogOversizeSkipped, browse?.skippedOversize)} oversized skipped (max 9 MP, 4096 pixels per side) · ${phase}${last ? ` · last activity ${count(Math.floor(Math.max(0, Date.now() - last) / 1000))}s ago` : ''}`;
    $('browse').textContent = !browse ? 'Checking automatic scrolling…' : browse.suspended ? `Automatic collection paused: ${browse.lastError || 'Collection is temporarily unavailable.'}` : browse.tabPaused ? 'Automatic scrolling: paused on this tab.' : browse.enabled ? `Automatic scrolling: on${browse.manualPaused ? ' · feed scan active on this tab' : ''}${browse.sourcePaused ? ' · waiting for Civitai' : browse.scrollAllowed === false ? ' · waiting for queue capacity' : ''} · ${count(browse.pendingTotal ?? browse.pending)} queued across tabs` : 'Automatic scrolling: off. Enable it in Browsing & activity.';
    $('queueStatus').textContent = pipeline ? `${count(pipeline.outstandingTotal)} / ${count(pipeline.outstandingLimit || 600)} outstanding across all tabs${Number(pipeline.outstandingTotal) >= 600 ? ` · scrolling paused until space is free.${Number(pipeline.paused) > 0 ? ` ${count(pipeline.paused)} images are queued on paused tabs. Resume a paused tab to drain its queue.` : ''}` : ''}` : `${total(s.pending, browse?.pending)} queued on this tab · ${count(browse?.pending)} automatic + ${count(s.pending)} feed`;
    $('pipelineStats').textContent = pipeline ? `This tab: ${count(pipeline.discovered)} discovered · ${count(pipeline.waitingDuplicateCheck)} waiting for duplicate check · ${count(pipeline.checkingDuplicates)} checking duplicates · ${count(pipeline.waitingMetadata)} waiting to read prompts · ${count(pipeline.readingPrompts)} reading prompts · ${count(pipeline.readyUpload)} records ready to send · ${count(pipeline.uploading)} records being sent` : 'Detailed queue stages will appear when the background connects.';
    $('sourceNotice').textContent = state?.sourceMismatch ? `This tab changed page. Its active scan still follows the saved source: ${state.sourcePageUrl || state.pageUrl || 'the original selected feed'}. Stop tab before starting another feed here.` : '';
    $('connectionStatus').textContent = !workerChecked ? 'Checking extension background…' : !compatible() ? updateWarning() : `Background ${backgroundVersion} · ${portReady ? 'Live activity updates' : reconnectAttempts >= 5 && !statusPort ? 'Polling activity · live updates unavailable' : 'Polling activity · reconnecting live updates'}`;
    $('connectionStatus').classList.toggle('error', workerChecked && !compatible());
    if (workerChecked && !compatible()) { $('runState').textContent = 'Extension update needed'; $('dot').classList.toggle('on', false); $('start').disabled = true; $('resume').disabled = true; }
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
    if (!disposed) { render(); refresh(); reconnect(); }
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
        clearTimeout(handshakeTimer); handshakeTimer = null; portReady = true; reconnectAttempts = 0; revision++;
        state = value.state; browse = value.browse; source = value.source; workerMetadata(value);
        speedControl.accept(value.config, state?.pipeline?.collectionSpeed || browse?.collectionSpeed, compatible());
        downloadControl.accept(value.transfers, compatible()); render();
      });
      port.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        disconnectStatus(port);
      });
    } catch { statusPort = null; portReady = false; reconnect(); }
  }
  async function refresh() {
    if (disposed || refreshing) return; refreshing = true;
    const before = revision;
    try {
      const values = await Promise.all([send({ type: 'getState' }), send({ type: 'civitai-auto-status' }), send({ type: 'getSourceStatus' }), send({ type: 'getConfig' }), send({ type: 'getDownloadSettings' })]);
      if (disposed || revision !== before) return;
      if (values[0]?.status) state = values[0]; if (values[1]?.ok) browse = values[1]; if (values[2]?.ok) source = values[2];
      workerMetadata(values.find(value => value?.backgroundVersion) || values[3]); revision++;
      speedControl.accept(values[3], state?.pipeline?.collectionSpeed || browse?.collectionSpeed, compatible()); render();
      downloadControl.accept(values[4]?.transfers, compatible());
    }
    finally { refreshing = false; }
  }
  async function begin(resume = false) {
    if (workerChecked && !compatible()) { message = updateWarning(); messageError = true; render(); return; }
    if (starting || state?.status?.running) return;
    if (!/^https:\/\/civitai\.(?:com|red)\//.test(location.href)) { message = 'Open a civitai.com or civitai.red page to scan.'; messageError = true; render(); return; }
    const epoch = ++startEpoch, pageUrl = location.href;
    captureController = new AbortController();
    message = resume ? '' : 'Detecting this tab’s feed. The page may scroll once to load it…'; messageError = false; starting = true; render();
    try {
      const guard = await send({ type: 'getSourceStatus' });
      if (disposed || epoch !== startEpoch || captureController.signal.aborted) return;
      if (!guard.ok) throw new Error(guard.error || 'Could not check Civitai collection status.');
      source = guard;
      if (guard.blockedUntil > Date.now()) throw new Error('Civitai requested a cooldown. Wait for the shared countdown before starting another scan.');
      const feedRequestUrls = resume ? [] : await window.__ISS_FEED_CAPTURE?.capture({ signal: captureController.signal });
      if (disposed || epoch !== startEpoch || captureController.signal.aborted) return;
      if (location.href !== pageUrl) throw new Error('This tab changed page. Start again from the page you want to scan.');
      if (!resume && !feedRequestUrls?.length) throw new Error('Civitai has not loaded this tab’s image feed. Wait for its images to load, then scan again. Other tabs keep their own scans.');
      message = ''; render();
      const result = await send({ type: resume ? 'resume' : 'start', backgroundDriver: true, settings: { pageUrl }, feedRequestUrls });
      if (epoch !== startEpoch || disposed) return;
      if (!result.ok) throw new Error(result.error || 'Could not start the feed scan.');
    } catch (error) {
      if (epoch === startEpoch && !disposed) { message = error.message || 'Could not detect this tab’s feed.'; messageError = true; }
    } finally {
      if (epoch === startEpoch && !disposed) { starting = false; captureController = null; await refresh(); }
    }
  }
  async function stop() { ++startEpoch; captureController?.abort(); window.__ISS_FEED_CAPTURE?.cancel(); const result = await send({ type: 'stop', reason: 'user', hard: true }); starting = false; message = result.ok ? '' : result.error || 'Could not stop the scan.'; messageError = !result.ok; await refresh(); }
  $('start').onclick = () => begin(); $('resume').onclick = async () => {
    if (workerChecked && !compatible()) { message = updateWarning(); messageError = true; render(); return; }
    if (state?.canResume) return begin(true);
    const result = await send({ type: 'civitai-auto-resume-tab' }); message = result.ok ? '' : result.error || 'Could not resume this tab.'; messageError = !result.ok; await refresh();
  }; $('stop').onclick = stop;
  $('settings').onclick = async () => { const result = await send({ type: 'openPromptLibrary' }); if (!result.ok) { message = result.error || 'Could not open browsing settings.'; messageError = true; render(); } };
  $('close').onclick = () => { root.style.display = 'none'; };
  const visible = () => { if (!document.hidden) refresh(); };
  const escape = event => { if (event.key === 'Escape' && event.composedPath?.().includes(root) && root.style.display !== 'none' && (starting || state?.status?.running || (browse?.enabled && !browse?.tabPaused))) stop(); };
  const timer = setInterval(() => { if (!portReady) refresh(); else render(); downloadControl.tick(); }, 2000); document.addEventListener('visibilitychange', visible); document.addEventListener('keydown', escape, true);
  window.__ISS_TOGGLE_PANEL = () => { root.style.display = root.style.display === 'none' ? 'block' : 'none'; refresh(); };
  window.__ISS_DISPOSE_PANEL = () => { disposed = true; speedControl.dispose(); downloadControl.dispose(); ++startEpoch; captureController?.abort(); clearInterval(timer); clearTimeout(reconnectTimer); clearTimeout(handshakeTimer); disconnectStatus(statusPort, true); document.removeEventListener('visibilitychange', visible); document.removeEventListener('keydown', escape, true); root.remove(); };
  render(); connectStatus(); refresh();
})();

