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
