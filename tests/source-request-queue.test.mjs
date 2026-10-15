import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../tab-feed-request.js', import.meta.url), 'utf8');
const page = 'https://civitai.red/models/99';
const url = 'https://civitai.red/api/trpc/image.getInfinite?input=%7B%22json%22%3A%7B%22modelId%22%3A99%7D%7D';
const success = () => ({ ok: true, status: 200, data: { result: { data: { json: { items: [] } } } } });
const failure = (status, retryAfter = null) => ({ ok: false, status, data: { error: { json: { message: `Source HTTP ${status}`, data: { httpStatus: status } } } }, retryAfter });
const observe = promise => promise.then(value => ({ ok: true, value }), error => ({ ok: false, error }));

function harness(saved = {}) {
  let now = Date.UTC(2026, 9, 14, 12), timerId = 0;
  const timers = new Map(), calls = [], storage = structuredClone(saved);
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const context = vm.createContext({ URL, Date: Clock, AbortSignal, Promise,
    ISSFeed: { decode: value => value?.json ?? value },
    setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { at: now + delay, callback }); return id; },
    clearTimeout: id => timers.delete(id),
    chrome: { runtime: { lastError: null }, storage: { local: {
      get: (key, callback) => queueMicrotask(() => callback(structuredClone(storage))),
      set: (value, callback) => { Object.assign(storage, structuredClone(value)); queueMicrotask(callback); }
    } }, scripting: { executeScript: async options => {
      calls.push({ time: now, tabId: options.target.tabId, url: options.args[0], deadline: options.args[2] });
      return [{ result: await api.reply(options) }];
    } } }
  });
  vm.runInContext(source, context);
  const flush = async () => { for (let index = 0; index < 40; index++) await Promise.resolve(); };
  const api = { context, calls, storage, reply: success, now: () => now, flush,
    request: (tabId, isCurrent) => context.requestCivitaiFeed(tabId, url, page, isCurrent),
    state: () => context.getCivitaiSourceRequestState(), resume: () => context.resumeCivitaiSourceRequests(),
    async advance(ms) {
      now += ms;
      for (;;) {
        const due = [...timers].filter(([, item]) => item.at <= now);
        if (!due.length) break;
        for (const [id, item] of due) { timers.delete(id); item.callback(); }
        await flush();
      }
      await flush();
    }
  };
  return api;
}

test('all tabs share at most two active source requests with paced starts', async () => {
  const h = harness(), releases = [];
  h.reply = () => h.calls.length <= 2 ? new Promise(resolve => { releases.push(resolve); }) : success();
  const first = observe(h.request(7)), second = observe(h.request(8)), third = observe(h.request(9));
  await h.flush(); assert.equal(h.calls.length, 1); assert.equal((await h.state()).queued, 2);
  await h.advance(1999); assert.equal(h.calls.length, 1);
  await h.advance(1); assert.equal(h.calls.length, 2); assert.equal((await h.state()).activeCount, 2);
  await h.advance(5000); assert.equal(h.calls.length, 2, 'third request waits for one of the two slots');
  releases[0](success()); await h.flush(); assert.equal((await first).ok, true); assert.equal((await third).ok, true);
  releases[1](success()); await h.flush(); assert.equal((await second).ok, true);
  assert.deepEqual(h.calls.map(call => call.tabId), [7, 8, 9]);
  assert.equal(h.calls[1].time - h.calls[0].time, 2000);
  assert.equal(h.calls[2].time - h.calls[1].time, 5000);
  assert.equal((await h.state()).intervalMs, 2000);
});
test('a rejection with two source requests active prevents every further start through cooldown', async () => {
  const h = harness(), releases = [];
  h.reply = () => new Promise(resolve => releases.push(resolve));
  const work = [observe(h.request(7)), observe(h.request(8)), observe(h.request(9))];
  await h.flush(); await h.advance(2000); assert.equal(h.calls.length, 2);
  releases[0](failure(429, '600')); await h.flush();
  assert.equal((await work[0]).error.status, 429); assert.equal((await work[2]).error.status, 429);
  releases[1](success()); await h.flush(); assert.equal((await work[1]).ok, true);
  await h.advance(599999); assert.equal(h.calls.length, 2);
  const refused = await observe(h.request(10)); assert.equal(refused.error.retryAfterMs, 1);
});

test('new tabs get source turns before another tab exhausts twelve metadata requests', async () => {
  const h = harness();
  const work = Array.from({ length: 12 }, () => observe(h.request(7)));
  await h.flush();
  work.push(observe(h.request(8)), observe(h.request(8)), observe(h.request(9)), observe(h.request(9)));
  await h.flush();
  for (let index = 0; index < 15; index++) await h.advance(2000);
  assert.equal((await Promise.all(work)).every(result => result.ok), true);
  assert.deepEqual(h.calls.slice(0, 6).map(call => call.tabId), [7, 8, 9, 7, 8, 9]);
  assert.equal(h.calls[1].time - h.calls[0].time, 2000);
  assert.ok(h.calls.slice(1).every((call, index) => call.time - h.calls[index].time >= 2000));
  assert.equal((await h.state()).queued, 0);
});

test('source transitions notify live activity without making status reads create work', async () => {
  const h = harness(); let changes = 0, release;
  h.context.indexCivitaiStatusChanged = () => { changes++; };
  h.reply = () => new Promise(resolve => { release = resolve; });
  const pending = observe(h.request(7)); await h.flush();
  assert.ok(changes >= 2, 'enqueue and request start notify');
  const beforeRead = changes; await h.state(); assert.equal(changes, beforeRead);
  release(failure(429, '60')); await h.flush(); await pending;
  assert.ok(changes > beforeRead, 'cooldown and completion notify');
  const beforeResume = changes; await h.resume(); assert.ok(changes > beforeResume);
});

test('429 drains every queued tab and preserves a long Retry-After without shortening it', async () => {
  const h = harness(); h.reply = () => failure(429, '900');
  const results = [7, 8, 9].map(id => observe(h.request(id))); await h.flush();
  for (const result of await Promise.all(results)) { assert.equal(result.ok, false); assert.equal(result.error.status, 429); assert.equal(result.error.retryAfterMs, 900000); }
  assert.equal(h.calls.length, 1); assert.equal((await h.state()).queued, 0);
  assert.equal(h.storage.indexCivitaiSourceGuardV1.cooldownUntil, h.now() + 900000);
  await h.resume(); assert.equal((await observe(h.request(10))).error.status, 429);
  await h.advance(899999); assert.equal((await observe(h.request(10))).error.retryAfterMs, 1);
  assert.equal(h.calls.length, 1);
  await h.advance(1); h.reply = success;
  assert.equal((await observe(h.request(10))).ok, true); assert.equal(h.calls.length, 2);
});

test('HTTP-date Retry-After uses the full requested deadline', async () => {
  const h = harness(), deadline = h.now() + 1200000;
  h.reply = () => failure(429, new Date(deadline).toUTCString());
  const result = await observe(h.request(7)); assert.equal(result.error.retryAfterMs, 1200000);
  assert.equal((await h.state()).blockedUntil, deadline);
});

test('source cooldown survives a service worker restart and makes no speculative retry', async () => {
  const h = harness(); h.reply = () => failure(429, '1200'); await observe(h.request(7));
  const restored = harness(h.storage), state = await restored.state();
  assert.equal(state.retryAfterMs, 1200000);
  assert.equal((await observe(restored.request(8))).error.status, 429);
  assert.equal(restored.calls.length, 0);
  await restored.advance(1200000);
  assert.equal((await observe(restored.request(8))).ok, true); assert.equal(restored.calls.length, 1);
});

for (const status of [401, 403]) test(`HTTP ${status} stops all tabs until a deliberate manual resume, including after restart`, async () => {
  const h = harness(); h.reply = () => failure(status);
  const results = [7, 8, 9].map(id => observe(h.request(id))); await h.flush();
  for (const result of await Promise.all(results)) assert.equal(result.error.status, status);
  assert.equal(h.calls.length, 1); assert.equal((await h.state()).authStatus, status);
  const restored = harness(h.storage); await restored.advance(86400000);
  assert.equal((await observe(restored.request(8))).error.status, status); assert.equal(restored.calls.length, 0);
  await restored.resume(); assert.equal((await observe(restored.request(8))).ok, true);
  assert.equal(restored.calls.length, 1); assert.equal((await restored.state()).authStatus, 0);
});

test('HTTP 200 tRPC rejection still pauses the shared queue', async () => {
  const h = harness(); h.reply = () => ({ ok: true, status: 200, data: { error: { json: { message: 'Too many requests', data: { code: 'TOO_MANY_REQUESTS' } } } }, retryAfter: '600' });
  const result = await observe(h.request(7)); assert.equal(result.error.status, 429);
  assert.equal((await h.state()).retryAfterMs, 600000);
});

test('stopped source runs are cancelled before their queued request reaches Civitai', async () => {
  const h = harness(); let current = true;
  const first = observe(h.request(7)), stopped = observe(h.request(8, () => current)), third = observe(h.request(9));
  await h.flush(); assert.equal((await first).ok, true); current = false;
  await h.advance(2000); const cancelled = await stopped;
  assert.equal(cancelled.error.sourceCancelled, true); assert.equal(h.calls.length, 1);
  await h.advance(2000); assert.equal((await third).ok, true);
  assert.deepEqual(h.calls.map(call => call.tabId), [7, 9]);
});

test('source queue has a fixed pending bound and overflow sends no source request', async () => {
  const h = harness(); let release;
  h.reply = () => new Promise(resolve => { release = resolve; });
  const results = Array.from({ length: 36 }, (_, index) => observe(h.request(index + 1)));
  await h.flush(); assert.equal(h.calls.length, 1); assert.equal((await h.state()).queued, 32);
  release(failure(429, '60')); await h.flush();
  const completed = await Promise.all(results);
  assert.equal(completed.filter(result => result.error.status === 503).length, 3);
  assert.equal(completed.filter(result => result.error.status === 429).length, 33);
  assert.equal(h.calls.length, 1); assert.equal((await h.state()).queued, 0);
});

test('invalid tab ids and checking source status never create source requests', async () => {
  const h = harness(); await h.state();
  assert.equal((await observe(h.request(null))).error.status, 409);
  assert.equal(h.calls.length, 0);
});

test('503 with Retry-After also drains source work and shares the full cooldown', async () => {
  const h = harness(); h.reply = () => failure(503, '700');
  const one = observe(h.request(7)), two = observe(h.request(8));
  assert.equal((await one).error.status, 503); assert.equal((await two).error.status, 429);
  assert.equal((await h.state()).retryAfterMs, 700000); assert.equal(h.calls.length, 1);
});

test('upstream 5xx failures stop queued tabs for a shared recovery pause', async () => {
  for (const status of [500, 502, 504]) {
    const h = harness(); h.reply = () => failure(status);
    const one = observe(h.request(7)), two = observe(h.request(8));
    assert.equal((await one).error.status, status); assert.equal((await two).error.status, 429);
    assert.equal((await h.state()).retryAfterMs, 60000); assert.equal(h.calls.length, 1);
  }
});

test('a frozen tab cannot hold the shared source queue indefinitely', async () => {
  const h = harness(); let release;
  h.reply = () => h.calls.length === 1 ? new Promise(resolve => { release = resolve; }) : success();
  const one = observe(h.request(7)), two = observe(h.request(8)); await h.flush();
  assert.equal(h.calls[0].deadline, h.now() + 20000);
  await h.advance(21000); const timeout = await one;
  assert.equal(timeout.error.sourceTimeout, true); assert.equal(h.calls.length, 2);
  release(success()); await h.flush();
  await h.advance(2000); assert.equal((await two).ok, true); assert.equal(h.calls.length, 2);
});

test('a delayed tab injection expires without fetching source data', async () => {
  const h = harness(); let fetched = 0;
  h.context.fetch = async () => { fetched++; return { ok: true }; };
  h.context.location = { origin: 'https://civitai.red' };
  const expired = await h.context.requestCivitaiFeedInTab(url, 'https://civitai.red', h.now() - 1);
  assert.equal(expired.ok, false); assert.equal(expired.status, 0); assert.equal(fetched, 0);
});
