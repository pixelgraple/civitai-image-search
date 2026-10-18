import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { harness, installCheckpoint } from './background-harness.mjs';

const CONFIG = 'civitaiPromptCloud';
const STATE = 'aiImageDatasetScraperStateV6';
const API = 'https://search-civitai.xyz/api.php';
const source = name => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const observe = promise => promise.then(value => ({ ok: true, value }), error => ({ ok: false, error }));
const flush = async () => { for (let count = 0; count < 1200; count++) await Promise.resolve(); };
const plain = value => JSON.parse(JSON.stringify(value));
const record = id => ({ id: String(id), prompt: 'fixture landscape', downloadUrl: `https://image.civitai.com/key/${id}/original=true/${id}.png` });
const card = id => ({ id: String(id), previewUrl: `https://image.civitai.com/key/${id}/width=450/${id}.png` });
const sender = (h, id) => ({ tab: h.tabs.get(id), url: h.tabs.get(id).url, frameId: 0 });

function installClock(context) {
  let now = Date.UTC(2026, 9, 14, 12), serial = 0;
  const timers = new Map();
  context.Date = class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  };
  context.setTimeout = (callback, delay = 0) => {
    const id = ++serial; timers.set(id, { at: now + Math.max(0, Number(delay) || 0), callback }); return id;
  };
  context.clearTimeout = id => timers.delete(id);
  return {
    now: () => now, timers,
    async advance(ms) {
      now += ms;
      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.at <= now);
        if (!due.length) break;
        for (const [id, timer] of due) { if (timers.delete(id)) timer.callback(); }
        await flush();
      }
      await flush();
    }
  };
}

function queues(files = []) {
  const storage = {};
  const context = vm.createContext({ URL, AbortSignal, Promise, console, structuredClone,
    chrome: { runtime: { lastError: null }, storage: { local: {
      get: (_key, callback) => queueMicrotask(() => callback(structuredClone(storage))),
      set: (value, callback) => { Object.assign(storage, structuredClone(value)); queueMicrotask(callback); }
    } } }
  });
  const clock = installClock(context);
  installCheckpoint(context);
  for (const name of ['collection-speed.js', ...files]) vm.runInContext(source(name), context);
  return { context, clock, storage, speed: context.ISSCollectionSpeed,
    run: text => vm.runInContext(text, context) };
}

async function background(saved = {}) {
  const h = await harness(saved);
  await h.run('autoBrowseCollector.initialized');
  h.run('autoBrowseCollector.pulse=async()=>{}; driverPulse=async()=>{}; pumpManualPrepared=()=>{};');
  const clock = installClock(h.context);
  const setSpeed = speedMultiplier => h.extensionMessage({ type: 'setCollectionSpeed', speedMultiplier });
  return { ...h, clock, setSpeed };
}

test('speed profiles are bounded half steps with a fixed600 backlog and default1x', () => {
  const { speed } = queues();
  assert.equal(speed.get().multiplier, 1);
  assert.equal(speed.get().sourceConcurrency, 1);
  for (let multiplier = 1; multiplier <= 5; multiplier += 0.5) {
    const profile = speed.profile(multiplier);
    assert.equal(profile.multiplier, multiplier);
    assert.equal(profile.metadataConcurrency, 12 * multiplier);
    assert.equal(profile.sourceIntervalMs, Math.round(2000 / multiplier));
    assert.equal(profile.uploadIntervalMs, 3000);
    assert.equal(profile.imageCooldownMs, Math.round(1000 / multiplier));
    assert.equal(profile.uploadBatchSize, 60);
    assert.equal(profile.discoveryBatchSize, Math.min(100, Math.round(60 * multiplier)));
    assert.equal(profile.outstandingLimit, 600);
    assert.equal(profile.sourceConcurrency, 1);
  }
  for (const concurrency of [1, 2, 3, 4]) assert.equal(speed.profile(1, concurrency).sourceConcurrency, concurrency);
  for (const concurrency of [0, 5, 1.5, '4', null, NaN]) assert.throws(() => speed.normalizeSourceConcurrency(concurrency));
  for (const value of [0, 0.5, 5.5, 99, -1, 1.25, NaN, Infinity, '2', null, undefined, {}, []])
    assert.throws(() => speed.normalize(value), `reject invalid speed ${String(value)}`);
});

test('speed is a browser-wide persisted preference and invalid messages leave it unchanged', async () => {
  const h = await background(); h.tabs.set(8, { id: 8, url: 'https://civitai.com/images' });
  assert.equal((await h.extensionMessage({ type: 'getConfig' })).speedMultiplier, 1);
  assert.equal((await h.setSpeed(3.5)).ok, true);
  assert.equal(h.storage[CONFIG].speedMultiplier, 3.5);
  for (const tabId of [7, 8]) {
    const state = await h.message({ type: 'getState' }, sender(h, tabId));
    assert.equal(state.pipeline.metadataConcurrency, 42);
    assert.equal(state.pipeline.outstandingLimit, 600);
  }
  for (const speedMultiplier of [0, 6, 1.25, '5', null, {}, []]) {
    const result = await h.setSpeed(speedMultiplier);
    assert.equal(result.ok, false);
    assert.equal(h.storage[CONFIG].speedMultiplier, 3.5);
    assert.equal(h.run('ISSCollectionSpeed.get().multiplier'), 3.5);
  }
  const restored = await background(structuredClone(h.storage));
  assert.equal((await restored.extensionMessage({ type: 'getConfig' })).speedMultiplier, 3.5);
  assert.equal(restored.run('ISSCollectionSpeed.get().metadataConcurrency'), 42);
});

test('changing browsing settings, Stop all, and legacy config cleanup preserve speed', async () => {
  const h = await background({ [CONFIG]: { apiBase: 'https://obsolete.invalid/', writeToken: 'obsolete-fixture', autoBrowse: false, speedMultiplier: 2.5 } });
  assert.equal(h.storage[CONFIG].speedMultiplier, 2.5);
  assert.equal(h.storage[CONFIG].apiBase, API);
  assert.equal(h.storage[CONFIG].writeToken, undefined);
  assert.equal((await h.extensionMessage({ type: 'saveConfig', autoBrowse: true })).ok, true);
  assert.equal(h.storage[CONFIG].speedMultiplier, 2.5);
  assert.equal((await h.extensionMessage({ type: 'pauseAll' })).ok, true);
  assert.equal(h.storage[CONFIG].autoBrowse, false);
  assert.equal(h.storage[CONFIG].speedMultiplier, 2.5);
  assert.equal((await h.setSpeed(5)).ok, true);
  assert.equal(h.storage[CONFIG].autoBrowse, false, 'speed never silently resumes stopped collection');
});

test('concurrent preference writes preserve both speed and browsing state', async () => {
  const h = await background();
  const results = await Promise.all([h.setSpeed(4.5), h.extensionMessage({ type: 'saveConfig', autoBrowse: false })]);
  assert.ok(results.every(result => result.ok));
  assert.equal(h.storage[CONFIG].speedMultiplier, 4.5);
  assert.equal(h.storage[CONFIG].autoBrowse, false);
  const oldValue = structuredClone(h.storage[CONFIG]);
  h.storage[CONFIG] = { ...oldValue, speedMultiplier: 2 };
  await h.emit('storageChanged', { [CONFIG]: { oldValue, newValue: h.storage[CONFIG] } }, 'local');
  assert.equal(h.run('ISSCollectionSpeed.get().multiplier'), 2, 'another extension surface updates the live profile');
  assert.equal(h.storage[CONFIG].autoBrowse, false);
});

test('untrusted pages and a Civitai tab claiming another tab cannot change global speed', async () => {
  const h = await background();
  h.tabs.set(8, { id: 8, url: 'https://civitai.com/images' });
  for (const sourceSender of [
    { url: 'https://evil.example/', tab: { id: 7, url: 'https://evil.example/' }, frameId: 0 },
    { ...sender(h, 7), frameId: 2 }
  ]) assert.equal((await h.message({ type: 'setCollectionSpeed', speedMultiplier: 5 }, sourceSender)).ok, false);
  assert.equal((await h.message({ type: 'setCollectionSpeed', speedMultiplier: 5, tabId: 8 }, sender(h, 7))).ok, false);
  assert.equal(h.run('ISSCollectionSpeed.get().multiplier'), 1);
  const oldSender = sender(h, 7);
  h.tabs.set(7, { id: 7, url: 'https://evil.example/' });
  assert.equal((await h.message({ type: 'setCollectionSpeed', speedMultiplier: 5 }, oldSender)).ok, false);
  h.tabs.set(7, { id: 7, url: 'https://civitai.red/models/99' });
  assert.equal((await h.message({ type: 'setCollectionSpeed', speedMultiplier: 2.5 }, sender(h, 7))).ok, true);
  assert.equal(h.run('ISSCollectionSpeed.get().multiplier'), 2.5, 'a trusted current tab panel can adjust the browser-wide speed');
});

test('speed changes retain both tab cursors, prepared records, paused owners and counters', async () => {
  const h = await background(); h.tabs.set(8, { id: 8, url: 'https://civitai.com/images' });
  h.run(`for(const tabId of [7,8]) {
    const run=freshState({sessionTabId:tabId,pageUrl:tabId===7?'https://civitai.red/models/99':'https://civitai.com/images'});
    run.feed={site:'civitai',pageUrl:run.settings.pageUrl,endpoint:'image.getInfinite',filters:{sort:'Newest'},cursor:'cursor-'+tabId,pages:4};
    run.catalogSyncedIds=['1'];run.catalogDiscoveredIds=['1',String(tabId)];run.outstandingIds=[String(tabId)];
    run.preparedRecords[String(tabId)]={id:String(tabId),prompt:'fixture landscape',downloadUrl:'https://image.civitai.com/key/x/original=true/'+tabId+'.png'};
    run.status.running=tabId===7;run.status.stopped=tabId===8;sessions.set(tabId,run);drivers.set(tabId,newDriver());
    reserveOutstanding(String(tabId),'manual',tabId,'readyUpload');
  }`);
  await h.run('persistState()'); const before = structuredClone(h.storage[STATE]);
  for (const multiplier of [5, 1.5, 1]) assert.equal((await h.setSpeed(multiplier)).ok, true);
  assert.deepEqual(h.storage[STATE], before);
  assert.equal(h.run('pipelineSnapshot().outstandingTotal'), 2);
  assert.equal(h.run('pipelineSnapshot().paused'), 1);
});

test('5x still caps all automatic tabs at600 unique durable records including paused work', async () => {
  const h = await background(); h.tabs.set(8, { id: 8, url: 'https://civitai.com/images' }); await h.setSpeed(5);
  for (let batch = 0; batch < 10; batch++) {
    const id = batch % 2 ? 8 : 7;
    const result = await h.message({ type: 'civitai-auto-cards', pageUrl: h.tabs.get(id).url,
      cards: Array.from({ length: 60 }, (_, index) => card(1000 + batch * 60 + index)) }, sender(h, id));
    assert.equal(result.accepted.length, 60);
    assert.ok(result.pipeline.outstandingTotal <= 600);
  }
  await h.message({ type: 'stop' }, sender(h, 7));
  for (const multiplier of [1, 5]) {
    await h.setSpeed(multiplier);
    const blocked = await h.message({ type: 'civitai-auto-cards', pageUrl: h.tabs.get(8).url, cards: [card(9999)] }, sender(h, 8));
    assert.equal(blocked.accepted.length, 0); assert.equal(blocked.pipeline.outstandingTotal, 600);
  }
  const restored = await background(structuredClone(h.storage));
  assert.equal(restored.run('pipelineSnapshot().outstandingTotal'), 600);
});

test('live source speed changes shorten and lengthen rolling windows while retaining recent starts', async () => {
  const h = queues(['tab-feed-request.js']), queue = h.run('ISSCivitaiSourceQueue'), starts = [];
  h.speed.set(1, 4);
  const request = owner => queue.enqueue(() => { starts.push({ owner, time: h.clock.now() }); return owner; }, () => true, owner);
  await Promise.all(Array.from({ length: 4 }, () => request(7))); await flush();
  const second = Promise.all(Array.from({ length: 4 }, () => request(8))); await flush(); await h.clock.advance(100);
  h.speed.set(5); await h.clock.advance(299); assert.equal(starts.length, 4);
  await h.clock.advance(1); assert.deepEqual(await second, Array(4).fill(8));
  assert.equal(starts[4].time - starts[0].time, 400);
  await h.clock.advance(500); queue.status();
  h.speed.set(1); const third = request(9); await flush();
  assert.equal(queue.status().nextStartInMs, 1500, 'a slowdown remembers starts outside the previous shorter window');
  await h.clock.advance(1499); assert.equal(starts.length, 8);
  await h.clock.advance(1); assert.equal(await third, 9); assert.equal(starts[8].time - starts[4].time, 2000);
  h.speed.set(1, 1);
  const downshifted = request(10); await flush();
  assert.equal(queue.status().maxActive, 1); assert.equal(queue.status().sourceStartLimit, 1);
  assert.equal(queue.status().nextStartInMs, 2000, 'lowering the request limit accounts for the latest prior start');
  await h.clock.advance(1999); assert.equal(starts.length, 9);
  await h.clock.advance(1); assert.equal(await downshifted, 10);
});

test('max speed admits60 metadata source jobs fairly without local queue-overflow errors', async () => {
  const h = queues(['tab-feed-request.js']), queue = h.run('ISSCivitaiSourceQueue'), starts = [];
  h.speed.set(5, 4);
  const jobs = Array.from({ length: 60 }, (_, index) => observe(queue.enqueue(() => { starts.push(index % 3); return index; }, () => true, index % 3)));
  await flush(); assert.equal(starts.length, 4); assert.equal(queue.status().queued, 56);
  for (let index = 0; index < 14; index++) await h.clock.advance(400);
  assert.ok((await Promise.all(jobs)).every(result => result.ok));
  assert.deepEqual(starts.slice(0, 9), [0, 1, 2, 0, 1, 2, 0, 1, 2]);
  assert.equal(queue.status().queued, 0);
});

test('downshifting60 active images preserves room for their second metadata requests', async () => {
  const h = queues(['civitai-image-queue.js', 'tab-feed-request.js']);
  const images = h.context.ISSImageQueue, requests = h.run('ISSCivitaiSourceQueue');
  let completedRequests = 0;
  h.speed.set(5, 4);
  const jobs = Array.from({ length: 60 }, (_, index) => observe(images.run(async () => {
    for (let field = 0; field < 2; field++)
      await requests.enqueue(() => { completedRequests++; }, () => true, index % 3);
  })));
  await flush(); assert.equal(images.status().active, 60);
  h.speed.set(1);
  assert.ok(requests.status().pendingLimit >= 60, 'active high-speed work keeps sufficient source capacity after slowing');
  for (let index = 0; index < 120; index++) await h.clock.advance(2000);
  assert.ok((await Promise.all(jobs)).every(result => result.ok));
  assert.equal(completedRequests, 120); assert.equal(images.status().active, 0);
});

test('speed changes preserve source Retry-After and auth pauses rather than resuming requests', async () => {
  for (const status of [429, 503, 403]) {
    const h = queues(['tab-feed-request.js']), queue = h.run('ISSCivitaiSourceQueue');
    const failed = await observe(queue.enqueue(() => { throw Object.assign(new Error('fixture source refusal'), { status, retryAfterMs: 90000 }); }));
    assert.equal(failed.ok, false); await flush();
    const before = plain(queue.status()), persisted = structuredClone(h.storage.indexCivitaiSourceGuardV1);
    h.speed.set(5); h.speed.set(1.5); h.speed.set(5);
    let started = false;
    const blocked = await observe(queue.enqueue(() => { started = true; }));
    assert.equal(blocked.ok, false); assert.equal(started, false);
    assert.equal(queue.status().blockedUntil, before.blockedUntil);
    assert.equal(queue.status().authStatus, before.authStatus);
    assert.deepEqual(h.storage.indexCivitaiSourceGuardV1, persisted);
  }
});

test('image concurrency grows live to60 globally and downshift waits for the old group to drain', async () => {
  const h = queues(['civitai-image-queue.js']), queue = h.context.ISSImageQueue.create(), releases = [];
  const jobs = Array.from({ length: 61 }, () => queue.run(() => new Promise(resolve => releases.push(resolve))));
  assert.equal(queue.status().active, 12);
  h.speed.set(5); await flush(); assert.equal(queue.status().active, 60); assert.equal(releases.length, 60);
  h.speed.set(1); releases.splice(0).forEach(resolve => resolve()); await flush();
  assert.equal(queue.status().active, 0); assert.equal(queue.status().coolingDown, true);
  await h.clock.advance(999); assert.equal(releases.length, 0);
  await h.clock.advance(1); assert.equal(releases.length, 1); assert.equal(queue.status().active, 1);
  releases.shift()(); await Promise.all(jobs);
});

test('a speed increase reschedules image cooldown but never removes its remaining minimum', async () => {
  const h = queues(['civitai-image-queue.js']), queue = h.context.ISSImageQueue.create();
  await Promise.all(Array.from({ length: 12 }, () => queue.run(() => true))); await flush();
  let started = false; const next = queue.run(() => { started = true; });
  await h.clock.advance(100); h.speed.set(5); await flush(); assert.equal(started, false);
  await h.clock.advance(99); assert.equal(started, false);
  await h.clock.advance(1); await next; assert.equal(started, true);
});

test('a live feed producer grows12to60 and slows without dropping remaining page records', async () => {
  const h = queues(['vendor/devalue.js', 'background-feed.js']), held = [], starts = [], limits = [];
  const images = Array.from({ length: 100 }, (_, index) => ({ id: index + 1, type: 'image',
    url: `https://image.civitai.com/key/${index + 1}/width=450/${index + 1}.png`,
    tags: ['fixture'], meta: { prompt: 'fixture landscape', modelName: 'Base checkpoint', resources: [] } }));
  const feed = { site: 'civitai', pageUrl: 'https://civitai.red/models/99', endpoint: 'image.getInfinite', filters: {}, cursor: null };
  const pending = h.context.ISSFeed.next(feed, async url => {
    limits.push(JSON.parse(new URL(url).searchParams.get('input')).json.limit);
    return { result: { data: { json: { items: images, nextCursor: 'next-page' } } } };
  }, task => { starts.push(h.clock.now()); return new Promise(resolve => held.push(async () => resolve(await task()))); });
  await flush(); assert.equal(starts.length, 12); assert.deepEqual(limits, [60]);
  h.speed.set(5); await flush(); assert.equal(starts.length, 60);
  h.speed.set(1);
  await Promise.all(held.splice(0, 48).map(release => release())); await flush();
  assert.equal(starts.length, 60, 'downshift waits until fewer than12 jobs remain');
  await held.shift()(); await flush(); assert.equal(starts.length, 61);
  while (held.length) { await Promise.all(held.splice(0).map(release => release())); await flush(); }
  const result = await pending;
  assert.equal(result.catalogItems.length, 100); assert.equal(result.cursor, 'next-page');
  assert.equal(new Set(result.catalogItems.map(item => item.id)).size, 100);
});

test('an active passive pulse grows12to60 and speed changes do not invalidate its images', async () => {
  const h = queues(['civitai-auto-background.js']), held = [], calls = [], uploads = [];
  const pageUrl = 'https://civitai.red/models/99';
  const collector = h.context.ISSBrowseCollector.create({
    config: async () => ({ apiBase: API, autoBrowse: true }), load: async () => undefined, save: async () => {},
    tab: async id => ({ id, url: pageUrl }), manualBusy: () => false,
    metadata: async (entry, procedure) => {
      calls.push({ id: entry.card.id, procedure });
      if (procedure === 'image.getDetail') return new Promise(resolve => held.push(() => resolve({ tags: ['fixture'], url: entry.card.previewUrl })));
      return { meta: { prompt: 'fixture landscape' }, resources: [] };
    },
    record: image => record(image.id), upsert: async () => {},
    sync: async records => { uploads.push(...records.map(item => item.id)); return { alreadyStored: 0 }; }
  });
  await collector.accept({ pageUrl, cards: Array.from({ length: 60 }, (_, index) => card(index + 1)) }, { url: pageUrl, tab: { id: 7, url: pageUrl }, frameId: 0 });
  const pending = collector.pulse(); await flush(); assert.equal(held.length, 12);
  h.speed.set(5); await flush(); assert.equal(held.length, 60);
  h.speed.set(1); held.splice(0).forEach(release => release()); await pending; await flush();
  const status = await collector.status(7);
  assert.equal(status.lastError, ''); assert.equal(status.retryAt, 0); assert.equal(status.pending, 0);
  assert.equal(status.submitted, 60); assert.equal(new Set(uploads).size, 60);
  assert.equal(calls.filter(call => call.procedure === 'image.getGenerationData').length, 60);
});

test('collection speed changes keep uploads at three seconds and retain server Retry-After', async () => {
  const h = await background(), requests = [];
  h.context.fetch = async (url, options) => {
    const body = JSON.parse(options.body); requests.push({ url, body, time: h.clock.now() });
    return new Response(JSON.stringify(url.endsWith('action=check')
      ? { ok: true, items: body.imageIds.map(imageId => ({ imageId, exists: false, needsDownload: true, sha256: '', downloadStatus: 'unknown' })) }
      : { ok: true, accepted: body.items.length, skipped: 0 }));
  };
  await h.setSpeed(1);
  const first = h.run(`syncCloudCatalogItems([${JSON.stringify(record(1))}],{tabId:7})`);
  await h.clock.advance(100); assert.equal(requests.length, 1, 'early check does not wait for upload');
  await h.setSpeed(5); await h.clock.advance(2999); assert.equal(requests.length, 1);
  await h.clock.advance(1); await first; await flush(); assert.equal(requests.length, 2);
  const second = h.run(`syncCloudCatalogItems([${JSON.stringify(record(2))}],{tabId:7})`); await h.setSpeed(1);
  await h.clock.advance(100); assert.equal(requests.length, 3);
  await h.clock.advance(2999); assert.equal(requests.length, 3);
  await h.clock.advance(1); await second; await flush(); assert.equal(requests.length, 4);
  h.context.fetch = async () => new Response('{}', { status: 429, headers: { 'Retry-After': '90' } });
  const refused = observe(h.run(`syncCloudCatalogItems([${JSON.stringify(record(3))}],{tabId:7})`)); await h.clock.advance(3000);
  assert.equal((await refused).ok, false); const retryAt = h.run('nextUploadAt');
  assert.ok(retryAt >= h.clock.now() + 90000);
  await h.setSpeed(5); assert.ok(h.run('nextUploadAt') >= retryAt, 'speed cannot shorten a server cooldown');
});

test('max-speed upload batches stay within60 records and the server byte limit', async () => {
  const h = await background(), batches = [];
  await h.setSpeed(5);
  h.context.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    assert.ok(new TextEncoder().encode(options.body).length < 1048576);
    if (body.items) batches.push(body.items.length);
    return new Response(JSON.stringify(body.imageIds
      ? { ok: true, items: body.imageIds.map(imageId => ({ imageId, exists: false, needsDownload: true, sha256: '', downloadStatus: 'unknown' })) }
      : { ok: true, accepted: body.items.length, skipped: 0 }));
  };
  const sync = h.run(`syncCloudCatalogItems(${JSON.stringify(Array.from({ length: 101 }, (_, i) => record(i + 1)))},{tabId:7})`);
  await h.clock.advance(100); await h.clock.advance(1000);
  await h.clock.advance(2000); await h.clock.advance(3000); await sync;
  assert.deepEqual(batches, [60, 41]);
  const longRecords = Array.from({ length: 100 }, (_, i) => ({ ...record(i + 200), prompt: '雪'.repeat(10000) }));
  const large = h.run(`syncCloudCatalogItems(${JSON.stringify(longRecords)},{tabId:7})`);
  await h.clock.advance(1000);
  for (let batch = 0; batch < 4; batch++) await h.clock.advance(3000);
  await large;
  assert.equal(batches.slice(2).reduce((total, count) => total + count, 0), 100);
  assert.ok(batches.slice(2).every(count => count < 100), 'UTF-8 byte size splits long prompts before the record count limit');
});
