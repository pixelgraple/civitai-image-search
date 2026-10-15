# Changelog

Release notes for **Index Civitai** and its shared Civitai Image Search server.

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
