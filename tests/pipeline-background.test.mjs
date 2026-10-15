import test from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './background-harness.mjs';

const key = 'aiImageDatasetScraperStateV6';
const pageUrl = 'https://civitai.red/models/99';
const card = id => ({ id: String(id), previewUrl: `https://image.civitai.com/key/${id}/width=450/${id}.jpg` });
const record = id => ({ id: String(id), prompt: 'fixture landscape', downloadUrl: `https://image.civitai.com/key/${id}/original=true/${id}.jpg` });
const sender = (h, id) => ({ url: h.tabs.get(id).url, tab: h.tabs.get(id), frameId: 0 });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, message) {
  const deadline = Date.now() + 2500;
  while (!predicate() && Date.now() < deadline) await sleep(10);
  assert.ok(predicate(), message || 'Expected pipeline transition');
}
function install(h) {
  const calls = [];
  h.run('PromptCatalogDB.forPromptCollection = async items => ({items:items.filter(item=>item?.prompt?.trim()),skippedIds:items.filter(item=>!item?.prompt?.trim()).map(item=>String(item.id))}); PromptCatalogDB.upsert = async items => items;');
  h.context.fetch = async (url, options) => {
    const body = JSON.parse(options.body); calls.push({ url, body, options });
    return new Response(JSON.stringify(url.endsWith('action=check')
      ? { ok: true, items: body.imageIds.map(imageId => ({ imageId, exists: false, needsDownload: true, sha256: '', downloadStatus: 'unknown' })) }
      : { ok: true, accepted: body.items.length, skipped: 0 }));
  };
  return calls;
}
function addRun(h, tabId = 7) {
  h.run(`{ const run = freshState({sessionTabId:${tabId},pageUrl:${JSON.stringify(h.tabs.get(tabId).url)}}); run.status.running=true; run.status.scanning=true; sessions.set(${tabId},run); drivers.set(${tabId},newDriver()); }`);
}

test('one accepted batch coalesces manual ownership and automatic queue persistence', async () => {
  const h = await harness(); install(h); addRun(h); let sessionWrites = 0, automaticWrites = 0;
  const set = h.context.chrome.storage.local.set;
  h.context.chrome.storage.local.set = (data, callback) => {
    if (data[key]) sessionWrites++;
    if (data.civitaiBrowseCollectorV1) automaticWrites++;
    return set(data, callback);
  };
  await h.run(`Promise.all(Array.from({length:60},(_,index)=>acceptManualRecords(sessions.get(7),[{id:String(index+1)}],[{imageId:String(index+1),exists:false}])))`);
  assert.equal(h.run('sessions.get(7).catalogSyncedIds.length'), 60);
  assert.equal(sessionWrites, 1); assert.equal(automaticWrites, 1);
});
function start(h, tabId = 7) {
  const url = new URL('/api/trpc/image.getInfinite', h.tabs.get(tabId).url);
  url.searchParams.set('input', JSON.stringify({ json: { modelId: 99, sort: 'Newest', browsingLevel: 1 } }));
  return h.message({ type: 'start', settings: { pageUrl: h.tabs.get(tabId).url }, feedRequestUrls: [url.href] }, sender(h, tabId));
}

test('one global600-ID capacity bounds all tabs and paused work remains inside the cap', async () => {
  const h = await harness(); h.tabs.set(8, { id: 8, url: 'https://civitai.red/models/101' });
  h.run('autoBrowseCollector.pulse = async () => {};');
  for (let batch = 0; batch < 10; batch++) {
    const tabId = batch % 2 ? 8 : 7;
    const response = await h.message({ type: 'civitai-auto-cards', pageUrl: h.tabs.get(tabId).url,
      cards: Array.from({ length: 60 }, (_, index) => card(1000 + batch * 60 + index)) }, sender(h, tabId));
    assert.equal(response.accepted.length, 60); assert.equal(response.outstandingTotal, (batch + 1) * 60);
  }
  const duplicate = await h.message({ type: 'civitai-auto-cards', pageUrl: h.tabs.get(8).url, cards: [card(1000)] }, sender(h, 8));
  assert.equal(duplicate.accepted.length, 1); assert.equal(duplicate.outstandingTotal, 600);
  for (const tabId of [7, 8]) assert.equal((await h.message({ type: 'civitai-auto-status' }, sender(h, tabId))).scrollAllowed, false);
  await h.message({ type: 'stop' }, sender(h, 7));
  const blocked = await h.message({ type: 'civitai-auto-cards', pageUrl: h.tabs.get(8).url, cards: [card(9999)] }, sender(h, 8));
  assert.equal(blocked.accepted.length, 0); assert.equal(blocked.pipeline.outstandingTotal, 600);
  assert.equal(blocked.pipeline.paused, 300);
  assert.match((await h.message({ type: 'civitai-auto-status' }, sender(h, 8))).phase, /resume paused tabs/);
  await h.run('autoBrowseCollector.acknowledgeManual([{id:"1000"}])');
  assert.equal((await h.message({ type: 'civitai-auto-status' }, sender(h, 8))).scrollAllowed, true);
  const next = await h.message({ type: 'civitai-auto-cards', pageUrl: h.tabs.get(8).url, cards: [card(9999)] }, sender(h, 8));
  assert.equal(next.accepted.length, 1); assert.equal(next.pipeline.outstandingTotal, 600);
});

test('manual and passive ownership of the same image occupy one capacity slot', async () => {
  const h = await harness(); h.run('autoBrowseCollector.pulse = async () => {};');
  await h.message({ type: 'civitai-auto-cards', pageUrl, cards: [card(55)] }); addRun(h);
  await h.run('admitManualImage("55",sessions.get(7),()=>true)');
  const value = h.run('pipelineSnapshot(7)');
  assert.equal(value.outstandingTotal, 1); assert.equal(value.outstanding, 1);
  await h.run('autoBrowseCollector.acknowledgeManual([{id:"55"}])');
  assert.equal(h.run('pipelineSnapshot().outstandingTotal'), 1);
  h.run('releaseManualImage(sessions.get(7),"55")'); await h.persist();
  await h.run('persistState(sessions.get(7))');
  assert.equal(h.run('pipelineSnapshot().outstandingTotal'), 0);
});

test('admission is waiting metadata until an actual image worker starts', async () => {
  const h = await harness(); addRun(h);
  await h.run('admitManualImage("55",sessions.get(7),()=>true)');
  assert.equal(h.run('pipelineSnapshot().waitingMetadata'), 1); assert.equal(h.run('pipelineSnapshot().readingPrompts'), 0);
  h.run('markOutstanding("55","manual",7,"readingPrompts")');
  assert.equal(h.run('pipelineSnapshot().waitingMetadata'), 0); assert.equal(h.run('pipelineSnapshot().readingPrompts'), 1);
});

test('partial ready records submit while another image in the same source page is still reading', async () => {
  const h = await harness(), calls = install(h); let release;
  h.context.nextFeed = async (_feed, _request, _queue, progress) => {
    await progress({ phase: 'metadata', ids: ['1', '2'], total: 2, completed: 0 });
    await progress({ phase: 'metadata-admit', id: '1', total: 2 });
    await progress({ phase: 'metadata-start', id: '1', total: 2 });
    await progress({ phase: 'metadata-complete', id: '1', record: record(1), total: 2, completed: 1 });
    await new Promise(resolve => { release = resolve; });
    await progress({ phase: 'metadata-admit', id: '2', total: 2 });
    await progress({ phase: 'metadata-start', id: '2', total: 2 });
    await progress({ phase: 'metadata-complete', id: '2', record: record(2), total: 2, completed: 2 });
    return { items: [{ url: record(1).downloadUrl }, { url: record(2).downloadUrl }], catalogItems: [record(1), record(2)], cursor: 'next', done: false };
  };
  h.run('ISSFeed.next = (...args) => nextFeed(...args);'); await start(h);
  await until(() => !!release && h.run('sessions.get(7).catalogSyncedIds.length') === 1);
  assert.equal(h.run('drivers.get(7).busy'), true); assert.equal(h.run('sessions.get(7).feed.cursor'), null);
  assert.equal(calls.filter(call => call.url.endsWith('action=images')).length, 1);
  release(); await until(() => h.run('sessions.get(7).feed.cursor') === 'next');
  await until(() => h.run('sessions.get(7).catalogSyncedIds.length') === 2);
  assert.equal(h.run('sessions.get(7).catalogSyncedIds.length'), 2);
  assert.equal(h.run('pipelineSnapshot().outstandingTotal'), 0);
});

test('a failed streamed upload retries independently while the full600 queue holds source admission', async () => {
  const pending = Array.from({ length: 599 }, (_, index) => ({ tabId: 8, pageUrl, card: card(1000 + index) }));
  const h = await harness({ civitaiBrowseCollectorV1: { version: 1, publicMode: true, pending, seen: [], pausedTabs: [8], tabs: {} } });
  install(h); let failed = false, uploads = 0;
  const transport = h.context.fetch;
  h.context.fetch = async (url, options) => {
    if (url.endsWith('action=images')) { uploads++; if (!failed) { failed = true; return new Response('{}', { status: 503 }); } }
    return transport(url, options);
  };
  h.context.nextFeed = async (_feed, _request, _queue, progress) => {
    await progress({ phase: 'metadata', ids: ['1', '2'], total: 2, completed: 0 });
    for (const id of ['1', '2']) {
      await progress({ phase: 'metadata-admit', id, total: 2 });
      await progress({ phase: 'metadata-start', id, total: 2 });
      await progress({ phase: 'metadata-complete', id, record: record(id), total: 2, completed: Number(id) });
    }
    return { items: [1, 2].map(id => ({ url: record(id).downloadUrl })), catalogItems: [record(1), record(2)], cursor: 'next', done: false };
  };
  h.run('ISSFeed.next = (...args) => nextFeed(...args);'); await start(h);
  await until(() => failed && h.run('sessions.get(7).uploadRetryAt') > Date.now());
  assert.equal(h.run('drivers.get(7).busy'), true); assert.equal(h.run('pipelineSnapshot().outstandingTotal'), 600);
  assert.equal(h.run('sessions.get(7).feed.cursor'), null);
  assert.equal(h.run('Object.keys(sessions.get(7).preparedRecords).length'), 1);
  assert.ok((await h.message({ type: 'getState' })).status.retryAt > Date.now());
  h.run('sessions.get(7).uploadRetryAt=0; nextUploadAt=0; collectionClockPulse();');
  await until(() => h.run('sessions.get(7).feed.cursor') === 'next', 'retry must free capacity without waiting for the source page to finish');
  await until(() => h.run('sessions.get(7).catalogSyncedIds.length') === 2, 'durable next-page progress does not wait for final submission');
  assert.equal(h.run('sessions.get(7).catalogSyncedIds.length'), 2); assert.equal(h.run('pipelineSnapshot().outstandingTotal'), 599);
  assert.equal(uploads, 3); assert.equal(h.run('Object.keys(sessions.get(7).preparedRecords).length'), 0);
});

test('storage commits ownership removal before capacity can be reused after a submission', async () => {
  const h = await harness(); install(h); addRun(h);
  await h.run('admitManualImage("1",sessions.get(7),()=>true)');
  let release;
  const set = h.context.chrome.storage.local.set;
  h.context.chrome.storage.local.set = (data, callback) => {
    if (data[key]?.runs[0]?.catalogSyncedIds.includes('1')) { release = () => set(data, callback); return; }
    set(data, callback);
  };
  const accepted = h.run('acceptManualRecords(sessions.get(7),[{id:"1"}],[{imageId:"1",exists:false}])');
  await until(() => !!release);
  assert.equal(h.run('pipelineSnapshot().outstandingTotal'), 1);
  assert.deepEqual(h.storage[key].runs[0].outstandingIds, ['1']);
  release(); await accepted;
  assert.equal(h.run('pipelineSnapshot().outstandingTotal'), 0);
  assert.deepEqual(h.storage[key].runs[0].outstandingIds, []);
});

test('an older removal snapshot cannot release capacity ahead of a queued ownership snapshot', async () => {
  const h = await harness(); addRun(h); await h.run('admitManualImage("1",sessions.get(7),()=>true)');
  const commits = [], set = h.context.chrome.storage.local.set;
  h.context.chrome.storage.local.set = (data, callback) => {
    if (data[key]) commits.push(() => set(data, callback)); else set(data, callback);
  };
  h.run('releaseManualImage(sessions.get(7),"1")'); const first = h.run('persistState(sessions.get(7))');
  h.run('sessions.get(7).outstandingIds=["1"]'); const second = h.run('persistState(sessions.get(7))');
  h.run('releaseManualImage(sessions.get(7),"1")'); const last = h.run('persistState(sessions.get(7))');
  await until(() => commits.length === 1); commits.shift()(); await first;
  assert.equal(h.run('pipelineSnapshot().outstandingTotal'), 1);
  await until(() => commits.length === 1); commits.shift()(); await second;
  assert.deepEqual(h.storage[key].runs[0].outstandingIds, ['1']);
  assert.equal(h.run('pipelineSnapshot().outstandingTotal'), 1);
  await until(() => commits.length === 1); commits.shift()(); await last;
  assert.equal(h.run('pipelineSnapshot().outstandingTotal'), 0);
});

test('restoration excludes already accepted and promptless reservations without dropping real queued work', async () => {
  const h = await harness(); addRun(h);
  h.run('sessions.get(7).status.running=false; sessions.get(7).catalogSyncedIds=["1"]; sessions.get(7).catalogPromptlessSkippedIds=["2"]; sessions.get(7).outstandingIds=["1","2","3"];');
  await h.run('persistState(sessions.get(7))');
  const restored = await harness(h.storage);
  assert.deepEqual(Array.from(restored.run('sessions.get(7).outstandingIds')), ['3']);
  assert.equal(restored.run('pipelineSnapshot().outstandingTotal'), 1);
  assert.equal(restored.run('pipelineSnapshot().paused'), 1);
});

test('upload chunks respect both60 records and the UTF8 request byte budget', async () => {
  const h = await harness(), calls = install(h);
  const records = Array.from({ length: 25 }, (_, index) => ({ ...record(index + 1), prompt: '😀'.repeat(20000) }));
  h.context.bigRecords = records;
  const result = await h.run('syncCloudCatalogItems(bigRecords)');
  assert.equal(result.accepted, 25);
  const posts = calls.filter(call => call.url.endsWith('action=images'));
  assert.ok(posts.length >= 3);
  assert.equal(posts.reduce((sum, call) => sum + call.body.items.length, 0), 25);
  for (const call of posts) { assert.ok(call.body.items.length <= 60); assert.ok(Buffer.byteLength(call.options.body, 'utf8') < 900 * 1024); }
});

test('one oversized prompt is retained by its caller and surfaces a useful upload error', async () => {
  const h = await harness(); const calls = install(h); addRun(h);
  h.context.largeRecord = { ...record(1), prompt: '😀'.repeat(240000) };
  h.run('sessions.get(7).preparedRecords["1"] = largeRecord;');
  await assert.rejects(h.run('ensureManualSubmission(sessions.get(7),largeRecord)'), /metadata larger than the server upload limit.*retained/);
  assert.equal(h.run('sessions.get(7).preparedRecords["1"].prompt.length'), 480000);
  assert.equal(h.run('pipelineSnapshot().outstandingTotal'), 1); assert.equal(calls.length, 0);
});

test('a stopped tab is filtered from a mixed upload after its storage preflight', async () => {
  const h = await harness(); h.tabs.set(8, { id: 8, url: 'https://civitai.red/models/101' }); install(h); addRun(h); addRun(h, 8);
  let release; const posted = [], transport = h.context.fetch;
  h.context.fetch = async (url, options) => {
    const response = await transport(url, options);
    if (url.endsWith('action=check')) await new Promise(resolve => { release = resolve; });
    else posted.push(...JSON.parse(options.body).items.map(item => item.id));
    return response;
  };
  h.context.recordOne = record(1); h.context.recordTwo = record(2);
  h.run('sessions.get(7).preparedRecords["1"]=recordOne; sessions.get(8).preparedRecords["2"]=recordTwo;');
  const first = h.run('ensureManualSubmission(sessions.get(7),recordOne)').catch(error => error);
  const second = h.run('ensureManualSubmission(sessions.get(8),recordTwo)');
  await until(() => !!release); await h.message({ type: 'stop' }, sender(h, 7)); release(); await Promise.all([first, second]);
  assert.deepEqual(posted, ['2']); assert.equal(h.run('sessions.get(7).catalogSyncedIds.length'), 0);
  assert.equal(h.run('sessions.get(8).catalogSyncedIds.length'), 1);
  assert.equal(h.run('pipelineSnapshot().outstandingTotal'), 1); assert.equal(h.run('pipelineSnapshot().paused'), 1);
});

test('actual image-queue cancellation during passive-to-manual handoff leaves collection healthy', async () => {
  const h = await harness(); install(h);
  h.context.fastTimer = callback => queueMicrotask(callback); h.context.queueReleases = [];
  h.run('ISSImageQueue=ISSImageQueue.create({setTimer:fastTimer});');
  const occupying = h.run('Promise.all(Array.from({length:12},()=>ISSImageQueue.run(()=>new Promise(resolve=>queueReleases.push(resolve)))))');
  assert.equal(h.run('ISSImageQueue.status().active'), 12);
  await h.message({ type: 'civitai-auto-cards', pageUrl, cards: [card(55)] });
  await until(() => h.run('ISSImageQueue.status().pending') === 1);
  addRun(h); h.run('autoBrowseCollector.pauseForManual(7)');
  const trigger = h.run('ISSImageQueue.run(async()=>true)');
  await h.run('clockTasks.get("browse")');
  const status = await h.message({ type: 'civitai-auto-status' });
  assert.equal(status.manualPaused, true); assert.equal(status.lastError, ''); assert.equal(status.retryAt, 0);
  assert.equal(status.pending, 1); assert.equal(status.pipeline.outstandingTotal, 1);
  h.context.queueReleases.forEach(resolve => resolve()); await occupying; await trigger;
});
