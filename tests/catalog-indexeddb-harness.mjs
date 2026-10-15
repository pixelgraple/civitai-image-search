// Minimal IndexedDB fixture for the catalog's store, request, and cursor APIs.
// Requests execute asynchronously in FIFO order, including writes enqueued
// from a request success handler; this ordering matters for duplicate IDs.
export function createCatalogIndexedDB() {
  const databases = new Map();
  const clone = value => value === undefined ? undefined : structuredClone(value);

  class Transaction {
    constructor(state, mode) {
      this.state = state;
      this.mode = mode;
      this.rows = new Map([...state.rows].map(([key, value]) => [key, clone(value)]));
      this.queue = [];
      this.active = true;
      this.scheduled = false;
      this.schedule();
    }
    schedule() {
      if (this.scheduled || !this.active) return;
      this.scheduled = true;
      setImmediate(() => this.step());
    }
    enqueue(operation, request = {}) {
      if (!this.active) throw new Error('TransactionInactiveError');
      this.queue.push({ operation, request });
      this.schedule();
      return request;
    }
    step() {
      this.scheduled = false;
      if (!this.active) return;
      const next = this.queue.shift();
      if (!next) {
        if (this.mode === 'readwrite') this.state.rows = this.rows;
        this.active = false;
        this.oncomplete?.({ target: this });
        return;
      }
      try {
        next.request.result = next.operation();
        next.request.onsuccess?.({ target: next.request });
      } catch (error) {
        next.request.error = this.error = error;
        this.active = false;
        next.request.onerror?.({ target: next.request });
        this.onerror?.({ target: this });
        this.onabort?.({ target: this });
        return;
      }
      this.schedule();
    }
    objectStore(name) {
      if (name !== 'images' || !this.state.created) throw new Error('NotFoundError');
      const tx = this;
      return {
        get: key => tx.enqueue(() => clone(tx.rows.get(key))),
        count: () => tx.enqueue(() => tx.rows.size),
        put(value) {
          if (tx.mode !== 'readwrite') throw new Error('ReadOnlyError');
          const copy = clone(value);
          return tx.enqueue(() => { tx.rows.set(copy.id, copy); return copy.id; });
        },
        openCursor(_range, direction = 'next') {
          const keys = [...tx.rows.keys()].sort();
          if (direction === 'prev') keys.reverse();
          const request = {};
          let index = 0;
          const advance = () => {
            if (index >= keys.length) return null;
            const key = keys[index++];
            return { key, value: clone(tx.rows.get(key)), continue: () => tx.enqueue(advance, request) };
          };
          return tx.enqueue(advance, request);
        },
      };
    }
  }

  return {
    open(name, version) {
      const request = {};
      setImmediate(() => {
        let state = databases.get(name);
        const upgrade = !state;
        if (!state) {
          state = { version, created: false, rows: new Map() };
          databases.set(name, state);
        }
        request.result = {
          objectStoreNames: { contains: storeName => storeName === 'images' && state.created },
          createObjectStore(storeName, options) {
            if (storeName !== 'images' || options.keyPath !== 'id') throw new Error('Unsupported store fixture');
            state.created = true;
            return { createIndex() {} };
          },
          transaction(storeName, mode = 'readonly') {
            if (storeName !== 'images') throw new Error('NotFoundError');
            return new Transaction(state, mode);
          },
          close() {},
        };
        if (upgrade) request.onupgradeneeded?.({ target: request });
        request.onsuccess?.({ target: request });
      });
      return request;
    },
  };
}
