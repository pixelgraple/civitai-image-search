# Changelog

Release notes for **Index Civitai** and its shared Civitai Image Search server.

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
