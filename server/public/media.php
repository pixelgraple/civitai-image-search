<?php
declare(strict_types=1);
require dirname(__DIR__) . '/lib.php';
require_once dirname(__DIR__) . '/access-gate.php';
try { gate_require_verified(); }
catch (Throwable $error) {
    error_log('Civitai media access gate unavailable.');
    header('Cache-Control: no-store'); http_response_code(503); exit;
}
$id=(string)($_GET['id']??''); $variant=(string)($_GET['variant']??'original');
$previewWidth=(string)($_GET['w']??'720');
if (!preg_match('/^\d{1,20}$/',$id) || !in_array($variant,['original','thumb'],true) ||
    ($variant==='thumb' && !in_array($previewWidth,['320','720'],true))) { http_response_code(404); exit; }
try {
    $stmt=db()->prepare('SELECT file_path,mime_type FROM images WHERE image_id=? AND download_status=?');
    $stmt->execute([$id,'ready']); $row=$stmt->fetch();
    if (!$row) { http_response_code(404); exit; }
    $cfg=config(); $root=realpath((string)($cfg['storage_dir']??''));
    $path=(string)$row['file_path']; $compact='';
    // Cache generation belongs to the worker/backfill. A gallery request only
    // reads an existing compact preview or its compatible legacy fallback.
    if ($variant==='thumb') {
        $compact=$previewWidth==='320'?stored_card_preview($path):'';
        if ($compact==='') $compact=stored_gallery_preview($path);
        $path=$compact!==''?$compact:thumbnail_path($path);
    }
    $full=realpath($path);
    if (!$root || !$full || !str_starts_with($full,$root . DIRECTORY_SEPARATOR) || !is_file($full)) { http_response_code(404); exit; }
    // Old decoder failures sometimes left a full-size original as the
    // legacy thumbnail. Never stream those multi-megabyte files in a grid.
    if ($variant==='thumb' && $compact==='') {
        $legacy=@getimagesize($full);
        if (!$legacy || max((int)$legacy[0],(int)$legacy[1])>720 || @filesize($full)>1024*1024) { http_response_code(404); exit; }
    }
    $mime=$variant==='thumb' ? mime_content_type($full) : (string)$row['mime_type'];
    if (!in_array($mime,['image/jpeg','image/png','image/webp'],true)) { http_response_code(404); exit; }
    $size=filesize($full); $etag='"'.hash('sha256',$full.':'.filemtime($full).':'.$size).'"';
    header('Content-Type: '.$mime); header('X-Content-Type-Options: nosniff'); header('Content-Disposition: inline');
    // Revalidate through the one-hour access gate; shared caches cannot publish media.
    header('Cache-Control: private, max-age=0, must-revalidate');
    header('Vary: Cookie');
    header('ETag: '.$etag);
    if (trim((string)($_SERVER['HTTP_IF_NONE_MATCH']??''))===$etag) { http_response_code(304); exit; }
    header('Content-Length: '.$size); if (($_SERVER['REQUEST_METHOD']??'GET')!=='HEAD') readfile($full);
} catch (Throwable $error) { error_log('Civitai media error: '.$error->getMessage()); http_response_code(500); }
