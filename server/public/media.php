<?php
declare(strict_types=1);
require dirname(__DIR__) . '/lib.php';
$id=(string)($_GET['id']??''); $variant=(string)($_GET['variant']??'original');
if (!preg_match('/^\d{1,20}$/',$id) || !in_array($variant,['original','thumb'],true)) { http_response_code(404); exit; }
try {
    $stmt=db()->prepare('SELECT file_path,mime_type FROM images WHERE image_id=? AND download_status=?');
    $stmt->execute([$id,'ready']); $row=$stmt->fetch();
    if (!$row) { http_response_code(404); exit; }
    $cfg=config(); $root=realpath((string)($cfg['storage_dir']??''));
    $path=(string)$row['file_path'];
    if ($variant==='thumb') $path=preg_replace('/\.(png|jpe?g|webp)$/i','-thumb.$1',$path) ?: $path;
    $full=realpath($path);
    if (!$root || !$full || !str_starts_with($full,$root . DIRECTORY_SEPARATOR) || !is_file($full)) { http_response_code(404); exit; }
    $mime=$variant==='thumb' ? mime_content_type($full) : (string)$row['mime_type'];
    if (!in_array($mime,['image/jpeg','image/png','image/webp'],true)) { http_response_code(404); exit; }
    header('Content-Type: '.$mime); header('X-Content-Type-Options: nosniff'); header('Content-Disposition: inline');
    header('Cache-Control: public, max-age=86400'); header('Content-Length: '.filesize($full)); readfile($full);
} catch (Throwable $error) { error_log('Civitai media error: '.$error->getMessage()); http_response_code(500); }
