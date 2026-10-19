// Keep startup diagnostics available even if the collector cannot be imported.
importScripts('diagnostics.js');
const diagnosticLog = ISSDiagnostics.start('worker');
diagnosticLog.install();
diagnosticLog.record('info', 'worker-start', 'Collector worker started.');
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!['index-civitai-diagnostic', 'openDiagnostics'].includes(message?.type)) return false;
  const own = sender?.id === chrome.runtime.id;
  let allowed = false;
  try { const url = new URL(sender?.url || ''); allowed = own &&
    (url.href.startsWith(chrome.runtime.getURL('')) ||
      (url.protocol === 'https:' && ['civitai.com', 'civitai.red'].includes(url.hostname) && sender.frameId === 0)); }
  catch {}
  if (!allowed) { respond({ ok: false }); return false; }
  if (message.type === 'openDiagnostics') {
    chrome.tabs.create({ url: chrome.runtime.getURL('diagnostics.html'), active: true }, () => {
      const error = chrome.runtime.lastError; respond(error ? { ok: false, error: error.message } : { ok: true });
    });
    return true;
  }
  const row = message.entry || {};
  ISSDiagnostics.start(['gallery', 'panel'].includes(row.context) ? row.context : 'worker').record(row.level, row.stage, row.message, row.details).then(ok => respond({ ok }));
  return true;
});
try { importScripts('background.js'); }
catch (error) {
  diagnosticLog.record('error', 'worker-import-failed', error);
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.type !== 'getWorkerHealth' || sender?.id !== chrome.runtime.id ||
      !String(sender.url || '').startsWith(chrome.runtime.getURL(''))) return false;
    respond({ ok: false, phase: 'error', backgroundVersion: chrome.runtime.getManifest().version,
      error: 'Collector startup failed. Open Error log in Extension options for details.' });
    return false;
  });
}
