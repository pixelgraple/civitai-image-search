// One browser-wide profile. Site/server cooldowns and the durable backlog cap
// remain independent of the user's throughput preference.
globalThis.ISSCollectionSpeed = (() => {
  'use strict';
  function normalize(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 1 || value > 5 || !Number.isInteger(value * 2))
      throw new TypeError('Collection speed must be a number from 1 to 5 in steps of 0.5.');
    return value;
  }
  function normalizeSourceConcurrency(value) {
    if (!Number.isInteger(value) || value < 1 || value > 4)
      throw new TypeError('Civitai processing must be a whole number from 1 to 4.');
    return value;
  }
  function profile(value = 1, sourceConcurrency = 1) {
    const multiplier = normalize(value);
    return Object.freeze({ multiplier, sourceConcurrency: normalizeSourceConcurrency(sourceConcurrency), sourceIntervalMs: Math.round(2000 / multiplier),
      uploadIntervalMs: 3000, imageCooldownMs: Math.round(1000 / multiplier),
      metadataConcurrency: 12 * multiplier, discoveryBatchSize: Math.min(100, Math.round(60 * multiplier)),
      uploadBatchSize: 60, scrollIntervalMs: Math.round(2000 / multiplier),
      outstandingLimit: 600 });
  }
  let current = profile();
  const listeners = new Set();
  return Object.freeze({ normalize, normalizeSourceConcurrency, profile, get: () => current,
    set(value, sourceConcurrency = current.sourceConcurrency) { const previous = current; current = profile(value, sourceConcurrency);
      for (const listener of [...listeners]) { try { listener(current, previous); } catch {} }
      return current;
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
  });
})();
