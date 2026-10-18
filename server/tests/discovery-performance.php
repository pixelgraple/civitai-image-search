<?php
declare(strict_types=1);
if (PHP_SAPI!=='cli') exit(1);
$root=sys_get_temp_dir().'/civitai-discovery-'.bin2hex(random_bytes(6));
mkdir($root,0700);mkdir($root.'/discovery-cache',0700);
file_put_contents($root.'/config.php','<?php return '.var_export(['database_path'=>$root.'/catalog.sqlite'],true).';');
putenv('CIVITAI_LIBRARY_CONFIG='.$root.'/config.php');
require dirname(__DIR__).'/lib.php';
require dirname(__DIR__).'/discovery-library.php';
$checks=0;
function check(bool $ok,string $label):void {global $checks;if(!$ok)throw new RuntimeException($label);$checks++;}
try {
 $live=new PDO('sqlite:'.$root.'/catalog.sqlite');
 $live->exec("CREATE TABLE images(image_id TEXT PRIMARY KEY,download_status TEXT,file_path TEXT,creator_name TEXT DEFAULT 'Fixture',model_name TEXT DEFAULT 'Fixture',loras_json TEXT DEFAULT '[\"Fixture\"]');
 CREATE INDEX images_download_status ON images(download_status);
 CREATE TABLE image_collection_skips(image_id TEXT PRIMARY KEY);
 CREATE TABLE image_pg13_safety_v2(image_id TEXT PRIMARY KEY,pg13_safe INTEGER);
 CREATE INDEX image_pg13_safety_v2_safe ON image_pg13_safety_v2(pg13_safe,image_id);");
 for($i=100;$i<=106;$i++){
  $live->prepare('INSERT INTO images(image_id,download_status,file_path) VALUES(?,?,?)')->execute([(string)$i,$i===105?'pending':'ready',$i===106?'':'fixture.webp']);
  $live->prepare('INSERT INTO image_pg13_safety_v2 VALUES(?,?)')->execute([(string)$i,in_array($i,[102,103],true)?0:1]);
 }
 $live->exec("INSERT INTO image_collection_skips VALUES('104')");
 $db=new PDO('sqlite:'.discovery_path());
 $db->exec("CREATE TABLE metadata(version INTEGER,policy INTEGER,built_at INTEGER);
 CREATE TABLE image_meta(image_id TEXT PRIMARY KEY,safe INTEGER,ready INTEGER,score INTEGER);
 CREATE INDEX image_preview_status ON image_meta(image_id,safe,ready);
 CREATE TABLE members(kind TEXT,key TEXT,image_id TEXT,PRIMARY KEY(kind,key,image_id)) WITHOUT ROWID;
 CREATE INDEX member_image ON members(image_id,kind,key);
 CREATE TABLE entries(scope INTEGER,kind TEXT,key TEXT,name TEXT,search_name TEXT,payload TEXT,image_count INTEGER,score INTEGER,PRIMARY KEY(scope,kind,key)) WITHOUT ROWID;
 CREATE INDEX entry_rank ON entries(scope,kind,image_count DESC,score DESC,key);");
 $db->prepare('INSERT INTO metadata VALUES(?,?,?)')->execute([DISCOVERY_VERSION,PG13_POLICY_VERSION,time()]);
 for($i=100;$i<=107;$i++)$db->prepare('INSERT INTO image_meta VALUES(?,?,1,10)')->execute([(string)$i,$i===103?0:1]);
 $kinds=['models','loras','creators','recipes','tags','phrases'];
 foreach($kinds as $kind){
  for($i=100;$i<=107;$i++)$db->prepare('INSERT INTO members VALUES(?,?,?)')->execute([$kind,'fixture',(string)$i]);
  foreach([0,1]as$scope)$db->prepare("INSERT INTO entries VALUES(?,?,?,'Fixture','fixture','{}',8,80)")->execute([$scope,$kind,'fixture']);
 }
 $ids=array_map('strval',range(100,107));
 check(discovery_previews($ids,true)===['100','101'],'Live PG-13, skips, readiness, missing files and deleted records override snapshots');
 check(discovery_previews($ids,false)===['100','101','102','103'],'Full view still enforces availability and collection skips');
 check(discovery_previews(['100','100','invalid'],true)===['100'],'Preview inputs are deduplicated and validated');
 mkdir($root.'/popular-cache',0700);
 $ranking=['total'=>1,'items'=>[['name'=>'Fixture','previewIds'=>$ids]]];
 $scopeData=['catalogImages'=>8,'users'=>$ranking,'models'=>$ranking,'loras'=>$ranking];
 file_put_contents($root.'/popular-cache/rankings-v1.json',json_encode(['version'=>POPULAR_CACHE_VERSION,'policyVersion'=>PG13_POLICY_VERSION,'generatedAt'=>time(),'scopes'=>['safe'=>$scopeData,'all'=>$scopeData]]));
 foreach(['users','models','loras']as$type)foreach([false,true]as$safe){
  $popular=popular_response($type,$safe);
  check(array_column($popular['items'][0]['previews'],'id')===($safe?['100','101']:['100','101','102','103']),'Popular previews retain current safety and ownership');
 }
 foreach($kinds as$kind)foreach([0,1]as$scope){
  $_GET=['kind'=>$kind,'pg13'=>(string)$scope];$data=discovery_request();
  check($data['total']===1&&$data['items'][0]['kind']===$kind,'Each directory returns indexed entries');
  check($data['items'][0]['previewIds']===($scope?['100','101']:['100','101','102']),'Directory previews retain live filtering');
  $_GET['key']='fixture';$profile=discovery_request();
  check($profile['items'][0]['previewIds']===($scope?['100','101']:['100','101','102','103']),'Profile examples retain live filtering');
  check(count($profile['related'])===5,'Related profile resources are available');
 }
 $_GET=['kind'=>'creators','q'=>'nomatch'];check(discovery_request()['items']===[],'Unmatched directory searches return no results');
 $_GET=['kind'=>'creators','q'=>'FIX','page'=>'999'];$data=discovery_request();check($data['total']===1&&$data['page']===1,'Name filtering is case insensitive and pagination is bounded');
 $plan=$db->query("EXPLAIN QUERY PLAN SELECT m.image_id FROM members m JOIN image_meta i INDEXED BY image_preview_status ON i.image_id=m.image_id WHERE m.kind='creators' AND m.key='fixture' AND i.safe=1 AND i.ready=1 LIMIT 3")->fetchAll(PDO::FETCH_ASSOC);
 check(str_contains(json_encode($plan),'COVERING INDEX image_preview_status'),'Preview safety lookup uses the covering index');
 $sql=file_get_contents(dirname(__DIR__).'/discovery-library.php');check(str_contains($sql,'images i INDEXED BY sqlite_autoindex_images_1'),'Live preview check is pinned to image IDs');
 $db->exec("INSERT INTO entries VALUES(1,'creators','capped','Capped','capped','{}',130,1300)");
 for($i=2000;$i<2130;$i++){
  $db->prepare('INSERT INTO image_meta VALUES(?,1,1,10)')->execute([(string)$i]);
  $db->prepare("INSERT INTO members VALUES('creators','capped',?)")->execute([(string)$i]);
  $db->prepare("INSERT INTO members VALUES('tags',?,?)")->execute([(string)$i,(string)$i]);
  $db->prepare("INSERT INTO entries VALUES(1,'tags',?,?,?,'{}',1,10)")->execute([(string)$i,(string)$i,(string)$i]);
 }
 $_GET=['kind'=>'creators','key'=>'capped','pg13'=>'1'];$capped=discovery_request();
 check($capped['sampleLimit']===64&&$capped['items'][0]['imageCount']===130,'Smaller connection sample preserves full profile totals');
 check(count($capped['related']['tags'])===8&&min(array_map('intval',array_column($capped['related']['tags'],'key')))>=2066,'Connections are drawn only from the bounded sample');
 echo json_encode(['ok'=>true,'checks'=>$checks]).PHP_EOL;
}finally{
 $db=null;$live=null;
 foreach(glob($root.'/discovery-cache/*')as$file)unlink($file);
 rmdir($root.'/discovery-cache');foreach(glob($root.'/popular-cache/*')as$file)unlink($file);if(is_dir($root.'/popular-cache'))rmdir($root.'/popular-cache');foreach(glob($root.'/*')as$file)unlink($file);rmdir($root);
}
