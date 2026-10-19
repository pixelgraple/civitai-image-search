# Changelog

Release notes for **Index Civitai** and its shared Civitai Image Search server.

## Website and operations - Search deadlines (2026-10-18)

- End browser requests after 60 seconds with visible error/Retry handling; retain directory pages' shorter 20-second limit.
- Match the Nginx deadline to the dedicated PHP pool's existing 60-second limit.
- Add an optional 60-second guard for root SSH diagnostic file searches, excluding application services and streaming pipe filters.
- Cover timeout, navigation cancellation, response-body stalls, verification, and process selection with focused regression checks.

## 2.8.25 - Collection clock and control recovery

- Keep the toolbar launcher visible after opening the page panel, with an independent worker-health reply during queue restoration.
- Retry a lost offscreen heartbeat after five seconds. Browser alarms recreate a missing collection clock; a frozen tab injection cannot prevent that clock from starting.
- Preserve active scans when clock setup temporarily fails, and recover older clock-error pauses on the same source tab. User-stopped scans remain paused.
- Retry temporary frame/renderer interruptions. Closed tabs, permission errors, source authentication pauses and rate-limit cooldowns still require their existing handling.
- Bound control replies to ten seconds and activity health requests to fifteen seconds. Show Retry/Restart controls instead of an indefinite loading state.
- Add recovery regression tests, including late replies, frozen injections and restoration of 70,000 saved accepted IDs with queued prompt data.

## 2.8.24 - Reliable toolbar launcher

- Open toolbar controls through a browser-owned popup independently of the collector service worker.
- Inject the panel immediately instead of waiting for a gallery to finish loading. Display page/worker errors after bounded waits, with Retry and a user-triggered Restart action.
- Reopening keeps the panel visible; delayed or repeated injections cannot toggle it closed. Opening controls does not start a scan or reset queued work.
- Keep the existing collector limits, retry policy, and saved queues. Include launcher recovery regression coverage.
- Separate server ingestion request quotas from the main catalog writer so duplicate checks do not wait behind image writes merely to count a request. Preserve active quota counters and limits, and add held-writer and concurrent-quota regression coverage.

## Website - Discovery performance (2026-10-18)

- Add a covering snapshot index for preview availability and PG-13 checks on Models, LoRAs, Creators, Recipes, and Prompt Explorer.
- Look up selected discovery and popular preview IDs directly instead of scanning the downloaded-image status index. Retain current safety and exclusion checks.
- Keep profile connection reads bounded to a labeled 64-image sample and remove a redundant distinct pass. Profile totals still cover the full snapshot.
- End stalled directory requests after 20 seconds with a working Retry button.
- Include isolated query/safety regression checks and timeout/navigation UI checks. Existing snapshots need the covering index before the new reader is deployed; see the README.

## 2.8.23 - Automatic connection recovery

- Retry temporary source/catalog connection failures after five seconds without stopping after three failures. Keep queued prompts and feed cursors.
- Retry reaction submissions and page lookups independently; show an automatic retry countdown and destination-specific catalog errors.
- Recover scans previously stopped by connection errors only when their original source tab is still open. Preserve deliberate Stop actions and source/server Retry-After waits.

## Server — Reaction update contention (2026-10-18)

- Reserve the SQLite writer before reading and merging reaction updates, avoiding immediate WAL read-to-write upgrade failures during image ingestion.
- Preserve partial counts, idempotent updates and atomic rollback. Source cooldowns and the extension queues are unchanged; no extension reload is needed.
- Add an isolated held-writer regression test and update the API method check to expect the current HTTP 405 response.

## 2.8.22 - Independent reaction backlog

- Fix the full reaction-enrichment queue interrupting prompt collection and causing misleading upload retries.
- Save overflow page lookups and stats updates in IndexedDB, with bounded 600-item working sets and no local image downloads.
- Preserve existing pending work on reload. Clear only the obsolete queue-full retry message and its collector delay.
- Retry unavailable source pages and not-yet-indexed stats individually, so unrelated records can continue.
- Show reaction page lookups and saved backlog counts separately from the shared image queue.
- Keep Civitai concurrency settings, rate-limit cooldowns, 60-record metadata batches and three-second upload pacing.

## 2.8.21 — Resilient metadata uploads

- Normalize LoRA/tag labels at the upload boundary, including old queued records: clean control characters and whitespace, preserve Unicode characters, deduplicate, and apply the server name/count limits.
- Normalize optional names on the server before validation so older extensions can recover from the LoRA-name rejection.
- Return per-record validation results. Invalid records are set aside without stopping healthy records or other tabs, and are not counted as accepted.
- Retain the local prompt record and field-level rejection evidence. Show invalid-metadata counts in the panel and Browsing & activity. A fresh manual scan can revisit a set-aside record; automatic browsing suppresses immediate rediscovery.
- Preserve queue state, authentication, body-size limits, source request pacing and server-only image downloads.

## Website — Search within models and LoRAs (2026-10-15)

- Keep checkpoint/model, LoRA and source-tag fields visible above the gallery; partial names match anywhere, ignoring case.
- Combine resource names with prompt/tag words and AND/OR tags, preserving the chosen constraints when clicking a quick topic, style or sort.
- Default the website's keyword scope to positive prompts and tags. Offer positive-prompt-only and all-metadata scopes; API clients that omit the scope keep their previous behavior.
- Accept model, LoRA and other search parameters in direct gallery links. Use the same constrained search for result counts and pagination. No extension reload is needed.

## 2.8.20 — Refresh Civitai stats

- Add a stats-only gallery scan, using exact source IDs to update existing records without prompt reads or new image downloads. Preserve its mode and cursor across restart and resume.
- Refresh reactions when normal scans encounter stored images; recheck all-zero and incomplete feed snapshots.
- Read accessible animated counts instead of hidden digit reels, handle deeply nested image viewers, and prefer hydrated exact counts over stale/unknown SSR metadata.
- Prefer all-time source counters when both all-time and generic aliases exist; preserve unknowns and allow genuine count decreases.
- Show live matched, changed, missing-library, queued, sending and retry statistics. Keep bounded metadata batches and existing source cooldowns.
- Preserve originals, SHA256 values, prompts and independent community votes. Update the contributor guide and extension download.

## 2.8.19 — Panel opening recovery

- Rebuild panels removed during Civitai navigation instead of toggling a detached element.
- Mark the panel ready only after initialization succeeds; clean up failed mounts so a later toolbar click can retry.
- Check the injected panel result. Show a toolbar warning and open Browsing & activity with recovery instructions if opening fails.
- Preserve existing queue ownership, scan state, source request limits, and manual scrolling in other tabs.
- Add panel lifecycle and toolbar failure regressions. Update status-test fixtures to acknowledge per-tab server transfer settings.

### Hosted gallery rate limit

- Diagnose gallery-triggered Cloudflare 520 errors as the hosting WAF's 120-request/minute limit on the shared media endpoint.
- Raise only this site's WAF threshold to 1,200 requests/minute with operator approval. CAPTCHA, ingestion quotas, and other WAF rules remain enabled.

## Classifier v7 — 2026-10-15

- Require two distinct affirmative non-photographic style cues before assigning Anime; `source_anime` alone now defaults to Realistic.
- Expand drawn, illustrated, animated and CG vocabulary while counting repeated, synonymous and overlapping cues only once.
- Keep exclusions for negated styles, disabled resources, photographic props and generic quality tags.
- Add bounded online catalog reclassification that preserves non-style fields and handles concurrent metadata updates.
- Apply the same server classifier to future submissions and metadata repairs. No extension reload is required.

## Website access gate — 2026-10-15

- Show a short preloader followed by an SVG CAPTCHA before loading the library.
- Keep the page blurred and inactive until verification succeeds. One verification unlocks the browser session for one fixed hour, shared by its tabs.
- Enforce the gate on catalog search, community reactions and image delivery. Close and clear the image viewer when access expires.
- Keep extension ingestion, duplicate checks, transfer status, installation instructions and the contributor guide available independently.
- Store CAPTCHA state privately on the server, limit challenge/answer attempts and prevent shared caching of gated media.
- The browser extension remains at version 2.8.18.

## 2.8.18

- Auto-scroll only explicitly started scan tabs whose current page still matches the selected feed. Other Civitai browsing tabs retain manual scrolling.
- Revoke scrolling permission on navigation and failed status refreshes, including stale responses from the previous page.
- Release unprepared discoveries from closed, navigated-away or restored orphan scan tabs after a durable checkpoint. Preserve prepared prompt records, live paused queues and feed cursors for resuming.
- Show the shared queue's preparing, ready-to-send and sending stages, with paused work identified as a subset. Clarify passive collection status.
- Keep the Civitai request slider at default 1 / maximum 4, metadata batches at 60 per 3 seconds, and server transfer slots at 32. Live investigation showed prompt preparation and retained queue ownership rather than server upload saturation.

### Website contributor guide — 2026-10-15

- Add a GUIDE tab beside the extension download and a dedicated contributor walkthrough at `/guide.php`.
- Explain choosing a gallery, the settings cogwheel, Scan this tab, background collection and completion messages.
- Show how contributions grow the shared library, explain accepted records and skipped images, and link installation instructions from the guide.

## 2.8.17

- Default to one active Civitai request across all tabs, with a live processing slider from one to four.
- Apply the selected limit to both simultaneous requests and starts per rolling interval; retain recent starts when lowering the limit and let in-flight work finish.
- Remember the chosen setting across browser restarts without clearing queued prompts, source rate-limit cooldowns or authentication pauses.
- Add cogwheel Settings panels and a cleaner activity layout. Group processing, automatic browsing, collection speed and server transfer preferences together.
- Keep the server's separate image-transfer limits unchanged.

## 2.8.16

- Let waiting source requests fill up to eight active slots together. Replace the one-start-at-a-time delay with at most eight starts per rolling collection-speed window.
- Keep the eight-request global ceiling, fair tab selection, 600-image backlog cap, cancellation checks, source cooldowns and request deadlines.
- Show successful source requests in the last minute and peak active requests for the current background session, so quickly completed requests remain visible as progress.
- Clarify the live speed description: the interval applies to a group of up to eight starts.
- Acquire the SQLite writer before reading mutable ingestion rows, avoiding a transaction-upgrade race that forced image batches to retry with HTTP 503 during concurrent metadata repairs.

## 2.8.15

- Raise the shared Civitai request ceiling from two to eight active requests across all tabs, with the live status denominator updated to eight.
- Keep the collection-speed setting and Civitai-requested cooldowns in effect.
- Combine repeated manual and automatic queue saves into bounded checkpoints, reducing browser storage churn during long scans.
- Keep at most one state snapshot being written and one pending save group, instead of retaining a full history copy for every image event.
- Preserve queued prompts, scan history, counters and duplicate checks. Queue ownership is released only after its removal is saved.
- Upload concurrency, source pacing and the shared 600-image limit remain unchanged.
- Include the website tag-search optimization and compact WebP gallery previews; full-size originals remain unchanged.

## 2.8.14

- Show creator usernames beneath the image heading, with a two-tab action for their Civitai profile and exact-username library search.
- Add shareable creator-library URLs and separate links when the browser blocks multiple new tabs.
- Record the actual .red or .com capture domain in new submissions and metadata-only duplicate revisits; retain the first recorded domain.
- Preserve capture origin in manual, automatic and resumed extension queues, without downloading stored images again.
- Let visitors choose a profile domain for older records whose original capture site was never saved.
- Include the clickable tag/model searches and model filter already published on the website.

## Website update — 2026-10-15

- Make generation model names clickable and add a dedicated Model name filter for captured model names, including case-insensitive name fragments.
- Model clicks start a fresh search with matching counts and pagination, preserving the sort order.
- Clicking a tag in the full image viewer starts a fresh search across the indexed library, clears unrelated filters, and keeps the current sort order.
- Show the selected tag and matching count on page one, with pagination for all matching images.
- Preserve complete clicked tags containing punctuation, including commas, while retaining manual AND/OR tag filters.
- Refresh the website script cache automatically; the extension stays at 2.8.13.

## 2.8.13

- Add a resumable server worker for missing creator, LoRA, model, prompt, tag and reaction metadata on existing images.
- Visit up to eight public image pages concurrently, preserve source cooldowns, and record per-field progress and unresolved fields.
- Preserve saved values and image files; update searchable metadata and classification atomically.
- Treat source omissions and empty resource lists as terminal partial results for the current snapshot.
- Preserve explicit LoRA versionName labels in future extension records.

## 2.8.12

- Add Most Civitai reactions sorting, separate from community upvotes and Buzz.
- Add dedicated LoRA and creator name filters with clickable names in the full viewer.
- Add AND/OR controls for search words and multiple exact source tags.
- Capture creator usernames from image-specific metadata and enrich existing records on ordinary revisits without another image download.
- Retain LoRA model and version names when available.
- Add indexed reaction ordering and compact search metadata indexes; preserve the collection and transfer limits.

## 2.8.11

- Add a live 4–32 server image-transfer slider per Civitai tab, defaulting to 32.
- Raise the shared server ceiling to 32 concurrent image transfers with fair scheduling across tab queues.
- Refill transfer slots as files finish instead of waiting for the slowest file in a wave.
- Show actual server active/pending/stored counts for each tab, with a single shared status refresh.
- Retain the 600-image browser queue, 60-record metadata batches, source cooldowns, and 9 MP / 4096 pixel limits.

## 2.8.10

- Limit collected images to **9,000,000 pixels total** and **4096 pixels on either side**. Both limits apply.
- Skip known oversized records before further collection and remember the result across scans.
- Check actual server-side image headers and stop oversized transfers when their dimensions become available.
- Skip oversized queued work while retaining previously completed image copies.
- Show an **oversized skipped** counter in collection progress.

## 2.8.9

- Let completed prompts submit without waiting for optional source-reaction page reads.
- Keep optional reaction reads in a separate durable queue.
- Use rolling metadata slots and pace source-request starts across tabs, with at most two actual source requests active globally.
- Return completed duplicate checks immediately while deferring busy image IDs individually.
- Cache verified file hashes with file-change checks and move expensive hash reads outside database write transactions.
- Download up to four image files concurrently on the server by default, using bounded temporary files.
- Bound thumbnail decoding and subprocess memory to keep a large image from repeatedly exhausting the worker.
- Reduce repeated catalog/index work and show more precise retry and activity information.

## 2.8.8

- Capture source reaction counts from matching image page data and visible cards.
- Allow newly observed source reactions to update existing catalog images through a separate reaction-only submission path.
- Preserve the distinction between a known zero count and an unavailable count.
- Add a resumable server worker for repairing missing source reactions from a fixed snapshot of known images.

## Included capabilities

The current release also includes automatic gallery scrolling, selected-feed scans, multiple-tab collection, a shared 600-image outstanding queue, live 1×–5× collection controls, positive-prompt requirements, server-only image storage, SHA256 duplicate handling, prompt/tag/model/LoRA search, a desktop masonry gallery and full image viewer, metadata-based Anime/Realistic grouping, and separate community reactions.

See the [README](README.md) for installation, current limits and behavior. These notes describe implemented features; throughput depends on source availability, browser state and server capacity.
