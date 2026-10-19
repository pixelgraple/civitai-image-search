// The browser opens this launcher even when the collector service worker fails.
// Inject UI directly; opening the controls never starts a scan or changes queues.
(() => {
  'use strict';
  const $ = id => document.getElementById(id), version = chrome.runtime.getManifest().version;
  const log = globalThis.ISSDiagnostics?.start('launcher'); log?.install();
  log?.record('info', 'launcher-open', 'Toolbar launcher opened.');
  let busy = false;
  $('version').textContent = `Version ${version}`;
  function deadline(operation, milliseconds, message) {
    let timer;
    return Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    })]).finally(() => clearTimeout(timer));
  }
  function eligible(tab) {
    try { const url = new URL(tab?.url); return Number.isInteger(tab.id) && url.protocol === 'https:' &&
      ['civitai.com', 'civitai.red'].includes(url.hostname) && !url.port && !url.username && !url.password; }
    catch { return false; }
  }
  function workerStatus() {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'getWorkerHealth' }, response => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else if (!response?.ok) reject(new Error(response?.error || 'The collector did not respond.'));
        else if (response.backgroundVersion !== version) reject(new Error('The collector is running an older version. Restart the extension.'));
        else if (response.phase && response.phase !== 'ready') reject(new Error(response.error || 'The collector is restoring its saved queue. Try opening again shortly.'));
        else resolve(response);
      });
    });
  }
  async function open() {
    if (busy) return;
    busy = true; $('retry').disabled = true; $('retry').textContent = 'Opening…';
    $('launcherError').hidden = true; $('restart').hidden = true; $('recoveryHint').hidden = true;
    $('launcherStatus').textContent = 'Opening this tab’s collection panel…';
    let mounted = false; const started = Date.now();
    try {
      const [tab] = await deadline(() => chrome.tabs.query({ active: true, currentWindow: true }), 3000, 'Brave did not return the active tab.');
      if (!eligible(tab)) { $('launcherStatus').textContent = 'Open a civitai.com or civitai.red gallery, then click Index Civitai.'; return; }
      const results = await deadline(() => chrome.scripting.executeScript({ target: { tabId: tab.id }, injectImmediately: true,
        files: ['diagnostics.js', 'civitai-feed-capture.js', 'runtime-request.js', 'download-control.js', 'source-control.js', 'panel.js'] }), 8000,
      'The page did not respond within 8 seconds. Refresh this gallery and try again.');
      const result = results?.find(item => item.frameId === 0)?.result || results?.[0]?.result;
      if (!result?.ok || result.panelVersion !== version) throw new Error(result?.error || 'The collection panel did not finish opening.');
      log?.record('info', 'panel-injected', 'Collection panel mounted.', { ms: Date.now() - started });
      mounted = true; $('launcherStatus').textContent = 'Panel opened. Connecting to the collector…';
      await deadline(workerStatus, 5000, 'The collector did not respond within 5 seconds. Restart the extension to reconnect.');
      Promise.allSettled([chrome.action.setBadgeText({ tabId: tab.id, text: '' }),
        chrome.action.setTitle({ tabId: tab.id, title: 'Index Civitai' })]);
      $('launcherStatus').textContent = 'Connected. This tab’s collection panel is open. Click outside this launcher to use it, or open Browsing & activity below.';
    } catch (error) {
      log?.record('error', mounted ? 'worker-connection' : 'panel-open-failed', error, { ms: Date.now() - started });
      $('launcherStatus').textContent = mounted ? 'The panel opened, but the collector is unavailable.' : 'Could not open this tab’s collection panel.';
      $('launcherError').textContent = String(error?.message || error).slice(0, 500); $('launcherError').hidden = false;
      $('restart').hidden = false; $('recoveryHint').hidden = false;
    } finally { busy = false; $('retry').disabled = false; $('retry').textContent = 'Try opening again'; }
  }
  $('retry').addEventListener('click', open);
  $('restart').addEventListener('click', () => {
    $('restart').disabled = true; $('launcherStatus').textContent = 'Restarting Index Civitai. Reopen it after refreshing your gallery.';
    try { chrome.runtime.reload(); }
    catch (error) { $('restart').disabled = false; $('launcherError').textContent = String(error?.message || error); $('launcherError').hidden = false; }
  });
  open();
})();
