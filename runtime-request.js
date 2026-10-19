// Every control request settles even if a service worker stops answering.
globalThis.ISSRuntimeRequest = (message, milliseconds = 10000) => new Promise((resolve, reject) => {
  let settled = false;
  const finish = (error, value) => {
    if (settled) return;
    settled = true; clearTimeout(timer);
    if (error) {
      if (globalThis.location?.protocol === 'chrome-extension:') globalThis.ISSDiagnostics?.start('activity').record('error', 'control-request', error, { action: message?.type });
      else globalThis.ISSDiagnostics?.relay('panel', 'error', 'control-request', error, { action: message?.type });
      reject(error);
    } else resolve(value);
  };
  const timer = setTimeout(() => finish(new Error('The collector did not respond within 10 seconds. Reopen Index Civitai and use Restart extension if it stays unavailable. Saved queues are retained.')), milliseconds);
  try {
    chrome.runtime.sendMessage(message, response => {
      const error = chrome.runtime.lastError;
      finish(error ? new Error(error.message) : null, response || { ok: false, error: 'The collector returned no response.' });
    });
  } catch (error) { finish(error); }
});
