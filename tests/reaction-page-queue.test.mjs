import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../reaction-page-queue.js', import.meta.url), 'utf8');
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
const item = id => ({ id: String(id), tabId: 7, pageUrl: 'https://civitai.red/models/99' });
async function harness({ saved, read, observe } = {}) {
  let now = 100000, serial = 0; const timers = new Map(), writes = [], reads = [], updates = [], errors = [];
  const context = vm.createContext({ URL, Map, Set, Object, Number, String, Math, Promise }); vm.runInContext(source, context);
  const queue = context.ISSReactionPages.create({ now: () => now, load: async () => saved,
    save: async value => writes.push(structuredClone(value)), report: error => errors.push(error),
    read: async entry => { reads.push(entry.id); return read ? read(entry) : { likeCount: 0 }; },
    observe: async (id, reactions) => { updates.push({ id, reactions: structuredClone(reactions) }); if (observe) await observe(id, reactions); },
    setTimer: (fn, delay) => { timers.set(++serial, { fn, at: now + delay }); return serial; }, clearTimer: id => timers.delete(id) });
  await queue.initialized;
  return { queue, reads, updates, writes, errors,
    async advance(ms) { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now && timers.delete(id)) timer.fn(); await flush(); } };
}
test('page jobs persist immediately and complete separately from the caller', async () => {
  let finish; const h = await harness({ read: () => new Promise(resolve => { finish = resolve; }) });
  await h.queue.enqueue(item(55)); assert.equal(h.reads.length, 0); assert.equal(h.writes[0].pending[0].id, '55');
  await h.advance(1000); assert.equal(h.queue.snapshot().active, 1);
  await h.queue.enqueue(item(56)); await h.advance(10000); assert.deepEqual(h.reads, ['55']);
  finish({ likeCount: 5, heartCount: 0 }); await flush();
  assert.deepEqual(h.updates, [{ id: '55', reactions: { likeCount: 5, heartCount: 0 } }]);
  assert.equal(h.writes.at(-1).pending.length, 1);
});
test('page enrichment resumes after restart and retains full server Retry-After', async () => {
  const h = await harness({ read: async () => { throw Object.assign(new Error('Rate limited'), { status: 429, retryAfterMs: 600000 }); } });
  await h.queue.enqueue(item(55)); await h.advance(1000);
  assert.equal(h.writes.at(-1).pending[0].retryAt, 701000);
  const restored = await harness({ saved: h.writes.at(-1) }); await restored.advance(600999);
  assert.equal(restored.reads.length, 0); await restored.advance(1); assert.deepEqual(restored.reads, ['55']);
  assert.equal(restored.queue.snapshot().queued, 0);
});
test('unavailable pages, stopped tabs and full update queues remain durable for later retry', async () => {
  for (const read of [async () => ({}), async () => { throw Object.assign(new Error('Tab paused'), { status: 409 }); }]) {
    const h = await harness({ read }); await h.queue.enqueue(item(55)); await h.advance(1000);
    assert.equal(h.queue.snapshot().queued, 1); assert.equal(h.updates.length, 0); assert.ok(h.writes.at(-1).pending[0].retryAt > 101000);
  }
  const h = await harness({ observe: async () => { throw new Error('Update queue full'); } });
  await h.queue.enqueue(item(55)); await h.advance(1000); assert.equal(h.queue.snapshot().queued, 1);
});
test('duplicate page jobs and capacity are bounded without silently discarding required work', async () => {
  const h = await harness();
  for (let id = 1; id <= 600; id++) await h.queue.enqueue(item(id));
  await h.queue.enqueue(item(1)); assert.equal(h.queue.snapshot().queued, 600);
  await assert.rejects(h.queue.enqueue(item(601)), /queue is full/);
  await assert.rejects(h.queue.enqueue({ ...item(601), pageUrl: 'https://evil.example/' }), /Invalid source/);
});
