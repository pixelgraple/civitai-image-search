# Changelog

Release notes for **Index Civitai** and its shared Civitai Image Search server.

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
