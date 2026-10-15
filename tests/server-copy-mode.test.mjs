import test from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './background-harness.mjs';
import { createCatalogIndexedDB } from './catalog-indexeddb-harness.mjs';

const stateKey = 'aiImageDatasetScraperStateV6';
const cloud = { apiBase: 'https://search-civitai.xyz/api.php', writeToken: 'test-writer-key' };
const originalUrl = 'https://image.civitai.com/key/image/original=true/135960467.jpg';
function feedRequestUrl() {
  const url = new URL('https://civitai.red/api/trpc/image.getInfinite');
  url.searchParams.set('input', JSON.stringify({ json: { browsingLevel: 1, sort: 'Newest', modelId: 99 } }));
  return url.href;
}
function startMessage(overrides = {}) {
  return { type: 'start', tabId: 7, backgroundDriver: true,
    settings: { siteMode: 'civitai', pageUrl: 'https://civitai.red/models/99', backgroundMode: true, autoScroll: true, ...overrides },
    feedRequestUrls: [feedRequestUrl()] };
}
function installFeed(h, indexedDB = createCatalogIndexedDB()) {
  h.context.indexedDB = indexedDB;
  // These tests advance the feed deliberately; uploader timers remain real.
  h.run('scheduleImmediateClock = () => {}');
  h.context.testFeedUrls = [];
  h.context.testFeedPayload = { items: [{ id: 77, tags: ['selfie'], images: [{ id: 135960467,
    type: 'image', url: 'https://image.civitai.com/key/image/width=450/135960467.jpg',
    stats: { likeCount: 0, heartCount: 0, laughCount: 0, cryCount: 0 },
    meta: { prompt: 'selfie, photorealistic portrait', negativePrompt: 'blurry', modelName: 'Realistic Vision XL', resources: [] } }] }], nextCursor: 'next-page' };
  h.run('requestCivitaiFeed = async (_tabId, url) => { testFeedUrls.push(url); return { result: { data: { json: testFeedPayload } } }; }');
  return indexedDB;
}
async function settleUploads(h) {
  await h.run('Promise.allSettled([...(manualSubmissionTasks.get(sessions.get(7))?.values() || [])])');
  await h.persist();
}
function state(h) { return JSON.parse(h.run('JSON.stringify(getPublicState(7))')); }
function acceptCloud(h, calls = []) {
  h.context.fetch = async (url, options) => {
    calls.push({ url, options });
    const body = JSON.parse(options.body);
    return new Response(JSON.stringify(url.endsWith('action=check') ? { ok: true, items: body.imageIds.map(imageId =>
      ({ imageId, exists: false, sha256: null, downloadStatus: 'missing', needsDownload: true })) }
      : { ok: true, accepted: body.items.length, skipped: 0 }), { status: 200 });
  };
}

test('contributor mode freezes at start and suppresses initial DOM downloads', async () => {
  const h = await harness({ civitaiPromptCloud: cloud });
  installFeed(h); acceptCloud(h);
  assert.equal((await h.message(startMessage())).ok, true);
  assert.equal(state(h).settings.serverCopies, true);
  const enqueue = await h.message({ type: 'enqueue', items: [{ url: originalUrl, type: 'image' }] });
  assert.equal(enqueue.ok, false);
  assert.equal(h.run('typeof pumpQueue'), 'undefined');
  assert.equal(h.started.length, 0);
  assert.equal(state(h).queue.length, 0);
  await h.persist();
  assert.equal(h.storage[stateKey].runs[0].settings.serverCopies, true);
});

test('server-copy scanning preserves observed feed filters, indexes and syncs without local copies', async () => {
  const h = await harness({ civitaiPromptCloud: cloud });
  installFeed(h); const calls = []; acceptCloud(h, calls);
  await h.message(startMessage());
  await h.run('backgroundFeedPulse(7)'); await settleUploads(h);
  const current = state(h);
  assert.equal(current.status.found, 1);
  assert.equal(current.status.catalogIndexed, 1);
  assert.equal(current.status.catalogSynced, 1);
  assert.equal(current.status.downloaded, 0);
  assert.equal(current.status.downloadedBytes, 0);
  assert.equal(h.started.length, 0);
  assert.equal(current.queue.length, 0);
  assert.equal(h.storage[stateKey].runs[0].feed.cursor, 'next-page');
  assert.equal(h.storage[stateKey].runs[0].feed.pages, 1);
  assert.equal((await h.run("PromptCatalogDB.search('selfie')")).length, 1);
  const sourceRequest = new URL(h.context.testFeedUrls[0]);
  assert.equal(sourceRequest.pathname, '/api/trpc/image.getInfinite');
  assert.deepEqual(JSON.parse(sourceRequest.searchParams.get('input')).json, { browsingLevel: 1, sort: 'Newest', modelId: 99, limit: 60 });
  assert.deepEqual(calls.map(call => call.url), ['https://search-civitai.xyz/api.php?action=check', 'https://search-civitai.xyz/api.php?action=images']);
});

test('early duplicate-check failure retains the cursor before indexing and retries the page once', async () => {
  const h = await harness({ civitaiPromptCloud: cloud });
  installFeed(h);
  h.context.fetch = async () => new Response('{}', { status: 503 });
  await h.message(startMessage());
  await h.run('backgroundFeedPulse(7)');
  await h.persist();
  assert.equal(h.storage[stateKey].runs[0].feed.cursor, null);
  assert.equal(h.storage[stateKey].runs[0].feed.pages, 0);
  assert.equal(h.storage[stateKey].runs[0].feed.failures, 1);
  assert.equal(state(h).status.catalogIndexed, 0);
  assert.equal(state(h).status.catalogSynced, 0);
  assert.equal(await h.run('PromptCatalogDB.count()'), 0);
  assert.match(state(h).status.lastError, /503/);
  assert.equal(state(h).status.stopped, false);
  assert.equal(h.started.length, 0);
  const calls = []; acceptCloud(h, calls); h.run('sessions.get(7).feed.retryAt = 0; sessions.get(7).uploadRetryAt = 0');
  await h.run('backgroundFeedPulse(7)'); await settleUploads(h);
  assert.equal(h.storage[stateKey].runs[0].feed.cursor, 'next-page');
  assert.equal(state(h).status.catalogIndexed, 1);
  assert.equal(state(h).status.catalogSynced, 1);
  assert.equal(calls.length, 2);
  assert.equal(h.started.length, 0);
});

test('a restored completed feed drains durable prepared records without a key or rereading its page', async () => {
  const h = await harness({ civitaiPromptCloud: cloud });
  const indexedDB = installFeed(h); h.context.testFeedPayload.nextCursor = null;
  h.context.fetch = async (url, options) => url.endsWith('action=check')
    ? new Response(JSON.stringify({ ok: true, items: JSON.parse(options.body).imageIds.map(imageId =>
      ({ imageId, exists: false, sha256: null, downloadStatus: 'missing', needsDownload: true })) }))
    : new Response('{}', { status: 503 });
  await h.message(startMessage()); await h.run('backgroundFeedPulse(7)'); await settleUploads(h);
  assert.equal(h.storage[stateKey].runs[0].feed.done, true);
  assert.equal(h.storage[stateKey].runs[0].feed.pages, 1);
  assert.equal(Object.keys(h.storage[stateKey].runs[0].preparedRecords).length, 1);
  assert.equal(state(h).status.catalogIndexed, 1); assert.equal(state(h).status.catalogSynced, 0);
  const saved = structuredClone(h.storage); saved.civitaiPromptCloud.writeToken = '';
  saved[stateKey].runs[0].feed.retryAt = 0; saved[stateKey].runs[0].uploadRetryAt = 0;
  const restored = await harness(saved); installFeed(restored, indexedDB);
  const requests = []; acceptCloud(restored, requests);
  await restored.run('backgroundFeedPulse(7)'); await settleUploads(restored);
  await restored.run('backgroundFeedPulse(7)'); await restored.persist();
  assert.equal(state(restored).settings.serverCopies, true);
  assert.equal(restored.storage[stateKey].runs[0].feed.done, true);
  assert.equal(restored.storage[stateKey].runs[0].feed.pages, 1);
  assert.equal(state(restored).status.lastError, '');
  assert.equal(state(restored).status.catalogIndexed, 1); assert.equal(state(restored).status.catalogSynced, 1);
  assert.equal(state(restored).status.stopReason, 'feed-complete');
  assert.equal(Object.keys(restored.storage[stateKey].runs[0].preparedRecords).length, 0);
  assert.equal(restored.context.testFeedUrls.length, 0);
  assert.equal(requests.length, 2); assert.equal(restored.started.length, 0);
});

test('legacy mode flags cannot enable local downloads', async () => {
  const h = await harness({ civitaiPromptCloud: cloud });
  const result = await h.message(startMessage({ backgroundMode: false }));
  assert.equal(result.ok, true);
  assert.equal(state(h).settings.serverCopies, true);
  assert.equal(state(h).status.running, true);
  assert.equal(h.started.length, 0);
});

test('Civitai without a key starts collection without local downloads', async () => {
  const h = await harness({ civitaiPromptCloud: { ...cloud, writeToken: '' } });
  const result = await h.message({ ...startMessage({ backgroundMode: false, autoScroll: false }), backgroundDriver: false });
  assert.equal(result.ok, true);
  assert.equal(state(h).settings.serverCopies, true);
  await h.message({ type: 'enqueue', items: [{ url: originalUrl, type: 'image' }] });
  assert.equal(h.started.length, 0);
});

test('other-site collection is rejected even with a contributor key', async () => {
  const h = await harness({ civitaiPromptCloud: cloud });
  const result = await h.message({ type: 'start', tabId: 7, settings: { siteMode: 'prompthero',
    pageUrl: 'https://prompthero.com/', backgroundMode: false, autoScroll: false } });
  assert.equal(result.ok, false);
  assert.equal(state(h).settings.serverCopies, true);
  await h.message({ type: 'enqueue', items: [{ url: 'https://cdn.prompthero.com/image.png', type: 'image' }] });
  assert.equal(h.started.length, 0);
});

test('a partially rejected upload retains durable prompts after the source cursor advances', async () => {
  const h = await harness({ civitaiPromptCloud: cloud });
  installFeed(h);
  h.context.fetch = async (url, options) => new Response(JSON.stringify(url.endsWith('action=check')
    ? { ok: true, items: JSON.parse(options.body).imageIds.map(imageId => ({ imageId, exists: false, sha256: null, downloadStatus: 'missing', needsDownload: true })) }
    : { ok: true, accepted: 0, skipped: 1 }), { status: 200 });
  await h.message(startMessage()); await h.run('backgroundFeedPulse(7)'); await settleUploads(h);
  assert.equal(h.storage[stateKey].runs[0].feed.cursor, 'next-page');
  assert.equal(h.storage[stateKey].runs[0].feed.pages, 1);
  assert.equal(state(h).status.catalogIndexed, 1);
  assert.equal(state(h).status.catalogSynced, 0);
  assert.match(state(h).status.lastError, /accepted 0 of 1/);
  assert.equal(Object.keys(h.storage[stateKey].runs[0].preparedRecords).length, 1);
  assert.equal(h.started.length, 0);
});

test('successful upload chunks count honestly when a later chunk fails and retry remains idempotent', async () => {
  const h = await harness({ civitaiPromptCloud: cloud });
  installFeed(h);
  const base = h.context.testFeedPayload.items[0].images[0];
  h.context.testFeedPayload.items[0].images = Array.from({ length: 61 }, (_, index) => ({ ...base,
    id: 135960467 + index, url: `https://image.civitai.com/key/image/width=450/${135960467 + index}.jpg` }));
  let calls = 0; const acceptedIds = new Set();
  h.context.fetch = async (url, options) => {
    if (url.endsWith('action=check')) return new Response(JSON.stringify({ ok: true, items: JSON.parse(options.body).imageIds.map(imageId =>
      ({ imageId, exists: false, sha256: null, downloadStatus: 'missing', needsDownload: true })) }), { status: 200 });
    if (++calls >= 2) return new Response('{}', { status: 503 });
    for (const record of JSON.parse(options.body).items) acceptedIds.add(String(record.id));
    return new Response(JSON.stringify({ ok: true, accepted: JSON.parse(options.body).items.length, skipped: 0 }), { status: 200 });
  };
  await h.message(startMessage()); await h.run('backgroundFeedPulse(7)'); await settleUploads(h);
  assert.equal(state(h).status.catalogIndexed, 61);
  assert.ok(acceptedIds.size > 0 && acceptedIds.size <= 60, 'a successful partial batch is retained');
  assert.equal(state(h).status.catalogSynced, acceptedIds.size);
  assert.equal(h.storage[stateKey].runs[0].feed.cursor, 'next-page');
  assert.equal(h.storage[stateKey].runs[0].feed.pages, 1);
  const retained = Object.keys(h.storage[stateKey].runs[0].preparedRecords);
  assert.equal(retained.length, 61 - acceptedIds.size);
  const retries = []; acceptCloud(h, retries);
  h.run('sessions.get(7).feed.retryAt = 0; sessions.get(7).uploadRetryAt = 0; pumpManualPrepared(sessions.get(7))');
  await settleUploads(h);
  const retryIds = retries.filter(call => call.url.endsWith('action=images')).flatMap(call => JSON.parse(call.options.body).items.map(item => item.id));
  assert.equal(retryIds.length, retained.length); assert.equal(new Set(retryIds).size, retained.length);
  assert.equal(retryIds.some(id => acceptedIds.has(id)), false, 'accepted chunks are never submitted again');
  assert.equal(h.context.testFeedUrls.length, 1, 'upload retries do not reread the committed feed');
  assert.equal(state(h).status.catalogIndexed, 61);
  assert.equal(state(h).status.catalogSynced, 61);
  assert.equal(h.storage[stateKey].runs[0].feed.cursor, 'next-page');
  assert.equal(h.started.length, 0);
});

test('early-check authentication failure stops before metadata and preserves the source cursor', async () => {
  const h = await harness({ civitaiPromptCloud: cloud });
  installFeed(h);
  h.context.fetch = async () => new Response('{}', { status: 401 });
  await h.message(startMessage()); await h.run('backgroundFeedPulse(7)'); await settleUploads(h);
  assert.equal(state(h).status.stopped, true);
  assert.equal(state(h).status.stopReason, 'feed-error');
  assert.match(state(h).status.lastError, /401/);
  assert.equal(h.storage[stateKey].runs[0].feed.cursor, null);
  assert.equal(h.storage[stateKey].runs[0].feed.pages, 0);
  assert.equal(state(h).status.catalogIndexed, 0);
  assert.equal(state(h).status.catalogSynced, 0);
  assert.equal(h.started.length, 0);
});

test('a promptless page advances without catalog writes, uploads or image downloads', async () => {
  const h = await harness({ civitaiPromptCloud: cloud }); installFeed(h);
  const image = h.context.testFeedPayload.items[0].images[0];
  image.meta.prompt = ' \n\t';
  // Hydration returns missing prompt too. The wire can still contain tags/model.
  h.run('requestCivitaiFeed = async (_tabId, url) => url.includes("getGenerationData") ? {result:{data:{json:{type:"image",resources:[],meta:{negativePrompt:"blurry"}}}}} : {result:{data:{json:testFeedPayload}}};');
  const calls = []; acceptCloud(h, calls);
  await h.message(startMessage()); await h.run('backgroundFeedPulse(7)'); await settleUploads(h);
  assert.deepEqual(calls.map(call => call.url), ['https://search-civitai.xyz/api.php?action=check']);
  assert.equal(h.started.length, 0);
  assert.equal(await h.run('PromptCatalogDB.count()'), 0);
  assert.equal(state(h).status.catalogPromptlessSkipped, 1);
  assert.equal(state(h).status.catalogSynced, 0);
  assert.equal(h.storage[stateKey].runs[0].feed.cursor, 'next-page');
});

test('verified stored images skip metadata and upload while SHA256 skip counts persist', async () => {
  const h = await harness({ civitaiPromptCloud: cloud }); installFeed(h);
  const calls = []; h.context.fetch = async (url) => { calls.push(url); return new Response(JSON.stringify(url.endsWith('action=check')
    ? {ok:true,items:[{imageId:'135960467',exists:true,sha256:'a'.repeat(64),needsDownload:false,downloadStatus:'ready'}]}
    : {ok:true,accepted:1,skipped:0}),{status:200}); };
  await h.message(startMessage()); await h.run('backgroundFeedPulse(7)'); await settleUploads(h);
  assert.equal(state(h).status.catalogStoredSkipped, 1);
  assert.equal(state(h).status.catalogSynced, 1);
  assert.equal(h.started.length, 0);
  assert.deepEqual(h.storage[stateKey].runs[0].catalogStoredSkippedIds, ['135960467']);
  assert.equal(await h.run('PromptCatalogDB.count()'), 0);
  assert.deepEqual(calls, ['https://search-civitai.xyz/api.php?action=check']);
});
