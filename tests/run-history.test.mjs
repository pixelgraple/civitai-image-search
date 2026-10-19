import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
const context = vm.createContext({ crypto: webcrypto, structuredClone });
vm.runInContext(fs.readFileSync(new URL('../run-history.js', import.meta.url), 'utf8'), context);
const history = context.ISSRunHistory;
const run = (size = 0) => Object.fromEntries(history.fields.map(field => [field, Array.from({ length: size }, (_, i) => String(i + 1))]));
function storage() {
  const values = {}, writes = [];
  const deps = { readMany: async keys => Object.fromEntries(keys.map(key => [key, structuredClone(values[key])])),
    writeMany: async data => { writes.push(structuredClone(data)); Object.assign(values, structuredClone(data)); } };
  return { values, writes, deps, ledger: history.create(deps) };
}
async function save(h, value) {
  const snapshot = h.ledger.capture([value]); await h.ledger.write(snapshot);
  h.values.main = snapshot.runs; h.ledger.committed(snapshot); return snapshot;
}

test('small histories stay compatible with inline checkpoints', async () => {
  const h = storage(), value = run(20); await save(h, value);
  assert.equal(h.writes.length, 0);
  assert.deepEqual(h.values.main[0].catalogSyncedIds, value.catalogSyncedIds);
  assert.equal((await h.ledger.restore(h.values.main[0])).catalogSyncedIds.length, 20);
});

test('large histories migrate without losing IDs, counters, queued prompts, or cursors', async () => {
  const h = storage(), value = run(70000);
  value.preparedRecords = { '999999': { id: '999999', prompt: 'landscape fixture' } };
  value.outstandingIds = ['999999']; value.feed = { cursor: 'keep-me' };
  await save(h, value);
  assert.ok(JSON.stringify(h.values.main).length < 2000);
  assert.ok(h.writes.every(batch => Object.keys(batch).length <= 32));
  const recovered = await history.create(h.deps).restore(h.values.main[0]);
  for (const field of history.fields) assert.deepEqual(Array.from(recovered[field]), value[field]);
  assert.deepEqual(recovered.preparedRecords, value.preparedRecords);
  assert.equal(recovered.feed.cursor, 'keep-me');
});

test('adding one ID to 500000 old IDs writes only one bounded tail chunk', async () => {
  const h = storage(), value = run(); value.catalogSyncedIds = Array.from({ length: 500000 }, (_, i) => String(i + 1));
  await save(h, value); h.writes.length = 0;
  history.add(value, 'catalogSyncedIds', ['500001', '500001']);
  const snapshot = await save(h, value);
  assert.equal(value.catalogSyncedIds.length, 500001);
  assert.equal(snapshot.chunks.length, 1);
  assert.ok(JSON.stringify(h.writes).length < 25000);
  assert.ok(JSON.stringify(snapshot.runs).length < 2000);
  assert.equal(history.has(value, 'catalogSyncedIds', '500001'), true);
  assert.equal(history.has(value, 'catalogSyncedIds', '999999'), false);
});

test('unchanged history produces no history writes on status or queue-only checkpoints', async () => {
  const h = storage(), value = run(3000); await save(h, value); h.writes.length = 0;
  for (let i = 0; i < 40; i++) { value.outstandingIds = [String(i + 9000)]; await save(h, value); }
  assert.equal(h.writes.length, 0);
});

test('interruption after chunk write restores only the older committed prefix', async () => {
  const h = storage(), value = run(3000); await save(h, value);
  history.add(value, 'catalogSyncedIds', ['4000', '4001']);
  await h.ledger.write(h.ledger.capture([value]));
  const recovered = await history.create(h.deps).restore(h.values.main[0]);
  assert.equal(recovered.catalogSyncedIds.length, 3000);
  assert.equal(history.has(recovered, 'catalogSyncedIds', '4000'), false);
  const retry = history.create(h.deps); await retry.restore(h.values.main[0]);
  history.add(recovered, 'catalogSyncedIds', ['5000']);
  const next = retry.capture([recovered]); await retry.write(next); retry.committed(next);
  const after = await history.create(h.deps).restore(next.runs[0]);
  assert.equal(after.catalogSyncedIds.at(-1), '5000');
  assert.equal(history.has(after, 'catalogSyncedIds', '4001'), false);
});

test('new IDs added during a write remain dirty for the next checkpoint', async () => {
  const h = storage(), value = run(3000), first = h.ledger.capture([value]);
  history.add(value, 'catalogSyncedIds', ['4000']);
  await h.ledger.write(first); h.ledger.committed(first);
  const next = h.ledger.capture([value]);
  assert.equal(next.chunks.length, 1);
  await h.ledger.write(next); h.ledger.committed(next);
  assert.equal((await history.create(h.deps).restore(next.runs[0])).catalogSyncedIds.at(-1), '4000');
});

test('a missing history chunk fails without overwriting the saved queue', async () => {
  const h = storage(), value = run(3000); await save(h, value);
  delete h.values[Object.keys(h.values).find(key => key.includes(':catalogSyncedIds:'))];
  const original = JSON.stringify(h.values.main);
  await assert.rejects(history.create(h.deps).restore(h.values.main[0]), /chunk is unavailable/);
  assert.equal(JSON.stringify(h.values.main), original);
});

test('sustained append/checkpoint cycles keep writes bounded and duplicate totals exact after restart', async () => {
  const h = storage(), value = run();
  value.catalogSyncedIds = Array.from({ length: 100000 }, (_, i) => String(i + 1));
  await save(h, value); h.writes.length = 0;
  let largest = 0;
  for (let i = 0; i < 1000; i++) {
    history.add(value, 'catalogSyncedIds', [String(i + 1), String(i + 100001)]);
    const next = await save(h, value);
    largest = Math.max(largest, JSON.stringify(next.runs).length + JSON.stringify(next.chunks).length);
  }
  assert.ok(largest < 30000);
  const recovered = await history.create(h.deps).restore(h.values.main[0]);
  assert.equal(recovered.catalogSyncedIds.length, 101000);
  assert.equal(new Set(recovered.catalogSyncedIds).size, 101000);
});

test('failed migration writes leave the old inline checkpoint usable', async () => {
  const h = storage(), value = run(3000); h.values.main = structuredClone([value]);
  const failing = history.create({ ...h.deps, writeMany: async () => { throw new Error('disk unavailable'); } });
  await assert.rejects(failing.write(failing.capture([value])), /disk unavailable/);
  assert.equal((await history.create(h.deps).restore(h.values.main[0])).catalogSyncedIds.length, 3000);
});
