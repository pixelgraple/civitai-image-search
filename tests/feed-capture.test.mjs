import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../civitai-feed-capture.js', import.meta.url), 'utf8');
const feed = (id = 1, origin = 'https://civitai.red', procedure = 'image.getInfinite') =>
  `${origin}/api/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify({ json: { modelId: id } }))}`;
const entry = (name = feed(), startTime = 10, extra = {}) => ({ name, startTime, initiatorType: 'fetch', ...extra });

function harness({ entries = [], observerMissing = false, bufferedMissing = false, nested = false } = {}) {
  let time = 100, nextId = 0, observerCallback, disconnected = false;
  const timers = new Map(), scrolls = [], observers = [], events = new Map(), navigationEvents = new Map();
  const resourceEntries = [...entries], location = { href: 'https://civitai.red/models/1' };
  const root = { scrollTop: 0, scrollHeight: nested ? 900 : 6000, clientHeight: 900,
    scrollTo(options) { scrolls.push({ kind: 'document', ...options }); this.scrollTop = options.top; } };
  const viewport = { scrollTop: 0, scrollHeight: 9000, clientHeight: 900,
    scrollTo(options) { scrolls.push({ kind: 'viewport', ...options }); this.scrollTop = options.top; } };
  function schedule(fn, delay, interval) { const id = ++nextId; timers.set(id, { fn, at: time + delay, interval }); return id; }
  const window = {
    addEventListener(type, handler) { events.set(type, handler); }, removeEventListener(type) { events.delete(type); },
    navigation: { addEventListener(type, handler) { navigationEvents.set(type, handler); }, removeEventListener(type) { navigationEvents.delete(type); } },
    scrollTo(options) { scrolls.push({ kind: 'window', ...options }); }
  };
  const context = vm.createContext({ window, location, URL, getComputedStyle: () => ({ overflowY: 'auto' }),
    performance: { now: () => time, getEntriesByType: type => { assert.equal(type, 'resource'); return resourceEntries; } },
    document: { scrollingElement: root, documentElement: root, querySelectorAll: () => nested ? [viewport] : [] },
    setTimeout: (fn, delay) => schedule(fn, delay, 0), clearTimeout: id => timers.delete(id),
    setInterval: (fn, delay) => schedule(fn, delay, delay), clearInterval: id => timers.delete(id),
    ...(observerMissing ? {} : { PerformanceObserver: class {
      constructor(fn) { observerCallback = fn; }
      observe(options) { observers.push(options); if (bufferedMissing && options.buffered) throw new Error('unsupported'); }
      disconnect() { disconnected = true; }
    } }),
    fetch() { throw new Error('Capture must never make network requests'); }
  });
  vm.runInContext(source, context);
  return { api: window.__ISS_FEED_CAPTURE, root, viewport, location, resourceEntries, scrolls, observers, timers,
    get disconnected() { return disconnected; },
    emit(records) { observerCallback?.({ getEntries: () => records }); },
    route(url, { event = 'navigation' } = {}) {
      location.href = url;
      if (event === 'navigation') navigationEvents.get('currententrychange')?.();
      else if (event) events.get(event)?.();
    },
    rerun() { vm.runInContext(source, context); return window.__ISS_FEED_CAPTURE; },
    tick(ms) {
      const end = time + ms;
      for (let steps = 0; steps < 10000; steps++) {
        const due = [...timers].filter(([, value]) => value.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) { time = end; return; }
        const [id, timer] = due; time = timer.at;
        if (timer.interval) timer.at += timer.interval; else timers.delete(id);
        timer.fn();
      }
      throw new Error('unbounded timer loop');
    }
  };
}

test('document-start observer remembers current-tab feeds without scrolling or networking', () => {
  const h = harness({ entries: [entry()] });
  assert.deepEqual(Array.from(h.api.snapshot()), [feed()]);
  assert.equal(h.observers[0].type, 'resource'); assert.equal(h.observers[0].buffered, true);
  h.tick(60000); assert.equal(h.scrolls.length, 0); assert.equal(h.timers.size, 1);
});

test('valid feed capture bypasses bootstrap and preserves exact filters', async () => {
  const h = harness(); const url = feed(42);
  h.emit([entry(url)]); assert.deepEqual(Array.from(await h.api.capture()), [url]);
  assert.equal(h.scrolls.length, 0); assert.equal(h.timers.size, 1);
});

test('ignores unsupported procedures, foreign origins, invalid input, and non-fetch resources', () => {
  const h = harness({ entries: [
    entry(feed(1, 'https://civitai.com')), entry(feed(1, 'https://evil.example')),
    entry(feed(1, 'https://civitai.red', 'image.getGenerationData')),
    entry('https://civitai.red/api/trpc/image.getInfinite'),
    entry('https://civitai.red/api/trpc/image.getInfinite?input=null'),
    entry('https://civitai.red/api/trpc/image.getInfinite?input=bad'),
    entry(feed() + '#fragment'), entry(feed(), 10, { initiatorType: 'img' }),
    entry(feed(), NaN), entry('https://civitai.red/api/trpc/image.getInfinite?input=' + 'a'.repeat(40000))
  ] });
  assert.equal(h.api.snapshot().length, 0);
});

test('supports the alternate feed and mixed batched request URLs', () => {
  const h = harness();
  const alternate = feed(2, 'https://civitai.red', 'image.getImagesAsPostsInfinite');
  const batch = `https://civitai.red/api/trpc/model.getById,image.getInfinite?batch=1&input=${encodeURIComponent(JSON.stringify({ 0: { json: { id: 4 } }, 1: { json: { modelId: 4 } } }))}`;
  h.emit([entry(alternate, 20), entry(batch, 30)]);
  assert.deepEqual(Array.from(h.api.snapshot()), [alternate, batch]);
});

test('retains at most 32 most-recent URLs and keeps out-of-order observer batches sorted', () => {
  const h = harness();
  h.emit(Array.from({ length: 50 }, (_, index) => entry(feed(index), index + 1)).reverse());
  assert.equal(h.api.snapshot().length, 32);
  assert.equal(h.api.snapshot()[0], feed(18)); assert.equal(h.api.snapshot().at(-1), feed(49));
  h.emit([entry(feed(18), 75), entry(feed(18), 1)]);
  assert.equal(h.api.snapshot().at(-1), feed(18));
});

test('retains entries even after the browser evicts resource timings', () => {
  const h = harness({ entries: [entry()] }); h.resourceEntries.length = 0;
  assert.deepEqual(Array.from(h.api.snapshot()), [feed()]);
});

test('navigation clears earlier feeds and delayed requests started on the old page', () => {
  const h = harness({ entries: [entry(feed(1), 10)] }); h.tick(50);
  h.route('https://civitai.red/models/2');
  h.emit([entry(feed(1), 140)]); assert.equal(h.api.snapshot().length, 0);
  h.emit([entry(feed(2), 151)]); assert.deepEqual(Array.from(h.api.snapshot()), [feed(2)]);
  h.tick(50); h.route('https://civitai.red/models/1');
  assert.equal(h.api.snapshot().length, 0, 'going back must not reuse initial buffered timings');
});

test('route polling and snapshot detect pushState without patching history', () => {
  const h = harness({ entries: [entry()] });
  h.route('https://civitai.red/images?tags=2', { event: null }); h.tick(500);
  assert.equal(h.api.snapshot().length, 0);
  h.emit([entry(feed(2), 601)]); assert.equal(h.api.snapshot().length, 1);
  h.route('https://civitai.red/images?tags=3', { event: null });
  assert.equal(h.api.snapshot().length, 0);
});

test('empty explicit capture performs one finite scroll and resolves a newly observed feed', async () => {
  const h = harness(); const promise = h.api.capture();
  assert.deepEqual(h.scrolls, [{ kind: 'document', top: 5100, behavior: 'instant' }]);
  h.tick(2000); assert.equal(h.scrolls.length, 1);
  h.emit([entry(feed(8), 2050)]); assert.deepEqual(Array.from(await promise), [feed(8)]);
  assert.equal(h.timers.size, 1);
});

test('bootstrap scroll distance is bounded and nested scroll viewport is supported', async () => {
  const h = harness(); h.root.scrollHeight = 1000000;
  const promise = h.api.capture(); assert.equal(h.scrolls[0].top, 12000); h.api.cancel(); await promise;
  const nested = harness({ nested: true }); const nestedPromise = nested.api.capture();
  assert.deepEqual(nested.scrolls, [{ kind: 'viewport', top: 8100, behavior: 'instant' }]);
  nested.api.cancel(); await nestedPromise;
});

test('repeated start shares the bounded bootstrap rather than scrolling or observing again', async () => {
  const h = harness(); const first = h.api.capture(), second = h.api.capture();
  assert.equal(first, second); assert.equal(h.scrolls.length, 1); assert.equal(h.observers.length, 1);
  h.api.cancel(); assert.equal((await first).length, 0); assert.equal((await second).length, 0);
});

test('missing feed times out with no retries, networking, or continued scroll loop', async () => {
  const h = harness(); const promise = h.api.capture({ timeoutMs: 500 });
  h.tick(500); assert.equal((await promise).length, 0); assert.equal(h.timers.size, 1);
  h.tick(10000); assert.equal(h.scrolls.length, 1);
});

test('Stop and AbortSignal cancel bootstrap immediately and remove pending timers', async () => {
  const h = harness(); const promise = h.api.capture(); h.api.cancel();
  assert.equal((await promise).length, 0); assert.equal(h.timers.size, 1);
  const controller = new AbortController(); const second = h.api.capture({ signal: controller.signal });
  controller.abort(); assert.equal((await second).length, 0); assert.equal(h.timers.size, 1);
  const scrollCount = h.scrolls.length;
  assert.equal((await h.api.capture({ signal: controller.signal })).length, 0);
  assert.equal(h.scrolls.length, scrollCount);
});

test('navigation while starting cancels rather than starting a different feed', async () => {
  const h = harness(); const promise = h.api.capture(); h.route('https://civitai.red/models/9');
  assert.equal((await promise).length, 0); assert.equal(h.timers.size, 1);
  h.emit([entry(feed(9), 101)]); assert.deepEqual(Array.from(h.api.snapshot()), [feed(9)]);
});

test('two tabs bootstrap independently and cancelling one leaves the other active', async () => {
  const first = harness(), second = harness(); const p1 = first.api.capture(), p2 = second.api.capture();
  first.api.cancel(); second.emit([entry(feed(2))]);
  assert.equal((await p1).length, 0); assert.deepEqual(Array.from(await p2), [feed(2)]);
  assert.equal(first.api.snapshot().length, 0); assert.equal(first.scrolls.length, 1); assert.equal(second.scrolls.length, 1);
});

test('observer fallback uses timing polling only during the finite bootstrap', async () => {
  const h = harness({ observerMissing: true }); const promise = h.api.capture();
  h.resourceEntries.push(entry(feed(3), 101)); h.tick(250);
  assert.deepEqual(Array.from(await promise), [feed(3)]); assert.equal(h.timers.size, 1);
  const fallback = harness({ bufferedMissing: true });
  assert.equal(fallback.observers.length, 2); assert.equal(fallback.observers[1].entryTypes[0], 'resource');
});

test('dispose cancels capture and disconnects all observers and timers', async () => {
  const h = harness(); const promise = h.api.capture(); h.api.dispose();
  assert.equal((await promise).length, 0); assert.equal(h.disconnected, true); assert.equal(h.timers.size, 0);
  h.emit([entry()]); assert.equal(h.api.snapshot().length, 0); assert.equal((await h.api.capture()).length, 0);
});

test('reinjecting the same version is idempotent', () => {
  const h = harness(); assert.equal(h.rerun(), h.api); assert.equal(h.observers.length, 1); assert.equal(h.timers.size, 1);
});

test('disposing allows a fresh observer to be installed on reinjection', () => {
  const h = harness(); h.api.dispose(); const replacement = h.rerun();
  assert.notEqual(replacement, h.api); assert.equal(h.observers.length, 2); assert.equal(h.timers.size, 1);
});
