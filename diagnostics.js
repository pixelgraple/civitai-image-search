// Local operational logs, independent of the collector and its saved queues.
// Never pass prompt records, request bodies, headers, or account data here.
(() => {
  'use strict';
  if (globalThis.ISSDiagnostics) return;
  const DB = 'indexCivitaiDiagnosticsV1', LIMIT = 500, AGE = 7 * 86400000;
  const contexts = new Set(['worker', 'launcher', 'activity', 'gallery', 'panel', 'clock', 'diagnostics']);
  function clean(value, limit = 500) {
    return String(value ?? '').slice(0, 4000)
      .replace(/(?:https?|chrome-extension|file):\/\/[^\s<>"')]+/gi, url => {
        try { const parsed = new URL(url); return parsed.protocol === 'chrome-extension:'
          ? '[extension]/' + parsed.pathname.split('/').pop().split(/[?#]/)[0] : parsed.origin + '/[redacted]'; }
        catch { return '[url redacted]'; }
      })
      .replace(/\b(?:authorization|cookie|set-cookie)\s*[:=][^\r\n]*/gi, '[credentials redacted]')
      .replace(/\b(?:password|passwd|secret|token|api[_-]?key|session[_-]?id)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '[credential redacted]')
      .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
      .replace(/[A-Za-z]:\\[^\r\n]+/g, '[local path redacted]')
      .replace(/\b[A-Za-z0-9_+/=-]{80,}\b/g, '[long value redacted]')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, limit);
  }
  function entry(context, level, stage, error, details = {}, now = Date.now()) {
    const data = {};
    for (const key of ['status', 'ms', 'count', 'preparing', 'ready', 'sending', 'paused', 'outstanding', 'activeTabs', 'retryAt', 'line', 'column', 'repeats'])
      if (Number.isFinite(details?.[key])) data[key] = Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, details[key]));
    for (const key of ['action', 'phase', 'reason', 'backgroundVersion'])
      if (typeof details?.[key] === 'string') data[key] = clean(details[key], 80);
    return { time: now, version: clean(globalThis.chrome?.runtime?.getManifest?.().version || 'unknown', 30),
      context: contexts.has(context) ? context : 'worker', level: ['info', 'warning', 'error'].includes(level) ? level : 'error',
      stage: String(stage || 'unknown').replace(/[^a-z0-9_.-]/gi, '-').slice(0, 60),
      message: clean(error?.message || error), stack: error?.stack ? clean(error.stack, 1000) : '', details: data };
  }
  function createStore(factory = globalThis.indexedDB) {
    let opening = null;
    function open() {
      if (opening) return opening;
      opening = new Promise((resolve, reject) => {
        let request, settled = false;
        const timer = setTimeout(() => fail(new Error('Diagnostic storage did not open within 3 seconds.')), 3000);
        const fail = error => { if (settled) return; settled = true; clearTimeout(timer); reject(error); };
        try {
          request = factory.open(DB, 1);
          request.onupgradeneeded = () => request.result.createObjectStore('events', { keyPath: 'id', autoIncrement: true });
          request.onerror = () => fail(request.error || new Error('Diagnostic storage could not open.'));
          request.onblocked = () => fail(new Error('Diagnostic storage is blocked by another extension page.'));
          request.onsuccess = () => {
            const db = request.result;
            if (settled) { db.close(); return; }
            settled = true; clearTimeout(timer);
            db.onversionchange = () => { db.close(); opening = null; };
            db.onclose = () => { opening = null; };
            resolve(db);
          };
        } catch (error) { fail(error); }
      }).catch(error => { opening = null; throw error; });
      return opening;
    }
    async function transaction(mode, work) {
      const db = await open();
      return new Promise((resolve, reject) => {
        let result, tx;
        const timer = setTimeout(() => { try { tx?.abort(); } catch {} reject(new Error('Diagnostic storage timed out.')); }, 3000);
        try {
          tx = db.transaction('events', mode);
          tx.oncomplete = () => { clearTimeout(timer); resolve(result); };
          tx.onerror = tx.onabort = () => { clearTimeout(timer); reject(tx.error || new Error('Diagnostic storage write failed.')); };
          work(tx.objectStore('events'), value => { result = value; });
        } catch (error) { clearTimeout(timer); reject(error); }
      });
    }
    return {
      append: rows => transaction('readwrite', store => {
        for (const row of rows.slice(-64)) store.add(row);
        const count = store.count();
        count.onsuccess = () => {
          let excess = Math.max(0, count.result - LIMIT);
          const cursor = store.openCursor();
          cursor.onsuccess = () => {
            const row = cursor.result;
            if (!row) return;
            if (excess > 0 || row.value.time < Date.now() - AGE) { row.delete(); excess--; row.continue(); }
          };
        };
      }),
      read: () => transaction('readonly', (store, done) => {
        const rows = [], cursor = store.openCursor(null, 'prev');
        cursor.onsuccess = () => {
          const row = cursor.result;
          if (!row || rows.length >= LIMIT) { done(rows); return; }
          if (row.value.time >= Date.now() - AGE) rows.push(row.value);
          row.continue();
        };
      }),
      clear: () => transaction('readwrite', store => store.clear())
    };
  }
  let sharedStore;
  const store = () => sharedStore ||= createStore();
  function create(context, options = {}) {
    const storage = options.store || store(), now = options.now || Date.now;
    const recent = new Map(), memory = [];
    let pending = 0, lastError = '', retryAt = 0, minute = 0, rate = 0;
    function record(level, stage, error, details = {}) {
      try {
        const row = entry(context, level, stage, error, details, now());
        const signature = [row.level, row.stage, row.message].join('|'), previous = recent.get(signature);
        if (previous && row.time - previous < 30000) return Promise.resolve(false);
        if (Math.floor(row.time / 60000) !== minute) { minute = Math.floor(row.time / 60000); rate = 0; }
        if (rate++ >= 100 || pending >= 64) return Promise.resolve(false);
        recent.set(signature, row.time); if (recent.size > 100) recent.delete(recent.keys().next().value);
        memory.unshift(row); if (memory.length > 50) memory.pop();
        if (row.time < retryAt) return Promise.resolve(false);
        pending++;
        return Promise.resolve().then(() => storage.append([row])).then(() => { lastError = ''; return true; }, error => {
          lastError = clean(error?.message || error); retryAt = now() + 60000; return false;
        }).finally(() => { pending--; });
      } catch { return Promise.resolve(false); }
    }
    return { record, state: () => ({ lastError, memory: memory.slice(), pending }),
      install: (target = globalThis) => {
        target.addEventListener?.('error', event => record('error', 'uncaught-error', event.error || event.message,
          { line: event.lineno, column: event.colno }));
        target.addEventListener?.('unhandledrejection', event => record('error', 'unhandled-rejection', event.reason));
      } };
  }
  const instances = new Map();
  function start(context) {
    if (!instances.has(context)) instances.set(context, create(context));
    return instances.get(context);
  }
  // Content scripts cannot access trusted extension storage; the worker records
  // only this small, sanitized operational envelope, even during restoration.
  function relay(context, level, stage, error, details) {
    try {
      const row = entry(context, level, stage, error, details);
      chrome.runtime.sendMessage({ type: 'index-civitai-diagnostic', entry: row }, () => { void chrome.runtime.lastError; });
    } catch { /* An invalid content context cannot persist; launcher logs it. */ }
  }
  globalThis.ISSDiagnostics = Object.freeze({ createStore, create, start, entry, clean, relay, store, LIMIT, AGE });
})();
