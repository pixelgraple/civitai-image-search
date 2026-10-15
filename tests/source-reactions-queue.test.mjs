import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../source-reactions-queue.js', import.meta.url), 'utf8');
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
async function harness({ saved = [], post, cooldownUntil = () => 0 } = {}) {
  let now = 100000, timerId = 0; const timers = new Map(), calls = [], writes = [], errors = [];
  const context = vm.createContext({ Date, Object, Number, String, JSON, Map, Set, Promise });
  vm.runInContext(source, context);
  const queue = context.ISSSourceReactions.create({ now: () => now, cooldownUntil,
    setTimer: (fn, delay) => { timers.set(++timerId, { at: now + delay, fn }); return timerId; }, clearTimer: id => timers.delete(id),
    load: async () => saved, save: async value => writes.push(structuredClone(value)), error: cause => errors.push(cause),
    post: async items => { calls.push({ at: now, items: structuredClone(items) }); return post ? post(items) : { accepted: items.length, missingIds: [] }; } });
  await queue.initialized;
  return { queue, calls, writes, errors, timers, now: () => now,
    async advance(ms) { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now && timers.delete(id)) timer.fn(); await flush(); } };
}
test('reaction updates coalesce across tabs, preserve zero, and retain absent fields', async () => {
  const h = await harness();
  await h.queue.observe('55', { likeCount: 0, heartCount: '7', cryCount: -1, arbitrary: 25 });
  await h.queue.observe('55', { heartCount: 7 });
  await h.queue.observe('55', { heartCount: 7 });
  assert.equal(h.queue.snapshot().queued, 1); await h.advance(2999); assert.equal(h.calls.length, 0);
  await h.advance(1); assert.deepEqual(h.calls[0].items, [{ id: '55', reactions: { likeCount: 0, heartCount: 7 } }]);
  assert.equal(h.queue.snapshot().queued, 0); assert.equal(h.queue.snapshot().updated, 1);
  await h.queue.observe('55', { likeCount: 0, heartCount: 7 }); await h.advance(3000); assert.equal(h.calls.length, 1);
});
test('batches at most60 updates per3seconds, restores pending metadata after restart', async () => {
  const saved = Array.from({ length: 65 }, (_, i) => ({ id: String(i + 1), reactions: { likeCount: 0 } }));
  const h = await harness({ saved }); await h.advance(3000); assert.equal(h.calls[0].items.length, 60);
  await h.advance(2999); assert.equal(h.calls.length, 1); await h.advance(1); assert.equal(h.calls[1].items.length, 5);
  assert.equal(h.calls[1].at - h.calls[0].at, 3000); assert.equal(h.writes.at(-1).pending.length, 0);
});
test('late DOM update racing prompt insertion retries only the missing ID', async () => {
  let missing = true;
  const h = await harness({ post: items => ({ accepted: items.length - (missing ? 1 : 0), missingIds: missing ? ['55'] : [] }) });
  await h.queue.observe('55', { likeCount: 2 }); await h.queue.observe('56', { likeCount: 0 }); await h.advance(3000);
  assert.equal(h.queue.snapshot().queued, 1); missing = false;
  await h.advance(15000); assert.deepEqual(h.calls[1].items, [{ id: '55', reactions: { likeCount: 2 } }]);
  assert.equal(h.queue.snapshot().queued, 0);
});
test('pending counts updated during an in-flight upload survive for the next batch', async () => {
  let finish;
  const h = await harness({ post: items => new Promise(resolve => { finish = () => resolve({ accepted: items.length }); }) });
  await h.queue.observe('55', { likeCount: 1 }); await h.advance(3000);
  await h.queue.observe('55', { likeCount: 2 }); finish(); await flush();
  assert.equal(h.queue.snapshot().queued, 1); await h.advance(3000);
  assert.equal(h.calls[1].items[0].reactions.likeCount, 2); finish(); await flush(); assert.equal(h.queue.snapshot().queued, 0);
});
test('rate limits and partial server replies retain updates without retry storms', async () => {
  let fail = true;
  const h = await harness({ post: items => { if (fail) throw Object.assign(new Error('Rate limited'), { status: 429 }); return { accepted: items.length }; } });
  await h.queue.observe('55', { likeCount: 1 }); await h.advance(3000); assert.equal(h.queue.snapshot().queued, 1);
  await h.advance(59999); assert.equal(h.calls.length, 1); fail = false; await h.advance(1); assert.equal(h.calls.length, 2);
  const partial = await harness({ post: () => ({ accepted: 0, missingIds: [] }) });
  await partial.queue.observe('55', { likeCount: 1 }); await partial.advance(3000);
  assert.equal(partial.queue.snapshot().queued, 1); assert.equal(partial.errors.length, 1);
});
test('metadata backlog and unknown-image retries remain bounded', async () => {
  const h = await harness({ post: items => ({ accepted: 0, missingIds: items.map(item => item.id) }) });
  for (let i = 1; i <= 600; i++) await h.queue.observe(String(i), { likeCount: 0 });
  await assert.rejects(h.queue.observe('601', { likeCount: 0 }), /queue is full/);
  assert.equal(h.queue.snapshot().queued, 600);
  const unknown = await harness({ post: items => ({ accepted: 0, missingIds: items.map(item => item.id) }) });
  await unknown.queue.observe('55', { likeCount: 0 }); await unknown.advance(3000);
  for (let i = 0; i < 9; i++) await unknown.advance(15000);
  assert.equal(unknown.calls.length, 10); assert.equal(unknown.queue.snapshot().queued, 0);
});
test('partial observations already sent by another tab do not cause extra updates', async () => {
  const h = await harness(); await h.queue.observe('55', { likeCount: 5, heartCount: 0 }); await h.advance(3000);
  await h.queue.observe('55', { heartCount: 0 }); await h.queue.observe('55', { likeCount: 5 }); await h.advance(6000);
  assert.equal(h.calls.length, 1); assert.equal(h.queue.snapshot().queued, 0);
});
test('server cooldown survives service worker restart', async () => {
  const h = await harness({ saved: { version: 1, retryAt: 160000, pending: [{ id: '55', reactions: { likeCount: 5 } }] } });
  await h.advance(59999); assert.equal(h.calls.length, 0); await h.advance(1); assert.equal(h.calls.length, 1);
});
test('statsUnknown placeholders are ignored rather than uploaded as real zero counts', async () => {
  const h = await harness();
  await h.queue.observe('55', { statsUnknown: true, likeCount: 0, heartCount: 0, laughCount: 0, cryCount: 0, buzzCount: 0 });
  await h.advance(3000); assert.equal(h.calls.length, 0); assert.equal(h.queue.snapshot().queued, 0);
  await h.queue.observe('55', { statsUnknown: false, likeCount: 0 }); await h.advance(3000);
  assert.deepEqual(h.calls[0].items, [{ id: '55', reactions: { likeCount: 0 } }]);
});
test('required page enrichment survives a long delay before prompt insertion', async () => {
  const h = await harness({ post: items => ({ accepted: 0, missingIds: items.map(item => item.id) }) });
  await h.queue.observe('55', { likeCount: 5 }, { retainMissing: true }); await h.advance(3000);
  for (let i = 0; i < 12; i++) await h.advance(15000);
  assert.equal(h.queue.snapshot().queued, 1); assert.equal(h.writes.at(-1).pending[0].retainMissing, true);
});
