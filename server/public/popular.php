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
  <title>Popular · Users, Models &amp; LoRAs · Search Civitai</title>
  <link rel="stylesheet" href="style.css?v=pg13-3">
  <link rel="stylesheet" href="access-gate.css?v=captcha1">
  <link rel="stylesheet" href="popular.css?v=popular1">
  <link rel="stylesheet" href="discovery.css?v=discovery2">
</head>
<body class="popular-page">
  <div id="libraryShell" inert aria-hidden="true">
  <header class="topbar">
    <a class="brand" href="/" aria-label="Search Civitai home"><span>SEARCH<span class="brand-accent">CIVITAI</span></span><span class="brand-domain">XYZ</span></a>
    <form id="searchForm" class="search" role="search" action="/" method="get">
      <span class="search-kind" aria-hidden="true">Images</span>
      <label id="queryLabel" class="sr-only" for="query">Search positive prompts and tags</label>
      <input id="query" name="q" type="search" maxlength="300" autocomplete="off" placeholder="Search prompt words or tags…">
      <label class="sr-only" for="qMode">Combine search words</label><select id="qMode" name="qMode" class="query-mode" title="Choose whether every word or any word must match"><option value="all">All words (AND)</option><option value="any">Any word (OR)</option></select>
      <button class="search-submit" type="submit" aria-label="Search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"></circle><path d="m16 16 5 5"></path></svg></button>
    </form>
    <nav class="extension-nav" aria-label="Extension and guide"><a class="extension-link" href="/downloads/index-civitai-2.8.28.zip" download><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"></path></svg><span>Index Civitai</span></a><a class="guide-link" href="/guide.php">GUIDE</a></nav>
  </header>
  <div class="browsebar">
    <?php $libraryActive=$libraryActive??'popular'; require __DIR__.'/library-nav.php'; ?>
    <span id="health" class="library-health" role="status">Connecting…</span>
  </div>
  <main class="popular-main">
    <header class="popular-heading">
      <div><p class="popular-eyebrow">COMMUNITY DISCOVERY</p><h1>Popular in the library</h1><p>Find creators, checkpoints and LoRAs behind the images indexed here.</p></div>
      <div class="popular-safety"><label for="popularPg13"><input id="popularPg13" type="checkbox" checked><span>PG-13 filter</span></label><p>On by default. Rankings and previews follow this filter.</p></div>
    </header>
    <div class="popular-toolbar">
      <div id="popularTabs" class="popular-tabs" role="tablist" aria-label="Popular rankings">
        <button id="popularUsers" type="button" role="tab" data-type="users" aria-selected="true" aria-controls="popularPanel">Users</button>
        <button id="popularModels" type="button" role="tab" data-type="models" aria-selected="false" aria-controls="popularPanel" tabindex="-1">Models</button>
        <button id="popularLoras" type="button" role="tab" data-type="loras" aria-selected="false" aria-controls="popularPanel" tabindex="-1">LoRAs</button>
      </div><span class="popular-limit">TOP 50</span>
    </div>
    <section id="popularPanel" role="tabpanel" aria-labelledby="popularUsers" aria-busy="true">
      <div class="popular-section-heading"><div><h2 id="popularTitle">Popular uploaders</h2><p id="popularDescription">At least 50 indexed images, each with 200+ combined Civitai reactions.</p></div><span id="popularUpdated"></span></div>
      <p id="popularStatus" class="popular-status" role="status" aria-live="polite">Verify to explore the rankings.</p>
      <div id="popularResults" class="popular-grid"></div>
    </section>
    <aside class="popular-explainer"><h2>How rankings work</h2><div>
      <p><b>Users</b>Each qualifying image has at least 200 recorded likes, hearts, laughs and cries combined. Creators need 50 qualifying images; the most qualifying images rank first.</p>
      <p><b>Models &amp; LoRAs</b>Ranked by indexed image count. Each LoRA is counted once per image. Select a card to browse that exact creator or resource.</p>
      <p><b>Captured from Civitai</b>Buzz and Search Civitai votes are excluded. Missing source counts may undercount popularity. Rankings refresh every 15 minutes and cover our indexed library.</p>
    </div></aside>
    <footer><span>Search Civitai · A community prompt library</span><a href="/">Browse images</a><a href="/guide.php">Contributor guide</a><a href="/extension.php">Install extension</a></footer>
  </main>

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
  <script src="access-gate.js?v=deadline60" defer></script>
  <script src="gallery-images.js?v=cards1" defer></script>
  <script src="popular.js?v=discovery1" defer></script>
</body>
</html>

