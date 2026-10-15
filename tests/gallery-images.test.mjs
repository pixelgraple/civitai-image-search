import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../server/public/gallery-images.js', import.meta.url), 'utf8');
function harness({ dpr = 1, observer = true } = {}) {
  const events = new Map(), timers = new Map(), images = [];
  let intersection;
  class Observer {
    constructor(callback, options) { this.callback = callback; this.options = options; this.targets = []; intersection = this; }
    observe(img) { this.targets.push(img); }
    disconnect() { this.disconnected = true; }
  }
  const window = { innerWidth: 1920, innerHeight: 1080, devicePixelRatio: dpr,
    addEventListener: (name, fn) => events.set(name, fn), removeEventListener: name => events.delete(name) };
  if (observer) window.IntersectionObserver = Observer;
  vm.runInNewContext(source, { window, IntersectionObserver: Observer, URL,
    location: { href: 'https://search-civitai.xyz/', origin: 'https://search-civitai.xyz' },
    setTimeout: fn => { timers.set(fn, fn); return fn; }, clearTimeout: key => timers.delete(key) });
  function image(id, top, width = 260, left = 0) {
    const img = { dataset: { preview: `https://search-civitai.xyz/media.php?id=${id}&variant=thumb&av=captcha1` },
      isConnected: true, rect: { width, top, bottom: top + 390, left, right: left + width }, requests: [],
      getBoundingClientRect() { return this.rect; }, set src(value) { this.requests.push(value); } };
    images.push(img); return img;
  }
  return { window, events, image, images, mount: () => window.CivitaiGalleryImages.mount({ querySelectorAll: () => images }),
    intersect: img => intersection.callback([{ target: img, isIntersecting: true, boundingClientRect: img.rect }]),
    observer: () => intersection, resize: () => { events.get('resize')?.(); for (const fn of timers.values()) fn(); timers.clear(); } };
}

test('visible masonry columns are prioritized even when their records appear late', () => {
  const h = harness(), offscreen = h.image(1, 3000), first = h.image(2, 150), nextColumn = h.image(31, 150, 260, 1500), near = h.image(32, 1200);
  h.mount();
  assert.equal(offscreen.requests.length, 0);
  for (const img of [first, nextColumn]) { assert.equal(img.fetchPriority, 'high'); assert.match(img.requests[0], /w=320/); }
  assert.equal(near.fetchPriority, 'low');
  assert.equal(h.observer().options.rootMargin, '300px 0px');
});
test('high-density screens and wide cards use the larger preview', () => {
  const h = harness({ dpr: 2 }), img = h.image(1, 0); h.mount(); assert.match(img.requests[0], /w=720/);
  const wide = harness(), card = wide.image(2, 0, 400); wide.mount(); assert.match(card.requests[0], /w=720/);
});
test('scrolling loads approaching cards once without requesting originals', () => {
  const h = harness(), img = h.image(1, 5000); h.mount();
  assert.equal(img.requests.length, 0); img.rect.top = 900; h.intersect(img); h.intersect(img);
  assert.equal(img.requests.length, 1); assert.match(img.requests[0], /variant=thumb/); assert.match(img.requests[0], /av=captcha1/);
});
test('resize upgrades visible previews but never downgrades or fetches distant cards', () => {
  const h = harness(), img = h.image(1, 0), distant = h.image(2, 5000); h.mount();
  h.window.devicePixelRatio = 2; h.resize(); assert.equal(img.requests.length, 2); assert.match(img.requests[1], /w=720/);
  h.window.devicePixelRatio = 1; h.resize(); assert.equal(img.requests.length, 2); assert.equal(distant.requests.length, 0);
});
test('pagination and locked sessions disconnect observers and ignore pending callbacks', () => {
  const h = harness(), img = h.image(1, 5000), stop = h.mount(); stop(); h.intersect(img);
  assert.equal(img.requests.length, 0); assert.equal(h.observer().disconnected, true); assert.equal(h.events.size, 0);
});
test('detached cards and foreign or original URLs cannot be fetched by the grid loader', () => {
  const h = harness(), detached = h.image(1, 0), foreign = h.image(2, 0), original = h.image(3, 0);
  detached.isConnected = false; foreign.dataset.preview = 'https://example.com/media.php?variant=thumb'; original.dataset.preview = 'https://search-civitai.xyz/media.php?id=3';
  h.mount(); assert.ok(h.images.every(img => img.requests.length === 0));
});
test('fallback without IntersectionObserver still defers distant cards', () => {
  const h = harness({ observer: false }), img = h.image(1, 5000), stop = h.mount(); assert.equal(img.requests.length, 0);
  img.rect.top = 500; img.rect.bottom = 890; h.events.get('scroll')(); assert.equal(img.requests.length, 1); stop(); assert.equal(h.events.size, 0);
});
test('page integration loads the helper before the app and disconnects on access expiry', () => {
  const index = fs.readFileSync(new URL('../server/public/index.php', import.meta.url), 'utf8');
  const app = fs.readFileSync(new URL('../server/public/app.js', import.meta.url), 'utf8');
  assert.ok(index.indexOf('gallery-images.js?v=cards1') < index.indexOf('app.js?v=cards1'));
  assert.match(app, /data-preview="\$\{esc\(preview\)\}/);
  assert.match(app, /civitai-access-change[\s\S]*stopGalleryImages\(\)/);
  assert.match(app, /mediaUrl\(row.downloadUrl, row.id\)/);
});
