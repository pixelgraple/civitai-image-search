<?php
declare(strict_types=1);
if (PHP_SAPI!=='cli') { http_response_code(404); exit; }
require __DIR__.'/lib.php';
require __DIR__.'/popular-library.php';
ini_set('memory_limit','768M');
$dir=popular_cache_directory();
if (!is_dir($dir) && !mkdir($dir,0750,true) && !is_dir($dir)) throw new RuntimeException('Cannot create ranking cache.');
$lock=fopen($dir.'/rebuild.lock','c');
if (!$lock || !flock($lock,LOCK_EX|LOCK_NB)) { echo "Another ranking rebuild is active.\n"; exit; }
$started=time();
$groups=['all'=>['users'=>[],'models'=>[],'loras'=>[]],'safe'=>['users'=>[],'models'=>[],'loras'=>[]]];
$counts=['all'=>0,'safe'=>0];
$pdo=popular_read_database();
$rows=$pdo->query('SELECT i.image_id,i.creator_name,i.model_name,i.loras_json,i.reactions_json,i.download_status,
    COALESCE(s.pg13_safe,0) pg13_safe FROM images i
    LEFT JOIN image_pg13_safety_v2 s ON s.image_id=i.image_id
    WHERE NOT EXISTS (SELECT 1 FROM image_collection_skips sk WHERE sk.image_id=i.image_id)
    ORDER BY i.rowid');
foreach ($rows as $row) {
    if (!valid_image_id((string)$row['image_id'])) continue;
    [$score,$known]=popular_reaction_data($row['reactions_json']);
    $creator=normalize_creator_name($row['creator_name']);
    $model=popular_name($row['model_name']);
    $names=[]; $loras=json_decode($row['loras_json'],true);
    if (is_array($loras)) foreach ($loras as $lora) {
        $name=popular_name($lora,200);
        if ($name!=='') $names[lower_text($name)]=$name;
    }
    $scopes=(int)$row['pg13_safe']===1?['all','safe']:['all'];
    foreach ($scopes as $scope) {
        $counts[$scope]++;
        if ($creator!=='') popular_add($groups[$scope]['users'],$creator,$creator,$row,$score,$known);
        if ($model!=='') popular_add($groups[$scope]['models'],$model,$creator,$row,$score,$known);
        foreach ($names as $name) popular_add($groups[$scope]['loras'],$name,$creator,$row,$score,$known);
    }
}
$rows->closeCursor(); $pdo=null;
$snapshot=['version'=>POPULAR_CACHE_VERSION,'policyVersion'=>PG13_POLICY_VERSION,'generatedAt'=>time(),'scopes'=>[]];
foreach ($groups as $scope=>$types) {
    $snapshot['scopes'][$scope]=['catalogImages'=>$counts[$scope]];
    foreach ($types as $type=>$entries) $snapshot['scopes'][$scope][$type]=popular_rank($entries,$type,$scope==='safe');
}
$encoded=json_encode($snapshot,JSON_THROW_ON_ERROR|JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES);
$temp=$dir.'/.rankings-'.bin2hex(random_bytes(6));
try {
    if (file_put_contents($temp,$encoded,LOCK_EX)!==strlen($encoded)) throw new RuntimeException('Could not write rankings.');
    chmod($temp,0640);
    if (!rename($temp,$dir.'/rankings-v1.json')) throw new RuntimeException('Could not publish rankings.');
} finally { if (is_file($temp)) unlink($temp); }
$summary=[];
foreach ($snapshot['scopes'] as $scope=>$data) $summary[$scope]=[
    'images'=>$data['catalogImages'],'qualifyingUsers'=>$data['users']['total'],
    'models'=>$data['models']['total'],'loras'=>$data['loras']['total'],
];
echo json_encode(['ok'=>true,'elapsedSeconds'=>time()-$started,'scopes'=>$summary]).PHP_EOL;
