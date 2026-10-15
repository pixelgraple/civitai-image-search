# Server deployment guide

Index Civitai 2.8.18 consists of a browser extension and a PHP catalog/image worker. The public shared library is https://search-civitai.xyz/. The domain and paths below are deployment examples; substitute your own values for an independent installation.

## Requirements and installation

Use Linux, Nginx, PHP 8.4 CLI and PHP-FPM with PDO SQLite, SQLite FTS5, cURL, Fileinfo and GD image support. `mbstring` is recommended for Unicode text. Python 3 supports the optional reaction repair worker and server test helpers. ImageMagick `convert` and `prlimit` provide the bounded thumbnail fallback.

Copy the contents of this `server/` directory into the application directory below. The browser extension is packaged separately. Create a dedicated non-login service account, such as `civitai-library`. Keep code and private configuration administrator-owned; grant the service read access to configuration and write access only to its database, media, temporary, log and job directories.

Copy `config.example.php` to `/data/civitai/config/config.php` and review its values. Set `CIVITAI_LIBRARY_CONFIG` to that absolute path in both the PHP-FPM pool and CLI worker environment. Schema initialization happens on first database use. SQLite needs write access to the database directory for its WAL and shared-memory files.

## Files and runtime data

| Purpose | Location |
| --- | --- |
| Application source | /www/wwwroot/search-civitai.xyz/ |
| Nginx document root | /www/wwwroot/search-civitai.xyz/public/ |
| Private configuration | /data/civitai/config/config.php |
| Legacy protected-mode key, root-only | /data/civitai/config/contributor.key |
| Optional protected-mode credential registry | /data/civitai/config/contributors.json |
| SQLite/FTS database | /data/civitai/database/catalog.sqlite |
| Originals, thumbnails, worker lock | /data/civitai/media/ |
| Site/PHP/worker logs | /data/civitai/logs/ |
| Certificate, ACME account/renewal state | /data/civitai/tls/ |
| Challenge webroot | /data/civitai/acme-webroot/ |
| Application backups and isolated test data | /data/civitai/backups/ and /data/civitai/test/ |

Configure HTTPS and serve only `public/`. The parent application contains CLI/source files and must stay outside the served root, as must all configuration, databases, media storage and backups. Configure certificates and renewal using the tools supported by your server.

## Website CAPTCHA and preloader

Deploy `access-gate.php` outside the public root, plus `public/access.php`, `public/access-gate.js` and `public/access-gate.css` with the updated index, app, API and media handlers. Add `access.php` and `guide.php` to the existing Nginx PHP filename allowlist; keep arbitrary PHP paths blocked. The gate uses the dedicated pool's private writable temporary/database directories, which must be included in `open_basedir`.

Verified access lasts one fixed hour in a Secure, HttpOnly session cookie, shared by tabs in that browser session. Browser session restoration may preserve session cookies, but the server still enforces the one-hour expiry. Search, community reactions and media require verification; media responses are private and must revalidate before cache reuse. Do not configure a CDN or reverse proxy to cache these responses publicly. Public extension ingestion, preflight checks, health and transfer-status endpoints remain independent so unattended scans continue.

The guide and extension installation/download pages stay public. Do not add CAPTCHA enforcement to contributor endpoints or embed a bypass credential in the extension.

## PHP and worker

Run the dedicated PHP 8.4 pool and image worker as the non-login civitai-library account, using CIVITAI_LIBRARY_CONFIG=/data/civitai/config/config.php. Use a dedicated local PHP-FPM socket, for example `/run/php/civitai-library.sock`, and configure Nginx to use it. Restrict the pool to the application plus private configuration and runtime directories, ignore inherited `.user.ini` files, and write errors beneath the data root. Disable shell/process functions, FFI, raw file uploads and URL fopen in the web pool; the CLI worker needs separate settings for its bounded thumbnail subprocess. Keep code and configuration unwritable to the service. Forward the Authorization header explicitly for optional protected mode. For a systemd worker, use `ProtectSystem=strict` and grant write access only to required runtime directories under `/data/civitai/`.

Schedule `php /www/wwwroot/search-civitai.xyz/worker.php 200` as the service account with the configuration environment set. A systemd oneshot service and `OnUnitInactiveSec=5s` timer can start the next run five seconds after the preceding run ends. The argument is the record limit for one run, not network concurrency. Give the service a bounded memory limit and a timeout longer than the internal 50-second work window; the shared deployment uses 768 MiB and 100 seconds. One coordinator holds the worker lock and downloads up to 32 images concurrently (`image_download_concurrency`, range 4–32). Downloads stream to bounded temporary files; hashes are computed while writing, and thumbnail conversion runs one image at a time. The worker validates HTTPS source/redirect hosts, JPEG/PNG/WebP headers, byte limits and saved hashes. It releases image locks and SQLite cursors during network transfers, then reacquires ownership and rechecks the source before committing. Unique-file storage usage is read once per run and updated as files are saved. Originals and thumbnails share the app account's ownership. The default storage cap is 1 TiB, with a 40 MiB image limit. Source transfer failures retry three times and remain visible as failed catalog records; HTTP 429/5xx pauses the shared coordinator without consuming attempts.

### Image size policy

Both collection limits apply: at most **9,000,000 pixels total (9 MP)** and **4096 pixels on either side**. A 3000 × 3000 image meets both limits; 4096 × 4096 exceeds the total pixel limit. An image exceeding 4096 pixels on one side is skipped even when its total pixel count is below 9 MP.

The extension checks known dimensions before submission, the API checks submitted metadata, and the worker verifies the actual image header. Oversized transfers are cancelled as soon as dimensions can be read, including when submitted metadata was missing or incorrect. Size-policy skips do not consume network retry attempts. Previously completed image copies are retained.

Terminal exclusions are stored in `image_collection_skips` with the image ID, reason, dimensions and timestamp. This prevents rediscovery and repeated downloads. An existing unfinished catalog row is marked failed with the size-limit explanation; public catalog queries exclude skip-table IDs. Preflight returns `downloadStatus: "skipped"`, `needsDownload: false` and `skipReason: "oversize"` so clients release queue capacity and display the skip. The existing `images.download_status` schema does not require a new enum value.

Thumbnail decoding additionally checks dimensions and available memory before calling GD. When bounded conversion is needed, `/usr/bin/convert` uses one thread, 64 MiB memory, 64 MiB mapped cache, 1 GiB temporary disk, and a 12-second processing limit. `/usr/bin/prlimit` caps the child's entire address space at 640 MiB and CPU time at 12 seconds, including decoder allocations that bypass ImageMagick's cache limits. PHP also enforces a 13-second subprocess deadline. Temporary conversion files live beside the destination and are cleaned afterward. If bounded conversion is unavailable or fails, an already-validated original can be copied as the thumbnail without decoding, with an explicit worker log entry. This fallback uses more network bandwidth. Failed local repairs consume a bounded retry so a broken thumbnail destination cannot stay at the head of the queue forever.

Public preflight uses keyless `POST api.php?action=check` with `{"imageIds":["135960467"]}` (1–100 positive IDs). Each result contains `imageId`, `exists`, `sha256`, `downloadStatus`, and `needsDownload`. The server verifies originals against their saved SHA256 inside the storage root. Valid copies skip another transfer; missing/corrupt ready copies return to the queue. Metadata submissions always merge prompts, tags and resources even when the original is already stored, and independently recheck storage so a preflight/upload race cannot create duplicate work.

Sorted per-image locks coordinate preflight, uploads, and the worker. Unknown preflight IDs and new promptless submissions create no persistent image lock files. Current clients set `allowPartial: true` in the preflight body: completed IDs are returned immediately and busy IDs appear in `deferredIds` for individual retry. Older clients without this option retain the all-results-or-retry contract, with HTTP 503 and Retry-After when the lock budget expires. SHA256 verification is cached for six hours and bound to file identity, size, timestamps, permissions and the expected digest; changed files are rehashed outside SQLite write transactions. Missing thumbnails are rebuilt from verified originals without fetching or incrementing network attempts. Repeated scans preserve pending/failed attempt counters instead of forcing unlimited retries. Equal content hashes across different image IDs share one original/thumbnail path after the first necessary fetch; exact remote hashes are unavailable before downloading an unknown ID. The storage cap counts shared paths once.

Configure certificate renewal and application log rotation for your environment. Validate the actual Nginx configuration before reloading it after certificate changes.

## Extension connection

Index Civitai 2.8.18 connects only to https://search-civitai.xyz/api.php. Everyone can read, search, check storage, and submit discovered image metadata without a key or account. The extension does not carry SSH credentials, SSH access, image bytes, or permission to download files to the computer. The server worker fetches approved Civitai image URLs into /data/civitai/media. No connection setup or credential sharing is required.

## Public ingestion configuration

Set `public_ingest_enabled` to the boolean `true` in the private server configuration. The `check`, `images`, and `writer-status` actions then accept anonymous requests and ignore credentials retained by old extensions. Omitting the setting or setting it to `false` retains the earlier protected behavior for private installations and isolated compatibility tests.

The public endpoints allow only catalog checks and metadata submission. Image URLs remain restricted to the approved Civitai HTTPS CDN hosts, image IDs must be positive numeric IDs, and the worker validates JPEG/PNG/WebP content, maximum file size, and total storage capacity. Client-supplied filesystem paths and commands are ignored. There is no filesystem browser, shell, arbitrary file upload, deletion, or credential-management API.

The default request budget is 120 ingestion requests per minute per client address, shared across that client's tabs; each submission can include up to 100 records. `public_ingest_requests_per_minute` adjusts this budget (1–1200). HTTP 429 responses include `Retry-After` for automatic backoff. Public reads do not consume ingestion quota. This quota uses only PHP's `REMOTE_ADDR`, canonicalizes equivalent addresses, and stores a SHA256 address identifier. It never trusts request headers such as `X-Forwarded-For`, `X-Real-IP`, or `CF-Connecting-IP`. If a trusted reverse proxy is used, configure and verify its real-address handling in Nginx before exposing the API; PHP must receive the verified client address. Quota rows expire after one minute and are removed during subsequent ingestion requests. `ingest_max_active_clients` bounds the table to 10,000 active client rows by default (maximum 100,000); capacity exhaustion returns a temporary 429 instead of creating unbounded state.

## Optional protected-mode administration

These commands are only needed for a separate installation with `public_ingest_enabled=false`. The shared public site does not require contributor credentials. In protected mode, issue one credential per contributor from the server's administrator shell:

```sh
export CIVITAI_LIBRARY_CONFIG=/data/civitai/config/config.php
php /www/wwwroot/search-civitai.xyz/contributors.php create "Contributor name"
php /www/wwwroot/search-civitai.xyz/contributors.php list
php /www/wwwroot/search-civitai.xyz/contributors.php revoke KEY_ID
```

Create prints a random token once. Only its SHA256 digest is retained in the root-managed 0640 registry. List never prints a token or digest. Revocation is checked on each authenticated request and takes effect immediately in protected mode. Contributors have the catalog:submit scope. The existing owner credential remains compatible. Protected-mode authentication is limited to 120 requests per minute per contributor, with HTTP 429 and Retry-After for backoff. Limits protect this server; upstream browsing and image retrieval can also be limited by Civitai.

Collection remains tied to pages selected in the browser. The extension uses the original Civitai tab's own read-only feed/detail requests for discovered IDs. There is no independent REST crawler or importer running on the server. New images without a nonblank positive prompt are skipped: tags or negative prompts alone do not qualify. Prior known positive prompts survive incomplete rescans, and the worker does not download older queued records lacking a positive prompt. Source reactions are snapshots, not local votes.

## Validation and recovery

Before deployment, lint PHP using the same PHP version as production and validate your actual Nginx configuration with `nginx -t`. Test the exact Nginx/FPM route, not just CLI PHP. Run `tests/public-ingestion.py` for anonymous submission/search, stale-key compatibility, invalid input rejection, quota backoff, forwarding-header spoof resistance, and bounded quota storage. The separate `tests/contributor-security.py` uses explicit protected mode to preserve optional private-installation compatibility. Verify anonymous preflight, promptless skipping, private-path 404s, FTS queries, worker completion, and original/thumbnail media routes.

Use SQLite's backup API for a consistent database snapshot; preserve the private config, certificate state, and media tree separately. Code/config backups are beneath /data/civitai/backups/. Retain the existing database and media during code updates. The test fixture is isolated under /data/civitai/test/ and must never be pointed at the production database.

The shared website is public over HTTPS. Desktop is the primary layout; mobile is secondary. Anyone running the extension can grow the catalog by scanning their chosen pages. An independent deployment also needs the extension endpoint constants, manifest host permissions and website origin settings changed to its new domain before packaging.

## Per-tab server transfers (2.8.11)

The extension automatically generates a random 256-bit collection capability for each tab. The server stores its SHA256 as `download_lanes.lane_key`; public image records and status responses never include the capability. `POST api.php?action=download-settings` accepts `collectionToken` and an optional integer `concurrency` from 4 to 32. The setting affects that tab only and cannot raise the global administrator ceiling. `POST api.php?action=download-status` accepts a `collectionTokens` array (1–100) and returns counters by array index; the extension combines all tabs into one five-second poll and honors server cooldowns. Status is reported as unknown if the worker heartbeat is stale.

Each submitted image can include `collectionToken`. `image_download_lanes` assigns its first collecting tab; duplicates cannot replace ownership. Existing clients and the older backlog use an unassigned lane. Per-tab limits default to 32. The rolling worker shares 32 slots fairly among eligible lanes, applies changed limits on subsequent admissions, and lets in-flight requests finish after a limit is reduced. Finalization and thumbnail decoding remain serial. The private `.download-status.json` file reports actual active transfers and is updated atomically. Lane activity counts use a covering index with status mirrored by a database trigger.

## Search filters (2.8.12)

Run the new `db()` initializer as the application account before cutting over the new API. It adds `creator_name` with an empty default and builds the source-reaction ordering and search-facet indexes. Existing prompts, files and FTS rows are preserved. Pause the image worker during the one-time index build to reduce disk contention. The expression index uses SQLite built-ins only and remains compatible with the Python reaction worker.

Search accepts `q`, `qMode=all|any`, comma/newline-separated `tag`, `tagMode=all|any`, `lora`, `creator`, `category`, and `sort=newest|upvotes|civitai_reactions`. Modes default to `all`; words and tags are limited to 20 each. Tags are exact names. LoRA and creator filters match literal case-insensitive fragments; creator strips an optional leading @. Sort totals require all four source social counts; incomplete totals remain null and sort last. Buzz is excluded. Public image rows add `creatorName` and nullable `sourceReactionTotal`.

Image ingestion accepts optional `creatorName`. Source-reaction refreshes also accept creator-only records. Blank or omitted attribution preserves the stored name; older clients continue to work. No mass creator backfill is started by this upgrade. New collector observations enrich attribution during ordinary scans and revisits.

## Metadata repair worker (2.8.13)

The private CLI worker revisits a fixed snapshot of indexed image links. It reads public HTML through the existing bounded page transport, extracting only the requested image and generation queries whose input ID matches. It does not discover new IDs, call source APIs, or fetch image bytes. Hidden generation data, unrelated users, model authors, comments, and recommended image metadata are excluded.

Install `metadata-backfill.py`, `metadata-page.py`, `metadata-repair.php`, and the updated `reaction-backfill.py` together. The PHP helper requires the existing catalog and configured path to agree. It fills empty creator/prompt/model fields, appends observed LoRA/tag names, and fills missing reaction counts. FTS and classification changes commit with catalog metadata in one transaction. Existing source counts, image files, download state, and community votes are retained.

Create a new private job directory for each snapshot as the application service account. Do not replace an existing job database. For example:

```sh
export CIVITAI_LIBRARY_CONFIG=/data/civitai/config/config.php
python3 -B /www/wwwroot/search-civitai.xyz/metadata-backfill.py snapshot --job-dir /data/civitai/metadata-backfill/initial --catalog /data/civitai/database/catalog.sqlite --origin https://civitai.red
python3 -B /www/wwwroot/search-civitai.xyz/metadata-backfill.py run --job-dir /data/civitai/metadata-backfill/initial --concurrency 8 --wave-wait 3 --transport curl --php /www/server/php/84/bin/php
python3 -B /www/wwwroot/search-civitai.xyz/metadata-backfill.py status --job-dir /data/civitai/metadata-backfill/initial
```

The shared deployment runs `civitai-metadata-backfill.service` as `civitai-library`, with write access only to its job directory tree, catalog directory, private temporary files and logs. Output is appended to `/data/civitai/logs/metadata-backfill.log`. Stop the service to pause; starting it resumes the same snapshot. The job exits when its snapshot is exhausted. A later snapshot can include newly indexed incomplete images.

Up to eight HTML requests run concurrently, followed by a three-second wave pause. Source robots rules, Retry-After, authentication/challenge cooldowns and four-attempt transient retry bounds apply. A successful page visit with omitted or explicitly empty resources is terminal for that snapshot, reported as partial or unavailable. Some images legitimately use no LoRAs. Status contains counts of pending/completed/failed images, fields initially wanted, fields observed/changed, and fields still missing among processed records. Private per-image observations and field audits remain in `job.sqlite`. No raw prompts or source HTML are printed to the operational log.
