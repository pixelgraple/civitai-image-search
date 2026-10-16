import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../background-feed.js', import.meta.url), 'utf8');
const tabSource = fs.readFileSync(new URL('../tab-feed-request.js', import.meta.url), 'utf8');
const pageUrl = 'https://civitai.red/models/123?modelVersionId=456';
const image = id => ({ id, type: 'image', hasMeta: true,
  url: `https://image.civitai.com/key/image-${id}/width=450/${id}.png` });
const wire = data => ({ result: { data: { json: data } } });
function harness(items, respond, endpoint = 'image.getImagesAsPostsInfinite') {
  const context = vm.createContext({ URL, structuredClone, Date, JSON, Set, Map, Array, Object, String, RegExp, Number,
    AbortController, setTimeout, clearTimeout });
  context.globalThis = context;
  context.ISSDevalue = { parse: value => JSON.parse(value) };
  vm.runInContext(source, context);
  const observed = new URL(`/api/trpc/${endpoint}`, pageUrl);
  observed.searchParams.set('input', JSON.stringify({ json: {
    modelId: 123, modelVersionId: 456, browsingLevel: 1, sort: 'Newest', include: ['cosmetics']
  } }));
  const feed = context.ISSFeed.fromRequests('civitai', pageUrl, [observed.href]);
  const calls = [];
  const request = async value => {
    const url = new URL(value);
    const procedure = url.pathname.split('/').pop();
    const input = JSON.parse(url.searchParams.get('input')).json;
    calls.push({ procedure, input, origin: url.origin });
    if (procedure === endpoint) return wire({ items, nextCursor: 'next-selected-page' });
    return respond(procedure, input);
  };
  return { feed, calls, next: (processImage, onProgress, readReactions) => context.ISSFeed.next(feed, request, processImage, onProgress, readReactions) };
}

test('missing reactions and all-zero feed snapshots are rechecked on image pages', async () => {
  const complete = { likeCount: 0, heartCount: 0, laughCount: 0, cryCount: 0 };
  const h = harness([1, 2].map(id => ({ ...image(id), tags: ['landscape'],
    meta: { prompt: 'landscape', modelName: 'Camera', resources: [] }, stats: id === 1 ? complete : { likeCount: 12 } })),
  () => { throw new Error('Unexpected metadata API request'); }, 'image.getInfinite');
  const pages = [];
  const result = await h.next(undefined, undefined, async id => { pages.push(id); return { likeCount: 13, heartCount: 2, laughCount: 0, cryCount: 0 }; });
  assert.deepEqual(pages.sort(), ['1', '2']); assert.equal(result.catalogItems[1].reactions.likeCount, 13);
  assert.deepEqual(JSON.parse(JSON.stringify(result.catalogItems[0].reactions)), { likeCount: 13, heartCount: 2, laughCount: 0, cryCount: 0 });
});
test('image-page rate rejection prevents cursor advancement rather than losing missing reactions', async () => {
  const h = harness([{ ...image(55), tags: ['landscape'], meta: { prompt: 'landscape', modelName: 'Camera', resources: [] } }],
    () => { throw new Error('Unexpected API request'); }, 'image.getInfinite');
  await assert.rejects(h.next(undefined, undefined, async () => { throw Object.assign(new Error('Page rate limit'), { status: 429 }); }), error => error.status === 429);
  assert.equal(h.feed.cursor, null);
});

test('optional reaction page metadata missing from HTTP200 or404 leaves counts unknown', async () => {
  const context = vm.createContext({ URL, structuredClone, Date, JSON, Set, Map, Array, Object, String, RegExp, Number,
    AbortController, setTimeout, clearTimeout });
  vm.runInContext(source, context);
  for (const status of [200, 404]) {
    const counts = await context.ISSFeed.civitaiPageReactions({ pageUrl }, '55', async () => {
      throw Object.assign(new Error('No matching image page metadata'), { status });
    });
    assert.deepEqual(JSON.parse(JSON.stringify(counts)), {});
    const h = harness([{ ...image(55), tags: ['landscape'], meta: { prompt: 'landscape', modelName: 'Camera', resources: [] } }],
      () => { throw new Error('Unexpected API request'); }, 'image.getInfinite');
    const page = await h.next(undefined, undefined, async () => counts);
    assert.equal(page.catalogItems[0].prompt, 'landscape'); assert.equal(page.cursor, 'next-selected-page');
    assert.deepEqual(JSON.parse(JSON.stringify(page.catalogItems[0].reactions)), {});
  }
});
test('optional reaction enrichment still propagates source rejection cooldown and cancellation', async () => {
  const context = vm.createContext({ URL, structuredClone, Date, JSON, Set, Map, Array, Object, String, RegExp, Number,
    AbortController, setTimeout, clearTimeout });
  vm.runInContext(source, context);
  for (const status of [401, 403, 409, 429, 500, 502, 503]) {
    const failure = Object.assign(new Error('Source unavailable'), { status, retryAfterMs: 60000 });
    await assert.rejects(context.ISSFeed.civitaiPageReactions({ pageUrl }, '55', async () => { throw failure; }),
      error => error === failure && error.retryAfterMs === 60000);
  }
});

test('hydrates actual gallery wire shape from generation data and nested detail tags for discovered IDs only', async () => {
  const h = harness([{ id: 777, images: [image(135960467)] }], (procedure, input) => {
    assert.equal(input.id, 135960467);
    return procedure === 'image.getGenerationData' ? wire({ type: 'image',
      meta: { prompt: 'selfie, beach', negativePrompt: 'blurry' },
      resources: [
        { modelType: 'Checkpoint', modelName: 'Realistic checkpoint', versionName: 'v1', baseModel: 'SDXL' },
        { modelType: 'LORA', modelName: 'Blue hair', versionName: 'v2', baseModel: 'SDXL' },
        { modelType: 'DoRA', modelName: 'Detail helper', versionName: 'v1' }
      ] }) : wire({ tags: [{ automated: true, tag: { id: 4, name: 'selfie' } }, { tag: { id: 5, name: 'beach' } }] });
  });
  const page = await h.next();
  assert.equal(page.catalogItems[0].prompt, 'selfie, beach');
  assert.equal(page.catalogItems[0].negativePrompt, 'blurry');
  assert.equal(page.catalogItems[0].modelName, 'Realistic checkpoint');
  assert.deepEqual(Array.from(page.catalogItems[0].loras), ['Blue hair', 'v2', 'Detail helper', 'v1']);
  assert.deepEqual(Array.from(page.catalogItems[0].tags), ['selfie', 'beach']);
  assert.deepEqual(h.calls.map(x => x.procedure), ['image.getImagesAsPostsInfinite', 'image.getGenerationData', 'image.getDetail']);
  assert.equal(h.calls.every(x => x.origin === 'https://civitai.red'), true);
  assert.deepEqual(h.calls[0].input, { modelId: 123, modelVersionId: 456, browsingLevel: 1, sort: 'Newest', include: ['cosmetics'], limit: 60 });
  assert.equal(page.cursor, 'next-selected-page');
});

test('post captions and post prompts do not become generation prompts when image metadata is hidden', async () => {
  const h = harness([{ id: 777, description: 'selfie caption', prompt: 'post description prompt', meta: { prompt: 'not per-image' },
    images: [{ ...image(55), hideMeta: true }] }], procedure => procedure === 'image.getGenerationData'
    ? wire({ type: 'image', resources: [] }) : wire({ tags: [] }));
  const page = await h.next();
  assert.equal(page.catalogItems[0].prompt, '');
  assert.equal(page.catalogItems[0].negativePrompt, '');
  assert.equal(page.catalogItems[0].id, '55');
  assert.match(page.catalogItems[0].downloadUrl, /original=true/);
});

test('tRPC 429 metadata error rejects the page and leaves its existing cursor unchanged', async () => {
  const h = harness([image(55)], () => ({ error: { json: { message: 'Rate limited', data: { code: 'TOO_MANY_REQUESTS', httpStatus: 429 } } } }), 'image.getInfinite');
  h.feed.cursor = 'previous-selected-page';
  await assert.rejects(h.next(), error => error.status === 429 && /Rate limited/.test(error.message));
  assert.equal(h.feed.cursor, 'previous-selected-page');
  assert.equal(h.calls.length, 2);
});

test('transient named-tag request failure rejects the page before catalog upload', async () => {
  const h = harness([image(55)], procedure => {
    if (procedure === 'image.getGenerationData') return wire({ type: 'image', meta: { prompt: 'selfie' }, resources: [] });
    throw Object.assign(new Error('Service unavailable'), { status: 503, retryAfterMs: 2000 });
  }, 'image.getInfinite');
  await assert.rejects(h.next(), error => error.status === 503 && error.retryAfterMs === 2000);
  assert.equal(h.feed.cursor, null);
});

test('deleted image detail remains a raw promptless candidate and duplicate feed IDs are read once', async () => {
  const h = harness([{ id: 7, images: [image(55), image(55)] }], () => ({ error: { json: { message: 'Not found', data: { code: 'NOT_FOUND', httpStatus: 404 } } } }));
  const page = await h.next();
  assert.equal(page.catalogItems.length, 1);
  assert.equal(page.catalogItems[0].prompt, '');
  assert.deepEqual(Array.from(page.catalogItems[0].tags), []);
  assert.equal(h.calls.length, 3);
});

test('unsafe media and entries without their own image ID trigger no metadata reads', async () => {
  const h = harness([{ id: 7, images: [
    { ...image(1), type: 'video' }, { ...image(2), url: 'https://evil.example/2.png' },
    { type: 'image', url: image(3).url }
  ] }], () => { throw new Error('Unexpected metadata request'); });
  const page = await h.next();
  assert.equal(page.catalogItems.length, 0);
  assert.equal(h.calls.length, 1);
});

test('unexpected metadata success body pauses collection instead of quietly indexing empty metadata', async () => {
  const h = harness([image(55)], () => wire({ items: [] }), 'image.getInfinite');
  await assert.rejects(h.next(), /metadata format changed/);
  assert.equal(h.feed.cursor, null);
});

test('removed metadata procedures and non-JSON 404 failures are surfaced instead of treated as deleted images', async () => {
  const missingProcedure = harness([image(55)], () => ({ error: { json: {
    message: 'No procedure found on path image.getGenerationData', data: { code: 'NOT_FOUND', httpStatus: 404 }
  } } }), 'image.getInfinite');
  await assert.rejects(missingProcedure.next(), /No procedure found/);
  const html404 = harness([image(55)], () => { throw Object.assign(new Error('Non-JSON response'), { status: 404 }); }, 'image.getInfinite');
  await assert.rejects(html404.next(), /Non-JSON response/);
});

test('captures real Civitai all-time stats aliases and dimensions without extra stats requests', async () => {
  const h = harness([{ id: 7, images: [{ ...image(55), width: 832, height: 1216,
    tags: [{ name: 'selfie' }], meta: { prompt: 'selfie', modelName: 'Realistic checkpoint', resources: [] },
    stats: { likeCountAllTime: 767, heartCountAllTime: 496, laughCountAllTime: 49,
      cryCountAllTime: 21, tippedAmountCountAllTime: 500, statsUnknown: false } }] }],
  () => { throw new Error('Stats must not add requests'); });
  const record = (await h.next()).catalogItems[0];
  assert.deepEqual(JSON.parse(JSON.stringify(record.reactions)), {
    likeCount: 767, heartCount: 496, laughCount: 49, cryCount: 21, buzzCount: 500
  });
  assert.equal(record.width, 832);
  assert.equal(record.height, 1216);
  assert.equal(h.calls.length, 1);
});

test('retains actual zero stats and omits unknown or invalid source values and dimensions', async () => {
  const h = harness([{ ...image(55), width: 0, height: '1216', tags: [{ name: 'selfie' }],
    meta: { prompt: 'selfie', modelName: 'Realistic checkpoint', resources: [] },
    stats: { likeCount: 0, heartCount: null, laughCount: -1, cryCount: '21', buzzCount: 37 } }],
  () => { throw new Error('Unexpected detail request'); }, 'image.getInfinite');
  const record = (await h.next()).catalogItems[0];
  assert.deepEqual(JSON.parse(JSON.stringify(record.reactions)), { likeCount: 0, buzzCount: 37 });
  assert.equal(Object.hasOwn(record, 'width'), false);
  assert.equal(Object.hasOwn(record, 'height'), false);
});

test('Civitai statsUnknown outage zeroes remain unknown and do not become catalog counts', async () => {
  const h = harness([{ ...image(55), tags: [{ name: 'selfie' }],
    meta: { prompt: 'selfie', modelName: 'Realistic checkpoint', resources: [] },
    stats: { likeCountAllTime: 0, heartCountAllTime: 0, laughCountAllTime: 0,
      cryCountAllTime: 0, tippedAmountCountAllTime: 0, statsUnknown: true } }],
  () => { throw new Error('Stats outage must not add requests'); }, 'image.getInfinite');
  const record = (await h.next()).catalogItems[0];
  assert.deepEqual(JSON.parse(JSON.stringify(record.reactions)), {});
  assert.equal(h.calls.length, 1);
});

test('uses stats and dimensions from an already needed detail read while retaining known feed fields', async () => {
  const h = harness([{ ...image(55), width: 832, height: 1216,
    meta: { prompt: 'selfie', modelName: 'Realistic checkpoint', resources: [] },
    stats: { likeCountAllTime: 15, heartCountAllTime: 9, laughCountAllTime: 3 } }],
  procedure => {
    assert.equal(procedure, 'image.getDetail');
    return wire({ tags: [{ tag: { name: 'selfie' } }], width: 1024, height: null,
      stats: { likeCount: 16, heartCount: null, cryCountAllTime: 2, buzzCountAllTime: 41, statsUnknown: false } });
  }, 'image.getInfinite');
  const record = (await h.next()).catalogItems[0];
  assert.deepEqual(JSON.parse(JSON.stringify(record.reactions)), {
    likeCount: 16, heartCount: 9, laughCount: 3, cryCount: 2, buzzCount: 41
  });
  assert.equal(record.width, 1024);
  assert.equal(record.height, 1216);
  assert.deepEqual(h.calls.map(x => x.procedure), ['image.getInfinite', 'image.getDetail']);
});

test('fills twelve image tasks, bounds large posts, and reports progress before a page finishes', async () => {
  const h = harness([{ images: Array.from({ length: 25 }, (_, index) => ({ ...image(index + 1),
    tags: ['selfie'], meta: { prompt: 'selfie', modelName: 'Camera', resources: [] } })) }],
  () => { throw new Error('Complete metadata must need no extra source reads'); });
  const running = [], progress = [];
  let active = 0, maximum = 0, finished = false;
  const processing = task => new Promise((resolve, reject) => {
    active++; maximum = Math.max(maximum, active);
    running.push(async () => { try { resolve(await task()); } catch (error) { reject(error); } finally { active--; } });
  });
  const pagePromise = h.next(processing, event => progress.push(event)).then(page => { finished = true; return page; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(active, 12);
  assert.equal(progress.filter(event => event.phase === 'metadata-admit').length, 12);
  assert.equal(progress.filter(event => event.phase === 'metadata-start').length, 0, 'queued jobs have not started reading prompts');
  await running.shift()();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(progress.filter(event => event.phase === 'metadata-complete').length, 1);
  assert.equal(progress.filter(event => event.phase === 'metadata-start').length, 1);
  assert.deepEqual(Array.from(progress[0].ids), Array.from({ length: 25 }, (_, index) => String(index + 1)));
  const firstComplete = progress.find(event => event.phase === 'metadata-complete');
  assert.equal(firstComplete.record.id, '1');
  assert.equal(firstComplete.record.prompt, 'selfie');
  assert.equal(finished, false);
  while (!finished) {
    await running.shift()?.();
    await new Promise(resolve => setImmediate(resolve));
  }
  const page = await pagePromise;
  assert.equal(maximum, 12);
  assert.equal(page.catalogItems.length, 25);
  assert.deepEqual(Array.from(page.catalogItems, record => record.id), Array.from({ length: 25 }, (_, index) => String(index + 1)));
  assert.equal(progress.at(-1).phase, 'metadata-ready');
  assert.equal(progress.at(-1).completed, 25);
});

test('waits for per-image admission before starting metadata requests', async () => {
  const h = harness([image(55)], procedure => procedure === 'image.getGenerationData'
    ? wire({ type: 'image', meta: { prompt: 'selfie' }, resources: [] }) : wire({ tags: [] }));
  let admit, admitted = false;
  const pagePromise = h.next(undefined, async event => {
    if (event.phase === 'metadata-admit') {
      admitted = true;
      await new Promise(resolve => { admit = resolve; });
    }
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(admitted, true);
  assert.equal(h.calls.length, 1, 'only the discovery feed runs before admission');
  admit();
  assert.equal((await pagePromise).catalogItems[0].prompt, 'selfie');
  assert.equal(h.calls.length, 3);
});

test('streams an oversized post through bounded admission without truncating its images', async () => {
  const count = 613;
  const h = harness([{ images: Array.from({ length: count }, (_, index) => ({ ...image(index + 1),
    tags: ['selfie'], meta: { prompt: 'selfie', modelName: 'Camera', resources: [] } })) }],
  () => { throw new Error('Complete records need no enrichment'); });
  const waiting = [], outstanding = new Set(), streamed = new Set();
  let maximum = 0;
  const page = await h.next(undefined, async event => {
    if (event.phase === 'metadata-admit') {
      // Deliberately use a smaller admission window than the twelve workers.
      while (outstanding.size >= 4) await new Promise(resolve => waiting.push(resolve));
      outstanding.add(event.id);
      maximum = Math.max(maximum, outstanding.size);
    } else if (event.phase === 'metadata-complete') {
      assert.equal(event.record.id, event.id);
      assert.equal(outstanding.delete(event.id), true);
      streamed.add(event.id);
      waiting.splice(0).forEach(resolve => resolve());
    }
  });
  assert.equal(maximum, 4);
  assert.equal(streamed.size, count);
  assert.equal(page.catalogItems.length, count);
  assert.equal(page.cursor, 'next-selected-page');
});

test('failed metadata drains outstanding tasks and leaves cursor unchanged before retry', async () => {
  const h = harness(Array.from({ length: 20 }, (_, index) => image(index + 1)), () => wire({ type: 'image', resources: [] }));
  h.feed.cursor = 'saved-cursor';
  const jobs = [], progress = [];
  let settled = false;
  const result = h.next(() => new Promise((resolve, reject) => jobs.push({ resolve, reject })), event => progress.push(event));
  result.catch(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(jobs.length, 12);
  jobs[0].reject(Object.assign(new Error('Temporary failure'), { status: 503 }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  for (const job of jobs.slice(1)) job.resolve({ prompt: 'selfie' });
  await assert.rejects(result, /Temporary failure/);
  assert.equal(jobs.length, 12);
  assert.equal(h.feed.cursor, 'saved-cursor');
  assert.equal(progress.some(event => event.phase === 'metadata-error'), true);
  assert.equal(progress.some(event => event.phase === 'metadata-ready'), false);
});

function tabHarness() {
  const calls = [];
  const context = vm.createContext({ URL, JSON, Number, Object, AbortSignal, location: { origin: 'https://civitai.red' },
    fetch: async (url, options) => { calls.push({ url, options }); return { ok: true, status: 200,
      json: async () => wire({ type: 'image', resources: [] }), headers: new Headers() }; } });
  vm.runInContext(tabSource, context);
  const invoke = (path, input = { json: { id: 55 } }) => {
    const url = new URL(path, 'https://civitai.red');
    url.searchParams.set('input', JSON.stringify(input));
    return context.requestCivitaiFeedInTab(url.href, 'https://civitai.red');
  };
  return { calls, invoke };
}

test('same-tab metadata reads use browser credentials and reject foreign endpoints, batches and invalid IDs', async () => {
  const h = tabHarness();
  for (const path of ['/api/trpc/image.getGenerationData', '/api/trpc/image.getDetail']) {
    assert.equal((await h.invoke(path)).ok, true);
  }
  assert.equal(h.calls.every(call => call.options.credentials === 'same-origin' && call.options.redirect === 'error'), true);
  for (const path of ['https://civitai.com/api/trpc/image.getDetail', '/api/trpc/image.delete',
    '/api/trpc/image.getDetail,image.delete', '/api/trpc/image.getDetail?batch=1']) {
    assert.equal((await h.invoke(path)).ok, false);
  }
  for (const input of [{ json: { id: '55' } }, { json: { id: 0 } }, { json: { id: 55, userId: 9 } }]) {
    assert.equal((await h.invoke('/api/trpc/image.getDetail', input)).ok, false);
  }
  assert.equal(h.calls.length, 2);
});


test('verified discovery skips bypass image workers and metadata without becoming promptless', async () => {
  const h = harness([image(55), image(56), image(57)], procedure => procedure === 'image.getGenerationData'
    ? wire({ type: 'image', meta: { prompt: 'a neutral landscape' }, resources: [] }) : wire({ tags: [] }));
  const events = []; let workers = 0;
  const page = await h.next(task => { workers++; return task(); }, event => {
    events.push(event);
    if (event.phase === 'metadata-admit' && event.id !== '56') return { skip: true };
  });
  assert.equal(workers, 1);
  assert.deepEqual(h.calls.filter(call => call.procedure !== 'image.getImagesAsPostsInfinite').map(call => call.input.id), [56, 56]);
  assert.equal(page.catalogItems[0], null); assert.equal(page.catalogItems[2], null);
  assert.equal(page.catalogItems[1].id, '56'); assert.equal(page.items.length, 3);
  assert.deepEqual(events.filter(event => event.phase === 'metadata-skipped').map(event => event.id).sort(), ['55', '57']);
  assert.equal(events.filter(event => event.phase === 'metadata-complete').length, 1);
  assert.equal(events.at(-1).phase, 'metadata-ready'); assert.equal(events.at(-1).completed, 3);
  assert.equal(page.cursor, 'next-selected-page');
});

test('an entirely stored feed page advances its result cursor without image processing', async () => {
  const h = harness(Array.from({ length: 60 }, (_, index) => image(index + 1)), () => { throw new Error('No metadata reads expected'); });
  const page = await h.next(() => { throw new Error('No image worker expected'); }, event =>
    event.phase === 'metadata-admit' ? { skip: true } : undefined);
  assert.equal(h.calls.length, 1); assert.equal(page.items.length, 60);
  assert.equal(page.catalogItems.length, 60); assert.equal(page.catalogItems.every(value => value === null), true);
  assert.equal(page.cursor, 'next-selected-page'); assert.equal(h.feed.cursor, null, 'only background commits a cursor');
});
