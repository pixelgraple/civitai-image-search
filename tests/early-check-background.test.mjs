import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { harness } from './background-harness.mjs';

const source = name => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const flush = async () => { for (let count = 0; count < 1200; count++) await Promise.resolve(); };
const observe = promise => promise.then(value => ({ ok: true, value }), error => ({ ok: false, error }));
const plain = value => JSON.parse(JSON.stringify(value));
const stored = (id, downloadStatus = 'ready') => ({ imageId: String(id), exists: true, needsDownload: false, sha256: 'a'.repeat(64), downloadStatus });
const missing = (id, downloadStatus = 'unknown') => ({ imageId: String(id), exists: false, needsDownload: true, sha256: '', downloadStatus });
const record = id => ({ id: String(id), prompt: 'fixture landscape', downloadUrl: `https://image.civitai.com/key/${id}/original=true/${id}.png` });
const card = id => ({ id: String(id), previewUrl: `https://image.civitai.com/key/${id}/width=450/${id}.png` });

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
        for (const [id, timer] of due) if (timers.delete(id)) timer.callback();
        await flush();
      }
      await flush();
    }
  };
}

function checks(post, options = {}) {
  const context = vm.createContext({ console, Promise });
  const clock = installClock(context);
  vm.runInContext(source('catalog-check-queue.js'), context);
  return { context, clock, queue: context.ISSCatalogChecks.create({ post, ...options }) };
}

async function background(saved = {}) {
  let clock;
  const h = await harness(saved, { setupContext: context => { clock = installClock(context); } });
  await h.run('autoBrowseCollector.initialized');
  h.run('driverPulse=async()=>{}; globalThis.testBrowsePulse=autoBrowseCollector.pulse; autoBrowseCollector.pulse=async()=>{}; uploadIntervalMs=3000;');
  h.run('PromptCatalogDB.forPromptCollection=async items=>({items:items.filter(item=>item?.prompt?.trim()),skippedIds:items.filter(item=>item?.id&&!item?.prompt?.trim()).map(item=>String(item.id))}); PromptCatalogDB.upsert=async items=>items;');
  return { ...h, clock, setSpeed: speedMultiplier => h.extensionMessage({ type: 'setCollectionSpeed', speedMultiplier }) };
}

function addRun(h, id = 7) {
  h.run(`{ const run=freshState({sessionTabId:${id},pageUrl:${JSON.stringify(h.tabs.get(id).url)}});
    run.status.running=true;run.status.scanning=true;
    run.feed={site:'civitai',pageUrl:run.settings.pageUrl,endpoint:'image.getInfinite',filters:{},cursor:null,pages:0};
    sessions.set(${id},run);drivers.set(${id},{...newDriver(),enabled:true}); }`);
}

const jsonResponse = body => new Response(JSON.stringify(body));

test('ready-file duplicates send only reaction enrichment, never image resubmission', async () => {
  const h = await background(), calls = [];
  h.context.fetch = async (url, options) => {
    const body = JSON.parse(options.body); calls.push({ url, body });
    return body.imageIds ? jsonResponse({ ok: true, items: body.imageIds.map(id => stored(id)) })
      : jsonResponse({ ok: true, accepted: body.items.length, missingIds: [] });
  };
  const done = h.run(`syncCloudCatalogItems([${JSON.stringify({ ...record(55), reactions: { likeCount: 0, heartCount: 12 } })}])`);
  await flush(); await h.clock.advance(100); assert.equal((await done).alreadyStored, 1);
  await h.clock.advance(3000);
  const updates = calls.filter(call => call.url.includes('action=source-reactions'));
  assert.equal(updates.length, 1); assert.deepEqual(updates[0].body.items, [{ id: '55', reactions: { likeCount: 0, heartCount: 12 } }]);
  assert.equal(calls.filter(call => /action=images$/.test(call.url)).length, 0); assert.equal(h.started.length, 0);
});

test('manual-feed early duplicate checks retain observed source reactions', async () => {
  const h = await background(), calls = []; addRun(h);
  h.context.fetch = async (url, options) => {
    const body = JSON.parse(options.body); calls.push({ url, body });
    return body.imageIds ? jsonResponse({ ok: true, items: body.imageIds.map(id => stored(id)) })
      : jsonResponse({ ok: true, accepted: body.items.length, missingIds: [] });
  };
  h.run(`ISSFeed.next=async(feed,request,process,progress)=>{
    await progress({phase:'metadata',ids:['55'],total:1});
    const admitted=await progress({phase:'metadata-admit',id:'55',reactions:{likeCount:13,cryCount:0},total:1});
    if(!admitted.skip)throw Error('Duplicate must skip metadata');
    return {items:[],catalogItems:[],done:true,cursor:null};
  };`);
  const page = h.run('backgroundFeedPulse(7)'); await flush(); await h.clock.advance(100); await page; await h.clock.advance(3000);
  const updates = calls.filter(call => call.url.includes('action=source-reactions'));
  assert.equal(updates.length, 1); assert.deepEqual(updates[0].body.items, [{ id: '55', reactions: { likeCount: 13, cryCount: 0 } }]);
  assert.equal(h.run('sessions.get(7).status.catalogStoredSkipped'), 1);
});

test('prompt upload and cursor advance do not wait for a slow optional reaction page', async () => {
  const h = await background(), calls = []; addRun(h); let finishPage, reading = false;
  h.context.readSlowPage = async () => { reading = true; return new Promise(resolve => { finishPage = resolve; }); };
  h.context.feedFixture = { result: { data: { json: { items: [{ id: 55, type: 'image', url: card(55).previewUrl,
    tags: ['landscape'], meta: { prompt: 'landscape', modelName: 'Camera', resources: [] } }], nextCursor: 'next-page' } } } };
  h.run('requestCivitaiFeed=async()=>feedFixture; ISSFeed.civitaiPageReactions=()=>readSlowPage();');
  h.context.fetch = async (url, options) => {
    const body = JSON.parse(options.body); calls.push({ url, body });
    return jsonResponse(body.imageIds ? { ok: true, items: body.imageIds.map(id => missing(id)) }
      : { ok: true, accepted: body.items.length, skipped: 0, missingIds: [] });
  };
  const page = h.run('backgroundFeedPulse(7)'); await flush(); await h.clock.advance(100); await page;
  assert.equal(h.run('sessions.get(7).feed.cursor'), 'next-page');
  assert.equal(h.storage.civitaiReactionPagesV1.pending[0].id, '55');
  await h.clock.advance(1000); assert.equal(reading, true);
  await h.clock.advance(3000); assert.deepEqual(plain(h.run('sessions.get(7).catalogSyncedIds')), ['55']);
  assert.equal(calls.filter(call => call.url.endsWith('action=images')).length, 1);
  assert.equal(calls.filter(call => call.url.endsWith('action=source-reactions')).length, 0);
  finishPage({ likeCount: 4, heartCount: 0, laughCount: 0, cryCount: 0 }); await flush(); await h.clock.advance(3000);
  assert.equal(calls.filter(call => call.url.endsWith('action=source-reactions')).length, 1);
});

test('upload60 and a3second pause remain fixed at every valid collection speed', async () => {
  const context = vm.createContext({}); vm.runInContext(source('collection-speed.js'), context);
  for (let multiplier = 1; multiplier <= 5; multiplier += 0.5) {
    const profile = context.ISSCollectionSpeed.profile(multiplier);
    assert.equal(profile.uploadBatchSize, 60);
    assert.equal(profile.uploadIntervalMs, 3000);
    assert.equal(profile.outstandingLimit, 600);
    assert.equal(profile.metadataConcurrency, 12 * multiplier);
  }
});

test('discovered IDs coalesce across callers into100-ID batches with a1second completion gap', async () => {
  const calls = [];
  const h = checks(async ids => { calls.push({ ids: [...ids], at: h.clock.now() }); return { ok: true, items: ids.map(id => missing(id)) }; });
  const firstTab = h.queue.prime(Array.from({ length: 120 }, (_, i) => i + 1));
  const secondTab = h.queue.prime(Array.from({ length: 90 }, (_, i) => i + 81));
  assert.equal(h.queue.snapshot().waiting, 170);
  await h.clock.advance(99); assert.equal(calls.length, 0);
  await h.clock.advance(1); assert.equal(calls.length, 1); assert.equal(calls[0].ids.length, 100);
  await h.clock.advance(999); assert.equal(calls.length, 1);
  await h.clock.advance(1); assert.equal(calls.length, 2); assert.equal(calls[1].ids.length, 70);
  assert.equal((await firstTab).length, 120); assert.equal((await secondTab).length, 90);
  assert.equal(new Set(calls.flatMap(call => call.ids)).size, 170);
  assert.equal(calls[1].at - calls[0].at, 1000);
  assert.equal(h.queue.snapshot().waiting, 0); assert.equal(h.queue.snapshot().checking, 0);
});

test('in-flight checks are singleflight and their live stages expose checking then cached', async () => {
  let resolvePost, posts = 0;
  const h = checks(ids => { posts++; return new Promise(resolve => { resolvePost = () => resolve({ ok: true, items: ids.map(id => stored(id)) }); }); });
  const first = h.queue.check('11'); assert.equal(h.queue.state('11'), 'waiting');
  await h.clock.advance(100); assert.equal(h.queue.state('11'), 'checking');
  const duplicate = h.queue.check('11'); await h.clock.advance(2000);
  assert.equal(posts, 1); assert.equal(h.queue.snapshot().checking, 1);
  resolvePost(); assert.equal((await first).exists, true); assert.equal((await duplicate).exists, true);
  assert.equal(h.queue.state('11'), null); assert.equal(h.queue.snapshot().cached, 1);
});

test('verified originals cache30seconds and missing files cache10seconds', async () => {
  const calls = [];
  const h = checks(async ids => { calls.push([...ids]); return { ok: true, items: ids.map(id => id === '1' ? stored(id) : missing(id)) }; });
  const initial = h.queue.prime(['1', '2']); await h.clock.advance(100); await initial;
  await h.clock.advance(9999); await h.queue.prime(['1', '2']); assert.equal(calls.length, 1);
  await h.clock.advance(1);
  const missingExpired = h.queue.check('2'); await h.clock.advance(100); await missingExpired; assert.equal(calls.length, 2);
  await h.clock.advance(19899); await h.queue.check('1'); assert.equal(calls.length, 2);
  await h.clock.advance(1);
  const storedExpired = h.queue.check('1'); await h.clock.advance(100); await storedExpired;
  assert.equal(calls.length, 3); assert.deepEqual(calls[2], ['1']);
});

test('verified cache is bounded to2000entries and evicted IDs are rechecked', async () => {
  let posts = 0;
  const h = checks(async ids => { posts++; return { ok: true, items: ids.map(id => stored(id)) }; });
  for (let batch = 0; batch < 21; batch++) {
    const pending = h.queue.prime(Array.from({ length: 100 }, (_, i) => String(batch * 100 + i + 1)));
    await h.clock.advance(batch ? 1000 : 100); await pending;
  }
  assert.equal(h.queue.snapshot().cached, 2000);
  await h.queue.check('2100'); assert.equal(posts, 21);
  const evicted = h.queue.check('1'); await h.clock.advance(1000); await evicted;
  assert.equal(posts, 22); assert.equal(h.queue.snapshot().cached, 2000);
});

test('original awaiting thumbnail repair is stored while pending or failed missing originals are not', async () => {
  const h = checks(async ids => ({ ok: true, items: ids.map(id => id === '1' ? stored(id, 'pending') : missing(id, id === '2' ? 'pending' : 'failed')) }));
  const result = h.queue.prime(['1', '2', '3']); await h.clock.advance(100);
  assert.deepEqual((await result).map(item => item.exists), [true, false, false]);
});

test('malformed or incomplete responses fail the whole batch without poisoning cache', async () => {
  const badResponses = [
    { ok: true, items: [] },
    { ok: true, items: [stored('1'), stored('1')] },
    { ok: true, items: [stored('1'), stored('99')] },
    { ok: true, items: [stored('1'), { ...stored('2'), sha256: 'bad' }] },
    { ok: true, items: [stored('1'), { ...stored('2'), downloadStatus: 'failed' }] },
    { ok: true, items: [stored('1'), { ...stored('2'), needsDownload: true }] },
    { ok: true, items: [stored('1'), { ...missing('2'), exists: 'false' }] },
    { ok: true, items: [stored('1'), { ...missing('2'), imageId: 2 }] }
  ];
  for (const bad of badResponses) {
    let invalid = true;
    const h = checks(async ids => invalid ? bad : { ok: true, items: ids.map(id => missing(id)) });
    const result = observe(h.queue.prime(['1', '2'])); await h.clock.advance(100);
    assert.equal((await result).ok, false); assert.equal(h.queue.snapshot().cached, 0);
    invalid = false;
    const retry = h.queue.prime(['1', '2']); await h.clock.advance(1000);
    assert.equal((await retry).length, 2); assert.equal(h.queue.snapshot().cached, 2);
  }
});

test('Stop cancels only its check subscriber before network and after a shared response', async () => {
  let live = false, posts = 0, resolvePost;
  const h = checks(ids => { posts++; return new Promise(resolve => { resolvePost = () => resolve({ ok: true, items: ids.map(id => stored(id)) }); }); });
  const stoppedBefore = observe(h.queue.check('1', () => live)); await h.clock.advance(100);
  assert.equal((await stoppedBefore).error.code, 'COLLECTION_CANCELLED'); assert.equal(posts, 0);
  live = true;
  const stoppedDuring = observe(h.queue.check('2', () => live)), otherTab = h.queue.check('2', () => true);
  await h.clock.advance(100); live = false; resolvePost();
  assert.equal((await stoppedDuring).error.status, 409); assert.equal((await otherTab).exists, true); assert.equal(posts, 1);
  const cachedStop = await observe(h.queue.check('2', () => false)); assert.equal(cachedStop.error.code, 'COLLECTION_CANCELLED');
});

test('early-check queue caps600unique IDs, preserves duplicate subscribers, and honors server cooldown', async () => {
  let cooldown = 0; const calls = [];
  const h = checks(async ids => { calls.push([...ids]); return { ok: true, items: ids.map(id => missing(id)) }; }, { cooldownUntil: () => cooldown });
  const work = h.queue.prime(Array.from({ length: 600 }, (_, i) => String(i + 1)));
  const duplicate = h.queue.check('600');
  const overflow = await observe(h.queue.check('601')); assert.equal(overflow.error.status, 503);
  cooldown = h.clock.now() + 60000;
  await h.clock.advance(100); assert.equal(calls.length, 0);
  await h.clock.advance(59899); assert.equal(calls.length, 0);
  await h.clock.advance(1); assert.equal(calls.length, 1);
  for (let batch = 0; batch < 5; batch++) await h.clock.advance(1000);
  assert.equal((await work).length, 600); assert.equal((await duplicate).imageId, '600');
  assert.equal(calls.flat().length, 600);
});

test('a new stored image is checked and skipped while an unrelated imagesPOST is blocked', async () => {
  const h = await background(), calls = []; let releaseUpload;
  h.context.fetch = async (url, options) => {
    const body = JSON.parse(options.body); calls.push({ url, body, at: h.clock.now() });
    if (body.imageIds) return jsonResponse({ ok: true, items: body.imageIds.map(id => id === '2' ? stored(id) : missing(id)) });
    return new Promise(resolve => { releaseUpload = () => resolve(jsonResponse({ ok: true, accepted: body.items.length, skipped: 0 })); });
  };
  const upload = h.run(`syncCloudCatalogItems([${JSON.stringify(record(1))}])`);
  await h.clock.advance(100); await h.clock.advance(3000);
  assert.equal(typeof releaseUpload, 'function'); assert.equal(h.run('uploadFlushing'), true);
  const duplicate = h.run(`syncCloudCatalogItems([${JSON.stringify(record(2))}])`);
  await h.clock.advance(100);
  assert.equal((await duplicate).alreadyStored, 1);
  assert.equal(calls.filter(call => call.body.imageIds).length, 2);
  assert.equal(calls.filter(call => call.body.items).length, 1);
  assert.equal(h.run('uploadFlushing'), true, 'early check never waits for the occupied upload queue');
  releaseUpload(); await upload;
});

test('only missing records upload in60record batches with a full3second pause at5x', async () => {
  const h = await background(), calls = [];
  await h.setSpeed(5);
  h.context.fetch = async (url, options) => {
    const body = JSON.parse(options.body); calls.push({ body, at: h.clock.now() });
    assert.ok(new TextEncoder().encode(options.body).length < 1048576);
    return jsonResponse(body.imageIds
      ? { ok: true, items: body.imageIds.map(id => id === '121' ? stored(id) : missing(id)) }
      : { ok: true, accepted: body.items.length, skipped: 0 });
  };
  const submitted = h.run(`syncCloudCatalogItems(${JSON.stringify(Array.from({ length: 121 }, (_, i) => record(i + 1)))})`);
  await h.clock.advance(100); await h.clock.advance(1000);
  assert.equal(calls.filter(call => call.body.items).length, 0);
  await h.clock.advance(1999); assert.equal(calls.filter(call => call.body.items).length, 0);
  await h.clock.advance(1); assert.equal(calls.filter(call => call.body.items).length, 1);
  await h.setSpeed(1); await h.clock.advance(2999); assert.equal(calls.filter(call => call.body.items).length, 1);
  await h.setSpeed(5); await h.clock.advance(1);
  const result = await submitted, uploads = calls.filter(call => call.body.items);
  assert.deepEqual(uploads.map(call => call.body.items.length), [60, 60]);
  assert.equal(uploads[1].at - uploads[0].at, 3000);
  assert.ok(uploads.every(call => call.body.items.every(item => item.id !== '121')));
  assert.equal(result.alreadyStored, 1); assert.equal(result.accepted, 121);
});

test('background invalid check response never uploads and remains retryable', async () => {
  const h = await background(); let checks = 0, uploads = 0;
  h.context.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    if (body.imageIds) { checks++; return jsonResponse(checks === 1 ? { ok: true, items: [] } : { ok: true, items: body.imageIds.map(id => stored(id)) }); }
    uploads++; return jsonResponse({ ok: true, accepted: body.items.length });
  };
  const failure = observe(h.run(`syncCloudCatalogItems([${JSON.stringify(record(1))}])`)); await h.clock.advance(100);
  assert.equal((await failure).ok, false); assert.equal(uploads, 0); assert.equal(h.run('catalogChecks.snapshot().cached'), 0);
  const retry = h.run(`syncCloudCatalogItems([${JSON.stringify(record(1))}])`); await h.clock.advance(1000);
  assert.equal((await retry).alreadyStored, 1); assert.equal(uploads, 0);
});

test('live pipeline separates duplicate waiting, checking, ready and actual uploading', async () => {
  const h = await background(); addRun(h);
  let releaseCheck, releaseUpload;
  h.context.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    return new Promise(resolve => {
      if (body.imageIds) releaseCheck = () => resolve(jsonResponse({ ok: true, items: body.imageIds.map(id => missing(id)) }));
      else releaseUpload = () => resolve(jsonResponse({ ok: true, accepted: body.items.length, skipped: 0 }));
    });
  };
  h.run('reserveOutstanding("1","manual",7,"readyUpload");sessions.get(7).outstandingIds=["1"];');
  const submitted = h.run(`syncCloudCatalogItems([${JSON.stringify(record(1))}],{onAccepted:(records,items)=>acceptManualRecords(sessions.get(7),records,items)})`);
  assert.equal(h.run('pipelineSnapshot().waitingDuplicateCheck'), 1);
  await h.clock.advance(100); assert.equal(h.run('pipelineSnapshot().checkingDuplicates'), 1);
  assert.equal(h.run('pipelineSnapshot().uploading'), 0);
  releaseCheck(); await flush(); assert.equal(h.run('pipelineSnapshot().readyUpload'), 1);
  await h.clock.advance(2999); assert.equal(h.run('pipelineSnapshot().uploading'), 0);
  await h.clock.advance(1); assert.equal(h.run('pipelineSnapshot().uploading'), 1);
  releaseUpload(); await submitted; await flush(); assert.equal(h.run('pipelineSnapshot().outstandingTotal'), 0);
});

test('manual selected feed skips stored IDs before image workers and advances a durable cursor before uploads finish', async () => {
  const h = await background(); addRun(h); const imageWorkers = [], calls = [];
  const feedImages = [1, 2].map(id => ({ id, type: 'image', url: card(id).previewUrl, tags: ['fixture'],
    stats: id === 2 ? { likeCount: 0, heartCount: 0, laughCount: 0, cryCount: 0 } : {},
    meta: { prompt: 'fixture landscape', modelName: 'Base checkpoint', resources: [] } }));
  h.context.feedFixture = { result: { data: { json: { items: feedImages, nextCursor: 'next-page' } } } };
  h.context.imageWorker = task => { imageWorkers.push(true); return task(); };
  h.run('requestCivitaiFeed=async()=>feedFixture;globalThis.ISSImageQueue={...ISSImageQueue,run:(...args)=>imageWorker(...args)};');
  h.context.fetch = async (_url, options) => {
    const body = JSON.parse(options.body); calls.push(body);
    return jsonResponse(body.imageIds ? { ok: true, items: body.imageIds.map(id => id === '1' ? stored(id) : missing(id)) }
      : { ok: true, accepted: body.items.length, skipped: 0 });
  };
  const page = h.run('backgroundFeedPulse(7)'); await flush(); await h.clock.advance(100); await page;
  assert.equal(imageWorkers.length, 1, 'stored image never enters source metadata processing: ' + JSON.stringify(h.run('sessions.get(7).status')));
  assert.deepEqual(plain(h.run('sessions.get(7).catalogStoredSkippedIds')), ['1']);
  assert.equal(h.run('sessions.get(7).feed.cursor'), 'next-page');
  const saved = h.storage.aiImageDatasetScraperStateV6.runs[0];
  assert.equal(saved.feed.cursor, 'next-page'); assert.equal(saved.preparedRecords['2'].prompt, 'fixture landscape');
  assert.equal(calls.filter(body => body.items).length, 0, 'cursor progresses while durable upload is still waiting');
  assert.equal(h.run('pipelineSnapshot().outstandingTotal'), 1);
  await h.clock.advance(3000);
  assert.equal(calls.filter(body => body.items).length, 1);
  assert.deepEqual(plain(h.run('sessions.get(7).catalogSyncedIds')), ['1', '2']);
  assert.equal(h.run('pipelineSnapshot().outstandingTotal'), 0);
});

test('passive discovery skips stored IDs before metadata and leaves only missing work queued', async () => {
  const h = await background(), calls = [], metadata = [];
  h.context.fetch = async (_url, options) => {
    const body = JSON.parse(options.body); calls.push(body);
    return jsonResponse(body.imageIds ? { ok: true, items: body.imageIds.map(id => id === '1' ? stored(id, 'pending') : missing(id)) }
      : { ok: true, accepted: body.items.length, skipped: 0 });
  };
  h.context.metadata = async (_feed, procedure, id) => {
    metadata.push({ procedure, id });
    return procedure === 'image.getDetail' ? { tags: ['fixture'], url: card(id).previewUrl,
      stats: { likeCount: 0, heartCount: 0, laughCount: 0, cryCount: 0 } } : { meta: { prompt: 'fixture landscape' }, resources: [] };
  };
  h.run('ISSFeed.civitaiMetadata=(...args)=>metadata(...args);');
  const accepted = await h.message({ type: 'civitai-auto-cards', pageUrl: h.tabs.get(7).url, cards: [card(1), card(2)] });
  assert.equal(accepted.accepted.length, 2);
  await h.clock.advance(100);
  const skipped = await h.run('autoBrowseCollector.status(7)');
  assert.equal(skipped.alreadyStored, 1); assert.equal(skipped.pending, 1); assert.equal(metadata.length, 0);
  const pulse = h.run('testBrowsePulse()'); await flush(); await pulse;
  assert.equal(metadata.length, 2); assert.ok(metadata.every(call => call.id === '2'));
  assert.equal(calls.filter(body => body.items).length, 0);
  await h.clock.advance(3000);
  const final = await h.run('autoBrowseCollector.status(7)');
  assert.equal(final.pending, 0); assert.equal(final.submitted, 2); assert.equal(final.alreadyStored, 1);
  assert.deepEqual(calls.filter(body => body.items).flatMap(body => body.items.map(item => item.id)), ['2']);
});

test('a completed feed with durable pending uploads resumes after restart and drains before stopping', async () => {
  const initial = await background(); addRun(initial);
  initial.run(`{const run=sessions.get(7);run.feed.done=true;run.feed.cursor='final-cursor';run.feed.pages=5;
    run.status.running=false;run.status.stopped=true;run.outstandingIds=['9'];run.preparedRecords['9']=${JSON.stringify(record(9))};}`);
  await initial.run('persistState(sessions.get(7))');
  const h = await background(structuredClone(initial.storage)), calls = [];
  h.context.fetch = async (_url, options) => {
    const body = JSON.parse(options.body); calls.push(body);
    return jsonResponse(body.imageIds ? { ok: true, items: body.imageIds.map(id => missing(id)) }
      : { ok: true, accepted: body.items.length, skipped: 0 });
  };
  h.run('ISSFeed.next=async()=>{throw new Error("A completed feed must not be fetched again");};');
  const resume = await h.message({ type: 'resume' }); assert.equal(resume.ok, true);
  await h.run('backgroundFeedPulse(7)'); await flush();
  assert.equal(h.run('sessions.get(7).status.running'), true);
  assert.equal(h.run('sessions.get(7).feed.cursor'), 'final-cursor');
  await h.clock.advance(100); await h.clock.advance(3000);
  await h.run('backgroundFeedPulse(7)');
  assert.equal(calls.filter(body => body.items).length, 1);
  assert.deepEqual(plain(h.run('sessions.get(7).catalogSyncedIds')), ['9']);
  assert.equal(h.run('sessions.get(7).status.running'), false);
  assert.equal(h.run('sessions.get(7).status.stopReason'), 'feed-complete');
  assert.equal(h.run('Object.keys(sessions.get(7).preparedRecords).length'), 0);
});

test('HTTP429 pauses early checks and uploads together without a speed-change bypass', async () => {
  const h = await background(); let requests = 0;
  h.context.fetch = async (_url, options) => {
    requests++; const body = JSON.parse(options.body);
    if (requests === 1) return new Response('{}', { status: 429, headers: { 'Retry-After': '90' } });
    return jsonResponse({ ok: true, items: body.imageIds.map(id => stored(id)) });
  };
  const first = observe(h.run('checkQueuedCatalogImage("1",()=>true)')); await h.clock.advance(100);
  assert.equal((await first).error.status, 429);
  const until = h.run('uploadCooldownUntil'); assert.equal(until - h.clock.now(), 90000);
  const second = h.run(`syncCloudCatalogItems([${JSON.stringify(record(2))}])`);
  await h.setSpeed(5); await h.clock.advance(89999); assert.equal(requests, 1);
  assert.equal(h.run('uploadCooldownUntil'), until);
  await h.clock.advance(1); assert.equal((await second).alreadyStored, 1); assert.equal(requests, 2);
});

test('stopping one passive tab during a shared check preserves its queue and lets another tab finish', async () => {
  const h = await background(); h.tabs.set(8, { id: 8, url: 'https://civitai.com/images' });
  let release; const requests = [];
  h.context.fetch = async (_url, options) => {
    const body = JSON.parse(options.body); requests.push(body);
    return new Promise(resolve => { release = () => resolve(jsonResponse({ ok: true, items: body.imageIds.map(id => stored(id)) })); });
  };
  for (const tabId of [7, 8]) await h.message({ type: 'civitai-auto-cards', pageUrl: h.tabs.get(tabId).url, cards: [card(tabId)] },
    { url: h.tabs.get(tabId).url, tab: h.tabs.get(tabId), frameId: 0 });
  await h.clock.advance(100); assert.equal(requests.length, 1);
  await h.message({ type: 'stop' }); release(); await flush();
  const stopped = await h.run('autoBrowseCollector.status(7)'), live = await h.run('autoBrowseCollector.status(8)');
  assert.equal(stopped.tabPaused, true); assert.equal(stopped.pending, 1); assert.equal(stopped.alreadyStored, 0);
  assert.equal(stopped.lastError, ''); assert.equal(stopped.retryAt, 0);
  assert.equal(live.pending, 0); assert.equal(live.alreadyStored, 1);
  assert.equal(h.run('pipelineSnapshot().outstandingTotal'), 1); assert.equal(h.run('pipelineSnapshot().paused'), 1);
});

test('a completed feed reattaches to a reopened tab and drains its orphaned prepared uploads', async () => {
  const initial = await background(); addRun(initial);
  initial.run(`{const run=sessions.get(7);run.feed.done=true;run.feed.cursor='last-page';run.feed.pages=4;
    run.status.running=false;run.status.stopped=true;run.outstandingIds=['9'];run.preparedRecords['9']=${JSON.stringify(record(9))};}`);
  await initial.run('persistState(sessions.get(7))');
  let clock;
  const h = await harness(structuredClone(initial.storage), {
    tabs: [{ id: 8, url: initial.tabs.get(7).url }], setupContext: context => { clock = installClock(context); }
  });
  h.run('driverPulse=async()=>{};autoBrowseCollector.pulse=async()=>{};uploadIntervalMs=3000;');
  h.run('ISSFeed.next=async()=>{throw new Error("An orphaned completed feed must not be fetched again");};');
  const calls = [];
  h.context.fetch = async (_url, options) => {
    const body = JSON.parse(options.body); calls.push(body);
    return jsonResponse(body.imageIds ? { ok: true, items: body.imageIds.map(id => missing(id)) }
      : { ok: true, accepted: body.items.length, skipped: 0 });
  };
  const source = { tab: h.tabs.get(8), url: h.tabs.get(8).url, frameId: 0 };
  const state = await h.message({ type: 'getState' }, source);
  assert.equal(state.canResume, true);
  const resumed = await h.message({ type: 'resume' }, source); assert.equal(resumed.ok, true);
  assert.equal(h.run('sessions.has(7)'), false);
  assert.equal(h.run('sessions.get(8).feed.cursor'), 'last-page');
  assert.equal(h.run('pipelineSnapshot(8).outstanding'), 1);
  await h.run('backgroundFeedPulse(8)'); await flush(); await clock.advance(100); await clock.advance(3000);
  await h.run('backgroundFeedPulse(8)');
  assert.deepEqual(calls.filter(body => body.items).flatMap(body => body.items.map(item => item.id)), ['9']);
  assert.equal(h.run('sessions.get(8).status.stopReason'), 'feed-complete');
  assert.equal(h.run('pipelineSnapshot().outstandingTotal'), 0);
});

test('concurrent duplicate metadata cannot grow a selected upload beyond the server byte limit', async () => {
  const h = await background(), uploads = [];
  h.context.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    if (body.items) uploads.push({ bytes: new TextEncoder().encode(options.body).length, ids: body.items.map(item => item.id) });
    return jsonResponse(body.imageIds ? { ok: true, items: body.imageIds.map(id => missing(id)) }
      : { ok: true, accepted: body.items.length, skipped: 0 });
  };
  const initial = h.run(`syncCloudCatalogItems(${JSON.stringify([record(1), { ...record(2), prompt: 'x'.repeat(600000) }])})`);
  await h.clock.advance(100);
  h.context.grownRecord = { ...record(1), prompt: 'y'.repeat(600000) };
  h.run(`globalThis.originalLiveSubscribers=liveSubscribers;globalThis.growthTriggered=false;
    liveSubscribers=async entry=>{if(entry.record.id==='2'&&!growthTriggered){growthTriggered=true;globalThis.growthResult=syncCloudCatalogItems([grownRecord]);}
      return originalLiveSubscribers(entry);};`);
  await h.clock.advance(3000); await h.clock.advance(3000); await initial; await h.run('growthResult');
  assert.ok(uploads.length >= 1);
  assert.ok(uploads.every(upload => upload.bytes < 1048576), JSON.stringify(uploads));
});
