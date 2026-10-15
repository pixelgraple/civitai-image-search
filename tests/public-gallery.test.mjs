import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../server/public/app.js', import.meta.url), 'utf8');
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
class Element {
  constructor(id = '') { this.id = id; this.value = ''; this.innerHTML = ''; this.textContent = ''; this.dataset = {}; this.disabled = false; this.open = false; this.hidden = false; this.attributes = {}; this.listeners = new Map(); this.classes = new Set(); this.children = []; this.classList = { add: value => this.classes.add(value), remove: value => this.classes.delete(value), toggle: (value, enabled) => enabled ? this.classes.add(value) : this.classes.delete(value) }; }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(type, handler) { this.listeners.set(type, [...(this.listeners.get(type) || []), handler]); }
  dispatch(type, event = {}) { for (const handler of this.listeners.get(type) || []) handler({ target: this, preventDefault() {}, ...event }); }
  querySelectorAll(selector) {
    if (selector === '[data-reaction]') {
      this.reactionButtons ??= ['upvote','heart','laugh','wow'].map(type => { const button = new Element(); button.dataset.reaction = type; return button; });
      return this.reactionButtons;
    }
    return this.children;
  }
  querySelector(selector) {
    if (selector === '.detail-identity') return { insertAdjacentHTML: (_position, html) => { this.innerHTML += html; } };
    const type = selector.match(/^\[data-reaction="(\w+)"\]$/)?.[1];
    if (type) return this.querySelectorAll('[data-reaction]').find(button => button.dataset.reaction === type);
    this.descendants ??= new Map();
    if (!this.descendants.has(selector)) this.descendants.set(selector, new Element());
    return this.descendants.get(selector);
  }
  focus() { this.focused = true; }
  showModal() { this.open = true; }
  close() { this.open = false; this.dispatch('close'); }
  closest() { return null; }
}
const clickTarget = (selector, element) => ({ closest: candidate => candidate === selector ? element : null });
function image(id, extra = {}) { return { id: String(id), previewUrl: `media.php?id=${id}&variant=thumb`, downloadUrl: `media.php?id=${id}`, prompt: `portrait ${id}`, negativePrompt: '', modelName: 'Example checkpoint', loras: [], tags: ['portrait'], category: 'realistic', confidence: .9, downloadStatus: 'ready', reactions: {}, width: 768, height: 1152, ...extra }; }
function searchResult(items, page = 1, total = items.length, categoryCounts = { anime: 0, realistic: total, uncertain: 0 }) { return { ok: true, items, page, total, pages: Math.ceil(total / 42), categoryCounts }; }
function harness(respond, { preview = false, reactionRespond = null } = {}) {
  const elements = new Map();
  const get = id => { if (!elements.has(id)) elements.set(id, new Element(id)); return elements.get(id); };
  get('counts').children = ['', 'anime', 'realistic', 'uncertain'].map(category => { const value = new Element(); value.dataset.category = category; return value; });
  get('topics').children = ['', 'selfie', 'portrait'].map(query => { const value = new Element(); value.dataset.query = query; return value; });
  const calls = [], copied = [], body = new Element('body');
  const context = vm.createContext({ URL, URLSearchParams, AbortController, setTimeout, clearTimeout, Set, Number, String, Object, Array, Math, location: { href: `https://search-civitai.xyz/${preview ? '?preview=layout' : ''}`, origin: 'https://search-civitai.xyz' }, document: { getElementById: get, createElement: tag => new Element(tag), activeElement: new Element('active'), body }, window: { scrollTo() {} }, navigator: { clipboard: { writeText: async text => copied.push(text) } }, fetch: async (url, options) => {
    const parsed = new URL(url, 'https://search-civitai.xyz/'); calls.push({ params: parsed.searchParams, options });
    if (parsed.searchParams.get('action') === 'health') return { ok: true, status: 200, json: async () => ({ ok: true, counts: { total: 43, ready: 43 } }) };
    if (parsed.searchParams.get('action') === 'reactions') {
      const result = reactionRespond ? await reactionRespond(parsed.searchParams, options, calls) : { ok: true, imageId: parsed.searchParams.get('id'), counts: { upvote: 0, heart: 0, laugh: 0, wow: 0 }, mine: { upvote: false, heart: false, laugh: false, wow: false }, csrfToken: 'fixture-csrf' };
      return { ok: !result.status || result.status < 400, status: result.status || 200, json: async () => result.data || result };
    }
    const response = await respond(parsed.searchParams, options, calls);
    return { ok: response.status ? response.status < 400 : true, status: response.status || 200, json: async () => response.data || response };
  } });
  vm.runInContext(source, context);
  const open = index => { const button = new Element(); button.dataset.index = String(index); get('results').dispatch('click', { target: clickTarget('.gallery-open', button) }); return button; };
  return { get, calls, copied, body, open };
}

const reactionResult = (id, counts = {}, mine = {}) => ({ ok: true, imageId: String(id), counts: { upvote: 0, heart: 0, laugh: 0, wow: 0, ...counts }, mine: { upvote: false, heart: false, laugh: false, wow: false, ...mine }, csrfToken: 'fixture-csrf' });
const react = (h, type) => {
  const button = h.get('viewerReactions').querySelector(`[data-reaction="${type}"]`);
  h.get('viewerReactions').dispatch('click', { target: clickTarget('[data-reaction]', button) });
  return button;
};

test('community votes load, save once while pending, and can be removed without mixing source stats', async () => {
  let finishWrite, selected = false;
  const h = harness(() => searchResult([image(1, { reactions: { likeCount: 77 } })]), { reactionRespond: async (params, options) => {
    if (options.method !== 'POST') return reactionResult(1, { upvote: Number(selected) }, { upvote: selected });
    const body = JSON.parse(options.body);
    assert.equal(body.csrfToken, 'fixture-csrf'); assert.equal(body.type, 'upvote'); assert.equal(body.id, '1');
    await new Promise(resolve => { finishWrite = resolve; }); selected = body.active;
    return reactionResult(1, { upvote: Number(selected) }, { upvote: selected });
  } });
  await flush(); h.open(0); await flush();
  const button = react(h, 'upvote'); assert.equal(button.disabled, true);
  react(h, 'upvote');
  assert.equal(h.calls.filter(call => call.options.method === 'POST').length, 1);
  finishWrite(); await flush();
  assert.equal(button.attributes['aria-pressed'], 'true'); assert.equal(button.querySelector('[data-reaction-count]').textContent, '1');
  assert.match(h.get('viewerDetails').innerHTML, /77 Civitai likes/);
  react(h, 'upvote'); finishWrite(); await flush();
  assert.equal(button.attributes['aria-pressed'], 'false'); assert.equal(button.querySelector('[data-reaction-count]').textContent, '0');
  h.get('closeViewer').dispatch('click'); h.open(0); await flush();
  assert.equal(h.calls.filter(call => call.params.get('action') === 'reactions' && call.options.method === 'GET').length, 2);
});

test('late reaction response cannot replace selections for a newly opened image', async () => {
  let resolveFirst;
  const h = harness(() => searchResult([image(1), image(2)]), { reactionRespond: params => params.get('id') === '1' ? new Promise(resolve => { resolveFirst = resolve; }) : reactionResult(2, { heart: 3 }, { heart: true }) });
  await flush(); h.open(0); h.get('viewerNext').dispatch('click'); await flush();
  resolveFirst(reactionResult(1, { upvote: 90 }, { upvote: true })); await flush();
  assert.match(h.get('viewerDetails').innerHTML, /Image #2/);
  assert.equal(h.get('viewerReactions').querySelector('[data-reaction="heart"]').attributes['aria-pressed'], 'true');
  assert.equal(h.get('viewerReactions').querySelector('[data-reaction="upvote"]').attributes['aria-pressed'], 'false');
});

test('reaction failures disable writes until retry refreshes server state', async () => {
  let fail = true;
  const h = harness(() => searchResult([image(1)]), { reactionRespond: () => fail ? { status: 503, data: { ok: false, error: 'Please retry' } } : reactionResult(1) });
  await flush(); h.open(0); await flush();
  assert.equal(h.get('communityStatus').textContent, 'Please retry'); assert.equal(h.get('retryReactions').hidden, false);
  react(h, 'heart'); assert.equal(h.calls.filter(call => call.options.method === 'POST').length, 0);
  fail = false; h.get('viewerReactions').dispatch('click', { target: clickTarget('#retryReactions', h.get('retryReactions')) }); await flush();
  assert.equal(h.get('retryReactions').hidden, true); assert.equal(h.get('viewerReactions').querySelector('[data-reaction="heart"]').disabled, false);
});

test('layout preview cannot read or submit reactions and sort survives filtering', async () => {
  const preview = harness(() => searchResult([image(1)]), { preview: true }); await flush(); preview.open(0); await flush(); react(preview, 'upvote');
  assert.equal(preview.calls.filter(call => call.params.get('action') === 'reactions').length, 0);
  assert.match(preview.get('communityStatus').textContent, /read-only/);
  const h = harness(() => searchResult([image(1)])); await flush();
  h.get('sort').value = 'upvotes'; h.get('sort').dispatch('change'); await flush();
  h.get('query').value = 'selfie'; h.get('searchForm').dispatch('submit'); await flush();
  assert.equal(h.calls.at(-1).params.get('sort'), 'upvotes'); assert.equal(h.calls.at(-1).params.get('q'), 'selfie');
});

test('desktop gallery renders uncropped local image cards, captured reactions and separate source links without exposing prompts in cards', async () => {
  const h = harness(() => searchResult([image(1, { prompt: '<img src=x onerror=evil()>', reactions: { likeCount: 424, heartCount: 317, laughCount: 29, cryCount: null, buzzCount: 0 } }), image(2)]));
  await flush();
  const html = h.get('results').innerHTML;
  assert.match(html, /width="768" height="1152"/);
  assert.match(html, /https:\/\/search-civitai.xyz\/media.php\?id=1&amp;variant=thumb/);
  assert.match(html, /gallery-open/); assert.match(html, /source-link/);
  assert.match(html, /424 Civitai likes/); assert.match(html, /317 Civitai hearts/);
  assert.doesNotMatch(html, /Civitai cries/); assert.doesNotMatch(html, /onerror|portrait 2/);
  assert.match(html, /reaction-unavailable">#2/);
  assert.equal(h.get('resultCount').textContent, '2 matching images · 1–2');
  assert.equal(h.get('health').textContent, '43 indexed · 43 stored');
});

test('detail viewer opens original local image with safely escaped prompts/resources, copy and source download controls', async () => {
  const prompt = 'portrait <script>alert("test")</script> & lighting';
  const h = harness(() => searchResult([image(99, { prompt, negativePrompt: '<bad>', modelName: '<model>', loras: ['<LoRA>'], tags: ['portrait', '<tag>'] })]));
  await flush(); const opener = h.open(0);
  assert.equal(h.get('imageViewer').open, true); assert.equal(h.body.classes.has('viewer-open'), true);
  assert.match(h.get('viewerMedia').innerHTML, /src="https:\/\/search-civitai.xyz\/media.php\?id=99"/);
  assert.match(h.get('viewerDetails').innerHTML, /&lt;script&gt;/);
  assert.doesNotMatch(h.get('viewerDetails').innerHTML, /<script>|<model>|<LoRA>|<tag>/);
  assert.equal(h.get('viewerDownload').hidden, false); assert.equal(h.get('viewerSource').href, 'https://civitai.red/images/99');
  const copy = new Element(); h.get('viewerDetails').dispatch('click', { target: clickTarget('#copyPrompt', copy) }); await flush();
  assert.deepEqual(h.copied, [prompt]); assert.equal(copy.textContent, 'Copied');
  h.get('closeViewer').dispatch('click');
  assert.equal(h.get('imageViewer').open, false); assert.equal(h.body.classes.has('viewer-open'), false); assert.equal(opener.focused, true);
});

test('viewer arrows cross result pages and return to the previous page without losing search filters', async () => {
  const pageOne = Array.from({ length: 42 }, (_, index) => image(100 - index));
  const h = harness(params => Number(params.get('page')) === 2 ? searchResult([image(58)], 2, 43) : searchResult(pageOne, 1, 43));
  await flush(); h.open(41); assert.equal(h.get('viewerPosition').textContent, '42 / 43');
  h.get('viewerNext').dispatch('click'); await flush();
  assert.equal(h.get('viewerPosition').textContent, '43 / 43'); assert.equal(h.get('viewerNext').disabled, true); assert.match(h.get('viewerDetails').innerHTML, /Image #58/);
  h.get('viewerPrev').dispatch('click'); await flush();
  assert.equal(h.get('viewerPosition').textContent, '42 / 43'); assert.equal(h.get('viewerNext').disabled, false);
  assert.deepEqual(h.calls.filter(call => call.params.get('action') === 'search').map(call => call.params.get('page')), ['1', '2', '1']);
});

test('topic/style/exact-tag filters update search and viewer tag links preserve the current keyword', async () => {
  const h = harness(() => searchResult([image(1, { tags: ['beach'] })])); await flush();
  const topic = new Element(); topic.dataset.query = 'selfie'; h.get('topics').dispatch('click', { target: clickTarget('[data-query]', topic) }); await flush();
  const category = new Element(); category.dataset.category = 'anime'; h.get('counts').dispatch('click', { target: clickTarget('[data-category]', category) }); await flush();
  h.open(0); const tag = new Element(); tag.dataset.tag = 'beach'; h.get('viewerDetails').dispatch('click', { target: clickTarget('[data-tag]', tag) }); await flush();
  const last = h.calls.at(-1).params;
  assert.equal(last.get('q'), 'selfie'); assert.equal(last.get('category'), 'anime'); assert.equal(last.get('tag'), 'beach'); assert.equal(last.get('page'), '1');
  assert.equal(h.get('imageViewer').open, false);
  h.get('clearFilters').dispatch('click'); await flush();
  assert.equal(h.calls.at(-1).params.get('q'), ''); assert.equal(h.calls.at(-1).params.get('category'), ''); assert.equal(h.calls.at(-1).params.get('tag'), '');
});

test('missing image copies and foreign or mismatched media URLs keep indexed details available without remote image requests', async () => {
  const h = harness(() => searchResult([image(1, { previewUrl: 'https://elsewhere.invalid/image.jpg', downloadUrl: 'media.php?id=2', downloadStatus: 'pending', reactions: {} })])); await flush();
  assert.doesNotMatch(h.get('results').innerHTML, /<img/); assert.match(h.get('results').innerHTML, /Image copy is processing/);
  h.open(0); assert.equal(h.get('viewerDownload').hidden, true); assert.doesNotMatch(h.get('viewerMedia').innerHTML, /<img/); assert.match(h.get('viewerDetails').innerHTML, /portrait 1/);
  assert.match(h.get('viewerDetails').innerHTML, /not available when indexed/);
});

test('empty and failed searches offer useful recovery and escape server error text', async () => {
  let failing = false;
  const h = harness(() => failing ? { status: 503, data: { ok: false, error: '<script>server failure</script>' } } : searchResult([])); await flush();
  assert.match(h.get('results').innerHTML, /No matching images/); assert.equal(h.get('pagination').innerHTML, '');
  failing = true; h.get('searchForm').dispatch('submit'); await flush();
  assert.match(h.get('results').innerHTML, /retrySearch/); assert.match(h.get('results').innerHTML, /&lt;script&gt;server failure&lt;\/script&gt;/); assert.doesNotMatch(h.get('results').innerHTML, /<script>/);
  assert.equal(h.get('results').attributes['aria-busy'], 'false');
});

test('a stale search response cannot overwrite newer selected filters and results', async () => {
  let resolveOld;
  const h = harness(params => params.get('q') === 'old' ? new Promise(resolve => { resolveOld = resolve; }) : searchResult([image(params.get('q') === 'new' ? 2 : 1)])); await flush();
  h.get('query').value = 'old'; h.get('searchForm').dispatch('submit'); await flush();
  h.get('query').value = 'new'; h.get('searchForm').dispatch('submit'); await flush();
  resolveOld(searchResult([image(3)])); await flush();
  assert.match(h.get('results').innerHTML, /data-index="0" aria-label="View image 2/); assert.doesNotMatch(h.get('results').innerHTML, /View image 3/); assert.equal(h.get('activeFilters').textContent, '“new”');
});

test('layout preview fills 48 cards from one stored image, labels example reactions and preserves real health/style counts', async () => {
  const h = harness(() => searchResult([image(91, { reactions: {} })]), { preview: true }); await flush();
  assert.equal(h.get('layoutPreview').hidden, false);
  assert.equal((h.get('results').innerHTML.match(/class="image-card"/g) || []).length, 48);
  assert.match(h.get('results').innerHTML, /width="768" height="1152"/);
  assert.match(h.get('results').innerHTML, /424 sample likes/);
  assert.match(h.get('previewDescription').textContent, /48 repeated cards from stored image #91/);
  assert.match(h.get('previewDescription').textContent, /labeled Sample are examples/);
  assert.equal(h.get('resultCount').textContent, '48 preview cards · 1 real stored image · not library counts');
  assert.equal(h.get('health').textContent, '43 indexed · 43 stored');
  assert.match(h.get('counts').children[2].innerHTML, /<span>1<\/span>/);
  assert.equal(h.calls.filter(call => call.params.get('action') === 'search').length, 1);
  assert.equal(h.calls.at(-1).params.get('limit'), '48');
  h.open(47); assert.equal(h.get('viewerPosition').textContent, '48 / 48'); assert.equal(h.get('viewerNext').disabled, true);
  assert.equal(h.get('viewerSource').href, 'https://civitai.red/images/91'); assert.equal(h.get('viewerDownload').href, 'https://search-civitai.xyz/media.php?id=91');
  h.get('viewerPrev').dispatch('click'); assert.equal(h.get('viewerPosition').textContent, '47 / 48');
});

test('layout preview uses genuine reaction stats when present and excludes pending/foreign media as sample candidates', async () => {
  const h = harness(() => searchResult([image(1, { downloadStatus: 'pending' }), image(2, { previewUrl: 'https://foreign.invalid/2.png' }), image(3, { reactions: { likeCount: 17 } })]), { preview: true }); await flush();
  assert.match(h.get('previewDescription').textContent, /stored image #3/);
  assert.match(h.get('results').innerHTML, /17 Civitai likes/);
  assert.doesNotMatch(h.get('results').innerHTML, /sample-reaction-label|424 sample likes/);
  assert.match(h.get('previewDescription').textContent, /captured source counts/);
});

test('layout preview without a ready local sample remains honest and normal mode never repeats cards', async () => {
  const preview = harness(() => searchResult([image(1, { downloadStatus: 'pending', previewUrl: '' })]), { preview: true }); await flush();
  assert.match(preview.get('previewDescription').textContent, /No stored image matches/);
  assert.equal(preview.get('resultCount').textContent, '0 preview cards');
  const normal = harness(() => searchResult([image(1)])); await flush();
  assert.equal(normal.get('layoutPreview').hidden, true); assert.equal((normal.get('results').innerHTML.match(/class="image-card"/g) || []).length, 1);
  assert.doesNotMatch(normal.get('results').innerHTML, /sample-reaction-label/);
  assert.equal(normal.get('resultCount').textContent, '1 matching image · 1–1');
});
