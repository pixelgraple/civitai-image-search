<?php
declare(strict_types=1);
require_once __DIR__ . '/access-gate.php';

const SEARCH_BLOCK_SECONDS = 600;
const SEARCH_BURST_SECONDS = 10;
const SEARCH_BURST_LIMIT = 12;
const SEARCH_MINUTE_LIMIT = 60;

/** Separate quota storage: never acquire the image catalog's writer lock. */
function search_guard_database(): PDO {
    $pdo = gate_rate_database();
    $pdo->exec('CREATE TABLE IF NOT EXISTS search_clients (
        client_key TEXT PRIMARY KEY, hits TEXT NOT NULL, blocked_until INTEGER NOT NULL,
        expires_at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS search_clients_expiry ON search_clients(expires_at);');
    return $pdo;
}

function search_guard_client(PDO $pdo): string {
    // This secret is also used for CAPTCHA quotas, but the purpose prefix keeps
    // the keys separate. No date component: a ban survives midnight and reloads.
    gate_client_key($pdo); // Initialize the server secret if necessary.
    $secret = (string)$pdo->query("SELECT value FROM access_settings WHERE name='ip_secret_v1'")->fetchColumn();
    $packed = @inet_pton((string)($_SERVER['REMOTE_ADDR'] ?? ''));
    if ($packed === false) throw new RuntimeException('Search requires a valid client address.');
    if (strlen($packed) === 16 && substr($packed, 0, 12) === str_repeat("\0", 10) . "\xff\xff") $packed = substr($packed, 12);
    // Keep temporary IPv6 addresses in one /64 quota, as IPv4 clients share one IP.
    if (strlen($packed) === 16) $packed = substr($packed, 0, 8) . str_repeat("\0", 8);
    return hash_hmac('sha256', 'search-client-v1:' . $packed, $secret);
}

/** A sliding window with a fixed ban; blocked attempts do not extend it. */
function search_guard_state(array $row, float $now, bool $consume): array {
    $until = (int)($row['blocked_until'] ?? 0);
    if ($until > $now) return ['hits'=>'[]', 'blocked_until'=>$until, 'expires_at'=>$until];
    $hits = json_decode((string)($row['hits'] ?? '[]'), true);
    $hits = is_array($hits) ? array_values(array_filter($hits, static fn($t)=>is_numeric($t) && $t > $now - 60 && $t <= $now)) : [];
    if ($consume) {
        $burst = count(array_filter($hits, static fn($t)=>$t > $now - SEARCH_BURST_SECONDS));
        if ($burst >= SEARCH_BURST_LIMIT || count($hits) >= SEARCH_MINUTE_LIMIT) {
            $until = (int)ceil($now) + SEARCH_BLOCK_SECONDS;
            return ['hits'=>'[]', 'blocked_until'=>$until, 'expires_at'=>$until];
        }
        $hits[] = $now;
    }
    return ['hits'=>json_encode($hits, JSON_THROW_ON_ERROR), 'blocked_until'=>0, 'expires_at'=>(int)ceil($now)+60];
}

function search_guard_check(bool $consume): int {
    $pdo = search_guard_database(); $key = search_guard_client($pdo); $now = microtime(true);
    if (!$consume) {
        $find = $pdo->prepare('SELECT blocked_until FROM search_clients WHERE client_key=?');
        $find->execute([$key]); $until = (int)$find->fetchColumn();
        return $until > $now ? $until : 0;
    }
    $active = false;
    try {
        $pdo->exec('BEGIN IMMEDIATE'); $active = true;
        $pdo->prepare('DELETE FROM search_clients WHERE expires_at<=?')->execute([(int)$now]);
        $find = $pdo->prepare('SELECT hits,blocked_until FROM search_clients WHERE client_key=?');
        $find->execute([$key]); $row = $find->fetch(); $find->closeCursor();
        if (!$row && (int)$pdo->query('SELECT COUNT(*) FROM search_clients')->fetchColumn() >= 20000) throw new RuntimeException('Search quota capacity reached.');
        $state = search_guard_state($row ?: [], $now, true);
        $pdo->prepare('INSERT INTO search_clients(client_key,hits,blocked_until,expires_at) VALUES(?,?,?,?)
            ON CONFLICT(client_key) DO UPDATE SET hits=excluded.hits,blocked_until=excluded.blocked_until,expires_at=excluded.expires_at')
            ->execute([$key,$state['hits'],$state['blocked_until'],$state['expires_at']]);
        $pdo->exec('COMMIT'); $active = false;
        return $state['blocked_until'];
    } catch (Throwable $error) {
        if ($active) $pdo->exec('ROLLBACK');
        throw $error;
    }
}

function search_guard_require(): void {
    try { $until = search_guard_check(true); }
    catch (Throwable $error) {
        error_log('Search quota unavailable (' . get_class($error) . ').');
        header('Retry-After: 30');
        json_response(['ok'=>false,'code'=>'search_guard_unavailable','error'=>'Search is temporarily unavailable. Please try again shortly.'],503);
    }
    if (!$until) return;
    header('Retry-After: ' . max(1,$until-time()));
    json_response(['ok'=>false,'code'=>'search_rate_limited','error'=>'Too many rapid searches. Searching is paused for 10 minutes.',
        'retryAfter'=>max(1,$until-time()),'blockedUntil'=>$until*1000,'blockPage'=>'access.php?action=search-block'],429);
}

function search_guard_page(): never {
    $unavailable = false;
    try { $until = search_guard_check(false); }
    catch (Throwable $error) { $unavailable = true; $until = time()+30; }
    gate_headers();
    header("Content-Security-Policy: default-src 'none'; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    header('X-Frame-Options: DENY');
    header('Content-Type: text/html; charset=utf-8');
    if ($until) { http_response_code($unavailable?503:429); header('Retry-After: '.max(1,$until-time())); }
    $remaining = max(0,$until-time());
    $heading = $unavailable ? 'Search is temporarily unavailable' : ($until ? 'Take a short search break' : 'You can search again');
    $message = $unavailable ? 'Please try again in a moment.' : 'Several searches arrived too quickly from your connection. The pause ends automatically after 10 minutes. Refreshing this page will not extend it.';
    echo '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Search paused · Search Civitai</title><link rel="stylesheet" href="search-block.css?v=security1"><main class="block-card"><a class="brand" href="/">SEARCH<span>CIVITAI</span></a><p class="eyebrow">SEARCH PROTECTION</p><h1>'.$heading.'</h1><p>'.$message.'</p><div id="countdown" role="timer" data-remaining="'.$remaining.'">'.sprintf('%02d:%02d',intdiv($remaining,60),$remaining%60).'</div><p class="help">Each search or results page counts once. Thumbnails and image downloads do not count toward this search limit.</p><a class="return-link" href="/">Return to the library</a></main><script src="search-block.js?v=security1" defer></script></html>';
    exit;
}
