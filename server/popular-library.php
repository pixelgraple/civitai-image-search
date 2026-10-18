<?php
declare(strict_types=1);

const POPULAR_CACHE_VERSION = 1;
const POPULAR_MIN_IMAGES = 50;
const POPULAR_MIN_REACTIONS = 200;

function popular_cache_directory(): string {
    return dirname((string)config()['database_path']).'/popular-cache';
}

function popular_read_database(): PDO {
    $pdo=new PDO('sqlite:'.config()['database_path'],null,null,[
        PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE=>PDO::FETCH_ASSOC,
    ]);
    $pdo->exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000; PRAGMA cache_size=-65536;');
    return $pdo;
}

function popular_name(mixed $value,int $maximum=300): string {
    if (!is_string($value) || !preg_match('//u',$value) || preg_match('/[\x00-\x1F\x7F]/u',$value)) return '';
    $value=trim($value);
    return text_length($value)<=$maximum?$value:'';
}

function popular_reaction_data(string $json): array {
    $values=normalize_reactions(json_decode($json,true));
    $score=0; $known=false;
    foreach (['likeCount','heartCount','laughCount','cryCount'] as $key) {
        if (isset($values[$key])) { $score+=$values[$key]; $known=true; }
    }
    // Missing counters never count as evidence of zero reactions. Known counters
    // can already prove the 200 threshold without guessing the missing values.
    return [$score,$known];
}

function popular_add(array &$groups,string $name,string $creator,array $row,int|float $score,bool $known): void {
    $key=lower_text($name);
    if (!isset($groups[$key])) $groups[$key]=[
        'name'=>$name,'imageCount'=>0,'qualifyingCount'=>0,
        'reactions'=>0,'qualifyingReactions'=>0,'reactionImages'=>0,
        'creators'=>[],'previews'=>[],
    ];
    $group=&$groups[$key];
    if (strcmp($name,$group['name'])<0) $group['name']=$name;
    $group['imageCount']++;
    $group['reactions']+=$score;
    if ($known) $group['reactionImages']++;
    if ($creator!=='') $group['creators'][lower_text($creator)]=true;
    if ($score>=POPULAR_MIN_REACTIONS) {
        $group['qualifyingCount']++;
        $group['qualifyingReactions']+=$score;
    }
    if ($row['download_status']==='ready') {
        $group['previews'][]=['id'=>(string)$row['image_id'],'score'=>$score];
        usort($group['previews'],static fn($a,$b)=>($b['score']<=>$a['score'])
            ?: (strlen($b['id'])<=>strlen($a['id'])) ?: strcmp($b['id'],$a['id']));
        $group['previews']=array_slice($group['previews'],0,3);
    }
    unset($group);
}

function popular_rank(array $groups,string $type,bool $safe): array {
    $entries=[];
    foreach ($groups as $group) {
        if ($type==='users' && $group['qualifyingCount']<POPULAR_MIN_IMAGES) continue;
        // The safe directory also avoids displaying adult resource/user names.
        if ($safe && !pg13_safe_for_fields('portrait',[],$group['name'],[])) continue;
        $group['creatorCount']=count($group['creators']);
        $group['previewIds']=array_column($group['previews'],'id');
        unset($group['creators'],$group['previews']);
        $entries[]=$group;
    }
    usort($entries,static function($a,$b) use($type) {
        if ($type==='users') return ($b['qualifyingCount']<=>$a['qualifyingCount'])
            ?: ($b['qualifyingReactions']<=>$a['qualifyingReactions'])
            ?: ($b['imageCount']<=>$a['imageCount'])
            ?: strcmp(lower_text($a['name']),lower_text($b['name']));
        return ($b['imageCount']<=>$a['imageCount'])
            ?: ($b['reactions']<=>$a['reactions'])
            ?: strcmp(lower_text($a['name']),lower_text($b['name']));
    });
    return ['total'=>count($entries),'items'=>array_slice($entries,0,50)];
}

function popular_belongs(array $row,string $type,string $name): bool {
    $key=lower_text($name);
    if ($type==='users') return lower_text(normalize_creator_name($row['creator_name']))===$key;
    if ($type==='models') return lower_text(trim($row['model_name']))===$key;
    $loras=json_decode($row['loras_json'],true);
    if (!is_array($loras)) return false;
    foreach ($loras as $lora) if (is_string($lora) && lower_text(trim($lora))===$key) return true;
    return false;
}

function popular_response(string $type,bool $safe): array {
    $path=popular_cache_directory().'/rankings-v1.json';
    if (!is_file($path)) throw new RuntimeException('Popular rankings have not been built yet.');
    $snapshot=json_decode((string)file_get_contents($path),true,64,JSON_THROW_ON_ERROR);
    if (($snapshot['version']??null)!==POPULAR_CACHE_VERSION ||
        ($snapshot['policyVersion']??null)!==PG13_POLICY_VERSION ||
        !is_int($snapshot['generatedAt']??null) || $snapshot['generatedAt']<time()-86400)
        throw new RuntimeException('Popular rankings need refreshing.');
    $scope=$snapshot['scopes'][$safe?'safe':'all']??null;
    $ranking=$scope[$type]??null;
    if (!is_array($ranking) || !is_array($ranking['items']??null)) throw new RuntimeException('Popular ranking is unavailable.');
    $items=array_slice($ranking['items'],0,50);
    $ids=[];
    foreach ($items as $item) foreach (($item['previewIds']??[]) as $id) {
        if (is_string($id) && valid_image_id($id)) $ids[$id]=$id;
    }
    $previews=[];
    if ($ids) {
        $pdo=popular_read_database();
        $sql='SELECT i.image_id,i.creator_name,i.model_name,i.loras_json FROM images i
            WHERE i.image_id IN ('.implode(',',array_fill(0,count($ids),'?')).')
            AND i.download_status=\'ready\' AND COALESCE(i.file_path,\'\')<>\'\'
            AND NOT EXISTS (SELECT 1 FROM image_collection_skips sk WHERE sk.image_id=i.image_id)';
        if ($safe) $sql.=' AND EXISTS (SELECT 1 FROM image_pg13_safety_v2 s WHERE s.image_id=i.image_id AND s.pg13_safe=1)';
        $stmt=$pdo->prepare($sql); $stmt->execute(array_values($ids));
        foreach ($stmt as $row) $previews[(string)$row['image_id']]=$row;
    }
    foreach ($items as &$item) {
        $item['previews']=[];
        foreach ($item['previewIds'] as $id) {
            if (!isset($previews[$id]) || !popular_belongs($previews[$id],$type,$item['name'])) continue;
            $item['previews'][]=['id'=>$id,'url'=>'media.php?id='.rawurlencode($id).'&variant=thumb&w=320&pv=1'];
        }
        unset($item['previewIds']);
    }
    unset($item);
    return ['ok'=>true,'type'=>$type,'pg13'=>$safe,'generatedAt'=>$snapshot['generatedAt'],
        'stale'=>$snapshot['generatedAt']<time()-1800,'refreshMinutes'=>15,
        'threshold'=>['images'=>POPULAR_MIN_IMAGES,'reactions'=>POPULAR_MIN_REACTIONS],
        'catalogImages'=>$scope['catalogImages'],'total'=>$ranking['total'],'items'=>$items];
}
