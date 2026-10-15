import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../civitai-browse.js', import.meta.url), 'utf8');
function harness(initialUrl = 'https://civitai.red/images') {
  let now = 100000, timerId = 0, statusCalls = 0, customResponse;
  const status = { ok: true, enabled: true, active: true, scrollAllowed: true, pending: 0, pendingTotal: 0, tabPaused: false, sourcePaused: false, retryAt: 0 };
  const location = new URL(initialUrl), cards = [], images = [], messages = [], scrolls = [], order = [], timers = new Map(), intervals = new Map(), events = {}, listeners = new Set(), observers = [];
  const node = (tagName = 'DIV', parent = null) => { const value = { tagName, parentElement: parent, children: [], isConnected: true, scrollTop: 0, clientHeight: 0, scrollHeight: 0, overflowY: 'visible' }; parent?.children.push(value); return value; };
  const root = node('HTML'); root.clientHeight = 800; root.scrollHeight = 10000;
  root.scrollBy = options => { order.push('scroll'); root.scrollTop += options.top; scrolls.push({ root, ...options }); };
  const body = node('BODY', root);
  let mutation;
  const document = { documentElement: root, body, scrollingElement: root, visibilityState: 'visible',
    createTreeWalker(start) {
      const list = []; const visit = parent => { for (const child of parent.children || []) { list.push(child); visit(child); } }; visit(start); let index = 0;
      return { currentNode: start, nextNode() { const next = list[index++] || null; if (next) this.currentNode = next; return next; } };
    },
    addEventListener: (name, fn) => { events[name] = fn; }, removeEventListener: (name, fn) => { if (events[name] === fn) delete events[name]; } };
  const context = vm.createContext({ URL, console, Date: { now: () => now }, location, document, window: {}, innerHeight: 800, innerWidth: 1200,
    getComputedStyle: value => ({ overflowY: value.overflowY }),
    setTimeout: fn => { timers.set(++timerId, fn); return timerId; }, clearTimeout: id => timers.delete(id),
    setInterval: fn => { intervals.set(++timerId, fn); return timerId; }, clearInterval: id => intervals.delete(id),
    addEventListener: (name, fn) => { events[name] = fn; }, removeEventListener: (name, fn) => { if (events[name] === fn) delete events[name]; },
    IntersectionObserver: class { constructor(fn) { this.fn = fn; this.targets = new Set(); observers.push(this); } observe(value) { this.targets.add(value); } unobserve(value) { this.targets.delete(value); } disconnect() { this.targets.clear(); } },
    MutationObserver: class { constructor(fn) { mutation = this; this.fn = fn; this.attached = false; } observe() { this.attached = true; } disconnect() { this.attached = false; } },
    chrome: { runtime: { sendMessage: async message => {
      if (message.type === 'civitai-auto-status') { statusCalls++; return { ...status }; }
      messages.push(structuredClone(message)); order.push('collect');
      return customResponse ? customResponse(message) : { ok: true, active: status.active, accepted: message.cards.map(card => card.id), status: { ...status } };
    }, onMessage: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) } } }
  });
  const flush = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };
  function addCard(id, { visible = true, top: fixedTop, src = `https://image.civitai.com/key/${id}/width=450/${id}.jpeg`, siblingImage = false, parent = body, scrolling = root } = {}) {
    const wrapper = node('DIV', parent), anchor = node('A', wrapper), image = node('IMG', siblingImage ? wrapper : anchor);
    Object.assign(image, { currentSrc: src, src, naturalWidth: 832, naturalHeight: 1216, getBoundingClientRect: () => { const top = (fixedTop ?? (visible ? 20 : 1100)) - scrolling.scrollTop; return { width: 300, height: 450, top, bottom: top + 450, left: 20, right: 320 }; } });
    anchor.href = `https://${location.hostname}/images/${id}`; cards.push(anchor); images.push(image); return { image, anchor, wrapper };
  }
  function nested() { const value = node('DIV', body); Object.assign(value, { clientHeight: 500, scrollHeight: 5000, overflowY: 'auto', getBoundingClientRect: () => ({ top: 0, bottom: 500, left: 0, right: 1000, width: 1000, height: 500 }), scrollBy(options) { order.push('scroll'); this.scrollTop += options.top; scrolls.push({ root: value, ...options }); } }); return value; }
  async function start() { vm.runInContext(source, context); await flush(); }
  async function tick() { const work = [...timers.values()]; timers.clear(); for (const fn of work) await fn(); await flush(); }
  async function pulse(next = {}) { Object.assign(status, next); for (const fn of listeners) fn({ type: 'civitai-auto-pulse', status: { ...status } }); await flush(); }
  async function refresh(next = {}) { Object.assign(status, next); for (const fn of listeners) fn({ type: 'civitai-auto-refresh' }); await flush(); }
  return { context, location, cards, images, messages, observers, addCard, start, tick, pulse, refresh, events, root, body, status, scrolls, order, nested, node, listeners, intervals, timers,
    mutate: () => mutation?.fn(), statusCalls: () => statusCalls, respond: fn => { customResponse = fn; }, advance: ms => { now += ms; }, document };
}

test('collects visible sibling images before scrolling; excludes offscreen and foreign media', async () => {
  const h = harness(); const card = h.addCard(55, { siblingImage: true }); h.addCard(56, { visible: false }); h.addCard(57, { src: 'https://foreign.example/57.jpg' });
  await h.start(); await h.tick(); assert.deepEqual(h.messages[0].cards.map(item => item.id), ['55']);
  assert.equal(h.observers[0].targets.has(card.image), true); assert.deepEqual(h.order, ['collect', 'scroll']); assert.equal(h.scrolls[0].top, 576);
  await h.tick(); assert.equal(h.messages.length, 2); assert.deepEqual(h.messages[1].cards.map(item => item.id), ['56']);
});
test('inactive tabs process background pulses and scroll without a local timer or focus', async () => {
  const h = harness(); h.document.visibilityState = 'hidden'; h.addCard(55); await h.start(); await h.pulse();
  assert.equal(h.messages.length, 1); assert.equal(h.scrolls.length, 1); assert.equal(h.statusCalls(), 1);
  assert.doesNotMatch(source, /\.focus\(|window\.open\(|visibilityState\s*[!=]==?\s*['"]visible/);
});
test('viewport discovery accepts up to sixty and drains remaining cards before scrolling', async () => {
  const h = harness(); for (let id = 1; id <= 64; id++) h.addCard(id); await h.start(); await h.pulse();
  assert.equal(h.messages[0].cards.length, 60); assert.equal(h.scrolls.length, 0);
  h.advance(2500); await h.pulse(); assert.equal(h.messages[1].cards.length, 4); assert.equal(h.scrolls.length, 1);
});
test('source cooldown and queue backpressure pause both discovery and scrolling', async () => {
  const h = harness(); h.addCard(55); await h.start(); await h.pulse({ sourcePaused: true });
  await h.pulse({ sourcePaused: false, pipeline: { outstandingTotal: 600 } }); await h.pulse({ pipeline: { outstandingTotal: 0 }, retryAt: 110000 });
  assert.equal(h.messages.length, 0); assert.equal(h.scrolls.length, 0);
  h.advance(10001); await h.pulse({ retryAt: 0 }); assert.equal(h.messages.length, 1); assert.equal(h.scrolls.length, 1);
});
test('Stop tab and global stop block pulses; resume continues without duplicate discovery', async () => {
  const h = harness(); h.addCard(55); await h.start(); await h.pulse({ tabPaused: true }); assert.equal(h.messages.length, 0);
  await h.pulse({ tabPaused: false }); assert.equal(h.messages.length, 1);
  h.root.scrollTop = 0; h.addCard(66); h.advance(2500); await h.pulse({ enabled: false, active: false }); assert.equal(h.messages.length, 1);
  await h.pulse({ enabled: true, active: true }); assert.deepEqual(h.messages[1].cards.map(item => item.id), ['66']);
});
test('nested galleries scroll their container instead of the page', async () => {
  const h = harness(), gallery = h.nested(); h.addCard(55, { parent: gallery, scrolling: gallery }); h.addCard(66, { parent: gallery, scrolling: gallery, top: 550 }); await h.start(); await h.pulse();
  assert.deepEqual(h.messages[0].cards.map(item => item.id), ['55'], 'Cards clipped by the nested viewport wait until scrolled into view');
  assert.equal(h.scrolls[0].root, gallery); assert.equal(gallery.scrollTop, 360); assert.equal(h.root.scrollTop, 0);
});
test('manual feed mode may scroll a gallery but does not duplicate its metadata work', async () => {
  const h = harness(); h.addCard(55); await h.start(); await h.pulse({ manualPaused: true, pending: 151, pendingTotal: 151, manualProgress: { processed: 0, pending: 12 } });
  assert.equal(h.messages.length, 0); assert.equal(h.scrolls.length, 1);
  h.root.scrollTop = 0; h.advance(60000); await h.pulse(); assert.equal(h.scrolls.length, 1, 'One viewport until twelve more metadata jobs complete');
  await h.pulse({ manualProgress: { processed: 12, pending: 12 } }); assert.equal(h.scrolls.length, 2);
});

test('explicit manual feeds may scroll while automatic browsing is off, honoring Stop and source cooldown', async () => {
  const h = harness(); h.addCard(55); await h.start();
  await h.pulse({ enabled: false, active: false, manualPaused: true, scrollAllowed: true, manualProgress: { processed: 0, pending: 12 } });
  assert.equal(h.scrolls.length, 1); assert.equal(h.messages.length, 0);
  h.root.scrollTop = 0; h.advance(3000);
  await h.pulse({ sourcePaused: true, manualProgress: { processed: 12, pending: 12 } }); assert.equal(h.scrolls.length, 1);
  await h.pulse({ sourcePaused: false, tabPaused: true }); assert.equal(h.scrolls.length, 1);
  await h.pulse({ tabPaused: false }); assert.equal(h.scrolls.length, 2);
});
test('image details collect the visible original without scrolling and seen IDs expire', async () => {
  const h = harness('https://civitai.com/images/88'); const image = h.node('IMG', h.body);
  Object.assign(image, { currentSrc: 'https://imagecache.civitai.com/key/88/width=450/88.jpg', naturalWidth: 1000, naturalHeight: 1500, getBoundingClientRect: () => ({ width: 600, height: 750, top: 20, bottom: 770, left: 20, right: 620 }) });
  await h.start(); await h.pulse(); assert.deepEqual(h.messages[0].cards.map(item => item.id), ['88']); assert.equal(h.scrolls.length, 0);
  h.advance(86400001); await h.pulse(); assert.equal(h.messages.length, 2);
});
test('creator, editor, upload, settings and unknown routes never collect or scroll', async () => {
  for (const path of ['/models/create', '/models/2970908/edit', '/posts/create', '/upload', '/settings', '/generate', '/account', '/unknown']) {
    const h = harness(`https://civitai.red${path}`); h.addCard(55); await h.start(); await h.pulse();
    assert.equal(h.messages.length, 0, path); assert.equal(h.scrolls.length, 0, path);
  }
});
test('model upload wizard steps never collect or scroll, while an ordinary wizard model slug remains allowed', async () => {
  const editor = harness('https://civitai.red/models/3001286/wizard?step=3');
  editor.addCard(55); await editor.start(); await editor.pulse();
  assert.equal(editor.messages.length, 0); assert.equal(editor.scrolls.length, 0);
  const gallery = harness('https://civitai.red/models/3001286/wizard');
  gallery.addCard(55); await gallery.start(); await gallery.pulse();
  assert.deepEqual(gallery.messages[0].cards.map(card => card.id), ['55']); assert.equal(gallery.scrolls.length, 1);
});
test('SPA route changes reset discovery while protected routes remain untouched', async () => {
  const h = harness('https://civitai.red/models/create'); h.addCard(55); await h.start(); await h.pulse();
  h.location.pathname = '/models/2970908/krea2-sickrealism'; await h.pulse(); assert.equal(h.messages[0].pageUrl, 'https://civitai.red/models/2970908/krea2-sickrealism');
  h.location.pathname = '/models/create'; h.addCard(66); h.advance(3000); await h.pulse(); assert.equal(h.messages.length, 1); assert.equal(h.scrolls.length, 1);
});
test('same-version injection is idempotent and a previous observer is disposed on replacement', async () => {
  const h = harness(); h.addCard(55); await h.start(); await h.start(); assert.equal(h.statusCalls(), 1); assert.equal(h.listeners.size, 1);
  h.context.window.__ISS_BROWSE_OBSERVER.version = '2.8.2'; await h.start(); assert.equal(h.statusCalls(), 2); assert.equal(h.listeners.size, 1); assert.equal(h.intervals.size, 1);
  await h.pulse(); assert.equal(h.messages.length, 1);
  h.context.window.__ISS_BROWSE_OBSERVER.dispose(); await h.pulse(); assert.equal(h.messages.length, 1); assert.equal(h.listeners.size, 0); assert.equal(h.timers.size, 0);
});
test('legacy boolean guard no longer prevents updated observer installation', async () => {
  const h = harness(); h.context.window.__ISS_BROWSE_OBSERVER = true; await h.start(); assert.equal(h.context.window.__ISS_BROWSE_OBSERVER.version, '2.8.12');
  const rejected = harness('https://civitai.red.evil.example/'); await rejected.start(); assert.equal(rejected.statusCalls(), 0);
});
test('navigation during card submission never scrolls the new page using stale work', async () => {
  const h = harness(); h.addCard(55); let finish; h.respond(() => new Promise(resolve => { finish = resolve; }));
  await h.start(); await h.pulse(); h.location.pathname = '/models/create'; finish({ ok: true, accepted: ['55'], active: true }); await h.pulse();
  assert.equal(h.scrolls.length, 0);
});
test('a late card response cannot undo a newer Stop tab pulse', async () => {
  const h = harness(); h.addCard(55); let finish; h.respond(() => new Promise(resolve => { finish = resolve; }));
  await h.start(); await h.pulse(); const oldStatus = { ...h.status };
  await h.pulse({ tabPaused: true, active: false, scrollAllowed: false });
  finish({ ok: true, accepted: ['55'], active: true, status: oldStatus }); await h.tick();
  assert.equal(h.scrolls.length, 0); assert.equal(h.messages.length, 1);
});
test('unaccepted cards stay in the viewport and are retried before scrolling', async () => {
  const h = harness(); h.addCard(55); h.respond(() => ({ ok: true, active: true, accepted: [] })); await h.start(); await h.pulse();
  assert.equal(h.scrolls.length, 0); h.respond(null); await h.pulse(); assert.equal(h.messages.length, 2); assert.equal(h.scrolls.length, 1);
});
test('bounded DOM walk continues across pulses on long pages', async () => {
  const h = harness(); for (let id = 0; id < 1700; id++) h.node('SPAN', h.body); h.addCard(55); await h.start(); await h.pulse();
  assert.equal(h.messages.length, 0); await h.pulse(); assert.deepEqual(h.messages[0].cards.map(item => item.id), ['55']);
});
test('WebP cards remain eligible and scrolling is paced across repeated pulses', async () => {
  const h = harness(); h.addCard(55, { src: 'https://image.civitai.com/key/55/width=450/55.webp' }); await h.start(); await h.pulse();
  h.root.scrollTop = 0; await h.pulse(); assert.equal(h.scrolls.length, 1); h.advance(2000); await h.pulse(); assert.equal(h.scrolls.length, 2);
});

test('live speed changes adjust scroll pacing without resetting discovered IDs', async () => {
  const h = harness(); h.addCard(55); await h.start(); await h.pulse();
  h.root.scrollTop = 0; h.advance(400);
  await h.pulse({ collectionSpeed: { multiplier: 5 } });
  assert.equal(h.scrolls.length, 2, '5x allows the next viewport after400ms');
  assert.equal(h.messages.length, 1, 'changing speed does not submit seen cards again');
  h.root.scrollTop = 0; h.advance(400);
  await h.pulse({ collectionSpeed: { multiplier: 1 } }); assert.equal(h.scrolls.length, 2);
  h.advance(1600); await h.pulse(); assert.equal(h.scrolls.length, 3, 'returning to1x restores2s pacing');
});

test('5x discovery stays bounded and respects the shared600 queue limit and cooldown', async () => {
  const h = harness(); for (let id=1; id<=105; id++) h.addCard(id); await h.start();
  await h.pulse({ collectionSpeed: { multiplier: 5 } });
  assert.equal(h.messages[0].cards.length, 100); assert.equal(h.scrolls.length, 0);
  await h.pulse({ pipeline: { outstandingTotal: 600 } }); assert.equal(h.messages.length, 1);
  await h.pulse({ pipeline: { outstandingTotal: 0 }, sourcePaused: true }); assert.equal(h.messages.length, 1);
  await h.pulse({ sourcePaused: false, retryAt: 105000 }); assert.equal(h.messages.length, 1);
  h.advance(5000); await h.pulse({ retryAt: 0 });
  assert.equal(h.messages[1].cards.length, 5); assert.equal(h.scrolls.length, 1);
});

test('a speed change cannot resume stopped tabs or scroll protected forms', async () => {
  const h = harness(); h.addCard(55); await h.start();
  await h.pulse({ tabPaused: true, collectionSpeed: { multiplier: 5 } });
  assert.equal(h.messages.length, 0); assert.equal(h.scrolls.length, 0);
  const form = harness('https://civitai.red/models/3001286/wizard?step=3');
  form.addCard(55); await form.start(); await form.pulse({ collectionSpeed: { multiplier: 5 } });
  assert.equal(form.messages.length, 0); assert.equal(form.scrolls.length, 0);
});

test('global six-hundred outstanding cap stops every tab and resumes as soon as capacity is available', async () => {
  for (const manualPaused of [false, true]) {
    const h = harness(); h.addCard(55); await h.start();
    await h.pulse({ manualPaused, pipeline: { outstandingTotal: 600 }, pending: 1, pendingTotal: 1 });
    assert.equal(h.messages.length, 0); assert.equal(h.scrolls.length, 0);
    await h.pulse({ pipeline: { outstandingTotal: 599 }, pending: 40, pendingTotal: 200 });
    assert.equal(h.scrolls.length, 1, 'Old per-tab36/global144 thresholds do not block available global capacity');
  }
});

test('the acceptance response prevents an extra scroll when its last card fills global capacity', async () => {
  const h = harness(); h.addCard(55); await h.start();
  h.respond(() => ({ ok: true, active: true, accepted: ['55'], pipeline: { outstandingTotal: 600 } }));
  await h.pulse({ pipeline: { outstandingTotal: 599 } });
  assert.equal(h.messages.length, 1); assert.equal(h.scrolls.length, 0);
});

function reactionButton(h, parent, text, attributes = {}) {
  const button = h.node('BUTTON', parent); button.textContent = text;
  button.getAttribute = key => attributes[key] ?? null; return button;
}
test('each gallery card captures only its own exact reaction counts including zero', async () => {
  const h = harness(), first = h.addCard(55), second = h.addCard(56);
  reactionButton(h, first.wrapper, '👍 120'); reactionButton(h, first.wrapper, '❤️ 0');
  reactionButton(h, second.wrapper, '👍 999'); reactionButton(h, second.wrapper, '😂 12');
  await h.start(); await h.pulse();
  assert.deepEqual(h.messages[0].cards.map(card => card.reactions), [{ likeCount: 120, heartCount: 0 }, { likeCount: 999, laughCount: 12 }]);
});
test('icon titles identify reactions while rounded, absent and conflicting values stay unknown', async () => {
  const h = harness(), card = h.addCard(55);
  const button = reactionButton(h, card.wrapper, '24'), icon = h.node('SVG', button);
  icon.getAttribute = key => key === 'class' ? 'tabler-icon tabler-icon-thumb-up' : null;
  reactionButton(h, card.wrapper, '❤️ 1.2K'); reactionButton(h, card.wrapper, '😢');
  reactionButton(h, card.wrapper, '😂 3'); reactionButton(h, card.wrapper, '😂 7');
  reactionButton(h, card.wrapper, '⚡ 1,500');
  await h.start(); await h.pulse();
  assert.deepEqual(h.messages[0].cards[0].reactions, { likeCount: 24, buzzCount: 1500 });
});
test('counts hydrated after discovery are submitted once without another image queue admission', async () => {
  const h = harness(), card = h.addCard(55); await h.start(); await h.pulse();
  h.root.scrollTop = 0; reactionButton(h, card.wrapper, '👍 8');
  await h.pulse(); assert.equal(h.messages.length, 2);
  assert.deepEqual(h.messages[1].cards[0].reactions, { likeCount: 8 });
  h.root.scrollTop = 0; await h.pulse(); assert.equal(h.messages.length, 2);
});
test('manual feeds report reaction-only cards without adding automatic metadata work', async () => {
  const h = harness(), card = h.addCard(55); reactionButton(h, card.wrapper, '👍 0');
  await h.start(); await h.pulse({ manualPaused: true });
  assert.equal(h.messages.length, 1); assert.equal(h.messages[0].reactionsOnly, true);
  assert.deepEqual(h.messages[0].cards[0].reactions, { likeCount: 0 });
});
test('server-rendered stats require the exact image query ID and never borrow post stats', async () => {
  const h = harness('https://civitai.red/images/55'), card = h.addCard(55);
  reactionButton(h, card.wrapper, '👍 3');
  const queries = [
    { queryKey: [['image', 'get'], { input: { id: 55 } }], state: { data: { id: 55, type: 'image', stats: { likeCountAllTime: 1234, heartCountAllTime: 0 } } } },
    { queryKey: [['post', 'get'], { input: { id: 55 } }], state: { data: { id: 55, stats: { likeCountAllTime: 999 } } } },
    { queryKey: [['image', 'get'], { input: { id: 56 } }], state: { data: { id: 55, stats: { likeCountAllTime: 777 } } } }
  ];
  h.document.getElementById = () => ({ textContent: JSON.stringify({ props: { pageProps: { trpcState: { json: { queries } } } } }) });
  await h.start(); await h.pulse();
  assert.deepEqual(h.messages[0].cards[0].reactions, { likeCount: 1234, heartCount: 0 });
});
