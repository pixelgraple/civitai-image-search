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
  <meta name="description" content="Help index Civitai with the Index Civitai extension. Choose a gallery, start a scan, and keep working while images and prompts join the shared searchable library.">
  <title>GUIDE · Help index Civitai</title>
  <link rel="stylesheet" href="extension.css?v=2.8.18">
  <link rel="stylesheet" href="guide.css?v=contributor-guide-v1">
</head>
<body class="guide-page">
  <a class="guide-skip" href="#guide-content">Skip to the guide</a>
  <header class="site-header"><a class="brand" href="/" aria-label="Search Civitai home">SEARCH<span>CIVITAI</span><small>XYZ</small></a><nav class="contributor-nav" aria-label="Site navigation"><a class="library-nav" href="/">Image library</a><a class="nav-download" href="/downloads/index-civitai-2.8.18.zip" download>Index Civitai ↓</a><a class="nav-guide" href="/guide.php" aria-current="page">GUIDE</a></nav></header>
  <main id="guide-content" class="guide-main">
    <section class="guide-hero" aria-labelledby="guide-title">
      <div><p class="eyebrow">THE COMMUNITY CONTRIBUTOR GUIDE</p><h1 id="guide-title">Help everyone find<br>the images you love.</h1><p class="lead">Choose a Civitai gallery you like, start a scan, and let Index Civitai collect its prompts and images for our shared search library. You can keep using other tabs while it works.</p><div class="actions"><a class="button primary" href="#start-collecting">Start collecting ↓</a><a class="button" href="/extension.php#install">Install the extension</a></div><p class="caption">Works on civitai.com and civitai.red · No account or contributor key needed</p></div>
      <aside class="guide-glance" aria-labelledby="glance-title"><p class="eyebrow">AT A GLANCE</p><h2 id="glance-title">You choose the gallery.<br>We build the library together.</h2><dl><div><dt>You control</dt><dd>Which tabs scan and how many Civitai requests run at once.</dd></div><div><dt>The extension collects</dt><dd>Image links, prompts and available generation details.</dd></div><div><dt>The server saves</dt><dd>Image copies for everyone to search. No automatic image downloads to your computer.</dd></div></dl><a href="/">Explore what we’ve indexed ↗</a></aside>
    </section>

    <section id="start-collecting" class="guide-walkthrough" aria-labelledby="steps-title">
      <div class="guide-section-heading"><div><p class="eyebrow">FIVE SIMPLE STEPS</p><h2 id="steps-title">Pick a gallery. Start a scan. Keep doing your thing.</h2></div><p>Already installed? You’re ready.<br>New here? <a href="/extension.php#install">Install Index Civitai first.</a></p></div>
      <ol class="guide-steps">
        <li><span class="step-number" aria-hidden="true">01</span><div><h3>Open a gallery you really like</h3><p>Go to an image gallery on <strong>civitai.com</strong> or <strong>civitai.red</strong>. Choose a creator, model, tag or set of filters that interests you. This is the feed your scan will follow.</p><p class="step-note">Different tastes help us build a more useful, varied library.</p></div></li>
        <li><span class="step-number" aria-hidden="true">02</span><div><h3>Open Index Civitai</h3><p>While you’re on that gallery tab, click <strong>Index Civitai</strong> in your browser toolbar. If it’s hidden, open the browser’s extensions menu and select it there.</p><p class="step-note">Pin the extension to your toolbar if you’d like easier access next time.</p></div></li>
        <li><span class="step-number" aria-hidden="true">03</span><div><h3>Choose your settings with the cogwheel</h3><p>Open <strong>Collection settings</strong>. Choose your preferred request limit. <strong>Collect images as you browse</strong> also lets you contribute visible images during normal browsing; starting a scan is what enables automatic scrolling on that gallery.</p><div class="guide-setting"><div><strong>Civitai requests at once</strong><span>Start at <b>1</b> · Adjustable up to <b>4</b></span></div><p>This limit is shared across your scanning tabs. Start with the default of 1; higher settings may trigger Civitai rate limits. Changes apply while you scan.</p></div><p class="step-note">The defaults are enough to get started. Collection speed and server transfers are available under Advanced settings.</p></div></li>
        <li><span class="step-number" aria-hidden="true">04</span><div><h3>Click Done, then Scan this tab</h3><p>Close settings with <strong>Done</strong>, then click <strong>Scan this tab</strong>. The panel changes to <strong>Scanning this tab’s feed</strong> and shows live progress as images are discovered, checked and submitted.</p><p class="step-note">Only tabs you explicitly start scanning auto-scroll. Your other Civitai browsing tabs stay under your control.</p></div></li>
        <li><span class="step-number" aria-hidden="true">05</span><div><h3>Leave it open and carry on</h3><p>Keep the gallery tab and browser open, and keep your computer awake. You can switch to other tabs and do other work while collection continues. <strong>You don’t need to stay on the tab or scroll it yourself.</strong></p><p>When the feed reaches its end, look for <strong>This tab’s feed finished</strong> and allow any remaining queued work to clear. Image copies may finish processing on the server afterward.</p><p class="step-note">Want to help with another gallery? Open it in a new tab and start its own scan. Each tab has its own Stop tab and Resume tab controls.</p></div></li>
      </ol>
    </section>

    <section class="guide-progress" aria-labelledby="progress-title"><div><p class="eyebrow">FOLLOW THE PROGRESS</p><h2 id="progress-title">See your contribution grow.</h2><p>Open <strong>Browsing &amp; activity</strong> for combined progress, or expand <strong>Queue &amp; transfer details</strong> in the tab’s panel.</p></div><dl><div><dt>Accepted</dt><dd>The server accepted the image’s prompt record. Its image file may still be processing.</dd></div><div><dt>Copies skipped</dt><dd>An existing stored copy was found, so it doesn’t need another download.</dd></div><div><dt>No prompt</dt><dd>The image has no usable positive prompt, so it can’t join this prompt-search library.</dd></div></dl></section>

    <section class="guide-faq details" aria-labelledby="faq-title"><p class="eyebrow">GOOD TO KNOW</p><h2 id="faq-title">A few answers before you leave it running</h2>
      <details><summary>Will it collect in a background tab?</summary><p>Yes. The gallery doesn’t need to be your active tab. Keep it open with the browser running and computer awake. A browser’s sleeping-tab feature or a sleeping computer can pause progress.</p></details>
      <details><summary>Why did scrolling or processing pause?</summary><p>The extension pauses discovery when its shared queue reaches 600 outstanding images, then continues when space becomes available. Civitai rate limits also trigger a cooldown. Watch the status message, keep the tab open, and give it time to resume. A counter showing zero active requests between batches is normal.</p></details>
      <details><summary>Will every image in the gallery be saved?</summary><p>Only eligible images with a nonblank positive prompt are indexed. Existing copies are skipped, and new images must be at most 9 MP in total and 4096 pixels on either side. Some source images hide their generation details or become unavailable.</p></details>
      <details><summary>How do I pause or finish a scan?</summary><p>Use <strong>Stop tab</strong> to pause that tab, then <strong>Resume tab</strong> when you want to continue. A scan finishes when its selected feed reaches the end; a large or continuously changing feed may take a while. Passive collection can remain on for visible images after a feed scan finishes, but automatic scrolling stops. Use <strong>Stop tab</strong> when you’re done contributing.</p></details>
      <details><summary>Where do the images and prompts go?</summary><p>The extension submits prompt records to search-civitai.xyz. Our server downloads eligible image copies into the shared library, where anyone can search indexed prompt words, tags, models, LoRAs and creator names. It doesn’t automatically save image files to your computer.</p></details>
    </section>

    <section class="guide-community" aria-labelledby="community-title"><div><p class="eyebrow">EVERY GALLERY HELPS</p><h2 id="community-title">Your favorite images could be<br>someone else’s next discovery.</h2><p>Everyone doing a little helps us index more of Civitai. Pick a gallery you love, leave a scan running, and help make those images easier for the whole community to find.</p></div><a class="button primary" href="/">Search the shared library ↗</a></section>
  </main>
  <footer><span>Search Civitai · An independent community project</span><a href="/extension.php">Installation &amp; download</a><a href="https://github.com/pixelgraple/civitai-image-search" target="_blank" rel="noopener noreferrer">GitHub ↗</a></footer>
</body>
</html>
