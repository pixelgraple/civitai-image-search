/* Local-only IndexedDB store for Civitai image prompts and links. */
globalThis.PromptCatalogDB = (() => {
  const DB_NAME = 'civitai-prompt-catalog';
  const DB_VERSION = 1;
  function capturedPage(id,value) {
    try {
      const url=new URL(value);
      return url.protocol==='https:' && ['civitai.com','civitai.red'].includes(url.hostname) &&
        !url.username && !url.password && !url.port && !url.search && !url.hash && url.pathname===`/images/${id}` ? url.href : '';
    } catch { return ''; }
  }
  function mergeRecords(prior,record) {
    const merged={...prior,...record};
    // Only capturedPageUrl carries observed origin; legacy pageUrl assumed .red.
    const capturedPageUrl=capturedPage(merged.id,prior.capturedPageUrl) || capturedPage(merged.id,record.capturedPageUrl);
    for (const field of ['prompt','negativePrompt','modelName','creatorName','downloadUrl','previewUrl','pageUrl']) {
      if (!String(record[field] ?? '').trim() && prior[field]) merged[field]=prior[field];
    }
    if (capturedPageUrl) { merged.capturedPageUrl=capturedPageUrl; merged.pageUrl=capturedPageUrl; }
    for (const field of ['tags','loras']) {
      if (!record[field]?.length && prior[field]?.length) merged[field]=prior[field];
    }
    if (prior.reactions || record.reactions) merged.reactions={...(prior.reactions||{}),...(record.reactions||{})};
    for (const field of ['width','height']) {
      if (!record[field] && prior[field]) merged[field]=prior[field];
    }
    return merged;
  }
  function open() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('images')) {
          const store = db.createObjectStore('images', { keyPath: 'id' });
          store.createIndex('updatedAt', 'updatedAt');
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Could not open the local prompt catalog.'));
    });
  }
  async function upsert(records) {
    if (!Array.isArray(records) || !records.length) return 0;
    const batch=new Map();
    for (const record of records) if (record?.id) batch.set(record.id,mergeRecords(batch.get(record.id)||{},record));
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('images', 'readwrite');
      const store = tx.objectStore('images');
      for (const record of batch.values()) {
        if (record?.id) {
          const request=store.get(record.id);
          request.onsuccess=()=>{
            store.put(mergeRecords(request.result||{},record));
          };
        }
      }
      tx.oncomplete = () => { db.close(); resolve(batch.size); };
      tx.onerror = () => { db.close(); reject(tx.error || new Error('Could not save prompt records.')); };
      tx.onabort = () => { db.close(); reject(tx.error || new Error('Prompt catalog write was cancelled.')); };
    });
  }
  async function count() {
    const db = await open();
    return new Promise((resolve, reject) => {
      const request = db.transaction('images').objectStore('images').count();
      request.onsuccess = () => { db.close(); resolve(request.result); };
      request.onerror = () => { db.close(); reject(request.error); };
    });
  }
  async function get(id) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const request = db.transaction('images').objectStore('images').get(String(id));
      request.onsuccess = () => { db.close(); resolve(request.result || null); };
      request.onerror = () => { db.close(); reject(request.error); };
    });
  }
  async function forPromptCollection(records) {
    const batch = new Map();
    for (const record of records || []) if (record?.id) {
      const id = String(record.id);
      batch.set(id, mergeRecords(batch.get(id) || {}, { ...record, id }));
    }
    if (!batch.size) return { items: [], skippedIds: [] };
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('images'), store = tx.objectStore('images');
      const combined = new Map();
      for (const [id, record] of batch) {
        const request = store.get(id);
        request.onsuccess = () => combined.set(id, mergeRecords(request.result || {}, record));
      }
      tx.oncomplete = () => {
        db.close(); const items = [], skippedIds = [];
        for (const id of batch.keys()) {
          const record = combined.get(id);
          if (typeof record?.prompt === 'string' && record.prompt.trim()) items.push(record);
          else skippedIds.push(id);
        }
        resolve({ items, skippedIds });
      };
      tx.onerror = () => { db.close(); reject(tx.error || new Error('Could not check known prompts.')); };
    });
  }
  function tokens(text) {
    return String(text || '').normalize('NFKC').toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  }
  function matches(record, terms) {
    const text = [record.prompt, record.negativePrompt, record.modelName, ...(record.loras || []), ...(record.tags || [])].join(' ').normalize('NFKC').toLocaleLowerCase();
    return terms.every(term => text.includes(term));
  }
  async function search(query) {
    const terms = tokens(query);
    const db = await open();
    return new Promise((resolve, reject) => {
      const results = [];
      const tx = db.transaction('images');
      const request = tx.objectStore('images').openCursor(null, 'prev');
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        if (!terms.length || matches(cursor.value, terms)) results.push(cursor.value);
        cursor.continue();
      };
      tx.oncomplete = () => { db.close(); resolve(results); };
      tx.onerror = () => { db.close(); reject(tx.error || new Error('Search failed.')); };
    });
  }
  async function exportCsv() {
    const db = await open();
    return new Promise((resolve, reject) => {
      const rows = [];
      const tx = db.transaction('images');
      const request = tx.objectStore('images').openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        rows.push(cursor.value); cursor.continue();
      };
      tx.oncomplete = () => {
        db.close();
        const q = value => `"${String(value || '').replaceAll('"', '""')}"`;
        resolve(['id,url,prompt,negative_prompt,tags', ...rows.map(row => [row.id,row.pageUrl,row.prompt,row.negativePrompt,(row.tags||[]).join('|')].map(q).join(','))].join('\r\n'));
      };
      tx.onerror = () => { db.close(); reject(tx.error || new Error('Export failed.')); };
    });
  }
  return { upsert, count, get, forPromptCollection, search, exportCsv };
})();
