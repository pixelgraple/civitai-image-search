import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const root = fileURLToPath(new URL('../', import.meta.url));
export function installCheckpoint(context) {
  vm.runInContext(fs.readFileSync(path.join(root, 'state-checkpoint.js'), 'utf8'), context);
  const checkpoint = context.ISSStateCheckpoint;
  // Existing collector tests use a deterministic microtask checkpoint clock.
  // Keep the real coalescing algorithm without advancing source-request timers.
  context.ISSStateCheckpoint = Object.freeze({ create: options => checkpoint.create({ ...options,
    setTimer: callback => {
      const timer = { cancelled: false };
      queueMicrotask(() => { if (!timer.cancelled) callback(); });
      return timer;
    },
    clearTimer: timer => { timer.cancelled = true; }
  }) });
}
export async function harness(saved = {}, options = {}) {
  const storage = structuredClone(saved), started = [], listeners = {}, timerCallbacks = new Map();
  const tabs = new Map([[7, { id: 7, url: 'https://civitai.red/models/99' }]]);
  if (options.tabs) { tabs.clear(); for (const tab of options.tabs) tabs.set(tab.id, tab); }
  let timer = 0;
  const event = name => ({ addListener: fn => { (listeners[name] ||= []).push(fn); } });
  const chrome = {
    runtime: { id: 'test-extension', lastError: null, getURL: value => 'chrome-extension://test-extension/' + value,
      getContexts: async () => [{ contextType: 'OFFSCREEN_DOCUMENT' }], onMessage: event('message'), onConnect: event('connect') },
    storage: { local: {
      setAccessLevel: async value => { storage.accessLevel = value.accessLevel; },
      get: (keys, cb) => queueMicrotask(() => cb(structuredClone(storage))),
      set: (data, cb) => { Object.assign(storage, structuredClone(data)); cb?.(); }
    }, onChanged: event('storageChanged') },
    action: { onClicked: event('action') },
    tabs: { get: (id, cb) => cb(tabs.get(id)), query: (query, cb) => cb([]),
      create: (options, cb) => cb({ id: 8, ...options }), sendMessage: async () => {},
      onRemoved: event('tabRemoved'), onUpdated: event('tabUpdated') },
    scripting: { executeScript: async () => { throw new Error('Source requests must be stubbed explicitly'); } },
    alarms: { create() {}, clear() {}, onAlarm: event('alarm') },
    offscreen: { createDocument: async () => {}, closeDocument: async () => {} }
  };
  // Any accidental access to the removed browser-download API fails a test.
  Object.defineProperty(chrome, 'downloads', { get() { started.push('forbidden'); throw new Error('Browser downloads are forbidden'); } });
  const context = vm.createContext({ console, chrome, URL, AbortController, AbortSignal, TextDecoder, TextEncoder, structuredClone,
    fetch: async () => { throw new Error('Test catalog transport must be stubbed explicitly'); },
    setTimeout, clearTimeout,
    setInterval: () => 0, clearInterval() {} });
  options.setupContext?.(context);
  context.importScripts = (...files) => files.forEach(file => file === 'state-checkpoint.js'
    ? installCheckpoint(context) : vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context));
  vm.runInContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), context);
  await vm.runInContext('ready', context);
  const run = code => vm.runInContext(code, context);
  run('uploadIntervalMs = 0');
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); await run('persistChain'); };
  await flush();
  return { context, run, storage, started, listeners, tabs, flush,
    persist: () => run('persistChain'),
    message: (msg, sender = { url: tabs.get(7)?.url, tab: tabs.get(7), frameId: 0 }) =>
      new Promise(resolve => listeners.message[0](msg, sender, resolve)),
    extensionMessage: msg => new Promise(resolve => listeners.message[0](msg,
      { url: 'chrome-extension://test-extension/library.html' }, resolve)),
    emit: async (name, ...args) => { for (const fn of listeners[name] || []) fn(...args); await flush(); }
  };
}
