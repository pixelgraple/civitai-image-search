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
  <meta name="description" content="Index Civitai turns the galleries you browse into a shared searchable library of images and prompts. Install the free community extension.">
  <title>Index Civitai · Install the community indexing extension</title>
  <link rel="stylesheet" href="extension.css?v=2.8.16">
</head>
<body>
  <header class="site-header"><a class="brand" href="/">SEARCH<span>CIVITAI</span><small>XYZ</small></a><nav aria-label="Site navigation"><a href="/">Image library</a><a href="https://github.com/pixelgraple/civitai-image-search" target="_blank" rel="noopener noreferrer">GitHub ↗</a></nav></header>
  <main>
    <section class="intro">
      <p class="eyebrow">COMMUNITY EXTENSION · VERSION 2.8.16</p>
      <h1>Browse Civitai.<br>Build a library everyone can search.</h1>
      <p class="lead">Index Civitai collects image links, prompts and generation details from your chosen galleries. The server saves image copies, and the community can search everything indexed so far.</p>
      <div class="actions"><a class="button primary" href="/downloads/index-civitai-2.8.16.zip" download>Download Index Civitai 2.8.16</a><a class="button" href="#install">Installation guide ↓</a></div>
      <p class="caption">For desktop Chromium browsers, including Chrome and Brave. No account or contributor key required.</p>
    </section>
    <section aria-labelledby="features"><div class="section-title"><p class="eyebrow">WHAT IT DOES</p><h2 id="features">Your browsing helps grow the shared index.</h2></div>
      <div class="features">
        <article><span class="number">01</span><h3>Automatic collection</h3><p>Browse normally or choose <strong>Scan this tab</strong>. Supported galleries scroll automatically to discover more images. Several open tabs can contribute, each with its own stop and resume controls.</p></article>
        <article><span class="number">02</span><h3>Search prompts and tags</h3><p>Search by prompt words, exact tags, LoRA names or captured creator usernames. Combine words and tags with AND or OR, and sort by Civitai reactions. View result counts, browse pages of image cards, and open an image with its prompt alongside it.</p></article>
        <article><span class="number">03</span><h3>Images saved on the server</h3><p>The extension submits metadata over HTTPS. The server fetches the image files. Collection does not save images to your computer or require you to hold server credentials.</p></article>
        <article><span class="number">04</span><h3>Live progress and controls</h3><p>Watch duplicate checks, prompt reads, submissions, retries and oversized skips update live. Adjust collection speed from <strong>1× to 5×</strong>. A separate 4–32 slider controls server image transfers for each tab, with live active, pending and stored counts. All tabs share a 600-image outstanding limit and 32 server transfer slots.</p></article>
        <article><span class="number">05</span><h3>Keep useful images</h3><p>A positive prompt is required. Existing stored copies skip repeat downloads; SHA-256 checks identify duplicate content. New images must be at most <strong>9 MP</strong> and <strong>4096 pixels on either side</strong>.</p></article>
        <article><span class="number">06</span><h3>Reactions and style filters</h3><p>Available Civitai reaction counts accompany the image. Visitors can also upvote and react in this library. Anime and Realistic filters use prompt and model metadata; classification is a sorting rule, not image analysis.</p></article>
      </div>
    </section>
    <section id="install" class="install" aria-labelledby="install-title">
      <div><p class="eyebrow">GET STARTED</p><h2 id="install-title">Install once.<br>Choose what to index.</h2><p>This is an unpacked browser extension. Keep its extracted folder in a permanent location.</p></div>
      <ol>
        <li><strong>Download and extract the ZIP.</strong><span>Use the download above, or the matching v2.8.16 asset on GitHub Releases.</span></li>
        <li><strong>Open your browser’s Extensions page.</strong><span>Visit <code>chrome://extensions</code> or <code>brave://extensions</code> and enable <strong>Developer mode</strong>.</span></li>
        <li><strong>Choose Load unpacked.</strong><span>Select the extracted folder containing <code>manifest.json</code>.</span></li>
        <li><strong>Open a Civitai gallery.</strong><span>Works on civitai.com and civitai.red. Open the Index Civitai panel and choose <strong>Scan this tab</strong>, or leave browsing collection enabled.</span></li>
      </ol>
      <p class="update"><strong>Already installed?</strong> Replace the files in your extension folder, click <strong>Reload</strong> on the Extensions page, and refresh your Civitai gallery tabs. Save unfinished upload or edit forms before refreshing them. Version 2.8.16 lets queued Civitai requests fill up to eight active slots across all tabs, shows successful requests per minute, and combines repeated queue saves to reduce browser CPU, memory and local storage activity during long scans. Your queued prompts and progress are retained. Reload the extension to activate the fix. The server can also repair missing metadata from previously indexed image pages; that job runs independently of your browser.</p>
    </section>
    <section class="details" aria-labelledby="details-title"><p class="eyebrow">HOW COLLECTION WORKS</p><h2 id="details-title">A few useful details</h2>
      <details><summary>Does it run without me scrolling?</summary><p>Yes, supported galleries scroll automatically while the browser and tabs remain open. Background tabs can collect without focus. Collection pauses when the queue is full, and sleeping computers or suspended tabs cannot continue normal work.</p></details>
      <details><summary>What data is shared?</summary><p>Collected records include the image ID and link, positive and available negative prompts, tags, model and LoRA names, captured uploader usernames, dimensions, and available source reactions. Submitted records and stored images become part of the public library. The browser keeps scan progress locally; the extension does not send Civitai passwords or login cookies to the library.</p></details>
      <details><summary>Why are some images skipped?</summary><p>Images need a positive prompt. New or queued images over 9,000,000 total pixels, or over 4096 pixels on either side, are skipped. Both limits apply: 4096 × 4096 exceeds 9 MP. Completed copies from before these limits remain available.</p></details>
      <details><summary>How fast does it submit?</summary><p>Up to 60 ready metadata records are sent per batch with a three-second pause. The server separately downloads up to 32 image files concurrently. Each tab has a live 4–32 transfer slider, defaulting to 32, and all contributors share those 32 server slots. Completed transfers release a slot immediately for the next file. Actual throughput depends on available prompts, browser activity, source responses and server capacity. Civitai and library rate limits still apply, and retries honor cooldowns.</p></details>
      <details><summary>Can missing metadata be recovered?</summary><p>The server can revisit indexed image links to fill missing creator names, generation resources and other metadata. Repairs preserve saved values and do not redownload image files. Only information exposed by the source can be recovered; some images have no LoRAs or hide their generation details.</p></details>
      <details><summary>Does this search all of Civitai?</summary><p>Search covers the images contributors have indexed. Collection follows chosen browser pages and uses their feed and detail requests. It is not a complete mirror of Civitai, and missing prompts or unavailable source data cannot be invented.</p></details>
    </section>
    <section class="closing"><div><h2>Help make prompts easier to find.</h2><p>Index the galleries you choose, then search the growing community library.</p></div><a class="button primary" href="/">Explore the library ↗</a></section>
  </main>
  <footer><span>Independent community project.</span><a href="https://github.com/pixelgraple/civitai-image-search" target="_blank" rel="noopener noreferrer">Source and documentation on GitHub ↗</a><a href="/downloads/index-civitai-2.8.16.zip" download>Download 2.8.16</a></footer>
</body>
</html>
