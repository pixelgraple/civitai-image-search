// Append-only history chunks keep old IDs out of every live queue checkpoint.
// The current checkpoint remains the authority for each committed prefix.
globalThis.ISSRunHistory = (() => {
  const fields = Object.freeze(['catalogIds', 'catalogSyncedIds', 'catalogStoredSkippedIds',
    'catalogPromptlessSkippedIds', 'catalogOversizeSkippedIds', 'catalogRejectedIds',
    'catalogProcessedIds', 'catalogDiscoveredIds']);
  const CHUNK_SIZE = 2048, INLINE_LIMIT = 256, IO_BATCH = 32;
  const membership = new WeakMap();
  function index(values) {
    let cached = membership.get(values);
    if (!cached || cached.length !== values.length) {
      cached = { values: new Set(values), length: values.length }; membership.set(values, cached);
    }
    return cached;
  }
  function has(run, field, id) { return index(run[field]).values.has(String(id)); }
  function add(run, field, ids) {
    const values = run[field], cached = index(values);
    for (const raw of ids) {
      const id = String(raw);
      if (!cached.values.has(id)) { cached.values.add(id); values.push(id); }
    }
    cached.length = values.length;
  }
  const validId = value => typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value) && Number.isSafeInteger(Number(value));
  function create({ readMany, writeMany, uuid = () => crypto.randomUUID() }) {
    const durable = new Map();
    const key = (id, field, part) => `civitaiRunHistoryV1:${id}:${field}:${part}`;
    const positionKey = (id, field) => `${id}:${field}`;
    async function restore(prior) {
      if (!prior.historyLengths || (typeof prior.historyLengths === 'object' && !Object.keys(prior.historyLengths).length)) return prior;
      if (!/^[a-f0-9-]{36}$/.test(prior.historyStoreId || '') || typeof prior.historyLengths !== 'object')
        throw new Error('Saved collection history is invalid; existing queues were preserved.');
      const restored = { ...prior };
      for (const [field, length] of Object.entries(prior.historyLengths)) {
        if (!fields.includes(field) || !Number.isSafeInteger(length) || length < 0)
          throw new Error('Saved collection history has an invalid count; existing queues were preserved.');
        const values = [], totalParts = Math.ceil(length / CHUNK_SIZE);
        for (let start = 0; start < totalParts; start += IO_BATCH) {
          const keys = Array.from({ length: Math.min(IO_BATCH, totalParts - start) }, (_, i) => key(prior.historyStoreId, field, start + i));
          const stored = await readMany(keys);
          for (const name of keys) {
            const needed = Math.min(CHUNK_SIZE, length - values.length), part = stored[name];
            // A crash may leave a longer tail from a not-yet-committed write.
            // Read only the prefix authorized by the main queue checkpoint.
            if (!Array.isArray(part) || part.length < needed || !part.slice(0, needed).every(validId))
              throw new Error('A saved history chunk is unavailable; existing queues were preserved.');
            values.push(...part.slice(0, needed));
          }
        }
        restored[field] = values;
        durable.set(positionKey(prior.historyStoreId, field), length);
      }
      return restored;
    }
    function capture(runs) {
      const chunks = [], positions = [], compact = [];
      for (const run of runs) {
        const copy = { ...run, historyLengths: { ...(run.historyLengths || {}) } };
        if (fields.some(field => run[field].length > INLINE_LIMIT) && !run.historyStoreId) run.historyStoreId = uuid();
        copy.historyStoreId = run.historyStoreId;
        for (const field of fields) {
          const values = run[field];
          if (values.length <= INLINE_LIMIT && !Object.hasOwn(copy.historyLengths, field)) continue;
          const position = positionKey(run.historyStoreId, field), committed = durable.get(position) || 0;
          if (values.length < committed) throw new Error('Saved collection history cannot shrink during a checkpoint.');
          copy[field] = []; copy.historyLengths[field] = values.length;
          if (values.length > committed) {
            for (let i = Math.floor(committed / CHUNK_SIZE); i < Math.ceil(values.length / CHUNK_SIZE); i++)
              chunks.push([key(run.historyStoreId, field, i), values.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE)]);
            positions.push([position, values.length]);
          }
        }
        compact.push(copy);
      }
      return { runs: structuredClone(compact), chunks, positions };
    }
    async function write(snapshot) {
      // Chunks must be durable before a checkpoint can refer to their prefixes.
      for (let i = 0; i < snapshot.chunks.length; i += IO_BATCH)
        await writeMany(Object.fromEntries(snapshot.chunks.slice(i, i + IO_BATCH)));
    }
    function committed(snapshot) {
      for (const [position, length] of snapshot.positions) durable.set(position, length);
    }
    return { restore, capture, write, committed };
  }
  return Object.freeze({ fields, add, has, create, CHUNK_SIZE, INLINE_LIMIT });
})();
