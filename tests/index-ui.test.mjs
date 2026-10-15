import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const sourceControl = fs.readFileSync(new URL('../source-control.js', import.meta.url), 'utf8');
const downloadStub = { create: () => ({ accept() {}, tick() {}, dispose() {} }) };
const library = fs.readFileSync(new URL('../library.js', import.meta.url), 'utf8');
const panel = fs.readFileSync(new URL('../panel.js', import.meta.url), 'utf8');
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };
class Element {
  constructor() { this.value = ''; this.checked = false; this.disabled = false; this.hidden = false; this.textContent = ''; this.style = {}; this.listeners = {}; this.classes = new Set(); this.classList = { toggle: (key, value) => value ? this.classes.add(key) : this.classes.delete(key) }; }
  addEventListener(event, fn) { this.listeners[event] = fn; }
  setAttribute(name, value) { (this.attributes ??= {})[name] = String(value); }
  async dispatch(event) { if (this.listeners[event]) await this.listeners[event]({ preventDefault() {} }); else if (this['on' + event]) await this['on' + event]({ preventDefault() {} }); }
  remove() {}
}
function transportHarness({ connectFails = false } = {}) {
  const ports = [], timers = new Map(); let timerId = 0, connections = 0, now = Date.now();
  return { ports, timers, connections: () => connections, now: () => now, advance: ms => { now += ms; },
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id; }, clearTimeout(id) { timers.delete(id); },
    nextTimer() { const first = [...timers].sort((a, b) => a[1].delay - b[1].delay)[0]; if (first) { timers.delete(first[0]); first[1].fn(); } },
    connect(options) {
      connections++; assert.equal(options.name, 'index-civitai-status-v1'); if (connectFails) throw new Error('Extension context invalidated');
      const messages = [], disconnects = [];
      const port = { disconnected: false, onMessage: { addListener: fn => messages.push(fn) }, onDisconnect: { addListener: fn => disconnects.push(fn) },
        emit(value) { if (!this.disconnected) messages.forEach(fn => fn(structuredClone(value))); },
        disconnect() { this.disconnected = true; },
        remoteDisconnect() { if (this.disconnected) return; this.disconnected = true; disconnects.forEach(fn => fn()); } };
      ports.push(port); return port;
    }
  };
}
const speedProfile = multiplier => ({ multiplier, sourceConcurrency: 1, sourceStartLimit: 1, metadataConcurrency: Math.round(12 * multiplier), uploadBatchSize: 60, uploadIntervalMs: 3000, sourceIntervalMs: Math.round(1000 / multiplier), outstandingLimit: 600 });
const speedConfig = multiplier => ({ sourceConcurrency: 1, speedMultiplier: multiplier, collectionSpeed: speedProfile(multiplier) });
const pushed = ({ state = { status: {}, activeTabs: 0, runs: [] }, browse = {}, source = {}, config = {}, ...rest } = {}) => ({ type: 'index-civitai-status', backgroundVersion: '2.8.18', statusProtocol: 1, state, browse: { ok: true, enabled: true, ...browse }, source: { ok: true, ...source }, config: { autoBrowse: true, ...speedConfig(1), ...config }, ...rest });
function libraryHarness({ config = {}, failSave = false, failFetch = false, scans = { activeTabs: 0, status: {}, runs: [] }, browse = {}, backgroundVersion = '2.8.18', statusProtocol = 1, connectFails = false, speedHandler } = {}) {
  const elements = new Map(), messages = [], requests = [], intervals = [], intervalDelays = [];
  const transport = transportHarness({ connectFails });
  const get = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const cloud = { ...speedConfig(1), ...config };
  const chrome = { runtime: { lastError: null, connect: transport.connect, sendMessage(payload, callback) {
    const reply = callback; callback = value => reply({ backgroundVersion, statusProtocol, ...value });
    messages.push(payload);
    if (payload.type === 'saveConfig') {
      if (failSave) { callback({ ok: false, error: 'Could not persist preference.' }); return; }
      cloud.autoBrowse = payload.autoBrowse; callback({ ok: true });
    } else if (payload.type === 'setCollectionSpeed') {
      if (speedHandler) { speedHandler(payload, callback, cloud); return; }
      Object.assign(cloud, speedConfig(payload.speedMultiplier)); callback({ ok: true, config: cloud, collectionSpeed: cloud.collectionSpeed });
    } else if (payload.type === 'pauseAll') { cloud.autoBrowse = false; callback({ ok: true }); }
    else if (payload.type === 'getConfig') callback({ ...cloud, ok: true, configured: true, autoBrowse: cloud.autoBrowse !== false });
    else if (payload.type === 'getState') callback(scans);
    else callback({ ok: true, enabled: cloud.autoBrowse !== false, synced: 3, pending: 2, alreadyStored: 1, skippedPromptless: 4, ...browse });
  } } };
  vm.runInNewContext(sourceControl + '\n' + library, { ISSDownloadControl: downloadStub, document: { getElementById: get }, chrome, URL, Date: { now: transport.now }, setTimeout: transport.setTimeout, clearTimeout: transport.clearTimeout, clearInterval() {}, setInterval(fn, delay) { intervals.push(fn); intervalDelays.push(delay); }, fetch: async (url, options) => {
    requests.push({ url, options }); if (failFetch) throw new Error('offline');
    return { ok: true, status: 200, json: async () => ({ ok: true, counts: { total: 5, ready: 4, pending: 1 } }) };
  } });
  return { get, cloud, messages, requests, intervals, intervalDelays, transport };
}
function panelHarness({ configured = true, config = {}, state = { status: {}, feed: {} }, browse = {}, capture = async () => ['https://civitai.red/api/trpc/image.getInfinite?x=1'], source = {}, backgroundVersion = '2.8.18', statusProtocol = 1, connectFails = false, speedHandler } = {}) {
  const elements = new Map(), messages = [], events = {};
  const transport = transportHarness({ connectFails });
  const get = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const root = new Element(); root.attachShadow = () => ({ getElementById: get, innerHTML: '' });
  const cloud = { ...speedConfig(1), ...config };
  const chrome = { runtime: { lastError: null, connect: transport.connect, sendMessage(payload, callback) {
    messages.push(payload); const reply = callback; callback = value => reply({ backgroundVersion, statusProtocol, ...value });
    if (payload.type === 'setCollectionSpeed') {
      if (speedHandler) { speedHandler(payload, callback, cloud); return; }
      Object.assign(cloud, speedConfig(payload.speedMultiplier)); callback({ ok: true, config: cloud, collectionSpeed: cloud.collectionSpeed }); return;
    }
    callback(payload.type === 'getConfig' ? { ...cloud, configured } : payload.type === 'getState' ? state : payload.type === 'civitai-auto-status' ? { ok: true, enabled: true, ...browse } : payload.type === 'getSourceStatus' ? {ok:true, ...source} : { ok: true });
  } } };
  const window = { __ISS_FEED_CAPTURE: { capture, cancel() {} } };
  vm.runInNewContext(sourceControl + '\n' + panel, { ISSDownloadControl: downloadStub, document: { getElementById() { return null; }, createElement() { return root; }, documentElement: { appendChild() {} }, addEventListener(name, fn) { events[name] = fn; }, removeEventListener() {} }, window, AbortController, chrome, Date: { now: transport.now }, location: { href: 'https://civitai.red/models/42', hostname: 'civitai.red' }, performance: { getEntriesByType() { return []; } }, setInterval() {}, clearInterval() {}, setTimeout: transport.setTimeout, clearTimeout: transport.clearTimeout });
  return { get, messages, root, events, transport, window, cloud };
}
test('fresh installation is ready without credentials and pins requests to shared HTTPS endpoint', async () => {
  const h = libraryHarness({ config: { apiBase: 'https://untrusted.example/api.php' } }); await flush();
  assert.equal(h.get('autoBrowse').checked, true); assert.equal(h.get('browseState').textContent, 'On');
  assert.match(h.get('browseStatus').textContent, /Only galleries started with Scan this tab scroll automatically.*inactive tabs/);
  assert.ok(h.requests.every(request => request.url.startsWith('https://search-civitai.xyz/api.php?action=')));
  assert.equal(h.requests.length, 1); assert.ok(h.requests[0].url.endsWith('health'));
  assert.equal(h.requests[0].options.redirect, 'error'); assert.equal(h.requests[0].options.credentials, 'omit');
  assert.equal(h.requests[0].options.headers.Authorization, undefined);
  assert.match(h.get('libraryHealth').textContent, /5 records indexed.*4 image files stored/);
});

test('browsing preference saves only its boolean without a setup request', async () => {
  const h = libraryHarness({ config: { writeToken: 'old-key' } }); await flush();
  h.get('autoBrowse').checked = false; await h.get('browseForm').dispatch('submit'); await flush();
  assert.equal(h.cloud.autoBrowse, false); assert.equal(h.get('browseState').textContent, 'Off');
  const saved = h.messages.find(message => message.type === 'saveConfig');
  assert.deepEqual(Object.keys(saved).sort(), ['autoBrowse', 'type']); assert.equal(saved.autoBrowse, false);
  assert.equal(h.requests.some(request => request.url.includes('writer-status')), false);
  assert.equal(h.requests.some(request => request.options.headers.Authorization), false);
  assert.match(h.get('settingsMessage').textContent, /feed scans keep running/); assert.equal(h.get('saveSettings').disabled, false);
});

test('saving browsing preference works while library health request is unavailable', async () => {
  const h = libraryHarness({ config: { autoBrowse: false }, failFetch: true }); await flush();
  assert.equal(h.get('autoBrowse').checked, false); h.get('autoBrowse').checked = true;
  await h.get('browseForm').dispatch('submit'); await flush();
  assert.equal(h.cloud.autoBrowse, true); assert.equal(h.get('browseState').textContent, 'On');
  assert.match(h.get('settingsMessage').textContent, /Saved/); assert.match(h.get('libraryHealth').textContent, /unavailable/);
});

test('preference save failures are shown and allow retry', async () => {
  const h = libraryHarness({ failSave: true }); await flush();
  h.get('autoBrowse').checked = false; await h.get('browseForm').dispatch('submit');
  assert.equal(h.cloud.autoBrowse, undefined); assert.match(h.get('settingsMessage').textContent, /Could not persist/);
  assert.equal(h.get('settingsMessage').classes.has('error'), true); assert.equal(h.get('saveSettings').disabled, false);
  assert.equal(h.get('autoBrowse').disabled, false);
});

test('activity refresh preserves an unsaved browsing preference', async () => {
  const h = libraryHarness(); await flush(); h.get('autoBrowse').checked = false;
  await h.intervals[0](); assert.equal(h.get('autoBrowse').checked, false);
});

test('Civitai panel starts immediately even with old unconfigured state and never requests credentials', async () => {
  const h = panelHarness({ configured: false }); await flush(); await h.get('start').dispatch('click');
  assert.equal(h.messages.some(message => message.type === 'start'), true); assert.equal(h.get('runState').textContent, 'Collecting visible images');
  await h.get('settings').dispatch('click'); assert.equal(h.messages.at(-1).type, 'openPromptLibrary');
  assert.equal(h.messages.some(message => Object.hasOwn(message, 'writeToken')), false);
  assert.equal(h.messages.some(message => message.type === 'getConfig'), true, 'Read the background-version handshake');
  assert.doesNotMatch(h.get('status').textContent, /key|connect|login/i);
});

test('public UI has no connection form or credential fields', () => {
  const html = fs.readFileSync(new URL('../library.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /contributorKey|connectionForm|type="password"|Disconnect/);
  assert.doesNotMatch(library, /writeToken|Authorization|writer-status|chrome\.storage/);
  assert.doesNotMatch(panel, /contributor key|Contributor connection|Connection &amp; browsing/);
  assert.match(panel, /Browsing &amp; activity/); assert.match(html, /2\.8\.17/);
});

test('panel starts only selected feed and offers resume for saved stopped progress', async () => {
  const h = panelHarness({ state: { canResume: true, status: { stopped: true, catalogSynced: 12, catalogStoredSkipped: 9, catalogPromptlessSkipped: 4 }, feed: { done: false } } }); await flush();
  assert.equal(h.get('resume').hidden, false); assert.equal(h.get('synced').textContent, '12');
  await h.get('resume').dispatch('click'); await flush(); const resume = h.messages.find(message => message.type === 'resume');
  assert.equal(resume.settings.pageUrl, 'https://civitai.red/models/42'); assert.deepEqual(Object.keys(resume.settings), ['pageUrl']);
  await h.get('start').dispatch('click'); await flush(); assert.equal(h.messages.find(message => message.type === 'start').feedRequestUrls.length, 1);
  await h.get('stop').dispatch('click'); await flush();
  assert.ok(h.messages.filter(message => ['start', 'resume', 'stop', 'getState', 'civitai-auto-status'].includes(message.type)).every(message => !Object.hasOwn(message, 'tabId')));
});

test('activity combines browsing and multiple feed tabs without claiming unique image counts', async () => {
  const h = libraryHarness({ scans: { activeTabs: 2, totalTabs: 3, status: { catalogSynced: 20, catalogStoredSkipped: 10, catalogPromptlessSkipped: 7 }, runs: [
    { tabId: 7, pageUrl: 'https://civitai.red/models/42?sort=Newest', status: { running: true, catalogSynced: 12 } },
    { tabId: 8, pageUrl: 'https://civitai.com/images?sort=Most+Reactions', status: { running: true, catalogSynced: 6 } },
    { tabId: 9, pageUrl: 'https://civitai.red/models/43', canResume: true, status: { stopped: true, catalogSynced: 2, lastError: '<img src=x onerror=alert(1)>' } }
  ] } }); await flush();
  assert.equal(h.get('activeTabCount').textContent, '2');
  assert.equal(h.get('syncedCount').textContent, '23'); assert.equal(h.get('storedCount').textContent, '11'); assert.equal(h.get('promptlessCount').textContent, '11');
  assert.equal(h.get('pendingCount').textContent, '2'); assert.equal(h.get('browseState').textContent, 'Feeds active');
  assert.match(h.get('browseStatus').textContent, /2 feed tabs are scanning/); assert.match(h.get('browseStatus').textContent, /inactive tabs/);
  assert.equal(h.get('feedSummary').hidden, false); assert.match(h.get('feedRuns').textContent, /Tab 7 · civitai.red\/models\/42\?sort=Newest/);
  assert.match(h.get('feedRuns').textContent, /Paused · 2 records accepted.*<img/); assert.equal(h.get('feedRuns').innerHTML, undefined);
  assert.equal(h.messages.find(message => message.type === 'getState').tabId, undefined);
});

test('feed activity stays visible when automatic browsing is disabled', async () => {
  const h = libraryHarness({ config: { autoBrowse: false }, scans: { activeTabs: 1, status: { catalogSynced: 8 }, runs: [] } }); await flush();
  assert.equal(h.get('activeTabCount').textContent, '1'); assert.equal(h.get('browseState').textContent, 'Feeds active');
  assert.match(h.get('browseStatus').textContent, /1 feed tab is scanning/); assert.match(h.get('browseStatus').textContent, /Automatic browsing collection is off/);
  assert.equal(h.get('feedSummary').hidden, true);
});

test('panel resume follows authoritative resumability and browsing pause is scoped to this tab', async () => {
  const h = panelHarness({ state: { canResume: false, status: { stopped: true }, feed: null }, browse: { manualPaused: false } }); await flush();
  assert.equal(h.get('resume').hidden, true); assert.doesNotMatch(h.get('browse').textContent, /feed scan active/);
  const active = panelHarness({ state: { canResume: false, status: { running: true, catalogSynced: 4 }, feed: { pages: 2 } }, browse: { manualPaused: true, scrollPageUrl: 'https://civitai.red/models/42' } }); await flush();
  assert.equal(active.get('stop').disabled, false); assert.match(active.get('browse').textContent, /feed scan active on this tab/);
});

test('closing panel keeps its scan running and Escape on the site does not stop a hidden panel', async () => {
  const h = panelHarness({ state: { status: { running: true } } }); await flush();
  await h.get('close').dispatch('click'); h.events.keydown({ key: 'Escape' }); await flush();
  assert.equal(h.root.style.display, 'none'); assert.equal(h.messages.some(message => message.type === 'stop'), false);
  h.root.style.display = 'block'; h.events.keydown({ key: 'Escape', composedPath: () => [h.root] }); await flush();
  assert.equal(h.messages.filter(message => message.type === 'stop').length, 1);
});

test('completed feed is shown as finished and does not offer unavailable resume', async () => {
  const h = panelHarness({ state: { canResume: false, status: { stopped: true }, feed: { done: true, pages: 10 } } }); await flush();
  assert.match(h.get('runState').textContent, /finished/); assert.match(h.get('status').textContent, /reached the end/);
  assert.equal(h.get('resume').hidden, true); assert.equal(h.get('start').disabled, false);
});

test('starting a second panel awaits its own capture even when resource timings are empty', async () => {
  const one = panelHarness();
  let captured = false;
  const secondUrl = 'https://civitai.red/api/trpc/image.getInfinite?input=second';
  const two = panelHarness({capture:async()=>{captured=true;return [secondUrl];}});
  await flush(); await one.get('start').dispatch('click'); await two.get('start').dispatch('click');
  assert.equal(captured,true);
  assert.equal(two.messages.find(message=>message.type==='start').feedRequestUrls[0],secondUrl);
  assert.notEqual(one.messages.find(message=>message.type==='start').feedRequestUrls[0],secondUrl);
});

test('Stop cancels feed discovery and a late capture never starts a scan', async () => {
  let release, signal;
  const h=panelHarness({capture:options=>{signal=options.signal;return new Promise(resolve=>{release=resolve;});}});
  await flush(); const starting=h.get('start').dispatch('click'); await flush();
  assert.equal(h.get('stop').disabled,false);
  await h.get('stop').dispatch('click'); release(['https://civitai.red/api/trpc/image.getInfinite?input=late']); await starting;
  assert.equal(signal.aborted,true); assert.equal(h.messages.some(message=>message.type==='start'),false);
  assert.equal(h.get('start').disabled,false);
});

test('feed detection failure explains a site load problem without stopping other tabs',async()=>{
  const h=panelHarness({capture:async()=>[]}); await flush(); await h.get('start').dispatch('click');
  assert.match(h.get('status').textContent,/has not loaded this tab/);
  assert.equal(h.messages.some(message=>['start','stop','pauseAll'].includes(message.type)),false);
});

test('panel displays a shared source cooldown',async()=>{
  const h=panelHarness({source:{blockedUntil:Date.now()+65000}}); await flush();
  assert.match(h.get('sourceStatus').textContent,/Civitai cooldown: \d+s/);
});
test('panel distinguishes actual source traffic from a catalog error and countdown', async () => {
  const h = panelHarness({ source: { activeCount: 2, maxActive: 4, queued: 17 },
    browse: { catalog: { lastError: 'Shared catalog returned HTTP 503 (check). Image storage is busy.', retryAt: Date.now() + 30000 } } });
  await flush(); const text = h.get('sourceStatus').textContent;
  assert.match(text, /2 \/ 4 requests active.*17 waiting/); assert.match(text, /Server:.*503.*storage is busy.*Retry in \d+s/);
  assert.doesNotMatch(text, /Civitai cooldown/);
});

test('manual Start cannot bootstrap another site request during a shared cooldown',async()=>{
  let captures=0;
  const h=panelHarness({source:{blockedUntil:Date.now()+65000},capture:async()=>{captures++;return [];}});
  await flush();await h.get('start').dispatch('click');
  assert.equal(captures,0);assert.match(h.get('status').textContent,/requested a cooldown/);
  assert.equal(h.messages.some(message=>message.type==='start'),false);
});

test('activity offers one action to stop all collection',async()=>{
  const h=libraryHarness(); await flush(); await h.get('pauseAll').dispatch('click');
  assert.equal(h.messages.filter(message=>message.type==='pauseAll').length,1);
  assert.match(h.get('collectionMessage').textContent,/All collection stopped/);
  assert.equal(h.get('autoBrowse').checked,false); assert.equal(h.get('pauseAll').disabled,false);
});

test('automatic-only panel shows its eight submitted images and twelve queued instead of zero manual totals', async () => {
  const h = panelHarness({ browse: { active: true, synced: 8, pending: 12, pendingTotal: 24, processed: 10, alreadyStored: 1, skippedPromptless: 2, phase: 'reading image metadata', lastActivityAt: Date.now() - 4000, scrollAllowed: true } }); await flush();
  assert.equal(h.get('synced').textContent, '8'); assert.equal(h.get('stored').textContent, '1'); assert.equal(h.get('promptless').textContent, '2');
  assert.match(h.get('activity').textContent, /10 processed.*12 queued on this tab.*reading image metadata.*last activity/);
  assert.match(h.get('browse').textContent, /Visible-image collection: on.*scrolling stays manual.*24 queued across tabs/);
  assert.match(h.get('speedEffective').textContent, /Prompt readers: 12 concurrent.*60 records per batch, 3-second pause/); assert.equal(h.get('stop').disabled, false);
});

test('panel combines automatic and manual counters only for its own tab', async () => {
  const h = panelHarness({ state: { status: { running: true, catalogSynced: 20, catalogStoredSkipped: 3, catalogPromptlessSkipped: 4, processed: 27, pending: 5, phase: 'submitting prompts' } }, browse: { synced: 8, alreadyStored: 1, skippedPromptless: 2, processed: 11, pending: 12, manualPaused: true } }); await flush();
  assert.equal(h.get('synced').textContent, '28'); assert.equal(h.get('stored').textContent, '4'); assert.equal(h.get('promptless').textContent, '6');
  assert.match(h.get('activity').textContent, /38 processed.*17 queued on this tab.*submitting prompts/);
});

test('paused automatic-only tab can resume without starting feed capture or enabling every tab', async () => {
  let captures = 0;
  const h = panelHarness({ browse: { tabPaused: true, synced: 8 }, capture: async () => { captures++; return []; } }); await flush();
  assert.equal(h.get('resume').hidden, false); assert.equal(h.get('stop').disabled, true); assert.match(h.get('runState').textContent, /paused/);
  await h.get('resume').dispatch('click'); assert.equal(captures, 0); assert.equal(h.messages.filter(item => item.type === 'civitai-auto-resume-tab').length, 1);
  assert.equal(h.messages.some(item => ['start', 'saveConfig', 'pauseAll'].includes(item.type)), false);
});

test('cooldown UI explains waiting with a retry countdown and retained progress', async () => {
  const h = panelHarness({ browse: { synced: 8, pending: 12, retryAt: Date.now() + 50000, sourcePaused: true, phase: 'waiting for Civitai cooldown' } }); await flush();
  assert.equal(h.get('synced').textContent, '8'); assert.match(h.get('sourceStatus').textContent, /Collection retry in \d+s/);
  assert.match(h.get('activity').textContent, /12 queued.*waiting for Civitai cooldown/); assert.match(h.get('browse').textContent, /waiting for Civitai/);
});

test('settings distinguish sixty-record uploads from twelve concurrent prompt readers', async () => {
  const h = libraryHarness({ browse: { pending: 2, pendingTotal: 31, processed: 19, phase: 'submitting prompts', lastActivityAt: Date.now() - 2000 } }); await flush();
  assert.equal(h.get('pendingCount').textContent, '31'); assert.match(h.get('activityDetails').textContent, /19 processed.*submitting prompts.*last activity/);
  assert.match(h.get('speedEffective').textContent, /Prompt readers: 12 concurrent.*60 records per batch, 3-second pause/);
  const html = fs.readFileSync(new URL('../library.html', import.meta.url), 'utf8');
  assert.match(html, /Collect images as you browse/); assert.match(html, /Inactive scan tabs work too/); assert.doesNotMatch(html, /does not scroll/);
});

test('Escape on the Civitai viewer never stops automatic collection outside the panel', async () => {
  const h = panelHarness({ browse: { enabled: true, active: true } }); await flush();
  h.events.keydown({ key: 'Escape', composedPath: () => [{ id: 'civitai-image-viewer' }] }); await flush();
  assert.equal(h.messages.some(item => item.type === 'stop'), false);
  h.events.keydown({ key: 'Escape', composedPath: () => [h.get('stop'), h.root] }); await flush();
  assert.equal(h.messages.filter(item => item.type === 'stop').length, 1);
});

test('settings last activity uses recent manual work instead of an older automatic timestamp', async () => {
  const h = libraryHarness({ browse: { lastActivityAt: Date.now() - 300000 }, scans: { activeTabs: 1, status: { lastActivityAt: Date.now(), processed: 12 }, runs: [] } }); await flush();
  assert.match(h.get('activityDetails').textContent, /last activity [01]s ago/);
});

test('settings push updates combined queues immediately without polling or server health requests', async () => {
  const h = libraryHarness(); await flush(); const messages = h.messages.length, requests = h.requests.length;
  h.transport.ports[0].emit(pushed({ state: { activeTabs: 2, status: { pending: 7, processed: 9, catalogSynced: 6 }, runs: [] }, browse: { pending: 4, pendingTotal: 4, synced: 8, processed: 12, phase: 'reading prompts' } }));
  assert.equal(h.get('pendingCount').textContent, '11'); assert.equal(h.get('syncedCount').textContent, '14');
  assert.match(h.get('queueBreakdown').textContent, /4 automatic · 7 feed/); assert.match(h.get('activityDetails').textContent, /21 processed · 14 accepted.*reading prompts/);
  assert.match(h.get('connectionStatus').textContent, /Background 2\.8\.17 · Live/);
  assert.equal(h.messages.length, messages); assert.equal(h.requests.length, requests);
  await h.intervals[0](); assert.equal(h.messages.length, messages, 'A healthy port replaces polling');
});

test('panel push updates owned counters and exposes a still-running source-mismatched feed', async () => {
  const h = panelHarness(); await flush(); const messages = h.messages.length;
  h.transport.ports[0].emit(pushed({ state: { status: { running: true, catalogSynced: 13, pending: 5, processed: 14 }, feed: { pages: 2 }, sourceMismatch: true, sourcePageUrl: 'https://civitai.red/models/42?sort=Newest' }, browse: { synced: 8, pending: 4, manualPaused: true } }));
  assert.equal(h.get('synced').textContent, '21'); assert.match(h.get('queueStatus').textContent, /9 queued.*4 automatic \+ 5 feed/);
  assert.equal(h.get('start').disabled, true); assert.equal(h.get('stop').disabled, false);
  assert.match(h.get('sourceNotice').textContent, /active scan still follows.*models\/42/); assert.match(h.get('connectionStatus').textContent, /Live activity/);
  assert.equal(h.messages.length, messages);
});

test('live preference changes preserve an unsaved checkbox choice', async () => {
  const h = libraryHarness(); await flush(); h.get('autoBrowse').checked = false; await h.get('autoBrowse').dispatch('change');
  h.transport.ports[0].emit(pushed({ config: { autoBrowse: true }, browse: { pendingTotal: 16 } }));
  assert.equal(h.get('autoBrowse').checked, false); assert.equal(h.get('pendingCount').textContent, '16');
});

test('disconnect resumes polling and reconnects the status port', async () => {
  const h = libraryHarness(); await flush(); h.transport.ports[0].emit(pushed({ browse: { pendingTotal: 10 } }));
  const messages = h.messages.length; h.transport.ports[0].remoteDisconnect(); await flush();
  assert.ok(h.messages.length > messages); assert.match(h.get('connectionStatus').textContent, /Polling activity/);
  h.transport.nextTimer(); assert.equal(h.transport.ports.length, 2);
  h.transport.ports[1].emit(pushed({ browse: { pendingTotal: 22 } })); assert.equal(h.get('pendingCount').textContent, '22');
  assert.match(h.get('connectionStatus').textContent, /Live activity/);
});

test('connection errors retry at most five times and keep polling available', async () => {
  const h = libraryHarness({ connectFails: true }); await flush();
  for (let index = 0; index < 8; index++) h.transport.nextTimer();
  assert.equal(h.transport.connections(), 6); assert.equal(h.transport.timers.size, 0);
  await h.intervals[0](); await flush(); assert.match(h.get('connectionStatus').textContent, /Polling activity · live updates unavailable/);
});

test('a silent port times out instead of pretending live status works', async () => {
  const h = panelHarness(); await flush(); h.transport.nextTimer(); await flush();
  assert.equal(h.transport.ports[0].disconnected, true); assert.match(h.get('connectionStatus').textContent, /Polling activity/);
  h.transport.nextTimer(); assert.equal(h.transport.ports.length, 2);
});

test('old or unidentified background workers require reload while preserving reported counts', async () => {
  for (const version of ['2.8.2', '']) {
    const h = panelHarness({ backgroundVersion: version, statusProtocol: 0, browse: { synced: 8 } }); await flush();
    assert.equal(h.get('synced').textContent, '8'); assert.equal(h.get('runState').textContent, 'Extension update needed'); assert.equal(h.get('start').disabled, true);
    assert.match(h.get('connectionStatus').textContent, /Reload Index Civitai.*Extensions page/);
    await h.get('start').dispatch('click'); assert.equal(h.messages.some(item => item.type === 'start'), false);
  }
  const h = libraryHarness({ backgroundVersion: '2.8.2', statusProtocol: 0 }); await flush();
  assert.equal(h.get('browseState').textContent, 'Reload extension'); assert.match(h.get('connectionStatus').textContent, /background 2\.8\.2/);
});

test('untrusted or incomplete status messages cannot replace displayed counters', async () => {
  const h = libraryHarness(); await flush(); const port = h.transport.ports[0], prior = h.get('pendingCount').textContent;
  port.emit({ type: 'window-message', browse: { pendingTotal: 999 } });
  port.emit(pushed({ state: null, browse: { pendingTotal: 999 } }));
  port.emit(pushed({ statusProtocol: 99, browse: { pendingTotal: 999 } }));
  port.emit(pushed({ backgroundVersion: '<img src=x>', browse: { pendingTotal: 999 } }));
  port.emit(pushed({ state: { status: null }, browse: { pendingTotal: 999 } }));
  assert.equal(h.get('pendingCount').textContent, prior); assert.doesNotMatch(h.get('connectionStatus').textContent, /Live activity/);
});

test('panel disposal disconnects its port and cancels reconnection timers', async () => {
  const h = panelHarness(); await flush(); h.window.__ISS_DISPOSE_PANEL();
  assert.equal(h.transport.ports[0].disconnected, true); assert.equal(h.transport.timers.size, 0);
});

test('older status revisions never replace newer live counts', async () => {
  for (const [h, element] of [[libraryHarness(), 'pendingCount'], [panelHarness(), 'synced']]) {
    await flush(); const port = h.transport.ports[0];
    port.emit(pushed({ revision: 5, browse: { pendingTotal: 22, synced: 22 } }));
    port.emit(pushed({ revision: 4, browse: { pendingTotal: 1, synced: 1 } }));
    assert.equal(h.get(element).textContent, '22');
  }
});

test('authoritative pipeline stages update live and are not confused with server image copies', async () => {
  const h = libraryHarness(); await flush(); const requests = h.requests.length;
  const pipeline = { discovered: 1220, waitingMetadata: 300, readingPrompts: 12, readyUpload: 228, uploading: 60, accepted: 620, alreadyStored: 20, outstandingTotal: 600, outstandingLimit: 600 };
  h.transport.ports[0].emit(pushed({ state: { status: {}, pipeline, activeTabs: 3, runs: [] } }));
  assert.equal(h.get('discoveredCount').textContent, '1,220'); assert.equal(h.get('waitingMetadataCount').textContent, '300');
  assert.equal(h.get('readingPromptsCount').textContent, '12'); assert.equal(h.get('readyUploadCount').textContent, '228'); assert.equal(h.get('uploadingCount').textContent, '60');
  assert.equal(h.get('syncedCount').textContent, '620'); assert.equal(h.get('storedCount').textContent, '20'); assert.equal(h.get('pendingCount').textContent, '600 / 600');
  assert.match(h.get('queueBreakdown').textContent, /scrolling is paused/);
  assert.equal(h.get('serverStoredCount').textContent, '4', 'Accepted metadata is not the number of files stored on the server');
  assert.equal(h.requests.length, requests, 'Pipeline pushes do not fetch server health');
});

test('panel shows scoped pipeline stages with the authoritative global capacity', async () => {
  const h = panelHarness(); await flush();
  h.transport.ports[0].emit(pushed({ state: { status: {}, pipeline: { discovered: 90, waitingMetadata: 10, readingPrompts: 12, readyUpload: 20, uploading: 0, accepted: 48, alreadyStored: 3, outstandingTotal: 600, outstandingLimit: 600,
    globalStages: { waitingDuplicateCheck: 150, checkingDuplicates: 20, waitingMetadata: 300, readingPrompts: 30, readyUpload: 80, uploading: 20 }, paused: 400 } } }));
  assert.equal(h.get('synced').textContent, '48'); assert.equal(h.get('stored').textContent, '3');
  assert.match(h.get('pipelineStats').textContent, /90 discovered · 0 waiting for duplicate check · 0 checking duplicates · 10 waiting to read prompts · 12 reading prompts · 20 records ready to send · 0 records being sent/);
  assert.match(h.get('queueStatus').textContent, /600 \/ 600 outstanding across all tabs.*scrolling paused/);
  assert.match(h.get('sharedQueueStatus').textContent, /Shared queue: 500 preparing.*80 ready to send.*20 sending.*400 paused \(included in these counts\)/);
});

test('server image counts refresh every ten seconds independently of live source events', async () => {
  const h = libraryHarness(); await flush(); assert.deepEqual(h.intervalDelays, [2000, 10000]);
  assert.equal(h.get('serverIndexedCount').textContent, '5'); assert.equal(h.get('serverStoredCount').textContent, '4');
  const requests = h.requests.length; await h.intervals[1](); await flush(); assert.equal(h.requests.length, requests + 1);
  assert.match(h.get('serverStatus').textContent, /Shared server totals.*every 10 seconds/);
});

test('local handshake-timeout disconnect explicitly reconnects without a local onDisconnect event', async () => {
  for (const h of [libraryHarness(), panelHarness()]) {
    await flush(); h.transport.nextTimer(); await flush();
    assert.equal(h.transport.ports[0].disconnected, true);
    h.transport.nextTimer(); assert.equal(h.transport.ports.length, 2);
    h.transport.ports[1].emit(pushed()); assert.match(h.get('connectionStatus').textContent, /Live activity updates/);
  }
});

test('full global queue explains how paused work can drain without inventing paused counts', async () => {
  for (const [h, element] of [[libraryHarness(), 'queueBreakdown'], [panelHarness(), 'queueStatus']]) {
    await flush(); const port = h.transport.ports[0];
    for (const paused of [600, 75]) {
      port.emit(pushed({ state: { status: {}, pipeline: { outstandingTotal: 600, outstandingLimit: 600, paused } } }));
      assert.match(h.get(element).textContent, new RegExp(`${paused} images are queued on paused tabs`));
      assert.match(h.get(element).textContent, /Resume a paused tab to drain its queue/);
    }
    for (const pipeline of [{ outstandingTotal: 600 }, { outstandingTotal: 600, paused: 0 }, { outstandingTotal: 599, paused: 75 }]) {
      port.emit(pushed({ state: { status: {}, pipeline } }));
      assert.doesNotMatch(h.get(element).textContent, /Resume a paused tab|images are queued on paused tabs/);
    }
  }
});

test('both speed sliders expose the accessible one-to-five range and live application help', () => {
  for (const source of [fs.readFileSync(new URL('../library.html', import.meta.url), 'utf8'), panel]) {
    assert.match(source, /label id="speedHeading" for="collectionSpeed"/);
    assert.match(source, /id="collectionSpeed" type="range" min="1" max="5" step="0.5"/);
    assert.match(source, /aria-describedby="speedHelp speedEffective"/);
    assert.match(source, /Speed is a target, not guaranteed throughput/);
    assert.match(source, /Server\/CDN image downloads run separately/);
  }
});

test('effective speed limits come from the background profile rather than multiplier arithmetic', async () => {
  const config = { speedMultiplier: 2.5, collectionSpeed: { ...speedProfile(2.5), metadataConcurrency: 17, sourceIntervalMs: 650 } };
  for (const create of [libraryHarness, panelHarness]) {
    const h = create({ config }); await flush();
    assert.equal(h.get('collectionSpeed').value, '2.5'); assert.equal(h.get('speedValue').textContent, '2.5×');
    assert.equal(h.get('collectionSpeed').attributes['aria-valuetext'], '2.5 times normal speed');
    assert.match(h.get('speedEffective').textContent, /Prompt readers: 17 concurrent.*up to 1 Civitai starts per 0.65s, 1 active maximum.*600 shared queue limit.*60 records per batch, 3-second pause/);
  }
});

test('rapid slider input is debounced and applies the latest value without a Save click or scan reset', async () => {
  for (const create of [libraryHarness, panelHarness]) {
    const h = create(); await flush(); const before = h.messages.length;
    for (const value of [1.5, 3, 5]) { h.get('collectionSpeed').value = String(value); await h.get('collectionSpeed').dispatch('input'); }
    assert.equal(h.messages.length, before); assert.equal(h.get('speedValue').textContent, '5×'); assert.match(h.get('speedStatus').textContent, /Applying 5×/);
    h.transport.nextTimer(); await flush();
    assert.deepEqual(h.messages.slice(before).map(item => ({ ...item })), [{ type: 'setCollectionSpeed', speedMultiplier: 5 }]);
    assert.equal(h.get('collectionSpeed').value, '5'); assert.match(h.get('speedStatus').textContent, /Applied 5× across all tabs/);
    assert.match(h.get('speedEffective').textContent, /60 records per batch, 3-second pause/);
  }
});

test('in-flight speed changes serialize and coalesce to the latest request', async () => {
  for (const create of [libraryHarness, panelHarness]) {
    const pending = [], h = create({ speedHandler: (payload, reply) => pending.push({ payload, reply }) }); await flush();
    h.get('collectionSpeed').value = '2'; await h.get('collectionSpeed').dispatch('input'); h.transport.nextTimer(); await flush();
    assert.match(h.get('speedStatus').textContent, /Applying 2×/);
    for (const value of [3.5, 5]) { h.get('collectionSpeed').value = String(value); await h.get('collectionSpeed').dispatch('input'); }
    h.transport.nextTimer(); await flush(); assert.equal(pending.length, 1);
    h.transport.ports[0].emit(pushed({ config: speedConfig(1) })); assert.equal(h.get('collectionSpeed').value, '5');
    pending[0].reply({ ok: true, config: speedConfig(2) }); await flush();
    assert.deepEqual(pending.map(item => item.payload.speedMultiplier), [2, 5]); assert.equal(h.get('collectionSpeed').value, '5');
    pending[1].reply({ ok: true, config: speedConfig(5) }); await flush(); assert.match(h.get('speedStatus').textContent, /Applied 5×/);
  }
});

test('dragging and recently applied speed resist stale snapshots, then accept idle cross-tab updates', async () => {
  for (const create of [libraryHarness, panelHarness]) {
    const h = create(); await flush(); const slider = h.get('collectionSpeed'), port = h.transport.ports[0];
    await slider.dispatch('pointerdown'); slider.value = '2.5'; await slider.dispatch('input');
    port.emit(pushed({ config: speedConfig(4) })); assert.equal(slider.value, '2.5');
    h.transport.nextTimer(); await flush(); await slider.dispatch('change'); assert.equal(slider.value, '2.5');
    port.emit(pushed({ config: speedConfig(1) })); assert.equal(slider.value, '2.5');
    h.transport.advance(1001); port.emit(pushed({ config: speedConfig(4) }));
    assert.equal(slider.value, '4'); assert.equal(h.get('speedValue').textContent, '4×');
  }
});

test('speed apply failures preserve the requested target and offer a working retry', async () => {
  for (const create of [libraryHarness, panelHarness]) {
    let attempts = 0;
    const h = create({ speedHandler: (payload, reply) => reply(++attempts === 1 ? { ok: false, error: 'Storage unavailable.' } : { ok: true, config: speedConfig(payload.speedMultiplier) }) }); await flush();
    h.get('collectionSpeed').value = '3'; await h.get('collectionSpeed').dispatch('input'); h.transport.nextTimer(); await flush();
    assert.equal(h.get('collectionSpeed').value, '3'); assert.match(h.get('speedStatus').textContent, /Speed was not changed: Storage unavailable/);
    assert.equal(h.get('speedRetry').hidden, false); assert.equal(h.get('speedStatus').classes.has('error'), true);
    h.transport.ports[0].emit(pushed()); assert.equal(h.get('collectionSpeed').value, '3');
    await h.get('speedRetry').dispatch('click'); h.transport.nextTimer(); await flush();
    assert.equal(attempts, 2); assert.match(h.get('speedStatus').textContent, /Applied 3×/); assert.equal(h.get('speedRetry').hidden, true);
  }
});

test('an earlier failed apply does not hide a newer queued speed request', async () => {
  for (const create of [libraryHarness, panelHarness]) {
    const pending = [], h = create({ speedHandler: (payload, reply) => pending.push({ payload, reply }) }); await flush();
    h.get('collectionSpeed').value = '2'; await h.get('collectionSpeed').dispatch('input'); h.transport.nextTimer(); await flush();
    h.get('collectionSpeed').value = '4'; await h.get('collectionSpeed').dispatch('input'); h.transport.nextTimer(); await flush();
    pending[0].reply({ ok: false, error: 'Previous change failed.' }); await flush();
    assert.equal(pending[1].payload.speedMultiplier, 4); assert.equal(h.get('speedRetry').hidden, true); assert.match(h.get('speedStatus').textContent, /Applying 4×/);
    pending[1].reply({ ok: true, config: speedConfig(4) }); await flush(); assert.match(h.get('speedStatus').textContent, /Applied 4×/);
  }
});

test('normal-speed reset applies one while browsing preference saves preserve the speed', async () => {
  for (const create of [libraryHarness, panelHarness]) {
    const h = create({ config: speedConfig(5) }); await flush(); await h.get('speedReset').dispatch('click'); h.transport.nextTimer(); await flush();
    assert.equal(h.cloud.speedMultiplier, 1); assert.equal(h.get('collectionSpeed').value, '1');
  }
  const h = libraryHarness({ config: speedConfig(3.5) }); await flush(); h.get('autoBrowse').checked = false;
  await h.get('browseForm').dispatch('submit'); await flush();
  assert.equal(h.cloud.speedMultiplier, 3.5); assert.equal(h.get('collectionSpeed').value, '3.5');
  assert.deepEqual(Object.keys(h.messages.find(item => item.type === 'saveConfig')).sort(), ['autoBrowse', 'type']);
});

test('old background workers cannot receive speed changes and disposal cancels a pending apply', async () => {
  for (const create of [libraryHarness, panelHarness]) {
    const h = create({ backgroundVersion: '2.8.5' }); await flush(); assert.equal(h.get('collectionSpeed').disabled, true);
    h.get('collectionSpeed').value = '5'; await h.get('collectionSpeed').dispatch('input');
    assert.equal(h.messages.some(item => item.type === 'setCollectionSpeed'), false);
  }
  const h = panelHarness(); await flush(); h.get('collectionSpeed').value = '5'; await h.get('collectionSpeed').dispatch('input');
  h.window.__ISS_DISPOSE_PANEL(); h.transport.nextTimer(); await flush();
  assert.equal(h.messages.some(item => item.type === 'setCollectionSpeed'), false);
});

test('duplicate checks, prompt readers and active record submissions remain separate live stages', async () => {
  const pipeline = { discovered: 1200, waitingDuplicateCheck: 270, checkingDuplicates: 120, waitingMetadata: 120, readingPrompts: 12, readyUpload: 18, uploading: 60, accepted: 600, alreadyStored: 40, outstandingTotal: 600, outstandingLimit: 600 };
  pipeline.globalStages = { waitingDuplicateCheck: 270, checkingDuplicates: 120, waitingMetadata: 120, readingPrompts: 12, readyUpload: 18, uploading: 60 };
  const h = libraryHarness(); await flush();
  h.transport.ports[0].emit(pushed({ state: { status: {}, pipeline } }));
  for (const [id, value] of [['waitingDuplicateCheckCount', '270'], ['checkingDuplicatesCount', '120'], ['waitingMetadataCount', '120'], ['readingPromptsCount', '12'], ['readyUploadCount', '18'], ['uploadingCount', '60']]) assert.equal(h.get(id).textContent, value);
  assert.match(h.get('queueBreakdown').textContent, /270 waiting for duplicate check · 120 checking duplicates · 120 waiting to read prompts · 12 reading prompts · 18 records ready to send · 60 records being sent/);
  assert.match(h.get('sharedQueueStatus').textContent, /Shared queue: 522 preparing.*18 ready to send.*60 sending.*0 paused \(included in these counts\)/);
  const p = panelHarness(); await flush(); p.transport.ports[0].emit(pushed({ state: { status: {}, pipeline } }));
  assert.match(p.get('pipelineStats').textContent, /270 waiting for duplicate check · 120 checking duplicates.*12 reading prompts.*60 records being sent/);
  h.transport.ports[0].emit(pushed({ state: { status: {}, pipeline: { ...pipeline, checkingDuplicates: 0, readyUpload: 78, uploading: 0 } } }));
  assert.equal(h.get('checkingDuplicatesCount').textContent, '0'); assert.equal(h.get('readyUploadCount').textContent, '78'); assert.equal(h.get('uploadingCount').textContent, '0');
});

test('all slider settings retain sixty-record batches and the three-second pause', async () => {
  for (const create of [libraryHarness, panelHarness]) {
    const h = create(); await flush();
    for (const multiplier of [1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5]) {
      h.transport.ports[0].emit(pushed({ config: speedConfig(multiplier) }));
      assert.equal(h.get('collectionSpeed').value, String(multiplier));
      assert.match(h.get('speedEffective').textContent, new RegExp(`Prompt readers: ${12 * multiplier} concurrent`));
      assert.match(h.get('speedEffective').textContent, /up to 60 records per batch, 3-second pause\. Smaller batches are sent when fewer records are ready/);
    }
  }
});

test('server file counts remain independent from prompt submissions and expose no invented active downloads', async () => {
  const h = libraryHarness(); await flush();
  h.transport.ports[0].emit(pushed({ state: { status: {}, pipeline: { accepted: 2500, uploading: 60, readingPrompts: 12 } } }));
  assert.equal(h.get('syncedCount').textContent, '2,500'); assert.equal(h.get('serverStoredCount').textContent, '4'); assert.equal(h.get('serverPendingCount').textContent, '1');
  assert.match(h.get('serverStatus').textContent, /server worker downloads image files.*separately from prompt reading/);
  const html = fs.readFileSync(new URL('../library.html', import.meta.url), 'utf8');
  assert.match(html, /Checking duplicates on server/); assert.match(html, /Sending prompt records/);
  assert.match(html, /Image files stored/); assert.match(html, /Image files still pending/); assert.doesNotMatch(html, /<dt>Downloading now/);
});
