<?php
// Appended to a rewritten isolated worker by Python. No request leaves the host.
function fixture_curl_init($url) { return (object)['url'=>$url,'options'=>[],'status'=>200,'completed'=>false,'result'=>CURLE_OK]; }
function fixture_curl_setopt_array($handle,$options) { $handle->options=$options; return true; }
function fixture_curl_getinfo($handle,$option) { return $handle->status; }
function fixture_curl_error($handle) { return $handle->result===CURLE_OK?'':'fixture write rejected'; }
function fixture_curl_close($handle) {}
function fixture_curl_multi_init() { return (object)['handles'=>[],'messages'=>[]]; }
function fixture_curl_multi_add_handle($multi,$handle) {
    $multi->handles[spl_object_id($handle)]=$handle;
    $GLOBALS['fixturePeak']=max($GLOBALS['fixturePeak']??0,count($multi->handles));
    return CURLM_OK;
}
function fixture_curl_multi_remove_handle($multi,$handle) { unset($multi->handles[spl_object_id($handle)]); return CURLM_OK; }
function fixture_curl_multi_select($multi,$timeout) { return 1; }
function fixture_curl_multi_info_read($multi) { return array_shift($multi->messages) ?: false; }
function fixture_curl_multi_close($multi) {
    $path=getenv('FIXTURE_META_LOG');
    if ($path) file_put_contents($path,json_encode(['peak'=>$GLOBALS['fixturePeak']??0,'networkLocksReleased'=>$GLOBALS['fixtureLocksReleased']??true]));
}
function fixture_curl_multi_exec($multi,&$running) {
    $scenario=(string)getenv('FIXTURE_SCENARIO');
    if ($scenario==='busy-during-transfer') { $error=new PDOException('fixture database busy'); $error->errorInfo=['HY000',5,'fixture']; throw $error; }
    if ($scenario==='busy-recording-error') {
        $writer=new PDO('sqlite:'.config()['database_path']); $writer->exec('BEGIN IMMEDIATE');
        $GLOBALS['fixtureHeldWriter']=$writer; throw new RuntimeException('fixture source failure');
    }
    foreach ($multi->handles as $handle) {
        if ($handle->completed) continue;
        $handle->completed=true;
        preg_match('~/([0-9]+)(?:\.png)?(?:\?.*)?$~',$handle->url,$match); $id=(string)($match[1]??'41');
        if ($scenario==='write-during-transfer' || $scenario==='source-changed') {
            $writer=new PDO('sqlite:'.config()['database_path']); $writer->setAttribute(PDO::ATTR_ERRMODE,PDO::ERRMODE_EXCEPTION);
            $writer->exec("UPDATE images SET updated_at='concurrent-writer' WHERE image_id='42'");
            if ($scenario==='source-changed') $writer->exec("UPDATE images SET source_url='https://image.civitai.com/changed.png' WHERE image_id='41'");
        }
        $locks=lock_image_ids([$id],0.01); unlock_image_ids($locks); $GLOBALS['fixtureLocksReleased']=true;
        if ($path=getenv('FIXTURE_CALL_LOG')) file_put_contents($path,"called\n",FILE_APPEND);
        $handle->status=(int)(getenv('FIXTURE_HTTP_STATUS')?:200);
        $options=$handle->options;
        $options[CURLOPT_HEADERFUNCTION]($handle,'HTTP/2 '.$handle->status."\r\n");
        $options[CURLOPT_HEADERFUNCTION]($handle,'Retry-After: '.getenv('FIXTURE_RETRY_AFTER')."\r\n");
        if (str_starts_with($scenario,'redirect-') && ($scenario!=='redirect-safe' || !str_contains($handle->url,'/redirected/'))) {
            $handle->status=302;
            $location=$scenario==='redirect-unsafe' ? 'https://127.0.0.1/private' : 'https://image.civitai.com/redirected/'.$id.'.png';
            $options[CURLOPT_HEADERFUNCTION]($handle,'Location: '.$location."\r\n");
        } elseif ($handle->status===200) {
            $bytes=base64_decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=');
            if ($scenario==='overflow') $bytes=str_repeat('x',1048577);
            if ($scenario==='invalid-image') $bytes='<html>Not image bytes</html>';
            if ($scenario==='storage-cap') $bytes.=str_pad($id,600000,'x');
            if ($scenario==='oversized-header') {
                // Valid PNG IHDR advertising a dangerous decoded size; never decode it.
                $width=30000; $height=30000; $payload=pack('NNCCCCC',$width,$height,8,2,0,0,0);
                $bytes="\x89PNG\r\n\x1a\n".pack('N',13).'IHDR'.$payload.pack('N',crc32('IHDR'.$payload)).pack('N',0).'IEND'.pack('N',crc32('IEND'));
            }
            $written=$options[CURLOPT_WRITEFUNCTION]($handle,$bytes);
            if ($written!==strlen($bytes)) $handle->result=CURLE_WRITE_ERROR;
        }
        $multi->messages[]=['handle'=>$handle,'result'=>$handle->result,'msg'=>CURLMSG_DONE];
    }
    $running=0; return CURLM_OK;
}
