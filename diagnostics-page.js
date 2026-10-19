(() => {
  'use strict';
  const $ = id => document.getElementById(id), log = ISSDiagnostics.start('diagnostics'), store = ISSDiagnostics.store();
  log.install();
  let rows = [], refreshing = false, checking = false, health = { phase: 'not checked' }, counts = null;
  $('version').textContent = chrome.runtime.getManifest().version;
  function request(type) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Collector did not respond within 5 seconds. Saved logs remain available.')), 5000);
      try { chrome.runtime.sendMessage({ type }, result => {
        clearTimeout(timer);
        const error = chrome.runtime.lastError;
        if (error || !result?.ok) reject(new Error(error?.message || result?.error || 'No collector response.'));
        else resolve(result);
      }); } catch (error) { clearTimeout(timer); reject(error); }
    });
  }
  function render() {
    const container = $('events'); container.replaceChildren();
    const filtered = rows.filter(row => $('level').value === 'all' || row.level === $('level').value);
    for (const row of filtered) {
      const card = document.createElement('article'); card.className = 'event ' + row.level;
      const meta = document.createElement('div'); meta.className = 'meta';
      for (const value of [new Date(row.time).toLocaleString(), row.level.toUpperCase(), row.context, row.stage, 'v' + row.version]) {
        const text = document.createElement('span'); text.textContent = value; meta.append(text);
      }
      const message = document.createElement('p'); message.textContent = row.message; card.append(meta, message);
      if (Object.keys(row.details || {}).length || row.stack) {
        const detail = document.createElement('details'), summary = document.createElement('summary'), pre = document.createElement('pre');
        summary.textContent = 'Details'; pre.textContent = [JSON.stringify(row.details, null, 2), row.stack].filter(Boolean).join('\n');
        detail.append(summary, pre); card.append(detail);
      }
      container.append(card);
    }
    if (!filtered.length) { const p = document.createElement('p'); p.textContent = 'No matching events yet.'; container.append(p); }
  }
  async function refresh() {
    if (refreshing) return; refreshing = true;
    try { rows = await store.read(); render(); $('logStatus').textContent = `${rows.length} saved events · updated ${new Date().toLocaleTimeString()}`; }
    catch (error) {
      rows = log.state().memory; render();
      $('logStatus').textContent = `Cannot read saved logs: ${ISSDiagnostics.clean(error.message)}. Only this page’s in-memory events are shown.`;
    } finally { refreshing = false; }
  }
  async function check() {
    if (checking) return; checking = true; $('checkWorker').disabled = true;
    try {
      const status = await request('getWorkerHealth');
      health = { phase: status.phase, backgroundVersion: status.backgroundVersion, error: ISSDiagnostics.clean(status.error || '') };
      $('workerStatus').textContent = status.phase === 'ready' ? `Connected · worker ${status.backgroundVersion}`
        : `${status.phase}: ${health.error || 'Restoring saved collection state.'}`;
      if (status.phase === 'ready') {
        const response = await request('getDiagnosticSnapshot'); counts = response.counts;
        $('queueStatus').textContent = `${counts.outstanding} outstanding · ${counts.preparing} preparing · ${counts.ready} ready · ${counts.sending} sending · ${counts.paused} paused · ${counts.activeTabs} active feeds`;
        await log.record('info', 'manual-health-check', 'Collector answered the diagnostic check.', counts);
      }
    } catch (error) {
      health = { phase: 'unavailable', error: ISSDiagnostics.clean(error.message) }; counts = null;
      $('workerStatus').textContent = health.error; $('queueStatus').textContent = '';
      await log.record('error', 'manual-health-check', error);
    } finally { checking = false; $('checkWorker').disabled = false; refresh(); }
  }
  async function report() {
    await refresh();
    return JSON.stringify({ application: 'Index Civitai', version: chrome.runtime.getManifest().version,
      generatedAt: new Date().toISOString(), health, counts, events: rows }, null, 2);
  }
  $('level').addEventListener('change', render);
  $('refresh').addEventListener('click', refresh);
  $('checkWorker').addEventListener('click', check);
  $('copy').addEventListener('click', async () => {
    const text = await report();
    try { await navigator.clipboard.writeText(text); $('logStatus').textContent = 'Report copied. You can paste it into this chat.'; }
    catch { $('manualCopy').hidden = false; $('manualCopy').open = true; $('report').value = text; $('report').focus(); $('report').select(); }
  });
  $('download').addEventListener('click', async () => {
    const url = URL.createObjectURL(new Blob([await report()], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url;
    link.download = 'index-civitai-diagnostics-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
  });
  $('clear').addEventListener('click', async () => {
    if (!confirm('Clear this extension’s diagnostic events? Saved scans and image queues are kept.')) return;
    try { await store.clear(); await refresh(); }
    catch (error) { $('logStatus').textContent = 'Could not clear logs: ' + ISSDiagnostics.clean(error.message); }
  });
  const timer = setInterval(() => { if (!document.hidden) refresh(); }, 5000);
  addEventListener('pagehide', () => clearInterval(timer), { once: true });
  refresh(); check();
})();
