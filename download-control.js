// Shared UI for the tab panel and Browsing & activity. No collection identity is exposed.
(() => {
  'use strict';
  function create({ root, send, chooseTab = false }) {
    const $ = id => root.getElementById(id), states = new Map();
    let selected = null, supported = false, disposed = false, requested = null, sending = null, failed = null;
    let debounce = null, pending = false, error = '', loading = false, activeLoad = 0;
    const valid = value => Number.isInteger(value) && value >= 4 && value <= 32;
    const count = value => value == null ? '—' : Math.max(0, Number(value) || 0).toLocaleString();
    const command = type => ({ type, ...(chooseTab ? { tabId: selected } : {}) });
    const current = () => states.get(selected);
    function render() {
      const state = current(), target = requested ?? failed ?? sending ?? state?.concurrency ?? 32;
      $('downloadConcurrency').value = String(target);
      $('downloadConcurrency').disabled = !supported || selected == null || !state?.acknowledged;
      if (chooseTab) $('downloadTab').disabled = !supported || selected == null || pending;
      $('downloadConcurrency').setAttribute('aria-valuetext', `Up to ${target} simultaneous server image transfers for this tab`);
      $('downloadValue').textContent = String(target);
      $('downloadRetry').hidden = !error;
      $('downloadRetry').disabled = pending || loading || !supported || selected == null;
      $('downloadStatus').textContent = error || (selected == null ? 'Open a Civitai tab to set its server transfers.' :
        pending || requested !== null ? `Applying ${target} transfers for this tab…` : !state?.acknowledged ? 'Connecting this tab’s transfer settings…' :
          `Up to ${state.concurrency} at once for this tab. Changes apply to the next transfers; current transfers finish.`);
      $('downloadStatus').classList.toggle('error', !!error);
      const updated = state?.updatedAt ? ` · updated ${Math.max(0, Math.floor((Date.now() - state.updatedAt) / 1000))}s ago` : '';
      $('downloadActivity').textContent = state?.acknowledged ?
        `This tab: ${count(state.active)} active · ${count(state.pending)} pending on server · ${count(state.stored)} stored. Shared server: ${count(state.server?.active)} / ${state.serverMax || 32} active${updated}.${state.error ? ` Activity unavailable: ${state.error}` : ''}` :
        'Live server activity refreshes every 5 seconds. A dash means current activity is unavailable.';
    }
    async function load() {
      if (!supported || selected == null || loading || disposed) return;
      const tabId = selected, epoch = ++activeLoad; loading = true; error = ''; render();
      try {
        const result = await send(command('getDownloadSettings'));
        if (disposed || epoch !== activeLoad || tabId !== selected) return;
        if (!result?.ok || !valid(result.transfers?.concurrency)) throw new Error(result?.error || 'Could not read server transfer settings.');
        states.set(selected, result.transfers);
      } catch (failure) { if (!disposed && tabId === selected) error = failure.message || 'Could not read server transfer settings.'; }
      finally { if (epoch === activeLoad) { loading = false; if (!disposed) render(); } }
    }
    async function apply() {
      if (disposed || pending || requested == null || selected == null) return;
      const value = requested, tabId = selected; requested = null; sending = value; pending = true; error = ''; render();
      try {
        const result = await send({ ...command('setDownloadConcurrency'), concurrency: value });
        if (disposed) return;
        if (!result?.ok || !valid(result.transfers?.concurrency)) throw new Error(result?.error || 'Could not apply server transfer limit.');
        states.set(tabId, result.transfers);
      } catch (failure) {
        if (!disposed && tabId === selected && requested == null) { failed = value; error = `Transfer limit was not changed: ${failure.message || 'Try again.'}`; }
      } finally {
        pending = false; sending = null;
        if (!disposed) { render(); if (requested !== null && debounce === null) apply(); }
      }
    }
    function choose(value) {
      if (!supported || !valid(Number(value)) || !current()) return;
      requested = Number(value); failed = null; error = ''; clearTimeout(debounce);
      debounce = setTimeout(() => { debounce = null; apply(); }, 300); render();
    }
    $('downloadConcurrency').addEventListener('input', () => choose($('downloadConcurrency').value));
    $('downloadRetry').addEventListener('click', () => { if (failed !== null) choose(failed); else load(); });
    if (chooseTab) $('downloadTab').addEventListener('change', () => {
      selected = Number($('downloadTab').value); ++activeLoad; loading = false;
      requested = failed = null; clearTimeout(debounce); debounce = null; error = ''; render(); load();
    });
    render();
    return {
      accept(value, compatible = true) {
        if (disposed) return;
        supported = compatible;
        if (chooseTab && Array.isArray(value?.tabs)) {
          const available = new Set(value.tabs.map(tab => tab.tabId));
          if (!available.has(selected)) {
            selected = value.tabs[0]?.tabId ?? null; ++activeLoad; loading = false; requested = failed = null; error = '';
            clearTimeout(debounce); debounce = null;
          }
          const select = $('downloadTab'), signature = JSON.stringify(value.tabs.map(tab => [tab.tabId, tab.title]));
          if (select.dataset.options !== signature) {
            select.replaceChildren();
            for (const tab of value.tabs) { const option = document.createElement('option'); option.value = String(tab.tabId); option.textContent = `Tab ${tab.tabId} · ${tab.title || 'Civitai'}`; select.appendChild(option); }
            select.dataset.options = signature;
          }
          select.value = selected == null ? '' : String(selected); select.disabled = !supported || !value.tabs.length || pending;
          for (const tab of value.tabs) if (valid(tab.concurrency)) states.set(tab.tabId, tab);
        } else if (!chooseTab && Number.isInteger(value?.tabId) && valid(value.concurrency)) {
          selected = value.tabId; states.set(selected, value);
        }
        render();
        if (supported && selected != null && !current()?.acknowledged && !loading && !error) load();
      },
      tick: render,
      dispose() { disposed = true; ++activeLoad; clearTimeout(debounce); }
    };
  }
  globalThis.ISSDownloadControl = { create };
})();
