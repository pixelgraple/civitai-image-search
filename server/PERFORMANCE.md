# Search and gallery performance

Tag searches use the existing FTS tag index to narrow candidates before exact
JSON tag matching. AND/OR semantics and complete clicked tags are preserved.
Non-ASCII and punctuation-only tags retain the original exact matching path
where a tokenizer prefilter could change the result. Search responses include
`Server-Timing` measurements for database setup, counts, and page selection.

Gallery previews are cached WebP files at quality 80, at most 720 pixels on either
side. Original images, original hashes, and full-size downloads are unchanged.
New downloads create compact previews automatically. Existing legacy thumbnails
remain valid fallback while a bounded background conversion upgrades them.
Image requests never perform conversion; they support ETag revalidation and HEAD.

## Gallery card delivery

Small cards use an additional cached WebP preview, up to **320 pixels wide** at
quality 78. Larger cards and high-density displays use the existing 720-pixel
preview. The card's displayed dimensions and aspect ratio stay the same. The
full-image viewer and download continue to use the original file.

The gallery prioritizes images actually visible across all masonry columns.
Images further than 300 pixels beyond the viewport do not start downloading
until the user approaches them. Resizing can upgrade a preview for a larger card
or a higher display density. Pagination and the access gate disconnect the old
loader so it cannot keep scheduling detached images.

`media.php?variant=thumb&w=320&id=123` selects the small cache, falling back to
the 720-pixel cache during backfill. Only widths 320 and 720 are accepted. A
legacy full-size copy is never served as a gallery thumbnail. Every request,
including conditional requests, still passes the one-hour access gate; caches
remain private. No public static media route is introduced.

New downloads generate both sizes. To backfill existing compact previews:

```sh
python3 preview_backfill_runner.py --cards
```

Run as the media owner under low CPU/I/O priority, with the worker's config
environment. It decodes only existing 720-pixel previews, checkpoints separately
in `.card-preview-backfill-v1.json`, and preserves originals and catalog rows.
For a specific page, use `preview_backfill.php --cards --ids=123,456`.

Animated WebP uploads get a still preview of their first frame. The worker uses
Python 3 with Pillow (`thumbnail_frame.py`) inside its existing address-space,
CPU-time, and wall-time limits. This avoids decoding every frame into memory.
The original animation remains available in the viewer/download. Install Pillow
in the server's `/usr/bin/python3` environment when deploying this worker.

## Upgrade existing previews

Run as the media owner with the same `CIVITAI_LIBRARY_CONFIG` used by the image
worker. GD WebP support is required. Keep CPU and I/O priority low.

```sh
php -d memory_limit=128M preview_backfill.php --limit=200 --max-seconds=40
```

Each batch retains its cursor in `.gallery-preview-backfill-v1.json` under the
configured media directory. A singleton lock prevents duplicate backfills.
`--ids=123,456` warms specific images without moving the background cursor.
Only existing legacy thumbnails up to 2.5 MP and 8 MiB are decoded; larger legacy
fallbacks are skipped. Original files and catalog rows are not modified.

`preview_backfill_runner.py` repeats bounded batches until completion. It uses
`CIVITAI_PHP_BINARY` or `/www/server/php/84/bin/php`, inherits the config environment,
and stops if a batch fails or makes no progress. The cursor permits resuming an
interrupted run. It does not install a recurring scheduler.
