# Civitai Image Search

**Find images by the words in their prompts. Help grow a shared library while browsing Civitai.**

Civitai Image Search combines **Index Civitai**, a browser extension, with a shared searchable image library. Contributors choose the Civitai pages they want to scan. The extension discovers images and collects their generation metadata; the server saves eligible image copies so everyone can search and browse the indexed collection.

**[Open the shared library](https://search-civitai.xyz/)** · **[Download Index Civitai 2.8.25](https://search-civitai.xyz/downloads/index-civitai-2.8.25.zip)** · **[Contributor guide](https://search-civitai.xyz/guide.php)** · **[Install the extension](https://search-civitai.xyz/extension.php)** · **[GitHub releases](https://github.com/pixelgraple/civitai-image-search/releases)**

The extension supports `civitai.com` and `civitai.red`. The website can be used without installing the extension. Browsing requires a short SVG CAPTCHA after the preloader; a successful answer unlocks that browser session for one hour across its tabs. No account or contributor key is needed. Extension contributions continue independently of the website CAPTCHA.

## Metadata upload recovery

Version 2.8.21 cleans and bounds optional resource names before submission, including previously queued records. The server applies the same normalization before validation. Invalid records are returned individually, set aside with their original local prompt and rejection evidence, and shown in the invalid-metadata counter; they do not count as accepted or stop other records. Refresh the extension and gallery tabs after updating; resume scans that were already stopped by the older version.

## Independent reaction backlog

Version 2.8.25 keeps the toolbar launcher visible with connection status and Retry/Restart controls. Collection heartbeats recover from unanswered messages, browser alarms repair a missing collection clock, and temporary renderer interruptions retry without stopping a saved scan. The activity page times out unresponsive controls and offers its own Restart action. Saved queues and source rate-limit cooldowns are retained.

Automatic recovery from 2.8.23 retries temporary network failures automatically after five seconds, preserving prompts, queues and source cursors. The panel shows the retry countdown and identifies shared-catalog connection failures. Existing runs stopped by a connection failure recover on reload when their original tab is still open; manually stopped tabs remain stopped. Required server/Civitai cooldowns and login or permission checks still apply.

Version 2.8.22 keeps excess reaction page lookups and stats updates in a durable local metadata backlog. A full 600-item reaction working set no longer blocks prompt preparation or image submissions. Unavailable pages and stats for images not yet in the library retry individually, allowing other work to continue. The panel and Browsing & activity show pending lookups and saved-backlog counts separately from the shared 600-image collection queue. Existing queued work survives the update. Source concurrency, server cooldowns and the 60-record/three-second upload pacing remain unchanged.

## Refresh Civitai reactions

Every scan refreshes source reactions on images already in the library, including duplicate images skipped for downloading. The reader handles Civitai's animated digit counters and prefers exact hydrated values over older page snapshots.

For a dedicated pass, stop a running scan on your chosen gallery, then click **Refresh Civitai stats only**. This starts at the beginning of that gallery's selected feed and updates existing records without reading prompts, ingesting images, or downloading files. Stop and Resume preserve the selected feed and position. Live counters show matched records, changed records, pending updates, and IDs not in the library. All-zero or incomplete feed snapshots get an image-page recheck; an unavailable response is reported rather than replacing known counts with invented zeroes.

Matching uses the exact Civitai image ID. File SHA256 remains the server's storage-integrity/deduplication check: identical files posted under different IDs can have different reactions, so counts are never copied between posts just because their hashes match. Community votes remain independent. Counts are snapshots, updated when an image is revisited, not a continuous mirror of all Civitai images. Civitai concurrency (default 1, maximum 4 across tabs), cooldowns, and server writer quotas still apply.

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

1. [Download the extension ZIP](https://search-civitai.xyz/downloads/index-civitai-2.8.25.zip) and extract it into a permanent folder.
2. Open `brave://extensions` or `chrome://extensions`, then enable **Developer mode**.
3. Click **Load unpacked** and select the extracted folder containing `manifest.json`.
4. For an existing unpacked installation, replace its files and click **Reload** on the Extensions page.
5. Refresh Civitai **gallery tabs** opened before the update. Save unfinished upload or edit forms before refreshing those tabs.

This is an unpacked Chromium extension. The download contains the browser extension; this repository also contains the website, server workers and development checks. See the [website guide](https://search-civitai.xyz/extension.php) for an introduction and the [changelog](CHANGELOG.md) for release history.

## Start contributing

The website’s **[GUIDE](https://search-civitai.xyz/guide.php)** sits beside the extension download. It walks through choosing a gallery, opening the settings cogwheel, starting a scan and leaving it running while you use other tabs, with explanations of progress, skipped images and server storage.

1. Open a gallery on `civitai.com` or `civitai.red` and choose its filters.
2. Click **Index Civitai** in the browser toolbar, then **Scan this tab**.
3. Leave that tab open. Discovery continues automatically; manual scrolling is not required.
4. Open another gallery in another tab to collect a different feed. Each tab has its own controls and saved position.
5. Use **Browsing & activity** to change collection speed and see combined progress. **Open shared library** takes you to the searchable results.

The separate **Server image transfers** slider controls actual image downloads for that tab, from **4 to 32** (default **32**). Use it in the tab's panel or select a tab in Browsing & activity. The server shares **32 total transfer slots** among contributors, so a target of 32 is a ceiling rather than a reserved allocation. Lowering the limit lets in-flight downloads finish before admitting more. Browser metadata uploads retain their 60-record batch and three-second pause.

**Collect images as you browse** defaults to on. It collects visible cards without moving the page. Only galleries explicitly started with **Scan this tab** auto-scroll; changing pages revokes that scrolling permission. Creation, edit, upload, settings and generation forms are excluded. An explicit feed scan follows the selected page's captured feed filters and keeps paging until stopped or the feed ends.

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
| Collection speed | **1×–5×**, in steps of 0.5, applied live across tabs. Adjusts discovery, scrolling, metadata slots and source request windows. |
| Source requests | **1 by default; adjustable from 1 to 4 across all tabs** using the Civitai processing slider in Settings. The selected limit controls both active requests and starts per rolling collection-speed window. Live changes keep queued work and source cooldowns; active requests finish when the limit is lowered. Successful requests per minute and peak concurrency remain visible. One image may require several metadata reads. Server image-transfer limits are configured separately. |
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

The visible **Search within a model or LoRA** row combines your search words with a **Checkpoint / model**, **LoRA**, and optional exact **Source tags**. Type any part of a resource name: `Krea2` matches names containing that text anywhere, ignoring case, like `%Krea2%` without typing the percent signs. For example, enter `beach` in the main search and `Krea2` under Checkpoint / model, then click **Search images**. Enter a LoRA instead to search within that LoRA, or fill both to require both. Quick topic buttons keep these constraints. Results include only indexed images with matching captured resource names.

Main search words now match **positive prompts and tags** by default. Under **Filters → Search words in**, choose **Positive prompts only** for prompt-specific matching or **All metadata** to also include negative prompts, models and LoRAs. The word AND/OR choice is evaluated within this scope; resource fields always narrow the result. Direct links accept `q`, `model`, `lora`, `tag` and the other filter parameters, for example [beach prompts/tags within Krea2 models](https://search-civitai.xyz/?q=beach&model=Krea2). API clients that omit `qScope` retain the existing all-metadata behavior.

Click any tag in the full image viewer to find **all indexed images with that exact tag**, ignoring case. This opens page one of a fresh tag search, clears previous keyword/model/creator/LoRA/style filters, and keeps your chosen sort order. Tags containing commas or other punctuation are kept as one complete tag. You can then use Filters to narrow those results further.

Click the **Model** name under Generation resources, such as **Krea2 - DarkRealism**, to start a fresh search for images with that captured model name. The visible **Checkpoint / model** field also accepts full names or name fragments, ignoring case. Model search uses the saved generation model, with matching counts and pagination. It can be combined with tags, LoRAs, creators and style filters.

The layout prioritizes desktop use, with a central image and a right-hand details panel. Mobile layouts are also supported.

Use **All words (AND)** or **Any word (OR)** beside the main search. In **Source tags**, enter up to 20 comma-separated exact source tags and choose **All tags (AND)** or **Any tag (OR)**. For example, `selfie, beach` with AND requires both tags; OR accepts either. Separate filled filters always narrow one another.

Dedicated **LoRA name** and **Creator username** fields match full names or name fragments, ignoring case. Creator means the image uploader; a leading `@` is optional. Click a LoRA in the full image viewer to search that name. Names must have been captured from the source. Version 2.8.12 begins collecting creator attribution during ordinary scans and revisits; older records remain unattributed until encountered again. Missing names are never inferred from prompt text.

The image heading displays **Creator @username**. Clicking the username opens two new tabs: the creator's Civitai images profile and a Search Civitai page matching that exact username. Individual links remain available if the browser blocks multiple new tabs. Creator-library links can be shared and bookmarked.

Version 2.8.14 records the actual `civitai.red` or `civitai.com` capture domain. The first recorded domain is retained, including when duplicates are encountered again. Older records did not save this information: their creator card asks you to choose the profile site until a new extension scan supplies it. A server metadata-repair visit does not pretend to recover the original capture domain. The recorded domain also controls the image's Open on Civitai link.

Choose **Most Civitai reactions** to rank captured likes, hearts, laughs and cries combined. Records with incomplete counts appear last. Buzz currency and this library's community votes are excluded. **Community upvotes** remains a separate sort.


### Popular creators, models and LoRAs

Open **Popular** beside **Images** to browse three rankings, with up to 50 entries each:

- **Users:** creators with at least 50 indexed images that each have 200 or more recorded Civitai likes, hearts, laughs and cries combined. Rank is qualifying image count, then qualifying reactions, then total indexed images.
- **Models:** checkpoints ranked by indexed image count.
- **LoRAs:** ranked by indexed image count, counting each name once per image.

Names are grouped without regard to case. Cards show small previews and open an exact-name gallery. Models and LoRAs break image-count ties using recorded reactions. Buzz and Search Civitai community votes are excluded. Known reaction counters can establish the 200 threshold even when other source counters are missing; missing values are never invented. Counts cover this indexed library, not all of Civitai.

PG-13 is enabled by default and applies to ranking counts and previews. Cached previews are checked again against the current catalog and safety decisions before being returned. The directory may contain fewer than 50 qualifying users, particularly with PG-13 enabled.

The server's **civitai-popular.timer** refreshes snapshots every 15 minutes through **popular-rebuild.php**, with one rebuild at a time. It reads the image catalog and atomically publishes a private cache beside the database in **popular-cache/rankings-v1.json**. Browsing reads this cache instead of rebuilding rankings on every request. The endpoint uses the existing CAPTCHA and search quota; images do not consume additional search quota.

Deployment requires adding **popular.php** to the site's Nginx PHP page allowlist, installing the supplied service and timer, and running the first snapshot rebuild before enabling the navigation link.

### Discovery tabs and profiles

The main navigation includes **Models**, **LoRAs**, **Creators**, **Recipes**, **Prompt Explorer**, and **Discover**.

- Model, LoRA and creator directories support name searches and pagination. Each profile has image examples, an exact gallery link and common resource/tag connections.
- Profile connections describe a bounded sample of up to 64 indexed images. Their sample counts are labeled separately from whole-profile totals.
- Recipes group recorded checkpoint names and complete LoRA-name sets. The directory shows combinations with at least two examples; individual recipe profiles can contain one. Weights may vary between examples. The image viewer displays only LoRA weights explicitly captured in the prompt, labeling zero weights disabled.
- Prompt Explorer covers common descriptive phrases and captured source tags. Its custom phrase form can search any phrase within an optional checkpoint. Quoted phrases stay together in positive and excluded searches.
- **More like this** in the image viewer finds up to 240 stored candidates using rare shared tags, common descriptive prompt phrases and LoRAs, with a bonus for the same checkpoint. It is metadata similarity, not a visual model.
- Discover shuffles stored images and keeps the current search filters. A seed keeps pagination stable until the visitor selects Shuffle again.
- Advanced gallery filters include excluded prompt words/phrases, minimum combined recorded source reactions, image orientation, minimum/maximum width and height, and stored-image availability. Existing model, LoRA, creator, tag, source and style filters combine with these.

PG-13 is enabled by default across these pages. Cached previews are checked against current availability, collection skips and PG-13 decisions before they are returned. Direct image and similar-image searches also enforce the live filter. Source counts and metadata may be incomplete.

Discovery uses a separate private SQLite snapshot at **/data/civitai/database/discovery-cache/catalog-v1.sqlite**. **civitai-discovery.timer** refreshes it every 15 minutes through **discovery-rebuild.php**; rebuilds read the catalog, take an exclusive rebuild lock and publish by atomic rename. The web API reads this snapshot and retains the existing CAPTCHA and search quota. Snapshots older than one day or with a mismatched policy version are rejected.

Directory previews use the snapshot's covering `image_preview_status(image_id,safe,ready)` index. Current availability, collection exclusions and PG-13 decisions are checked against the live catalog by exact image IDs; discovery and popular pages must not scan all downloaded images for a small preview list. Profile connections use a labeled sample of up to 64 images; overall profile image/reaction totals still cover the full snapshot. The directory shows a retry action after a 20-second request timeout.

For an existing installation, deploy the updated rebuild worker and rebuild the snapshot **before** enabling the updated discovery reader. Alternatively, while holding `discovery-cache/rebuild.lock`, add `CREATE INDEX IF NOT EXISTS image_preview_status ON image_meta(image_id,safe,ready)` to the existing snapshot in a normal SQLite transaction. Future rebuilds create this index automatically. The live catalog's existing `image_pg13_safety_v2_safe` index is also required. Do not change the safety policy or disable verification to improve response time.

Deployment adds **discovery.php** and **discover.php** to the existing Nginx PHP page allowlist. Keep **library-nav.php** an include only. Install the discovery service/timer and complete the first snapshot before publishing the navigation. App files stay under **/www/wwwroot/search-civitai.xyz**; the database and snapshot stay outside the public web directory.

### Repair incomplete records

The server can revisit a fixed snapshot of already indexed image links to recover missing creator usernames, model and LoRA names, prompts, source tags and reactions. The metadata worker reads public image-page HTML with **up to eight visits at a time** and a **three-second pause between groups**. It does not download image files or discover new image IDs.

Existing values are preserved. Observed tags and LoRA labels are added, missing text and reaction fields are filled, and search/classification are updated together when needed. Progress, retries, per-field update counts and remaining gaps are stored in a private resumable job. Source cooldowns are honored. Missing or explicitly empty resources are recorded as a completed partial result, rather than retried indefinitely; not every image uses a LoRA or exposes its generation details.

This repair runs on the server without requiring contributors to keep browser tabs open. Administrators can create another snapshot later to cover newly indexed incomplete records; it is not an unbounded crawl.

### Anime and Realistic are metadata groups

Classifier v9 requires **at least two distinct affirmative non-photographic style cues** for **Anime**. It reads positive prompts, tags, model names and LoRA names; otherwise it defaults to **Realistic**. For example, `source_anime` alone stays Realistic, while anime plus cel shading can qualify as Anime. Repeated words, spelling variants and the same cue repeated across metadata fields count only once. Overlapping words in one style phrase do not manufacture extra evidence.

Resource context now contributes supporting evidence: Illustrious/NoobAI family names count as one cue in the recorded model, alongside independent evidence such as Disney animation, anime, or an active recognized Gelatomusume/PPW animation style adapter. The family alone does not determine the image style; LoRA compatibility lists do not establish the actual model family. This family mapping is informed by the official [Illustrious model card](https://huggingface.co/OnomaAIResearch/Illustrious-XL-v1.0) and [NoobAI model card](https://huggingface.co/Laxhar/noobai-XL-1.0). Ecchi/source_ecchi and drawn motion/speed lines are also recognized; photographic motion blur, quality tags, `1girl`, generic `IL` abbreviations, and arbitrary artist names are not additional art cues. Known adapter filename/display aliases share disabled-weight handling. Portrait and photorealism wording do not override two independent art cues.

Separate negative prompts and disabled or zero-weight prompt resources do not provide positive cues. Disabled LoRAs stay excluded even when the collector also saved their names separately; positive uses of the same resource still count. Generic `3d` tags, negated stylization and styling described as commercial photography do not establish an illustrated medium. Ordinary references to a digital camera, artwork on a prop or phrases such as “drawing attention” are excluded from art-style detection.

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

`server/reclassify.php --online` previews corrections to the existing catalog in bounded batches; add `--apply` to save them. This mode classifies outside write transactions and checks for concurrent metadata changes before updating only the style fields. It reports category transitions and any unresolved conflicts. `--uncertain-only` limits either mode to legacy Uncertain records. Back up the catalog first.

## Reporting a problem

Include the extension version, collection speed, browser, whether one or several tabs are scanning, and the exact status or retry message. Queue counts help distinguish discovery, prompt reads, submission and server image processing. Do not include passwords, browser cookies or private configuration in an issue.

Feature suggestions and improvements to metadata handling, source compatibility, queue behavior, accessibility and search are welcome.

### Extension settings

Use the cogwheel in the tab panel or Browsing & activity to open Settings. Civitai processing starts at one request across all tabs and can be changed live up to four. Automatic browsing, collection speed and server transfer preferences are grouped there, while collection progress stays visible on the main screen. Existing installs without a saved Civitai processing preference also start at one; subsequent choices are remembered.
