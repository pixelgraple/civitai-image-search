import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { harness } from './background-harness.mjs';

const version = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url))).version;
async function toolbar(result) {
  const h = await harness(); const scripts = [], opened = [], badges = [], titles = [];
  h.context.chrome.scripting.executeScript = async details => {
    scripts.push(details); if (result instanceof Error) throw result;
    return [{ frameId: 0, result }];
  };
  h.context.chrome.action.setBadgeText = async details => { badges.push(details); };
  h.context.chrome.action.setTitle = async details => { titles.push(details); };
  h.context.chrome.tabs.create = (details, callback) => { opened.push(details); callback({ id: 8, ...details }); };
  return { h, scripts, opened, badges, titles, click: tab => h.listeners.action[0](tab || h.tabs.get(7)) };
}

test('toolbar opens the panel on the reported model page and clears an old failure badge', async () => {
  const t = await toolbar({ ok: true, panelVersion: version });
  await t.click({ id: 7, url: 'https://civitai.red/models/2908958/gonzaleskreav1w4a8' });
  assert.equal(t.scripts.length, 1); assert.equal(t.scripts[0].target.tabId, 7);
  assert.equal(t.scripts[0].files.at(-1), 'panel.js'); assert.equal(t.opened.length, 0);
  assert.equal(t.badges.at(-1).text, '');
  assert.equal(t.titles.at(-1).title, 'Index Civitai');
});

for (const [label, outcome] of [
  ['injection rejected', new Error('Cannot access contents of the page')],
  ['panel initialization failed', { ok: false, error: 'Panel mount failed' }],
  ['script returned no result', undefined],
  ['old panel remained', { ok: true, panelVersion: '0.0.1' }]
]) {
  test(`toolbar shows a recoverable fallback when ${label}`, async () => {
    const t = await toolbar(outcome); await t.click();
    assert.equal(t.badges.at(-1).text, '!'); assert.match(t.titles.at(-1).title, /refresh/i);
    assert.equal(t.opened.length, 1); assert.match(t.opened[0].url, /library\.html\?panelError=1$/);
    assert.match((await t.h.extensionMessage({ type: 'getDebugText' })).text, /panel-error/);
  });
}

test('toolbar on an unrelated site opens normal activity without injecting', async () => {
  const t = await toolbar(); await t.click({ id: 9, url: 'https://example.com/' });
  assert.equal(t.scripts.length, 0); assert.match(t.opened[0].url, /library\.html$/);
});
