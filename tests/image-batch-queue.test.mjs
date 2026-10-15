import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../civitai-image-queue.js', import.meta.url), 'utf8');
const GROUP = 12;
const indices = (start, end) => Array.from({length: end - start}, (_, index) => start + index);
const flush = async () => { for (let count = 0; count < 64; count++) await Promise.resolve(); };
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function harness(options = {}) {
  let time = 0; const timers = [];
  const setTimer = (fn, delay) => { timers.push({ fn, at: time + delay }); return timers.length; };
  const context = vm.createContext({ setTimeout: setTimer }); vm.runInContext(source, context);
  const queue = context.ISSImageQueue.create({ setTimer, ...options });
  return { queue, singleton: context.ISSImageQueue, timers,
    tick(ms) { time += ms; for (;;) { const index = timers.findIndex(timer => timer.at <= time); if (index < 0) break; timers.splice(index, 1)[0].fn(); } }
  };
}

test('singleton exposes shared run and independent factory queues', async () => {
  const h = harness(); assert.equal(typeof h.singleton.run, 'function'); assert.equal(typeof h.singleton.create, 'function');
  assert.equal(await h.singleton.run(() => 42), 42); assert.equal(h.queue.status().groupStarted, 0);
});

test('starts at most twelve images across different callers', async () => {
  const h = harness(), jobs = Array.from({ length: GROUP * 2 + 1 }, deferred), starts = [];
  const promises = jobs.map((job, index) => h.queue.run(() => { starts.push(index); return job.promise; }));
  assert.deepEqual(starts, indices(0, GROUP)); assert.equal(h.queue.status().active, GROUP); assert.equal(h.queue.status().pending, GROUP + 1);
  jobs[0].resolve('zero'); await flush();
  assert.deepEqual(starts, indices(0, GROUP), 'a settled slot cannot let a thirteenth image into the same group');
  for (const job of jobs.slice(1, GROUP)) job.resolve(); await flush();
  assert.equal(h.queue.status().coolingDown, true); h.tick(999); await flush(); assert.equal(starts.length, GROUP);
  h.tick(1); assert.deepEqual(starts, indices(0, GROUP * 2));
  for (const job of jobs.slice(GROUP, GROUP * 2)) job.resolve(); await flush(); h.tick(1000);
  assert.equal(starts.length, GROUP * 2 + 1); jobs[GROUP * 2].resolve(); await Promise.all(promises);
});

test('a slow image cannot hold replacement jobs after the rolling start window', async () => {
  const h = harness(), slow = deferred(); let thirteenth = false;
  const first = [...Array.from({length: GROUP - 1}, () => h.queue.run(() => 1)), h.queue.run(() => slow.promise)];
  const next = h.queue.run(() => { thirteenth = true; }); await flush(); h.tick(10000); await flush();
  assert.equal(thirteenth, true); assert.equal(h.queue.status().active, 1);
  slow.resolve(); await Promise.all(first); await next; assert.equal(thirteenth, true);
});

test('a partial group remains available to later images without adding a cooldown early', async () => {
  const h = harness(); await h.queue.run(() => 1); await h.queue.run(() => 2);
  assert.equal(h.queue.status().groupStarted, 2); assert.equal(h.timers.length, 0);
  h.tick(60000); assert.equal(await h.queue.run(() => 3), 3); assert.equal(h.timers.length, 0);
  for (let value = 4; value < GROUP; value++) { assert.equal(await h.queue.run(() => value), value); assert.equal(h.timers.length, 0); }
  assert.equal(await h.queue.run(() => GROUP), GROUP); await flush(); assert.equal(h.queue.status().coolingDown, true);
  h.tick(1000); assert.equal(h.queue.status().groupStarted, 0);
});

test('sync exceptions and rejected image jobs release active slots and still count toward twelve', async () => {
  const h = harness();
  const jobs = [h.queue.run(() => { throw new Error('sync'); }), h.queue.run(() => Promise.reject(new Error('async'))), ...Array.from({length: GROUP - 2}, () => h.queue.run(() => 3))];
  const outcomes = await Promise.allSettled(jobs); await flush();
  assert.deepEqual(outcomes.map(value => value.status), ['rejected', 'rejected', ...Array(GROUP - 2).fill('fulfilled')]);
  assert.equal(h.queue.status().active, 0); assert.equal(h.queue.status().coolingDown, true);
  let started = false; const next = h.queue.run(() => { started = true; }); h.tick(1000); await next; assert.equal(started, true);
});

test('cancelled work does not execute or consume a group slot', async () => {
  const h = harness(); let started = false;
  await assert.rejects(h.queue.run(() => { started = true; }, () => false),
    { name: 'AbortError', status: 409, code: 'COLLECTION_CANCELLED' });
  await assert.rejects(h.queue.run(() => { started = true; }, () => { throw new Error('gone'); }), { name: 'AbortError' });
  assert.equal(started, false); assert.equal(h.queue.status().groupStarted, 0);
});

test('cancellation is rechecked for queued jobs before the next group starts', async () => {
  const h = harness(); const active = Array.from({ length: GROUP }, deferred); let current = true, executed = false;
  const group = active.map(job => h.queue.run(() => job.promise));
  const canceled = h.queue.run(() => { executed = true; }, () => current);
  const rejection = assert.rejects(canceled, { name: 'AbortError' }); current = false;
  active.forEach(job => job.resolve()); await Promise.all(group); await rejection; await flush(); h.tick(1000);
  assert.equal(executed, false); assert.equal(h.queue.status().groupStarted, 0);
});

test('cancelling one tab does not cancel queued work for another tab', async () => {
  const h = harness(); const active = Array.from({ length: GROUP }, deferred); let firstTab = true;
  const group = active.map(job => h.queue.run(() => job.promise));
  const first = h.queue.run(() => 'wrong', () => firstTab);
  const rejected = assert.rejects(first, { name: 'AbortError' });
  const second = h.queue.run(() => 'second tab'); firstTab = false;
  active.forEach(job => job.resolve()); await Promise.all(group); await rejected; await flush(); h.tick(1000);
  assert.equal(await second, 'second tab'); assert.equal(h.queue.status().groupStarted, 1);
});

test('pending queue is bounded to 100 and overflow does not disturb active images', async () => {
  const h = harness(), active = Array.from({ length: GROUP }, deferred); let current = true;
  const group = active.map(job => h.queue.run(() => job.promise));
  const pending = Array.from({ length: 100 }, () => h.queue.run(() => 1, () => current));
  const pendingOutcomes = Promise.allSettled(pending);
  await assert.rejects(h.queue.run(() => 2), { name: 'QueueFullError' });
  assert.equal(h.queue.status().pending, 100); assert.equal(h.queue.status().active, GROUP);
  current = false; active.forEach(job => job.resolve()); await Promise.all(group);
  assert.ok((await pendingOutcomes).every(result => result.reason?.name === 'AbortError'));
  assert.equal(h.queue.status().pending, 0);
});

test('cancelled queued entries are removed before checking the pending limit', async () => {
  const h = harness({ maxPending: 1 }), active = Array.from({ length: GROUP }, deferred); let current = true;
  const group = active.map(job => h.queue.run(() => job.promise));
  const old = h.queue.run(() => 1, () => current), rejected = assert.rejects(old, { name: 'AbortError' }); current = false;
  const replacement = h.queue.run(() => 2); await rejected;
  assert.equal(h.queue.status().pending, 1); active.forEach(job => job.resolve()); await Promise.all(group); await flush(); h.tick(1000);
  assert.equal(await replacement, 2);
});

test('reentrant job submission preserves FIFO ordering and the group limit', async () => {
  const h = harness(), order = []; let child;
  await h.queue.run(() => { order.push('parent'); child = h.queue.run(() => { order.push('child'); return 2; }); return 1; });
  assert.equal(await child, 2); assert.deepEqual(order, ['parent', 'child']); assert.equal(h.queue.status().groupStarted, 2);
});

test('invalid callers reject without consuming queue slots', async () => {
  const h = harness(); await assert.rejects(h.queue.run(null), { name: 'TypeError' });
  await assert.rejects(h.queue.run(() => 1, null), { name: 'TypeError' }); assert.equal(h.queue.status().groupStarted, 0);
});

test('factory caps pending jobs at600 and cannot reduce the explicit one-second cooldown', async () => {
  const h = harness({ maxPending: 10000, cooldownMs: 0.1 });
  await Promise.all(Array.from({ length: GROUP }, () => h.queue.run(() => 1))); await flush();
  let started = false; const next = h.queue.run(() => { started = true; }); h.tick(999); assert.equal(started, false);
  h.tick(1); await next; assert.equal(started, true);
});

test('async false predicates cancel without executing or counting an image', async () => {
  const h = harness(); let executed = false;
  await assert.rejects(h.queue.run(() => { executed = true; }, async () => false), { name: 'AbortError' });
  assert.equal(executed, false); assert.equal(h.queue.status().groupStarted, 0);
  assert.equal(h.queue.status().active, 0); assert.equal(h.queue.status().checking, 0);
});

test('rejected async predicates are handled as cancellation without unhandled rejections', async () => {
  const h = harness(); let executed = false;
  await assert.rejects(h.queue.run(() => { executed = true; }, async () => { throw new Error('tab closed'); }), { name: 'AbortError' });
  assert.equal(executed, false); assert.equal(h.queue.status().pending, 0);
  assert.equal(await h.queue.run(() => 'next'), 'next'); assert.equal(h.queue.status().groupStarted, 1);
});

test('a cancellation while an async predicate is awaiting prevents the image from starting', async () => {
  const h = harness(), check = deferred(); let current = true, executed = false;
  const image = h.queue.run(() => { executed = true; }, async () => { await check.promise; return current; });
  assert.equal(h.queue.status().checking, 1); assert.equal(h.queue.status().active, 0);
  const rejected = assert.rejects(image, { name: 'AbortError' }); current = false; check.resolve(); await rejected;
  assert.equal(executed, false); assert.equal(h.queue.status().groupStarted, 0); assert.equal(h.queue.status().pending, 0);
});

test('async predicate checks reserve capacity and preserve FIFO even when later checks finish first', async () => {
  const h = harness(), checks = Array.from({ length: GROUP + 1 }, deferred), jobs = Array.from({ length: GROUP + 1 }, deferred), order = [];
  const images = jobs.map((job, index) => h.queue.run(() => { order.push(index); return job.promise; }, () => checks[index].promise));
  assert.equal(h.queue.status().checking, 1); assert.equal(h.queue.status().pending, GROUP + 1);
  checks.slice(1).forEach(check => check.resolve(true)); await flush(); assert.deepEqual(order, []);
  checks[0].resolve(true); await flush(); await flush();
  assert.deepEqual(order, indices(0, GROUP)); assert.equal(h.queue.status().active, GROUP); assert.equal(h.queue.status().checking, 0);
  jobs.slice(0, GROUP).forEach(job => job.resolve()); await flush(); h.tick(999); assert.equal(order.length, GROUP);
  h.tick(1); await flush(); assert.deepEqual(order, indices(0, GROUP + 1)); jobs[GROUP].resolve(); await Promise.all(images);
});

test('async cancellation of queued images releases pending capacity during a full active group', async () => {
  const h = harness({ maxPending: 1 }), active = Array.from({ length: GROUP }, deferred);
  const group = active.map(job => h.queue.run(() => job.promise));
  await assert.rejects(h.queue.run(() => 'must not run', async () => false), { name: 'AbortError' });
  assert.equal(h.queue.status().pending, 0); assert.equal(h.queue.status().active, GROUP);
  const next = h.queue.run(() => 'replacement', async () => true);
  active.forEach(job => job.resolve()); await Promise.all(group); await flush(); h.tick(1000);
  assert.equal(await next, 'replacement');
});

test('a pending async check counts toward the bounded pending limit', async () => {
  const h = harness({ maxPending: 2 }), check = deferred();
  const first = h.queue.run(() => 1, () => check.promise);
  const second = h.queue.run(() => 2);
  await assert.rejects(h.queue.run(() => 3), { name: 'QueueFullError' });
  assert.equal(h.queue.status().pending, 2); assert.equal(h.queue.status().checking, 1);
  check.resolve(true); assert.deepEqual(await Promise.all([first, second]), [1, 2]);
});
