<?php
declare(strict_types=1);

const COMMUNITY_REACTION_TYPES = ['upvote','heart','laugh','wow'];
const COMMUNITY_VISITOR_COOKIE = '__Host-index_civitai_visitor';
const COMMUNITY_VISITOR_TTL = 31536000;

/** Identity is signed by a private database secret; arbitrary client cookie values cannot vote. */
function community_reaction_secret(PDO $pdo): string {
    $find=$pdo->prepare("SELECT setting_value FROM community_reaction_settings WHERE setting_key='signing_secret_v1'");
    $find->execute(); $secret=$find->fetchColumn(); $find->closeCursor();
    if ($secret===false) {
        $pdo->prepare("INSERT OR IGNORE INTO community_reaction_settings(setting_key,setting_value) VALUES('signing_secret_v1',?)")
            ->execute([bin2hex(random_bytes(32))]);
        $find->execute(); $secret=$find->fetchColumn(); $find->closeCursor();
    }
    if (!is_string($secret) || preg_match('/^[a-f0-9]{64}$/D',$secret)!==1) throw new RuntimeException('Community reaction signing configuration is invalid.');
    return $secret;
}

function community_reaction_origin(): string {
    $origin=rtrim((string)(config()['public_origin']??'https://search-civitai.xyz'),'/');
    if (preg_match('~^https?://[a-z0-9.-]+(?::[0-9]{1,5})?$~iD',$origin)!==1) throw new RuntimeException('Community reaction origin is invalid.');
    return strtolower($origin);
}

function community_reaction_check_origin(string $method): void {
    header('Vary: Origin, Sec-Fetch-Site');
    header('X-Content-Type-Options: nosniff');
    $origin=(string)($_SERVER['HTTP_ORIGIN']??'');
    $fetchSite=strtolower((string)($_SERVER['HTTP_SEC_FETCH_SITE']??''));
    if (!in_array($fetchSite,['','same-origin','none'],true) ||
        ($origin!=='' && strtolower($origin)!==community_reaction_origin()) ||
        ($method==='POST' && $origin==='')) {
        json_response(['ok'=>false,'error'=>'Reactions must be submitted from this library.'],403);
    }
}

function community_reaction_visitor(string $secret): ?array {
    $cookie=$_COOKIE[COMMUNITY_VISITOR_COOKIE]??null;
    if (!is_string($cookie) || preg_match('/^([a-f0-9]{64})([a-f0-9]{8})([a-f0-9]{64})$/D',$cookie,$parts)!==1) return null;
    $expires=(int)hexdec($parts[2]);
    if ($expires<=time() || $expires>time()+COMMUNITY_VISITOR_TTL+60 ||
        !hash_equals(hash_hmac('sha256','visitor-v1:'.$parts[1].$parts[2],$secret),$parts[3])) return null;
    return ['hash'=>hash('sha256',$parts[1]),'csrf'=>hash_hmac('sha256','csrf-v1:'.$cookie,$secret)];
}

function community_reaction_new_visitor(string $secret): array {
    $random=bin2hex(random_bytes(32)); $expires=time()+COMMUNITY_VISITOR_TTL;
    $payload=$random.sprintf('%08x',$expires);
    $cookie=$payload.hash_hmac('sha256','visitor-v1:'.$payload,$secret);
    setcookie(COMMUNITY_VISITOR_COOKIE,$cookie,[
        'expires'=>$expires,'path'=>'/','secure'=>true,'httponly'=>true,'samesite'=>'Lax',
    ]);
    return ['hash'=>hash('sha256',$random),'csrf'=>hash_hmac('sha256','csrf-v1:'.$cookie,$secret)];
}

/** Rotate the keyed quota identifier daily; never persist raw addresses or trust forwarding headers. */
function community_reaction_client_key(string $secret): string {
    $packed=@inet_pton((string)($_SERVER['REMOTE_ADDR']??''));
    if ($packed===false) throw new RuntimeException('A valid client address is required for reactions.');
    if (strlen($packed)===16 && substr($packed,0,12)===str_repeat("\0",10)."\xff\xff") $packed=substr($packed,12);
    return hash_hmac('sha256','reaction-address:'.gmdate('Y-m-d').':'.$packed,$secret);
}

function community_reaction_limit(string $name,int $default,int $maximum): int {
    return max(1,min($maximum,(int)(config()[$name]??$default)));
}

/** Hold one SQLite write transaction for quotas and the resulting vote, including its count snapshot. */
function community_reaction_limited(PDO $pdo,array $buckets,callable $operation): mixed {
    $now=time(); $blockedUntil=0; $result=null;
    $pdo->exec('BEGIN IMMEDIATE');
    try {
        $pdo->prepare('DELETE FROM community_reaction_windows WHERE expires_at<=?')->execute([$now]);
        $maxBuckets=community_reaction_limit('reaction_max_rate_buckets',20000,100000);
        $active=(int)$pdo->query('SELECT COUNT(*) FROM community_reaction_windows')->fetchColumn();
        $find=$pdo->prepare('SELECT request_count,expires_at FROM community_reaction_windows WHERE bucket_key=?');
        $increment=$pdo->prepare('INSERT INTO community_reaction_windows(bucket_key,expires_at,request_count) VALUES(?,?,1) ON CONFLICT(bucket_key) DO UPDATE SET request_count=request_count+1');
        foreach ($buckets as [$key,$seconds,$limit]) {
            $end=(intdiv($now,$seconds)+1)*$seconds;
            $find->execute([$key]); $row=$find->fetch(); $find->closeCursor();
            if (($row && (int)$row['request_count']>=$limit) || (!$row && $active>=$maxBuckets)) {
                $blockedUntil=max($blockedUntil,$row ? (int)$row['expires_at'] : $now+60);
                break;
            }
            $increment->execute([$key,$end]);
            if (!$row) $active++;
        }
        if ($blockedUntil) $pdo->exec('ROLLBACK');
        else { $result=$operation(); $pdo->exec('COMMIT'); }
    } catch (Throwable $error) {
        // BEGIN IMMEDIATE is issued explicitly so use matching SQL transaction control.
        try { $pdo->exec('ROLLBACK'); } catch (Throwable) {}
        throw $error;
    }
    if ($blockedUntil) {
        header('Retry-After: '.max(1,$blockedUntil-time()));
        json_response(['ok'=>false,'error'=>'Reaction limit reached. Please wait before trying again.'],429);
    }
    return $result;
}

function community_reaction_result(PDO $pdo,string $id,array $visitor): array {
    $counts=array_fill_keys(COMMUNITY_REACTION_TYPES,0); $mine=array_fill_keys(COMMUNITY_REACTION_TYPES,false);
    $find=$pdo->prepare('SELECT upvote,heart,laugh,wow FROM community_reaction_counts WHERE image_id=?');
    $find->execute([$id]); $row=$find->fetch();
    if ($row) foreach (COMMUNITY_REACTION_TYPES as $type) $counts[$type]=(int)$row[$type];
    $find=$pdo->prepare('SELECT reaction_type FROM community_reactions WHERE image_id=? AND visitor_hash=?');
    $find->execute([$id,$visitor['hash']]);
    foreach ($find->fetchAll(PDO::FETCH_COLUMN) as $type) $mine[$type]=true;
    return ['ok'=>true,'imageId'=>$id,'counts'=>$counts,'mine'=>$mine,'csrfToken'=>$visitor['csrf']];
}

function community_reaction_input(): array {
    if (!preg_match('~^application/json(?:\s*;|$)~i',(string)($_SERVER['CONTENT_TYPE']??''))) {
        json_response(['ok'=>false,'error'=>'Reactions require a JSON request.'],415);
    }
    if ((int)($_SERVER['CONTENT_LENGTH']??0)>4096) json_response(['ok'=>false,'error'=>'Reaction request is too large.'],413);
    $stream=fopen('php://input','rb'); $raw=$stream===false ? false : stream_get_contents($stream,4097);
    if (is_resource($stream)) fclose($stream);
    if ($raw===false || strlen($raw)>4096) json_response(['ok'=>false,'error'=>'Reaction request is too large.'],413);
    $data=json_decode($raw,true);
    if (!is_array($data) || array_is_list($data)) json_response(['ok'=>false,'error'=>'Expected a reaction object.'],400);
    return $data;
}

function community_reactions_request(): never {
    $method=(string)($_SERVER['REQUEST_METHOD']??'');
    if (!in_array($method,['GET','POST'],true)) {
        header('Allow: GET, POST'); json_response(['ok'=>false,'error'=>'Method not allowed.'],405);
    }
    community_reaction_check_origin($method);
    $body=$method==='POST' ? community_reaction_input() : [];
    $id=$method==='POST' ? ($body['id']??null) : ($_GET['id']??null);
    if (!valid_image_id($id)) json_response(['ok'=>false,'error'=>'A valid image ID is required.'],400);
    $id=(string)$id;
    if ($method==='POST' && (!in_array($body['type']??null,COMMUNITY_REACTION_TYPES,true) || !is_bool($body['active']??null))) {
        json_response(['ok'=>false,'error'=>'Choose a supported reaction and a true or false active state.'],400);
    }
    $pdo=db(); $find=$pdo->prepare('SELECT 1 FROM images WHERE image_id=?'); $find->execute([$id]);
    $known=$find->fetchColumn()!==false; $find->closeCursor();
    // Release this implicit read snapshot before another request commits and we acquire the
    // write transaction. Keeping a one-row SELECT cursor open can cause SQLITE_BUSY_SNAPSHOT.
    if (!$known) json_response(['ok'=>false,'error'=>'Image not found.'],404);
    // Invalid and unknown images never mint identities, secrets or quota rows.
    $secret=community_reaction_secret($pdo); $visitor=community_reaction_visitor($secret);
    if ($method==='GET') {
        if (!$visitor) {
            community_reaction_limited($pdo,[['identity:'.community_reaction_client_key($secret),3600,community_reaction_limit('reaction_identities_per_hour',20,1000)]],static fn()=>null);
            $visitor=community_reaction_new_visitor($secret);
        }
        $pdo->beginTransaction();
        try { $result=community_reaction_result($pdo,$id,$visitor); $pdo->commit(); }
        catch (Throwable $error) { if ($pdo->inTransaction()) $pdo->rollBack(); throw $error; }
        json_response($result);
    }
    if (!$visitor || !is_string($body['csrfToken']??null) || !hash_equals($visitor['csrf'],$body['csrfToken'])) {
        json_response(['ok'=>false,'error'=>'Your reaction session expired. Reopen the image and try again.'],403);
    }
    $result=community_reaction_limited($pdo,[
        ['write-visitor:'.$visitor['hash'],60,community_reaction_limit('reaction_writes_per_minute',60,600)],
        ['write-address:'.community_reaction_client_key($secret),60,community_reaction_limit('reaction_ip_writes_per_minute',120,1200)],
    ],static function() use ($pdo,$id,$body,$visitor): array {
        if ($body['active']) {
            $pdo->prepare('INSERT OR IGNORE INTO community_reactions(image_id,visitor_hash,reaction_type,created_at) VALUES(?,?,?,?)')
                ->execute([$id,$visitor['hash'],$body['type'],time()]);
        } else {
            $pdo->prepare('DELETE FROM community_reactions WHERE image_id=? AND visitor_hash=? AND reaction_type=?')
                ->execute([$id,$visitor['hash'],$body['type']]);
        }
        return community_reaction_result($pdo,$id,$visitor);
    });
    json_response($result);
}
