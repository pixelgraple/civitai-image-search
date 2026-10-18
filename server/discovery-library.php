<?php
declare(strict_types=1);
require_once __DIR__.'/popular-library.php';
const DISCOVERY_VERSION=1;
function discovery_path(): string { return dirname(config()['database_path']).'/discovery-cache/catalog-v1.sqlite'; }
function discovery_db(): PDO {
    $path=discovery_path();
    if (!is_file($path)) throw new RuntimeException('Discovery snapshot not built.');
    $db=new PDO('sqlite:'.$path,null,null,[PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION,PDO::ATTR_DEFAULT_FETCH_MODE=>PDO::FETCH_ASSOC]);
    $db->exec('PRAGMA query_only=ON; PRAGMA busy_timeout=3000; PRAGMA cache_size=-16384;');
    $meta=$db->query('SELECT * FROM metadata')->fetch();
    if (!$meta || (int)$meta['version']!==DISCOVERY_VERSION || (int)$meta['policy']!==PG13_POLICY_VERSION || (int)$meta['built_at']<time()-86400) throw new RuntimeException('Discovery snapshot needs refreshing.');
    return $db;
}
function discovery_recipe(string $model,array $loras): string {
    if ($model==='' || !$loras) return '';
    $keys=array_unique(array_map(static fn($s)=>lower_text(trim($s)),$loras)); sort($keys,SORT_STRING);
    return hash('sha256',json_encode([lower_text(trim($model)),$keys],JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES));
}
function discovery_terms(string $prompt,array $tags): array {
    $out=[];
    foreach (array_slice($tags,0,64) as $tag) {
        $name=popular_name($tag,100);
        if ($name!=='') $out['tags:'.lower_text($name)]=['tags',lower_text($name),$name];
    }
    // Explicit descriptive phrases; generic quality words do not drive similarity.
    $phrases=['direct flash','golden hour','soft lighting','natural lighting','hard lighting','rim lighting','studio lighting','cinematic lighting','volumetric lighting','backlit','backlighting','low light','overcast','neon lighting','window light','shallow depth of field','depth of field','film grain','motion blur','bokeh','black and white','analog photography','smartphone photo','phone selfie','mirror selfie','candid photograph','webcam','close up','wide angle','low angle','high angle','full body','portrait','landscape','street photography','fashion photography','macro photography','underwater','sunset','sunrise','silhouette','minimalist','watercolor','oil painting','digital illustration','pixel art','comic book','flat colors','line art','cel shading','anime style','photorealistic','realistic skin','soft focus','fisheye','polaroid','vintage','cyberpunk','steampunk','fantasy','beach','forest','mountains','city street','snow','rain','flowers','indoors','outdoors','looking at viewer'];
    $text=lower_text(preg_replace('/<lora:[^>]*>/iu','',$prompt)??$prompt);
    $text=preg_replace('/[_-]+/u',' ',$text)??$text;
    static $pattern=null;
    $pattern??='/(?<![\p{L}\p{N}])(?:'.implode('|',array_map(static fn($p)=>preg_quote($p,'/'),$phrases)).')(?![\p{L}\p{N}])/u';
    preg_match_all($pattern,$text,$found);
    foreach (array_unique($found[0]) as $phrase) {
        $out['phrases:'.$phrase]=['phrases',$phrase,$phrase];
    }
    return array_values($out);
}
function discovery_previews(array $ids,bool $safe): array {
    $ids=array_values(array_unique(array_filter(array_map('strval',$ids),'valid_image_id')));
    if (!$ids) return [];
    $pdo=popular_read_database();
    $sql="SELECT image_id FROM images i WHERE image_id IN (".implode(',',array_fill(0,count($ids),'?')).") AND download_status='ready' AND COALESCE(file_path,'')<>'' AND NOT EXISTS(SELECT 1 FROM image_collection_skips sk WHERE sk.image_id=i.image_id)";
    if ($safe) $sql.=' AND EXISTS(SELECT 1 FROM image_pg13_safety_v2 s WHERE s.image_id=i.image_id AND s.pg13_safe=1)';
    $s=$pdo->prepare($sql); $s->execute($ids); $allowed=array_fill_keys(array_column($s->fetchAll(),'image_id'),true);
    return array_values(array_filter($ids,static fn($id)=>isset($allowed[$id])));
}
function discovery_entry(array $row): array {
    return ['kind'=>$row['kind'],'key'=>$row['key'],'name'=>$row['name'],'imageCount'=>(int)$row['image_count'],'reactions'=>(int)$row['score'],'data'=>json_decode($row['payload'],true)?:[]];
}
function discovery_request(): array {
    $db=discovery_db();
    $kind=search_parameter('kind','models',12); $key=search_parameter('key','',320);
    $q=lower_text(search_parameter('q','',200)); $pg13=search_parameter('pg13','1',1);
    $page=search_parameter('page','1',5);
    if (!in_array($kind,['models','loras','creators','recipes','tags','phrases'],true) || !in_array($pg13,['0','1'],true) || !ctype_digit($page)) json_response(['ok'=>false,'error'=>'Invalid discovery filter.'],400);
    $safe=$pg13==='1'; $scope=(int)$safe; $page=max(1,min(10000,(int)$page)); $limit=24;
    $where='scope=? AND kind=?'; $args=[$scope,$kind];
    if ($key!=='') { $where.=' AND key=?'; $args[]=lower_text($key); }
    if ($q!=='') { $where.=' AND instr(search_name,?)>0'; $args[]=$q; }
    if ($kind==='recipes' && $key==='') $where.=' AND image_count>=2';
    $s=$db->prepare('SELECT COUNT(*) FROM entries WHERE '.$where); $s->execute($args); $total=(int)$s->fetchColumn();
    $pages=(int)ceil($total/$limit); $page=min($page,max(1,$pages));
    $s=$db->prepare('SELECT * FROM entries WHERE '.$where.' ORDER BY image_count DESC,score DESC,key LIMIT ? OFFSET ?');
    foreach ($args as $i=>$v) $s->bindValue($i+1,$v);
    $s->bindValue(count($args)+1,$limit,PDO::PARAM_INT); $s->bindValue(count($args)+2,($page-1)*$limit,PDO::PARAM_INT); $s->execute();
    $items=array_map('discovery_entry',$s->fetchAll()); $allIds=[];
    $preview=$db->prepare('SELECT m.image_id FROM members m JOIN image_meta i ON i.image_id=m.image_id WHERE m.kind=? AND m.key=? AND (CAST(? AS INTEGER)=0 OR i.safe=1) AND i.ready=1 LIMIT ?');
    foreach ($items as &$item) {
        $preview->bindValue(1,$kind); $preview->bindValue(2,$item['key']); $preview->bindValue(3,$scope,PDO::PARAM_INT); $preview->bindValue(4,$key!==''?24:3,PDO::PARAM_INT); $preview->execute();
        $item['previewIds']=array_map('strval',array_column($preview->fetchAll(),'image_id')); $allIds=array_merge($allIds,$item['previewIds']);
    } unset($item);
    $allowed=array_fill_keys(discovery_previews($allIds,$safe),true);
    foreach ($items as &$item) $item['previewIds']=array_values(array_filter($item['previewIds'],static fn($id)=>isset($allowed[$id])));
    unset($item);
    $related=[];
    if ($key!=='' && $items) {
        // Bound profile aggregation to a labeled sample, independent of catalog size.
        $s=$db->prepare('SELECT DISTINCT x.kind,x.key,COUNT(*) uses FROM members x
          JOIN (SELECT m.image_id FROM members m JOIN image_meta i ON i.image_id=m.image_id WHERE m.kind=? AND m.key=? AND (CAST(? AS INTEGER)=0 OR i.safe=1) ORDER BY m.image_id DESC LIMIT 1000) sample ON sample.image_id=x.image_id
          WHERE x.kind IN (\'models\',\'loras\',\'creators\',\'tags\',\'phrases\',\'recipes\') GROUP BY x.kind,x.key ORDER BY uses DESC LIMIT 180');
        $s->execute([$kind,lower_text($key),$scope]);
        $entry=$db->prepare('SELECT * FROM entries WHERE scope=? AND kind=? AND key=?');
        foreach ($s->fetchAll() as $pair) {
            if ($pair['kind']===$kind && $pair['key']===lower_text($key)) continue;
            if (count($related[$pair['kind']]??[])>=8) continue;
            $entry->execute([$scope,$pair['kind'],$pair['key']]); $row=$entry->fetch();
            if ($row) $related[$pair['kind']][]=[...discovery_entry($row),'sampleUses'=>(int)$pair['uses']];
        }
    }
    $meta=$db->query('SELECT * FROM metadata')->fetch();
    return ['ok'=>true,'items'=>$items,'total'=>$total,'page'=>$page,'pages'=>$pages,'kind'=>$kind,'pg13'=>$safe,'related'=>$related,'sampleLimit'=>1000,'generatedAt'=>(int)$meta['built_at']];
}
function discovery_similar(string $id,bool $safe): array {
    $db=discovery_db(); $scope=(int)$safe;
    $s=$db->prepare('SELECT image_id FROM image_meta WHERE image_id=? AND (CAST(? AS INTEGER)=0 OR safe=1)'); $s->execute([$id,$scope]);
    if (!$s->fetchColumn()) return [];
    // Rare cues are more useful than ubiquitous tags; a model alone is insufficient.
    $s=$db->prepare("SELECT m.kind,m.key,e.image_count FROM members m JOIN entries e ON e.kind=m.kind AND e.key=m.key AND e.scope=? WHERE m.image_id=? AND m.kind IN ('loras','tags','phrases') AND e.image_count>1 ORDER BY e.image_count ASC LIMIT 16");
    $s->execute([$scope,$id]); $terms=$s->fetchAll();
    if (!$terms) return [];
    $model=$db->prepare("SELECT key FROM members WHERE image_id=? AND kind='models' LIMIT 1");
    $model->execute([$id]);$modelKey=(string)($model->fetchColumn()?:'');
    $clauses=[];$args=[];
    foreach ($terms as $term) {
        $clauses[]='(m.kind=? AND m.key=?)'; $args[]=$term['kind'];$args[]=$term['key'];
    }
    $s=$db->prepare('SELECT m.image_id,SUM(CASE m.kind WHEN \'loras\' THEN 5 WHEN \'phrases\' THEN 3 ELSE 2 END)+CASE WHEN EXISTS(SELECT 1 FROM members model WHERE model.kind=\'models\' AND model.key=? AND model.image_id=m.image_id) THEN 2 ELSE 0 END score FROM members m JOIN image_meta i ON i.image_id=m.image_id WHERE ('.implode(' OR ',$clauses).') AND m.image_id<>? AND i.ready=1 AND (CAST(? AS INTEGER)=0 OR i.safe=1) GROUP BY m.image_id ORDER BY score DESC,i.score DESC,m.image_id DESC LIMIT 240');
    $s->execute([$modelKey,...$args,$id,$scope]); return array_map('strval',array_column($s->fetchAll(),'image_id'));
}
function discovery_attach(PDO $pdo): void {
    discovery_db(); // Reject missing, obsolete or malformed snapshots before attaching.
    $s=$pdo->prepare('ATTACH DATABASE ? AS discovery'); $s->execute([discovery_path()]);
}
function discovery_search_terms(string $input): array {
    preg_match_all('/"([^"]+)"|([^\s,"]+)/u',$input,$matches,PREG_SET_ORDER);
    $out=[];
    foreach ($matches as $match) {
        $phrase=isset($match[2]) && $match[2]!=='' ? $match[2] : $match[1];
        $words=preg_split('/[^\p{L}\p{N}]+/u',lower_text($phrase),-1,PREG_SPLIT_NO_EMPTY)?:[];
        if ($words) $out[]=implode(' ',$words);
    }
    if (count($out)>20) json_response(['ok'=>false,'error'=>'Use at most 20 words or quoted phrases.'],400);
    return array_values(array_unique($out));
}
