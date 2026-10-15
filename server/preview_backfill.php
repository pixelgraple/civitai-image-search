<?php
declare(strict_types=1);
if (PHP_SAPI!=='cli') { http_response_code(404); exit; }
require __DIR__.'/lib.php';

// Run as the media owner, under nice/ionice. Repeated invocations resume from a
// small cursor file; originals and catalog rows are never written. --ids warms
// a specific result page without moving the background cursor.
$options=getopt('',['limit:','pause-ms:','max-seconds:','after:','ids:','cards','help']);
$cards=isset($options['cards']);
if (isset($options['help'])) {
    fwrite(STDOUT,"Usage: php preview_backfill.php [--cards] [--limit=100] [--pause-ms=100] [--max-seconds=40] [--after=ID] [--ids=ID,ID]\n"); exit;
}
$limit=max(1,min(500,(int)($options['limit']??100)));
$pause=max($cards?0:50,min(5000,(int)($options['pause-ms']??100)));
$maxSeconds=max(1,min(300,(int)($options['max-seconds']??40)));
$root=realpath((string)(config()['storage_dir']??''));
if (!$root || !is_writable($root)) { fwrite(STDERR,"Image storage is unavailable or not writable.\n"); exit(1); }
if (!function_exists('imagewebp')) { fwrite(STDERR,"GD WebP encoding is unavailable; legacy previews retained.\n"); exit(1); }
$lock=fopen($root.'/.gallery-preview-backfill.lock','c');
if (!$lock || !flock($lock,LOCK_EX|LOCK_NB)) { fwrite(STDOUT,"Preview backfill already running.\n"); exit; }
chmod($root.'/.gallery-preview-backfill.lock',0640);
$statePath=$root.($cards?'/.card-preview-backfill-v1.json':'/.gallery-preview-backfill-v1.json'); $saved=[]; $ids=[];
if (isset($options['ids'])) {
    $ids=array_values(array_unique(explode(',',(string)$options['ids'])));
    if (!$ids || count($ids)>500 || array_filter($ids,static fn($id)=>!preg_match('/^[1-9][0-9]{0,19}$/D',$id))) {
        fwrite(STDERR,"Expected up to 500 comma-separated image IDs.\n"); exit(1);
    }
}
if (!$ids && is_file($statePath)) {
    if (is_link($statePath) || filesize($statePath)>16384) { fwrite(STDERR,"Invalid preview cursor file.\n"); exit(1); }
    $saved=json_decode((string)file_get_contents($statePath),true);
    if (!is_array($saved) || ($saved['version']??0)!==1) { fwrite(STDERR,"Invalid preview cursor state.\n"); exit(1); }
}
$cursor=(string)($options['after']??$saved['after']??'');
if ($cursor!=='' && !preg_match('/^[1-9][0-9]{0,19}$/D',$cursor)) { fwrite(STDERR,"Invalid image ID cursor.\n"); exit(1); }
$started=microtime(true); $pdo=db();
if ($ids) {
    $query=$pdo->prepare("SELECT image_id,file_path,mime_type FROM images WHERE download_status='ready' AND image_id IN (".implode(',',array_fill(0,count($ids),'?')).') ORDER BY image_id LIMIT '.$limit);
    $query->execute($ids);
} else {
    $query=$pdo->prepare("SELECT image_id,file_path,mime_type FROM images WHERE image_id>? AND download_status='ready' ORDER BY image_id LIMIT ".$limit);
    $query->execute([$cursor]);
}
$rows=$query->fetchAll(); $query->closeCursor();
$counts=['processed'=>0,'upgraded'=>0,'alreadyCached'=>0,'skipped'=>0,'errors'=>0,'legacyBytes'=>0,'previewBytes'=>0];
$checkpoint=static function(bool $complete=false) use (&$cursor,&$counts,$statePath,$ids): void {
    if ($ids) return;
    $temporary=$statePath.'.'.bin2hex(random_bytes(5)).'.tmp';
    $body=json_encode(['version'=>1,'after'=>$cursor,'completed'=>$complete,'updatedAt'=>gmdate('c'),'lastRun'=>$counts],JSON_THROW_ON_ERROR);
    try {
        if (file_put_contents($temporary,$body,LOCK_EX)!==strlen($body) || !chmod($temporary,0640) || !rename($temporary,$statePath)) throw new RuntimeException('Could not save preview cursor.');
    } finally { if (is_file($temporary)) @unlink($temporary); }
};
foreach ($rows as $row) {
    if (microtime(true)-$started>=$maxSeconds) break;
    $path=(string)$row['file_path']; $mime=(string)$row['mime_type'];
    try {
        if ($cards) {
            if (stored_card_preview($path)!=='') $counts['alreadyCached']++;
            elseif (build_card_preview($path)) {
                $counts['upgraded']++;
                $counts['legacyBytes']+=(int)@filesize(gallery_preview_path($path));
                $counts['previewBytes']+=(int)@filesize(card_preview_path($path));
            } else $counts['skipped']++;
        }
        elseif (stored_gallery_preview($path)!=='') $counts['alreadyCached']++;
        elseif (upgrade_legacy_gallery_preview($path,$mime)) {
            $counts['upgraded']++;
            $counts['legacyBytes']+=(int)@filesize(thumbnail_path($path));
            $counts['previewBytes']+=(int)@filesize(gallery_preview_path($path));
        } else $counts['skipped']++;
    } catch (Throwable $error) {
        $counts['errors']++; fwrite(STDERR,'preview '.$row['image_id'].': '.$error->getMessage()."\n");
    }
    $counts['processed']++; $cursor=(string)$row['image_id'];
    if ($counts['processed']%10===0) $checkpoint();
    usleep($pause*1000);
}
$complete=!$ids && count($rows)<$limit && $counts['processed']===count($rows);
$checkpoint($complete);
fwrite(STDOUT,json_encode(['after'=>$cursor,'completed'=>$complete,'targeted'=>(bool)$ids,'elapsedSeconds'=>round(microtime(true)-$started,2),...$counts],JSON_UNESCAPED_SLASHES)."\n");
