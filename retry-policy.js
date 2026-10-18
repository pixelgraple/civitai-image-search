// Retry connection interruptions without resuming a user's deliberately stopped tab.
globalThis.ISSRetryPolicy = (() => {
  function isTransient(error) {
    const status = Number(error?.status) || Number(String(error?.message || '').match(/HTTP (\d{3})\b/)?.[1]) || 0;
    if (status) return [408, 425, 429].includes(status) || (status >= 500 && status <= 599);
    return ['AbortError', 'TimeoutError', 'NetworkError'].includes(error?.name) ||
      /failed to fetch|network(?: request failed|error| error)|load failed|timed out|could not reach its feed|source tab did not respond|network connection failed/i.test(String(error?.message || ''));
  }
  function delay(error) {
    return Math.max(5000, Number(error?.retryAfterMs) || 0, Number(error?.status) === 429 ? 60000 : 0);
  }
  return Object.freeze({ isTransient, delay });
})();
