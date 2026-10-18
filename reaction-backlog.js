// Optional reaction work spills to IndexedDB instead of blocking image ingestion.
// Only small metadata jobs are stored here; image bytes stay on the server.
globalThis.ISSReactionBacklog = (() => {
  let opening;
  function open() {
    if (!opening) opening = new Promise((resolve, reject) => {
      const request = indexedDB.open('civitai-reaction-backlog', 1);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore('jobs', { keyPath: 'key' });
        store.createIndex('kind', 'kind');
        store.createIndex('due', ['kind', 'retryAt', 'queuedAt']);
      };
      request.onerror = () => { opening = null; reject(request.error); };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); opening = null; };
        resolve(db);
      };
    });
    return opening;
  }
  function create(kind, merge = (previous, item) => ({ ...previous, ...item })) {
    let size = 0;
    const ready = (async () => {
      const db = await open();
      await new Promise((resolve, reject) => {
        const request = db.transaction('jobs').objectStore('jobs').index('kind').count(kind);
        request.onsuccess = () => { size = request.result; resolve(); };
        request.onerror = () => reject(request.error);
      });
    })();
    async function put(item) {
      await ready; const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('jobs', 'readwrite'), store = tx.objectStore('jobs');
        const key = kind + ':' + item.id, request = store.get(key); let added = false;
        request.onsuccess = () => {
          const old = request.result, value = merge(old?.item || {}, item); added = !old;
          store.put({ key, kind, item: value, revision: crypto.randomUUID(),
            retryAt: Math.max(0, Number(value.retryAt) || 0), queuedAt: old?.queuedAt || Date.now() });
        };
        tx.oncomplete = () => { if (added) size++; resolve(); };
        tx.onerror = tx.onabort = () => reject(tx.error || new Error('Could not save the reaction backlog.'));
      });
    }
    async function peek(limit, time = Date.now()) {
      await ready; const db = await open();
      return new Promise((resolve, reject) => {
        const rows = [], tx = db.transaction('jobs');
        const range = IDBKeyRange.bound([kind, 0, 0], [kind, time, Number.MAX_SAFE_INTEGER]);
        const request = tx.objectStore('jobs').index('due').openCursor(range);
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor || rows.length >= limit) return;
          rows.push(cursor.value); cursor.continue();
        };
        tx.oncomplete = () => resolve(rows);
        tx.onerror = tx.onabort = () => reject(tx.error || new Error('Could not read the reaction backlog.'));
      });
    }
    async function removeMany(rows) {
      await ready; const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('jobs', 'readwrite'), store = tx.objectStore('jobs');
        let removed = 0;
        for (const { id, revision } of rows) {
          const request = store.get(kind + ':' + id);
          request.onsuccess = () => {
            if (request.result && (!revision || request.result.revision === revision)) {
              store.delete(request.result.key); removed++;
            }
          };
        }
        tx.oncomplete = () => { size -= removed; resolve(removed); };
        tx.onerror = tx.onabort = () => reject(tx.error || new Error('Could not acknowledge reaction work.'));
      });
    }
    const remove = (id, revision) => removeMany([{ id, revision }]);
    return { ready, put, peek, remove, removeMany, count: () => size };
  }
  return { create };
})();
