<?php
header("Content-Security-Policy: default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'");
header('Referrer-Policy: strict-origin-when-cross-origin');
header('X-Content-Type-Options: nosniff');
header('X-Frame-Options: DENY');
?>
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="description" content="Search the community Civitai image library by prompt, tag, model, or LoRA.">
  <title>Search Civitai · Community image library</title>
  <link rel="stylesheet" href="style.css?v=community-reactions-v1">
</head>
<body>
  <header class="topbar">
    <a class="brand" href="/" aria-label="Search Civitai home"><span>SEARCH<span class="brand-accent">CIVITAI</span></span><span class="brand-domain">XYZ</span></a>
    <form id="searchForm" class="search" role="search">
      <span class="search-kind" aria-hidden="true">Images</span>
      <label class="sr-only" for="query">Search prompt text, tags, models, and LoRAs</label>
      <input id="query" type="search" maxlength="300" autocomplete="off" placeholder="Search prompts, tags, models, LoRAs…">
      <button class="search-submit" type="submit" aria-label="Search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"></circle><path d="m16 16 5 5"></path></svg></button>
    </form>
    <a class="extension-link" href="/downloads/index-civitai-2.8.11.zip" download><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"></path></svg><span>Index Civitai</span></a>
  </header>
  <div class="browsebar">
    <div class="browse-title"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"></rect><circle cx="8" cy="8" r="1.5"></circle><path d="m3 17 6-6 5 5 3-3 4 4"></path></svg><b>Images</b><span>Community library</span></div>
    <span id="health" class="library-health" role="status">Connecting…</span>
  </div>
  <main>
    <div id="layoutPreview" class="layout-preview" hidden role="status"><span><b>Layout preview</b> <span id="previewDescription">48 repeated cards from one stored image. The library is unchanged.</span></span><a href="/">Exit preview ↗</a></div>
    <section class="catalog-controls" aria-label="Image search filters">
      <div class="filterbar">
        <div id="counts" class="style-tabs" role="group" aria-label="Image style">
          <button type="button" class="style-tab is-active" data-category="" aria-pressed="true">All styles</button>
          <button type="button" class="style-tab" data-category="anime" aria-pressed="false">Anime</button>
          <button type="button" class="style-tab" data-category="realistic" aria-pressed="false">Realistic</button>
          <button type="button" class="style-tab" data-category="uncertain" aria-pressed="false">Uncertain</button>
        </div>
        <details id="filterPanel" class="filter-panel"><summary><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M7 12h10M10 17h4"></path></svg>Filters</summary><div class="filter-popover">
          <label for="tag">Exact source tag</label><div class="tag-input"><input id="tag" type="text" maxlength="100" placeholder="For example: selfie"><button id="applyTag" type="button">Apply</button></div>
          <label for="category">Image style</label><select id="category"><option value="">All styles</option><option value="anime">Anime</option><option value="realistic">Realistic</option><option value="uncertain">Uncertain</option></select>
          <p>Anime includes fantasy, illustration and animation cues in prompt or generation metadata. Other images are sorted as Realistic. Uncertain is retained for older records.</p><button id="clearFilters" class="clear-filters" type="button">Clear search and filters</button>
        </div></details>
      </div>
      <div id="topics" class="topic-chips" role="group" aria-label="Quick prompt searches">
        <button type="button" data-query="" aria-pressed="true" class="is-active">All</button><button type="button" data-query="animal" aria-pressed="false">Animal</button><button type="button" data-query="beach" aria-pressed="false">Beach</button><button type="button" data-query="cartoon" aria-pressed="false">Cartoon</button><button type="button" data-query="cat" aria-pressed="false">Cat</button><button type="button" data-query="cosplay" aria-pressed="false">Cosplay</button><button type="button" data-query="cyberpunk" aria-pressed="false">Cyberpunk</button><button type="button" data-query="dog" aria-pressed="false">Dog</button><button type="button" data-query="dragon" aria-pressed="false">Dragon</button><button type="button" data-query="fantasy" aria-pressed="false">Fantasy</button><button type="button" data-query="landscape" aria-pressed="false">Landscape</button><button type="button" data-query="mecha" aria-pressed="false">Mecha</button><button type="button" data-query="portrait" aria-pressed="false">Portrait</button><button type="button" data-query="selfie" aria-pressed="false">Selfie</button><button type="button" data-query="steampunk" aria-pressed="false">Steampunk</button>
      </div>
      <div class="resultbar"><span id="resultCount" role="status" aria-live="polite">Loading images…</span><span id="activeFilters"></span><label class="sort-control" for="sort"><span>Sort</span><select id="sort"><option value="newest">Newest</option><option value="upvotes">Most upvoted</option></select></label></div>
    </section>
    <section id="results" class="results" aria-label="Matching images" aria-busy="true"></section>
    <nav id="pagination" class="pagination" aria-label="Search result pages"></nav>
    <footer><span>Search Civitai · A community prompt library</span><span>Search covers indexed images. Copies may still be processing.</span><a href="/extension.php">Extension guide</a><a href="https://github.com/pixelgraple/civitai-image-search" target="_blank" rel="noopener noreferrer">GitHub ↗</a><a href="/?preview=layout">Layout preview</a><a href="/downloads/index-civitai-2.8.11.zip" download>Index Civitai 2.8.11</a></footer>
  </main>
  <dialog id="imageViewer" class="image-viewer" aria-labelledby="viewerTitle">
    <div class="viewer-toolbar"><div class="viewer-toolbar-left"><button id="closeViewer" type="button" class="icon-button" aria-label="Close image viewer"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"></path></svg></button><span id="viewerPosition"></span></div><div class="viewer-actions"><a id="viewerSource" class="viewer-source" href="#" target="_blank" rel="noopener noreferrer">Open on Civitai ↗</a><a id="viewerDownload" class="viewer-download" href="#" download>Download original</a></div></div>
    <div class="viewer-layout"><div class="viewer-stage"><button id="viewerPrev" class="viewer-arrow viewer-prev" type="button" aria-label="Previous image">‹</button><div id="viewerMedia" class="viewer-media"></div><button id="viewerNext" class="viewer-arrow viewer-next" type="button" aria-label="Next image">›</button><section id="viewerReactions" class="viewer-reactions" aria-label="Community reactions"></section></div><aside id="viewerDetails" class="viewer-details"></aside></div>
    <span id="viewerStatus" class="viewer-status" role="status" aria-live="polite"></span>
  </dialog>
  <script src="app.js?v=classifier-v6"></script>
</body>
</html>
