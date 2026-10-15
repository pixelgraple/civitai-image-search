// Index Civitai sends prompt metadata and source URLs to the public shared catalog.
// The server owns image transfers. This extension has no file download API.
importScripts('collection-speed.js', 'catalog-check-queue.js', 'source-reactions-queue.js', 'reaction-page-queue.js', 'vendor/devalue.js', 'background-feed.js', 'tab-feed-request.js', 'civitai-image-queue.js', 'catalog-db.js', 'civitai-auto-background.js');

const STATE_KEY = 'aiImageDatasetScraperStateV6'; // Retain existing cursors and counts.
const CONFIG_KEY = 'civitaiPromptCloud';
const API_URL = 'https://search-civitai.xyz/api.php';
const BACKGROUND_VERSION = '2.8.10', STATUS_PROTOCOL = 1;
const versionStatus = value => ({ ...value, backgroundVersion: BACKGROUND_VERSION, statusProtocol: STATUS_PROTOCOL });
const OFFSCREEN_PATH = 'offscreen.html';
const RUN_VERSION = 3;
const sessions = new Map(), drivers = new Map(), commandEpochs = new Map();
const MAX_ACTIVE_FEEDS = 3;
let uploadQueue = Promise.resolve(), nextUploadAt = 0, uploadIntervalMs = 3000;
const OUTSTANDING_LIMIT = 600;
let lastUploadFinishedAt = 0, uploadCooldownUntil = 0, uploadFlushQueuedAt = 0;
const catalogStatus = { lastError: '', lastStatus: 0, retryAt: 0, action: '' };
const uploadWaiters = new Set();
let configWrites = Promise.resolve();
const outstandingImages = new Map(), capacityWaiters = new Set(), preparedUploads = new Map();
const manualSubmissionTasks = new WeakMap();
const manualAcceptanceBatches = new WeakMap();
let uploadFlushTimer = null, uploadFlushing = false;
let nextAutoTabPulseAt = 0, autoTabPulseBusy = false;
const clockTasks = new Map();
const statusPorts = new Map();
let statusRevision = 0, statusPushTimer = null, immediateClockTimer = null;
const storageAccessReady = chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
const catalogChecks = ISSCatalogChecks.create({ post: imageIds => postCatalog('check', { imageIds, allowPartial: true }),
  changed: notifyStatusChanged, cooldownUntil: () => uploadCooldownUntil,
  setTimer: (callback, delay) => setTimeout(callback, delay), clearTimer: timer => clearTimeout(timer) });
const checkQueuedCatalogImage = (id, isCurrent) => catalogChecks.check(id, isCurrent);
const primeCatalogChecks = (ids, isCurrent) => catalogChecks.prime(ids, isCurrent);
const sourceReactionUpdates = ISSSourceReactions.create({
  post: items => postCatalog('source-reactions', { items }),
  load: () => readStorage('civitaiSourceReactionQueueV1'),
  save: value => writeStorage('civitaiSourceReactionQueueV1', value),
  cooldownUntil: () => uploadCooldownUntil, changed: notifyStatusChanged,
  error: error => addDebug('source-reactions', String(error?.message || error))
});
const observeSourceReactions = (id, reactions) => sourceReactionUpdates.observe(id, reactions).catch(error => addDebug('source-reactions', error.message));
const reactionPages = ISSReactionPages.create({
  load: () => readStorage('civitaiReactionPagesV1'), save: value => writeStorage('civitaiReactionPagesV1', value),
  observe: (id, reactions) => sourceReactionUpdates.observe(id, reactions, { retainMissing: true }), changed: notifyStatusChanged,
  report: error => addDebug('reaction-page', String(error?.message || error)),
  read: async item => {
    const config = await readCloudCatalogConfig();
    if (!config.autoBrowse && !activeRuns().length) throw Object.assign(new Error('Reaction enrichment is paused with collection.'), { status: 409 });
    const origin = new URL(item.pageUrl).origin;
    let tab = await getTab(item.tabId);
    const eligible = tab => ISSBrowseCollector.page(tab?.url)?.origin === origin &&
      (!autoBrowseCollector.isPaused(tab.id) || sessions.get(tab.id)?.status.running);
    if (!eligible(tab)) tab = (await queryCivitaiTabs()).find(eligible);
    if (!tab) throw Object.assign(new Error('Reaction enrichment is waiting for an available Civitai tab.'), { status: 409 });
    const current = async () => eligible(await getTab(tab.id)) && ((await readCloudCatalogConfig()).autoBrowse || activeRuns().length > 0);
    return ISSFeed.civitaiPageReactions({ pageUrl: item.pageUrl }, item.id,
      url => requestCivitaiFeed(tab.id, url, tab.url, current));
  }
});
const deferReactionPage = (id, tabId, pageUrl) => reactionPages.enqueue({ id: String(id), tabId, pageUrl });
const discardOversizeReactions = id => Promise.all([reactionPages.discard(id), sourceReactionUpdates.discard(id)]);
const activeRuns = () => [...sessions.values()].filter(run => run.status.running);
const epochFor = id => commandEpochs.get(id) || 0;
const advanceEpoch = id => { const epoch = epochFor(id) + 1; commandEpochs.set(id, epoch); return epoch; };
function newDriver() { return { enabled: false, busy: false, phase: 'idle', nextPulseAt: 0 }; }
function matchingRun(tabId, pageUrl) {
  const owned = sessions.get(tabId);
  if (owned && (!pageUrl || owned.settings.pageUrl === pageUrl || owned.status.running)) return owned;
  const recoverable = pageUrl ? [...sessions.values()].find(run => run.orphaned && !run.status.running && run.settings.pageUrl === pageUrl &&
    run.feed && (!run.feed.done || Object.keys(run.preparedRecords || {}).length > 0)) : undefined;
  return recoverable || owned;
}
let debugLogEntries = [], persistChain = Promise.resolve(), offscreenCreating = null;

function readStorage(key) {
  return storageAccessReady.then(() => new Promise((resolve, reject) => chrome.storage.local.get(key, value => {
    const error = chrome.runtime.lastError;
    error ? reject(new Error(error.message)) : resolve(value?.[key]);
  })));
}
function writeStorage(key, value) {
  return new Promise((resolve, reject) => chrome.storage.local.set({ [key]: value }, () => {
    const error = chrome.runtime.lastError;
    error ? reject(new Error(error.message)) : resolve();
  }));
}
function getTab(tabId) {
  return new Promise(resolve => chrome.tabs.get(tabId, tab => {
    const error = chrome.runtime.lastError; resolve(error ? null : tab);
  }));
}
function freshState(settings = {}) {
  return { version: RUN_VERSION, queue: [], catalogIds: [], catalogSyncedIds: [], catalogProcessedIds: [],
    catalogDiscoveredIds: [], outstandingIds: [], preparedRecords: {},
    catalogStoredSkippedIds: [], catalogPromptlessSkippedIds: [], catalogOversizeSkippedIds: [], feed: settings.feed || null,
    sessionTabId: Number.isInteger(settings.sessionTabId) ? settings.sessionTabId : null,
    settings: { siteMode: 'civitai', serverCopies: true, backgroundMode: true,
      autoScroll: true, pageUrl: String(settings.pageUrl || '') },
    status: { found: 0, catalogIndexed: 0, catalogSynced: 0, catalogStoredSkipped: 0,
      catalogPromptlessSkipped: 0, catalogOversizeSkipped: 0, downloaded: 0, downloadedBytes: 0,
      processed: 0, submitted: 0, pending: 0, phase: 'idle', lastActivityAt: 0, retryAt: 0,
      running: false, scanning: false, stopped: false, stopReason: '', lastError: '' } };
}
function recalcCounts(run) {
  Object.assign(run.status, { found: run.catalogIds.length, catalogIndexed: run.catalogIds.length,
    catalogSynced: run.catalogSyncedIds.length, catalogStoredSkipped: run.catalogStoredSkippedIds.length,
    catalogPromptlessSkipped: run.catalogPromptlessSkippedIds.length, catalogOversizeSkipped: run.catalogOversizeSkippedIds.length, downloaded: 0, downloadedBytes: 0,
    processed: (run.catalogProcessedIds || run.catalogIds).length, submitted: run.catalogSyncedIds.length,
    retryAt: Math.max(run.feed?.retryAt > Date.now() ? run.feed.retryAt : 0,
      run.uploadRetryAt > Date.now() ? run.uploadRetryAt : 0) });
}
function publicRun(run = freshState()) {
  recalcCounts(run); const driver = drivers.get(run.sessionTabId) || newDriver();
  return structuredClone({ tabId: run.sessionTabId, pageUrl: run.settings.pageUrl,
    settings: run.settings, status: run.status, queue: [],
    feed: run.feed ? { pages: run.feed.pages, cursor: run.feed.cursor, done: !!run.feed.done } : null,
    sessionTabId: run.sessionTabId, driver: { enabled: driver.enabled, busy: driver.busy, phase: driver.phase, batchNumber: run.feed?.pages || 0 },
    canResume: !!run.feed && (!run.feed.done || Object.keys(run.preparedRecords || {}).length > 0) && !run.status.running });
}
function getPublicState(tabId, pageUrl) {
  if (Number.isInteger(tabId)) {
    const run = matchingRun(tabId, pageUrl), value = publicRun(run);
    return versionStatus({ ...value, pipeline: pipelineSnapshot(tabId), sourcePageUrl: run?.settings.pageUrl || '',
      sourceMismatch: !!run?.settings.pageUrl && !!pageUrl && run.settings.pageUrl !== pageUrl });
  }
  const runs = [...sessions.values()].map(publicRun), status = freshState().status;
  for (const run of runs) for (const key of ['found','catalogIndexed','catalogSynced','catalogStoredSkipped','catalogPromptlessSkipped','catalogOversizeSkipped','processed','submitted','pending']) status[key] += run.status[key] || 0;
  status.lastActivityAt = Math.max(0, ...runs.map(run => run.status.lastActivityAt || 0));
  status.running = status.scanning = activeRuns().length > 0;
  return versionStatus({ ok: true, activeTabs: activeRuns().length, totalTabs: runs.length, runs, status, pipeline: pipelineSnapshot() });
}
function ownerFor(kind, tabId) { return `${kind}:${tabId}`; }
function reserveOutstanding(id, kind, tabId, stage = 'waitingDuplicateCheck', restoring = false) {
  id = String(id); let entry = outstandingImages.get(id);
  if (!entry && !restoring && outstandingImages.size >= OUTSTANDING_LIMIT) return false;
  if (!entry) { entry = { owners: new Map() }; outstandingImages.set(id, entry); }
  entry.owners.set(ownerFor(kind, tabId), { kind, tabId, stage }); notifyStatusChanged(); return true;
}
function markOutstanding(id, kind, tabId, stage) {
  const owner = outstandingImages.get(String(id))?.owners.get(ownerFor(kind, tabId));
  if (owner) { owner.stage = stage; notifyStatusChanged(); }
}
function releaseOutstanding(id, kind, tabId) {
  const entry = outstandingImages.get(String(id)); if (!entry) return;
  if (kind) entry.owners.delete(ownerFor(kind, tabId)); else entry.owners.clear();
  if (!entry.owners.size) outstandingImages.delete(String(id));
  notifyStatusChanged(); for (const resolve of [...capacityWaiters]) resolve();
}
async function admitManualImage(id, run, isCurrent) {
  id = String(id);
  if (run.catalogSyncedIds.includes(id) || run.catalogPromptlessSkippedIds.includes(id) || run.catalogOversizeSkippedIds.includes(id)) return;
  while (isCurrent()) {
    if (reserveOutstanding(id, 'manual', run.sessionTabId, 'waitingMetadata')) {
      run.outstandingIds = [...new Set([...run.outstandingIds, String(id)])];
      run.catalogDiscoveredIds = [...new Set([...run.catalogDiscoveredIds, String(id)])];
      await persistState(run); return;
    }
    run.status.phase = pipelineSnapshot().paused ? 'shared queue full; resume paused tabs' : 'waiting for shared capacity'; notifyStatusChanged();
    await new Promise(resolve => {
      let timer;
      const wake = () => { clearTimeout(timer); capacityWaiters.delete(wake); resolve(); };
      capacityWaiters.add(wake); timer = setTimeout(wake, 1000);
      startClockTask('browse', () => autoBrowseCollector.pulse());
    });
  }
  throw Object.assign(new Error('Collection was paused.'), { status: 409 });
}
const manualCurrent = run => sessions.get(run.sessionTabId) === run && run.status.running && !run.status.stopped;
function releaseManualImage(run, id) {
  id = String(id); run.outstandingIds = run.outstandingIds.filter(value => value !== id);
  // Capacity is released by persistState only after durable ownership removal.
}
function acceptManualRecords(run, batch, storageItems) {
  let group = manualAcceptanceBatches.get(run);
  if (!group) {
    group = { records: [], storage: [] };
    group.work = Promise.resolve().then(async () => {
      if (manualAcceptanceBatches.get(run) === group) manualAcceptanceBatches.delete(run);
      await acceptManualRecordsNow(run, group.records, group.storage);
    });
    manualAcceptanceBatches.set(run, group);
  }
  group.records.push(...batch); group.storage.push(...storageItems); return group.work;
}
async function acceptManualRecordsNow(run, batch, storageItems) {
  if (!manualCurrent(run)) return;
  const oversized = new Set(storageItems.filter(item => item.downloadStatus === 'skipped' && item.skipReason === 'oversize').map(item => item.imageId));
  await Promise.all([...oversized].map(discardOversizeReactions));
  run.catalogOversizeSkippedIds = [...new Set([...run.catalogOversizeSkippedIds, ...oversized])];
  run.catalogSyncedIds = [...new Set([...run.catalogSyncedIds, ...batch.filter(item => !oversized.has(String(item.id))).map(item => String(item.id))])];
  run.catalogStoredSkippedIds = [...new Set([...run.catalogStoredSkippedIds, ...storageItems.filter(item => item.exists && !oversized.has(item.imageId)).map(item => item.imageId)])];
  for (const item of batch) { delete run.preparedRecords[String(item.id)]; releaseManualImage(run, item.id); }
  run.uploadRetryAt = 0; run.uploadFailures = 0; run.status.lastError = ''; run.status.lastActivityAt = Date.now();
  await autoBrowseCollector.acknowledgeManual(batch); await persistState(run);
}
function ensureManualSubmission(run, record) {
  let tasks = manualSubmissionTasks.get(run);
  if (!tasks) { tasks = new Map(); manualSubmissionTasks.set(run, tasks); }
  const id = String(record.id);
  if (tasks.has(id)) return tasks.get(id);
  if (run.catalogSyncedIds.includes(id) || run.catalogOversizeSkippedIds.includes(id)) { delete run.preparedRecords[id]; releaseManualImage(run, id); return persistState(run); }
  if (run.uploadRetryAt > Date.now()) return Promise.reject(Object.assign(new Error(run.status.lastError || 'Waiting to retry the server upload.'),
    { status: 503, retryAfterMs: run.uploadRetryAt - Date.now() }));
  const current = () => manualCurrent(run);
  const work = (async () => {
    await admitManualImage(id, run, current); if (!current()) throw Object.assign(new Error('Collection was paused.'), { status: 409 });
    markOutstanding(id, 'manual', run.sessionTabId, 'readyUpload');
    return syncCloudCatalogItems([record], { isCurrent: current, onAccepted: (batch, stored) => acceptManualRecords(run, batch, stored) });
  })().catch(async error => {
    if (current() && error.status !== 409) {
      if (!(run.uploadRetryAt > Date.now())) run.uploadFailures = (run.uploadFailures || 0) + 1;
      run.uploadRetryAt = Date.now() + Math.min(300000, Math.max(error.status === 429 ? 60000 : 5000 * 2 ** Math.min(6, (run.uploadFailures || 1) - 1), error.retryAfterMs || 0));
      run.status.lastError = String(error.message || 'Server upload failed.').slice(0, 500);
      run.status.phase = 'waiting for server retry'; run.status.lastActivityAt = Date.now();
      if ([400, 401, 403, 404].includes(error.status) || (run.uploadFailures >= 3 && ![429, 503].includes(error.status)))
        await stopSession(run.sessionTabId, 'upload-error', run.status.lastError);
      else await persistState(run);
    }
    throw error;
  }).finally(() => { if (tasks.get(id) === work) tasks.delete(id); });
  tasks.set(id, work); return work;
}
function pumpManualPrepared(run) {
  if (!manualCurrent(run) || run.uploadRetryAt > Date.now()) return;
  for (const record of Object.values(run.preparedRecords)) ensureManualSubmission(run, record).catch(() => {});
}
function pipelineSnapshot(tabId) {
  const scoped = Number.isInteger(tabId), entries = [...outstandingImages.entries()].filter(([, entry]) =>
    !scoped || [...entry.owners.values()].some(owner => owner.tabId === tabId));
  const stages = { waitingDuplicateCheck: 0, checkingDuplicates: 0, waitingMetadata: 0, readingPrompts: 0, readyUpload: 0, uploading: 0 };
  for (const [id, entry] of entries) {
    const owners = [...entry.owners.values()].filter(owner => !scoped || owner.tabId === tabId);
    const stage = preparedUploads.get(id)?.uploading ? 'uploading'
      : preparedUploads.get(id)?.checking ? catalogChecks.state(id) === 'checking' ? 'checkingDuplicates' : 'waitingDuplicateCheck'
      : owners.some(owner => owner.stage === 'readyUpload') ? 'readyUpload'
      : owners.some(owner => owner.stage === 'readingPrompts') ? 'readingPrompts'
      : owners.some(owner => owner.stage === 'waitingDuplicateCheck' || owner.stage === 'checkingDuplicates')
        ? catalogChecks.state(id) === 'checking' ? 'checkingDuplicates' : 'waitingDuplicateCheck' : 'waitingMetadata';
    stages[stage]++;
  }
  const runs = scoped ? [sessions.get(tabId)].filter(Boolean) : [...sessions.values()];
  const automatic = autoBrowseCollector?.stats(tabId) || {};
  return { ...stages, outstanding: entries.length, outstandingTotal: outstandingImages.size, outstandingLimit: OUTSTANDING_LIMIT,
    paused: [...outstandingImages.values()].filter(entry => [...entry.owners.values()].every(owner =>
      owner.kind === 'manual' ? !sessions.get(owner.tabId)?.status.running : autoBrowseCollector.isPaused(owner.tabId))).length,
    discovered: runs.reduce((sum, run) => sum + run.catalogDiscoveredIds.length, 0) + (automatic.discovered || 0),
    accepted: runs.reduce((sum, run) => sum + run.catalogSyncedIds.length, 0) + (automatic.accepted || 0),
    alreadyStored: runs.reduce((sum, run) => sum + run.catalogStoredSkippedIds.length, 0) + (automatic.alreadyStored || 0),
    skippedOversize: runs.reduce((sum, run) => sum + run.catalogOversizeSkippedIds.length, 0) + (automatic.skippedOversize || 0),
    metadataConcurrency: ISSCollectionSpeed.get().metadataConcurrency, uploadBatchSize: ISSCollectionSpeed.get().uploadBatchSize,
    uploadIntervalMs: ISSCollectionSpeed.get().uploadIntervalMs, collectionSpeed: ISSCollectionSpeed.get() };
}
function persistState(run) {
  if (run && sessions.get(run.sessionTabId) !== run) return Promise.resolve();
  notifyStatusChanged();
  for (const value of sessions.values()) recalcCounts(value);
  const snapshot = structuredClone({ version: RUN_VERSION, runs: [...sessions.values()] });
  const retired = [...outstandingImages].flatMap(([id, entry]) => [...entry.owners.values()]
    .filter(owner => owner.kind === 'manual' && !snapshot.runs.find(value => value.sessionTabId === owner.tabId)?.outstandingIds.includes(id))
    .map(owner => ({ id, tabId: owner.tabId })));
  const next = persistChain.catch(() => {}).then(async () => {
    await writeStorage(STATE_KEY, snapshot);
    // An older queued snapshot must not release capacity before a newer queued
    // snapshot that may still own the ID has reached durable storage.
    if (persistChain === next) for (const owner of retired)
      if (!sessions.get(owner.tabId)?.outstandingIds.includes(owner.id)) releaseOutstanding(owner.id, 'manual', owner.tabId);
  });
  persistChain = next; return next;
}
function addDebug(stage, message, data = {}) {
  const safe = {};
  for (const [key, value] of Object.entries(data)) if (/^(checked|alreadyStored|needsCopy|images|page)$/.test(key)) safe[key] = Number(value) || 0;
  debugLogEntries.push({ time: new Date().toISOString(), stage: String(stage).slice(0, 80),
    message: String(message || '').slice(0, 500), ...safe });
  if (debugLogEntries.length > 200) debugLogEntries.shift();
}
function formatDebugLog() {
  return debugLogEntries.map(({ time, stage, message }) => `[${time}] ${stage}: ${message}`).join('\n');
}
async function readCloudCatalogConfig() {
  const value = await readStorage(CONFIG_KEY) || {};
  let speedMultiplier = 1;
  try { speedMultiplier = ISSCollectionSpeed.normalize(value.speedMultiplier ?? 1); } catch {}
  return { apiBase: API_URL, autoBrowse: value.autoBrowse !== false, configured: true,
    speedMultiplier, collectionSpeed: ISSCollectionSpeed.profile(speedMultiplier) };
}
function validFeed(feed, pageUrl) {
  return ISSBrowseCollector.page(pageUrl) && feed?.site === 'civitai' && feed.pageUrl === pageUrl &&
    ['image.getInfinite', 'image.getImagesAsPostsInfinite'].includes(feed.endpoint) &&
    feed.filters && typeof feed.filters === 'object' && !Array.isArray(feed.filters);
}
async function restoreAll() {
  const previousConfig = await readStorage(CONFIG_KEY);
  uploadIntervalMs = ISSCollectionSpeed.set((await readCloudCatalogConfig()).speedMultiplier).uploadIntervalMs;
  if (previousConfig && (Object.hasOwn(previousConfig, 'writeToken') || previousConfig.apiBase !== API_URL)) {
    await writeStorage(CONFIG_KEY, { apiBase: API_URL, autoBrowse: previousConfig.autoBrowse !== false, speedMultiplier: ISSCollectionSpeed.get().multiplier });
  }
  const saved = await readStorage(STATE_KEY);
  if (!saved || typeof saved !== 'object') return;
  const candidates = saved.version === RUN_VERSION && Array.isArray(saved.runs) ? saved.runs : [saved];
  for (const prior of candidates.slice(-100)) {
    const pageUrl = String(prior.settings?.pageUrl || ''), tabId = prior.sessionTabId;
    if (!Number.isInteger(tabId) || !ISSBrowseCollector.page(pageUrl) || sessions.has(tabId)) continue;
    const run = freshState({ pageUrl, sessionTabId: tabId }), driver = newDriver();
    for (const key of ['catalogIds', 'catalogSyncedIds', 'catalogStoredSkippedIds', 'catalogPromptlessSkippedIds', 'catalogOversizeSkippedIds', 'catalogProcessedIds', 'catalogDiscoveredIds', 'outstandingIds']) {
      run[key] = [...new Set((Array.isArray(prior[key]) ? prior[key] : []).map(String)
        .filter(id => /^[1-9]\d{0,19}$/.test(id) && Number.isSafeInteger(Number(id))))];
    }
    if (!run.catalogProcessedIds.length) run.catalogProcessedIds = run.catalogIds.slice();
    if (!run.catalogDiscoveredIds.length) run.catalogDiscoveredIds = run.catalogProcessedIds.slice();
    run.outstandingIds = run.outstandingIds.filter(id => !run.catalogSyncedIds.includes(id) && !run.catalogPromptlessSkippedIds.includes(id) && !run.catalogOversizeSkippedIds.includes(id));
    run.uploadRetryAt = Math.max(0, Math.min(Number(prior.uploadRetryAt) || 0, Date.now() + 300000));
    for (const record of Object.values(prior.preparedRecords || {})) {
      if (record && /^[1-9]\d{0,19}$/.test(String(record.id)) && String(record.prompt || '').trim() && !run.catalogSyncedIds.includes(String(record.id))) {
        run.preparedRecords[String(record.id)] = record;
        if (!run.outstandingIds.includes(String(record.id))) run.outstandingIds.push(String(record.id));
      }
    }
    for (const id of run.outstandingIds) reserveOutstanding(id, 'manual', tabId, run.preparedRecords[id] ? 'readyUpload' : 'waitingMetadata', true);
    if (validFeed(prior.feed, pageUrl)) run.feed = { ...prior.feed, pages: Math.max(0, Number(prior.feed.pages) || 0),
      retryAt: Math.max(0, Math.min(Number(prior.feed.retryAt) || 0, Date.now() + 300000)) };
    Object.assign(run.status, { stopped: !!prior.status?.stopped, stopReason: String(prior.status?.stopReason || ''), lastError: String(prior.status?.lastError || '').slice(0,500) });
    if (/contributor|connection.required|key is invalid/i.test(run.status.lastError)) run.status.lastError = '';
    sessions.set(tabId, run); drivers.set(tabId, driver);
    const sourceTab = await getTab(tabId);
    run.orphaned = ISSBrowseCollector.page(sourceTab?.url)?.href !== pageUrl;
    if (prior.status?.running || prior.status?.scanning) {
      try {
        if (prior.settings?.serverCopies !== true) throw new Error('Previous local collection is paused. Resume to send this feed to the server.');
        if (!run.feed || (run.feed.done && !Object.keys(run.preparedRecords).length)) throw new Error('Start a Civitai feed to use server collection.');
        if (run.orphaned) throw new Error('Source tab changed after restart. Open the same Civitai page and resume this saved feed.');
        if (!run.status.stopped) { run.status.running = run.status.scanning = true; driver.enabled = true; driver.phase = 'selected feed'; }
      } catch (error) {
        run.status.stopped = true; run.status.stopReason = 'resume-required'; run.status.lastError = error.message;
      }
    }
  }
  // Old browser-file queues are deliberately discarded during migration.
  await persistState();
}
const ready = restoreAll();

async function ensureOffscreenTicker() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)] });
  if (contexts.length) return;
  if (!offscreenCreating) offscreenCreating = chrome.offscreen.createDocument({ url: OFFSCREEN_PATH,
    reasons: ['WORKERS'], justification: 'Run the indexing and scrolling clock for enabled Civitai collection, including inactive Civitai tabs.' });
  try { await offscreenCreating; } finally { offscreenCreating = null; }
}
async function closeOffscreenTicker() {
  try {
    if (offscreenCreating) await offscreenCreating;
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)] });
    if (contexts.length && !await needsOffscreenTicker()) await chrome.offscreen.closeDocument();
  } catch {}
}
async function stopSession(tabId, reason = 'user', error = '') {
  advanceEpoch(tabId);
  if (reason === 'user') await autoBrowseCollector.pauseTab(tabId);
  const run = sessions.get(tabId), driver = drivers.get(tabId);
  if (run) {
    if (driver) { driver.enabled = false; driver.phase = 'paused'; }
    run.status.running = run.status.scanning = false; run.status.stopped = true;
    if (['source-tab-closed','source-tab-changed'].includes(reason)) run.orphaned = true;
    run.status.stopReason = reason; if (error) run.status.lastError = error;
    run.status.phase = reason === 'feed-complete' ? 'selected feed complete' : 'paused';
    run.status.lastActivityAt = Date.now();
    await persistState(run);
  }
  if (!activeRuns().length) chrome.alarms.clear('iss-active-run');
  await closeOffscreenTicker();
}
async function stopAll(reason, error) {
  for (const id of new Set([...sessions.keys(), ...commandEpochs.keys()])) await stopSession(id, reason, error);
}
function controlTabId(message, sender) {
  if (isCivitaiSender(sender)) {
    if (message.tabId != null && message.tabId !== sender.tab.id) throw new Error('A Civitai tab can only control its own scan.');
    return sender.tab.id;
  }
  if (!Number.isInteger(message.tabId)) throw new Error('Choose the Civitai tab to control.');
  return message.tabId;
}
async function startSession(message, sender, resume = false) {
  const tabId = controlTabId(message, sender), epoch = advanceEpoch(tabId);
  const starting = () => epochFor(tabId) === epoch;
  const tab = await getTab(tabId), current = ISSBrowseCollector.page(tab?.url);
  if (!starting()) throw new Error('Start was cancelled for this tab.');
  if (!current) throw new Error('Index Civitai supports civitai.com and civitai.red pages only.');
  const owned = sessions.get(tabId);
  if (owned?.status.running) {
    if (owned.settings.pageUrl !== current.href) {
      const error = 'This tab changed pages. Its previous feed is paused with its position saved. Return to its source page to resume, or start a fresh scan here.';
      await stopSession(tabId, 'source-tab-changed', error);
      throw new Error(error);
    }
    throw new Error('This tab already has an active scan.');
  }
  let feed, pageUrl, previous;
  if (resume) {
    previous = matchingRun(tabId, current.href);
    if (!previous?.feed || (previous.feed.done && !Object.keys(previous.preparedRecords || {}).length) || previous.settings.pageUrl !== current.href) throw new Error('Open the same Civitai page as the saved feed to resume.');
    pageUrl = previous.settings.pageUrl;
    feed = { ...previous.feed, failures: 0, retryAt: 0 };
  } else {
    pageUrl = String(message.settings?.pageUrl || current.href);
    if (current.href !== pageUrl || (message.settings?.siteMode && message.settings.siteMode !== 'civitai')) throw new Error('Start from the current Civitai page.');
    feed = ISSFeed.fromRequests('civitai', pageUrl, message.feedRequestUrls || []);
  }
  await ensureOffscreenTicker();
  const verifiedTab = await getTab(tabId);
  if (!starting() || ISSBrowseCollector.page(verifiedTab?.url)?.href !== pageUrl) {
    await closeOffscreenTicker(); throw new Error('Start was cancelled or this tab changed page.');
  }
  await resumeCivitaiSourceRequests();
  if (!starting()) throw new Error('Start was cancelled for this tab.');
  if (resume && (sessions.get(previous.sessionTabId) !== previous || previous.status.running)) {
    throw new Error('This saved feed was already resumed in another tab.');
  }
  const run = resume ? { ...previous, feed, sessionTabId: tabId } : freshState({ pageUrl, sessionTabId: tabId, feed });
  run.orphaned = false;
  // Clone mutable status so a response from the old paused run cannot change this run.
  run.status = { ...run.status, running: true, scanning: true, stopped: false, stopReason: '', lastError: '' };
  if (previous && previous.sessionTabId !== tabId) {
    for (const id of previous.outstandingIds) {
      releaseOutstanding(id, 'manual', previous.sessionTabId);
      reserveOutstanding(id, 'manual', tabId, previous.preparedRecords[id] ? 'readyUpload' : 'waitingMetadata', true);
    }
    sessions.delete(previous.sessionTabId); drivers.delete(previous.sessionTabId);
  }
  sessions.set(tabId, run); drivers.set(tabId, { ...newDriver(), enabled: true, phase: 'selected feed' });
  await autoBrowseCollector.resumeTab(tabId);
  autoBrowseCollector.pauseForManual(tabId);
  await persistState(run); chrome.alarms.create('iss-active-run', { periodInMinutes: 0.5 });
  scheduleImmediateClock();
  return { ok: true, state: getPublicState(tabId, pageUrl) };
}
async function backgroundFeedPulse(tabId) {
  const run = sessions.get(tabId), currentDriver = drivers.get(tabId), feed = run?.feed;
  if (!feed || !currentDriver.enabled || currentDriver.busy || run.status.stopped || Date.now() < (feed.retryAt || 0)) return;
  if (feed.done) {
    if (Object.keys(run.preparedRecords).length) {
      pumpManualPrepared(run);
      run.status.phase = currentDriver.phase = run.uploadRetryAt > Date.now() ? 'waiting for server retry' : 'finishing queued submissions';
      notifyStatusChanged();
    } else await stopSession(tabId, 'feed-complete');
    return;
  }
  currentDriver.busy = true;
  const current = () => sessions.get(tabId) === run && drivers.get(tabId) === currentDriver && run.status.running && !run.status.stopped;
  const enqueuePrepared = records => Promise.all(records.map(record => ensureManualSubmission(run, record)));
  try {
    if (!current()) return;
    run.status.phase = currentDriver.phase = 'reading selected feed'; run.status.lastActivityAt = Date.now();
    notifyStatusChanged();
    // Prepared metadata survives a browser restart independently of its cursor.
    // Replay it while source work continues; the shared uploader deduplicates IDs.
    pumpManualPrepared(run);
    const result = await ISSFeed.next(feed,
      url => requestCivitaiFeed(run.sessionTabId, url, run.settings.pageUrl, current),
      task => ISSImageQueue.run(task, current),
      async progress => {
        if (!current()) return;
        if (progress.phase === 'metadata' && Array.isArray(progress.ids)) {
          const ids = progress.ids.map(String);
          run.catalogDiscoveredIds = [...new Set([...run.catalogDiscoveredIds, ...ids])];
          for (const id of ids) if (!run.catalogSyncedIds.includes(id) && !run.catalogOversizeSkippedIds.includes(id) && reserveOutstanding(id, 'manual', tabId))
            run.outstandingIds = [...new Set([...run.outstandingIds, id])];
          await persistState(run);
          primeCatalogChecks(ids.filter(id => !run.catalogSyncedIds.includes(id) && run.outstandingIds.includes(id)), current).catch(() => {});
        }
        if (progress.phase === 'metadata-admit') {
          const id = String(progress.id);
          if (run.catalogSyncedIds.includes(id)) { observeSourceReactions(id, progress.reactions); return { skip: true }; }
          if (run.catalogPromptlessSkippedIds.includes(id) || run.catalogOversizeSkippedIds.includes(id)) return { skip: true };
          await admitManualImage(id, run, current);
          markOutstanding(id, 'manual', tabId, 'waitingDuplicateCheck');
          const stored = await checkQueuedCatalogImage(id, current);
          if (!current()) throw Object.assign(new Error('Collection was paused.'), { status: 409 });
          if (stored.exists) {
            if (stored.downloadStatus !== 'skipped') observeSourceReactions(id, progress.reactions);
            run.catalogIds = [...new Set([...run.catalogIds, id])];
            run.catalogProcessedIds = [...new Set([...run.catalogProcessedIds, id])];
            await acceptManualRecords(run, [{ id }], [stored]);
            return { skip: true };
          }
          markOutstanding(id, 'manual', tabId, 'waitingMetadata'); return;
        }
        if (progress.phase === 'metadata-oversize') {
          const id = String(progress.id);
          run.catalogOversizeSkippedIds = [...new Set([...run.catalogOversizeSkippedIds, id])];
          run.catalogProcessedIds = [...new Set([...run.catalogProcessedIds, id])];
          delete run.preparedRecords[id]; releaseManualImage(run, id);
          run.status.phase = currentDriver.phase = 'skipped image over 9 MP or 4096 pixels';
          run.status.lastActivityAt = Date.now();
          await discardOversizeReactions(id);
          await autoBrowseCollector.acknowledgeManual([{ id }]); await persistState(run); return;
        }
        if (progress.phase === 'metadata-start') { markOutstanding(progress.id, 'manual', tabId, 'readingPrompts'); return; }
        run.status.pending = Math.max(0, Number(progress.total || 0) - Number(progress.completed || 0));
        run.status.phase = currentDriver.phase = progress.phase === 'metadata-ready' ? 'preparing server submission' : 'reading prompts';
        run.status.lastActivityAt = Date.now();
        if (progress.phase === 'metadata-complete' && progress.id) {
          run.catalogProcessedIds = [...new Set([...run.catalogProcessedIds, String(progress.id)])];
          recalcCounts(run);
          if (progress.record) {
            const eligible = await PromptCatalogDB.forPromptCollection([progress.record]);
            if (!current()) return;
            if (eligible.items.length) {
              await PromptCatalogDB.upsert(eligible.items);
              if (!current()) return;
              run.catalogIds = [...new Set([...run.catalogIds, ...eligible.items.map(item => String(item.id))])];
              for (const record of eligible.items) {
                if (run.catalogSyncedIds.includes(String(record.id)) || run.catalogOversizeSkippedIds.includes(String(record.id))) { releaseManualImage(run, record.id); continue; }
                run.preparedRecords[String(record.id)] = record;
                markOutstanding(record.id, 'manual', tabId, 'readyUpload');
              }
              await persistState(run);
              enqueuePrepared(eligible.items.filter(record => !run.catalogSyncedIds.includes(String(record.id)))).catch(() => {});
            } else {
              run.catalogPromptlessSkippedIds = [...new Set([...run.catalogPromptlessSkippedIds, ...eligible.skippedIds])];
              releaseManualImage(run, progress.id);
              await persistState(run);
            }
          } else { releaseManualImage(run, progress.id); }
        } else if (progress.phase === 'metadata-error' && progress.id) {
          markOutstanding(progress.id, 'manual', tabId, run.preparedRecords[String(progress.id)] ? 'readyUpload' : 'waitingMetadata');
        }
        notifyStatusChanged();
      }, async id => { await deferReactionPage(id, run.sessionTabId, run.settings.pageUrl); return {}; });
    if (!current()) return;
    const signature = JSON.stringify(result.items.map(item => item.url));
    if (result.items.length && signature === feed.lastSignature) throw new Error('The feed repeated its previous page. Resume after checking Civitai.');
    const eligible = await PromptCatalogDB.forPromptCollection(result.catalogItems || []);
    if (!current()) return;
    run.catalogPromptlessSkippedIds = [...new Set([...run.catalogPromptlessSkippedIds, ...eligible.skippedIds])];
    if (eligible.items.length) {
      await PromptCatalogDB.upsert(eligible.items);
      if (!current()) return;
      run.catalogIds = [...new Set([...run.catalogIds, ...eligible.items.map(item => String(item.id))])];
      run.status.phase = currentDriver.phase = 'submitting prompts'; run.status.lastActivityAt = Date.now();
      notifyStatusChanged();
      const remaining = eligible.items.filter(record => !run.catalogSyncedIds.includes(String(record.id)) && !run.catalogOversizeSkippedIds.includes(String(record.id)));
      for (const record of remaining) run.preparedRecords[String(record.id)] = record;
      await persistState(run); enqueuePrepared(remaining).catch(() => {});
    }
    for (const id of eligible.skippedIds) releaseManualImage(run, id);
    run.outstandingIds = run.outstandingIds.filter(id => !!run.preparedRecords[id]);
    if (!current()) return;
    Object.assign(feed, { cursor: result.cursor, done: result.done, pages: feed.pages + 1,
      failures: 0, retryAt: 0, lastSignature: signature });
    if (run.uploadRetryAt > Date.now()) currentDriver.phase = run.status.phase = 'waiting for server retry';
    else { currentDriver.phase = run.status.phase = 'selected feed'; run.status.lastError = ''; }
    run.status.pending = 0;
    run.status.lastActivityAt = Date.now();
    // A source cursor advances after every prompt is durably queued. Uploads
    // drain independently, so the next page can be checked while they run.
    await persistState(run);
    addDebug('feed', 'Indexed selected Civitai feed page', { page: feed.pages, images: eligible.items.length });
    if (current() && feed.done && !Object.keys(run.preparedRecords).length) await stopSession(tabId, 'feed-complete');
  } catch (error) {
    if (!current()) return;
    feed.failures = (feed.failures || 0) + 1; run.status.lastError = error.message || 'Civitai collection failed.';
    if ([400, 401, 403, 404, 409].includes(error.status) || (feed.failures >= 3 && ![429,503].includes(error.status))) await stopSession(tabId, 'feed-error', run.status.lastError);
    else {
      const delay = Math.min(300000, Math.max(error.status === 429 ? 60000 : 5000 * 2 ** (feed.failures - 1), error.retryAfterMs || 0));
      feed.retryAt = Date.now() + delay; currentDriver.phase = run.status.phase = `retry in ${Math.ceil(delay / 1000)}s`; await persistState(run);
    }
    addDebug('feed-error', run.status.lastError);
  } finally { currentDriver.busy = false; notifyStatusChanged(); }
}
async function driverPulse() {
  const available = MAX_ACTIVE_FEEDS - [...drivers.values()].filter(driver => driver.busy).length;
  if (available <= 0) return;
  const candidates = activeRuns().filter(run => {
    const driver = drivers.get(run.sessionTabId);
    return driver?.enabled && !driver.busy && Date.now() >= Math.max(driver.nextPulseAt, run.feed?.retryAt || 0);
  }).sort((a,b) => (drivers.get(a.sessionTabId).nextPulseAt || 0) - (drivers.get(b.sessionTabId).nextPulseAt || 0)).slice(0,available);
  for (const run of candidates) drivers.get(run.sessionTabId).nextPulseAt = Date.now() + ISSCollectionSpeed.get().imageCooldownMs;
  await Promise.allSettled(candidates.map(run => backgroundFeedPulse(run.sessionTabId)));
}

// All tabs share a single paced submission queue. Image bytes never pass through it.
function queuedUpload(task) {
  const result = uploadQueue.catch(() => {}).then(async () => {
    while (Date.now() < nextUploadAt) await new Promise(resolve => {
      let timer;
      const wake = () => { clearTimeout(timer); uploadWaiters.delete(wake); resolve(); };
      uploadWaiters.add(wake); timer = setTimeout(wake, Math.max(0, nextUploadAt - Date.now()));
    });
    try { return await task(); }
    finally { lastUploadFinishedAt = Date.now(); nextUploadAt = Math.max(uploadCooldownUntil, lastUploadFinishedAt + uploadIntervalMs); }
  });
  uploadQueue = result; return result;
}
async function syncCloudCatalogItems(records, { required = true, onAccepted, isCurrent = () => true } = {}) {
  if (!Array.isArray(records) || !records.length) return { enabled: true, accepted: 0, alreadyStored: 0, missing: 0, storageItems: [] };
  const uniqueRecords = new Map();
  for (const record of records) {
    const id = String(record?.id ?? '');
    if (!/^\d{1,20}$/.test(id) || !Number.isSafeInteger(Number(id)) || Number(id) <= 0) throw new Error('Shared catalog record has an invalid image ID.');
    const prior = uniqueRecords.get(id) || {}, merged = { ...prior, ...record, id };
    for (const key of ['prompt', 'negativePrompt', 'modelName', 'downloadUrl', 'sourceUrl']) if (!String(merged[key] || '').trim() && prior[key]) merged[key] = prior[key];
    for (const key of ['tags', 'loras']) if ((!Array.isArray(merged[key]) || !merged[key].length) && prior[key]) merged[key] = prior[key];
    merged.reactions = { ...(prior.reactions || {}), ...(record.reactions || {}) }; uniqueRecords.set(id, merged);
  }
  const unique = [...uniqueRecords.values()].filter(record => String(record.prompt || '').trim());
  const results = await Promise.all(unique.map(record => new Promise((resolve, reject) => {
    let entry = preparedUploads.get(record.id);
    const fresh = !entry;
    if (!entry) { entry = { record, subscribers: new Set(), uploading: false, checking: true }; preparedUploads.set(record.id, entry); }
    else if (!entry.uploading && !entry.selected) entry.record = { ...entry.record, ...record };
    entry.subscribers.add({ isCurrent, onAccepted, resolve, reject });
    if (fresh) checkPreparedUpload(entry);
    else if (!entry.checking) scheduleUploadFlush();
    notifyStatusChanged();
  })));
  return { enabled: true, accepted: results.filter(item => item.downloadStatus !== 'skipped').length,
    alreadyStored: results.filter(item => item.exists && item.downloadStatus !== 'skipped').length,
    skippedOversize: results.filter(item => item.downloadStatus === 'skipped' && item.skipReason === 'oversize').length,
    missing: results.filter(item => item.needsDownload).length, storageItems: results, skippedPromptless: uniqueRecords.size - unique.length };
}
async function completePreparedUpload(entry, stored) {
  if (preparedUploads.get(entry.record.id) === entry) preparedUploads.delete(entry.record.id);
  for (const subscriber of entry.subscribers) {
    try {
      if (!await subscriber.isCurrent()) throw Object.assign(new Error('Collection was paused.'), { status: 409 });
      await subscriber.onAccepted?.([entry.record], [stored]); subscriber.resolve(stored);
    } catch (error) { subscriber.reject(error); }
  }
}
async function checkPreparedUpload(entry) {
  try {
    if (ISSFeed.imageExceedsLimits(entry.record)) {
      await completePreparedUpload(entry, { imageId: entry.record.id, exists: true, needsDownload: false, downloadStatus: 'skipped', skipReason: 'oversize' });
      return;
    }
    const size = new TextEncoder().encode(JSON.stringify(entry.record)).length + 1;
    if (size > 900 * 1024) throw new Error(`Image ${entry.record.id} has metadata larger than the server upload limit. Its prompt is retained for retry.`);
    const stored = await checkQueuedCatalogImage(entry.record.id, () => liveSubscribers(entry));
    if (!await liveSubscribers(entry)) return;
    entry.storageItem = stored;
    if (stored.exists) {
      if (stored.downloadStatus !== 'skipped') observeSourceReactions(entry.record.id, entry.record.reactions);
      await completePreparedUpload(entry, stored);
    }
  } catch (error) {
    for (const subscriber of entry.subscribers) subscriber.reject(error);
    if (preparedUploads.get(entry.record.id) === entry) preparedUploads.delete(entry.record.id);
  } finally {
    entry.checking = false; notifyStatusChanged(); scheduleUploadFlush();
  }
}
function scheduleUploadFlush() {
  if (uploadFlushTimer !== null || uploadFlushing || ![...preparedUploads.values()].some(entry => !entry.checking && entry.storageItem)) return;
  if (!uploadFlushQueuedAt) uploadFlushQueuedAt = Date.now();
  const wait = Math.max(0, nextUploadAt - Date.now(), uploadFlushQueuedAt + uploadIntervalMs - Date.now());
  uploadFlushTimer = setTimeout(() => { uploadFlushTimer = null; uploadFlushQueuedAt = 0; flushPreparedUploads().catch(error => addDebug('upload-error', error.message)); }, wait);
}
async function liveSubscribers(entry) {
  for (const subscriber of [...entry.subscribers]) {
    let current = false; try { current = await subscriber.isCurrent(); } catch {}
    if (!current) { entry.subscribers.delete(subscriber); subscriber.reject(Object.assign(new Error('Collection was paused.'), { status: 409 })); }
  }
  if (!entry.subscribers.size && preparedUploads.get(entry.record.id) === entry) preparedUploads.delete(entry.record.id);
  return entry.subscribers.size > 0;
}
async function flushPreparedUploads() {
  if (uploadFlushing) return;
  uploadFlushing = true;
  const batch = []; let bytes = 12;
  // UTF-8 encoded JSON remains below the server's 1 MiB body limit. A single
  // oversized record stays in durable caller storage and reports a clear error.
  const byteLength = value => new TextEncoder().encode(JSON.stringify(value)).length;
  try {
    for (const entry of [...preparedUploads.values()]) {
      if (!await liveSubscribers(entry)) continue;
      if (entry.checking || !entry.storageItem) continue;
      const size = byteLength(entry.record) + 1;
      if (size > 900 * 1024) {
        const error = new Error(`Image ${entry.record.id} has metadata larger than the server upload limit. Its prompt is retained for retry.`);
        for (const subscriber of entry.subscribers) subscriber.reject(error);
        preparedUploads.delete(entry.record.id); continue;
      }
      if (batch.length >= ISSCollectionSpeed.get().uploadBatchSize || bytes + size > 900 * 1024) break;
      // Freeze the counted record while awaiting other subscribers. A duplicate
      // must not grow an already-sized batch beyond the request byte ceiling.
      bytes += size; entry.selected = true; batch.push(entry);
    }
    notifyStatusChanged();
    if (!batch.length) return;
    await queuedUpload(async () => {
      let active = [];
      for (const entry of batch) if (await liveSubscribers(entry)) active.push(entry);
      if (!active.length) return;
      // Checks already ran independently at queue admission. The server also
      // rechecks under its image lock, closing races with other contributors.
      for (const entry of active) entry.uploading = true;
      notifyStatusChanged();
      const result = await postCatalog('images', { items: active.map(entry => entry.record) });
      const skipped = result.skippedItems ?? [], skippedById = new Map(), activeIds = new Set(active.map(entry => entry.record.id));
      if (!Array.isArray(skipped)) throw new Error('Shared catalog returned invalid skipped-image details. This batch has been retained for retry.');
      for (const item of skipped) {
        if (typeof item?.imageId !== 'string' || !activeIds.has(item.imageId) || skippedById.has(item.imageId) || item.reason !== 'oversize')
          throw new Error('Shared catalog returned invalid skipped-image details. This batch has been retained for retry.');
        skippedById.set(item.imageId, { imageId: item.imageId, exists: true, needsDownload: false, downloadStatus: 'skipped', skipReason: 'oversize' });
      }
      if (Number(result.accepted) + skippedById.size !== active.length || Number(result.skipped || 0) !== skippedById.size) throw new Error(`Shared catalog accepted ${Number(result.accepted) || 0} of ${active.length} records. This batch has been retained for retry.`);
      await Promise.all(active.map(entry => completePreparedUpload(entry, skippedById.get(entry.record.id) || entry.storageItem)));
      addDebug('server-storage', 'Submitted new prompt records after early duplicate checks', { checked: active.length,
        alreadyStored: 0, needsCopy: active.length });
    });
  } catch (error) {
    for (const entry of batch) {
      for (const subscriber of entry.subscribers) subscriber.reject(error);
      preparedUploads.delete(entry.record.id);
    }
    throw error;
  } finally {
    uploadFlushing = false;
    for (const entry of batch) { entry.uploading = false; entry.selected = false; }
    notifyStatusChanged(); scheduleUploadFlush();
  }
}
async function postCatalog(action, body) {
  try {
    const response = await fetch(API_URL + '?action=' + action, { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), cache: 'no-store', signal: AbortSignal.timeout(25000), credentials: 'omit', redirect: 'error' });
    if (!response.ok) {
      const retryAfterMs = civitaiRetryAfterMs(response.headers.get('retry-after'));
      if (response.status === 429 || (response.status === 503 && retryAfterMs > 0)) {
        uploadCooldownUntil = Math.max(uploadCooldownUntil, Date.now() + Math.max(response.status === 429 ? 60000 : 0, retryAfterMs));
        nextUploadAt = Math.max(nextUploadAt, uploadCooldownUntil);
      }
      let detail = ''; try { detail = String((await response.json())?.error || '').slice(0, 300); } catch {}
      throw Object.assign(new Error(`Shared catalog returned HTTP ${response.status} (${action}).${detail ? ' ' + detail : ''}`), { status: response.status, retryAfterMs });
    }
    const result = await response.json(); if (!result?.ok) throw new Error(result?.error || 'Shared catalog rejected this batch.');
    if (catalogStatus.action === action) Object.assign(catalogStatus, { lastError: '', lastStatus: 0, retryAt: 0, action: '' });
    notifyStatusChanged(); return result;
  } catch (error) {
    if (['TimeoutError', 'AbortError'].includes(error?.name)) error = Object.assign(new Error(`Shared catalog ${action} request timed out after 25 seconds.`), { status: 0 });
    Object.assign(catalogStatus, { action, lastError: String(error?.message || error), lastStatus: Number(error?.status) || 0,
      retryAt: Math.max(uploadCooldownUntil, Date.now() + Math.max(5000, Number(error?.retryAfterMs) || 0)) });
    notifyStatusChanged(); throw error;
  }
}

const autoBrowseCollector = ISSBrowseCollector.create({
  config: readCloudCatalogConfig, load: readStorage, save: writeStorage, tab: getTab,
  metadata: (entry, procedure, isCurrent) => ISSFeed.civitaiMetadata({ pageUrl: entry.pageUrl }, procedure, entry.card.id,
    url => requestCivitaiFeed(entry.tabId, url, entry.pageUrl, isCurrent)),
  deferReactions: entry => deferReactionPage(entry.card.id, entry.tabId, entry.pageUrl),
  record: (image, enrichment) => ISSFeed.civitaiCatalogRecord(image, {}, enrichment),
  oversize: image => ISSFeed.imageExceedsLimits(image),
  discardOversizeReactions,
  upsert: records => PromptCatalogDB.upsert(records), existing: id => PromptCatalogDB.get(id),
  processImage: (task, isCurrent) => ISSImageQueue.run(task, isCurrent),
  checkQueued: checkQueuedCatalogImage, primeChecks: primeCatalogChecks,
  observeReactions: observeSourceReactions,
  sync: (records, options) => syncCloudCatalogItems(records, options),
  manualBusy: tabId => Number.isInteger(tabId) ? !!sessions.get(tabId)?.status.running : false, debug: addDebug,
  admit: (id, tabId, restore = false, stage = 'waitingDuplicateCheck') => reserveOutstanding(id, 'auto', tabId, stage, restore),
  release: (id, tabId) => releaseOutstanding(id, 'auto', tabId),
  stage: (id, tabId, stage) => markOutstanding(id, 'auto', tabId, stage),
  capacityBlocked: () => outstandingImages.size >= OUTSTANDING_LIMIT || capacityWaiters.size > 0,
  pipeline: pipelineSnapshot,
  changed: notifyStatusChanged,
  notice: () => { refreshAutoBrowseTabs().catch(() => {}); },
  wake: () => { ready.then(() => startClockTask('browse', () => autoBrowseCollector.pulse())).catch(error => addDebug('browse-error', error.message)); }
});
function queryCivitaiTabs() {
  return new Promise(resolve => chrome.tabs.query({ url: ['https://civitai.com/*', 'https://civitai.red/*'] }, values => {
    void chrome.runtime.lastError; resolve(values || []);
  }));
}
async function needsOffscreenTicker() {
  if (activeRuns().length) return true;
  if (!(await readCloudCatalogConfig()).autoBrowse) return false;
  for (const tab of await queryCivitaiTabs()) {
    if (Number.isInteger(tab.id) && ISSBrowseCollector.page(tab.url)) {
      const status = await autoBrowseCollector.status(tab.id);
      if (status.active) return true;
    }
  }
  return false;
}
async function reconcileOffscreenTicker() {
  if (await needsOffscreenTicker()) await ensureOffscreenTicker();
  else await closeOffscreenTicker();
}
async function getBrowseStatus(tabId) {
  // Source state may wait for persistence during startup. Read the current tab
  // controls afterwards so a late pulse cannot revive a tab stopped meanwhile.
  const source = await getCivitaiSourceRequestState();
  const status = await autoBrowseCollector.status(tabId);
  const run = Number.isInteger(tabId) ? sessions.get(tabId) : null;
  const sourcePaused = !!source.authStatus || source.blockedUntil > Date.now();
  const retryAt = Math.max(status.retryAt || 0, source.blockedUntil > Date.now() ? source.blockedUntil : 0,
    run?.feed?.retryAt > Date.now() ? run.feed.retryAt : 0, run?.uploadRetryAt > Date.now() ? run.uploadRetryAt : 0);
  const manualActive = !!run?.status.running;
  const pipeline = pipelineSnapshot(tabId);
  return versionStatus({ ...status, collectionSpeed: ISSCollectionSpeed.get(), pipeline, outstandingTotal: pipeline.outstandingTotal, sourcePaused, sourceCooldownUntil: source.blockedUntil || 0,
    sourcePauseReason: source.pauseReason || '', retryAt,
    catalog: { ...catalogStatus, retryAt: Math.max(catalogStatus.retryAt, uploadCooldownUntil, run?.uploadRetryAt || 0) },
    reactionEnrichment: reactionPages.snapshot(),
    phase: sourcePaused ? source.authStatus ? 'Civitai needs attention' : 'waiting for Civitai cooldown'
      : pipeline.outstandingTotal >= OUTSTANDING_LIMIT && pipeline.paused ? 'shared queue full; resume paused tabs'
      : status.manualPaused ? run.status.phase || 'selected feed collecting' : status.phase,
    lastActivityAt: Math.max(status.lastActivityAt || 0, run?.status.lastActivityAt || 0),
    // Visual scroll and source metadata use separate clocks. A manual feed can
    // keep its page moving while it owns metadata work for that one tab.
    scrollAllowed: (status.active || manualActive) && !status.tabPaused && !sourcePaused && retryAt <= Date.now() &&
      pipeline.outstandingTotal < OUTSTANDING_LIMIT,
    manualProgress: manualActive ? { processed: run.status.processed || 0,
      submitted: run.status.catalogSynced || 0, pending: run.status.pending || 0 } : null });
}
function scheduleImmediateClock() {
  if (immediateClockTimer !== null) return;
  immediateClockTimer = setTimeout(() => {
    immediateClockTimer = null; collectionClockPulse();
  }, 0);
}
function scheduleStatusPush() {
  if (!statusPorts.size || statusPushTimer !== null) return;
  statusPushTimer = setTimeout(() => {
    statusPushTimer = null;
    for (const client of statusPorts.values()) if (client.dirty) publishStatus(client);
  }, 100);
}
function notifyStatusChanged() {
  statusRevision++;
  for (const client of statusPorts.values()) client.dirty = true;
  scheduleStatusPush();
}
globalThis.indexCivitaiStatusChanged = notifyStatusChanged;
function publicStatusConfig(config) {
  return versionStatus({ ok: true, apiBase: API_URL, configured: true, autoBrowse: config.autoBrowse,
    speedMultiplier: config.speedMultiplier, collectionSpeed: config.collectionSpeed });
}
function compactStatusState(state) {
  const compactRun = run => ({ ...run, ...(run.feed ? { feed: { pages: run.feed.pages, done: run.feed.done } } : {}) });
  return Array.isArray(state.runs) ? { ...state, runs: state.runs.slice(-100).map(compactRun) } : compactRun(state);
}
async function buildStatusSnapshot(client) {
  await ready;
  const source = versionStatus({ ok: true, ...await getCivitaiSourceRequestState() });
  const config = publicStatusConfig(await readCloudCatalogConfig());
  let tab;
  if (client.tabId !== null) {
    tab = await getTab(client.tabId);
    if (!ISSBrowseCollector.page(tab?.url)) throw new Error('The status tab is no longer on Civitai.');
  }
  const browse = await getBrowseStatus(client.tabId === null ? undefined : client.tabId);
  const state = compactStatusState(client.tabId === null ? getPublicState()
    : getPublicState(client.tabId, ISSBrowseCollector.page(tab.url).href));
  return versionStatus({ type: 'index-civitai-status', state, browse, source, config });
}
function removeStatusPort(client) {
  if (!statusPorts.has(client.port)) return;
  statusPorts.delete(client.port); client.closed = true;
  client.port.onDisconnect.removeListener?.(client.disconnected);
  if (!statusPorts.size && statusPushTimer !== null) { clearTimeout(statusPushTimer); statusPushTimer = null; }
}
async function publishStatus(client) {
  if (client.closed || client.publishing || !client.dirty) return;
  client.publishing = true; client.dirty = false;
  const revision = statusRevision;
  try {
    const snapshot = await buildStatusSnapshot(client);
    if (client.closed) return;
    // A snapshot assembled across awaited calls is discarded if newer state
    // arrived. One producer per port and monotonic revisions prevent reordering.
    if (revision !== statusRevision) { client.dirty = true; return; }
    client.port.postMessage({ ...snapshot, revision });
  } catch {
    removeStatusPort(client);
    try { client.port.disconnect(); } catch {}
  } finally {
    client.publishing = false;
    if (!client.closed && client.dirty) scheduleStatusPush();
  }
}
function connectStatusPort(port) {
  const sender = port?.sender;
  if (port?.name !== 'index-civitai-status-v1' || (sender?.id && sender.id !== chrome.runtime.id) ||
      (!isExtensionPage(sender) && !isCivitaiSender(sender)) || statusPorts.size >= 64) {
    try { port?.disconnect(); } catch {} return;
  }
  const client = { port, tabId: isExtensionPage(sender) ? null : sender.tab.id,
    dirty: true, publishing: false, closed: false, disconnected: null };
  client.disconnected = () => removeStatusPort(client);
  statusPorts.set(port, client); port.onDisconnect.addListener(client.disconnected);
  scheduleStatusPush();
}
function startClockTask(name, task) {
  if (clockTasks.has(name)) return;
  const work = Promise.resolve().then(task).catch(error => addDebug(name + '-error', error.message))
    .finally(() => { if (clockTasks.get(name) === work) clockTasks.delete(name); });
  clockTasks.set(name, work);
}
function withClockTimeout(promise, milliseconds = 2500) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Civitai tab did not answer its collection pulse.')), milliseconds);
    Promise.resolve(promise).then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}
async function pulseAutoTabs() {
  if (autoTabPulseBusy || Date.now() < nextAutoTabPulseAt) return;
  autoTabPulseBusy = true; nextAutoTabPulseAt = Date.now() + ISSCollectionSpeed.get().scrollIntervalMs;
  try {
    const tabs = await queryCivitaiTabs();
    await Promise.allSettled(tabs.filter(tab => Number.isInteger(tab.id) && ISSBrowseCollector.page(tab.url)).map(async tab => {
      const status = await getBrowseStatus(tab.id);
      await withClockTimeout(chrome.tabs.sendMessage(tab.id, { type: 'civitai-auto-pulse', status }));
    }));
  } finally { autoTabPulseBusy = false; }
}
function collectionClockPulse() {
  // Dispatch and acknowledge immediately. A slow metadata page never holds the
  // offscreen heartbeat, passive collection, or another tab's scroll clock.
  for (const run of activeRuns()) pumpManualPrepared(run);
  driverPulse().catch(error => addDebug('feeds-error', error.message));
  startClockTask('browse', () => autoBrowseCollector.pulse());
  startClockTask('scroll', pulseAutoTabs);
}
async function refreshAutoBrowseTabs() {
  const tabs = await queryCivitaiTabs();
  await Promise.allSettled(tabs.filter(tab => Number.isInteger(tab.id) && ISSBrowseCollector.page(tab.url)).map(async tab => {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['civitai-browse.js'] });
      await withClockTimeout(chrome.tabs.sendMessage(tab.id, { type: 'civitai-auto-refresh' }));
    } catch {} // Loading/closed tabs attach the content script on next load.
  }));
  await reconcileOffscreenTicker();
  nextAutoTabPulseAt = 0;
  startClockTask('scroll', pulseAutoTabs); startClockTask('browse', () => autoBrowseCollector.pulse());
}
function isExtensionPage(sender) {
  return ['library.html', 'popup.html'].some(path => sender?.url === chrome.runtime.getURL(path));
}
function isCivitaiSender(sender) {
  return Number.isInteger(sender?.tab?.id) && (sender.frameId == null || sender.frameId === 0) &&
    !!ISSBrowseCollector.page(sender.url || sender.tab.url);
}
function openLibrary() {
  return new Promise(resolve => chrome.tabs.create({ url: chrome.runtime.getURL('library.html'), active: true }, tab => {
    const error = chrome.runtime.lastError; resolve(error ? { ok: false, error: error.message } : { ok: true, tabId: tab?.id });
  }));
}
function updateConfig(change) {
  const result = configWrites.catch(() => {}).then(async () => {
    const previous = await readCloudCatalogConfig();
    const next = { apiBase: API_URL, autoBrowse: previous.autoBrowse, speedMultiplier: previous.speedMultiplier, ...change };
    await writeStorage(CONFIG_KEY, next); return next;
  });
  configWrites = result; return result;
}
function applyCollectionSpeed(value) {
  const profile = ISSCollectionSpeed.set(value); uploadIntervalMs = profile.uploadIntervalMs;
  nextUploadAt = Math.max(uploadCooldownUntil, lastUploadFinishedAt ? lastUploadFinishedAt + uploadIntervalMs : 0);
  for (const wake of [...uploadWaiters]) wake();
  if (uploadFlushTimer !== null) { clearTimeout(uploadFlushTimer); uploadFlushTimer = null; }
  scheduleUploadFlush();
  for (const driver of drivers.values()) driver.nextPulseAt = 0;
  autoBrowseCollector.speedChanged?.();
  nextAutoTabPulseAt = 0; notifyStatusChanged(); scheduleImmediateClock();
  return profile;
}
async function handleMessage(message, sender) {
  if (message?.type === 'driverPulse' && sender?.url === chrome.runtime.getURL(OFFSCREEN_PATH)) {
    collectionClockPulse(); return { ok: true };
  }
  if ((sender?.id && sender.id !== chrome.runtime.id) || (!isExtensionPage(sender) && !isCivitaiSender(sender))) throw new Error('This command is available only in Index Civitai or a Civitai tab.');
  switch (message?.type) {
    case 'start': return startSession(message, sender);
    case 'resume': return startSession(message, sender, true);
    case 'stop': { const tabId = controlTabId(message, sender); await stopSession(tabId, 'user');
      nextAutoTabPulseAt = 0; startClockTask('scroll', pulseAutoTabs); return { ok: true, state: getPublicState(tabId) }; }
    case 'getSourceStatus': return versionStatus({ ok: true, ...await getCivitaiSourceRequestState() });
    case 'pauseAll': {
      if (!isExtensionPage(sender)) throw new Error('Stop all collection from Browsing & activity.');
      await updateConfig({ autoBrowse: false });
      await stopAll('user');
      await autoBrowseCollector.reconfigure(); await refreshAutoBrowseTabs();
      return { ok: true };
    }
    case 'getState': return isCivitaiSender(sender) ? getPublicState(sender.tab.id, ISSBrowseCollector.page(sender.url || sender.tab.url).href) : getPublicState();
    case 'getConfig': {
      const config = await readCloudCatalogConfig();
      return publicStatusConfig(config);
    }
    case 'setCollectionSpeed': {
      const speedMultiplier = ISSCollectionSpeed.normalize(message.speedMultiplier);
      if (isCivitaiSender(sender)) {
        const tabId = controlTabId(message, sender), tab = await getTab(tabId);
        if (!ISSBrowseCollector.page(tab?.url)) throw new Error('Change collection speed from a current Civitai tab.');
      }
      await updateConfig({ speedMultiplier });
      const collectionSpeed = applyCollectionSpeed(speedMultiplier);
      return versionStatus({ ok: true, config: publicStatusConfig(await readCloudCatalogConfig()), collectionSpeed });
    }
    case 'saveConfig': {
      if (!isExtensionPage(sender)) throw new Error('Change browsing settings in the Index Civitai extension page.');
      if (message.apiBase && message.apiBase !== API_URL) throw new Error('Index Civitai connects only to its shared server.');
      const previous = await readCloudCatalogConfig();
      const change = Object.prototype.hasOwnProperty.call(message, 'autoBrowse') ? { autoBrowse: message.autoBrowse !== false } : {};
      // Speed has its own validated command. Routine settings saves preserve it.
      const next = await updateConfig(change);
      if (previous.autoBrowse !== next.autoBrowse) { await autoBrowseCollector.reconfigure(); await refreshAutoBrowseTabs(); }
      return { ok: true, configured: true, config: publicStatusConfig(await readCloudCatalogConfig()) };
    }
    case 'civitai-auto-status': return getBrowseStatus(isCivitaiSender(sender) ? sender.tab.id : undefined);
    case 'civitai-auto-resume-tab': {
      const tabId = controlTabId(message, sender), tab = await getTab(tabId);
      if (!ISSBrowseCollector.page(tab?.url)) throw new Error('Return to Civitai to resume automatic collection.');
      if (!(await readCloudCatalogConfig()).autoBrowse) throw new Error('Turn on automatic browsing in settings first.');
      await resumeCivitaiSourceRequests(); await autoBrowseCollector.resumeTab(tabId);
      await reconcileOffscreenTicker(); nextAutoTabPulseAt = 0; collectionClockPulse();
      return { ok: true, status: await getBrowseStatus(tabId) };
    }
    case 'civitai-auto-cards': return autoBrowseCollector.accept(message, sender);
    case 'openPromptLibrary': return openLibrary();
    case 'getDebugText': return { ok: true, text: formatDebugLog(), count: debugLogEntries.length };
    case 'clearDebugLog': debugLogEntries = []; return { ok: true };
    default: throw new Error('Unsupported Index Civitai command.');
  }
}
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  ready.then(() => handleMessage(message, sender)).then(sendResponse)
    .catch(error => sendResponse(versionStatus({ ok: false, error: error.message })));
  return true;
});
chrome.runtime.onConnect.addListener(connectStatusPort);
chrome.action.onClicked.addListener(async tab => {
  if (!ISSBrowseCollector.page(tab?.url)) { await openLibrary(); return; }
  try { await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['civitai-feed-capture.js', 'panel.js'] }); }
  catch (error) { addDebug('panel-error', error.message); }
});
chrome.alarms.onAlarm.addListener(alarm => {
  ready.then(() => ['iss-active-run', 'civitai-auto-browse'].includes(alarm.name) ? collectionClockPulse() : undefined)
    .catch(error => addDebug('clock-error', error.message));
});
chrome.tabs.onRemoved.addListener(tabId => {
  ready.then(async () => {
    await autoBrowseCollector.dropTab(tabId);
    await stopSession(tabId, 'source-tab-closed', 'The source tab closed. Reopen this Civitai page to resume its feed.');
    await reconcileOffscreenTicker();
  }).catch(() => {});
});
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.url) {
    autoBrowseCollector.dropTab(tabId, change.url).catch(() => {});
    ready.then(() => {
      const run = sessions.get(tabId);
      if (run && ISSBrowseCollector.page(change.url)?.href !== run.settings.pageUrl)
        return stopSession(tabId, 'source-tab-changed', 'This tab changed pages. Return to the saved page to resume, or start this new feed.');
      if (run?.orphaned) { run.orphaned = false; return persistState(run); }
      if (!run) advanceEpoch(tabId);
    }).catch(() => {});
  }
  if (change.status === 'complete' && ISSBrowseCollector.page(tab?.url)) refreshAutoBrowseTabs().catch(() => {});
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[CONFIG_KEY]) return;
  const changed = changes[CONFIG_KEY];
  ready.then(async () => {
    if (changed.oldValue?.speedMultiplier !== changed.newValue?.speedMultiplier)
      applyCollectionSpeed((await readCloudCatalogConfig()).speedMultiplier);
    if ((changed.oldValue?.autoBrowse !== false) !== (changed.newValue?.autoBrowse !== false)) {
      await autoBrowseCollector.reconfigure(); await refreshAutoBrowseTabs();
    }
  }).catch(error => addDebug('settings-error', error.message));
});
ready.then(async () => {
  await autoBrowseCollector.initialized;
  chrome.alarms.create('civitai-auto-browse', { periodInMinutes: 0.5 });
  if (activeRuns().length) chrome.alarms.create('iss-active-run', { periodInMinutes: 0.5 });
  try { await refreshAutoBrowseTabs(); }
  catch (error) { await stopAll('clock-error', error.message); throw error; }
}).catch(error => addDebug('startup-error', error.message));
