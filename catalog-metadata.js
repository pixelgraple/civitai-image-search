/* Match the server's bounded UTF-8 metadata fields at the upload boundary.
 * Existing queued records also pass here; original prompts remain in IndexedDB.
 */
globalThis.ISSCatalogMetadata = (() => {
  function text(value, limit) {
    if (typeof value !== 'string') return '';
    const clean = value.toWellFormed ? value.toWellFormed() : Array.from(value, c =>
      c.length===1 && c.charCodeAt(0)>=0xD800 && c.charCodeAt(0)<=0xDFFF ? '\uFFFD' : c).join('');
    return Array.from(clean.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g,'').replace(/\s+/gu,' ').trim()).slice(0,limit).join('');
  }
  function names(values) {
    if (!Array.isArray(values)) return [];
    const out=new Set();
    for (const value of values) {
      const name=text(typeof value==='string'?value:value?.name,200);
      if (name) out.add(name);
      if (out.size>=200) break;
    }
    return [...out];
  }
  function record(value) {
    return {...value,tags:names(value.tags),loras:names(value.loras),
      modelName:text(value.modelName,300),creatorName:text(value.creatorName,200)};
  }
  return Object.freeze({text,names,record});
})();
