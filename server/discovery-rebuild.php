<?php
declare(strict_types=1);
if (PHP_SAPI!=='cli') { http_response_code(404);exit; }
require __DIR__.'/lib.php';
require __DIR__.'/discovery-library.php';
ini_set('memory_limit','512M');
$dir=dirname(discovery_path());
if (!is_dir($dir) && !mkdir($dir,0750,true)) throw new RuntimeException('Cannot create discovery cache.');
$lock=fopen($dir.'/rebuild.lock','c');
if (!$lock || !flock($lock,LOCK_EX|LOCK_NB)) exit("A discovery rebuild is already running.\n");
$temp=$dir.'/.build-'.bin2hex(random_bytes(6)).'.sqlite'; $started=time();
try {
 $out=new PDO('sqlite:'.$temp,null,null,[PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION]);
 $out->exec("PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA cache_size=-65536;
 CREATE TABLE image_meta(image_id TEXT PRIMARY KEY,safe INTEGER,ready INTEGER,score INTEGER);
 CREATE TABLE members(kind TEXT,key TEXT,image_id TEXT,PRIMARY KEY(kind,key,image_id)) WITHOUT ROWID;
 CREATE TABLE labels(kind TEXT,key TEXT,name TEXT,search_name TEXT,payload TEXT,safe_name INTEGER,PRIMARY KEY(kind,key)) WITHOUT ROWID;
 CREATE TABLE entries(scope INTEGER,kind TEXT,key TEXT,name TEXT,search_name TEXT,payload TEXT,image_count INTEGER,score INTEGER,PRIMARY KEY(scope,kind,key)) WITHOUT ROWID;
 CREATE TABLE metadata(version INTEGER,policy INTEGER,built_at INTEGER);");
 $im=$out->prepare('INSERT INTO image_meta VALUES(?,?,?,?)');
 $mem=$out->prepare('INSERT OR IGNORE INTO members VALUES(?,?,?)');
 $label=$out->prepare('INSERT OR IGNORE INTO labels VALUES(?,?,?,?,?,?)');
 $seen=[];$count=0;
 $out->beginTransaction();
 $source=popular_read_database();
 $rows=$source->query("SELECT i.image_id,i.prompt,i.tags_json,i.creator_name,i.model_name,i.loras_json,i.reactions_json,i.download_status,COALESCE(s.pg13_safe,0) safe FROM images i LEFT JOIN image_pg13_safety_v2 s ON s.image_id=i.image_id WHERE NOT EXISTS(SELECT 1 FROM image_collection_skips sk WHERE sk.image_id=i.image_id)");
 foreach ($rows as $r) {
  $id=(string)$r['image_id']; if (!valid_image_id($id)) continue;
  [$score]=popular_reaction_data($r['reactions_json']);
  $im->execute([$id,(int)$r['safe'],$r['download_status']==='ready'?1:0,$score]);
  $model=popular_name($r['model_name']);$creator=normalize_creator_name($r['creator_name']);
  $loras=[];foreach ((json_decode($r['loras_json'],true)?:[]) as $n) { $n=popular_name($n,200);if ($n!=='') $loras[lower_text($n)]=$n; }
  ksort($loras,SORT_STRING);$loras=array_values($loras);
  $terms=discovery_terms($r['prompt'],json_decode($r['tags_json'],true)?:[]);
  if ($model!=='') $terms[]=['models',lower_text($model),$model];
  if ($creator!=='') $terms[]=['creators',lower_text($creator),$creator];
  foreach ($loras as $n) $terms[]=['loras',lower_text($n),$n];
  $recipe=discovery_recipe($model,$loras);
  if ($recipe!=='') $terms[]=['recipes',$recipe,$model.' + '.count($loras).' LoRA'.(count($loras)===1?'':'s'),['model'=>$model,'loras'=>$loras]];
  foreach ($terms as $t) {
   [$kind,$key,$name]=$t;$payload=$t[3]??[];
   $mem->execute([$kind,$key,$id]);$identity=$kind.':'.$key;
   if (!isset($seen[$identity])) {
    $search=$kind==='recipes'?$model.' '.implode(' ',$loras):$name;
    $safeName=pg13_safe_for_fields('portrait',[],$search,[])?1:0;
    $label->execute([$kind,$key,$name,lower_text($search),json_encode($payload,JSON_UNESCAPED_UNICODE|JSON_THROW_ON_ERROR),$safeName]);$seen[$identity]=true;
   }
  }
  $count++;
  if ($count%5000===0) { $out->commit();$out->beginTransaction(); }
 }
 $rows->closeCursor();$source=null;$out->commit();unset($seen);
 $out->exec('CREATE INDEX member_image ON members(image_id,kind,key); CREATE INDEX image_safe ON image_meta(safe,image_id);');
 foreach ([0,1] as $scope) {
  $out->exec("INSERT INTO entries SELECT $scope,m.kind,m.key,l.name,l.search_name,l.payload,COUNT(*),SUM(i.score) FROM members m JOIN image_meta i ON i.image_id=m.image_id JOIN labels l ON l.kind=m.kind AND l.key=m.key ".($scope?'WHERE i.safe=1 AND l.safe_name=1 ':'')."GROUP BY m.kind,m.key");
 }
 $out->exec('CREATE INDEX entry_rank ON entries(scope,kind,image_count DESC,score DESC,key);');
 $s=$out->prepare('INSERT INTO metadata VALUES(?,?,?)');$s->execute([DISCOVERY_VERSION,PG13_POLICY_VERSION,time()]);
 $entries=(int)$out->query('SELECT COUNT(*) FROM entries')->fetchColumn();
 $out->exec('ANALYZE; PRAGMA optimize;');$s=null;$im=null;$mem=null;$label=null;$out=null;
 chmod($temp,0640);
 if (!rename($temp,discovery_path())) throw new RuntimeException('Cannot publish discovery cache.');
 echo json_encode(['ok'=>true,'images'=>$count,'entries'=>$entries,'seconds'=>time()-$started]).PHP_EOL;
} finally { if (is_file($temp)) unlink($temp); }
