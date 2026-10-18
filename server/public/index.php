<?php
header("Content-Security-Policy: default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'");
header('Referrer-Policy: strict-origin-when-cross-origin');
header('X-Content-Type-Options: nosniff');
header('X-Frame-Options: DENY');
?>
<!doctype html>
<html lang="en" class="access-locked">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="description" content="Search the community Civitai image library by prompt, tags, model, LoRA, or creator, and sort by Civitai reactions.">
  <title>Search Civitai · Community image library</title>
  <link rel="stylesheet" href="style.css?v=pg13-3">
  <link rel="stylesheet" href="access-gate.css?v=captcha1">
  <link rel="stylesheet" href="popular.css?v=popular1">
  <link rel="stylesheet" href="discovery.css?v=discovery2">
</head>
<body>
  <div id="libraryShell" inert aria-hidden="true">
  <header class="topbar">
    <a class="brand" href="/" aria-label="Search Civitai home"><span>SEARCH<span class="brand-accent">CIVITAI</span></span><span class="brand-domain">XYZ</span></a>
    <form id="searchForm" class="search" role="search">
      <span class="search-kind" aria-hidden="true">Images</span>
      <label id="queryLabel" class="sr-only" for="query">Search positive prompts and tags</label>
      <input id="query" type="search" maxlength="300" autocomplete="off" placeholder="Search words, tags or "quoted phrases"…">
      <label class="sr-only" for="qMode">Combine search words</label><select id="qMode" class="query-mode" title="Choose whether every word or any word must match"><option value="all">All words (AND)</option><option value="any">Any word (OR)</option></select>
      <button class="search-submit" type="submit" aria-label="Search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"></circle><path d="m16 16 5 5"></path></svg></button>
    </form>
    <nav class="extension-nav" aria-label="Extension and guide"><a class="extension-link" href="/downloads/index-civitai-2.8.23.zip" download><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"></path></svg><span>Index Civitai</span></a><a class="guide-link" href="/guide.php">GUIDE</a></nav>
  </header>
  <div class="browsebar">
    <?php $libraryActive=$libraryActive??'images'; require __DIR__.'/library-nav.php'; ?>
    <span id="health" class="library-health" role="status">Connecting…</span>
  </div>
  <main>
    <section class="discover-banner" id="discoverBanner" hidden><div><h1>Discover something different</h1><p>A shuffled gallery of stored images. Your search and PG-13 filters still apply.</p></div><button type="button" id="shuffleImages" class="shuffle-button">Shuffle images ↻</button></section>
    <div id="layoutPreview" class="layout-preview" hidden role="status"><span><b>Layout preview</b> <span id="previewDescription">48 repeated cards from one stored image. The library is unchanged.</span></span><a href="/">Exit preview ↗</a></div>
    <section class="catalog-controls" aria-label="Image search filters">
      <section class="resource-search-bar" aria-labelledby="resourceSearchTitle">
        <div class="resource-search-heading"><h1 id="resourceSearchTitle">Search within a model or LoRA</h1><p id="resourceSearchHelp">Match any part of a name, ignoring case. No % needed. Leave blank to search all models.</p></div>
        <div class="resource-search-fields">
          <div class="resource-field"><label for="model">Checkpoint / model</label><input id="model" type="search" maxlength="300" autocomplete="off" placeholder="Any part of a model name, e.g. Krea2" aria-describedby="resourceSearchHelp"></div>
          <div class="resource-field"><label for="lora">LoRA</label><input id="lora" type="search" maxlength="200" autocomplete="off" placeholder="Any part of a LoRA name" aria-describedby="resourceSearchHelp"></div>
          <div class="resource-field resource-tags"><label for="tag">Source tags <span>optional</span></label><div class="tag-input"><input id="tag" type="text" maxlength="1000" placeholder="beach, landscape" aria-describedby="tagHelp"><label class="sr-only" for="tagMode">Combine source tags</label><select id="tagMode"><option value="all">All tags (AND)</option><option value="any">Any tag (OR)</option></select></div></div>
          <button id="searchWithin" class="apply-filters" type="button">Search images</button>
        </div>
        <div class="resource-search-notes"><p>Each filled field must match, together with your search words above.</p><p id="tagHelp">Separate up to 20 exact tags with commas. AND requires every tag; OR accepts any tag.</p></div>
      </section>
      <div class="filterbar">
        <div id="counts" class="style-tabs" role="group" aria-label="Image style">
          <button type="button" class="style-tab is-active" data-category="" aria-pressed="true">All styles</button>
          <button type="button" class="style-tab" data-category="anime" aria-pressed="false">Anime</button>
          <button type="button" class="style-tab" data-category="realistic" aria-pressed="false">Realistic</button>
          <button type="button" class="style-tab" data-category="uncertain" aria-pressed="false">Uncertain</button>
        </div>
        <details id="filterPanel" class="filter-panel"><summary><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M7 12h10M10 17h4"></path></svg>Filters<span id="filterCount" class="filter-count" hidden></span></summary><div class="filter-popover">
          <div class="filter-panel-heading"><b>Find your next reference</b><span>Combine filters to narrow the library</span></div>
          <div class="filter-fields">
            <div class="filter-field"><label for="qScope">Search words in</label><select id="qScope" aria-describedby="qScopeHelp"><option value="prompt_tags">Positive prompts + tags</option><option value="prompt">Positive prompts only</option><option value="all">All metadata</option></select><p id="qScopeHelp">All metadata also searches negative prompts, model names and LoRA names.</p></div>
            <div class="filter-field"><label for="creator">Creator username</label><input id="creator" type="search" maxlength="200" autocomplete="off" placeholder="Username or @username" aria-describedby="metadataHelp"></div>
            <div class="filter-field filter-field-wide"><label for="category">Image style</label><select id="category"><option value="">All styles</option><option value="anime">Anime</option><option value="realistic">Realistic</option><option value="uncertain">Uncertain</option></select><p>Anime includes fantasy, illustration and animation cues. Other images are sorted as Realistic; Uncertain is retained for older records.</p></div>
            <div class="filter-field"><label for="source">Captured source</label><select id="source"><option value="">Both Civitai sources</option><option value="com">Civitai.com</option><option value="red">Civitai.red</option><option value="unknown">Unknown / older record</option></select><p>Use this to browse one source, or leave it on both.</p></div>
            <div class="filter-field filter-field-wide"><label for="exclude">Prompt words or phrases to exclude</label><input id="exclude" type="text" maxlength="500" placeholder='watermark "motion blur"'><p>Use quotes to keep a phrase together. Any match in the positive prompt excludes the image.</p></div>
            <div class="filter-field"><label for="minReactions">Minimum Civitai reactions</label><input id="minReactions" type="number" min="0" max="10000000" step="1" placeholder="Any"><p>Combined recorded likes, hearts, laughs and cries.</p></div>
            <div class="filter-field"><label for="orientation">Image shape</label><select id="orientation"><option value="">Any shape</option><option value="portrait">Portrait</option><option value="landscape">Landscape</option><option value="square">Square / near square</option></select></div>
            <div class="filter-field"><label for="minWidth">Minimum width (px)</label><input id="minWidth" type="number" min="0" max="4096" step="1" placeholder="Any"></div>
            <div class="filter-field"><label for="minHeight">Minimum height (px)</label><input id="minHeight" type="number" min="0" max="4096" step="1" placeholder="Any"></div>
            <div class="filter-field"><label for="maxWidth">Maximum width (px)</label><input id="maxWidth" type="number" min="0" max="4096" step="1" placeholder="Any"></div>
            <div class="filter-field"><label for="maxHeight">Maximum height (px)</label><input id="maxHeight" type="number" min="0" max="4096" step="1" placeholder="Any"></div>
            <div class="filter-field filter-field-wide"><label for="ready">Image availability</label><select id="ready"><option value="0">All indexed images</option><option value="1">Stored images only</option></select></div>
            <div class="filter-field filter-field-wide safety-filter"><label class="filter-checkbox"><input id="pg13" type="checkbox" checked><span>PG-13 safe filter</span></label><p>On by default. A conservative filter checks prompts, tags, models and LoRAs for nudity, chest exposure, sexual content and spelling disguises on both Civitai sources. Some safe images may also be hidden. Metadata filtering cannot guarantee that an image is free of nudity. Turn it off to browse all indexed content.</p></div>
          </div>
          <p id="metadataHelp" class="filter-source-note">Model, LoRA and creator searches match names captured from the source, ignoring case. Older images may be missing this metadata. Each filled filter must match. The PG-13 rule is applied on the server before counts and pagination; it is never just a visual hide.</p>
          <div class="filter-actions"><button id="clearFilters" class="clear-filters" type="button">Clear all</button><button id="applyFilters" class="apply-filters" type="button">Apply filters</button></div>
        </div></details>
      </div>
      <div id="topics" class="topic-chips" role="group" aria-label="Quick prompt searches">
        <button type="button" data-query="" aria-pressed="true" class="is-active">All</button><button type="button" data-query="animal" aria-pressed="false">Animal</button><button type="button" data-query="beach" aria-pressed="false">Beach</button><button type="button" data-query="cartoon" aria-pressed="false">Cartoon</button><button type="button" data-query="cat" aria-pressed="false">Cat</button><button type="button" data-query="cosplay" aria-pressed="false">Cosplay</button><button type="button" data-query="cyberpunk" aria-pressed="false">Cyberpunk</button><button type="button" data-query="dog" aria-pressed="false">Dog</button><button type="button" data-query="dragon" aria-pressed="false">Dragon</button><button type="button" data-query="fantasy" aria-pressed="false">Fantasy</button><button type="button" data-query="landscape" aria-pressed="false">Landscape</button><button type="button" data-query="mecha" aria-pressed="false">Mecha</button><button type="button" data-query="portrait" aria-pressed="false">Portrait</button><button type="button" data-query="selfie" aria-pressed="false">Selfie</button><button type="button" data-query="steampunk" aria-pressed="false">Steampunk</button>
      </div>
      <div class="resultbar"><span id="resultCount" role="status" aria-live="polite" tabindex="-1">Loading images…</span><label class="sort-control" for="sort"><span>Sort</span><select id="sort" aria-describedby="sortHelp"><option value="newest">Newest</option><option value="civitai_reactions">Most Civitai reactions</option><option value="upvotes">Community upvotes</option><option value="random">Random discovery</option></select></label></div>
      <div id="searchContext" class="search-context" hidden><div id="activeFilters" class="active-filters" aria-label="Applied search filters"></div><p id="sortHelp" class="sort-help" hidden>Sorted by captured Civitai likes, hearts, laughs and cries combined. Incomplete counts appear last. Buzz and this site's community votes are excluded.</p></div>
    </section>
    <section id="results" class="results" aria-label="Matching images" aria-busy="true"><div class="access-skeleton-card" aria-hidden="true"></div><div class="access-skeleton-card" aria-hidden="true"></div><div class="access-skeleton-card" aria-hidden="true"></div><div class="access-skeleton-card" aria-hidden="true"></div><div class="access-skeleton-card" aria-hidden="true"></div><div class="access-skeleton-card" aria-hidden="true"></div><div class="access-skeleton-card" aria-hidden="true"></div><div class="access-skeleton-card" aria-hidden="true"></div><div class="access-skeleton-card" aria-hidden="true"></div><div class="access-skeleton-card" aria-hidden="true"></div><div class="access-skeleton-card" aria-hidden="true"></div><div class="access-skeleton-card" aria-hidden="true"></div><div class="access-skeleton-card" aria-hidden="true"></div><div class="access-skeleton-card" aria-hidden="true"></div></section>
    <nav id="pagination" class="pagination" aria-label="Search result pages"></nav>
    <footer><span>Search Civitai · A community prompt library</span><span>Search covers indexed images. Copies may still be processing.</span><a href="/guide.php">Contributor guide</a><a href="/extension.php">Install extension</a><a href="https://github.com/pixelgraple/civitai-image-search" target="_blank" rel="noopener noreferrer">GitHub ↗</a><a href="/?preview=layout">Layout preview</a><a href="/downloads/index-civitai-2.8.23.zip" download>Index Civitai 2.8.23</a></footer>
  </main>
  <dialog id="imageViewer" class="image-viewer" aria-labelledby="viewerTitle">
    <div class="viewer-toolbar"><div class="viewer-toolbar-left"><button id="closeViewer" type="button" class="icon-button" aria-label="Close image viewer"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"></path></svg></button><span id="viewerPosition"></span></div><div class="viewer-actions"><a id="viewerSimilar" class="viewer-similar" href="#">More like this ↗</a><a id="viewerSource" class="viewer-source" href="#" target="_blank" rel="noopener noreferrer">Open on Civitai ↗</a><a id="viewerDownload" class="viewer-download" href="#" download>Download original</a></div></div>
    <div class="viewer-layout"><div class="viewer-stage"><button id="viewerPrev" class="viewer-arrow viewer-prev" type="button" aria-label="Previous image">‹</button><div id="viewerMedia" class="viewer-media"></div><button id="viewerNext" class="viewer-arrow viewer-next" type="button" aria-label="Next image">›</button><section id="viewerReactions" class="viewer-reactions" aria-label="Community reactions"></section></div><aside id="viewerDetails" class="viewer-details"></aside></div>
    <span id="viewerStatus" class="viewer-status" role="status" aria-live="polite"></span>
  </dialog>
  </div>
  <section id="accessPreloader" class="access-preloader" role="status" aria-live="polite" aria-label="Preparing the library"><div class="access-loading"><strong>SEARCH<span>CIVITAI</span></strong><span class="access-spinner" aria-hidden="true"></span><p>Preparing your library…</p></div></section>
  <dialog id="accessDialog" class="access-dialog" aria-labelledby="accessTitle" aria-describedby="accessDescription">
    <div class="access-card"><p class="access-eyebrow">Search Civitai · Community library</p><span class="access-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 3 4 6v5c0 5 4 8 8 10 4-2 8-5 8-10V6l-8-3Z"></path><path d="m8 12 3 3 5-6"></path></svg></span><h1 id="accessTitle" tabindex="-1">One quick check.</h1><p id="accessDescription" class="access-description">A quick check before you explore the image library.</p>
      <form id="accessForm" novalidate>
        <div class="access-image-box"><img id="accessImage" alt="Verification code: six characters" width="360" height="112" hidden><span id="accessImagePlaceholder" class="access-image-placeholder">Preparing your code…</span></div>
        <div class="access-code-tools"><span>Enter the six characters shown</span><button id="accessRefresh" class="access-refresh" type="button"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 13 3M18 18a8 8 0 0 1-13-3"></path></svg>New code</button></div>
        <label for="accessAnswer">Verification code</label><input id="accessAnswer" class="access-answer" type="text" maxlength="6" minlength="6" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="••••••" aria-describedby="accessMessage" disabled>
        <button id="accessSubmit" class="access-submit" type="submit" disabled>Enter the library</button><p id="accessMessage" class="access-message" role="status" aria-live="polite"></p><button id="accessRetry" class="access-retry" type="button" hidden>Try again</button>
      </form>
      <p class="access-note"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2"></path></svg><span>One check unlocks the library for one hour in this browser.</span></p>
    </div>
  </dialog>
  <noscript><div class="access-noscript"><h1>JavaScript is needed to continue.</h1><p>Enable JavaScript and reload this page to complete verification and open the image library.</p><a href="/guide.php">Read the contributor guide</a></div></noscript>
  <script src="access-gate.js?v=captcha1" defer></script>
  <script src="gallery-images.js?v=cards1" defer></script>
  <script src="app.js?v=discovery1" defer></script>
</body>
</html>

