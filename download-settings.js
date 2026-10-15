// Private per-tab transfer identities never leave the background except to our server.
(() => {
  'use strict';
  const valid = value => Number.isInteger(value) && value >= 4 && value <= 32;
  function create(deps) {
    const lanes = new Map(), chains = new Map();
    let writes = Promise.resolve(), pollWork = null, nextPollAt = 0;
    let server = { limit: 32, active: null, updatedAt: null, phase: 'Checking server transfers' };
    const persist = () => {
      const snapshot = [...lanes].map(([tabId, lane]) => ({ tabId, token: lane.token, concurrency: lane.concurrency, pageUrl: lane.pageUrl }));
      writes = writes.catch(() => {}).then(() => deps.save(snapshot)); return writes;
    };
    const initialized = (async () => {
      const [saved, tabs] = await Promise.all([deps.load(), deps.tabs()]);
      const open = new Map(tabs.filter(tab => Number.isInteger(tab.id)).map(tab => [tab.id, tab])), used = new Set();
      for (const item of (Array.isArray(saved) ? saved : []).slice(-100)) {
        if (!item || !/^[a-f0-9]{64}$/.test(item.token) || !valid(item.concurrency)) continue;
        const prior = open.get(item.tabId);
        // Browser restarts can renumber restored tabs; match an unused copy of
        // the same page while keeping duplicate gallery tabs in separate lanes.
        const tab = prior?.url === item.pageUrl && !used.has(prior.id) ? prior :
          tabs.find(tab => Number.isInteger(tab.id) && tab.url === item.pageUrl && !used.has(tab.id));
        if (!tab) continue;
        used.add(tab.id);
        lanes.set(tab.id, { token: item.token, concurrency: item.concurrency, pageUrl: tab.url, acknowledged: false, forcePreference: true, active: null, pending: null, stored: null, updatedAt: null, error: '' });
      }
      await persist();
    })();
    const serial = (tabId, work) => {
      const result = (chains.get(tabId) || Promise.resolve()).catch(() => {}).then(work);
      chains.set(tabId, result);
      result.finally(() => { if (chains.get(tabId) === result) chains.delete(tabId); }).catch(() => {});
      return result;
    };
    async function laneFor(tabId) {
      await initialized;
      const tab = await deps.tab(tabId);
      if (!Number.isInteger(tabId) || !deps.eligible(tab)) throw new Error('Choose an open Civitai tab to change its server transfers.');
      let lane = lanes.get(tabId);
      if (!lane) {
        if (lanes.size >= 100) {
          const open = new Set((await deps.tabs()).map(tab => tab.id));
          for (const id of lanes.keys()) if (!open.has(id)) lanes.delete(id);
          if (lanes.size >= 100) throw new Error('Server transfer settings support up to 100 open Civitai tabs.');
        }
        const token = [...crypto.getRandomValues(new Uint8Array(32))].map(value => value.toString(16).padStart(2, '0')).join('');
        lane = { token, concurrency: 32, pageUrl: tab.url, acknowledged: false, active: null, pending: null, stored: null, updatedAt: null, error: '' };
        lanes.set(tabId, lane); await persist();
      } else if (lane.pageUrl !== tab.url) { lane.pageUrl = tab.url; await persist(); }
      return lane;
    }
    const publicLane = (tabId, lane) => ({ tabId, concurrency: lane?.concurrency ?? 32, serverMax: server.limit,
      active: lane?.active ?? null, pending: lane?.pending ?? null, stored: lane?.stored ?? null,
      updatedAt: lane?.updatedAt ?? null, error: lane?.error || '', acknowledged: !!lane?.acknowledged, server: { ...server } });
    async function synchronize(tabId, concurrency) {
      return serial(tabId, async () => {
        const lane = await laneFor(tabId);
        if (concurrency === undefined && lane.acknowledged) return lane;
        try {
          if (Date.now() < (deps.cooldownUntil?.() || 0)) throw Object.assign(new Error('Server transfer settings are waiting for the shared server cooldown.'), { status: 429, retryAfterMs: deps.cooldownUntil() - Date.now() });
          const preference = concurrency ?? (lane.forcePreference ? lane.concurrency : undefined);
          const result = await deps.post('download-settings', { collectionToken: lane.token, ...(preference === undefined ? {} : { concurrency: preference }) });
          if (!valid(result?.concurrency)) throw new Error('Server returned invalid transfer settings.');
          // Only an acknowledged settings response changes the persistent preference.
          lane.concurrency = result.concurrency; lane.acknowledged = true; lane.forcePreference = false; lane.error = '';
          if (Number.isInteger(result.serverMax) && result.serverMax > 0 && result.serverMax <= 32) server.limit = result.serverMax;
          await persist(); deps.changed(); return lane;
        } catch (error) { lane.acknowledged = false; lane.forcePreference = true; lane.error = String(error?.message || error); deps.changed(); throw error; }
      });
    }
    async function poll() {
      await initialized;
      if (pollWork || Date.now() < Math.max(nextPollAt, deps.cooldownUntil?.() || 0)) return pollWork;
      nextPollAt = Date.now() + 5000;
      pollWork = (async () => {
        const tabs = await deps.tabs(), open = new Set(tabs.map(tab => tab.id));
        const selected = [...lanes].filter(([tabId, lane]) => open.has(tabId) && lane.acknowledged).slice(0, 100);
        if (!selected.length) return;
        try {
          const result = await deps.post('download-status', { collectionTokens: selected.map(([, lane]) => lane.token) });
          if (!Array.isArray(result.items)) throw new Error('Server returned invalid transfer activity.');
          const sample = result.server || {};
          server = { limit: Number.isInteger(sample.limit) && sample.limit > 0 && sample.limit <= 32 ? sample.limit : server.limit, active: Number.isInteger(sample.active) && sample.active >= 0 ? sample.active : null,
            updatedAt: Number.isFinite(sample.updatedAt) ? sample.updatedAt : null, phase: String(sample.phase || '').slice(0, 100) };
          for (const item of result.items) {
            if (!Number.isInteger(item?.index) || !selected[item.index] || !valid(item.concurrency)) continue;
            const [tabId, lane] = selected[item.index];
            if (lanes.get(tabId) !== lane) continue;
            // Reassert an acknowledged local preference if the server pruned
            // an idle lane. Never overwrite a setting with a stale status read.
            if (!chains.has(tabId) && item.concurrency !== lane.concurrency) { lane.acknowledged = false; lane.forcePreference = true; }
            Object.assign(lane, { active: Number.isInteger(item.active) && item.active >= 0 ? item.active : null,
              pending: Math.max(0, Number(item.pending) || 0), stored: Math.max(0, Number(item.stored) || 0), updatedAt: Date.now(), error: '' });
          }
        } catch (error) {
          server = { ...server, active: null, phase: 'Server activity unavailable' };
          for (const [tabId, lane] of selected) if (lanes.get(tabId) === lane) { lane.active = null; lane.error = String(error?.message || error); }
        }
        deps.changed();
      })().finally(() => { pollWork = null; });
      return pollWork;
    }
    return {
      initialized, poll,
      async token(tabId) { return (await synchronize(tabId)).token; },
      async get(tabId) { const lane = await synchronize(tabId); poll().catch(() => {}); return publicLane(tabId, lane); },
      async set(tabId, concurrency) {
        if (!valid(concurrency)) throw new Error('Server image transfers must be a whole number from 4 to 32.');
        const lane = await synchronize(tabId, concurrency); poll().catch(() => {}); return publicLane(tabId, lane);
      },
      async snapshot(tabId) {
        await initialized; poll().catch(() => {});
        if (Number.isInteger(tabId)) return publicLane(tabId, lanes.get(tabId));
        const tabs = (await deps.tabs()).filter(deps.eligible).slice(0, 100);
        return { tabs: tabs.map(tab => ({ ...publicLane(tab.id, lanes.get(tab.id)), title: String(tab.title || 'Civitai').slice(0, 160), url: tab.url })), server: { ...server } };
      },
      async drop(tabId) { await initialized; if (lanes.delete(tabId)) { await persist(); deps.changed(); } }
    };
  }
  globalThis.ISSDownloadSettings = { create };
})();
