# Civitai Image Search

**Find images by the words in their prompts. Help grow a shared library while browsing Civitai.**

Civitai Image Search combines **Index Civitai**, a browser extension, with a shared searchable image library. Contributors choose the Civitai pages they want to scan. The extension discovers images and collects their generation metadata; the server saves eligible image copies so everyone can search and browse the indexed collection.

**[Open the shared library](https://search-civitai.xyz/)** · **[Download Index Civitai 2.8.14](https://search-civitai.xyz/downloads/index-civitai-2.8.14.zip)** · **[Website guide](https://search-civitai.xyz/extension.php)** · **[GitHub release](https://github.com/pixelgraple/civitai-image-search/releases/tag/v2.8.14)**

The extension supports `civitai.com` and `civitai.red`. The website can be used without installing the extension. Public browsing and contribution require no account or contributor key.

## What it can do

| Feature | What you get |
| --- | --- |
| Search generation metadata | Find indexed images by prompt words, tags, model names and LoRA names, with matching result counts. |
| Desktop gallery | A dark masonry gallery with pagination, style filters and sorting by newest or community upvotes. |
| Full image viewer | A large central image, a prompt and metadata sidebar, previous/next navigation, prompt copying and a link to the original Civitai page. |
| Automatic discovery | Collect from supported galleries as you browse, or start a scan of a selected page and let it keep discovering images automatically. |
| Several tabs at once | Separate feed filters, progress and stop/resume controls per tab, with shared queue and request pacing. |
| Server storage | The extension submits metadata over HTTPS. The server downloads image files into the shared library. No automatic image downloads to your computer. |
| Duplicate prevention | Check known image IDs before reading prompts; verify stored copies with SHA256 and reuse identical content after its first necessary download. |
| Live progress | Watch discovered images, duplicate checks, prompt reads, ready/sending records, accepted submissions and skipped images as they change. |
| Adjustable collection | Change collection speed from 1× to 5× in half steps while scans are running. |
| Per-tab image transfers | Set each tab's server image-transfer target from 4 to 32 while it runs, and see its active, pending and stored counts. Tabs share 32 server transfer slots. |
| Source reactions | Preserve available Civitai reaction counts and update them when later observations become available. |
| Community reactions | Upvote, love, laugh or react with wow on the shared website. These votes are separate from Civitai's counts. |
| Style grouping | Sort into Anime or Realistic from positive prompts, tags, model and LoRA names using a documented metadata rule. |

Search covers **images already indexed by contributors**. It does not search every image on Civitai.

## Install or update

1. [Download the extension ZIP](https://search-civitai.xyz/downloads/index-civitai-2.8.14.zip) and extract it into a permanent folder.
2. Open `brave://extensions` or `chrome://extensions`, then enable **Developer mode**.
3. Click **Load unpacked** and select the extracted folder containing `manifest.json`.
4. For an existing unpacked installation, replace its files and click **Reload** on the Extensions page.
5. Refresh Civitai **gallery tabs** opened before the update. Save unfinished upload or edit forms before refreshing those tabs.

This is an unpacked Chromium extension. The download contains the browser extension; this repository also contains the website, server workers and development checks. See the [website guide](https://search-civitai.xyz/extension.php) for an introduction and the [changelog](CHANGELOG.md) for release history.

## Start contributing

1. Open a gallery on `civitai.com` or `civitai.red` and choose its filters.
2. Click **Index Civitai** in the browser toolbar, then **Scan this tab**.
3. Leave that tab open. Discovery continues automatically; manual scrolling is not required.
4. Open another gallery in another tab to collect a different feed. Each tab has its own controls and saved position.
5. Use **Browsing & activity** to change collection speed and see combined progress. **Open shared library** takes you to the searchable results.

The separate **Server image transfers** slider controls actual image downloads for that tab, from **4 to 32** (default **32**). Use it in the tab's panel or select a tab in Browsing & activity. The server shares **32 total transfer slots** among contributors, so a target of 32 is a ceiling rather than a reserved allocation. Lowering the limit lets in-flight downloads finish before admitting more. Browser metadata uploads retain their 60-record batch and three-second pause.

**Collect as I browse Civitai** defaults to on. It collects cards and automatically scrolls supported galleries, while detail pages can be indexed without scrolling. Creation, edit, upload, settings and generation forms are excluded. An explicit feed scan follows the selected page's captured feed filters and keeps paging until stopped or the feed ends.

**Stop tab** pauses collection for that tab. **Resume tab** continues its saved scan position. **Stop all collection** stops feed scans and disables passive collection. An already running source request may take up to 20 seconds to finish.

Background tabs do not need to be focused, but they must remain open and available. Browser tab suspension, closing the browser or putting the computer to sleep can pause progress. The extension cannot guarantee continuous operation while the browser or computer is suspended.

## What gets indexed

- A **nonblank positive prompt is required**. Tags alone or a negative prompt alone do not qualify.
- Images must be at most **9,000,000 pixels total (9 MP)**.
- Images must be at most **4096 pixels on either side**.
- Both dimension limits apply: `3000 × 3000` qualifies; `4096 × 4096` does not.
- Known oversized images are skipped before submission or download. The server also checks actual image headers and stops oversized transfers when dimensions become available.
- Skipped oversized IDs are remembered to avoid repeated work. Previously completed image copies are retained.

Where available, the catalog stores the original image link, positive and negative prompts, tags, model and LoRA names, captured creator usernames, source reactions, dimensions, file hash and storage status. An incomplete rescan does not erase a previously known positive prompt.

## How collection and storage work

```text
Your selected Civitai tabs
  → discover image IDs and check the shared catalog
  → read generation metadata for images that still need it
  → submit eligible prompt records over HTTPS
  → server queues and downloads image files
  → shared prompt search, gallery and reactions
```

The extension connects to the fixed `https://search-civitai.xyz/api.php` endpoint. It contains no SSH credentials, contributor keys or server configuration, and has no browser downloads permission. It stores preferences, queue metadata and progress in the browser profile. Each tab automatically gets a random private collection identity to update its own transfer preference; users do not create or enter a key. The server retains only a hash of that identity and does not expose it in public image records. Image files are saved by the server worker. The website's **Download original** button is a separate, deliberate user action.

The server validates IDs and approved Civitai HTTPS source hosts, verifies file content and hashes, and controls its own storage paths. The submission API does not provide shell access, arbitrary file upload, deletion or filesystem browsing.

### Queue and speed limits

| Stage | Current behavior |
| --- | --- |
| Outstanding images | **600 unique images total across all tabs**, including browsing and feed scans. Discovery and scrolling pause at the cap and resume as capacity becomes available. |
| Collection speed | **1×–5×**, in steps of 0.5, applied live across tabs. Adjusts discovery, scrolling, metadata slots and source request spacing. |
| Source requests | At most **two actual Civitai requests active globally**. Starts are paced from two seconds at 1× to 400 ms at 5×. |
| Metadata processing | Rolling slots: completed prompts can move forward without waiting for the slowest image or optional reaction lookup. |
| Metadata submission | Up to **60 prompt records per batch**, with a **three-second pause** after a batch. Smaller batches are sent when fewer records are ready. This stays the same at every speed setting. |
| Server image downloads | **Up to 32 concurrent transfers total**, with a live **4–32 target for each tab**. Vacant slots are refilled without waiting for a whole batch. Downloads stream to temporary files; thumbnails are generated individually. |
| Shared totals | The activity page refreshes indexed, stored and pending server totals every ten seconds. Local queue progress receives live updates. |

More tabs share the same source request budget. Up to three feeds run together; additional started tabs take turns. Paused tabs retain their outstanding work, so resuming them may be necessary to drain a full queue.

**Submitted** means the server accepted a metadata record. Its image copy may still be processing. Browser counters describe that browser's retained progress; the website shows the shared catalog.

### Duplicate checks and retries

Known image IDs are checked before prompt reads, independently of uploads. Stored originals are verified against their SHA256 digest, with a verification cache that is invalidated when the file's identity or relevant attributes change. A busy file is deferred individually so other checks can finish. Missing or damaged stored copies can return to collection.

Identical content under different image IDs can share stored files after a content-hash comparison. An unknown image normally needs an initial server download before its content hash is available.

Source and server failures retain work for retry. Rate limits and server errors trigger shared cooldowns and honor `Retry-After`; authorization failures pause source collection until the site is checked and collection is deliberately resumed. Optional source reaction page reads use a separate durable queue and do not hold prepared prompts back.

The extension reads Civitai pages and the feed/detail requests used by those pages. It is **not immune to source rate limits or site changes**. Collection speed controls do not override source cooldowns, authentication requirements or server capacity.

## Search, styles and reactions

### Find an image

Open [the library](https://search-civitai.xyz/), search a word such as `selfie`, `landscape` or `portrait`, and refine by tag or style. Results include matching counts and pagination. Click a card for the full image, readable prompt, tags, generation resources and source link. Copy a prompt or move to the next image directly from the viewer.

Click any tag in the full image viewer to find **all indexed images with that exact tag**, ignoring case. This opens page one of a fresh tag search, clears previous keyword/model/creator/LoRA/style filters, and keeps your chosen sort order. Tags containing commas or other punctuation are kept as one complete tag. You can then use Filters to narrow those results further.

Click the **Model** name under Generation resources, such as **Krea2 - DarkRealism**, to start a fresh search for images with that captured model name. The **Model name** field in Filters also accepts full names or name fragments, ignoring case. Model search uses the saved generation model, with matching counts and pagination. It can be combined with tags, LoRAs, creators and style filters.

The layout prioritizes desktop use, with a central image and a right-hand details panel. Mobile layouts are also supported.

Use **All words (AND)** or **Any word (OR)** beside the main search. In **Filters**, enter up to 20 comma-separated exact source tags and choose **All tags (AND)** or **Any tag (OR)**. For example, `selfie, beach` with AND requires both tags; OR accepts either. Separate filled filters always narrow one another.

Dedicated **LoRA name** and **Creator username** fields match full names or name fragments, ignoring case. Creator means the image uploader; a leading `@` is optional. Click a LoRA in the full image viewer to search that name. Names must have been captured from the source. Version 2.8.12 begins collecting creator attribution during ordinary scans and revisits; older records remain unattributed until encountered again. Missing names are never inferred from prompt text.

The image heading displays **Creator @username**. Clicking the username opens two new tabs: the creator's Civitai images profile and a Search Civitai page matching that exact username. Individual links remain available if the browser blocks multiple new tabs. Creator-library links can be shared and bookmarked.

Version 2.8.14 records the actual `civitai.red` or `civitai.com` capture domain. The first recorded domain is retained, including when duplicates are encountered again. Older records did not save this information: their creator card asks you to choose the profile site until a new extension scan supplies it. A server metadata-repair visit does not pretend to recover the original capture domain. The recorded domain also controls the image's Open on Civitai link.

Choose **Most Civitai reactions** to rank captured likes, hearts, laughs and cries combined. Records with incomplete counts appear last. Buzz currency and this library's community votes are excluded. **Community upvotes** remains a separate sort.


### Repair incomplete records

The server can revisit a fixed snapshot of already indexed image links to recover missing creator usernames, model and LoRA names, prompts, source tags and reactions. The metadata worker reads public image-page HTML with **up to eight visits at a time** and a **three-second pause between groups**. It does not download image files or discover new image IDs.

Existing values are preserved. Observed tags and LoRA labels are added, missing text and reaction fields are filled, and search/classification are updated together when needed. Progress, retries, per-field update counts and remaining gaps are stored in a private resumable job. Source cooldowns are honored. Missing or explicitly empty resources are recorded as a completed partial result, rather than retried indefinitely; not every image uses a LoRA or exposes its generation details.

This repair runs on the server without requiring contributors to keep browser tabs open. Administrators can create another snapshot later to cover newly indexed incomplete records; it is not an unbounded crawl.

### Anime and Realistic are metadata groups

Classifier v6 puts affirmative fantasy, anime, illustration, animation or digital-art cues in **Anime**. Otherwise it defaults to **Realistic**. Anime cues take precedence when photographic wording also appears. The rule reads positive prompts, tags, model names and LoRA names.

Separate negative prompts and disabled or zero-weight prompt resources do not provide positive cues. Ordinary references to a digital camera, artwork on a prop or phrases such as “drawing attention” are excluded from art-style detection.

These are broad library sorting choices, **not visual image analysis or calibrated confidence scores**. For example, a fantasy render can fall under Anime. The Uncertain filter remains for older records awaiting reclassification.

### Two separate reaction systems

**Civitai source reactions** are read-only snapshots collected from the matching image's page data or visible card. Known zeros are preserved. Missing counts remain missing; rounded display values are not turned into invented exact counts. Later observations can update an existing record without downloading the image again.

**Community reactions** are votes made on Search Civitai. The full viewer offers upvote, love, laugh and wow, and remembers choices in the browser without requiring an account. The gallery can sort by community upvotes. These actions do not vote on Civitai or alter its source counts.

## Development and self-hosting

| Location | Purpose |
| --- | --- |
| `manifest.json`, `background.js`, `civitai-*.js` | Manifest V3 extension, discovery, page integration and queue coordination. |
| `panel.js`, `library.html`, `library.js` | In-tab panel and Browsing & activity interface. |
| `tests/` | Node-based extension checks and fixtures. |
| `server/public/` | Website, API and media routes; the only directory intended as the web document root. |
| `server/lib.php`, `server/schema.sql` | Catalog storage, validation and SQLite full-text search. |
| `server/worker.php` | Image download queue, hashes, dimension checks and thumbnails. |
| `server/style-classifier.php`, `server/reclassify.php` | Metadata grouping and existing-catalog reclassification. |
| `server/reaction-backfill.py` | Resumable source-reaction repair and shared page transport. |
| `server/metadata-backfill.py`, `metadata-page.py`, `metadata-repair.php` | Snapshot-based page metadata repair, exact-image extraction and atomic catalog/FTS updates. |
| `server/tests/` | Isolated ingestion, storage, worker, classifier and reaction checks. |

See **[the deployment guide](server/DEPLOY.md)** and **[example configuration](server/config.example.php)** for server requirements and operational details. Keep private configuration, the database and media outside the public document root. The shared deployment keeps application code under `/www/wwwroot/search-civitai.xyz` and runtime data under `/data/civitai/`.

The released extension targets the shared service. A separate installation needs corresponding endpoint and host-permission changes; copying the server alone does not redirect the extension.

Run extension checks from the repository root with Node.js:

```sh
npm test
```

Server test scripts document their own runtime requirements. For example, on a suitable Linux/PHP environment:

```sh
PHP_BINARY=/path/to/php python3 server/tests/public-ingestion.py
```

Use isolated test data. Preserve the catalog and media when deploying code, and take a consistent database backup before maintenance.

### Maintenance workers

The optional reaction backfill worker snapshots known IDs with missing or incomplete source reactions and stores resumable progress. A new upload does not extend an existing job. It updates only source reactions, leaving prompts, image downloads, classification and community votes intact. Source pacing and cooldowns still apply. See the worker's CLI help and deployment guide before starting a job.

`server/reclassify.php --uncertain-only` previews corrections to legacy Uncertain records. `--apply` saves them. Back up the catalog first.

## Reporting a problem

Include the extension version, collection speed, browser, whether one or several tabs are scanning, and the exact status or retry message. Queue counts help distinguish discovery, prompt reads, submission and server image processing. Do not include passwords, browser cookies or private configuration in an issue.

Feature suggestions and improvements to metadata handling, source compatibility, queue behavior, accessibility and search are welcome.
