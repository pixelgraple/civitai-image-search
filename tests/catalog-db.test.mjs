import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createCatalogIndexedDB } from './catalog-indexeddb-harness.mjs';

const source = fs.readFileSync(new URL('../catalog-db.js', import.meta.url), 'utf8');
function loadCatalog() {
  const context = vm.createContext({ indexedDB: createCatalogIndexedDB() });
  vm.runInContext(source, context);
  return context.PromptCatalogDB;
}
const richRecord = overrides => ({
  id: '135960467', pageUrl: 'https://civitai.red/images/135960467',
  downloadUrl: 'https://image.civitai.com/key/image/original=true/135960467.jpg',
  previewUrl: 'https://image.civitai.com/key/image/width=450/135960467.jpg',
  prompt: 'candid selfie, afternoon sunlight', negativePrompt: 'blurry, watermark',
  tags: ['selfie', 'Café'], modelName: 'Realistic Vision XL',
  loras: ['Blue Hair Portrait LoRA'], updatedAt: '2026-10-14T10:00:00Z', ...overrides,
});
const blankRecord = overrides => richRecord({
  pageUrl: '', downloadUrl: '', previewUrl: '', prompt: '', negativePrompt: '',
  tags: [], modelName: '', loras: [], updatedAt: '2026-10-14T11:00:00Z', ...overrides,
});

test('prompt eligibility drops unknown blank, tags-only and negative-only images without storing them', async () => {
  const db = loadCatalog();
  const result = await db.forPromptCollection([
    richRecord({ id: '1', prompt: '' }), richRecord({ id: '2', prompt: ' \n\t\u00a0' }),
    richRecord({ id: '3', prompt: 'selfie' })
  ]);
  assert.deepEqual(Array.from(result.skippedIds), ['1', '2']);
  assert.deepEqual(Array.from(result.items, item => item.id), ['3']);
  assert.equal(await db.count(), 0, 'checking eligibility never writes promptless rows');
});

test('prompt eligibility preserves an earlier known prompt on an incomplete later scan', async () => {
  const db = loadCatalog(); const original = richRecord();
  await db.upsert([original]);
  const result = await db.forPromptCollection([blankRecord({ prompt: ' \n\t' })]);
  assert.equal(result.items.length, 1);
  assert.equal(result.skippedIds.length, 0);
  assert.equal(result.items[0].prompt, original.prompt);
  assert.equal((await db.get(original.id)).prompt, original.prompt);
  assert.equal(await db.get('unknown'), null);
});

test('persists a complete catalog record and exposes it to search', async () => {
  const db = loadCatalog();
  const original = richRecord();
  await db.upsert([original]);
  assert.equal(await db.count(), 1);
  const found = await db.search('selfie');
  assert.equal(found.length, 1);
  assert.deepEqual(found[0], original);
});

test('a later promptless rescan retains metadata and URLs while updating discovery time', async () => {
  const db = loadCatalog();
  const original = richRecord();
  await db.upsert([original]);
  const blank = blankRecord();
  await db.upsert([blank]);
  assert.equal(await db.count(), 1);
  const found = await db.search('selfie');
  assert.equal(found.length, 1);
  assert.deepEqual(found[0], { ...original, updatedAt: blank.updatedAt });
  assert.equal((await db.search('watermark')).length, 1);
  assert.equal((await db.search('café')).length, 1);
});

test('a populated rescan updates searchable metadata instead of preserving stale values', async () => {
  const db = loadCatalog();
  await db.upsert([richRecord()]);
  const replacement = richRecord({ prompt: 'manga illustration', negativePrompt: 'bad anatomy',
    tags: ['manga'], modelName: 'Anime Canvas', loras: ['Ink Outline LoRA'] });
  await db.upsert([replacement]);
  assert.deepEqual((await db.search('manga'))[0], replacement);
  assert.equal((await db.search('sunlight')).length, 0);
  assert.equal((await db.search('realistic vision')).length, 0);
});

test('search includes model and LoRA names with case-insensitive terms across fields', async () => {
  const db = loadCatalog();
  await db.upsert([richRecord(), richRecord({ id: '135960468', prompt: 'forest landscape',
    negativePrompt: '', tags: ['landscape'], modelName: 'Anime Canvas', loras: ['Ink Outline LoRA'] })]);
  assert.deepEqual(Array.from(await db.search('REALISTIC VISION'), row => row.id), ['135960467']);
  assert.deepEqual(Array.from(await db.search('blue hair portrait'), row => row.id), ['135960467']);
  assert.deepEqual(Array.from(await db.search('selfie vision hair'), row => row.id), ['135960467']);
  assert.equal((await db.search('vision outline')).length, 0);
});

test('duplicate IDs in one scan batch retain enrichment from the populated occurrence', async () => {
  const db = loadCatalog();
  const original = richRecord();
  const blank = blankRecord();
  assert.equal(await db.upsert([original, blank]), 1, 'the write count reflects one unique image');
  assert.equal(await db.count(), 1);
  const found = await db.search('selfie');
  assert.equal(found.length, 1, 'the blank duplicate must not erase the earlier prompt in the same batch');
  assert.deepEqual(found[0], { ...original, updatedAt: blank.updatedAt });
});

test('a blank rescan retains known reaction counts and image dimensions', async () => {
  const db = loadCatalog();
  const original = richRecord({ width: 1280, height: 1920,
    reactions: { likeCount: 14, heartCount: 8, laughCount: 3, cryCount: 1, buzzCount: 120 } });
  await db.upsert([original]);
  const blank = blankRecord({ width: 0, height: null, reactions: {} });
  await db.upsert([blank]);
  const found = (await db.search('selfie'))[0];
  assert.equal(found.width, original.width);
  assert.equal(found.height, original.height);
  assert.deepEqual(found.reactions, original.reactions);
  assert.equal(found.updatedAt, blank.updatedAt);
});

test('a partial rescan updates supplied reaction counts including zero while preserving missing keys and dimensions', async () => {
  const db = loadCatalog();
  const original = richRecord({ width: 1280, height: 1920,
    reactions: { likeCount: 14, heartCount: 8, laughCount: 3, cryCount: 1, buzzCount: 120 } });
  await db.upsert([original]);
  await db.upsert([blankRecord({ width: 2048, height: 0,
    reactions: { likeCount: 0, heartCount: 12, cryCount: 0 } })]);
  const found = (await db.search('selfie'))[0];
  assert.equal(found.width, 2048);
  assert.equal(found.height, original.height);
  assert.deepEqual(found.reactions, { likeCount: 0, heartCount: 12, laughCount: 3, cryCount: 0, buzzCount: 120 });
});
