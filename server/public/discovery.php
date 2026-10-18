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
  <title>Explore · Models, LoRAs, Creators &amp; Recipes · Search Civitai</title>
  <link rel="stylesheet" href="style.css?v=pg13-3">
  <link rel="stylesheet" href="access-gate.css?v=captcha1">
  <link rel="stylesheet" href="popular.css?v=popular1">
  <link rel="stylesheet" href="discovery.css?v=discovery2">
</head>
<body class="popular-page discovery-page">
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
    <nav class="extension-nav" aria-label="Extension and guide"><a class="extension-link" href="/downloads/index-civitai-2.8.24.zip" download><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"></path></svg><span>Index Civitai</span></a><a class="guide-link" href="/guide.php">GUIDE</a></nav>
  </header>
  <div class="browsebar">
    <?php $libraryActive='discovery'; require __DIR__.'/library-nav.php'; ?>
    <span id="health" class="library-health" role="status">Connecting…</span>
  </div>
  <main class="popular-main">
    <header class="popular-heading">
      <div><p class="popular-eyebrow">EXPLORE THE INDEX</p><h1 id="directoryTitle">Models</h1><p id="directoryDescription">Explore resources and the images made with them.</p></div>
      <div class="popular-safety"><label for="directoryPg13"><input id="directoryPg13" type="checkbox" checked><span>PG-13 filter</span></label><p>Counts, names and previews follow your filter.</p></div>
    </header>
    <form id="directorySearch" class="discovery-search" role="search">
      <label>Find in this directory<input id="directoryQuery" type="search" maxlength="200" autocomplete="off" placeholder="Search names…"></label>
      <label id="phraseKindLabel" class="phrase-kind" hidden>Explore<select id="phraseKind"><option value="phrases">Prompt phrases</option><option value="tags">Source tags</option></select></label>
      <button type="submit">Search directory</button>
    </form>
    <form id="customPhraseForm" class="discovery-search" hidden>
      <label>Explore any prompt phrase<input id="customPhrase" type="text" maxlength="250" required placeholder="e.g. soft window light"></label>
      <label>Within a checkpoint <span class="discovery-note">optional · partial name</span><input id="phraseModel" type="search" maxlength="300" placeholder="e.g. Krea2"></label>
      <button type="submit">Find image examples ↗</button>
    </form>
    <a id="directoryBack" class="discovery-back" href="/discovery.php" hidden>← Back to directory</a>
    <p id="directoryStatus" class="popular-status" role="status" aria-live="polite">Verify to explore the library.</p>
    <section id="directoryProfile" class="discovery-profile" aria-label="Profile" hidden></section>
    <section id="directoryResults" class="popular-grid" aria-label="Directory results" aria-busy="true"></section>
    <nav id="directoryPagination" class="pagination" aria-label="Directory pages"></nav>
    <aside class="popular-explainer"><h2>About this directory</h2><p id="directoryNote" class="discovery-note">Counts cover this indexed library. Metadata may be incomplete. Discovery refreshes every 15 minutes.</p></aside>
    <footer><span>Search Civitai · Community discovery</span><a href="/">Browse images</a><a href="/guide.php">Contributor guide</a></footer>
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
  <script src="access-gate.js?v=captcha1" defer></script>
  <script src="gallery-images.js?v=cards1" defer></script>
  <script src="discovery.js?v=discovery3" defer></script>
</body>
</html>

