<?php
declare(strict_types=1);

function config(): array {
    $path = getenv('CIVITAI_LIBRARY_CONFIG') ?: __DIR__ . '/config.local.php';
    if (!is_file($path)) throw new RuntimeException('Server configuration is not installed.');
    $value = require $path;
    if (!is_array($value)) throw new RuntimeException('Invalid server configuration.');
    return $value;
}

function db(): PDO {
    static $pdo;
    if ($pdo instanceof PDO) return $pdo;
    $cfg = config();
    $path = (string)($cfg['database_path'] ?? '');
    if ($path === '' || !str_starts_with($path, '/')) throw new RuntimeException('Database path must be absolute.');
    $dir = dirname($path);
    if (!is_dir($dir) && !mkdir($dir, 0750, true) && !is_dir($dir)) throw new RuntimeException('Could not create database directory.');
    $pdo = new PDO('sqlite:' . $path, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);
    $pdo->sqliteCreateFunction('catalog_lower', static fn($value)=>lower_text((string)$value), 1, PDO::SQLITE_DETERMINISTIC);
    $pdo->exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;');
    $schema=file_get_contents(__DIR__.'/schema.sql');
    if ($schema===false) throw new RuntimeException('Database schema is unavailable.');
    $pdo->exec($schema);
    $columns=array_column($pdo->query('PRAGMA table_info(images)')->fetchAll(),'name');
    foreach (['reactions_json'=>"TEXT NOT NULL DEFAULT '{}'",'image_width'=>'INTEGER NOT NULL DEFAULT 0','image_height'=>'INTEGER NOT NULL DEFAULT 0'] as $column=>$definition) {
        if (in_array($column,$columns,true)) continue;
        try { $pdo->exec('ALTER TABLE images ADD COLUMN '.$column.' '.$definition); }
        catch (PDOException $error) {
            $current=array_column($pdo->query('PRAGMA table_info(images)')->fetchAll(),'name');
            if (!in_array($column,$current,true)) throw $error;
        }
    }
    return $pdo;
}

function lower_text(string $value): string { return function_exists('mb_strtolower') ? mb_strtolower($value,'UTF-8') : strtolower($value); }
function cut_text(string $value,int $length): string { return function_exists('mb_substr') ? mb_substr($value,0,$length,'UTF-8') : substr($value,0,$length); }

function json_response(array $body, int $status = 200): never {
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($body, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}

function cors_headers(): void {
    header('Access-Control-Allow-Origin: *');
    header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
    header('Access-Control-Allow-Headers: Authorization, Content-Type');
    header('Vary: Origin');
}

function json_input(): array {
    $raw = file_get_contents('php://input');
    if ($raw === false || strlen($raw) > 1048576) json_response(['ok'=>false,'error'=>'Request body too large.'], 413);
    $data = json_decode($raw, true);
    if (!is_array($data)) json_response(['ok'=>false,'error'=>'Expected a JSON object.'], 400);
    return $data;
}

function normalize_strings(mixed $value, int $limit = 200): array {
    if (!is_array($value)) return [];
    $out = [];
    foreach ($value as $item) {
        if (is_array($item)) $item = $item['name'] ?? '';
        if (!is_string($item)) continue;
        $item = trim(preg_replace('/\s+/u', ' ', $item) ?? '');
        if ($item === '') continue;
        $out[] = cut_text($item, 200);
        if (count($out) >= $limit) break;
    }
    return array_values(array_unique($out));
}

function normalize_reactions(mixed $value): array {
    if (!is_array($value) || ($value['statsUnknown']??false)===true) return [];
    $out=[];
    foreach (['likeCount','heartCount','laughCount','cryCount','buzzCount'] as $key) {
        $number=$value[$key]??null;
        if ((is_int($number)||is_float($number)) && is_finite((float)$number) && $number>=0 && $number<=9007199254740991 && floor($number)==$number) $out[$key]=(int)$number;
    }
    return $out;
}

/** Buzz is optional; four observed reaction counts, including zero, are complete. */
function source_reactions_missing(mixed $value): bool {
    $known=normalize_reactions($value);
    return count(array_diff(['likeCount','heartCount','laughCount','cryCount'],array_keys($known)))>0;
}

/** Refresh source metadata without inspecting media or rewriting searchable image fields. */
function update_source_reactions(PDO $pdo,array $items): array {
    $records=[]; $skipped=0;
    foreach ($items as $item) {
        if (!is_array($item) || !valid_image_id($item['id']??null) || !($counts=normalize_reactions($item['reactions']??null))) {
            $skipped++; continue;
        }
        $id=(string)$item['id'];
        $records[$id]=array_replace($records[$id]??[],$counts);
    }
    $accepted=0; $updated=0; $missingIds=[];
    if (!$records) return compact('accepted','updated','skipped','missingIds');
    $find=$pdo->prepare('SELECT reactions_json FROM images WHERE image_id=?');
    $update=$pdo->prepare('UPDATE images SET reactions_json=?,updated_at=? WHERE image_id=?');
    $pdo->beginTransaction();
    try {
        foreach ($records as $id=>$counts) {
            $id=(string)$id; $find->execute([$id]); $row=$find->fetch();
            if (!$row) { $missingIds[]=$id; continue; }
            $prior=normalize_reactions(json_decode($row['reactions_json'],true));
            $merged=array_replace($prior,$counts); $accepted++;
            if ($merged==$prior) continue;
            $update->execute([json_encode((object)$merged,JSON_THROW_ON_ERROR),gmdate('c'),$id]); $updated++;
        }
        $pdo->commit();
    } catch (Throwable $error) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        throw $error;
    }
    return compact('accepted','updated','skipped','missingIds');
}

function image_dimension(mixed $value): int {
    return is_numeric($value) && (float)$value>0 && (float)$value<=100000 && floor((float)$value)==(float)$value ? (int)$value : 0;
}

function image_size_exceeds_limits(mixed $width,mixed $height): bool {
    $w=is_numeric($width) ? (float)$width : 0.0;
    $h=is_numeric($height) ? (float)$height : 0.0;
    return $w>4096 || $h>4096 || ($w>0 && $h>0 && $w*$h>9000000);
}

function image_size_limit_message(): string {
    return 'Skipped: exceeds 9 MP or 4096 pixels per side.';
}

function image_collection_skip(PDO $pdo,string $id): ?array {
    $find=$pdo->prepare('SELECT reason,width,height FROM image_collection_skips WHERE image_id=?');
    $find->execute([$id]); return $find->fetch() ?: null;
}

/** Caller holds the image lock. Existing completed copies are retained. */
function skip_image_collection(PDO $pdo,string $id,mixed $width,mixed $height): void {
    $find=$pdo->prepare('SELECT download_status FROM images WHERE image_id=?');
    $find->execute([$id]);
    if ($find->fetchColumn()==='ready') return;
    $width=image_dimension($width); $height=image_dimension($height); $now=gmdate('c');
    $pdo->prepare("INSERT INTO image_collection_skips(image_id,reason,width,height,skipped_at) VALUES(?,'oversize',?,?,?) ON CONFLICT(image_id) DO UPDATE SET width=excluded.width,height=excluded.height,skipped_at=excluded.skipped_at")
        ->execute([$id,$width,$height,$now]);
    $pdo->prepare("UPDATE images SET download_status='failed',download_error=?,image_width=?,image_height=?,updated_at=? WHERE image_id=? AND download_status<>'ready'")
        ->execute([image_size_limit_message(),$width,$height,$now,$id]);
}

function valid_image_id(mixed $value): bool {
    return (is_string($value) || is_int($value)) && preg_match('/^[1-9]\d{0,19}$/D', (string)$value) === 1;
}

function has_positive_prompt(string $prompt): bool {
    return preg_match('/[^\s\p{Z}]/u',$prompt) === 1;
}

class StorageLockBusy extends RuntimeException {}

/** Acquire in sorted order before a transaction, with a bounded wait for the whole batch. */
function lock_image_ids(array $ids, float $timeout=3.0): array {
    $storage=(string)(config()['storage_dir']??'');
    if ($storage==='' || !str_starts_with($storage,'/')) throw new RuntimeException('Storage directory must be absolute.');
    $directory=rtrim($storage,'/').'/.image-locks';
    if (!is_dir($directory) && !mkdir($directory,0750,true) && !is_dir($directory)) throw new RuntimeException('Could not create storage lock directory.');
    $root=realpath($storage); $resolved=realpath($directory);
    if (!$root || !$resolved || !str_starts_with($resolved,$root.DIRECTORY_SEPARATOR)) throw new RuntimeException('Storage lock directory escaped configured root.');
    $ids=array_values(array_unique(array_map('strval',$ids))); sort($ids,SORT_STRING); $locks=[]; $deadline=microtime(true)+$timeout;
    try {
        foreach ($ids as $id) {
            if (!valid_image_id($id)) throw new RuntimeException('Invalid image lock ID.');
            $handle=fopen($directory.'/'.$id.'.lock','c');
            if (!$handle) throw new RuntimeException('Could not open image storage lock.');
            while (!flock($handle,LOCK_EX|LOCK_NB)) {
                if (microtime(true)>=$deadline) { fclose($handle); throw new StorageLockBusy('Image storage is busy; retry this batch shortly.'); }
                usleep(50000);
            }
            @chmod($directory.'/'.$id.'.lock',0640); $locks[]=$handle;
        }
        return $locks;
    } catch (Throwable $error) { unlock_image_ids($locks); throw $error; }
}

function unlock_image_ids(array $locks): void {
    foreach (array_reverse($locks) as $handle) { flock($handle,LOCK_UN); fclose($handle); }
}

/** Include inode, timestamps, permissions and the catalog's expected digest in every cache key. */
function stored_image_fingerprint(array $row,string $full): ?array {
    clearstatcache(true,$full); $stat=@stat($full);
    if (!$stat || ($stat['mode']&0170000)!==0100000 || $stat['size']<=0 || !is_readable($full)) return null;
    if ((int)($row['file_size']??0)>0 && $stat['size']!==(int)$row['file_size']) return null;
    $fingerprint=['path'=>$full];
    foreach (['dev','ino','size','mtime','ctime','mode','uid','gid'] as $key) $fingerprint[$key]=(int)$stat[$key];
    $fingerprint['expectedSha']=(string)($row['sha256']??'');
    $fingerprint['expectedSize']=(int)($row['file_size']??0);
    $fingerprint['expectedMime']=(string)($row['mime_type']??'');
    return $fingerprint;
}

/** One private cache entry per original path; changing a file replaces its entry. */
function stored_image_cache_path(string $full,bool $create=false): ?string {
    $root=realpath((string)(config()['storage_dir']??''));
    if (!$root || !str_starts_with($full,$root.DIRECTORY_SEPARATOR)) return null;
    $directory=$root.'/.image-verifications';
    if (!is_dir($directory) && (!$create || !@mkdir($directory,0750,true))) return null;
    $resolved=realpath($directory);
    if (!$resolved || !str_starts_with($resolved,$root.DIRECTORY_SEPARATOR)) return null;
    return $resolved.'/'.hash('sha256',$full).'.json';
}

/** Only seed from bytes already verified by this process, after coarse timestamps are stable. */
function remember_stored_image_verification(array $row,array $verified): void {
    $root=realpath((string)(config()['storage_dir']??''));
    $full=realpath((string)($row['file_path']??''));
    if (!$root || !$full || !str_starts_with($full,$root.DIRECTORY_SEPARATOR) || empty($verified['exists']) || ($verified['path']??'')!==$full) return;
    $fingerprint=stored_image_fingerprint($row,$full); $now=time();
    if (!$fingerprint || $fingerprint['mtime']>=$now || $fingerprint['ctime']>=$now) return;
    $digest=(string)($verified['sha256']??''); $mime=(string)($verified['mime']??'');
    if (!preg_match('/^[a-f0-9]{64}$/D',$digest) || ($verified['size']??0)!==$fingerprint['size'] ||
        !in_array($mime,['image/jpeg','image/png','image/webp'],true) ||
        ($fingerprint['expectedSha']!=='' && !hash_equals($fingerprint['expectedSha'],$digest)) ||
        ($fingerprint['expectedMime']!=='' && $fingerprint['expectedMime']!==$mime)) return;
    $path=stored_image_cache_path($full,true);
    if (!$path || is_link($path)) return;
    $temporary=@tempnam(dirname($path),'.verify-');
    if (!$temporary) return;
    try {
        $data=json_encode(['version'=>1,'verifiedAt'=>$now,'fingerprint'=>$fingerprint,'sha256'=>$digest,'mime'=>$mime],JSON_THROW_ON_ERROR);
        if (@file_put_contents($temporary,$data,LOCK_EX)!==strlen($data)) return;
        @chmod($temporary,0640); @rename($temporary,$path);
    } finally { if (is_file($temporary)) @unlink($temporary); }
}

/** Verify original bytes on a cache miss; unchanged, stable files reuse a recent verification. */
function inspect_stored_image(array $row): array {
    $missing=['exists'=>false,'sha256'=>'','path'=>'','size'=>0,'mime'=>''];
    $root=realpath((string)(config()['storage_dir']??''));
    $path=(string)($row['file_path']??''); clearstatcache(true,$path); $full=$path===''?false:realpath($path);
    if (!$root || !$full || !str_starts_with($full,$root.DIRECTORY_SEPARATOR)) return $missing;
    $fingerprint=stored_image_fingerprint($row,$full);
    if (!$fingerprint) return $missing;
    $expected=$fingerprint['expectedSha']; $knownMime=$fingerprint['expectedMime'];
    if ($expected!=='' && !preg_match('/^[a-f0-9]{64}$/D',$expected)) return $missing;
    $now=time(); $cache=stored_image_cache_path($full);
    if ($fingerprint['mtime']<$now && $fingerprint['ctime']<$now && $cache && !is_link($cache) && is_file($cache) && filesize($cache)<=4096) {
        $saved=json_decode((string)@file_get_contents($cache),true);
        if (is_array($saved) && ($saved['version']??0)===1 && is_int($saved['verifiedAt']??null) &&
            $saved['verifiedAt']<=$now && $saved['verifiedAt']>=$now-21600 && ($saved['fingerprint']??null)===$fingerprint &&
            preg_match('/^[a-f0-9]{64}$/D',(string)($saved['sha256']??'')) &&
            ($expected==='' || hash_equals($expected,$saved['sha256'])) &&
            in_array($saved['mime']??'', ['image/jpeg','image/png','image/webp'],true) &&
            ($knownMime==='' || $knownMime===$saved['mime']) && stored_image_fingerprint($row,$full)===$fingerprint) {
            return ['exists'=>true,'sha256'=>$saved['sha256'],'path'=>$full,'size'=>$fingerprint['size'],'mime'=>$saved['mime']];
        }
    }
    $info=@getimagesize($full); $mime=(string)($info['mime']??'');
    if (!in_array($mime,['image/jpeg','image/png','image/webp'],true) || ($knownMime!=='' && $knownMime!==$mime)) return $missing;
    $digest=@hash_file('sha256',$full);
    if ($digest===false || ($expected!=='' && !hash_equals($expected,$digest)) || stored_image_fingerprint($row,$full)!==$fingerprint) return $missing;
    $verified=['exists'=>true,'sha256'=>$digest,'path'=>$full,'size'=>$fingerprint['size'],'mime'=>$mime];
    // Never seed from a hash that began during the file's last modification second.
    if ($fingerprint['mtime']<$now && $fingerprint['ctime']<$now) remember_stored_image_verification($row,$verified);
    return $verified;
}

/** Run all image/thumbnail reads before beginning the catalog write transaction. */
function inspect_image_storage(array $row): array {
    if (($row['download_status']??'')!=='ready' && (image_size_exceeds_limits($row['image_width']??0,$row['image_height']??0) || ($row['download_error']??'')===image_size_limit_message())) {
        return ['exists'=>false,'sha256'=>'','path'=>'','size'=>0,'mime'=>'','thumbnailValid'=>false];
    }
    $stored=inspect_stored_image($row);
    $stored['thumbnailValid']=$stored['exists'] && valid_stored_thumbnail($stored['path'],$stored['mime']);
    return $stored;
}

function thumbnail_path(string $path): string {
    return preg_replace('/\.(png|jpe?g|webp)$/i','-thumb.$1',$path) ?: '';
}

function valid_stored_thumbnail(string $path, string $mime): bool {
    $thumb=thumbnail_path($path); $root=realpath((string)(config()['storage_dir']??'')); $full=$thumb===''?false:realpath($thumb);
    if (!$root || !$full || !str_starts_with($full,$root.DIRECTORY_SEPARATOR) || !is_file($full) || !is_readable($full)) return false;
    $info=@getimagesize($full); return ($info['mime']??'')===$mime;
}

/** Caller holds this image's lock. Valid bytes can recover an interrupted status update. */
function check_image_storage(PDO $pdo, ?array $row, string $id, ?array $inspection=null): array {
    if (!$row || $row['download_status']!=='ready') {
        if ($row && image_size_exceeds_limits($row['image_width']??0,$row['image_height']??0)) skip_image_collection($pdo,$id,$row['image_width'],$row['image_height']);
        if (image_collection_skip($pdo,$id)) return ['imageId'=>$id,'exists'=>true,'sha256'=>'','downloadStatus'=>'skipped','needsDownload'=>false,'skipReason'=>'oversize'];
    }
    if (!$row) return ['imageId'=>$id,'exists'=>false,'sha256'=>'','downloadStatus'=>'unknown','needsDownload'=>true];
    $stored=$inspection??inspect_image_storage($row); $status=(string)$row['download_status'];
    if ($stored['exists']) {
        if ($status!=='ready' || ($row['sha256']??'')!==$stored['sha256'] || (int)$row['file_size']!==$stored['size'] || $row['mime_type']!==$stored['mime']) {
            $pdo->prepare("UPDATE images SET sha256=?,mime_type=?,file_size=?,download_status='ready',download_error='',updated_at=? WHERE image_id=?")
                ->execute([$stored['sha256'],$stored['mime'],$stored['size'],gmdate('c'),$id]);
        }
        $status='ready';
        if (!$stored['thumbnailValid']) {
            $pdo->prepare("UPDATE images SET download_status='pending',download_error='Thumbnail needs local repair.',updated_at=? WHERE image_id=?")
                ->execute([gmdate('c'),$id]);
            $status='pending';
        }
    } elseif ($status==='ready') {
        $pdo->prepare("UPDATE images SET download_status='pending',download_attempts=0,download_error='Stored image is missing or failed SHA256 verification.',updated_at=? WHERE image_id=? AND download_status='ready'")
            ->execute([gmdate('c'),$id]);
        $status='pending';
    }
    return ['imageId'=>$id,'exists'=>$stored['exists'],'sha256'=>$stored['sha256'],'downloadStatus'=>$status,'needsDownload'=>!$stored['exists']];
}

function classify_style(string $prompt, string $model, array $loras, array $tags): array {
    require_once __DIR__.'/style-classifier.php';
    return classify_prompt_style($prompt, $model, $loras, $tags);
}

function safe_image_url(mixed $value): ?string {
    if (!is_string($value) || strlen($value) > 2048) return null;
    $url = parse_url($value);
    if (!$url || ($url['scheme'] ?? '') !== 'https' || !in_array(strtolower($url['host'] ?? ''), ['image.civitai.com','imagecache.civitai.com','blobs.civitai.com','blobs-b2.civitai.com'], true)) return null;
    if (isset($url['user']) || isset($url['pass']) || isset($url['port'])) return null;
    return $value;
}

function contributor_registry_path(): string {
    $path=(string)(config()['contributors_path']??'');
    if ($path!=='' && !str_starts_with($path,'/')) throw new RuntimeException('Contributor registry must use a private absolute path.');
    return $path;
}

function contributor_registry(): array {
    $path=contributor_registry_path();
    if ($path==='' || !is_file($path)) return ['version'=>1,'keys'=>[]];
    if (filesize($path)>1048576) throw new RuntimeException('Contributor registry exceeds its size limit.');
    $data=json_decode((string)file_get_contents($path),true);
    if (!is_array($data) || ($data['version']??null)!==1 || !is_array($data['keys']??null)) {
        throw new RuntimeException('Contributor registry is invalid.');
    }
    return $data;
}

function public_ingest_enabled(): bool { return (config()['public_ingest_enabled']??false) === true; }

/** Use only the address supplied by the web server, never a client-supplied forwarding header. */
function public_ingest_client_id(): string {
    $address=(string)($_SERVER['REMOTE_ADDR']??'');
    $packed=@inet_pton($address);
    if ($packed===false) throw new RuntimeException('A valid client address is required for public ingestion.');
    // Canonicalize IPv4-mapped IPv6, so it cannot obtain a second quota for the same address.
    if (strlen($packed)===16 && substr($packed,0,12)===str_repeat("\0",10)."\xff\xff") $packed=substr($packed,12);
    return 'public:'.hash('sha256','index-civitai-ingest:'.$packed);
}

function limit_contributor_requests(string $id, bool $public=false): void {
    $cfg=config();
    $limit=max(1,min(1200,(int)($cfg[$public?'public_ingest_requests_per_minute':'contributor_requests_per_minute']??120)));
    $maxClients=max(1,min(100000,(int)($cfg['ingest_max_active_clients']??10000)));
    $window=intdiv(time(),60)*60; $pdo=db(); $blocked=false;
    $pdo->beginTransaction();
    try {
        // The first write serializes the capacity check and insert. Retain only the current minute.
        $pdo->prepare('DELETE FROM ingest_request_windows WHERE window_start<>?')->execute([$window]);
        $find=$pdo->prepare('SELECT request_count FROM ingest_request_windows WHERE contributor_id=?'); $find->execute([$id]);
        $count=$find->fetchColumn();
        if ($count===false) {
            if ((int)$pdo->query('SELECT COUNT(*) FROM ingest_request_windows')->fetchColumn()>=$maxClients) $blocked=true;
            else $pdo->prepare('INSERT INTO ingest_request_windows(contributor_id,window_start,request_count) VALUES(?,?,1)')->execute([$id,$window]);
        } elseif ((int)$count>=$limit) $blocked=true;
        else $pdo->prepare('UPDATE ingest_request_windows SET request_count=request_count+1 WHERE contributor_id=?')->execute([$id]);
        $pdo->commit();
    } catch (Throwable $error) { if ($pdo->inTransaction()) $pdo->rollBack(); throw $error; }
    if ($blocked) {
        header('Retry-After: '.max(1,$window+60-time()));
        json_response(['ok'=>false,'error'=>'Indexing request limit reached. Retry shortly.'],429);
    }
}

function authenticate_writer(): void {
    // Public indexing is deliberately keyless. Ignore credentials retained by older extensions.
    if (public_ingest_enabled()) { limit_contributor_requests(public_ingest_client_id(),true); return; }
    $cfg=config(); $header=(string)($_SERVER['HTTP_AUTHORIZATION']??'');
    if (strlen($header)>2048 || !preg_match('/^Bearer\s+(\S+)$/i',$header,$m)) {
        json_response(['ok'=>false,'error'=>'Contributor key is invalid.'],401);
    }
    $token=$m[1]; $id='';
    if (str_starts_with($token,'icv1_')) {
        if (preg_match('/^icv1_([a-f0-9]{16})_[A-Za-z0-9_-]{43}$/D',$token,$parts)) {
            $entry=contributor_registry()['keys'][$parts[1]]??null;
            if (is_array($entry) && empty($entry['revoked']) &&
                hash_equals((string)($entry['sha256']??''),hash('sha256',$token))) {
                if (($entry['scope']??'')!=='catalog:submit') json_response(['ok'=>false,'error'=>'This key cannot submit catalog records.'],403);
                $id=$parts[1];
            }
        }
    } else {
        $hash=(string)($cfg['write_token_hash']??'');
        if ($hash!=='' && password_verify($token,$hash)) $id='owner';
    }
    if ($id==='') json_response(['ok'=>false,'error'=>'Contributor key is invalid or revoked.'],401);
    limit_contributor_requests($id);
}

function public_image_row(array $row): array {
    $id = (string)$row['image_id'];
    return [
        'id'=>$id, 'pageUrl'=>'https://civitai.red/images/' . rawurlencode($id),
        'previewUrl'=>($row['download_status'] === 'ready') ? 'media.php?id=' . rawurlencode($id) . '&variant=thumb' : '',
        'downloadUrl'=>($row['download_status'] === 'ready') ? 'media.php?id=' . rawurlencode($id) : '',
        'prompt'=>$row['prompt'], 'negativePrompt'=>$row['negative_prompt'],
        'tags'=>json_decode($row['tags_json'], true) ?: [], 'modelName'=>$row['model_name'],
        'loras'=>json_decode($row['loras_json'], true) ?: [], 'category'=>$row['style_category'],
        'reactions'=>json_decode($row['reactions_json'],true) ?: new stdClass(),
        'communityReactions'=>[
            'upvote'=>(int)($row['community_upvote']??0),'heart'=>(int)($row['community_heart']??0),
            'laugh'=>(int)($row['community_laugh']??0),'wow'=>(int)($row['community_wow']??0),
        ],
        'width'=>(int)$row['image_width'], 'height'=>(int)$row['image_height'],
        'confidence'=>(float)$row['style_confidence'], 'downloadStatus'=>$row['download_status'],
        'updatedAt'=>$row['updated_at'],
    ];
}
