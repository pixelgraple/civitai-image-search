// Coalesce durable queue checkpoints without retaining a snapshot per image.
globalThis.ISSStateCheckpoint = (() => {
  function create({ capture, write, committed = () => {}, delayMs = 500,
    setTimer = setTimeout, clearTimer = clearTimeout }) {
    let pending = null, writing = false, timer = null, revision = 0;
    function schedule() {
      if (!pending || writing || timer !== null) return;
      // Start the window at the first change. Further changes never postpone it.
      timer = setTimer(() => { timer = null; flush(); }, delayMs);
    }
    async function flush() {
      if (writing || !pending) return;
      if (timer !== null) { clearTimer(timer); timer = null; }
      const group = pending, version = revision;
      pending = null; writing = true;
      try {
        // Capture only when this write can start. Changes during the write share
        // one next promise, with no additional queued copies of the large state.
        const snapshot = capture();
        await write(snapshot);
        // Releasing queue ownership requires the latest requested checkpoint.
        committed(snapshot, version === revision);
        group.resolve();
      } catch (error) {
        group.reject(error);
      } finally {
        writing = false; schedule();
      }
    }
    function request() {
      revision++;
      if (!pending) {
        const group = {};
        group.promise = new Promise((resolve, reject) => { group.resolve = resolve; group.reject = reject; });
        pending = group;
      }
      const result = pending.promise;
      schedule();
      // This promise resolves only after a snapshot containing this request's
      // revision is durable, including when another write was already active.
      return result;
    }
    return { request };
  }
  return Object.freeze({ create });
})();
