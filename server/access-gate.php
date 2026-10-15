<?php
declare(strict_types=1);

const CIVITAI_ACCESS_COOKIE = '__Host-civitai_access';
const CIVITAI_ACCESS_TTL = 3600;
const CIVITAI_CHALLENGE_TTL = 300;
const CIVITAI_CHALLENGE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

final class CivitaiAccessRateLimit extends RuntimeException {
    public function __construct(public readonly int $retryAfter) { parent::__construct('Verification requests are temporarily limited.'); }
}

function gate_origin(): string {
    $origin = strtolower(rtrim((string)(config()['public_origin'] ?? 'https://search-civitai.xyz'), '/'));
    if (!preg_match('~^https://[a-z0-9.-]+(?::[0-9]{1,5})?$~D', $origin)) throw new RuntimeException('Invalid access origin.');
    return $origin;
}

function gate_headers(): void {
    header_remove('Access-Control-Allow-Origin');
    header_remove('Access-Control-Allow-Credentials');
    header('Cache-Control: private, no-store, max-age=0');
    header('Pragma: no-cache');
    header('Vary: Cookie, Origin, Sec-Fetch-Site');
    header('X-Content-Type-Options: nosniff');
    header('Referrer-Policy: no-referrer');
    header('Cross-Origin-Resource-Policy: same-origin');
}

function gate_release_session(): void {
    if (session_status() === PHP_SESSION_ACTIVE && !session_write_close()) throw new RuntimeException('Could not save access session.');
}

function gate_json(array $body, int $status = 200): never {
    gate_release_session();
    gate_headers();
    json_response($body, $status);
}

function gate_session_path(): string {
    $database = (string)(config()['database_path'] ?? '');
    if (!str_starts_with($database, '/') || dirname($database) === '/') throw new RuntimeException('Invalid private catalog path.');
    return dirname(dirname($database)) . '/tmp/php/access-sessions';
}

/** Read-only checks never create a session for a missing or invented cookie. */
function gate_open_session(bool $create = false): bool {
    if (session_status() === PHP_SESSION_ACTIVE) {
        if (session_name() !== CIVITAI_ACCESS_COOKIE) throw new RuntimeException('Unexpected active session.');
        return true;
    }
    $directory = gate_session_path();
    $id = $_COOKIE[CIVITAI_ACCESS_COOKIE] ?? null;
    $validId = is_string($id) && preg_match('/^[A-Za-z0-9,-]{22,128}$/D', $id);
    if (!$create && (!$validId || !is_file($directory . '/sess_' . $id) || is_link($directory . '/sess_' . $id))) return false;
    if (!is_dir($directory) && (!$create || (!@mkdir($directory, 0700, true) && !is_dir($directory)))) throw new RuntimeException('Could not create private access sessions.');
    if (is_link($directory) || realpath($directory) !== $directory || !is_writable($directory)) throw new RuntimeException('Private access sessions are unavailable.');
    if (!$validId || is_link($directory . '/sess_' . $id)) unset($_COOKIE[CIVITAI_ACCESS_COOKIE]);
    if (headers_sent()) throw new RuntimeException('Access session started after response output.');
    if (session_module_name('files') === false) throw new RuntimeException('File access sessions are unavailable.');
    ini_set('session.use_strict_mode', '1');
    ini_set('session.use_only_cookies', '1');
    ini_set('session.use_cookies', '1');
    ini_set('session.use_trans_sid', '0');
    ini_set('session.gc_maxlifetime', '3900');
    ini_set('session.gc_probability', '1');
    ini_set('session.gc_divisor', '1000');
    foreach (['session.use_strict_mode' => '1', 'session.use_only_cookies' => '1', 'session.use_cookies' => '1', 'session.use_trans_sid' => '0'] as $key => $value) {
        if ((string)ini_get($key) !== $value) throw new RuntimeException('Secure access session settings are unavailable.');
    }
    if ((int)ini_get('session.gc_maxlifetime') < CIVITAI_ACCESS_TTL) throw new RuntimeException('Access session lifetime is unavailable.');
    if (session_name(CIVITAI_ACCESS_COOKIE) === false || session_save_path($directory) === false || session_cache_limiter('') === false ||
        session_name() !== CIVITAI_ACCESS_COOKIE || session_save_path() !== $directory) throw new RuntimeException('Private access session settings are unavailable.');
    if (!session_set_cookie_params(['lifetime' => 0, 'path' => '/', 'domain' => '', 'secure' => true, 'httponly' => true, 'samesite' => 'Lax'])) throw new RuntimeException('Secure access cookies are unavailable.');
    if (!session_start()) throw new RuntimeException('Could not open access session.');
    return true;
}

function gate_verified_until(): int {
    $until = $_SESSION['verifiedUntil'] ?? 0;
    $solved = $_SESSION['verifiedAt'] ?? 0;
    return is_int($until) && is_int($solved) && $solved > 0 && $solved <= time() &&
        $until === $solved + CIVITAI_ACCESS_TTL && $until > time() ? $until : 0;
}

/** Always close the session lock before queries, image streaming, or conditional responses. */
function gate_is_verified(): bool {
    try { return gate_open_session(false) && gate_verified_until() > 0; }
    finally { gate_release_session(); }
}

function gate_require_verified(): void {
    try {
        if (gate_is_verified()) return;
        gate_json(['ok' => false, 'code' => 'captcha_required', 'error' => 'Complete the image verification to browse this library.'], 403);
    } catch (Throwable $error) {
        if (session_status() === PHP_SESSION_ACTIVE) session_abort();
        gate_headers();
        header('Retry-After: 30');
        json_response(['ok' => false, 'code' => 'captcha_unavailable', 'error' => 'Verification is temporarily unavailable. Please try again shortly.'], 503);
    }
}

function gate_check_origin(string $method): void {
    $origin = (string)($_SERVER['HTTP_ORIGIN'] ?? '');
    $site = strtolower((string)($_SERVER['HTTP_SEC_FETCH_SITE'] ?? ''));
    if (!in_array($site, ['', 'same-origin', 'none'], true) ||
        ($origin !== '' && strtolower($origin) !== gate_origin()) || ($method === 'POST' && $origin === '')) {
        gate_json(['ok' => false, 'error' => 'Open verification on this library website.'], 403);
    }
}

/** Quotas have their own database, so verification never takes the catalog writer lock. */
function gate_rate_database(): PDO {
    static $pdo;
    if ($pdo instanceof PDO) return $pdo;
    $catalog = (string)(config()['database_path'] ?? '');
    if (!str_starts_with($catalog, '/') || !is_dir(dirname($catalog))) throw new RuntimeException('Private verification storage is unavailable.');
    $path = dirname($catalog) . '/access-gate.sqlite';
    if (is_link($path)) throw new RuntimeException('Invalid verification storage.');
    $previousMask = umask(0077);
    try {
        $pdo = new PDO('sqlite:' . $path, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);
        $pdo->exec('PRAGMA busy_timeout=1500; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;');
        $pdo->exec('CREATE TABLE IF NOT EXISTS access_settings(name TEXT PRIMARY KEY,value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS access_rate_buckets(bucket_key TEXT PRIMARY KEY,hits INTEGER NOT NULL,expires_at INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS access_rate_expiry ON access_rate_buckets(expires_at);');
        if (!chmod($path, 0640)) throw new RuntimeException('Could not protect verification storage.');
    } finally { umask($previousMask); }
    return $pdo;
}

function gate_client_key(PDO $pdo): string {
    $secret = $pdo->query("SELECT value FROM access_settings WHERE name='ip_secret_v1'")->fetchColumn();
    if ($secret === false) {
        $pdo->prepare("INSERT OR IGNORE INTO access_settings(name,value) VALUES('ip_secret_v1',?)")->execute([bin2hex(random_bytes(32))]);
        $secret = $pdo->query("SELECT value FROM access_settings WHERE name='ip_secret_v1'")->fetchColumn();
    }
    if (!is_string($secret) || !preg_match('/^[a-f0-9]{64}$/D', $secret)) throw new RuntimeException('Invalid verification quota secret.');
    $address = @inet_pton((string)($_SERVER['REMOTE_ADDR'] ?? ''));
    if ($address === false) throw new RuntimeException('Verification requires a valid client address.');
    if (strlen($address) === 16 && substr($address, 0, 12) === str_repeat("\0", 10) . "\xff\xff") $address = substr($address, 12);
    return hash_hmac('sha256', 'access-address:' . gmdate('Y-m-d') . ':' . $address, $secret);
}

function gate_rate_limit(string $action): void {
    $quotas = match ($action) {
        'challenge' => [[60, 12], [3600, 60]],
        'verify' => [[60, 20], [3600, 100]],
        'image' => [[60, 60]],
        default => [[60, 120]],
    };
    $pdo = gate_rate_database(); $client = gate_client_key($pdo); $now = time(); $active = false;
    try {
        $pdo->exec('BEGIN IMMEDIATE'); $active = true;
        $pdo->prepare('DELETE FROM access_rate_buckets WHERE expires_at<=?')->execute([$now]);
        $count = (int)$pdo->query('SELECT COUNT(*) FROM access_rate_buckets')->fetchColumn();
        $find = $pdo->prepare('SELECT hits FROM access_rate_buckets WHERE bucket_key=?');
        $update = $pdo->prepare('INSERT INTO access_rate_buckets(bucket_key,hits,expires_at) VALUES(?,1,?) ON CONFLICT(bucket_key) DO UPDATE SET hits=hits+1');
        $buckets = [];
        foreach ($quotas as [$period, $limit]) {
            $start = intdiv($now, $period) * $period;
            $key = hash('sha256', $action . ':' . $client . ':' . $period . ':' . $start);
            $find->execute([$key]); $hits = $find->fetchColumn(); $find->closeCursor();
            if (($hits !== false && (int)$hits >= $limit) || ($hits === false && ++$count > 20000)) throw new CivitaiAccessRateLimit(max(1, $start + $period - $now));
            $buckets[] = [$key, $start + $period];
        }
        foreach ($buckets as $bucket) $update->execute($bucket);
        $pdo->exec('COMMIT'); $active = false;
    } catch (Throwable $error) {
        if ($active) $pdo->exec('ROLLBACK');
        throw $error;
    }
}

function gate_prune_challenges(): void {
    if (!is_array($_SESSION['challenges'] ?? null)) $_SESSION['challenges'] = [];
    foreach ($_SESSION['challenges'] as $id => $challenge) {
        if (!is_array($challenge) || !is_int($challenge['expiresAt'] ?? null) || $challenge['expiresAt'] <= time()) unset($_SESSION['challenges'][$id]);
    }
    while (count($_SESSION['challenges']) > 5) unset($_SESSION['challenges'][array_key_first($_SESSION['challenges'])]);
}

function gate_session_limit(string $kind, int $limit): void {
    $now = time(); $period = 900; $window = intdiv($now, $period) * $period;
    $counter = $_SESSION['limits'][$kind] ?? [];
    $count = ($counter['window'] ?? null) === $window ? (int)($counter['count'] ?? 0) : 0;
    if ($count >= $limit) throw new CivitaiAccessRateLimit(max(1, $window + $period - $now));
    $_SESSION['limits'][$kind] = ['window' => $window, 'count' => $count + 1];
}

/** Server-rendered glyph pixels become shuffled vector paths, never text or character attributes. */
function gate_challenge_svg(string $answer): string {
    $font = [
        '2'=>[14,17,1,2,4,8,31], '3'=>[30,1,1,14,1,1,30], '4'=>[2,6,10,18,31,2,2],
        '5'=>[31,16,16,30,1,1,30], '6'=>[14,16,16,30,17,17,14], '7'=>[31,1,2,4,8,8,8],
        '8'=>[14,17,17,14,17,17,14], '9'=>[14,17,17,15,1,1,14],
        'A'=>[14,17,17,31,17,17,17], 'B'=>[30,17,17,30,17,17,30], 'C'=>[14,17,16,16,16,17,14],
        'D'=>[30,17,17,17,17,17,30], 'E'=>[31,16,16,30,16,16,31], 'F'=>[31,16,16,30,16,16,16],
        'G'=>[14,17,16,23,17,17,15], 'H'=>[17,17,17,31,17,17,17], 'J'=>[7,2,2,2,18,18,12],
        'K'=>[17,18,20,24,20,18,17], 'L'=>[16,16,16,16,16,16,31], 'M'=>[17,27,21,21,17,17,17],
        'N'=>[17,25,25,21,19,19,17], 'P'=>[30,17,17,30,16,16,16], 'Q'=>[14,17,17,17,21,18,13],
        'R'=>[30,17,17,30,20,18,17], 'S'=>[15,16,16,14,1,1,30], 'T'=>[31,4,4,4,4,4,4],
        'U'=>[17,17,17,17,17,17,14], 'V'=>[17,17,17,17,17,10,4], 'W'=>[17,17,17,21,21,27,17],
        'X'=>[17,17,10,4,10,17,17], 'Y'=>[17,17,10,4,4,4,4], 'Z'=>[31,1,2,4,8,16,31],
    ];
    $paths = []; $svg = '<svg xmlns="http://www.w3.org/2000/svg" width="360" height="112" viewBox="0 0 360 112" role="img" aria-label="Six verification characters"><rect width="360" height="112" rx="14" fill="#151924"/>';
    for ($i = 0; $i < 70; $i++) $svg .= '<circle cx="' . random_int(4, 356) . '" cy="' . random_int(4, 108) . '" r="1.2" fill="#47566b"/>';
    for ($i = 0; $i < 6; $i++) {
        $rows = $font[$answer[$i]]; $angle = random_int(-12, 12) * M_PI / 180;
        $cos = cos($angle); $sin = sin($angle); $x = 25 + $i * 51 + random_int(-2, 2); $y = 32 + random_int(-6, 6);
        foreach ($rows as $row => $bits) for ($column = 0; $column < 5; $column++) {
            if (!($bits & (1 << (4 - $column)))) continue;
            $points = [];
            foreach ([[0,0],[5.8,0],[5.8,6.8],[0,6.8]] as [$dx,$dy]) {
                $px = $column * 5.8 + $dx - 14.5; $py = $row * 6.8 + $dy - 23.8;
                $points[] = sprintf('%.2F %.2F', $x + 14.5 + $px * $cos - $py * $sin, $y + 23.8 + $px * $sin + $py * $cos);
            }
            $paths[] = 'M' . implode('L', $points) . 'Z';
        }
    }
    for ($i = count($paths) - 1; $i > 0; $i--) { $j = random_int(0, $i); [$paths[$i], $paths[$j]] = [$paths[$j], $paths[$i]]; }
    $svg .= '<path fill="#d9eaff" d="' . implode('', $paths) . '"/>';
    for ($i = 0; $i < 3; $i++) $svg .= '<path d="M0 ' . random_int(10, 102) . ' Q180 ' . random_int(0, 112) . ' 360 ' . random_int(10, 102) . '" fill="none" stroke="#6982ac" stroke-opacity="0.55" stroke-width="1.5"/>';
    return $svg . '</svg>';
}

