<?php
declare(strict_types=1);
require_once dirname(__DIR__) . '/lib.php';
require_once dirname(__DIR__) . '/access-gate.php';

try {
    gate_headers();
    $method = (string)($_SERVER['REQUEST_METHOD'] ?? 'GET');
    $action = is_string($_GET['action'] ?? null) ? $_GET['action'] : 'status';
    gate_check_origin($method);
    if ($action==='search-block' && $method==='GET') {
        require_once dirname(__DIR__).'/search-guard.php';
        search_guard_page();
    }
    if (!in_array($action, ['status', 'challenge', 'image', 'verify'], true)) gate_json(['ok' => false, 'error' => 'Unknown verification action.'], 404);
    $expected = $action === 'verify' ? 'POST' : 'GET';
    if ($method !== $expected) { header('Allow: ' . $expected); gate_json(['ok' => false, 'error' => 'Unsupported request method.'], 405); }
    gate_rate_limit($action);
    if ($action === 'status') {
        $until = gate_open_session(false) ? gate_verified_until() : 0;
        gate_json(['ok' => true, 'verified' => $until > 0, 'expiresAt' => $until * 1000]);
    }
    if ($action === 'challenge') {
        gate_open_session(true);
        $until = gate_verified_until();
        if ($until > 0) gate_json(['ok' => true, 'verified' => true, 'expiresAt' => $until * 1000]);
        gate_prune_challenges(); gate_session_limit('challenge', 30);
        while (count($_SESSION['challenges']) >= 5) unset($_SESSION['challenges'][array_key_first($_SESSION['challenges'])]);
        $answer = '';
        for ($i = 0; $i < 6; $i++) $answer .= CIVITAI_CHALLENGE_ALPHABET[random_int(0, strlen(CIVITAI_CHALLENGE_ALPHABET) - 1)];
        $id = bin2hex(random_bytes(24)); $csrf = bin2hex(random_bytes(32)); $salt = bin2hex(random_bytes(32)); $expires = time() + CIVITAI_CHALLENGE_TTL;
        $_SESSION['challenges'][$id] = ['expiresAt' => $expires, 'csrf' => $csrf, 'salt' => $salt,
            'digest' => hash_hmac('sha256', $answer, $salt), 'svg' => gate_challenge_svg($answer), 'views' => 0];
        unset($answer);
        gate_json(['ok' => true, 'challengeId' => $id, 'csrfToken' => $csrf, 'imageUrl' => 'access.php?action=image&id=' . $id, 'expiresAt' => $expires * 1000, 'length' => 6]);
    }
    if ($action === 'image') {
        $id = $_GET['id'] ?? null;
        if (!is_string($id) || !preg_match('/^[a-f0-9]{48}$/D', $id) || !gate_open_session(false)) gate_json(['ok' => false, 'error' => 'Request a new verification image.', 'newChallenge' => true], 404);
        gate_prune_challenges();
        $challenge = $_SESSION['challenges'][$id] ?? null;
        if (!$challenge || ($challenge['views'] ?? 0) >= 5) gate_json(['ok' => false, 'error' => 'This verification image has expired. Request a new image.', 'newChallenge' => true], 404);
        $_SESSION['challenges'][$id]['views']++;
        $svg = $challenge['svg']; gate_release_session();
        header("Content-Security-Policy: default-src 'none'; sandbox");
        header('Content-Type: image/svg+xml; charset=utf-8');
        header('Content-Length: ' . strlen($svg));
        echo $svg; exit;
    }
    $contentType = strtolower(trim(explode(';', (string)($_SERVER['CONTENT_TYPE'] ?? ''))[0]));
    if ($contentType !== 'application/json') gate_json(['ok' => false, 'error' => 'Submit verification as JSON.'], 415);
    $raw = file_get_contents('php://input', false, null, 0, 4097);
    if ($raw === false || strlen($raw) > 4096) gate_json(['ok' => false, 'error' => 'Verification request is too large.'], 413);
    $body = json_decode($raw, true);
    if (!is_array($body) || array_is_list($body)) gate_json(['ok' => false, 'error' => 'Expected a verification JSON object.'], 400);
    $id = $body['challengeId'] ?? null; $csrf = $body['csrfToken'] ?? null; $answer = $body['answer'] ?? null;
    if (!is_string($id) || !preg_match('/^[a-f0-9]{48}$/D', $id) || !is_string($csrf) || !preg_match('/^[a-f0-9]{64}$/D', $csrf) || !is_string($answer) || strlen($answer) > 64) gate_json(['ok' => false, 'error' => 'Enter the six characters from a new verification image.', 'newChallenge' => true], 400);
    if (!gate_open_session(false)) gate_json(['ok' => false, 'error' => 'Your verification session expired. Request a new image.', 'newChallenge' => true], 400);
    $until = gate_verified_until();
    if ($until > 0) gate_json(['ok' => true, 'verified' => true, 'expiresAt' => $until * 1000]);
    gate_prune_challenges(); gate_session_limit('verify', 20);
    $challenge = $_SESSION['challenges'][$id] ?? null;
    if (!$challenge) gate_json(['ok' => false, 'error' => 'This verification image expired or was already used. Request a new image.', 'newChallenge' => true], 400);
    if (!hash_equals($challenge['csrf'], $csrf)) gate_json(['ok' => false, 'error' => 'Verification token did not match. Request a new image.', 'newChallenge' => true], 403);
    unset($_SESSION['challenges'][$id]); // Every submitted answer consumes its challenge.
    $answer = strtoupper(trim($answer));
    if (strlen($answer) !== 6 || !hash_equals($challenge['digest'], hash_hmac('sha256', $answer, $challenge['salt']))) {
        unset($answer);
        gate_json(['ok' => false, 'code' => 'captcha_incorrect', 'error' => 'Those characters did not match. Request a new image and try again.', 'newChallenge' => true], 400);
    }
    unset($answer, $challenge);
    if (!session_regenerate_id(true)) throw new RuntimeException('Could not rotate verification session.');
    $solved = time(); $expires = $solved + CIVITAI_ACCESS_TTL;
    $_SESSION['verifiedAt'] = $solved; $_SESSION['verifiedUntil'] = $expires; $_SESSION['challenges'] = [];
    // Regeneration issues the configured browser-session cookie; the server enforces the fixed one-hour cap.
    gate_json(['ok' => true, 'verified' => true, 'expiresAt' => $expires * 1000]);
} catch (CivitaiAccessRateLimit $error) {
    try {
        header('Retry-After: ' . $error->retryAfter);
        gate_json(['ok' => false, 'code' => 'captcha_rate_limited', 'error' => 'Too many verification requests. Please wait and try again.', 'retryAfter' => $error->retryAfter], 429);
    } catch (Throwable $storageError) {
        if (session_status() === PHP_SESSION_ACTIVE) session_abort();
        gate_headers(); header('Retry-After: 30');
        json_response(['ok' => false, 'code' => 'captcha_unavailable', 'error' => 'Verification is temporarily unavailable. Please try again shortly.'], 503);
    }
} catch (Throwable $error) {
    if (session_status() === PHP_SESSION_ACTIVE) session_abort();
    gate_headers(); header('Retry-After: 30');
    error_log('Civitai access gate unavailable (' . get_class($error) . ').');
    json_response(['ok' => false, 'code' => 'captcha_unavailable', 'error' => 'Verification is temporarily unavailable. Please try again shortly.'], 503);
}
