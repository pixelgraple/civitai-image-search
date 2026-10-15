// Shared, live browser-wide source limit. Server transfer settings are independent.
(() => {
  'use strict';
  function create({ root, send, onApplied = () => {} }) {
    const $ = id => root.getElementById(id);
    const valid = value => Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 4;
    let applied = 1, requested = null, sending = null, failed = null;
    let supported = false, pending = false, editing = false, disposed = false, debounce = null, protectUntil = 0, error = '';
    function render() {
      const target = requested ?? failed ?? sending ?? applied;
      if (!editing) $('sourceConcurrency').value = String(target);
      $('sourceConcurrency').disabled = !supported;
      $('sourceConcurrency').setAttribute('aria-valuetext', `Up to ${target} Civitai requests at once across all tabs`);
      $('sourceValue').textContent = String(editing ? $('sourceConcurrency').value : target);
      $('sourceRetry').hidden = failed === null;
      $('sourceRetry').disabled = !supported || pending;
      $('sourceReset').disabled = !supported;
      $('sourceSettingStatus').textContent = error || (!supported ? 'Connecting to collection settings…' : pending || requested !== null ? `Applying a shared limit of ${target}…` : `Up to ${applied} active across all tabs. Changes apply live; current requests finish.`);
      $('sourceSettingStatus').classList.toggle('error', Boolean(error));
    }
    async function apply() {
      if (disposed || pending || requested === null) return;
      const value = requested; requested = null; sending = value; pending = true; error = ''; render();
      try {
        const result = await send({ type: 'setSourceConcurrency', sourceConcurrency: value });
        if (disposed) return;
        const actual = result?.config?.sourceConcurrency ?? result?.collectionSpeed?.sourceConcurrency;
        if (!result?.ok || !valid(actual)) throw new Error(result?.error || 'Could not save the Civitai limit.');
        applied = Number(actual); protectUntil = Date.now() + 1000; onApplied(result);
      } catch (failure) {
        if (!disposed && requested === null) { failed = value; error = `Limit was not changed: ${failure.message || 'Try again.'}`; }
      } finally {
        pending = false; sending = null;
        if (!disposed) { render(); if (requested !== null && debounce === null) apply(); }
      }
    }
    function choose(value) {
      if (!supported || !valid(value)) return;
      requested = Number(value); failed = null; error = ''; clearTimeout(debounce);
      debounce = setTimeout(() => { debounce = null; apply(); }, 200); render();
    }
    $('sourceConcurrency').addEventListener('input', () => choose($('sourceConcurrency').value));
    $('sourceConcurrency').addEventListener('pointerdown', () => { editing = true; });
    for (const event of ['change', 'pointerup', 'pointercancel', 'blur']) $('sourceConcurrency').addEventListener(event, () => { editing = false; render(); });
    $('sourceReset').addEventListener('click', () => { editing = false; choose(1); });
    $('sourceRetry').addEventListener('click', () => choose(failed));
    render();
    return {
      accept(config, effective, compatible = true) {
        const value = config?.sourceConcurrency ?? effective?.sourceConcurrency;
        supported = compatible && valid(value);
        if (supported && !pending && requested === null && failed === null && !editing && !(Date.now() < protectUntil && Number(value) !== applied)) applied = Number(value);
        render();
      },
      dispose() { disposed = true; clearTimeout(debounce); debounce = null; }
    };
  }
  globalThis.ISSSourceControl = { create };
})();
