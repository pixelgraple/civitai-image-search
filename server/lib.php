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
    $pdo->sqliteCreateFunction('catalog_has_pg13_term', static fn($value)=>catalog_has_pg13_term($value), 1, PDO::SQLITE_DETERMINISTIC);
    // WAL is initialized during catalog setup; do not renegotiate it on every request while the image-copy worker is writing.
    $pdo->exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    $schema=file_get_contents(__DIR__.'/schema.sql');
    if ($schema===false) throw new RuntimeException('Database schema is unavailable.');
    $pdo->exec($schema);
    // Materialized safety decisions keep the default PG-13 search fast. The
    // decision is recomputed when a record is ingested and backfilled for the
    // existing catalog; the prompt text never has to be regex-scanned during
    // every paginated search.
    $pdo->exec('CREATE TABLE IF NOT EXISTS image_pg13_safety_v2 (image_id TEXT PRIMARY KEY REFERENCES images(image_id) ON DELETE CASCADE, pg13_safe INTEGER NOT NULL CHECK(pg13_safe IN (0,1)), checked_at TEXT NOT NULL)');
    $pdo->exec('CREATE INDEX IF NOT EXISTS image_pg13_safety_v2_safe ON image_pg13_safety_v2(pg13_safe,image_id)');
    $pdo->exec('CREATE TRIGGER IF NOT EXISTS image_pg13_inputs_changed_v2 AFTER UPDATE OF prompt,tags_json,model_name,loras_json ON images
        WHEN NEW.prompt IS NOT OLD.prompt OR NEW.tags_json IS NOT OLD.tags_json OR NEW.model_name IS NOT OLD.model_name OR NEW.loras_json IS NOT OLD.loras_json
        BEGIN DELETE FROM image_pg13_safety_v2 WHERE image_id=NEW.image_id; END');
    $columns=array_column($pdo->query('PRAGMA table_info(images)')->fetchAll(),'name');
    foreach (['reactions_json'=>"TEXT NOT NULL DEFAULT '{}'",'image_width'=>'INTEGER NOT NULL DEFAULT 0','image_height'=>'INTEGER NOT NULL DEFAULT 0','creator_name'=>"TEXT NOT NULL DEFAULT ''",'source_page_url'=>"TEXT NOT NULL DEFAULT ''"] as $column=>$definition) {
        if (in_array($column,$columns,true)) continue;
        try { $pdo->exec('ALTER TABLE images ADD COLUMN '.$column.' '.$definition); }
        catch (PDOException $error) {
            $current=array_column($pdo->query('PRAGMA table_info(images)')->fetchAll(),'name');
            if (!in_array($column,$current,true)) throw $error;
        }
    }
    // Build after additive column migrations so older catalogs also upgrade safely.
    // SQLite sorts NULL scores last in DESC order; incomplete source counts stay unknown.
    $pdo->exec('CREATE INDEX IF NOT EXISTS images_civitai_reaction_order ON images('.source_reaction_score_sql().' DESC,length(image_id) DESC,image_id DESC)');
    // Cover grouped counts and name/tag predicates without reading prompt/media columns.
    $pdo->exec('CREATE INDEX IF NOT EXISTS images_search_facets ON images(style_category,creator_name,loras_json,tags_json,image_id)');
    $pdo->exec('CREATE INDEX IF NOT EXISTS images_model_facets ON images(style_category,model_name,image_id)');
    return $pdo;
}

function lower_text(string $value): string { return function_exists('mb_strtolower') ? mb_strtolower($value,'UTF-8') : strtolower($value); }

require_once __DIR__.'/pg13-policy.php';

function cut_text(string $value,int $length): string { return function_exists('mb_substr') ? mb_substr($value,0,$length,'UTF-8') : substr($value,0,$length); }
function text_length(string $value): int { return function_exists('mb_strlen') ? mb_strlen($value,'UTF-8') : (int)preg_match_all('/./us',$value); }

function json_response(array $body, int $status = 200): never {
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($body, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}

function cors_headers(): void {
    $origin=(string)($_SERVER['HTTP_ORIGIN']??'');
    $site=strtolower((string)($_SERVER['HTTP_SEC_FETCH_SITE']??''));
    $allowed=in_array($origin,['https://search-civitai.xyz','https://civitai.com','https://civitai.red','https://www.civitai.com','https://www.civitai.red'],true)
        || preg_match('~\Achrome-extension://[a-p]{32}\z~D',$origin)===1
        || preg_match('~\Amoz-extension://[a-f0-9-]{36}\z~D',$origin)===1;
    if (($origin!=='' && !$allowed) || ($origin==='' && $site==='cross-site')) {
        json_response(['ok'=>false,'error'=>'This browser origin cannot submit to the catalog.'],403);
    }
    header('Access-Control-Allow-Origin: '.($origin!==''?$origin:'*'));
    header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
    header('Access-Control-Allow-Headers: Authorization, Content-Type');
    header('Vary: Origin');
}

function json_input(): array {
    $type=strtolower(trim(explode(';',(string)($_SERVER['CONTENT_TYPE']??''))[0]));
    if ($type!=='application/json') json_response(['ok'=>false,'error'=>'Submit an application/json request.'],415);
    if ((int)($_SERVER['CONTENT_LENGTH']??0)>1048576) json_response(['ok'=>false,'error'=>'Request body too large.'],413);
    $raw = file_get_contents('php://input',false,null,0,1048577);
    if ($raw === false || strlen($raw) > 1048576) json_response(['ok'=>false,'error'=>'Request body too large.'], 413);
    $data = json_decode($raw, true, 32);
    if (!is_array($data) || array_is_list($data)) json_response(['ok'=>false,'error'=>'Expected a JSON object.'], 400);
    return $data;
}

/** Optional source labels are bounded before validation, including old clients. */
function normalize_ingest_names(mixed $item): mixed {
    if (!is_array($item) || array_is_list($item)) return $item;
    foreach (['tags','loras'] as $key) {
        if (isset($item[$key]) && is_array($item[$key]) && array_is_list($item[$key]))
            $item[$key]=normalize_strings($item[$key]);
    }
    return $item;
}
class InvalidIngestRecord extends InvalidArgumentException {
    public function __construct(string $message,public readonly string $field='record') { parent::__construct($message); }
}
/** Invalid record metadata is isolated; request/authentication limits stay enforced. */
function validate_ingest_item(mixed $item): void {
    if (!is_array($item) || array_is_list($item)) throw new InvalidIngestRecord('Each record must be an object.');
    foreach (['prompt'=>20000,'negativePrompt'=>10000,'modelName'=>300,'creatorName'=>200,'downloadUrl'=>2048,'sourceUrl'=>2048,'capturedPageUrl'=>2048] as $key=>$limit) {
        if (!isset($item[$key])) continue;
        if (!is_string($item[$key]) || strlen($item[$key])>$limit*4 || !preg_match('//u',$item[$key]) || str_contains($item[$key],"\0") || text_length($item[$key])>$limit)
            throw new InvalidIngestRecord('Invalid or oversized record field: '.$key.'.',$key);
    }
    foreach (['tags','loras'] as $key) {
        if (!isset($item[$key])) continue;
        if (!is_array($item[$key]) || !array_is_list($item[$key]) || count($item[$key])>200) throw new InvalidIngestRecord('Use a list of at most 200 '.$key.'.',$key);
        foreach ($item[$key] as $value) {
            if (is_array($value)) $value=$value['name']??null;
            if (!is_string($value) || strlen($value)>800 || !preg_match('//u',$value) || str_contains($value,"\0") || text_length($value)>200)
                throw new InvalidIngestRecord('Invalid name in '.$key.'.',$key);
        }
    }
    foreach (['width','height'] as $key) if (isset($item[$key]) && !is_int($item[$key]) && !is_float($item[$key]) && !is_string($item[$key]))
        throw new InvalidIngestRecord('Invalid image dimension.',$key);
}

function normalize_strings(mixed $value, int $limit = 200): array {
    if (!is_array($value)) return [];
    $out = [];
    foreach ($value as $item) {
        if (is_array($item)) $item = $item['name'] ?? '';
        if (!is_string($item)) continue;
        if (!preg_match('//u',$item)) continue;
        $item=preg_replace('/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/u','',$item)??'';
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

/** Keep the indexed ordering identical to source_reactions_missing(), excluding Buzz. */
function source_reaction_score_sql(string $alias=''): string {
    $column=($alias!=='' ? $alias.'.' : '').'reactions_json';
    $checks=[]; $values=[];
    foreach (['likeCount','heartCount','laughCount','cryCount'] as $key) {
        $value="json_extract($column,'$.".$key."')";
        $checks[]="json_type($column,'$.".$key."') IN ('integer','real') AND $value>=0 AND $value<=9007199254740991 AND CAST($value AS INTEGER)=$value";
        $values[]=$value;
    }
    return 'CASE WHEN json_valid('.$column.') THEN CASE WHEN '.implode(' AND ',$checks).' THEN '.implode('+',$values).' ELSE NULL END ELSE NULL END';
}

function normalize_creator_name(mixed $value): string {
    if (!is_string($value) || !preg_match('//u',$value) || preg_match('/[\x00-\x1F\x7F]/u',$value)) return '';
    return cut_text(ltrim(trim($value),'@'),200);
}

/** Recorded capture provenance must be an image page for this ID, never a CDN URL. */
function normalize_captured_page_url(mixed $value,string $id): string {
    if (!is_string($value) || !valid_image_id($id) || strlen($value)>160 ||
        !preg_match('~\Ahttps://(?:www\.)?(civitai\.(?:red|com))/images/([1-9][0-9]{0,19})/?\z~i',$value,$parts) || $parts[2]!==$id) return '';
    return 'https://'.strtolower($parts[1]).'/images/'.$id;
}

/** Query values must be strings, bounded, and valid UTF-8 before any SQL construction. */
function search_parameter(string $key,string $default='',int $maxLength=300): string {
    $value=$_GET[$key]??$default;
    if (!is_string($value) || strlen($value)>4*$maxLength || !preg_match('//u',$value) || str_contains($value,"\0") || text_length($value)>$maxLength) {
        json_response(['ok'=>false,'error'=>'Invalid or oversized search parameter: '.$key.'.'],400);
    }
    return trim($value);
}

/** Refresh source attribution and reactions without inspecting media or prompt fields. */
function update_source_reactions(PDO $pdo,array $items): array {
    $records=[]; $skipped=0;
    foreach ($items as $item) {
        if (!is_array($item) || !valid_image_id($item['id']??null)) {
            $skipped++; continue;
        }
        $id=(string)$item['id'];
        $counts=normalize_reactions($item['reactions']??null); $creator=normalize_creator_name($item['creatorName']??null);
        // Legacy pageUrl values were synthesized as .red, so only the new explicit
        // capturedPageUrl field is evidence of which site the contributor visited.
        $pageUrl=normalize_captured_page_url($item['capturedPageUrl']??null,$id);
        if (!$counts && $creator==='' && $pageUrl==='') { $skipped++; continue; }
        $records[$id]=[
            'reactions'=>array_replace($records[$id]['reactions']??[],$counts),
            'creatorName'=>$creator!=='' ? $creator : ($records[$id]['creatorName']??''),
            'capturedPageUrl'=>($records[$id]['capturedPageUrl']??'') ?: $pageUrl,
        ];
    }
    $accepted=0; $updated=0; $missingIds=[];
    if (!$records) return compact('accepted','updated','skipped','missingIds');
    $find=$pdo->prepare('SELECT reactions_json,creator_name,source_page_url FROM images WHERE image_id=?');
    $update=$pdo->prepare('UPDATE images SET reactions_json=?,creator_name=?,source_page_url=?,updated_at=? WHERE image_id=?');
    // Reserve the writer before reading counts. Upgrading a deferred WAL read
    // transaction can fail immediately under ingestion/worker writes, ignoring
    // busy_timeout and forcing otherwise valid reaction batches to retry.
    $pdo->exec('BEGIN IMMEDIATE');
    $transaction=true;
    try {
        foreach ($records as $id=>$record) {
            $id=(string)$id; $find->execute([$id]); $row=$find->fetch(); $find->closeCursor();
            if (!$row) { $missingIds[]=$id; continue; }
            $prior=normalize_reactions(json_decode($row['reactions_json'],true));
            $merged=array_replace($prior,$record['reactions']);
            $creator=(string)$row['creator_name']!=='' ? (string)$row['creator_name'] : $record['creatorName']; $accepted++;
            $pageUrl=normalize_captured_page_url($row['source_page_url']??null,$id) ?: $record['capturedPageUrl'];
            if ($merged==$prior && $creator===(string)$row['creator_name'] && $pageUrl===(string)$row['source_page_url']) continue;
            $update->execute([json_encode((object)$merged,JSON_THROW_ON_ERROR),$creator,$pageUrl,gmdate('c'),$id]); $updated++;
        }
        $pdo->exec('COMMIT'); $transaction=false;
    } catch (Throwable $error) {
        if ($transaction) $pdo->exec('ROLLBACK');
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

function download_concurrency_limit(): int {
    return max(4,min(32,(int)(config()['image_download_concurrency']??32)));
}

function valid_collection_token(mixed $token): bool {
    return is_string($token) && preg_match('/^[a-f0-9]{64}$/D',$token)===1;
}

class DownloadLaneCapacity extends RuntimeException {}

/** Caller holds a write transaction; never replace an existing tab preference on ingestion. */
function ensure_download_lane(PDO $pdo,string $key): void {
    $find=$pdo->prepare('SELECT updated_at FROM download_lanes WHERE lane_key=?'); $find->execute([$key]);
    $lastUsed=$find->fetchColumn();
    if ($lastUsed!==false) {
        if ((string)$lastUsed<gmdate('c',time()-86400)) $pdo->prepare('UPDATE download_lanes SET updated_at=? WHERE lane_key=?')->execute([gmdate('c'),$key]);
        return;
    }
    if ((int)$pdo->query('SELECT COUNT(*) FROM download_lanes')->fetchColumn()>=10000) {
        $prune=$pdo->prepare("DELETE FROM download_lanes WHERE lane_key IN (SELECT dl.lane_key FROM download_lanes dl WHERE dl.updated_at<? AND NOT EXISTS (SELECT 1 FROM image_download_lanes m JOIN images i ON i.image_id=m.image_id WHERE m.lane_key=dl.lane_key AND i.download_status='pending') ORDER BY dl.updated_at LIMIT 100)");
        $prune->execute([gmdate('c',time()-30*86400)]);
        if ((int)$pdo->query('SELECT COUNT(*) FROM download_lanes')->fetchColumn()>=10000) throw new DownloadLaneCapacity('Transfer settings capacity reached. Retry later.');
    }
    $pdo->prepare('INSERT OR IGNORE INTO download_lanes(lane_key,concurrency,updated_at) VALUES(?,32,?)')->execute([$key,gmdate('c')]);
}

/** The private worker file contains only hashed lane identifiers and bounded counters. */
function download_worker_status(): array {
    $empty=['updatedAt'=>null,'active'=>null,'limit'=>download_concurrency_limit(),'phase'=>'waiting for worker status','lanes'=>[]];
    $root=realpath((string)(config()['storage_dir']??''));
    if (!$root) return $empty;
    $path=$root.'/.download-status.json';
    if (is_link($path) || !is_file($path) || filesize($path)>1048576) return $empty;
    $state=json_decode((string)@file_get_contents($path),true);
    if (!is_array($state) || !is_numeric($state['updatedAt']??null) || (int)$state['updatedAt']<time()-20 || (int)$state['updatedAt']>time()+5) return $empty;
    $state['active']=max(0,min(32,(int)($state['active']??0)));
    $state['limit']=download_concurrency_limit();
    $state['lanes']=is_array($state['lanes']??null)?$state['lanes']:[];
    $state['phase']=cut_text((string)($state['phase']??'running'),80);
    return $state;
}

function download_status_for_tokens(PDO $pdo,array $tokens): array {
    $keys=array_map(static fn($token)=>hash('sha256',$token),$tokens); $unique=array_values(array_unique($keys));
    $slots=implode(',',array_fill(0,count($unique),'?'));
    $preferences=$pdo->prepare('SELECT lane_key,concurrency FROM download_lanes WHERE lane_key IN ('.$slots.')');
    $preferences->execute($unique); $limits=[];
    foreach ($preferences->fetchAll() as $row) $limits[$row['lane_key']]=(int)$row['concurrency'];
    $counts=$pdo->prepare("SELECT lane_key,SUM(download_status='pending') pending,SUM(download_status='ready') stored FROM image_download_lanes WHERE lane_key IN (".$slots.') GROUP BY lane_key');
    $counts->execute($unique); $totals=[];
    foreach ($counts->fetchAll() as $row) $totals[$row['lane_key']]=$row;
    $worker=download_worker_status(); $items=[];
    foreach ($keys as $index=>$key) {
        $active=$worker['active']===null?null:max(0,min(32,(int)($worker['lanes'][$key]['active']??0)));
        $items[]=['index'=>$index,'concurrency'=>$limits[$key]??32,'active'=>$active,'pending'=>(int)($totals[$key]['pending']??0),'stored'=>(int)($totals[$key]['stored']??0)];
    }
    return ['items'=>$items,'server'=>array_intersect_key($worker,array_flip(['limit','active','updatedAt','phase']))];
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

function gallery_preview_path(string $path): string {
    return preg_match('/\.(png|jpe?g|webp)$/i',$path) ? $path.'.preview-v1.webp' : '';
}

/** A separate compact cache keeps original hashes and legacy previews intact. */
function stored_gallery_preview(string $path): string {
    $preview=gallery_preview_path($path); $root=realpath((string)(config()['storage_dir']??''));
    $full=$preview===''?false:realpath($preview);
    if (!$root || !$full || !str_starts_with($full,$root.DIRECTORY_SEPARATOR) || !is_file($full) || !is_readable($full)) return '';
    $info=@getimagesize($full);
    return ($info['mime']??'')==='image/webp' && (int)($info[0]??0)>0 && (int)($info[1]??0)>0 &&
        (int)$info[0]<=720 && (int)$info[1]<=720 ? $full : '';
}

function card_preview_path(string $path): string {
    return preg_match('/\.(png|jpe?g|webp)$/i',$path) ? $path.'.card-v1.webp' : '';
}

function stored_card_preview(string $path): string {
    $preview=card_preview_path($path); $root=realpath((string)(config()['storage_dir']??''));
    $full=$preview===''?false:realpath($preview);
    if (!$root || !$full || !str_starts_with($full,$root.DIRECTORY_SEPARATOR) || !is_file($full) || !is_readable($full)) return '';
    $info=@getimagesize($full);
    return ($info['mime']??'')==='image/webp' && (int)($info[0]??0)>0 && (int)($info[1]??0)>0 &&
        (int)$info[0]<=320 && (int)$info[1]<=720 ? $full : '';
}

/** Worker/CLI only. Decode the bounded preview, never the full original. */
function build_card_preview(string $path): bool {
    if (stored_card_preview($path)!=='') return true;
    $source=stored_gallery_preview($path); $destination=card_preview_path($path);
    if ($source==='' || $destination==='' || !function_exists('imagewebp') || !function_exists('imagecreatefromwebp') ||
        realpath(dirname($destination))!==dirname($source) || filesize($source)>8*1024*1024) return false;
    $image=null; $out=null; $temporary=$destination.'.'.bin2hex(random_bytes(5)).'.tmp';
    try {
        $image=@imagecreatefromwebp($source); if (!$image) return false;
        $width=imagesx($image); $height=imagesy($image); $scale=min(1,320/$width);
        $out=imagecreatetruecolor(max(1,(int)round($width*$scale)),max(1,(int)round($height*$scale)));
        if (!$out) return false;
        imagealphablending($out,false); imagesavealpha($out,true);
        if (!imagecopyresampled($out,$image,0,0,0,0,imagesx($out),imagesy($out),$width,$height) || !imagewebp($out,$temporary,78)) return false;
        $saved=@getimagesize($temporary);
        if (($saved['mime']??'')!=='image/webp' || (int)($saved[0]??0)<1 || (int)($saved[1]??0)<1 || $saved[0]>320 || $saved[1]>720) return false;
        return chmod($temporary,0640) && rename($temporary,$destination);
    } finally {
        if ($out) imagedestroy($out); if ($image) imagedestroy($image);
        if (is_file($temporary)) @unlink($temporary);
    }
}

/** CLI/worker only: upgrade a bounded legacy thumbnail, never decode an original here. */
function upgrade_legacy_gallery_preview(string $path,string $mime): bool {
    if (stored_gallery_preview($path)!=='') return true;
    if (!function_exists('imagewebp')) return false;
    $root=realpath((string)(config()['storage_dir']??'')); $legacy=thumbnail_path($path);
    $source=$legacy===''?false:realpath($legacy); $destination=gallery_preview_path($path);
    if (!$root || !$source || $destination==='' || !str_starts_with($source,$root.DIRECTORY_SEPARATOR) ||
        realpath(dirname($destination))!==dirname($source) || !is_file($source) || !is_readable($source) || filesize($source)>8*1024*1024) return false;
    $info=@getimagesize($source); $width=(int)($info[0]??0); $height=(int)($info[1]??0);
    if (($info['mime']??'')!==$mime || $width<1 || $height<1 || max($width,$height)>4096 || $width*(float)$height>2500000) return false;
    $decoder=['image/jpeg'=>'imagecreatefromjpeg','image/png'=>'imagecreatefrompng','image/webp'=>'imagecreatefromwebp'][$mime]??'';
    if ($decoder==='' || !function_exists($decoder)) return false;
    $limit=trim((string)ini_get('memory_limit')); $memoryLimit=(float)$limit;
    if (preg_match('/([kmg])$/i',$limit,$match)) $memoryLimit*=1024**(['k'=>1,'m'=>2,'g'=>3][strtolower($match[1])]);
    $estimated=$width*(float)$height*8+720*720*8+16*1024*1024;
    if ($memoryLimit>0 && memory_get_usage(true)+$estimated>$memoryLimit) return false;
    $image=null; $out=null; $temporary=$destination.'.'.bin2hex(random_bytes(5)).'.tmp';
    try {
        $image=@$decoder($source); if (!$image) return false;
        $scale=min(1,720/max($width,$height));
        $out=imagecreatetruecolor(max(1,(int)round($width*$scale)),max(1,(int)round($height*$scale)));
        if (!$out) return false;
        imagealphablending($out,false); imagesavealpha($out,true);
        if (!imagecopyresampled($out,$image,0,0,0,0,imagesx($out),imagesy($out),$width,$height) || !imagewebp($out,$temporary,80)) return false;
        $saved=@getimagesize($temporary);
        if (($saved['mime']??'')!=='image/webp' || (int)($saved[0]??0)<1 || (int)($saved[1]??0)<1) return false;
        return chmod($temporary,0640) && rename($temporary,$destination);
    } finally {
        if ($out) imagedestroy($out); if ($image) imagedestroy($image);
        if (is_file($temporary)) @unlink($temporary);
    }
}

function valid_stored_thumbnail(string $path, string $mime): bool {
    if (stored_gallery_preview($path)!=='') return true;
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
    if (!is_string($value) || strlen($value) > 2048 || preg_match('/[\x00-\x20\x7f\\\\]/',$value) || !preg_match('//u',$value)) return null;
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

require_once __DIR__.'/ingest-limits.php';

function limit_contributor_requests(string $id, bool $public=false): void {
    $cfg=config();
    $limit=max(1,min(1200,(int)($cfg[$public?'public_ingest_requests_per_minute':'contributor_requests_per_minute']??120)));
    $maxClients=max(1,min(100000,(int)($cfg['ingest_max_active_clients']??10000)));
    $window=intdiv(time(),60)*60; $pdo=ingest_limits_db(); $blocked=false;
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
    $capturedPageUrl=normalize_captured_page_url($row['source_page_url']??null,$id);
    $sourceDomain=$capturedPageUrl!=='' ? (string)parse_url($capturedPageUrl,PHP_URL_HOST) : '';
    $sourceReactions=normalize_reactions(json_decode($row['reactions_json'],true));
    $sourceTotal=source_reactions_missing($sourceReactions) ? null : array_sum(array_intersect_key($sourceReactions,array_flip(['likeCount','heartCount','laughCount','cryCount'])));
    return [
        'id'=>$id, 'pageUrl'=>$capturedPageUrl ?: 'https://civitai.red/images/' . rawurlencode($id),
        'capturedPageUrl'=>$capturedPageUrl, 'sourceDomain'=>$sourceDomain,
        'sourceOrigin'=>$sourceDomain!=='' ? 'https://'.$sourceDomain : '',
        'previewUrl'=>($row['download_status'] === 'ready') ? 'media.php?id=' . rawurlencode($id) . '&variant=thumb&pv=1' : '',
        'downloadUrl'=>($row['download_status'] === 'ready') ? 'media.php?id=' . rawurlencode($id) : '',
        'prompt'=>$row['prompt'], 'negativePrompt'=>$row['negative_prompt'],
        'tags'=>json_decode($row['tags_json'], true) ?: [], 'modelName'=>$row['model_name'], 'creatorName'=>(string)($row['creator_name']??''),
        'loras'=>json_decode($row['loras_json'], true) ?: [], 'category'=>$row['style_category'],
        'reactions'=>json_decode($row['reactions_json'],true) ?: new stdClass(),
        'sourceReactionTotal'=>$sourceTotal,
        'communityReactions'=>[
            'upvote'=>(int)($row['community_upvote']??0),'heart'=>(int)($row['community_heart']??0),
            'laugh'=>(int)($row['community_laugh']??0),'wow'=>(int)($row['community_wow']??0),
        ],
        'width'=>(int)$row['image_width'], 'height'=>(int)$row['image_height'],
        'confidence'=>(float)$row['style_confidence'], 'downloadStatus'=>$row['download_status'],
        'updatedAt'=>$row['updated_at'],
    ];
}
