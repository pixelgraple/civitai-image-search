import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../background-feed.js', import.meta.url), 'utf8');
function loadFeed(payload) {
  const context = vm.createContext({ URL, structuredClone, Date, JSON, Set, Array, Object, String, RegExp, Number, AbortController, setTimeout, clearTimeout, Response });
  context.globalThis = context;
  context.ISSDevalue = { parse: value => JSON.parse(value) };
  context.fetch = async url => {
    const procedure = new URL(url).pathname.split('/').pop();
    const data = procedure === 'image.getGenerationData' ? { type: 'image', resources: [] }
      : procedure === 'image.getDetail' ? { tags: [] } : payload;
    return new Response(JSON.stringify({ result: { data: { json: data } } }), { status: 200 });
  };
  vm.runInContext(source, context);
  return context.ISSFeed;
}
function requestUrl() {
  const url = new URL('https://civitai.red/api/trpc/image.getInfinite');
  url.searchParams.set('input', JSON.stringify({ json: { browsingLevel: 1, sort: 'Newest' } }));
  return url.href;
}

test('all-time reaction aliases override generic zero defaults', () => {
  const feed = loadFeed({});
  assert.deepEqual(JSON.parse(JSON.stringify(feed.imageReactions({ likeCount: 0, likeCountAllTime: 44, heartCount: 0, heartCountAllTime: 32 }))),
    { likeCount: 44, heartCount: 32 });
});

test('indexes image URL, prompt, negative prompt, tags, model, and LoRA from a feed page', async () => {
  const image = { id: 135960467, type: 'image', url: 'https://image.civitai.com/key/abc/width=450/135960467.jpg',
    meta: { prompt: 'selfie, anime style', negativePrompt: 'blurry', modelName: 'Anime checkpoint', resources: [{ type: 'lora', name: 'Blue Hair LoRA' }] } };
  const feed = loadFeed({ items: [{ id: 77, tags: [{ name: 'selfie' }, 'anime'], images: [image] }], nextCursor: null });
  const query = feed.fromRequests('civitai', 'https://civitai.red/images', [requestUrl()]);
  const page = await feed.next(query);
  assert.equal(page.items.length, 1);
  assert.match(page.items[0].url, /original=true/);
  assert.equal(page.catalogItems[0].id, '135960467');
  assert.equal(page.catalogItems[0].pageUrl, 'https://civitai.red/images/135960467');
  assert.equal(page.catalogItems[0].prompt, 'selfie, anime style');
  assert.equal(page.catalogItems[0].negativePrompt, 'blurry');
  assert.deepEqual(Array.from(page.catalogItems[0].tags), ['selfie', 'anime']);
  assert.equal(page.catalogItems[0].modelName, 'Anime checkpoint');
  assert.deepEqual(Array.from(page.catalogItems[0].loras), ['Blue Hair LoRA']);
});

test('returns raw promptless candidates so collection can skip them or reuse a known prompt', async () => {
  const feed = loadFeed({ items: [{ id: 43, images: [{ id: 55, type: 'image', url: 'https://image.civitai.com/key/abc/width=450/55.png' }] }], nextCursor: null });
  const query = feed.fromRequests('civitai', 'https://civitai.red/images', [requestUrl()]);
  const page = await feed.next(query);
  assert.equal(page.catalogItems.length, 1);
  assert.equal(page.catalogItems[0].prompt, '');
  assert.equal(page.catalogItems[0].downloadUrl.includes('original=true'), true);
});

test('Civitai WebP originals remain valid prompt-bearing catalog candidates', async () => {
  const feed = loadFeed({items:[{id:55,type:'image',url:'https://image.civitai.com/key/abc/width=450/55.webp',meta:{prompt:'selfie',modelName:'Realistic model',resources:[]},tags:['selfie']}],nextCursor:null});
  const query = feed.fromRequests('civitai','https://civitai.red/images',[requestUrl()]);
  const page = await feed.next(query);
  assert.equal(page.catalogItems.length,1);
  assert.match(page.catalogItems[0].downloadUrl,/original=true\/55\.webp$/);
});

test('does not catalog non-image resources or unsafe media hosts', async () => {
  const feed = loadFeed({ items: [{ id: 43, images: [
    { id: 1, type: 'video', url: 'https://image.civitai.com/key/a/width=450/1.jpg' },
    { id: 2, type: 'image', url: 'https://evil.example/2.jpg', meta: { prompt: 'selfie' } }
  ] }], nextCursor: null });
  const query = feed.fromRequests('civitai', 'https://civitai.red/images', [requestUrl()]);
  const page = await feed.next(query);
  assert.equal(page.catalogItems.length, 0);
  assert.equal(page.items.length, 0);
});

test('does not mutate the captured feed filters while paging', async () => {
  const feed = loadFeed({ items: [], nextCursor: null });
  const query = feed.fromRequests('civitai', 'https://civitai.red/models/123', [requestUrl()]);
  assert.deepEqual(JSON.parse(JSON.stringify(query.filters)), { browsingLevel: 1, sort: 'Newest' });
});
