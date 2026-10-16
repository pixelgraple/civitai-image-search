import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../tab-feed-request.js', import.meta.url), 'utf8');
const query = (id, stats, requestId = id, type = 'image') => ({ queryKey: [[type, 'get'], { input: { id: requestId } }],
  state: { data: { id, type: 'image', stats } } });
const html = queries => `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { trpcState: { json: { queries } } } } })}</script>`;
function harness(body, status = 200) {
  const calls = [], context = vm.createContext({ URL, Date, AbortSignal, setTimeout, clearTimeout,
    location: { origin: 'https://civitai.red' }, fetch: async (url, options) => {
      calls.push({ url, options }); return { ok: status === 200, status, text: async () => body,
        headers: { get: key => key === 'retry-after' ? '60' : 'text/html' } };
    } });
  vm.runInContext(source, context);
  return { calls, request: url => context.requestCivitaiFeedInTab(url, 'https://civitai.red') };
}
test('image-page fallback fetches only HTML and extracts exact source stats without media or execution', async () => {
  const h = harness(html([query(55, { likeCountAllTime: 0, heartCountAllTime: 12 })]));
  const result = await h.request('https://civitai.red/images/55');
  assert.equal(result.ok, true); assert.deepEqual(JSON.parse(JSON.stringify(result.data)), { id: '55', stats: { likeCountAllTime: 0, heartCountAllTime: 12 }, username: '' });
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].options.credentials, 'same-origin');
  assert.equal(h.calls[0].options.headers.Accept, 'text/html'); assert.equal(h.calls[0].options.redirect, 'error');
});
test('source page parser rejects another image, mismatched query, post stats and challenges', async () => {
  for (const body of [html([query(56, { likeCountAllTime: 99 })]), html([query(55, { likeCountAllTime: 99 }, 56)]),
    html([query(55, { likeCountAllTime: 99 }, 55, 'post')]), '<html>Challenge</html>']) {
    const result = await harness(body).request('https://civitai.red/images/55');
    assert.equal(result.data, null); assert.match(result.message, /matching reaction metadata/);
  }
});
test('page fallback rejects arbitrary origins, credentials, queries, unsafe IDs and redirects before fetch', async () => {
  for (const url of ['https://evil.example/images/55', 'https://civitai.com/images/55', 'https://me:secret@civitai.red/images/55',
    'https://civitai.red/images/55?redirect=evil', 'https://civitai.red/images/55#other', 'https://civitai.red/images/9007199254740992',
    'https://civitai.red/images/0', 'https://civitai.red/posts/55']) {
    const h = harness(''); const result = await h.request(url); assert.equal(result.ok, false, url); assert.equal(h.calls.length, 0, url);
  }
});
test('page HTTP rate limit and Retry-After stay available to the shared source scheduler', async () => {
  const result = await harness('<html>Rate limited</html>', 429).request('https://civitai.red/images/55');
  assert.equal(result.ok, false); assert.equal(result.status, 429); assert.equal(result.retryAfter, '60');
});
