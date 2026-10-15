// Civitai controls run in an isolated world. Public indexing needs no setup.
(() => {
  'use strict';
  const VERSION = '2.8.19', ROOT_ID = '__iss_panel_root';
  const previousRoot = document.getElementById(ROOT_ID);
  if (window.__ISS_PANEL_VERSION === VERSION && previousRoot?.isConnected && typeof window.__ISS_TOGGLE_PANEL === 'function') {
    try { window.__ISS_TOGGLE_PANEL(); return { ok: true, panelVersion: VERSION }; } catch { /* Rebuild an unusable panel. */ }
  }
  try { window.__ISS_DISPOSE_PANEL?.(); } catch { /* An old extension context may be invalid. */ }
  previousRoot?.remove();
  delete window.__ISS_PANEL_VERSION; delete window.__ISS_TOGGLE_PANEL; delete window.__ISS_DISPOSE_PANEL;
  let state = null, browse = null, source = null, message = '', messageError = false;
  let starting = false, refreshing = false, disposed = false, settingsOpen = false, autoSaving = false;
  let startEpoch = 0, captureController = null;
  let backgroundVersion = '', statusProtocol = 0, workerChecked = false, statusPort = null, portReady = false, reconnectTimer = null, handshakeTimer = null, reconnectAttempts = 0, revision = 0;
  const root = document.createElement('div'); root.id = ROOT_ID;
  try {
  const panel = root.attachShadow({ mode: 'open' });
  panel.innerHTML = `
    <style>
      :host{all:initial;position:fixed;top:16px;right:16px;z-index:2147483647;width:min(380px,calc(100vw - 32px));color-scheme:dark}
      *{box-sizing:border-box}.shell{font:13px/1.5 "Segoe UI",system-ui,sans-serif;color:#edf1f9;background:#14181f;border:1px solid #344252;border-radius:16px;box-shadow:0 22px 70px #000a;overflow:hidden;max-height:calc(100dvh - 32px);overflow-y:auto}
      header{display:flex;gap:10px;align-items:center;padding:16px;background:#19212c;border-bottom:1px solid #2b3543}.mark{width:34px;height:34px;border:1px solid #315777;border-radius:10px;background:#20374c;color:#8dceff;display:grid;place-items:center;font-size:23px}h2{margin:0;font-size:16px;line-height:1.3}small{font-size:10px;color:#9caec3}.header-actions{margin-left:auto;display:flex;gap:4px}.icon-button{display:grid;place-items:center;width:32px;height:32px;padding:5px;border-color:transparent;background:transparent;color:#b4c4d8}.icon-button svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.7}.icon-button[aria-expanded=true]{background:#244765;color:#a5d9ff}.close{font-size:23px}
      main{padding:16px}p{margin:0 0 12px}.hint{font-size:11px;color:#9caec3}.state{display:flex;gap:8px;align-items:center;color:#bbd7ec;font-size:12px}.dot{width:7px;height:7px;background:#6b7484;border-radius:50%}.dot.on{background:#75d6ac;box-shadow:0 0 0 4px #75d6ac13}.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:7px;margin:15px 0}.stat{background:#1a222e;border:1px solid #2d3a4b;padding:12px 4px;border-radius:10px;text-align:center}.stat b{display:block;font-size:23px;font-variant-numeric:tabular-nums;letter-spacing:-.6px}.stat:first-child b{color:#8bd5ff}.stat span{font-size:10px;color:#9caec3}.status{font-size:12px;color:#cbd8e6;overflow-wrap:anywhere}.error{color:#ffb7c0}.source-card{background:#12283a;border:1px solid #284b65;padding:12px;border-radius:10px;margin-bottom:12px}.source-card .hint{color:#b3d0e3;margin:0}.queue-summary{padding:10px 12px;background:#1a222e;border-left:2px solid #42a8ec;border-radius:5px;line-height:1.7}.mini-title{display:block;color:#83b7da;font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;margin-bottom:6px}.browse{border-top:1px solid #2b3543;padding-top:12px;font-size:11px;color:#9caec3}.actions{display:flex;gap:8px;padding:0 16px 15px}.actions button{flex:1}.links{display:flex;justify-content:space-between;gap:8px;padding:12px 16px;border-top:1px solid #2b3543;background:#11151c}
      button,a{font:inherit;cursor:pointer}button{border:1px solid #3b4b5d;border-radius:8px;padding:9px 10px;background:#222d3b;color:#edf1f9}button.primary{background:#2189d2;border-color:#40a5e8;color:white;font-weight:600}button:disabled{opacity:.45;cursor:not-allowed}.links button{font-size:11px;padding:6px 9px}.links a{color:#91caff;font-size:12px;text-decoration:none;align-self:center}:is(button,a,input,summary):focus-visible{outline:2px solid #91caff;outline-offset:3px}[hidden]{display:none!important}details>summary{cursor:pointer;font-size:11px;color:#b4c4d8;padding:9px 0}.detail-content{padding-top:7px}
      .settings-view{padding:16px}.settings-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px}.settings-head h3{margin:0;font-size:16px}.settings-head button{font-size:11px;padding:6px 10px}.settings-intro{color:#9caec3;font-size:11px}.speed-control{margin-top:17px;padding-top:15px;border-top:1px solid #2b3543}.source-control{border:1px solid #31516b;background:#162735;border-radius:11px;padding:13px;margin:0 0 18px}.speed-heading{display:flex;align-items:center;justify-content:space-between;gap:10px;font-weight:600;font-size:12px}.speed-heading output{color:#8ac9ff;font-size:23px;font-variant-numeric:tabular-nums}.speed-control input[type=range]{display:block;width:100%;height:32px;margin:6px 0 0;accent-color:#42a8ec;cursor:pointer}.speed-scale{display:flex;justify-content:space-between;font-size:10px;color:#9caec3;margin-bottom:10px}.speed-actions{display:flex;gap:7px}.speed-actions button{font-size:11px;padding:6px 9px}.speed-control .hint{margin-bottom:8px}.speed-control .error{color:#ffb7c0}.browse-option{display:flex;align-items:flex-start;gap:10px;cursor:pointer;font-size:12px}.browse-option input{margin:4px 0;accent-color:#42a8ec}.browse-option small{display:block;margin-top:4px;font-size:11px}.advanced{margin-top:16px;border-top:1px solid #2b3543}.advanced summary{font-size:12px;font-weight:600;padding-top:14px}.advanced .speed-control:first-of-type{margin-top:0;border-top:0}.settings-note{margin:12px 0 0;font-size:11px;color:#9caec3}
    </style>
    <section class="shell" role="region" aria-label="Index Civitai">
      <header><span class="mark" aria-hidden="true">⌗</span><div><h2>Index Civitai</h2><small>This tab · v${VERSION}</small></div><div class="header-actions"><button id="settingsToggle" class="icon-button" type="button" aria-label="Collection settings" title="Collection settings" aria-expanded="false" aria-controls="settingsView"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 3 6 0 .5 2 2 1.2 2-.6 3 5.2-1.5 1.4v2.3l1.5 1.4-3 5.2-2-.6-2 1.2-.5 2H9l-.5-2-2-1.2-2 .6-3-5.2L3 14.5v-2.3l-1.5-1.4 3-5.2 2 .6 2-1.2z" transform="translate(1 -1) scale(.92)"/><circle cx="12" cy="12" r="3"/></svg></button><button id="close" class="icon-button close" aria-label="Hide Index Civitai" title="Hide panel; indexing continues">×</button></div></header>
      <section id="settingsView" class="settings-view" aria-labelledby="settingsHeading" hidden>
        <div class="settings-head"><h3 id="settingsHeading">Collection settings</h3><button id="settingsClose" type="button">Done</button></div><p class="settings-intro">Changes apply while your tabs are collecting.</p>
        <section class="speed-control source-control" aria-labelledby="sourceHeading"><div class="speed-heading"><label id="sourceHeading" for="sourceConcurrency">Civitai requests at once</label><output id="sourceValue" for="sourceConcurrency">1</output></div><input id="sourceConcurrency" type="range" min="1" max="4" step="1" value="1" disabled aria-describedby="sourceHelp sourceSettingStatus"><div class="speed-scale" aria-hidden="true"><span>1 · Default</span><span>2</span><span>3</span><span>4 · Maximum</span></div><p id="sourceHelp" class="hint">One shared limit for every Civitai tab. Start at 1; higher limits can trigger Civitai rate limits. Cooldowns still apply.</p><p id="sourceSettingStatus" class="hint" role="status" aria-live="polite"></p><div class="speed-actions"><button id="sourceReset" type="button">Restore 1</button><button id="sourceRetry" type="button" hidden>Retry limit change</button></div></section>
        <label class="browse-option" for="autoBrowse"><input id="autoBrowse" type="checkbox" checked disabled><span><b>Collect images as you browse</b><small>Index visible images in open galleries. Only tabs you start with Scan this tab scroll automatically, including inactive tabs.</small></span></label><p id="autoBrowseStatus" class="settings-note" role="status" aria-live="polite"></p>
        <details class="advanced"><summary>Advanced settings</summary><section class="speed-control" aria-labelledby="speedHeading"><div class="speed-heading"><label id="speedHeading" for="collectionSpeed">Collection speed</label><output id="speedValue" for="collectionSpeed">1×</output></div><input id="collectionSpeed" type="range" min="1" max="5" step="0.5" value="1" disabled aria-describedby="speedHelp speedEffective"><div class="speed-scale" aria-hidden="true"><span>1× Normal</span><span>3×</span><span>5×</span></div><p id="speedHelp" class="hint">Adjusts discovery, scrolling, and prompt reading. The shared Civitai limit above always applies. Speed is a target, not guaranteed throughput. Server/CDN image downloads run separately.</p><p id="speedEffective" class="hint">Reading effective collection limits…</p><p id="speedStatus" class="hint" role="status" aria-live="polite">Checking collection speed…</p><div class="speed-actions"><button id="speedReset" type="button">Restore 1×</button><button id="speedRetry" type="button" hidden>Retry speed change</button></div></section>
        <section class="speed-control" aria-labelledby="downloadHeading"><div class="speed-heading"><label id="downloadHeading" for="downloadConcurrency">Server image transfers for this tab</label><output id="downloadValue" for="downloadConcurrency">32</output></div><input id="downloadConcurrency" type="range" min="4" max="32" step="1" value="32" disabled aria-describedby="downloadHelp downloadStatus"><div class="speed-scale" aria-hidden="true"><span>4</span><span>16</span><span>32</span></div><p id="downloadHelp" class="hint">The server saves image files separately. Up to 32 transfers per tab; all contributors share 32 server slots. This does not change the browser’s Civitai request limit.</p><p id="downloadStatus" class="hint" role="status" aria-live="polite"></p><button id="downloadRetry" type="button" hidden>Retry transfer setting</button></section></details>
      </section>
      <main id="overview"><p class="state"><i id="dot" class="dot"></i><span id="runState">Ready to index</span></p><div class="stats"><div class="stat"><b id="synced">0</b><span>Accepted</span></div><div class="stat"><b id="stored">0</b><span>Copies skipped</span></div><div class="stat"><b id="promptless">0</b><span>No prompt</span></div></div><div class="source-card"><span class="mini-title">Source activity · all tabs</span><p id="sourceStatus" class="hint" role="status"></p></div><p id="queueStatus" class="hint" role="status"></p><p id="sharedQueueStatus" class="hint queue-summary" role="status"></p><p id="status" class="status" role="status" aria-live="polite"></p><p id="sourceNotice" class="hint" role="status"></p><div id="browse" class="browse">Checking collection…</div><details><summary>Queue &amp; transfer details</summary><div class="detail-content"><p id="pipelineStats" class="hint" role="status"></p><p id="activity" class="hint" role="status"></p><p id="downloadActivity" class="hint" role="status"></p><p id="connectionStatus" class="hint" role="status"></p><p class="hint">Tab totals combine automatic collection and feed scans. Only images with a positive prompt are indexed. Files are saved on the server.</p></div></details></main>
      <div class="actions"><button id="start" class="primary">Scan this tab</button><button id="resume" hidden>Resume tab</button><button id="stop" disabled>Stop tab</button></div>
      <div class="links"><a href="https://search-civitai.xyz/" target="_blank" rel="noopener noreferrer">Shared library ↗</a><button id="settings">Browsing &amp; activity</button></div>
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
  const sourceControl = ISSSourceControl.create({ root: panel, send, onApplied(result) { revision++; speedControl.accept(result.config, result.collectionSpeed, compatible()); } });
  function acceptSettings(config, effective) {
    sourceControl.accept(config, effective, compatible());
    speedControl.accept(config, effective, compatible());
    if (!autoSaving) $('autoBrowse').checked = config?.autoBrowse !== false;
    $('autoBrowse').disabled = autoSaving || !compatible();
  }
  function showSettings(open) { settingsOpen = open; $('settingsView').hidden = !open; $('overview').hidden = open; $('settingsToggle').setAttribute('aria-expanded', String(open)); (open ? $('settingsClose') : $('settingsToggle')).focus?.(); }
  $('settingsToggle').onclick = () => showSettings(!settingsOpen);
  $('settingsClose').onclick = () => showSettings(false);
  $('autoBrowse').addEventListener('change', async () => {
    if (autoSaving || !compatible()) return;
    const enabled = $('autoBrowse').checked; autoSaving = true; $('autoBrowse').disabled = true; $('autoBrowseStatus').textContent = 'Saving browsing preference…';
    const result = await send({ type: 'setAutoBrowse', autoBrowse: enabled });
    if (disposed) return;
    autoSaving = false; $('autoBrowseStatus').textContent = result?.ok ? (enabled ? 'Visible-image collection is on. Only started scans scroll their galleries.' : 'Automatic collection is off. Feed scans keep running.') : result?.error || 'Could not save browsing preference.';
    $('autoBrowseStatus').classList.toggle('error', !result?.ok);
    if (result?.ok) { revision++; acceptSettings(result.config, result.config?.collectionSpeed); }
    else $('autoBrowse').checked = !enabled;
    $('autoBrowse').disabled = !compatible(); await refresh();
  });
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
    $('runState').textContent = starting ? 'Starting this tab’s feed…' : s.running ? 'Scanning this tab’s feed' : browse?.tabPaused ? 'This tab is paused' : complete ? `This tab’s feed finished${autoRunning ? ' · auto collection on' : ''}` : autoRunning ? 'Collecting visible images' : s.stopped ? 'This tab’s scan stopped' : 'Ready to index';
    $('start').disabled = busy; $('start').textContent = starting ? 'Connecting…' : s.running ? 'Scanning…' : 'Scan this tab';
    $('stop').disabled = !busy && !autoRunning; $('resume').hidden = (!state?.canResume && !browse?.tabPaused) || busy; $('resume').disabled = busy;
    $('status').textContent = message || s.lastError || browse?.lastError || (s.running ? `Feed page ${count(state?.feed?.pages || s.driverBatch || 1)} · ${state?.driver?.phase || s.driverPhase || 'indexing prompts'}` : browse?.tabPaused ? 'Collection is stopped for this tab. Resume tab to continue.' : complete ? `This tab’s feed reached the end.${autoRunning ? ' Automatic collection stays on for new gallery images.' : ' Scan this tab to start again.'}` : autoRunning ? 'Visible images are collected as you browse. Choose Scan this tab to scroll this gallery automatically. Other tabs keep manual scrolling.' : state?.canResume ? 'This tab’s feed is paused. Resume its saved position, or start a fresh scan here.' : s.stopped ? 'This tab’s scan stopped. Start a fresh scan from the selected page.' : 'Scan this page’s selected feed. You can run other Civitai tabs at the same time. Keep each source tab open.');
    $('status').classList.toggle('error', messageError || !!s.lastError || !!browse?.lastError);
    const remaining = Math.max(0, Math.ceil((Math.max(source?.blockedUntil || 0, browse?.retryAt || 0) - Date.now()) / 1000));
    const sourceActive = Number(source?.activeCount ?? (source?.active ? 1 : 0)), sourceQueued = Number(source?.queued || 0);
    const catalogWait = Math.max(0, Math.ceil((Number(browse?.catalog?.retryAt || 0) - Date.now()) / 1000));
    const sourceWait = Math.max(0, Math.ceil((Number(source?.blockedUntil || 0) - Date.now()) / 1000));
    $('sourceStatus').textContent = `Civitai: ${sourceActive} / ${Number(source?.maxActive || 1)} requests active · ${sourceQueued} waiting for a source turn.` +
        ` ${count(source?.completedLastMinute)} successful requests in the last minute · peak ${count(source?.peakActiveCount)} active this session.` +
      (sourceWait ? ` Civitai cooldown: ${sourceWait}s.` : source?.pauseReason ? ` ${source.pauseReason}` : '') +
      (browse?.catalog?.lastError ? ` Server: ${browse.catalog.lastError}${catalogWait ? ` Retry in ${catalogWait}s.` : ' Retrying when queued work is ready.'}` :
        remaining && !sourceWait ? ` Collection retry in ${remaining}s.` : '');
    const phase = String((s.running ? s.phase : '') || browse?.phase || 'waiting for gallery images').replace(/[-_]/g, ' ');
    const last = Number(browse?.lastActivityAt) || 0;
    $('activity').textContent = `${total(s.processed, browse?.processed)} processed · ${total(s.pending, browse?.pending)} queued on this tab · ${total(s.catalogOversizeSkipped, browse?.skippedOversize)} oversized skipped (max 9 MP, 4096 pixels per side) · ${phase}${last ? ` · last activity ${count(Math.floor(Math.max(0, Date.now() - last) / 1000))}s ago` : ''}`;
    const scrollSelected = !!browse?.scrollPageUrl && browse.scrollPageUrl === location.href;
    const browseWait = browse?.sourcePaused ? ' · waiting for Civitai' : '';
    $('browse').textContent = !browse ? 'Checking collection…' : browse.suspended ? `Collection paused: ${browse.lastError || 'Collection is temporarily unavailable.'}` : browse.tabPaused ? 'Collection and scrolling: paused on this tab.' : scrollSelected ? `Automatic scrolling: ${browse.scrollAllowed ? 'on' : 'waiting'} · feed scan active on this tab${browseWait}${!browse.scrollAllowed && !browse.sourcePaused ? ' · waiting for queue capacity or retry' : ''} · ${count(browse.pendingTotal ?? browse.pending)} queued across tabs` : browse.enabled ? `Visible-image collection: on · scrolling stays manual${browseWait} · ${count(browse.pendingTotal ?? browse.pending)} queued across tabs` : 'Visible-image collection: off. Scan this tab to start this gallery’s feed.';
    const shared = pipeline?.globalStages;
    $('sharedQueueStatus').hidden = !shared;
    $('sharedQueueStatus').textContent = shared ? `Shared queue: ${count((Number(shared.waitingDuplicateCheck) || 0) + (Number(shared.checkingDuplicates) || 0) + (Number(shared.waitingMetadata) || 0) + (Number(shared.readingPrompts) || 0))} preparing (checks/prompts) · ${count(shared.readyUpload)} ready to send · ${count(shared.uploading)} sending. ${count(pipeline.paused)} paused (included in these counts).` : '';
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
        acceptSettings(value.config, state?.pipeline?.collectionSpeed || browse?.collectionSpeed);
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
      acceptSettings(values[3], state?.pipeline?.collectionSpeed || browse?.collectionSpeed); render();
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
  const escape = event => { if (event.key === 'Escape' && settingsOpen && event.composedPath?.().includes(root)) { showSettings(false); event.preventDefault?.(); return; } if (event.key === 'Escape' && event.composedPath?.().includes(root) && root.style.display !== 'none' && (starting || state?.status?.running || (browse?.enabled && !browse?.tabPaused))) stop(); };
  const timer = setInterval(() => { if (!portReady) refresh(); else render(); downloadControl.tick(); }, 2000); document.addEventListener('visibilitychange', visible); document.addEventListener('keydown', escape, true);
  window.__ISS_TOGGLE_PANEL = () => { root.style.display = root.style.display === 'none' ? 'block' : 'none'; refresh(); };
  window.__ISS_DISPOSE_PANEL = () => { disposed = true; speedControl.dispose(); sourceControl.dispose(); downloadControl.dispose(); ++startEpoch; captureController?.abort(); clearInterval(timer); clearTimeout(reconnectTimer); clearTimeout(handshakeTimer); disconnectStatus(statusPort, true); document.removeEventListener('visibilitychange', visible); document.removeEventListener('keydown', escape, true); root.remove(); };
  render(); connectStatus(); refresh();
  window.__ISS_PANEL_VERSION = VERSION;
  return { ok: true, panelVersion: VERSION };
  } catch (error) {
    try { window.__ISS_DISPOSE_PANEL?.(); } catch { /* Always clear a failed mount. */ }
    root.remove();
    delete window.__ISS_PANEL_VERSION; delete window.__ISS_TOGGLE_PANEL; delete window.__ISS_DISPOSE_PANEL;
    return { ok: false, error: String(error?.message || 'Could not open the collection panel.').slice(0, 300) };
  }
})();

