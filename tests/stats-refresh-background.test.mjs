import test from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './background-harness.mjs';

const counts = { likeCount: 45, heartCount: 20, laughCount: 1, cryCount: 0 };
const image = id => ({ id, type: 'image', url: `https://image.civitai.com/key/asset-${id}/width=450/test.jpeg`, stats: counts });
async function setup() {
  const h = await harness(), calls = [], sourceCalls = [];
  h.context.sourceReply = async url => {
    sourceCalls.push(url);
    if (url.includes('/images/')) return { id: Number(url.split('/').pop()), stats: counts };
    return { result: { data: { json: { items: [image(55), image(56)], nextCursor: null } } } };
  };
  h.run('requestCivitaiFeed = async (tabId, url) => sourceReply(url)');
  h.context.fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    assert.match(url, /action=source-reactions$/);
    const items = JSON.parse(options.body).items;
    return new Response(JSON.stringify({ ok: true, accepted: items.filter(x => x.id === '55').length, updated: 1,
      missingIds: items.filter(x => x.id !== '55').map(x => x.id) }), { status: 200 });
  };
  const url = new URL('/api/trpc/image.getInfinite', h.tabs.get(7).url);
  url.searchParams.set('input', JSON.stringify({ json: { modelId: 99, sort: 'Newest' } }));
  return { h, calls, sourceCalls, start: () => h.message({ type: 'start', settings: { pageUrl: h.tabs.get(7).url, statsOnly: true }, feedRequestUrls: [url.href] }) };
}

test('stats-only traverses the selected feed and only sends existing-record updates', async () => {
  const { h, calls, sourceCalls, start } = await setup();
  assert.equal((await start()).ok, true); await h.run('driverPulse()');
  await h.run('sourceReactionUpdates.flush()');
  assert.equal(sourceCalls.length, 1, 'no prompt, detail or image download requests for complete counts');
  assert.equal(calls.length, 1); assert.deepEqual(calls[0].body.items.map(x => x.id), ['55', '56']);
  assert.equal(calls[0].body.items[0].reactions.likeCount, 45);
  assert.equal(h.run('sessions.get(7).settings.statsOnly'), true);
  assert.equal(h.run('sessions.get(7).status.processed'), 2);
  assert.equal(h.run('sessions.get(7).feed.done'), true);
  assert.equal(h.run('sourceReactionUpdates.snapshot().notInLibrary'), 1);
  assert.equal(h.run('sourceReactionUpdates.snapshot().queued'), 0);
  assert.equal(h.started.length, 0, 'browser downloads are forbidden');
  assert.equal(h.run('sessions.get(7).catalogSyncedIds.length'), 0, 'no catalog ingest');
  await h.message({ type: 'civitai-auto-cards', pageUrl: h.tabs.get(7).url, cards: [{ id: '57', previewUrl: image(57).url, reactions: counts }] });
  assert.equal((await h.run('autoBrowseCollector.status(7)')).pending, 0, 'no passive image jobs after completion');
});

test('all-zero stats are reread even with all four keys present', async () => {
  const { h, sourceCalls, start } = await setup();
  h.context.sourceReply = async url => {
    sourceCalls.push(url);
    return url.includes('/images/') ? { id: 55, stats: counts }
      : { result: { data: { json: { items: [{ ...image(55), stats: { likeCount: 0, heartCount: 0, laughCount: 0, cryCount: 0 } }], nextCursor: null } } } };
  };
  await start(); await h.run('driverPulse()'); await h.run('sourceReactionUpdates.flush()');
  assert.equal(sourceCalls.length, 2); assert.match(sourceCalls[1], /\/images\/55$/);
  assert.equal(h.run('sourceReactionUpdates.snapshot().updated'), 1);
});

test('rate-limited refresh keeps its cursor and uses the existing cooldown path', async () => {
  const { h, start } = await setup();
  h.context.sourceReply = async url => {
    if (url.includes('/images/')) throw Object.assign(new Error('Rate limited'), { status: 429, retryAfterMs: 65000 });
    return { result: { data: { json: { items: [{ ...image(55), stats: {} }], nextCursor: 'after-55' } } } };
  };
  await start(); await h.run('driverPulse()');
  assert.equal(h.run('sessions.get(7).feed.cursor'), null);
  assert.ok(h.run('sessions.get(7).feed.retryAt - Date.now()') > 60000);
  assert.equal(h.run('sourceReactionUpdates.snapshot().queued'), 0);
});

test('stats-only mode and feed position survive service worker restart', async () => {
  const { h, start } = await setup(); await start(); await h.persist();
  const restarted = await harness(structuredClone(h.storage));
  assert.equal(restarted.run('sessions.get(7).settings.statsOnly'), true);
  assert.equal(restarted.run('sessions.get(7).feed.statsOnly'), true);
  assert.equal(restarted.run('sessions.get(7).status.running'), true);
});

test('unavailable zero-count page snapshots never replace stored reactions', async () => {
  const { h, start } = await setup();
  h.context.sourceReply = async url => url.includes('/images/') ? { id: 55, stats: { statsUnknown: true, likeCount: 0 } }
    : { result: { data: { json: { items: [{ ...image(55), stats: { likeCount: 0, heartCount: 0, laughCount: 0, cryCount: 0 } }], nextCursor: null } } } };
  await start(); await h.run('driverPulse()');
  assert.equal(h.run('sourceReactionUpdates.snapshot().queued'), 0);
  assert.equal(h.run('sessions.get(7).status.statsUnavailable'), 1);
});
