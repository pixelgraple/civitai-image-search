import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { installCheckpoint } from './background-harness.mjs';
const source = fs.readFileSync(new URL('../civitai-auto-background.js', import.meta.url), 'utf8');
const blankCard = id => ({ id: String(id), previewUrl: `https://image.civitai.com/key/${id}/width=450/${id}.jpeg`, width: 450, height: 600 });
const initialCloud = { apiBase: 'https://search-civitai.xyz/api.php' };
const pageUrl = 'https://civitai.red/models/99';
function harness(storage = {}, overrides = {}) {
  let now = 100000, cloud = { ...initialCloud }, manual = false;
  const calls = [], uploads = [], stored = [], tabs = new Map([[7, { id: 7, url: pageUrl }], [8, { id: 8, url: pageUrl }]]);
  const context = vm.createContext({ URL, console, structuredClone, Date: { now: () => now } });
  installCheckpoint(context);
  vm.runInContext(source, context);
  const deps = {
    config: async () => cloud, load: async key => structuredClone(storage[key]),
    save: async (key, value) => { storage[key] = structuredClone(value); }, tab: async id => tabs.get(id),
    manualBusy: () => manual,
    metadata: async (entry, procedure) => { calls.push({ id: entry.card.id, procedure, pageUrl: entry.pageUrl });
      return procedure === 'image.getDetail' ? { id: Number(entry.card.id), tags: [{ tag: { name: 'selfie' } }] } : { meta: { prompt: 'selfie photo' } }; },
    record: (image, enrichment) => ({ id: String(image.id), prompt: enrichment.generation?.meta?.prompt || '',
      downloadUrl: image.url, tags: ['selfie'] }),
    upsert: async records => { stored.push(structuredClone(records)); },
    sync: async (records, options) => { uploads.push({ records: structuredClone(records), options }); return { alreadyStored: 1 }; },
    ...overrides
  };
  const collector = context.ISSBrowseCollector.create(deps);
  // Preparation and upload are intentionally independent. Flush immediate fake
  // uploader continuations without waiting for deliberately blocked transfers.
  const flush = async () => { for (let index = 0; index < 160; index++) await Promise.resolve(); };
  const pulse = collector.pulse, status = collector.status;
  collector.pulse = async () => { await pulse(); await flush(); };
  collector.status = async (...args) => { await flush(); return status(...args); };
  const message = (cards = [blankCard(55)], sender = { tab: { id: 7, url: pageUrl }, url: pageUrl, frameId: 0 }, url = pageUrl) =>
    collector.accept({ pageUrl: url, cards }, sender);
  return { collector, storage, calls, uploads, stored, tabs, message, deps,
    configure: value => { cloud = value; }, manual: value => { manual = value; }, advance: ms => { now += ms; } };
}

test('stored and previously seen images enrich reaction metadata without rereading prompts', async () => {
  const updates = [];
  const h = harness({}, { checkQueued: async id => ({ imageId: id, exists: true }),
    observeReactions: (id, reactions) => updates.push({ id, reactions: structuredClone(reactions) }) });
  await h.message([{ ...blankCard(55), reactions: { likeCount: 7, heartCount: 0 } }]); await h.collector.pulse();
  assert.equal(h.calls.length, 0); assert.equal(h.uploads.length, 0);
  assert.deepEqual(updates[0], { id: '55', reactions: { likeCount: 7, heartCount: 0 } });
  await h.message([{ ...blankCard(55), reactions: { likeCount: 8 } }]);
  assert.equal(updates.at(-1).reactions.likeCount, 8); assert.equal((await h.collector.status()).pending, 0);
});
test('reaction-only observations are allowed during a manual feed and never create image jobs', async () => {
  const updates = [], h = harness({}, { observeReactions: (id, reactions) => updates.push({ id, reactions }) });
  h.manual(true);
  const response = await h.collector.accept({ pageUrl, reactionsOnly: true, cards: [{ ...blankCard(55), reactions: { likeCount: 0, heartCount: '8', cryCount: -1 } }] },
    { tab: { id: 7, url: pageUrl }, url: pageUrl, frameId: 0 });
  assert.deepEqual(Array.from(response.accepted), ['55']); assert.equal(updates.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(updates[0].reactions)), { likeCount: 0 });
  assert.equal((await h.collector.status()).pending, 0); assert.equal(h.calls.length, 0);
});

test('passive collection durably defers image pages only when core reaction counts are missing', async () => {
  for (const complete of [false, true]) {
    const pages = [], stats = complete ? { likeCount: 0, heartCount: 0, laughCount: 0, cryCount: 0 } : {};
    const h = harness({}, { record: image => ({ id: String(image.id), prompt: 'landscape', downloadUrl: image.url, reactions: stats }),
      deferReactions: async entry => { pages.push(entry.card.id); } });
    await h.message(); await h.collector.pulse();
    assert.equal(pages.length, complete ? 0 : 1); assert.equal(h.uploads[0].records[0].reactions.likeCount, complete ? 0 : undefined);
  }
});

test('automatic collection defaults on without a key and only on exact HTTPS Civitai hosts', async () => {
  const h = harness();
  assert.equal((await h.collector.status()).active, true);
  for (const url of ['https://civitai.red.evil.test/models/99', 'https://www.civitai.red/models/99', 'http://civitai.red/models/99', 'https://other.test/']) {
    assert.equal((await h.message(undefined, { tab: { id: 7, url }, url }, url)).ok, false);
  }
  assert.equal((await h.message(undefined, { tab: { id: 7, url: pageUrl }, url: pageUrl, frameId: 2 })).ok, false);
  assert.equal((await h.message(undefined, undefined, pageUrl + '?changed=1')).ok, false);
  h.configure({ ...initialCloud, writeToken: '' });
  assert.equal((await h.collector.status()).active, true);
  assert.deepEqual(Array.from((await h.message()).accepted), ['55']);
  await h.collector.pulse(); assert.equal(h.calls.length, 2);
  h.configure({ ...initialCloud, autoBrowse: false });
  assert.equal((await h.collector.status()).active, false);
});

test('card acceptance uses the current tab URL when a trusted sender URL lags SPA navigation', async () => {
  const h = harness();
  const nextPage = pageUrl + '?view=gallery';
  h.tabs.get(7).url = nextPage;
  const staleSender = { tab: { id: 7, url: pageUrl }, url: pageUrl, frameId: 0 };
  const accepted = await h.message([blankCard(55)], staleSender, nextPage);
  assert.equal(accepted.ok, true); assert.deepEqual(Array.from(accepted.accepted), ['55']);
  assert.equal((await h.message([blankCard(56)], staleSender, pageUrl)).ok, false);
  assert.equal((await h.message([blankCard(57)], staleSender, 'https://civitai.com/models/99?view=gallery')).ok, false);
  assert.equal((await h.message([blankCard(58)], { ...staleSender, url: 'https://evil.example/' }, nextPage)).ok, false);
  h.tabs.get(7).url = 'https://evil.example/';
  assert.equal((await h.message([blankCard(59)], staleSender, nextPage)).ok, false);
  assert.equal((await h.collector.status(7)).pending, 1);
});

test('visible-card metadata is read sequentially, indexed and synced without any local image download', async () => {
  const h = harness();
  await h.message(); await h.collector.pulse();
  assert.deepEqual(h.calls.map(call => call.procedure), ['image.getDetail', 'image.getGenerationData']);
  assert.equal(h.calls.every(call => call.id === '55' && call.pageUrl === pageUrl), true);
  assert.equal(h.stored.length, 1); assert.equal(h.uploads.length, 1);
  assert.equal(h.uploads[0].options.required, true);
  const status = await h.collector.status();
  assert.equal(status.synced, 1); assert.equal(status.alreadyStored, 1); assert.equal(status.pending, 0);
  assert.doesNotMatch(source, /downloads\.download|ISSFeed\.next|scrollTo|scrollBy/);
});

test('promptless images are acknowledged and skipped before catalog writes or server copies', async () => {
  const h = harness({}, { metadata: async (_entry, procedure) => procedure === 'image.getDetail' ? { tags: [] } : { meta: { prompt: '  ', negativePrompt: 'selfie' }, resources: [] } });
  await h.message(); await h.collector.pulse();
  assert.equal(h.stored.length, 0); assert.equal(h.uploads.length, 0);
  assert.equal((await h.collector.status()).skippedPromptless, 1);
  assert.equal((await h.collector.status()).pending, 0);
  await h.message(); h.advance(30000); await h.collector.pulse();
  assert.equal((await h.collector.status()).skippedPromptless, 1);
});

test('a missing rescan prompt reuses an existing known positive prompt', async () => {
  const h = harness({}, { metadata: async () => ({ tags: [], meta: {} }), existing: async id => ({ id, prompt: 'known selfie prompt' }) });
  await h.message(); await h.collector.pulse();
  assert.equal(h.uploads[0].records[0].prompt, 'known selfie prompt');
  assert.equal((await h.collector.status()).skippedPromptless, 0);
});

test('new cards from two tabs deduplicate in one serialized persistent queue', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const h = harness({}, { metadata: async (_entry, procedure) => {
    if (procedure === 'image.getDetail') await gate;
    return procedure === 'image.getDetail' ? { tags: [] } : { meta: { prompt: 'selfie' } };
  } });
  await h.message();
  await h.message(undefined, { tab: { id: 8, url: pageUrl }, url: pageUrl });
  assert.equal((await h.collector.status()).pending, 1);
  const first = h.collector.pulse(); await h.collector.pulse();
  release(); await first;
  assert.equal(h.uploads.length, 1); assert.equal(h.storage.civitaiBrowseCollectorV1.seen.length, 1);
});

test('pending cards survive worker restart, and transient failures retry the same record after cooldown', async () => {
  const storage = {};
  const h = harness(storage, { sync: async () => { throw Object.assign(new Error('Shared HTTP 503'), { status: 503 }); } });
  await h.message(); await h.collector.pulse();
  assert.equal(storage.civitaiBrowseCollectorV1.pending.length, 1);
  assert.equal((await h.collector.status()).suspended, false);
  const reads = h.calls.length; await h.collector.pulse(); assert.equal(h.calls.length, reads);
  const resumed = harness(storage); await resumed.collector.pulse(); assert.equal(resumed.uploads.length, 0);
  resumed.advance(31000); await resumed.collector.pulse();
  assert.equal(resumed.uploads.length, 1); assert.equal(storage.civitaiBrowseCollectorV1.pending.length, 0);
});

test('auth rejection suspends collection across worker restart until settings change', async () => {
  const storage = {};
  const h = harness(storage, { sync: async () => { throw Object.assign(new Error('Rejected key'), { status: 401 }); } });
  await h.message(); await h.collector.pulse();
  assert.equal((await h.collector.status()).active, false);
  const resumed = harness(storage); await resumed.collector.pulse();
  assert.equal(resumed.uploads.length, 0); assert.equal((await resumed.collector.status()).suspended, true);
  await resumed.collector.reconfigure(); await resumed.collector.pulse();
  assert.equal(resumed.uploads.length, 1);
});

test('upgrade clears a legacy contributor-key suspension once without losing the observed queue',async()=>{
  const storage={}; const original=harness(storage);await original.message();
  const saved=storage.civitaiBrowseCollectorV1;
  delete saved.publicMode;saved.suspended=true;saved.lastError='Contributor key is invalid';saved.retryAt=400000;
  const upgraded=harness(storage);await upgraded.collector.initialized;
  assert.equal((await upgraded.collector.status()).suspended,false);
  assert.equal((await upgraded.collector.status()).pending,1);
  assert.equal(storage.civitaiBrowseCollectorV1.publicMode,true);
  await upgraded.collector.pulse();assert.equal(upgraded.uploads.length,1);
});

test('source Retry-After survives MV3 worker restart rather than bypassing its cooldown', async () => {
  const storage = {};
  const h = harness(storage, { metadata: async () => { throw Object.assign(new Error('Source rate limited'), { status: 429, retryAfterMs: 300000 }); } });
  await h.message(); await h.collector.pulse();
  assert.equal(storage.civitaiBrowseCollectorV1.retryAt, 400000);
  const resumed = harness(storage); await resumed.collector.pulse(); assert.equal(resumed.calls.length, 0);
  resumed.advance(299999); await resumed.collector.pulse(); assert.equal(resumed.calls.length, 0);
  resumed.advance(1); await resumed.collector.pulse(); assert.equal(resumed.uploads.length, 1);
});

test('same-origin SPA navigation keeps observed backlog and cancels old reads; tab close drops it', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  let entered; const started = new Promise(resolve => { entered = resolve; });
  const h = harness({}, { metadata: async () => { entered(); await gate; return { tags: [], meta: { prompt: 'selfie' } }; } });
  await h.message(); const work = h.collector.pulse();
  await started; await h.collector.dropTab(7, 'https://civitai.red/images/99');
  h.tabs.get(7).url = 'https://civitai.red/images/99'; release(); await work;
  assert.equal(h.uploads.length, 0); assert.equal((await h.collector.status()).pending, 1);
  assert.equal(h.storage.civitaiBrowseCollectorV1.pending[0].pageUrl, 'https://civitai.red/images/99');
  h.advance(11000); await h.collector.pulse(); assert.equal(h.uploads.length, 1);
  const fresh = harness(); await fresh.message(); await fresh.collector.dropTab(7);
  fresh.tabs.delete(7); await fresh.collector.pulse(); assert.equal(fresh.calls.length, 0);
  const moved = harness(); await moved.message(); await moved.collector.dropTab(7, 'https://other.test/');
  assert.equal((await moved.collector.status()).pending, 0);
});

test('manual scans defer passive work and disabling browsing clears its pending queue', async () => {
  const h = harness(); await h.message(); h.manual(true); await h.collector.pulse();
  assert.equal(h.calls.length, 0); assert.equal((await h.collector.status()).manualPaused, true);
  h.manual(false); await h.collector.pulse(); assert.equal(h.uploads.length, 1);
  await h.message([blankCard(56)]);
  h.configure({ ...initialCloud, autoBrowse: false }); await h.collector.reconfigure();
  assert.equal((await h.collector.status()).pending, 0);
  assert.equal((await h.collector.status()).active, false);
});

test('untrusted media, invalid IDs, oversized batches and pending floods remain bounded', async () => {
  const h = harness();
  const rejected = await h.message([{ ...blankCard(55), previewUrl: 'https://evil.test/55.jpg' }, blankCard(0), blankCard('9e9'), blankCard('99999999999999999999')]);
  assert.equal(rejected.accepted.length, 0);
  await h.message(Array.from({ length: 20 }, (_, index) => blankCard(index + 1)));
  assert.equal((await h.collector.status()).pending, 20);
  for (let index = 0; index < 20; index++) await h.message(Array.from({ length: 60 }, (_, offset) => blankCard(index * 60 + offset + 100)));
  assert.equal((await h.collector.status()).pending, 600);
});

test('rolling passive admission streams every completed image without a full-group barrier', async () => {
  const h = harness(); await h.message(Array.from({ length: 12 }, (_, index) => blankCard(index + 1)));
  await h.message(Array.from({ length: 12 }, (_, index) => blankCard(index + 13)));
  await h.collector.pulse(); assert.equal(h.uploads.length, 24); assert.equal(h.uploads[0].records.length, 1);
  assert.equal((await h.collector.status(7)).processed, 24);
  await h.collector.pulse(); assert.equal(h.uploads.length, 24);
  assert.equal((await h.collector.status(7)).pending, 0); assert.equal((await h.collector.status(7)).submitted, 24);
});

test('seen IDs expire after one day so later revisits refresh prompts and reactions', async () => {
  const h = harness(); await h.message(); await h.collector.pulse();
  await h.message(); h.advance(11000); await h.collector.pulse(); assert.equal(h.uploads.length, 1);
  h.advance(86400000); await h.message(); await h.collector.pulse(); assert.equal(h.uploads.length, 2);
});

test('content script registration stays exact-host while scrolling uses no cookies, fetch or file API', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  const entry = manifest.content_scripts.find(script => script.js.includes('civitai-browse.js'));
  assert.deepEqual(entry.matches, ['https://civitai.com/*', 'https://civitai.red/*']);
  assert.equal(entry.all_frames, false);
  const content = fs.readFileSync(new URL('../civitai-browse.js', import.meta.url), 'utf8');
  assert.doesNotMatch(content, /\bfetch\(|writeToken|document\.cookie|ISSFeed\.next|downloads\.download/);
  assert.match(content, /IntersectionObserver/); assert.match(content, /MutationObserver/);
});

test('passive queue accepts validated WebP originals as well as JPEG and PNG', async () => {
  const h = harness();
  const accepted = await h.message([{ ...blankCard(55), previewUrl: 'https://image.civitai.com/key/55/width=450/55.webp' }]);
  assert.deepEqual(Array.from(accepted.accepted), ['55']); await h.collector.pulse(); assert.equal(h.uploads.length, 1);
});

test('passive tab B proceeds while a manual feed owns tab A and retains tab A backlog', async () => {
  const manualTabs = new Set();
  const h = harness({}, { manualBusy: tabId => manualTabs.has(tabId) });
  await h.message([blankCard(55)]);
  manualTabs.add(7);
  await h.message([blankCard(56)], { tab: { id: 8, url: pageUrl }, url: pageUrl, frameId: 0 });
  assert.equal((await h.collector.status(7)).manualPaused, true);
  assert.equal((await h.collector.status(8)).manualPaused, false);
  assert.equal((await h.collector.status()).manualPaused, false);
  await h.collector.pulse();
  assert.deepEqual(h.calls.map(call => call.id), ['56', '56']);
  assert.deepEqual(h.uploads.map(upload => upload.records[0].id), ['56']);
  assert.deepEqual(h.storage.civitaiBrowseCollectorV1.pending.map(entry => entry.card.id), ['55']);
  manualTabs.delete(7); h.advance(11000); await h.collector.pulse();
  assert.deepEqual(h.uploads.map(upload => upload.records[0].id), ['56', '55']);
  assert.equal((await h.collector.status()).pending, 0);
});

test('generation change during awaited tab validation cancels stale metadata work', async () => {
  let entered, release, reads = 0;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const h = harness({}, { tab: async id => {
    // The first lookup selects the queued entry. The second validates it.
    if (++reads === 2) { entered(); await gate; }
    return { id, url: pageUrl };
  } });
  await h.message(); const work = h.collector.pulse(); await started;
  h.collector.pauseForManual(7); release(); await work;
  assert.equal(h.calls.length, 0); assert.equal(h.uploads.length, 0);
  assert.equal((await h.collector.status()).pending, 1);
  assert.equal((await h.collector.status()).lastError, '');
  h.advance(11000); await h.collector.pulse(); assert.equal(h.uploads.length, 1);
});

test('queued passive sync rechecks async isCurrent before transferring and retains cancelled entry', async () => {
  let entered, release, transfers = 0;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const h = harness({}, { sync: async (_records, options) => {
    assert.equal(options.required, true); assert.equal(typeof options.isCurrent, 'function');
    entered(); await gate;
    if (!await options.isCurrent()) throw Object.assign(new Error('Collection was paused.'), { status: 409 });
    transfers++; return { alreadyStored: 0 };
  } });
  await h.message(); const work = h.collector.pulse(); await started;
  h.collector.pauseForManual(7); release(); await work;
  assert.equal(transfers, 0); assert.equal((await h.collector.status()).pending, 1);
  assert.equal((await h.collector.status()).suspended, false); assert.equal((await h.collector.status()).lastError, '');
  h.advance(11000); await h.collector.pulse();
  assert.equal(transfers, 1); assert.equal((await h.collector.status()).pending, 0);
});

test('concurrent queue updates persist immutable snapshots in order', async () => {
  const storage = {}, writes = [];
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const h = harness(storage, { save: async (key, value) => {
    writes.push(value);
    if (writes.length === 1) { entered(); await gate; }
    storage[key] = structuredClone(value);
  } });
  const first = h.message([blankCard(55)]); await started;
  const second = h.message([blankCard(56)], { tab: { id: 8, url: pageUrl }, url: pageUrl, frameId: 0 });
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.equal(writes.length, 1, 'second write waits for first storage operation');
  assert.deepEqual(Array.from(writes[0].pending, entry => entry.card.id), ['55'], 'first snapshot cannot gain the later entry');
  release(); await Promise.all([first, second]);
  assert.equal(writes.length, 2);
  assert.deepEqual(storage.civitaiBrowseCollectorV1.pending.map(entry => entry.card.id), ['55', '56']);
});

test('twelve observed images enter the shared image queue together and stream ready records independently', async () => {
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const twelve = new Promise(resolve => { started = resolve; });
  let active = 0, peak = 0, queued = 0;
  const h = harness({}, { processImage: async (task, current) => {
    assert.equal(await current(), true); peak = Math.max(peak, ++active);
    if (++queued === 12) started();
    await gate;
    try { return await task(); } finally { active--; }
  } });
  await h.message(Array.from({ length: 12 }, (_, index) => blankCard(index + 1)));
  const work = h.collector.pulse(); await twelve;
  assert.equal(peak, 12); assert.equal(h.uploads.length, 0);
  assert.equal((await h.collector.status(7)).pending, 12);
  release(); await work;
  assert.equal(h.stored.length, 12); assert.equal(h.uploads.length, 12);
  assert.equal(h.uploads[0].records.length, 1);
  assert.equal((await h.collector.status(7)).processed, 12);
  assert.equal((await h.collector.status(7)).submitted, 12);
});

test('live processed count advances before grouped server submission finishes', async () => {
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const h = harness({}, { sync: async records => { entered(); await gate; return { alreadyStored: records.length }; } });
  await h.message(Array.from({ length: 12 }, (_, index) => blankCard(index + 1)));
  const work = h.collector.pulse(); await started;
  const progress = await h.collector.status(7);
  assert.equal(progress.processed, 12); assert.equal(progress.submitted, 0); assert.equal(progress.pending, 12);
  assert.match(progress.phase, /ready to submit|waiting for image worker/); assert.equal(progress.lastActivityAt, 100000);
  release(); await work;
  const complete = await h.collector.status(7);
  assert.equal(complete.submitted, 12); assert.equal(complete.alreadyStored, 12); assert.equal(complete.pending, 0);
});

test('failed grouped uploads retain prepared metadata across restart without rereading twelve prompts', async () => {
  const storage = {};
  const h = harness(storage, { sync: async () => { throw Object.assign(new Error('server busy'), { status: 503 }); } });
  await h.message(Array.from({ length: 12 }, (_, index) => blankCard(index + 1))); await h.collector.pulse();
  assert.equal(h.calls.length, 24); assert.equal(storage.civitaiBrowseCollectorV1.pending.filter(entry => entry.record).length, 12);
  assert.equal((await h.collector.status(7)).processed, 12); assert.equal((await h.collector.status(7)).submitted, 0);
  const restored = harness(storage); restored.advance(31000); await restored.collector.pulse();
  assert.equal(restored.calls.length, 0); assert.equal(restored.uploads.length, 12);
  assert.equal((await restored.collector.status(7)).processed, 12); assert.equal((await restored.collector.status(7)).submitted, 12);
});

test('pausing one tab mid-batch preserves its cards while another tab uploads its own group', async () => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const h = harness({}, { metadata: async (entry, procedure) => {
    if (entry.tabId === 7) { entered(); await gate; }
    return procedure === 'image.getDetail' ? { tags: [] } : { meta: { prompt: 'landscape' } };
  } });
  await h.message([blankCard(1), blankCard(2)]);
  await h.message([blankCard(3), blankCard(4)], { tab: { id: 8, url: pageUrl }, url: pageUrl, frameId: 0 });
  const work = h.collector.pulse(); await started; await h.collector.pauseTab(7); release(); await work;
  assert.equal((await h.collector.status(7)).tabPaused, true); assert.equal((await h.collector.status(7)).pending, 2);
  assert.equal((await h.collector.status(8)).submitted, 2); assert.equal((await h.collector.status(8)).pending, 0);
  assert.equal(h.uploads.length, 2); assert.deepEqual(h.uploads.flatMap(upload => upload.records.map(record => record.id)), ['3', '4']);
  await h.collector.resumeTab(7); h.advance(1001); await h.collector.pulse();
  assert.equal((await h.collector.status(7)).submitted, 2); assert.equal((await h.collector.status(8)).submitted, 2);
});

test('tab pause persists across worker restart and rejects fresh cards only on that tab', async () => {
  const storage = {}, h = harness(storage);
  await h.message(); await h.collector.pauseTab(7);
  const restored = harness(storage); await restored.collector.pulse();
  assert.equal((await restored.collector.status(7)).active, false); assert.equal(restored.calls.length, 0);
  assert.equal((await restored.message([blankCard(56)])).active, false);
  assert.equal((await restored.message([blankCard(57)], { tab: { id: 8, url: pageUrl }, url: pageUrl })).active, true);
  await restored.collector.pulse(); assert.equal((await restored.collector.status(8)).submitted, 1);
  await restored.collector.resumeTab(7); restored.advance(1001); await restored.collector.pulse();
  assert.equal((await restored.collector.status(7)).submitted, 1);
});

test('manual ownership suppresses duplicate visible-card enqueue but not another tab', async () => {
  const h = harness({}, { manualBusy: tabId => tabId === 7 });
  const result = await h.message();
  assert.equal(result.manualPaused, true); assert.equal(result.accepted.length, 0);
  await h.message([blankCard(56)], { tab: { id: 8, url: pageUrl }, url: pageUrl }); await h.collector.pulse();
  assert.equal((await h.collector.status(7)).pending, 0); assert.equal((await h.collector.status(8)).submitted, 1);
});

test('automatic capacity is released only after the latest queued ownership snapshot commits', async () => {
  const commits = [], releases = [], storage = {}; let hold = false;
  const h = harness(storage, { release: id => releases.push(id), save: (key, value) => {
    if (!hold) { storage[key] = structuredClone(value); return Promise.resolve(); }
    return new Promise(resolve => commits.push(() => { storage[key] = structuredClone(value); resolve(); }));
  } });
  await h.message([blankCard(55)]); hold = true;
  const first = h.collector.acknowledgeManual([{ id: '55' }]);
  for (let index = 0; index < 20; index++) await Promise.resolve();
  h.advance(86400001); const added = h.message([blankCard(55)]);
  for (let index = 0; index < 20; index++) await Promise.resolve();
  const last = h.collector.acknowledgeManual([{ id: '55' }]);
  for (let index = 0; index < 20; index++) await Promise.resolve();
  assert.equal(commits.length, 1); commits.shift()(); await first;
  for (let index = 0; index < 20; index++) await Promise.resolve();
  assert.equal(releases.length, 0); assert.equal(commits.length, 1);
  commits.shift()(); await Promise.all([added, last]);
  assert.equal(commits.length, 0, 'intermediate ownership changes share one pending checkpoint');
  assert.deepEqual(releases, ['55']); assert.equal(storage.civitaiBrowseCollectorV1.pending.length, 0);
});

for (const reason of ['manual handoff', 'Stop', 'navigation', 'already accepted']) {
  test(`withdrawn image work from ${reason} does not create a global error or retry delay`, async () => {
    let release, entered;
    const gate = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    const h = harness({}, { processImage: async (_task, current) => {
      entered(); await gate; assert.equal(await current(), false);
      throw Object.assign(new Error('This image collection was stopped before it started.'), { name: 'AbortError', status: 409, code: 'COLLECTION_CANCELLED' });
    } });
    await h.message(); const work = h.collector.pulse(); await started;
    if (reason === 'manual handoff') h.collector.pauseForManual(7);
    if (reason === 'Stop') await h.collector.pauseTab(7);
    if (reason === 'navigation') { h.tabs.get(7).url = pageUrl + '?view=gallery'; await h.collector.dropTab(7, h.tabs.get(7).url); }
    if (reason === 'already accepted') await h.collector.acknowledgeManual([{ id: '55' }]);
    release(); await work;
    assert.equal((await h.collector.status()).lastError, ''); assert.equal((await h.collector.status()).retryAt, 0);
    assert.equal((await h.collector.status(7)).lastError, ''); assert.equal((await h.collector.status(8)).retryAt, 0);
    assert.equal((await h.collector.status(8)).active, true);
    assert.equal((await h.collector.status()).pending, reason === 'already accepted' ? 0 : 1);
  });
}

test('a late genuine failure from an older tab epoch cannot pause the replacement scan', async () => {
  let entered, release;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const h = harness({}, { metadata: async () => { entered(); await gate; throw Object.assign(new Error('Old request returned503'), { status: 503 }); } });
  await h.message(); const work = h.collector.pulse(); await started;
  h.collector.pauseForManual(7); release(); await work;
  assert.equal((await h.collector.status()).lastError, ''); assert.equal((await h.collector.status()).retryAt, 0);
  assert.equal((await h.collector.status()).pending, 1);
});

test('a current network AbortError remains a real retryable failure', async () => {
  const h = harness({}, { metadata: async () => { throw Object.assign(new Error('The current metadata request timed out'), { name: 'AbortError' }); } });
  await h.message(); await h.collector.pulse();
  assert.equal((await h.collector.status()).lastError, 'The current metadata request timed out');
  assert.ok((await h.collector.status()).retryAt > 100000); assert.equal((await h.collector.status()).pending, 1);
});

test('upgrade clears only the old queue-cancellation text while preserving real errors and cooldowns', async () => {
  const cancellation = 'This image collection was stopped before it started.';
  const storage = { civitaiBrowseCollectorV1: { version: 1, publicMode: true, pending: [], seen: [], pausedTabs: [],
    retryAt: 140000, lastError: cancellation, tabs: { '7': { lastError: cancellation }, '8': { lastError: 'Actual server failure' } } } };
  const h = harness(storage);
  assert.equal((await h.collector.status()).lastError, ''); assert.equal((await h.collector.status(7)).lastError, '');
  assert.equal((await h.collector.status(8)).lastError, 'Actual server failure');
  assert.equal((await h.collector.status()).retryAt, 140000);
  assert.equal(storage.civitaiBrowseCollectorV1.lastError, '');
  assert.equal(storage.civitaiBrowseCollectorV1.tabs['7'].lastError, '');
});


const checkedStorage = (id, exists = true, downloadStatus = exists ? 'ready' : 'unknown') => ({
  imageId: String(id), exists, needsDownload: !exists, downloadStatus, sha256: exists ? 'a'.repeat(64) : ''
});

test('discovery checks all60 passive IDs before metadata or upload workers run', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const checked = [], primed = [], released = [];
  const h = harness({}, {
    primeChecks: async ids => { primed.push(Array.from(ids)); return []; },
    checkQueued: async id => { checked.push(id); await gate; return checkedStorage(id); },
    release: id => { assert.ok(!h.storage.civitaiBrowseCollectorV1.pending.some(entry => entry.card.id === id)); released.push(id); }
  });
  await h.message(Array.from({ length: 60 }, (_, index) => blankCard(index + 1)));
  await h.collector.status();
  assert.equal(checked.length, 60); assert.equal(primed[0].length, 60);
  const pulse = h.collector.pulse(); await h.collector.status();
  assert.equal(h.calls.length, 0); assert.equal(h.uploads.length, 0);
  assert.equal(checked.length, 60, 'metadata preparation joins the discovery check');
  release(); await pulse; const status = await h.collector.status();
  assert.equal(status.pending, 0); assert.equal(status.processed, 60);
  assert.equal(status.synced, 60); assert.equal(status.alreadyStored, 60);
  assert.equal(h.calls.length, 0); assert.equal(h.uploads.length, 0);
  assert.equal(new Set(released).size, 60);
  await h.message([blankCard(1)]); await h.collector.pulse();
  assert.equal((await h.collector.status()).alreadyStored, 60);
});

test('only verified originals skip; missing pending or failed images still acquire metadata', async () => {
  const h = harness({}, {
    checkQueued: async id => checkedStorage(id, Number(id) <= 56, Number(id) === 55 ? 'ready' : Number(id) === 58 ? 'failed' : 'pending'),
    sync: async records => { h.uploads.push({ records }); return { alreadyStored: 0 }; }
  });
  await h.message([55, 56, 57, 58].map(blankCard)); await h.collector.pulse();
  const status = await h.collector.status();
  assert.deepEqual([...new Set(h.calls.map(call => call.id))].sort(), ['57', '58']);
  assert.equal(status.alreadyStored, 2); assert.equal(status.synced, 4);
  assert.equal(status.processed, 4); assert.equal(status.pending, 0);
  assert.equal(h.uploads.length, 2);
});

for (const transition of ['stop', 'manual handoff', 'manual acceptance', 'navigation']) {
  test(`a late stored check cannot count or revive work after ${transition}`, async () => {
    let release; const gate = new Promise(resolve => { release = resolve; });
    const h = harness({}, { checkQueued: async id => { await gate; return checkedStorage(id); } });
    await h.message(); await h.collector.status();
    if (transition === 'stop') await h.collector.pauseTab(7);
    if (transition === 'manual handoff') { h.manual(true); h.collector.pauseForManual(7); }
    if (transition === 'manual acceptance') await h.collector.acknowledgeManual([{ id: '55' }]);
    if (transition === 'navigation') { h.tabs.get(7).url = pageUrl + '?changed=1'; await h.collector.dropTab(7, h.tabs.get(7).url); }
    release(); const status = await h.collector.status();
    assert.equal(status.synced, 0); assert.equal(status.processed, 0); assert.equal(status.alreadyStored, 0);
    assert.equal(status.lastError, ''); assert.equal(h.calls.length, 0); assert.equal(h.uploads.length, 0);
    assert.equal(status.pending, transition === 'manual acceptance' ? 0 : 1);
  });
}

test('restored prepared records are checked before replaying an upload', async () => {
  const storage = { civitaiBrowseCollectorV1: { version: 1, publicMode: true, processed: 1,
    pending: [{ tabId: 7, pageUrl, card: blankCard(55), processed: true,
      record: { id: '55', prompt: 'a neutral landscape', downloadUrl: blankCard(55).previewUrl } }],
    tabs: { 7: { processed: 1, discovered: 1 } }, seen: [] } };
  const primed = [];
  const h = harness(storage, { primeChecks: async ids => { primed.push(Array.from(ids)); return []; },
    checkQueued: async id => checkedStorage(id) });
  await h.collector.pulse(); const status = await h.collector.status();
  assert.deepEqual(primed[0], ['55']); assert.equal(status.pending, 0);
  assert.equal(status.processed, 1); assert.equal(status.synced, 1); assert.equal(status.alreadyStored, 1);
  assert.equal(h.calls.length, 0); assert.equal(h.uploads.length, 0);
});

test('failed early checks retain pending IDs and prevent speculative metadata reads', async () => {
  const h = harness({}, { checkQueued: async () => { throw Object.assign(new Error('Shared check HTTP503'), { status: 503 }); } });
  await h.message([blankCard(55), blankCard(56)]); await h.collector.pulse();
  const status = await h.collector.status();
  assert.equal(status.pending, 2); assert.equal(status.synced, 0);
  assert.match(status.lastError, /Shared check HTTP503/); assert.ok(status.retryAt > 100000);
  assert.equal(h.calls.length, 0); assert.equal(h.uploads.length, 0);
});


test('later pulses do not recheck missing queued IDs or reset in-flight stages', async () => {
  const checks = [], primes = [], stages = []; let releaseUpload;
  const uploadGate = new Promise(resolve => { releaseUpload = resolve; });
  const h = harness({}, {
    primeChecks: async ids => { primes.push(Array.from(ids)); return []; },
    checkQueued: async id => { checks.push(id); return checkedStorage(id, false); },
    stage: (id, _tabId, stage) => stages.push({ id, stage }),
    sync: async () => { await uploadGate; return { alreadyStored: 0 }; }
  });
  await h.message(Array.from({ length: 36 }, (_, index) => blankCard(index + 1)));
  await h.collector.pulse();
  assert.equal(checks.length, 36); assert.equal(primes.length, 1);
  const firstPrepared = new Set(stages.filter(value => value.stage === 'readyUpload').map(value => value.id));
  assert.equal(firstPrepared.size, 36); stages.length = 0;
  h.advance(11000); await h.collector.pulse();
  h.advance(11000); await h.collector.pulse();
  assert.equal(checks.length, 36, 'one missing check per admission even after root cache TTL');
  assert.equal(primes.length, 1);
  assert.equal(stages.some(value => firstPrepared.has(value.id)), false, 'submitted metadata keeps its current stage');
  releaseUpload(); const status = await h.collector.status();
  assert.equal(status.synced, 36); assert.equal(status.pending, 0);
});
