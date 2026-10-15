<?php
declare(strict_types=1);
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
require __DIR__ . '/lib.php';
$workerStarted=microtime(true);

class WorkerSourceBackoff extends RuntimeException {
    public function __construct(public readonly int $status, public readonly int $until) {
        parent::__construct('Image host requested a cooldown after HTTP '.$status.'.');
    }
}

/** Policy exclusions are terminal and do not consume network retry attempts. */
class WorkerImageSizeLimit extends RuntimeException {
    public function __construct(public readonly int $width,public readonly int $height) {
        parent::__construct(image_size_limit_message());
    }
}

function worker_retry_after_deadline(string $header, ?int $now=null): int {
    $now??=time(); $header=trim($header); $until=$now+60;
    if ($header!=='' && ctype_digit($header)) {
        // Avoid overflow while retaining even long server-requested pauses.
        $seconds=(float)$header;
        $until=$seconds>=PHP_INT_MAX-$now ? PHP_INT_MAX : $now+(int)$seconds;
    } elseif ($header!=='') {
        $parsed=strtotime($header);
        if ($parsed!==false) $until=$parsed;
    }
    return max($now+60,$until);
}

function worker_backoff_until(string $path): int {
    if (!is_file($path)) return 0;
    $length=filesize($path);
    if ($length===false || $length>2048) throw new RuntimeException('Worker cooldown state is invalid.');
    $saved=json_decode((string)file_get_contents($path),true);
    if (!is_array($saved) || !is_int($saved['until']??null) || !is_int($saved['status']??null) ||
        (($saved['status']!==429) && ($saved['status']<500 || $saved['status']>599))) {
        throw new RuntimeException('Worker cooldown state is invalid.');
    }
    return max(0,$saved['until']);
}

/** The singleton worker lock protects this small state file; no DB write is needed to pause. */
function save_worker_backoff(string $path,WorkerSourceBackoff $error): void {
    $temporary=$path.'.'.bin2hex(random_bytes(5)).'.tmp';
    $body=json_encode(['until'=>$error->until,'status'=>$error->status,'createdAt'=>time()],JSON_THROW_ON_ERROR);
    try {
        if (file_put_contents($temporary,$body,LOCK_EX)!==strlen($body)) throw new RuntimeException('Could not persist image host cooldown.');
        if (!chmod($temporary,0640) || !rename($temporary,$path)) throw new RuntimeException('Could not finalize image host cooldown.');
    } finally { if (is_file($temporary)) @unlink($temporary); }
}

/** Create one bounded streaming request; redirects are validated before reuse. */
function worker_transfer_handle(object $state,int $maxBytes): object {
    $url=safe_image_url($state->url);
    if (!$url) throw new RuntimeException('Source URL rejected.');
    $state->url=$url; $state->size=0; $state->overflow=false; $state->writeFailed=false;
    $state->sizeLimit=null; $state->headerChecked=false; $state->nextHeaderProbe=1024;
    $state->location=''; $state->retryAfter=''; $state->digest=hash_init('sha256');
    if (!ftruncate($state->file,0) || !rewind($state->file)) throw new RuntimeException('Could not reset transfer spool.');
    $ch=curl_init($url);
    curl_setopt_array($ch,[
        CURLOPT_RETURNTRANSFER=>false, CURLOPT_FOLLOWLOCATION=>false, CURLOPT_PROTOCOLS=>CURLPROTO_HTTPS,
        CURLOPT_CONNECTTIMEOUT=>8, CURLOPT_TIMEOUT=>35, CURLOPT_USERAGENT=>'CivitaiPromptLibrary/1.0',
        CURLOPT_HTTPHEADER=>['Accept: image/webp,image/png,image/jpeg;q=0.9,*/*;q=0.1'],
        CURLOPT_HEADERFUNCTION=>static function($ch,string $line) use ($state): int {
            if (stripos($line,'HTTP/')===0) { $state->location=''; $state->retryAfter=''; }
            if (stripos($line,'Location:')===0) $state->location=trim(substr($line,9));
            if (stripos($line,'Retry-After:')===0) $state->retryAfter=substr(trim(substr($line,12)),0,160);
            return strlen($line);
        },
        CURLOPT_WRITEFUNCTION=>static function($ch,string $chunk) use ($state,$maxBytes): int {
            $length=strlen($chunk);
            if ($state->size+$length>$maxBytes) { $state->overflow=true; return 0; }
            $written=fwrite($state->file,$chunk);
            if ($written!==$length) { $state->writeFailed=true; return 0; }
            hash_update($state->digest,$chunk); $state->size+=$length;
            // Image headers usually arrive in the first chunk. Probe a bounded
            // prefix so oversized files can stop before their full download.
            // Unknown/truncated headers are checked again after the transfer.
            if (!$state->headerChecked && $state->nextHeaderProbe<=262144 && $state->size>=$state->nextHeaderProbe &&
                (int)curl_getinfo($ch,CURLINFO_RESPONSE_CODE)===200) {
                $state->nextHeaderProbe=max($state->nextHeaderProbe*2,$state->size*2);
                if (!fflush($state->file)) { $state->writeFailed=true; return 0; }
                $info=@getimagesize($state->path); $width=(int)($info[0]??0); $height=(int)($info[1]??0);
                if ($width>0 && $height>0 && in_array($info['mime']??'',['image/jpeg','image/png','image/webp'],true)) {
                    $state->headerChecked=true;
                    if (image_size_exceeds_limits($width,$height)) {
                        $state->sizeLimit=new WorkerImageSizeLimit($width,$height); return 0;
                    }
                }
            }
            return $length;
        },
    ]);
    return $ch;
}

/** Publish only counters, never source URLs, prompts, or collection capabilities. */
function worker_publish_download_status(string $path,array $counts,array $limits,int $globalLimit,string $phase): void {
    $lanes=[];
    foreach ($limits as $lane=>$limit) $lanes[$lane]=['active'=>(int)($counts[$lane]??0),'limit'=>(int)$limit];
    foreach ($counts as $lane=>$active) if (!isset($lanes[$lane])) $lanes[$lane]=['active'=>(int)$active,'limit'=>$globalLimit];
    $body=json_encode(['updatedAt'=>time(),'active'=>array_sum($counts),'limit'=>$globalLimit,'lanes'=>(object)$lanes,'phase'=>$phase],JSON_THROW_ON_ERROR);
    $temporary=$path.'.'.bin2hex(random_bytes(5)).'.tmp';
    try {
        if (file_put_contents($temporary,$body,LOCK_EX)!==strlen($body) || !chmod($temporary,0640) || !rename($temporary,$path)) {
            throw new RuntimeException('Could not publish download activity.');
        }
    } finally { if (is_file($temporary)) @unlink($temporary); }
}

/**
 * Keep free transfer slots filled rather than waiting for the slowest file in a
 * wave. Admission and completion callbacks are serial; image decoding therefore
 * never multiplies with network concurrency. Completed spools are consumed at
 * once, bounding both open files and temporary disk usage by the global limit.
 */
function fetch_image_pipeline(callable $nextJob,callable $complete,callable $readLimits,int $maxBytes,string $spool,
    int $globalLimit,float $admissionDeadline,float $finishDeadline,string $statusPath): void {
    if (!function_exists('curl_multi_init')) throw new RuntimeException('PHP cURL multi is required.');
    $globalLimit=max(4,min(32,$globalLimit));
    $multi=curl_multi_init(); $states=[]; $handles=[]; $counts=[]; $limits=[]; $refreshed=0.0; $published=0.0; $phase='downloading';
    $refresh=static function(bool $force=false) use (&$refreshed,&$limits,$readLimits): void {
        $now=microtime(true);
        if ($force || $now-$refreshed>=1.0) { $limits=$readLimits(); $refreshed=$now; }
    };
    $publish=static function(bool $force=false) use (&$published,&$counts,&$limits,&$phase,$statusPath,$globalLimit): void {
        $now=microtime(true);
        if ($force || $now-$published>=1.0) {
            worker_publish_download_status($statusPath,$counts,$limits,$globalLimit,$phase); $published=$now;
        }
    };
    $release=static function(string $id) use (&$states,&$handles,&$counts,$multi): void {
        $state=$states[$id]??null;
        if (!$state) return;
        if (isset($state->handle)) {
            unset($handles[spl_object_id($state->handle)]);
            curl_multi_remove_handle($multi,$state->handle); curl_close($state->handle); unset($state->handle);
        }
        if (is_resource($state->file)) fclose($state->file);
        @unlink($state->path);
        if ($state->active) $counts[$state->lane]=max(0,($counts[$state->lane]??1)-1);
        unset($states[$id]);
    };
    try {
        $refresh(true); $publish(true);
        while (true) {
            $refresh();
            if (microtime(true)>=$finishDeadline) { $phase='finishing'; break; }
            // A lowered lane limit lets in-flight requests finish, then admits
            // replacements only when that lane is below its latest setting.
            while (count($states)<$globalLimit && microtime(true)<$admissionDeadline) {
                $refresh(); $job=$nextJob($counts,$limits);
                if ($job===null) break;
                if (microtime(true)>=$admissionDeadline) break;
                $id=(string)$job['image_id']; $lane=(string)$job['_lane'];
                $path=$spool.'/'.$id.'.'.bin2hex(random_bytes(8)).'.part'; $file=null;
                try {
                    $file=fopen($path,'x+b');
                    if (!$file || !chmod($path,0640)) throw new RuntimeException('Could not create transfer spool.');
                    $state=(object)['id'=>$id,'lane'=>$lane,'active'=>true,'job'=>$job,'url'=>(string)$job['source_url'],'path'=>$path,'file'=>$file,'redirects'=>0];
                    $states[$id]=$state; $counts[$lane]=($counts[$lane]??0)+1;
                    $ch=worker_transfer_handle($state,$maxBytes); $state->handle=$ch;
                    if (curl_multi_add_handle($multi,$ch)!==CURLM_OK) throw new RuntimeException('Could not start image transfer.');
                    $handles[spl_object_id($ch)]=$id;
                } catch (Throwable $error) {
                    if (isset($states[$id])) $release($id);
                    else { if (is_resource($file)) fclose($file); if (is_file($path)) @unlink($path); }
                    $complete($job,['error'=>$error]);
                }
            }
            $phase=microtime(true)>=$admissionDeadline?'finishing':'downloading'; $publish();
            if (!$handles) break;
            do { $code=curl_multi_exec($multi,$running); } while ($code===CURLM_CALL_MULTI_PERFORM);
            if ($code!==CURLM_OK) throw new RuntimeException('Image transfer coordinator failed.');
            $completed=[];
            while ($message=curl_multi_info_read($multi)) $completed[]=$message;
            if (!$completed) {
                if (curl_multi_select($multi,0.2)===-1) usleep(10000);
                continue;
            }
            // Inspect every response already delivered by this event-loop tick
            // before admitting replacements. A later queued 429 must not hide
            // behind an earlier successful image and allow extra starts.
            foreach ($completed as $message) {
                $completedId=$handles[spl_object_id($message['handle'])]??null;
                if ($completedId===null) continue;
                $completedStatus=(int)curl_getinfo($message['handle'],CURLINFO_RESPONSE_CODE);
                if ($completedStatus===429 || ($completedStatus>=500 && $completedStatus<=599)) {
                    $phase='cooldown';
                    throw new WorkerSourceBackoff($completedStatus,worker_retry_after_deadline($states[$completedId]->retryAfter));
                }
            }
            // Detach every finished handle before thumbnail work so network
            // activity excludes completed files waiting for serial finalization.
            foreach ($completed as &$message) {
                $ch=$message['handle']; $key=spl_object_id($ch); $id=$handles[$key]??null;
                $message['_id']=$id;
                if ($id===null) continue;
                $state=$states[$id];
                $message['_status']=(int)curl_getinfo($ch,CURLINFO_RESPONSE_CODE);
                $message['_error']=curl_error($ch);
                unset($handles[$key]);
                curl_multi_remove_handle($multi,$ch); curl_close($ch); unset($state->handle);
                $state->active=false;
                $counts[$state->lane]=max(0,($counts[$state->lane]??1)-1);
            }
            unset($message);
            $phase=$handles?'downloading':'finalizing'; $publish(true);
            // Finalize completed requests only; do not wait for other active
            // files. The next loop immediately replenishes the released slots.
            foreach ($completed as $message) {
                $id=$message['_id'];
                if ($id===null) continue;
                $state=$states[$id]; $status=$message['_status']; $transferError=$message['_error'];
                try {
                    if ($state->sizeLimit instanceof WorkerImageSizeLimit) throw $state->sizeLimit;
                    if ($state->overflow) throw new RuntimeException('Image exceeded configured size limit.');
                    if ($state->writeFailed) throw new RuntimeException('Could not write image transfer spool.');
                    if (($message['result']??CURLE_OK)!==CURLE_OK) throw new RuntimeException('Image transfer failed: '.substr($transferError,0,120));
                    if ($status>=300 && $status<400) {
                        if ($state->redirects++>=3 || $state->location==='') throw new RuntimeException('Image redirect limit or safe location missing.');
                        $location=$state->location;
                        if (str_starts_with($location,'//')) $location='https:'.$location;
                        elseif (str_starts_with($location,'/')) { $base=parse_url($state->url); $location='https://'.($base['host']??'').$location; }
                        $state->url=$location; $next=worker_transfer_handle($state,$maxBytes); $state->handle=$next;
                        if (curl_multi_add_handle($multi,$next)!==CURLM_OK) throw new RuntimeException('Could not follow image redirect.');
                        $handles[spl_object_id($next)]=$id;
                        $state->active=true; $counts[$state->lane]=($counts[$state->lane]??0)+1;
                        continue;
                    }
                    if ($status!==200) throw new RuntimeException('Image host returned HTTP '.$status.'.');
                    if ($state->size<=0) throw new RuntimeException('Image response was empty.');
                    if (!fflush($state->file)) throw new RuntimeException('Could not flush image transfer spool.');
                    $info=@getimagesize($state->path); $mime=(string)($info['mime']??'');
                    if (!in_array($mime,['image/jpeg','image/png','image/webp'],true)) throw new RuntimeException('Response was not a supported image.');
                    $width=(int)($info[0]??0); $height=(int)($info[1]??0);
                    if ($width<=0 || $height<=0) throw new RuntimeException('Image dimensions were invalid.');
                    if (image_size_exceeds_limits($width,$height)) throw new WorkerImageSizeLimit($width,$height);
                    $result=['path'=>$state->path,'mime'=>$mime,'size'=>$state->size,'sha256'=>hash_final($state->digest),'width'=>$width,'height'=>$height];
                } catch (Throwable $error) {
                    if (isset($state->handle)) {
                        curl_multi_remove_handle($multi,$state->handle); curl_close($state->handle); unset($state->handle);
                    }
                    $result=['error'=>$error];
                }
                unset($states[$id]);
                if (is_resource($state->file)) fclose($state->file);
                $publish();
                try { $complete($state->job,$result); }
                finally { if (is_file($state->path)) @unlink($state->path); }
            }
        }
        if ($phase!=='cooldown') $phase='idle';
    } catch (Throwable $error) {
        if (!($error instanceof WorkerSourceBackoff)) $phase='error';
        throw $error;
    } finally {
        foreach (array_keys($states) as $id) $release((string)$id);
        curl_multi_close($multi);
        $publish(true);
    }
}

/** Isolate oversized decoding in a tightly bounded ImageMagick subprocess. */
function worker_large_thumbnail(string $source,string $destination,string $mime): bool {
    if (!function_exists('proc_open') || !is_executable('/usr/bin/convert') || !is_executable('/usr/bin/prlimit')) return false;
    $format=['image/jpeg'=>'jpeg','image/png'=>'png','image/webp'=>'webp'][$mime]??'';
    if ($format==='') return false;
    $temporary=$destination.'.magick';
    if (!mkdir($temporary,0750)) return false;
    // ImageMagick's cache limits do not bound codec allocations. An OS address
    // space limit also contains libwebp/libpng decoder memory in the child.
    $command=['/usr/bin/prlimit','--as=671088640','--cpu=12','--','/usr/bin/convert','-limit','thread','1','-limit','memory','64MiB','-limit','map','64MiB',
        '-limit','disk','1024MiB','-limit','time','12','-limit','area','16MP',
        $format.':'.$source.'[0]','-thumbnail','720x720>','-strip','-quality','82',$format.':'.$destination];
    $process=null; $pipes=[]; $code=-1; $until=microtime(true)+13;
    try {
        $process=proc_open($command,[0=>['file','/dev/null','r'],1=>['pipe','w'],2=>['pipe','w']],$pipes,null,
            ['PATH'=>'/usr/bin:/bin','MAGICK_TEMPORARY_PATH'=>$temporary,'MAGICK_THREAD_LIMIT'=>'1','OMP_NUM_THREADS'=>'1']);
        if (!is_resource($process)) return false;
        stream_set_blocking($pipes[1],false); stream_set_blocking($pipes[2],false);
        do {
            // Drain output without retaining arbitrary image metadata in memory.
            foreach ([1,2] as $index) for ($read=0;$read<4;$read++) {
                $chunk=fread($pipes[$index],8192); if ($chunk===false || $chunk==='') break;
            }
            $state=proc_get_status($process);
            if (!$state['running']) { $code=$state['exitcode']; break; }
            if (microtime(true)>$until) { proc_terminate($process,9); break; }
            usleep(50000);
        } while (true);
        foreach ($pipes as $pipe) fclose($pipe); $pipes=[];
        $closed=proc_close($process); $process=null; if ($code<0) $code=$closed;
        if ($code!==0 || !is_file($destination)) return false;
        $info=@getimagesize($destination);
        return ($info['mime']??'')===$mime && (int)($info[0]??0)>0 && (int)($info[1]??0)>0 && (int)$info[0]<=720 && (int)$info[1]<=720;
    } finally {
        if (is_resource($process)) { proc_terminate($process,9); foreach ($pipes as $pipe) if (is_resource($pipe)) fclose($pipe); proc_close($process); }
        foreach (glob($temporary.'/*') ?: [] as $file) if (is_file($file)) @unlink($file);
        @rmdir($temporary);
    }
}

function save_thumbnail(string $source,string $destination,string $mime): void {
    // Read only image headers before GD allocates decoded pixels. Small compressed
    // PNGs can expand far beyond the worker's cgroup memory budget.
    $info=@getimagesize($source); $width=(int)($info[0]??0); $height=(int)($info[1]??0);
    if ($width<=0 || $height<=0 || ($info['mime']??'')!==$mime) throw new RuntimeException('Invalid original dimensions for thumbnail.');
    $scale=min(1,720/max(1,$width)); $outWidth=max(1,(int)round($width*$scale)); $outHeight=max(1,(int)round($height*$scale));
    $limit=trim((string)ini_get('memory_limit')); $memoryLimit=(float)$limit;
    if (preg_match('/([kmg])$/i',$limit,$match)) $memoryLimit*=1024**(['k'=>1,'m'=>2,'g'=>3][strtolower($match[1])]);
    $available=$memoryLimit>0 ? max(0,$memoryLimit-memory_get_usage(true)-32*1024*1024) : 128*1024*1024;
    $budget=min(128*1024*1024,$available);
    $estimated=$width*(float)$height*8+$outWidth*(float)$outHeight*8+16*1024*1024;
    $decoder=['image/jpeg'=>'imagecreatefromjpeg','image/png'=>'imagecreatefrompng','image/webp'=>'imagecreatefromwebp'][$mime]??'';
    if ($width>32768 || $height>32768 || $estimated>$budget || !$decoder || !function_exists($decoder)) {
        if (worker_large_thumbnail($source,$destination,$mime)) {
            fwrite(STDOUT,'thumbnail bounded conversion '.basename($source).' '.$width.'x'.$height."\n"); return;
        }
        // The validated original remains viewable even when thumbnail decoding
        // would exceed safe memory. copy() streams bytes and does not decode.
        if (!copy($source,$destination)) throw new RuntimeException('Could not copy bounded-memory thumbnail fallback.');
        fwrite(STDOUT,'thumbnail original fallback '.basename($source).' '.$width.'x'.$height."; GD memory limit protected\n"); return;
    }
    $image=@$decoder($source);
    if (!$image) { if (!copy($source,$destination)) throw new RuntimeException('Could not copy thumbnail.'); return; }
    $out=imagecreatetruecolor($outWidth,$outHeight);
    if (!$out) { imagedestroy($image); throw new RuntimeException('Could not allocate bounded thumbnail.'); }
    if ($mime==='image/png' || $mime==='image/webp') { imagealphablending($out,false); imagesavealpha($out,true); }
    imagecopyresampled($out,$image,0,0,0,0,imagesx($out),imagesy($out),$width,$height);
    if ($mime==='image/jpeg') $ok=imagejpeg($out,$destination,84); elseif ($mime==='image/png') $ok=imagepng($out,$destination,7); else $ok=imagewebp($out,$destination,82);
    imagedestroy($out); imagedestroy($image);
    if (!$ok) throw new RuntimeException('Could not encode thumbnail.');
}

function ensure_thumbnail(string $source,string $mime): void {
    if (valid_stored_thumbnail($source,$mime)) return;
    $destination=thumbnail_path($source);
    if ($destination==='') throw new RuntimeException('Invalid thumbnail path.');
    $temporary=$destination.'.'.bin2hex(random_bytes(5)).'.tmp';
    try {
        save_thumbnail($source,$temporary,$mime); chmod($temporary,0640);
        if (!rename($temporary,$destination)) throw new RuntimeException('Could not finalize thumbnail.');
    } finally { if (is_file($temporary)) @unlink($temporary); }
}

function mark_stored_ready(PDO $pdo,string $id,array $stored,int $attempt): void {
    // Recheck the actual original header for local repairs and content reuse,
    // too. Metadata may omit dimensions or describe a smaller CDN preview.
    $info=@getimagesize($stored['path']); $width=(int)($info[0]??0); $height=(int)($info[1]??0);
    if ($width<=0 || $height<=0 || ($info['mime']??'')!==$stored['mime']) throw new RuntimeException('Invalid original image dimensions.');
    if (image_size_exceeds_limits($width,$height)) throw new WorkerImageSizeLimit($width,$height);
    // Persist verified originals before thumbnail work so a failed thumbnail or
    // interrupted process can recover locally instead of fetching the bytes again.
    $pdo->prepare("UPDATE images SET file_path=?,mime_type=?,file_size=?,sha256=?,image_width=?,image_height=?,download_status='pending',download_attempts=?,download_error='',updated_at=? WHERE image_id=?")
        ->execute([$stored['path'],$stored['mime'],$stored['size'],$stored['sha256'],$width,$height,$attempt,gmdate('c'),$id]);
    ensure_thumbnail($stored['path'],$stored['mime']);
    $pdo->prepare("UPDATE images SET download_status='ready',download_error='',updated_at=? WHERE image_id=?")->execute([gmdate('c'),$id]);
    if (function_exists('remember_stored_image_verification')) remember_stored_image_verification(
        ['file_path'=>$stored['path'],'file_size'=>$stored['size'],'mime_type'=>$stored['mime'],'sha256'=>$stored['sha256']],
        ['exists'=>true,...$stored]
    );
}

function worker_image_row(PDO $pdo,string $id): ?array {
    $find=$pdo->prepare('SELECT * FROM images WHERE image_id=?');
    try { $find->execute([$id]); return $find->fetch() ?: null; }
    finally { $find->closeCursor(); }
}

function worker_record_failure(PDO $pdo,string $id,int $attempt,Throwable $error): void {
    if ($error instanceof WorkerImageSizeLimit) {
        skip_image_collection($pdo,$id,$error->width,$error->height);
        fwrite(STDOUT,"skipped {$id}: {$error->width}x{$error->height}; ".$error->getMessage()."\n"); return;
    }
    if ($error instanceof StorageLockBusy) { fwrite(STDOUT,"busy {$id}; leaving queue and attempts unchanged\n"); return; }
    if ($error instanceof PDOException && in_array(((int)($error->errorInfo[1]??0))&255,[5,6],true)) {
        fwrite(STDOUT,"database busy {$id}; leaving queue and attempts unchanged\n"); return;
    }
    $status=$attempt>=3?'failed':'pending'; $msg=substr($error->getMessage(),0,240);
    try {
        $pdo->prepare("UPDATE images SET download_status=?,download_attempts=?,download_error=?,updated_at=? WHERE image_id=? AND download_status='pending'")
            ->execute([$status,$attempt,$msg,gmdate('c'),$id]);
    } catch (PDOException $writeError) {
        if (!in_array(((int)($writeError->errorInfo[1]??0))&255,[5,6],true)) throw $writeError;
        fwrite(STDOUT,"database busy {$id}; could not record failure, leaving queue unchanged\n"); return;
    }
    fwrite(STDERR,"{$status} {$id}: {$msg}\n");
}

function worker_account_file(array &$sizes,int &$used,string $path,int $size): void {
    $used+=$size-($sizes[$path]??0); $sizes[$path]=$size;
}

$cfg=config(); $lockPath=rtrim((string)($cfg['storage_dir']??''),'/').'/.worker.lock';
if (!str_starts_with($lockPath,'/')) { fwrite(STDERR,"Invalid storage directory\n"); exit(1); }
if (!is_dir(dirname($lockPath)) && !mkdir(dirname($lockPath),0750,true) && !is_dir(dirname($lockPath))) { fwrite(STDERR,"Cannot create storage directory\n"); exit(1); }
$lock=fopen($lockPath,'c'); if (!$lock || !flock($lock,LOCK_EX|LOCK_NB)) { fwrite(STDOUT,"worker already running\n"); exit(0); }
$concurrency=download_concurrency_limit(); $statusPath=dirname($lockPath).'/.download-status.json';
$backoffPath=dirname($lockPath).'/.worker-backoff.json'; $backoffUntil=worker_backoff_until($backoffPath);
if ($backoffUntil>time()) {
    worker_publish_download_status($statusPath,[],[],$concurrency,'cooldown');
    fwrite(STDOUT,'image host cooldown active; retry in '.($backoffUntil-time())." seconds\n"); exit(0);
}
$pdo=db(); $limit=max(1,min(200,(int)($argv[1]??200))); $deadline=$workerStarted+50; $finishDeadline=$workerStarted+85;
$maxBytes=max(1048576,min(100*1024*1024,(int)($cfg['max_image_bytes']??41943040)));
$cap=max($maxBytes,(int)($cfg['storage_max_bytes']??107374182400)); $done=0;
$storage=(string)($cfg['storage_dir']??''); $root=realpath($storage);
if (!$root || !str_starts_with($storage,'/')) throw new RuntimeException('Invalid image storage root.');
$spool=$root.'/.download-tmp';
if (!is_dir($spool) && !mkdir($spool,0750,true) && !is_dir($spool)) throw new RuntimeException('Could not create transfer spool directory.');
if (realpath($spool)!==$spool) throw new RuntimeException('Transfer spool escaped configured storage root.');
// Only this singleton creates these bounded files. Recover leftovers from a
// killed process without touching originals, thumbnails, or unrelated files.
foreach (glob($spool.'/*.part') ?: [] as $orphan) {
    if (preg_match('/^[1-9][0-9]{0,19}\.[a-f0-9]{16}\.part$/D',basename($orphan)) && is_file($orphan)) @unlink($orphan);
}
$sizes=[]; $used=0;
$usage=$pdo->query("SELECT file_path,MAX(file_size) size FROM images WHERE file_path IS NOT NULL AND file_path<>'' AND file_size>0 GROUP BY file_path");
foreach ($usage->fetchAll() as $storedFile) worker_account_file($sizes,$used,(string)$storedFile['file_path'],(int)$storedFile['size']);
$usage->closeCursor();
// Take oldest work from every lane before taking its next item. The outer limit
// bounds each worker run without allowing one contributor's backlog to hide all
// other lanes. Last-served timestamps preserve fairness between worker runs.
$queue=$pdo->query("WITH ranked AS (
    SELECT i.image_id,i.discovered_at,COALESCE(m.lane_key,'') lane_key,
    ROW_NUMBER() OVER (PARTITION BY COALESCE(m.lane_key,'') ORDER BY i.discovered_at,i.image_id) lane_rank
    FROM images i LEFT JOIN image_download_lanes m ON m.image_id=i.image_id
    WHERE i.download_status='pending' AND LENGTH(TRIM(i.prompt))>0
  ) SELECT r.image_id,r.lane_key FROM ranked r LEFT JOIN download_lanes l ON l.lane_key=r.lane_key
  ORDER BY r.lane_rank,COALESCE(l.last_served_at,''),r.discovered_at,r.image_id LIMIT ".$limit)->fetchAll();
$queues=[];
foreach ($queue as $candidate) $queues[(string)$candidate['lane_key']][]=(string)$candidate['image_id'];
$laneOrder=array_keys($queues); $laneCursor=0;
$readLimits=static function() use ($pdo,$laneOrder,$concurrency): array {
    $limits=array_fill_keys($laneOrder,$concurrency);
    $keys=array_values(array_filter($laneOrder,static fn($lane)=>$lane!==''));
    if ($keys) {
        $statement=$pdo->prepare('SELECT lane_key,concurrency FROM download_lanes WHERE lane_key IN ('.implode(',',array_fill(0,count($keys),'?')).')');
        try {
            $statement->execute($keys);
            foreach ($statement->fetchAll() as $row) $limits[(string)$row['lane_key']]=min($concurrency,max(4,min(32,(int)$row['concurrency'])));
        } finally { $statement->closeCursor(); }
    }
    return $limits;
};
$lastServed=$pdo->prepare('UPDATE download_lanes SET last_served_at=? WHERE lane_key=?');
$nextJob=static function(array $active,array $limits) use (&$queues,&$laneCursor,$laneOrder,$pdo,$deadline,&$sizes,&$used,&$done,$lastServed): ?array {
    $laneCount=count($laneOrder);
    while ($laneCount && microtime(true)<$deadline) {
        $chosen=null;
        for ($checked=0;$checked<$laneCount;$checked++) {
            $index=($laneCursor+$checked)%$laneCount; $lane=(string)$laneOrder[$index];
            if (empty($queues[$lane]) || ($active[$lane]??0)>=($limits[$lane]??4)) continue;
            $chosen=$lane; $laneCursor=($index+1)%$laneCount; break;
        }
        if ($chosen===null) return null;
        $id=array_shift($queues[$chosen]); $imageLocks=[]; $attempt=0; $localRepair=false;
        try {
            $imageLocks=lock_image_ids([$id],0.0); $item=worker_image_row($pdo,$id);
            if (!$item || $item['download_status']!=='pending' || !has_positive_prompt((string)$item['prompt'])) continue;
            if ($chosen!=='') {
                try { $lastServed->execute([gmdate('c'),$chosen]); }
                catch (PDOException $error) { if (!in_array(((int)($error->errorInfo[1]??0))&255,[5,6],true)) throw $error; }
            }
            if (image_size_exceeds_limits($item['image_width']??0,$item['image_height']??0)) {
                throw new WorkerImageSizeLimit((int)($item['image_width']??0),(int)($item['image_height']??0));
            }
            $attempt=(int)$item['download_attempts']; $stored=inspect_stored_image($item);
            if ($stored['exists']) {
                worker_account_file($sizes,$used,$stored['path'],$stored['size']); $localRepair=true;
                mark_stored_ready($pdo,$id,$stored,$attempt); $done++;
                fwrite(STDOUT,"reused {$id} verified SHA256; no network download\n");
            } else { $item['_lane']=$chosen; return $item; }
        } catch (Throwable $error) { worker_record_failure($pdo,$id,$attempt+($localRepair?1:0),$error); }
        finally { unlock_image_ids($imageLocks); }
    }
    return null;
};
$complete=static function(array $job,array $result) use ($pdo,$finishDeadline,&$sizes,&$used,&$done,$cap,$root): void {
    $id=(string)$job['image_id']; $imageLocks=[]; $attempt=(int)$job['download_attempts'];
    try {
        // No new thumbnail begins after 85 seconds. Its bounded 13-second
        // subprocess still fits within the service's 100-second hard timeout.
        if (microtime(true)>=$finishDeadline && !(($result['error']??null) instanceof WorkerImageSizeLimit)) {
            fwrite(STDOUT,"worker deadline {$id}; leaving queue and attempts unchanged\n"); return;
        }
        $imageLocks=lock_image_ids([$id],0.0); $current=worker_image_row($pdo,$id);
        if (!$current || $current['download_status']!=='pending' || !has_positive_prompt((string)$current['prompt'])) return;
        if ((string)$current['source_url']!==(string)$job['source_url']) { fwrite(STDOUT,"source changed {$id}; leaving queue and attempts unchanged\n"); return; }
        if (image_size_exceeds_limits($current['image_width']??0,$current['image_height']??0)) {
            throw new WorkerImageSizeLimit((int)($current['image_width']??0),(int)($current['image_height']??0));
        }
        $attempt=max($attempt,(int)$current['download_attempts'])+1;
        if (isset($result['error'])) throw $result['error'];
        $mime=$result['mime']; $digest=$result['sha256']; $size=(int)$result['size'];
        $donors=$pdo->prepare("SELECT * FROM images WHERE sha256=? AND download_status='ready' AND image_id<>? ORDER BY image_id LIMIT 20");
        $donors->execute([$digest,$id]); $candidates=$donors->fetchAll(); $donors->closeCursor();
        foreach ($candidates as $donor) {
            $shared=inspect_stored_image($donor);
            if (!$shared['exists'] || $shared['sha256']!==$digest || $shared['mime']!==$mime) continue;
            worker_account_file($sizes,$used,$shared['path'],$shared['size']);
            mark_stored_ready($pdo,$id,$shared,$attempt); $done++;
            fwrite(STDOUT,"ready {$id} reused existing content SHA256 {$digest}\n"); return;
        }
        $dir=$root.'/images/'.substr($id,-2).'/'.substr($id,-4,-2);
        if (!is_dir($dir) && !mkdir($dir,0750,true) && !is_dir($dir)) throw new RuntimeException('Could not create image directory.');
        $resolved=realpath($dir);
        if (!$resolved || !str_starts_with($resolved,$root.DIRECTORY_SEPARATOR)) throw new RuntimeException('Image directory escaped configured storage root.');
        $ext=['image/jpeg'=>'jpg','image/png'=>'png','image/webp'=>'webp'][$mime]; $path=$resolved.'/'.$id.'.'.$ext;
        if ($used-($sizes[$path]??0)+$size>$cap) throw new RuntimeException('Image would exceed configured storage cap.');
        if (!rename($result['path'],$path)) throw new RuntimeException('Could not finalize image file.');
        worker_account_file($sizes,$used,$path,$size);
        mark_stored_ready($pdo,$id,['path'=>$path,'mime'=>$mime,'size'=>$size,'sha256'=>$digest],$attempt); $done++;
        fwrite(STDOUT,"ready {$id} {$size} bytes\n");
    } catch (Throwable $error) { worker_record_failure($pdo,$id,$attempt,$error); }
    finally { unlock_image_ids($imageLocks); }
};
fwrite(STDOUT,'download concurrency '.$concurrency.'; fair rolling lanes '.count($laneOrder).'; bounded spool; storage usage '.$used." bytes\n");
try { fetch_image_pipeline($nextJob,$complete,$readLimits,$maxBytes,$spool,$concurrency,$deadline,$finishDeadline,$statusPath); }
catch (WorkerSourceBackoff $error) {
    save_worker_backoff($backoffPath,$error);
    fwrite(STDOUT,'image host HTTP '.$error->status.'; paused until '.gmdate('c',$error->until)."; unfinished queue and attempts unchanged\n");
}
fwrite(STDOUT,"processed {$done}/".count($queue)." ready\n");
