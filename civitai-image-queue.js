// One image-work queue for the service worker. Manual scans and passive
// collection share bounded groups and rest periods from the live speed profile.
globalThis.ISSImageQueue = (() => {
  'use strict';
  function create({ setTimer = setTimeout, clearTimer = globalThis.clearTimeout || (() => {}), cooldownMs, maxPending = 100 } = {}) {
    const speed = () => globalThis.ISSCollectionSpeed?.get() || { metadataConcurrency: 12, imageCooldownMs: 1000 };
    const delay = () => cooldownMs == null ? speed().imageCooldownMs : Math.min(60000, Math.max(1000, Number(cooldownMs) || 1000));
    const limit = Math.min(600, Math.max(1, Math.floor(Number(maxPending) || 100)));
    let cooldownTimer = null, cooldownStartedAt = 0, cooldownEpoch = 0;
    const notify = () => { try { globalThis.indexCivitaiStatusChanged?.(); } catch {} };
    let waiting = [], active = 0, groupStarted = 0, coolingDown = false, pumping = false, checking = null;
    const error = (name, message) => Object.assign(new Error(message), { name });
    // Expected lifecycle cancellation, distinct from a failed source request.
    const cancelled = () => Object.assign(error('AbortError', 'This image collection was stopped before it started.'),
      { status: 409, code: 'COLLECTION_CANCELLED' });
    const current = job => {
      try {
        const value = job.isCurrent();
        return value && typeof value.then === 'function'
          ? Promise.resolve(value).then(result => result !== false, () => false)
          : value !== false;
      } catch { return false; }
    };

    function prune() {
      waiting = waiting.filter(job => {
        const result = job.probe || current(job);
        if (result && typeof result.then === 'function') {
          if (!job.probe) {
            job.probe = result;
            result.then(valid => {
              if (job.probe === result) job.probe = null;
              if (valid) return;
              const index = waiting.indexOf(job);
              if (index < 0) return; // The pump owns a job already being checked.
              waiting.splice(index, 1); job.reject(cancelled()); notify(); pump();
            });
          }
          return true;
        }
        if (result) return true;
        job.reject(cancelled()); return false;
      });
    }
    function settled(job, ok, result) {
      active--;
      if (ok) job.resolve(result); else job.reject(result);
      prune();
      notify(); pump();
    }
    function start(job) {
      active++; groupStarted++;
      notify();
      let result;
      try { result = job.task(); } catch (cause) { result = Promise.reject(cause); }
      Promise.resolve(result).then(value => settled(job, true, value), cause => settled(job, false, cause));
    }
    function pump() {
      if (pumping || checking) return;
      pumping = true;
      try {
        if (coolingDown) return;
        while (waiting.length && active < speed().metadataConcurrency && groupStarted < speed().metadataConcurrency) {
          const job = waiting.shift();
          const result = job.probe || current(job);
          if (result && typeof result.then === 'function') {
            // Reserve one slot while checking the next FIFO item. No later
            // image can overtake it or exceed the live group limit.
            checking = job;
            notify();
            result.then(valid => {
              checking = null;
              notify();
              if (valid) {
                if (active < speed().metadataConcurrency && groupStarted < speed().metadataConcurrency) start(job);
                else waiting.unshift(job); // A live slowdown never cancels queued work.
              } else job.reject(cancelled());
              pump();
            });
            break;
          }
          if (!result) { job.reject(cancelled()); continue; }
          start(job);
        }
        // Limit starts within each short window, while allowing a completed
        // slot to refill even when another image remains slow or stalled.
        if (groupStarted >= speed().metadataConcurrency) {
          coolingDown = true; cooldownStartedAt = Date.now();
          notify(); scheduleCooldown();
        }
      } finally { pumping = false; }
    }
    function scheduleCooldown(rescheduling = false) {
      if (cooldownTimer !== null) clearTimer(cooldownTimer);
      const epoch = ++cooldownEpoch;
      cooldownTimer = setTimer(() => {
        if (epoch !== cooldownEpoch) return;
        cooldownTimer = null; coolingDown = false; groupStarted = 0; notify(); pump();
      }, rescheduling ? Math.max(0, cooldownStartedAt + delay() - Date.now()) : delay());
    }
    globalThis.ISSCollectionSpeed?.subscribe(() => {
      if (coolingDown && active > 0 && groupStarted < speed().metadataConcurrency) {
        clearTimer(cooldownTimer); cooldownTimer = null; cooldownEpoch++; coolingDown = false;
      } else if (coolingDown) scheduleCooldown(true);
      notify(); pump();
    });
    function run(task, isCurrent = () => true) {
      if (typeof task !== 'function' || typeof isCurrent !== 'function') return Promise.reject(new TypeError('Image work and its cancellation check must be functions.'));
      return new Promise((resolve, reject) => {
        const job = { task, isCurrent, resolve, reject };
        prune();
        if (waiting.length + (checking ? 1 : 0) >= limit) { reject(error('QueueFullError', 'The image collection queue is full. Let current images finish before trying again.')); return; }
        waiting.push(job); prune(); notify(); pump();
      });
    }
    function status() { return { active, pending: waiting.length + (checking ? 1 : 0), checking: checking ? 1 : 0, groupStarted, coolingDown, concurrency: speed().metadataConcurrency, cooldownMs: delay(), pendingLimit: limit }; }
    return Object.freeze({ run, status });
  }
  return Object.freeze({ ...create({ maxPending: 600 }), create });
})();
