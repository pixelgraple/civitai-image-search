<?php
declare(strict_types=1);
if (PHP_SAPI!=='cli') { http_response_code(404); exit; }
if (function_exists('posix_geteuid') && posix_geteuid()!==0) { fwrite(STDERR,"Run contributor management as the server administrator.\n"); exit(1); }
require __DIR__.'/lib.php';

try {
    $action=$argv[1]??'';
    if (!in_array($action,['create','list','revoke'],true)) throw new RuntimeException('Usage: php contributors.php create "Name" | list | revoke KEY_ID');
    $path=contributor_registry_path();
    if ($path==='' || !is_dir(dirname($path))) throw new RuntimeException('Set contributors_path to a file in the private configuration directory first.');
    $lock=fopen($path.'.lock','c');
    if (!$lock || !flock($lock,LOCK_EX)) throw new RuntimeException('Could not lock contributor registry.');
    chmod($path.'.lock',0600);
    try {
        $data=contributor_registry(); $result=[];
        if ($action==='create') {
            $label=trim((string)($argv[2]??''));
            if ($label==='' || strlen($label)>100) throw new RuntimeException('Choose a contributor label of 1 to 100 bytes.');
            if (count($data['keys'])>=1000) throw new RuntimeException('Contributor registry has reached its configured capacity.');
            do { $id=bin2hex(random_bytes(8)); } while (isset($data['keys'][$id]));
            $token='icv1_'.$id.'_'.rtrim(strtr(base64_encode(random_bytes(32)),'+/','-_'),'=');
            $data['keys'][$id]=['label'=>$label,'sha256'=>hash('sha256',$token),'scope'=>'catalog:submit','revoked'=>false,'createdAt'=>gmdate('c')];
            $result=['id'=>$id,'label'=>$label,'scope'=>'catalog:submit','token'=>$token];
        } elseif ($action==='revoke') {
            $id=(string)($argv[2]??'');
            if (!preg_match('/^[a-f0-9]{16}$/D',$id) || !isset($data['keys'][$id])) throw new RuntimeException('Contributor key ID was not found.');
            $data['keys'][$id]['revoked']=true; $data['keys'][$id]['revokedAt']=gmdate('c');
            $result=['id'=>$id,'revoked'=>true];
        } else {
            foreach ($data['keys'] as $id=>$entry) $result[]=['id'=>$id,'label'=>$entry['label']??'','scope'=>$entry['scope']??'','revoked'=>!empty($entry['revoked']),'createdAt'=>$entry['createdAt']??''];
        }
        if ($action!=='list') {
            $temporary=$path.'.'.bin2hex(random_bytes(6)).'.tmp';
            try {
                $json=json_encode($data,JSON_PRETTY_PRINT|JSON_UNESCAPED_SLASHES|JSON_THROW_ON_ERROR)."\n";
                if (file_put_contents($temporary,$json,LOCK_EX)!==strlen($json)) throw new RuntimeException('Could not save contributor registry.');
                if (!chmod($temporary,0640) || !chgrp($temporary,filegroup(dirname($path)))) throw new RuntimeException('Could not restrict contributor registry permissions.');
                if (!rename($temporary,$path)) throw new RuntimeException('Could not finalize contributor registry.');
            } finally { if (is_file($temporary)) @unlink($temporary); }
        }
        fwrite(STDOUT,json_encode($result,JSON_PRETTY_PRINT|JSON_UNESCAPED_SLASHES|JSON_THROW_ON_ERROR)."\n");
    } finally { flock($lock,LOCK_UN); fclose($lock); }
} catch (Throwable $error) { fwrite(STDERR,$error->getMessage()."\n"); exit(1); }
