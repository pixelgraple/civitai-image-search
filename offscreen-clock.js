// Offscreen WORKERS reason: only a clock, with no network or file operations.
setInterval(() => postMessage('pulse'), 1000);
