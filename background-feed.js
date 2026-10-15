// Direct feed pagination. No page timers, visibility tests, or foreground window.
// Each run keeps the user's exact observed query; never replace it with an
// unfiltered global feed when a site changes its API or requires a login.
globalThis.ISSFeed = (() => {
  const speed = () => globalThis.ISSCollectionSpeed?.get() || { metadataConcurrency: 12, discoveryBatchSize: 60 };
  const procedures = ['image.getInfinite', 'image.getImagesAsPostsInfinite'];
  function decode(value) {
    return typeof value === 'string' ? ISSDevalue.parse(value) : value?.json ?? value;
  }
  function fromRequests(site, pageUrl, requestUrls = []) {
    const page = new URL(pageUrl);
    if (site !== 'civitai' || page.protocol !== 'https:' || !['civitai.com', 'civitai.red'].includes(page.hostname) ||
        page.username || page.password) throw new Error('Index Civitai supports only Civitai pages.');
    for (const value of [...requestUrls].reverse()) {
      try {
        const url = new URL(value);
        if (url.origin !== page.origin || !url.pathname.startsWith('/api/trpc/')) continue;
        const names = decodeURIComponent(url.pathname.slice('/api/trpc/'.length)).split(',');
        const index = names.findIndex(name => procedures.includes(name));
        if (index < 0) continue;
        const input = JSON.parse(url.searchParams.get('input'));
        const envelope = url.searchParams.get('batch') === '1' ? input[index] : input;
        const params = decode(envelope);
        if (!params || typeof params !== 'object' || Array.isArray(params)) continue;
        // Preserve superjson metadata (undefined/date-valued filters). Paging
        // metadata must not turn our new cursor back into undefined.
        const meta = typeof envelope === 'object' ? structuredClone(envelope.meta) : undefined;
        if (meta?.values) {
          delete meta.values.cursor;
          delete meta.values.page;
        }
        const filters = structuredClone(params);
        delete filters.cursor;
        delete filters.page;
        delete filters.direction;
        return { site, pageUrl, endpoint: names[index], filters, meta, cursor: null, pages: 0 };
      } catch {}
    }
    throw new Error('Scroll the website once to load another row, then press Start again. This captures your exact feed filters for background mode.');
  }
  async function request(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(url, {
        credentials: 'include', cache: 'no-store', ...options, signal: controller.signal
      });
      if (!response.ok) {
        const error = new Error(`Background feed HTTP ${response.status}` +
          ([401, 403].includes(response.status) ? ' — the site rejected this request. This does not necessarily mean you are logged out.' : ''));
        error.status = response.status;
        error.retryAfterMs = Math.min(300000, Math.max(0, Number(response.headers.get('retry-after')) * 1000 || 0));
        throw error;
      }
      return await response.json(); // Timeout covers the body, not just headers.
    } finally { clearTimeout(timer); }
  }
  function imageUrl(value, site) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:') return null;
      if (site !== 'civitai' || url.username || url.password) return null;
      if (!['image.civitai.com', 'imagecache.civitai.com'].includes(url.hostname)) return null;
      const parts = url.pathname.split('/');
      if (parts.length < 5) return null;
      parts[parts.length - 2] = 'original=true';
      url.pathname = parts.join('/');
      return /\.(png|jpe?g|webp)$/i.test(url.pathname) ? url.href : null;
    } catch { return null; }
  }
  function civitaiImage(image) {
    if (!image || typeof image !== 'object') return null;
    if (image.type && image.type !== 'image') return null;
    let value = image.url;
    if (typeof value !== 'string') return null;
    if (/^[\w-]+$/.test(value)) {
      const name = /\.(png|jpe?g|webp)$/i.test(image.name || '') ? image.name : `${image.id}.png`;
      value = `https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/${value}/original=true/${encodeURIComponent(name)}`;
    }
    const url = imageUrl(value, 'civitai');
    return url ? { url, type: 'image' } : null;
  }
  function promptText(value) {
    if (typeof value === 'string') return value.trim();
    if (Array.isArray(value)) return value.map(promptText).filter(Boolean).join(', ');
    return '';
  }
  function tagNames(value) {
    return Array.isArray(value) ? value.map(tag => typeof tag === 'string' ? tag : tag?.name ?? tag?.tag?.name).filter(Boolean) : [];
  }
  function imageCreator(image, post = {}) {
    const normalize = value => {
      if (typeof value !== 'string') return '';
      const name = value.trim().replace(/^@/, '');
      return name && [...name].length <= 200 && !/[\u0000-\u001f\u007f-\u009f]/u.test(name) ? name : '';
    };
    // Only the image uploader, or the uploader of a post containing this exact
    // image. Resource/model authors and the signed-in account are unrelated.
    const direct = normalize(image?.user?.username) || normalize(image?.username);
    if (direct) return direct;
    return Array.isArray(post.images) && post.images.some(item => String(item?.id) === String(image?.id))
      ? normalize(post.user?.username) || normalize(post.username) : '';
  }
  function imageReactions(...statsSources) {
    const aliases = {
      likeCount: ['likeCount', 'likeCountAllTime'],
      heartCount: ['heartCount', 'heartCountAllTime'],
      laughCount: ['laughCount', 'laughCountAllTime'],
      cryCount: ['cryCount', 'cryCountAllTime'],
      buzzCount: ['buzzCount', 'buzzCountAllTime', 'tippedAmountCountAllTime']
    };
    const reactions = {};
    for (const stats of statsSources) {
      // Civitai emits zero placeholders during a metrics outage. Those are not
      // observed counts, so they must not overwrite the catalog's last reading.
      if (!stats || typeof stats !== 'object' || stats.statsUnknown === true) continue;
      for (const [key, names] of Object.entries(aliases)) {
        const value = names.map(name => stats[name]).find(value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
        if (value !== undefined) reactions[key] = value;
      }
    }
    return reactions;
  }
  function imageDimension(...values) {
    return values.find(value => typeof value === 'number' && Number.isSafeInteger(value) && value > 0);
  }
  function imageExceedsLimits(image) {
    const width = imageDimension(image?.width), height = imageDimension(image?.height);
    return width > 4096 || height > 4096 || (width !== undefined && height !== undefined && width * height > 9000000);
  }
  const hasCoreReactions = value => ['likeCount', 'heartCount', 'laughCount', 'cryCount']
    .every(key => Number.isSafeInteger(value?.[key]) && value[key] >= 0);
  async function civitaiPageReactions(feed, id, siteRequest, observeCreator) {
    const url = new URL(`/images/${encodeURIComponent(id)}`, feed.pageUrl);
    let result;
    try { result = await siteRequest(url.href); }
    catch (error) {
      // Reaction enrichment is optional when an otherwise valid image page
      // lacks readable metadata or has disappeared. Source rejection, rate
      // limits, cancellation and server failures still use the shared guard.
      if ([200, 404].includes(Number(error?.status))) return {};
      throw error;
    }
    if (String(result?.id) !== String(id)) throw new Error('The image page returned reaction metadata for another image.');
    const creatorName = imageCreator(result);
    if (creatorName) await observeCreator?.(creatorName);
    return imageReactions(result.stats);
  }
  function civitaiCatalogRecord(image, post = {}, enrichment = {}) {
    if (!image || typeof image !== 'object') return null;
    const downloadUrl = civitaiImage(image)?.url || '';
    if (!downloadUrl) return null;
    const id = image?.id;
    if (!Number.isSafeInteger(Number(id)) || Number(id) <= 0) return null;
    if (enrichment.detail && Object.prototype.hasOwnProperty.call(enrichment.detail, 'id') &&
        (!Number.isSafeInteger(Number(enrichment.detail.id)) || Number(enrichment.detail.id) !== Number(id)))
      throw new Error('Civitai returned details for a different image. Collection paused to protect metadata attribution.');
    const hasGenerationRead = Object.prototype.hasOwnProperty.call(enrichment, 'generation');
    const meta = hasGenerationRead ? enrichment.generation?.meta || {} : image?.meta || image?.metadata || {};
    // Post descriptions/captions are not generation prompts. A detail read is
    // authoritative, including a missing meta object when the uploader hid it.
    const prompt = image.hideMeta ? '' : promptText(hasGenerationRead ? meta.prompt ?? meta.Prompt : image?.prompt ?? meta.prompt ?? meta.Prompt);
    const negativePrompt = image.hideMeta ? '' : promptText(hasGenerationRead ? meta.negativePrompt ?? meta.NegativePrompt : image?.negativePrompt ?? meta.negativePrompt ?? meta.NegativePrompt);
    const tags = [...new Set(Object.prototype.hasOwnProperty.call(enrichment, 'detail')
      ? tagNames(enrichment.detail?.tags) : [...tagNames(image?.tags), ...tagNames(post?.tags)])];
    const resources = (hasGenerationRead ? [enrichment.generation?.resources] : [image?.resources, meta.resources, post?.resources])
      .flatMap(value => Array.isArray(value) ? value : []);
    const checkpoint = resources.find(resource => String(resource?.type ?? resource?.modelType ?? '').toLowerCase() === 'checkpoint');
    const modelName = promptText(checkpoint?.modelName ?? checkpoint?.model?.name ?? checkpoint?.name ??
      (hasGenerationRead ? meta.modelName ?? meta.Model : image?.modelName ?? image?.model?.name ?? meta.modelName ?? meta.Model ?? post?.modelName ?? post?.model?.name));
    const loras = [...new Set(resources.filter(resource => {
      const type = String(resource?.type ?? resource?.modelType ?? '').toLowerCase();
      return type.includes('lora') || type.includes('locon') || type.includes('dora') || resource?.isLora === true;
    }).flatMap(resource => [resource?.modelName, resource?.model?.name, resource?.versionName, resource?.name].map(promptText)).filter(Boolean))];
    const url = typeof image?.url === 'string' ? image.url : '';
    let previewUrl = '';
    try {
      const parsed = new URL(url.startsWith('http') ? url : `https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/${url}/width=450/${image?.name || `${id}.png`}`);
      if (['image.civitai.com', 'imagecache.civitai.com'].includes(parsed.hostname)) previewUrl = parsed.href;
    } catch {}
    const reactions = imageReactions(image.stats, image.reactions, enrichment.detail?.stats);
    const creatorName = imageCreator(enrichment.detail) || imageCreator(image, post);
    const width = imageDimension(enrichment.detail?.width, image.width);
    const height = imageDimension(enrichment.detail?.height, image.height);
    return { id: String(id), pageUrl: `https://civitai.red/images/${encodeURIComponent(id)}`, previewUrl, downloadUrl,
      prompt, negativePrompt, tags, modelName, loras, reactions, creatorName,
      ...(width === undefined ? {} : { width }), ...(height === undefined ? {} : { height }),
      updatedAt: Date.now(), source: 'civitai' };
  }
  async function civitaiMetadata(feed, procedure, id, siteRequest) {
    const url = new URL(`/api/trpc/${procedure}`, feed.pageUrl);
    url.searchParams.set('input', JSON.stringify({ json: { id: Number(id) } }));
    let response;
    try {
      response = siteRequest ? await siteRequest(url.href) : await request(url.href, { headers: { Accept: 'application/json' } });
    } catch (error) {
      // Only an explicit missing-image response is an empty record. An HTML
      // 404 or removed procedure is a collection failure, not missing metadata.
      if (error.status === 404 && error.trpcCode === 'NOT_FOUND' && !/no procedure/i.test(error.message)) return null;
      throw error;
    }
    if (response?.error) {
      const detail = decode(response.error);
      const status = detail?.data?.httpStatus ?? detail?.httpStatus;
      if ((status === 404 || detail?.data?.code === 'NOT_FOUND') && !/no procedure/i.test(detail?.message || '')) return null;
      throw Object.assign(new Error(detail?.message || 'Civitai image metadata request failed.'), {
        status: status || (detail?.data?.code === 'TOO_MANY_REQUESTS' ? 429 : 0)
      });
    }
    const data = decode(response?.result?.data);
    if (!data || typeof data !== 'object' || Array.isArray(data) ||
        (procedure === 'image.getGenerationData' ? !('resources' in data || 'meta' in data || 'type' in data) : !('tags' in data))) {
      throw new Error('Civitai image metadata format changed. Collection paused before advancing the feed.');
    }
    if (procedure === 'image.getDetail' && Object.prototype.hasOwnProperty.call(data, 'id') &&
        (!Number.isSafeInteger(Number(data.id)) || Number(data.id) !== Number(id)))
      throw new Error('Civitai returned details for a different image. Collection paused to protect metadata attribution.');
    return data;
  }
  async function civitaiCatalogItems(feed, posts, siteRequest, processImage = task => task(), onProgress = () => {}, readReactions) {
    const candidates = new Map();
    for (const post of posts) {
      for (const image of Array.isArray(post.images) ? post.images : [post]) {
        const initial = civitaiCatalogRecord(image, post);
        if (initial && !candidates.has(initial.id)) candidates.set(initial.id, { image, post, initial });
      }
    }
    const pending = [...candidates.values()], records = new Array(pending.length);
    let next = 0, completed = 0, failure;
    await onProgress({ phase: 'metadata', ids: pending.map(({ initial }) => initial.id), completed, total: pending.length });
    // The live profile bounds each page producer; the global image queue also
    // bounds all producers together. Slowing down lets current work finish.
    await new Promise(resolve => {
      let active = 0, finished = false, unsubscribe;
      const pump = () => {
        if (finished) return;
        while (!failure && next < pending.length && active < speed().metadataConcurrency) {
          const index = next++, { image, post, initial } = pending[index]; active++;
          (async () => {
            try {
              // One post may exceed 600 images. Admission waits for durable
              // accepted work to free capacity without truncating the page.
              if (imageExceedsLimits(initial)) {
                records[index] = null; completed++;
                await onProgress({ phase: 'metadata-oversize', id: initial.id, completed, total: pending.length });
                return;
              }
              const admission = await onProgress({ phase: 'metadata-admit', id: initial.id, reactions: initial.reactions, creatorName: initial.creatorName, completed, total: pending.length });
              if (admission?.skip === true) {
                records[index] = null; completed++;
                await onProgress({ phase: 'metadata-skipped', id: initial.id, completed, total: pending.length });
                return;
              }
              records[index] = await processImage(async () => {
                await onProgress({ phase: 'metadata-start', id: initial.id, completed, total: pending.length });
                const enrichment = {};
                const resources = image?.resources ?? image?.meta?.resources;
                if (!initial.prompt || !initial.modelName || !Array.isArray(resources))
                  enrichment.generation = await civitaiMetadata(feed, 'image.getGenerationData', initial.id, siteRequest);
                if (!initial.tags.length) enrichment.detail = await civitaiMetadata(feed, 'image.getDetail', initial.id, siteRequest);
                const record = civitaiCatalogRecord(image, post, enrichment);
                if (imageExceedsLimits(record)) {
                  await onProgress({ phase: 'metadata-oversize', id: initial.id, completed, total: pending.length });
                  return null;
                }
                if (record?.prompt && readReactions && !hasCoreReactions(record.reactions))
                  record.reactions = { ...record.reactions, ...await readReactions(record.id) };
                return record;
              });
              completed++;
              await onProgress({ phase: 'metadata-complete', id: initial.id, record: records[index], completed, total: pending.length });
            } catch (error) {
              failure ||= error;
              try { await onProgress({ phase: 'metadata-error', id: initial.id, completed, total: pending.length }); }
              catch (progressError) { failure ||= progressError; }
            } finally { active--; pump(); }
          })();
        }
        if (!active && (failure || next >= pending.length)) { finished = true; unsubscribe?.(); resolve(); }
      };
      unsubscribe = globalThis.ISSCollectionSpeed?.subscribe(pump); pump();
    });
    if (failure) throw failure;
    await onProgress({ phase: 'metadata-ready', completed, total: pending.length });
    return records;
  }
  async function trpc(feed, siteRequest, processImage, onProgress, readReactions) {
    if (feed.site !== 'civitai' || !procedures.includes(feed.endpoint)) throw new Error('Unsupported Civitai feed.');
    const params = { ...feed.filters };
    // Discovery can fill the backlog independently of the live metadata worker limit.
    // The shared admission limit also bounds posts containing many images.
    params.limit = speed().discoveryBatchSize;
    if (feed.cursor != null) params.cursor = feed.cursor;
    const url = new URL(`/api/trpc/${feed.endpoint}`, feed.pageUrl);
    url.searchParams.set('input', JSON.stringify({ json: params, ...(feed.meta ? { meta: feed.meta } : {}) }));
    const response = siteRequest ? await siteRequest(url.href)
      : await request(url.href, { headers: { Accept: 'application/json' } });
    if (response.error) throw new Error(decode(response.error)?.message || 'Feed API rejected this query.');
    const data = decode(response.result?.data);
    if (!Array.isArray(data?.items)) throw new Error('Feed API format changed: missing items.');
    const catalogItems = await civitaiCatalogItems(feed, data.items, siteRequest, processImage, onProgress, readReactions);
    const items = data.items.flatMap(item => Array.isArray(item.images) ? item.images : [item]).map(civitaiImage).filter(Boolean);
    const cursor = data.nextCursor ?? null, done = cursor == null;
    if (!done && JSON.stringify(cursor) === JSON.stringify(feed.cursor)) throw new Error('Feed returned the same cursor; stopped to avoid a loop.');
    return { items, catalogItems, cursor, done, count: data.items.length };
  }
  return { fromRequests, next: trpc, decode,
    civitaiMetadata, civitaiCatalogRecord, civitaiPageReactions, imageReactions, imageCreator, hasCoreReactions, imageExceedsLimits };
})();
