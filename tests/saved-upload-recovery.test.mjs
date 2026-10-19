import test from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './background-harness.mjs';

const key = 'aiImageDatasetScraperStateV6';
const pageUrl = 'https://civitai.red/models/99';
const record = id => ({ id: String(id), prompt: 'landscape fixture', downloadUrl: `https://image.civitai.com/key/test/original=true/${id}.jpg` });
function saved(reason = 'source-tab-closed', count = 40) {
  const records = Array.from({ length: count }, (_, i) => record(i + 100));
  return { civitaiPromptCloud: { autoBrowse: false }, [key]: { version: 3, runs: [{
    version: 3, sessionTabId: 7, settings: { serverCopies: true, pageUrl },
    status: { stopped: true, running: false, scanning: false, stopReason: reason,
      lastError: reason === 'resume-required' ? 'Source tab changed after restart. Open the same Civitai page and resume this saved feed.' : 'The source tab closed.' },
    outstandingIds: records.map(r => r.id), preparedRecords: Object.fromEntries(records.map(r => [r.id, r])),
    feed: { site: 'civitai', pageUrl, endpoint: 'image.getInfinite', filters: { modelId: 99 }, cursor: 'keep-this-cursor', pages: 2, done: false }
  }] } };
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  const deadline = Date.now() + 2500;
  while (!predicate() && Date.now() < deadline) await sleep(10);
  assert.ok(predicate(), 'Expected saved upload recovery to progress');
}
function transport(h, { exists = false, failure = 0 } = {}) {
  const calls = [];
  h.context.fetch = async (url, options) => {
    const action = new URL(url).searchParams.get('action'), body = JSON.parse(options.body); calls.push({ action, body });
    if (action === 'check') return new Response(JSON.stringify({ ok: true, items: body.imageIds.map(imageId => ({ imageId, exists, needsDownload: !exists, downloadStatus: exists ? 'ready' : 'unknown', sha256: exists ? 'a'.repeat(64) : '', sourcePageMissing: false })) }));
    if (action === 'images') return failure ? new Response('{}', { status: failure, headers: { 'Retry-After': '75' } })
      : new Response(JSON.stringify({ ok: true, accepted: body.items.length, skipped: 0 }));
    if (action === 'source-reactions') return new Response(JSON.stringify({ ok: true, matched: body.items.length, updated: 0, missing: 0 }));
    throw new Error(`Unexpected action ${action}`);
  };
  h.run('uploadIntervalMs=0; ISSFeed.next=async()=>{throw new Error("Saved uploads must not scan the source")};');
  return calls;
}

test('40 prepared records from a closed tab drain without reopening or scanning any source', async () => {
  const h = await harness(saved(), { tabs: [] }), calls = transport(h);
  assert.equal(h.run('publicRun(sessions.get(7)).status.pending'), 40);
  assert.equal(h.run('pipelineSnapshot().paused'), 0);
  assert.equal(h.run('pipelineSnapshot().recoveringUploads'), 40);
  assert.equal(await h.run('needsOffscreenTicker()'), true);
  h.run('collectionClockPulse()');
  await until(() => h.run('pipelineSnapshot().outstandingTotal') === 0);
  assert.equal(h.storage[key].runs[0].catalogSyncedIds.length, 40);
  assert.equal(h.storage[key].runs[0].feed.cursor, 'keep-this-cursor');
  assert.equal(h.run('sessions.get(7).status.running'), false);
  assert.equal(h.run('publicRun(sessions.get(7)).status.pending'), 0);
  assert.equal(calls.filter(c => c.action === 'images').flatMap(c => c.body.items).length, 40);
  assert.ok(calls.filter(c => c.action === 'images').every(c => c.body.items.every(r => !r.collectionToken)));
  assert.equal(await h.run('needsOffscreenTicker()'), false);
});

test('restart and navigation pauses recover prepared uploads while user and rejection pauses do not', async () => {
  for (const reason of ['resume-required', 'source-tab-changed', 'user', 'feed-error', 'upload-error']) {
    const h = await harness(saved(reason, 1), { tabs: [] }), calls = transport(h);
    const shouldRecover = ['resume-required', 'source-tab-changed'].includes(reason);
    assert.equal(h.run('manualUploadCurrent(sessions.get(7))'), shouldRecover);
    h.run('collectionClockPulse()');
    if (shouldRecover) await until(() => h.run('pipelineSnapshot().outstandingTotal') === 0);
    else { await sleep(40); assert.equal(calls.length, 0); assert.equal(h.run('pipelineSnapshot().paused'), 1); }
  }
});

test('closed-tab recovery skips existing copies and retains no duplicate upload', async () => {
  const h = await harness(saved('source-tab-closed', 1), { tabs: [] }), calls = transport(h, { exists: true });
  h.run('collectionClockPulse()'); await until(() => h.run('pipelineSnapshot().outstandingTotal') === 0);
  assert.equal(h.storage[key].runs[0].catalogStoredSkippedIds.length, 1);
  assert.equal(calls.some(c => c.action === 'images'), false);
});

test('saved uploads retain server cooldowns, prompts and ownership on a rejected batch', async () => {
  const h = await harness(saved('source-tab-closed', 1), { tabs: [] }), calls = transport(h, { failure: 429 });
  h.run('collectionClockPulse()'); await until(() => h.run('sessions.get(7).uploadRetryAt') > Date.now());
  assert.ok(h.run('sessions.get(7).uploadRetryAt') >= Date.now() + 73000);
  assert.equal(h.run('pipelineSnapshot().outstandingTotal'), 1);
  assert.equal(h.storage[key].runs[0].preparedRecords['100'].prompt, 'landscape fixture');
  h.run('collectionClockPulse()'); await sleep(40);
  assert.equal(calls.filter(c => c.action === 'images').length, 1);
});

test('closing or navigating a user-stopped tab cannot revive its prepared uploads', async () => {
  const h = await harness(saved('user', 1)); transport(h);
  await h.run('stopSession(7,"source-tab-changed","This tab changed pages")');
  await h.run('stopSession(7,"source-tab-closed","The source tab closed")');
  assert.equal(h.run('sessions.get(7).status.stopReason'), 'user');
  assert.equal(h.run('manualUploadCurrent(sessions.get(7))'), false);
});

test('Stop all cancels saved upload recovery and preserves its prepared records', async () => {
  const h = await harness(saved('source-tab-closed', 1), { tabs: [] }); transport(h);
  await h.extensionMessage({ type: 'pauseAll' });
  assert.equal(h.run('manualUploadCurrent(sessions.get(7))'), false);
  assert.equal(h.run('pipelineSnapshot().paused'), 1);
  assert.equal(h.storage[key].runs[0].preparedRecords['100'].prompt, 'landscape fixture');
});

test('server authentication failures pause recovery and closing the tab cannot undo that pause', async () => {
  const h = await harness(saved('resume-required', 1), { tabs: [] }), calls = transport(h, { failure: 403 });
  h.run('collectionClockPulse()'); await until(() => h.run('sessions.get(7).status.stopReason') === 'upload-error');
  await h.run('stopSession(7,"source-tab-closed","The source tab closed")');
  assert.equal(h.run('manualUploadCurrent(sessions.get(7))'), false);
  assert.match(h.run('sessions.get(7).status.lastError'), /HTTP 403/);
  h.run('collectionClockPulse()'); await sleep(40);
  assert.equal(calls.filter(c => c.action === 'images').length, 1);
});

test('legacy browser-download records cannot enable detached server uploads during migration', async () => {
  const old = saved('source-tab-closed', 1); old[key].runs[0].settings.serverCopies = false;
  const h = await harness(old, { tabs: [] }), calls = transport(h);
  assert.equal(h.run('manualUploadCurrent(sessions.get(7))'), false);
  h.run('collectionClockPulse()'); await sleep(40); assert.equal(calls.length, 0);
});

test('closing an active tab with an upload in progress commits it without restarting its source', async () => {
  const data = saved('source-tab-closed', 1);
  Object.assign(data[key].runs[0].status, { running: true, scanning: true, stopped: false, stopReason: '', lastError: '' });
  const h = await harness(data), calls = transport(h); let release;
  const fetch = h.context.fetch;
  h.context.fetch = (url, options) => url.endsWith('action=images')
    ? new Promise(resolve => { release = () => resolve(fetch(url, options)); }) : fetch(url, options);
  h.run('pumpManualPrepared(sessions.get(7))'); await until(() => !!release);
  h.tabs.delete(7); await h.run('stopSession(7,"source-tab-closed","The source tab closed")');
  release(); await until(() => h.run('pipelineSnapshot().outstandingTotal') === 0);
  assert.equal(h.storage[key].runs[0].catalogSyncedIds.length, 1);
  assert.equal(h.storage[key].runs[0].feed.cursor, 'keep-this-cursor');
  assert.equal(calls.filter(c => c.action === 'images').length, 1);
});
