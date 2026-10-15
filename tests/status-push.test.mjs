import test from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './background-harness.mjs';

const extensionSender = { id: 'test-extension', url: 'chrome-extension://test-extension/library.html' };
const sender = (h, id = 7) => ({ id: 'test-extension', url: h.tabs.get(id).url, tab: h.tabs.get(id), frameId: 0 });
const plain = value => JSON.parse(JSON.stringify(value));
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(predicate, message = 'Expected status update') {
  const deadline = Date.now() + 2000;
  while (!predicate() && Date.now() < deadline) await sleep(10);
  assert.ok(predicate(), message);
}
function port(h, t, source = extensionSender, name = 'index-civitai-status-v1') {
  const messages = [], disconnectListeners = new Set(); let disconnected = false;
  const value = { name, sender: source,
    onDisconnect: { addListener: fn => disconnectListeners.add(fn), removeListener: fn => disconnectListeners.delete(fn) },
    postMessage: message => { assert.equal(disconnected, false); messages.push(plain(message)); },
    disconnect: () => { if (disconnected) return; disconnected = true; for (const listener of [...disconnectListeners]) listener(); }
  };
  t.after(() => value.disconnect());
  for (const listener of h.listeners.connect) listener(value);
  return { value, messages, disconnectListeners, get disconnected() { return disconnected; } };
}
function install(h) {
  h.context.nextFeed = async () => ({ items: [], catalogItems: [], cursor: 'private-cursor', done: false });
  h.run('ISSFeed.next = (...args) => nextFeed(...args); PromptCatalogDB.forPromptCollection = async items => ({items,skippedIds:[]}); PromptCatalogDB.upsert = async items => items;');
  h.context.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    return new Response(JSON.stringify(url.endsWith('action=check')
      ? { ok: true, items: body.imageIds.map(imageId => ({ imageId, exists: false, needsDownload: true, downloadStatus: 'unknown', sha256: '' })) }
      : { ok: true, accepted: body.items.length, skipped: 0 }));
  };
}
function start(h, id = 7, type = 'start', source = sender(h, id)) {
  const pageUrl = h.tabs.get(id).url, url = new URL('/api/trpc/image.getInfinite', pageUrl);
  url.searchParams.set('input', JSON.stringify({ json: { modelId: Number(new URL(pageUrl).pathname.split('/').pop()), sort: 'Newest', browsingLevel: 1 } }));
  return h.message({ type, settings: { pageUrl }, feedRequestUrls: [url.href] }, source);
}

test('a stale sender URL cannot hide the active run owned by its tab', async () => {
  const h = await harness(); install(h);
  assert.equal((await start(h)).ok, true);
  h.run('sessions.get(7).catalogSyncedIds = ["99"];');
  const stale = { ...sender(h), url: 'https://civitai.red/models/99?view=gallery' };
  const state = await h.message({ type: 'getState' }, stale);
  assert.equal(state.status.running, true); assert.equal(state.status.catalogSynced, 1);
  assert.equal(state.sourceMismatch, true); assert.equal(state.sourcePageUrl, h.tabs.get(7).url);
  assert.match((await start(h, 7, 'start', stale)).error, /already has an active scan/);
  assert.equal((await h.message({ type: 'getState' }, stale)).status.running, true);
});

test('Start detects actual navigation even without a tab event and preserves the original cursor', async () => {
  const h = await harness(); install(h); await start(h);
  h.run('sessions.get(7).feed.cursor = "saved-original-position";');
  h.tabs.get(7).url = 'https://civitai.red/models/500';
  const result = await start(h);
  assert.equal(result.ok, false); assert.match(result.error, /previous feed is paused/);
  const state = await h.message({ type: 'getState' });
  assert.equal(state.status.running, false); assert.equal(state.sourceMismatch, true);
  assert.equal(state.feed.cursor, 'saved-original-position');
  assert.equal(state.pageUrl, 'https://civitai.red/models/99');
  assert.equal((await start(h, 7, 'resume')).ok, false);
  assert.equal((await start(h)).ok, true);
  assert.equal((await h.message({ type: 'getState' })).pageUrl, 'https://civitai.red/models/500');
});

test('background handshake is hardcoded in every status response and Start triggers work immediately', async () => {
  const h = await harness(); install(h); let reads = 0;
  h.context.nextFeed = async () => { reads++; return { items: [], catalogItems: [], cursor: null, done: false }; };
  for (const type of ['getState', 'getConfig', 'getSourceStatus', 'civitai-auto-status']) {
    const response = await h.message({ type });
    assert.equal(response.backgroundVersion, '2.8.12'); assert.equal(response.statusProtocol, 1);
  }
  assert.equal((await start(h)).ok, true);
  await until(() => reads === 1, 'Start should not wait for an alarm or offscreen heartbeat');
});

test('live initial snapshots are complete, bounded, private, and scoped to the subscribing tab', async t => {
  const h = await harness(); install(h);
  h.tabs.set(8, { id: 8, url: 'https://civitai.red/models/101' });
  await start(h, 7); await start(h, 8);
  h.run('sessions.get(7).catalogSyncedIds = ["99"]; sessions.get(8).catalogSyncedIds = ["101","102"]; sessions.get(8).status.lastError = "Other tab failure";');
  const own = port(h, t, sender(h)), global = port(h, t);
  await until(() => own.messages.length && global.messages.length);
  const message = own.messages.at(-1), aggregate = global.messages.at(-1);
  assert.equal(message.type, 'index-civitai-status'); assert.equal(message.backgroundVersion, '2.8.12'); assert.equal(message.statusProtocol, 1);
  for (const field of ['state', 'browse', 'source', 'config']) assert.equal(typeof message[field], 'object');
  assert.equal(message.state.sessionTabId, 7); assert.equal(message.state.status.catalogSynced, 1); assert.equal(message.state.runs, undefined);
  assert.equal(aggregate.state.activeTabs, 2); assert.equal(aggregate.state.status.catalogSynced, 3);
  assert.equal(message.state.feed.cursor, undefined); assert.equal(aggregate.state.runs[0].feed.cursor, undefined);
  assert.doesNotMatch(JSON.stringify(message), /private-cursor|catalogSyncedIds|"prompt"|"downloadUrl"|Other tab failure/);
  assert.equal(message.config.writeToken, undefined);
});

test('live port pushes manual progress before network completion and then submission and Stop', async t => {
  const h = await harness(); install(h); let release, progress;
  h.context.nextFeed = async (_feed, _request, _queue, callback) => {
    progress = callback; callback({ phase: 'metadata', completed: 0, total: 12 });
    await new Promise(resolve => { release = resolve; });
    return { items: [{ url: 'https://image.civitai.com/key/99/original=true/99.jpg' }],
      catalogItems: [{ id: '99', prompt: 'private prompt', downloadUrl: 'https://image.civitai.com/key/99/original=true/99.jpg' }], cursor: 'next', done: false };
  };
  const subscription = port(h, t, sender(h)); await start(h);
  await until(() => !!release);
  progress({ phase: 'metadata-complete', id: '99', completed: 1, total: 12 });
  await until(() => subscription.messages.some(value => value.state.status.processed === 1));
  const during = subscription.messages.at(-1);
  assert.equal(during.state.status.pending, 11); assert.equal(during.state.status.catalogSynced, 0);
  assert.equal(during.state.status.phase, 'reading prompts'); assert.ok(during.state.status.lastActivityAt > 0);
  release(); await until(() => subscription.messages.some(value => value.state.status.catalogSynced === 1));
  await h.message({ type: 'stop' });
  await until(() => subscription.messages.at(-1).browse.tabPaused);
  assert.equal(subscription.messages.at(-1).state.status.running, false);
  assert.equal(subscription.messages.at(-1).browse.scrollAllowed, false);
  assert.doesNotMatch(JSON.stringify(subscription.messages), /private prompt/);
});

test('automatic queue acceptance and completion notify a tab without polling', async t => {
  const h = await harness(); install(h); let release;
  h.context.autoDetail = async (_entry, procedure) => {
    if (procedure === 'image.getDetail') { await new Promise(resolve => { release = resolve; }); return { id: 55, type: 'image', url: 'https://image.civitai.com/key/55/original=true/55.jpg', stats: { likeCount: 0, heartCount: 0, laughCount: 0, cryCount: 0 } }; }
    return { meta: { prompt: 'private automatic prompt' } };
  };
  h.run('ISSFeed.civitaiMetadata = (_feed, procedure, id) => autoDetail(id, procedure);');
  const subscription = port(h, t, sender(h));
  await h.message({ type: 'civitai-auto-cards', pageUrl: h.tabs.get(7).url,
    cards: [{ id: '55', previewUrl: 'https://image.civitai.com/key/55/width=450/55.jpg' }] });
  await until(() => !!release && subscription.messages.some(value => value.browse.pending === 1));
  release(); await until(() => subscription.messages.some(value => value.browse.synced === 1));
  const status = subscription.messages.at(-1).browse;
  assert.equal(status.processed, 1); assert.equal(status.pending, 0); assert.ok(status.lastActivityAt > 0);
  assert.doesNotMatch(JSON.stringify(subscription.messages), /private automatic prompt/);
});

test('source notifier bursts coalesce and delayed stale snapshots never post out of order', async t => {
  const h = await harness(), subscription = port(h, t);
  await until(() => subscription.messages.length === 1);
  const firstRevision = subscription.messages[0].revision;
  for (let index = 0; index < 30; index++) h.run('indexCivitaiStatusChanged()');
  await until(() => subscription.messages.length === 2);
  assert.equal(subscription.messages[1].revision, firstRevision + 30);
  let release;
  h.context.delayedSource = new Promise(resolve => { release = resolve; });
  h.run('getCivitaiSourceRequestState = () => delayedSource; indexCivitaiStatusChanged();');
  await until(() => h.run('[...statusPorts.values()][0].publishing'));
  h.run('indexCivitaiStatusChanged()');
  release({ authStatus: 0, blockedUntil: 0, queued: 5 });
  await until(() => subscription.messages.length === 3);
  assert.equal(subscription.messages[2].revision, firstRevision + 32);
  assert.equal(subscription.messages[2].source.queued, 5);
  assert.ok(subscription.messages.every((value, index, all) => !index || value.revision > all[index - 1].revision));
});

test('status ports reject untrusted origins, subframes, other extensions, and unexpected names', async t => {
  const h = await harness();
  for (const source of [
    { url: 'https://evil.example', tab: { id: 7, url: 'https://evil.example' }, frameId: 0 },
    { ...sender(h), frameId: 1 }, { ...sender(h), id: 'other-extension' },
    { url: 'chrome-extension://test-extension/offscreen.html' },
    { url: 'chrome-extension://test-extension/library.html?untrusted' }
  ]) assert.equal(port(h, t, source).disconnected, true);
  assert.equal(port(h, t, sender(h), 'unexpected').disconnected, true);
  assert.equal(h.run('statusPorts.size'), 0); assert.equal(h.run('statusPushTimer'), null);
});

test('live subscriptions have a fixed connection bound and disconnect releases their slot', async t => {
  const h = await harness(), subscriptions = [];
  for (let index = 0; index < 64; index++) subscriptions.push(port(h, t));
  assert.equal(h.run('statusPorts.size'), 64);
  assert.equal(port(h, t).disconnected, true);
  subscriptions[0].value.disconnect();
  assert.equal(port(h, t).disconnected, false);
  assert.equal(h.run('statusPorts.size'), 64);
});

test('disconnect cleans subscriptions and prevents an in-flight snapshot from posting', async t => {
  const h = await harness(); let release;
  h.context.delayedSource = new Promise(resolve => { release = resolve; });
  h.run('getCivitaiSourceRequestState = () => delayedSource;');
  const subscription = port(h, t);
  await until(() => h.run('[...statusPorts.values()][0].publishing'));
  subscription.value.disconnect(); release({ authStatus: 0, blockedUntil: 0 });
  await h.flush(); await sleep(130);
  assert.equal(subscription.messages.length, 0); assert.equal(subscription.disconnectListeners.size, 0);
  assert.equal(h.run('statusPorts.size'), 0); assert.equal(h.run('statusPushTimer'), null);
});

test('a subscription closes when its actual tab leaves Civitai and the global subscription stays connected', async t => {
  const h = await harness(), own = port(h, t, sender(h)), global = port(h, t);
  await until(() => own.messages.length && global.messages.length);
  h.tabs.get(7).url = 'https://example.com/'; h.run('indexCivitaiStatusChanged()');
  await until(() => own.disconnected);
  assert.equal(global.disconnected, false); assert.equal(h.run('statusPorts.size'), 1);
});
