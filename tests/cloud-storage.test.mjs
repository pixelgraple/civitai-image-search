import test from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './background-harness.mjs';

const config = { civitaiPromptCloud: { apiBase: 'https://search-civitai.xyz/api.php', writeToken: 'private-test-key' } };
const record = { id: '123', prompt: 'selfie, new prompt', tags: ['selfie'],
  downloadUrl: 'https://image.civitai.com/key/image/original=true/123.jpg' };
const stored = id => ({ imageId: id, exists: true, needsDownload: false, sha256: 'a'.repeat(64), downloadStatus: 'ready' });
const absent = id => ({ imageId: id, exists: false, needsDownload: true, sha256: null, downloadStatus: 'missing' });
function respond(data, status = 200) { return new Response(JSON.stringify(data), { status }); }

test('verified originals skip both source work and redundant metadata uploads', async () => {
  const h = await harness(config), calls = [];
  h.context.fetch = async (url, options) => {
    calls.push({ url, options });
    return respond(url.endsWith('action=check') ? { ok: true, items: [stored('123')] } : { ok: true, accepted: 1, skipped: 0 });
  };
  const result = await h.run('syncCloudCatalogItems(' + JSON.stringify([record]) + ', {required:true})');
  assert.equal(result.alreadyStored, 1);
  assert.equal(result.missing, 0);
  assert.equal(result.accepted, 1);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.endsWith('action=check'));
  assert.equal(h.started.length, 0);
  for (const call of calls) {
    assert.equal(call.options.credentials, 'omit');
    assert.equal(call.options.redirect, 'error');
    assert.equal(call.options.headers.Authorization, undefined);
    assert.equal(new URL(call.url).searchParams.has('token'), false);
  }
});

test('missing image checks precede metadata queue request and report counts', async () => {
  const h = await harness(config), actions = [];
  h.context.fetch = async (url) => {
    const action = new URL(url).searchParams.get('action'); actions.push(action);
    return respond(action === 'check' ? { ok: true, items: [absent('123')] } : { ok: true, accepted: 1, skipped: 0 });
  };
  const result = await h.run('syncCloudCatalogItems(' + JSON.stringify([record]) + ')');
  assert.deepEqual(actions, ['check', 'images']);
  assert.equal(result.alreadyStored, 0);
  assert.equal(result.missing, 1);
  assert.equal(h.started.length, 0);
});

test('a missing thumbnail keeps the verified original skipped while server repairs its preview', async () => {
  const h = await harness(config);
  h.context.fetch = async url => respond(url.endsWith('action=check')
    ? {ok:true,items:[{...stored('123'),downloadStatus:'pending'}]} : {ok:true,accepted:1,skipped:0});
  const result = await h.run('syncCloudCatalogItems(' + JSON.stringify([record]) + ')');
  assert.equal(result.alreadyStored, 1);
  assert.equal(result.missing, 0);
  assert.equal(h.started.length, 0);
});

test('duplicate IDs receive one check and preserve known fields alongside real zero reactions', async () => {
  const h = await harness(config), bodies = [];
  h.context.fetch = async (url, options) => {
    const body = JSON.parse(options.body); bodies.push(body);
    return respond(url.endsWith('action=check') ? { ok: true, items: [absent('123')] } : { ok: true, accepted: 1, skipped: 0 });
  };
  const result = await h.run('syncCloudCatalogItems(' + JSON.stringify([
    { ...record, modelName: 'Realistic model', reactions: { heartCount: 4, likeCount: 2 } },
    { id: '123', prompt: '', tags: [], reactions: { heartCount: 0 } }
  ]) + ')');
  assert.deepEqual(bodies[0].imageIds, ['123']);
  assert.equal(bodies[1].items.length, 1);
  assert.equal(bodies[1].items[0].prompt, record.prompt);
  assert.equal(bodies[1].items[0].modelName, 'Realistic model');
  assert.deepEqual(bodies[1].items[0].reactions, { heartCount: 0, likeCount: 2 });
  assert.equal(result.accepted, 1);
});

for (const status of [401, 404, 503]) test(`failed storage check HTTP ${status} prevents metadata writes and local fallback`, async () => {
  const h = await harness(config); let calls = 0;
  h.context.fetch = async () => { calls++; return respond({ ok: false }, status); };
  await assert.rejects(h.run('syncCloudCatalogItems(' + JSON.stringify([record]) + ',{required:true})'), error => error.status === status);
  assert.equal(calls, 1);
  assert.equal(h.started.length, 0);
});

for (const items of [[], [stored('999')], [{ ...stored('123'), sha256: 'invalid' }],
  [{ ...stored('123'), needsDownload: true }], [{ ...stored('123'), downloadStatus: 'failed' }]]) {
  test('incomplete or inconsistent storage check never claims success: ' + JSON.stringify(items), async () => {
    const h = await harness(config); let calls = 0;
    h.context.fetch = async () => { calls++; return respond({ ok: true, items }); };
    await assert.rejects(h.run('syncCloudCatalogItems(' + JSON.stringify([record]) + ')'), /storage check/);
    assert.equal(calls, 1);
    assert.equal(h.started.length, 0);
  });
}

test('invalid image ID is rejected before any storage request', async () => {
  const h = await harness(config); let calls = 0;
  h.context.fetch = async () => { calls++; throw new Error('unexpected request'); };
  await assert.rejects(h.run('syncCloudCatalogItems([{id:"abc"}])'), /invalid image ID/);
  assert.equal(calls, 0);
});
