<?php
return [
    // Keep this file outside the public web root and readable only by PHP-FPM.
    'database_path' => '/data/civitai/database/catalog.sqlite',
    'storage_dir' => '/data/civitai/media',
    'storage_max_bytes' => 1099511627776, // 1 TiB
    'max_image_bytes' => 41943040, // 40 MiB per image
    'image_download_concurrency' => 4, // One coordinator; bounded between 1 and 8 transfers.
    // Reactions belong to this origin; ingestion keeps its separate extension CORS policy.
    'public_origin' => 'https://search-civitai.xyz',
    'reaction_writes_per_minute' => 60,
    'reaction_ip_writes_per_minute' => 120,
    'reaction_identities_per_hour' => 20,
    'reaction_max_rate_buckets' => 20000,
    // The shared Index Civitai installation accepts metadata from everyone without a key.
    'public_ingest_enabled' => true,
    'public_ingest_requests_per_minute' => 120,
    // Quota rows expire after one minute and cannot exceed this configured bound.
    'ingest_max_active_clients' => 10000,
    // Optional protected mode only (public_ingest_enabled=false).
    // Generate with: php generate-token.php. Store only the hash here.
    'write_token_hash' => 'REPLACE_WITH_PASSWORD_HASH',
    // Private, root-managed registry. Individual keys only authorize catalog ingestion.
    'contributors_path' => '/data/civitai/config/contributors.json',
    'contributor_requests_per_minute' => 120,
];
