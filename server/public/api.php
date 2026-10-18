<?php
declare(strict_types=1);
require dirname(__DIR__) . '/lib.php';
$action = is_string($_GET['action']??null) ? $_GET['action'] : '';
// Reject unknown methods/actions and malformed routing before any catalog work.
$methods=['health'=>'GET','writer-status'=>'GET','download-settings'=>'POST','download-status'=>'POST','check'=>'POST','source-reactions'=>'POST','search'=>'GET','popular'=>'GET','discovery'=>'GET','images'=>'POST','reactions'=>['GET','POST']];
if (!isset($methods[$action])) json_response(['ok'=>false,'error'=>'Not found.'],404);
$method=(string)($_SERVER['REQUEST_METHOD']??'');
if ($method==='OPTIONS' && in_array($action,['search','popular','discovery','reactions'],true)) { header('Allow: '.implode(', ',(array)$methods[$action])); json_response(['ok'=>false,'error'=>'Method not allowed.'],405); }
if ($method!=='OPTIONS' && !in_array($method,(array)$methods[$action],true)) {
    header('Allow: '.implode(', ',(array)$methods[$action])); json_response(['ok'=>false,'error'=>'Method not allowed.'],405);
}
// Session-gated browsing must never inherit ingestion's wildcard CORS.
if (!in_array($action, ['reactions', 'search', 'popular', 'discovery'], true)) {
    cors_headers();
    if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(204); exit; }
}
try {
    if (in_array($action,['search','popular','discovery'],true)) {
        require_once dirname(__DIR__).'/search-guard.php';
        gate_check_origin('GET');
        search_guard_require(); // One HTTP search, regardless of matches or image loads.
    }
    if (in_array($action, ['search', 'popular', 'discovery', 'reactions'], true)) {
        require_once dirname(__DIR__) . '/access-gate.php';
        gate_require_verified();
    }
    if ($action === 'discovery') {
        require_once dirname(__DIR__).'/discovery-library.php';
        try { json_response(discovery_request()); }
        catch (Throwable $error) {
            error_log('Discovery: '.$error->getMessage());
            json_response(['ok'=>false,'error'=>'Discovery is refreshing. Please try again shortly.'],503);
        }
    }
    if ($action === 'popular') {
        $type=search_parameter('type','users',6);
        $pg13=search_parameter('pg13','1',1);
        if (!in_array($type,['users','models','loras'],true) || !in_array($pg13,['0','1'],true))
            json_response(['ok'=>false,'error'=>'Choose users, models or loras and a valid PG-13 filter.'],400);
        require dirname(__DIR__).'/popular-library.php';
        try { json_response(popular_response($type,$pg13==='1')); }
        catch (Throwable $error) {
            error_log('Popular rankings: '.$error->getMessage());
            json_response(['ok'=>false,'error'=>'Popular rankings are temporarily unavailable. Please try again shortly.'],503);
        }
    }
    if ($action === 'reactions') {
        require dirname(__DIR__) . '/reactions.php';
        community_reactions_request();
    }
    if ($action === 'health' && $_SERVER['REQUEST_METHOD'] === 'GET') {
        $counts = db()->query("SELECT COUNT(*) total, SUM(download_status='ready') ready, SUM(download_status='pending') pending, (SELECT COUNT(*) FROM image_collection_skips) skipped FROM images i WHERE NOT EXISTS (SELECT 1 FROM image_collection_skips sk WHERE sk.image_id=i.image_id)")->fetch();
        json_response(['ok'=>true,'service'=>'civitai-prompt-library','counts'=>array_map('intval',$counts ?: [])]);
    }
    if ($action === 'writer-status' && $_SERVER['REQUEST_METHOD'] === 'GET') {
        authenticate_writer(); json_response(['ok'=>true,'writer'=>true,'publicIndexing'=>public_ingest_enabled()]);
    }
    if ($action === 'download-settings' && $_SERVER['REQUEST_METHOD'] === 'POST') {
        authenticate_writer(); $body=json_input(); $token=$body['collectionToken']??null;
        if (!valid_collection_token($token) || (isset($body['concurrency']) && (!is_int($body['concurrency']) || $body['concurrency']<4 || $body['concurrency']>32))) {
            json_response(['ok'=>false,'error'=>'Use a valid collection identity and a transfer limit from 4 to 32.'],400);
        }
        $key=hash('sha256',$token); $pdo=db(); $pdo->beginTransaction();
        try {
            ensure_download_lane($pdo,$key);
            if (isset($body['concurrency'])) $pdo->prepare('UPDATE download_lanes SET concurrency=?,updated_at=? WHERE lane_key=?')->execute([$body['concurrency'],gmdate('c'),$key]);
            $find=$pdo->prepare('SELECT concurrency FROM download_lanes WHERE lane_key=?'); $find->execute([$key]); $limit=(int)$find->fetchColumn();
            $pdo->commit();
        } catch (Throwable $error) { if ($pdo->inTransaction()) $pdo->rollBack(); throw $error; }
        json_response(['ok'=>true,'concurrency'=>$limit,'serverMax'=>download_concurrency_limit()]);
    }
    if ($action === 'download-status' && $_SERVER['REQUEST_METHOD'] === 'POST') {
        authenticate_writer(); $body=json_input(); $tokens=$body['collectionTokens']??null;
        if (!is_array($tokens) || !array_is_list($tokens) || count($tokens)<1 || count($tokens)>100 || count(array_filter($tokens,'valid_collection_token'))!==count($tokens)) {
            json_response(['ok'=>false,'error'=>'Submit between 1 and 100 collection identities.'],400);
        }
        json_response(['ok'=>true,...download_status_for_tokens(db(),$tokens)]);
    }
    if ($action === 'check' && $_SERVER['REQUEST_METHOD'] === 'POST') {
        authenticate_writer(); $body=json_input(); $ids=$body['imageIds']??null;
        if (!is_array($ids) || !array_is_list($ids) || count($ids)<1 || count($ids)>100 || count(array_filter($ids,'valid_image_id'))!==count($ids)) {
            json_response(['ok'=>false,'error'=>'Submit between 1 and 100 positive image IDs.'],400);
        }
        $ids=array_values(array_unique(array_map('strval',$ids))); $pdo=db(); $items=[]; $deferred=[];
        // Unknown preflight IDs do not need locks or create filesystem entries. A concurrent
        // submission may make an ID known after this snapshot; ingestion checks it again.
        $known=$pdo->prepare('SELECT image_id FROM images WHERE image_id IN ('.implode(',',array_fill(0,count($ids),'?')).')');
        $known->execute($ids); $knownIds=array_fill_keys(array_map('strval',$known->fetchAll(PDO::FETCH_COLUMN)),true);
        $find=$pdo->prepare('SELECT * FROM images WHERE image_id=?');
        $partial=($body['allowPartial']??false)===true;
        if ($partial) {
            $deadline=microtime(true)+5.0;
            foreach ($ids as $id) {
                if (!isset($knownIds[$id])) {
                    $items[]=[...check_image_storage($pdo,null,$id),'reactionsMissing'=>true,'creatorMissing'=>true,'sourcePageMissing'=>true]; continue;
                }
                if (microtime(true)>=$deadline) { $deferred[]=$id; continue; }
                $locks=[];
                try {
                    $locks=lock_image_ids([$id],0.0);
                    $find->execute([$id]); $row=$find->fetch(); $find->closeCursor();
                    // Slow original-byte reads must not keep SQLite's writer transaction open.
                    $inspection=$row ? inspect_image_storage($row) : null;
                    $pdo->beginTransaction();
                    $storage=check_image_storage($pdo,$row?:null,$id,$inspection);
                    $pdo->commit();
                    $storage['reactionsMissing']=source_reactions_missing($row ? json_decode($row['reactions_json'],true) : null);
                    $storage['creatorMissing']=!$row || trim((string)$row['creator_name'])==='';
                    $storage['sourcePageMissing']=!$row || normalize_captured_page_url($row['source_page_url']??null,$id)==='';
                    $items[]=$storage;
                } catch (Throwable $error) {
                    if ($pdo->inTransaction()) $pdo->rollBack();
                    if ($error instanceof StorageLockBusy || ($error instanceof PDOException && in_array(((int)($error->errorInfo[1]??0))&255,[5,6],true))) $deferred[]=$id;
                    else throw $error;
                } finally { unlock_image_ids($locks); }
            }
        } else {
            // Older extensions expect every requested ID or a retryable batch failure.
            $locks=$knownIds ? lock_image_ids(array_keys($knownIds)) : [];
            try {
                $rows=[]; $inspections=[];
                foreach (array_keys($knownIds) as $id) {
                    $find->execute([(string)$id]); $rows[$id]=$find->fetch()?:null; $find->closeCursor();
                    $inspections[$id]=$rows[$id] ? inspect_image_storage($rows[$id]) : null;
                }
                $pdo->beginTransaction();
                foreach ($ids as $id) {
                    $row=$rows[$id]??null;
                    $storage=check_image_storage($pdo,$row,$id,$inspections[$id]??null);
                    $storage['reactionsMissing']=source_reactions_missing($row ? json_decode($row['reactions_json'],true) : null);
                    $storage['creatorMissing']=!$row || trim((string)$row['creator_name'])==='';
                    $storage['sourcePageMissing']=!$row || normalize_captured_page_url($row['source_page_url']??null,(string)$id)==='';
                    $items[]=$storage;
                }
                $pdo->commit();
            } catch (Throwable $error) { if ($pdo->inTransaction()) $pdo->rollBack(); throw $error; }
            finally { unlock_image_ids($locks); }
        }
        $existing=count(array_filter($items,static fn($item)=>$item['exists']));
        $result=['ok'=>true,'items'=>$items,'checked'=>count($items),'existing'=>$existing,'missing'=>count($items)-$existing];
        if ($partial) $result+=['deferredIds'=>$deferred,'retryAfterMs'=>$deferred?1000:0];
        json_response($result);
    }
    if ($action === 'source-reactions' && $_SERVER['REQUEST_METHOD'] === 'POST') {
        authenticate_writer(); $body=json_input(); $items=$body['items']??null;
        if (!is_array($items) || !array_is_list($items) || count($items)<1 || count($items)>100) {
            json_response(['ok'=>false,'error'=>'Submit between 1 and 100 source reaction records.'],400);
        }
        json_response(['ok'=>true,...update_source_reactions(db(),$items)]);
    }
    if ($action === 'search' && $_SERVER['REQUEST_METHOD'] === 'GET') {
        require_once dirname(__DIR__).'/discovery-library.php';
        $exclude=search_parameter('exclude','',500);
        $orientation=search_parameter('orientation','',10);
        $recipe=search_parameter('recipe','',64); $similar=search_parameter('similar','',20);
        $image=search_parameter('image','',20); $seed=search_parameter('seed','1',10);
        $ready=search_parameter('ready','0',1);
        if (!in_array($orientation,['','portrait','landscape','square'],true) || !in_array($ready,['0','1'],true) ||
            ($recipe!=='' && !preg_match('/^[a-f0-9]{64}$/D',$recipe)) ||
            ($similar!=='' && !valid_image_id($similar)) || ($image!=='' && !valid_image_id($image)) ||
            !ctype_digit($seed) || (float)$seed>2147483647) json_response(['ok'=>false,'error'=>'Invalid discovery or image filter.'],400);
        $numbers=[];
        foreach (['minWidth'=>4096,'minHeight'=>4096,'maxWidth'=>4096,'maxHeight'=>4096,'minReactions'=>10000000] as $field=>$maximum) {
            $value=search_parameter($field,'',8);
            if ($value!=='' && (!ctype_digit($value) || (int)$value>$maximum)) json_response(['ok'=>false,'error'=>'Invalid numeric filter: '.$field],400);
            $numbers[$field]=(int)$value;
        }
        foreach (['Width','Height'] as $axis) if ($numbers['max'.$axis]>0 && $numbers['min'.$axis]>$numbers['max'.$axis])
            json_response(['ok'=>false,'error'=>'Minimum dimensions cannot exceed maximum dimensions.'],400);
        $q=search_parameter('q'); $tag=search_parameter('tag','',4000);
        $lora=search_parameter('lora','',200); $creator=ltrim(search_parameter('creator','',200),'@');
        $creatorMatch=search_parameter('creatorMatch','contains',8);
        $model=search_parameter('model','',300);
        $modelMatch=search_parameter('modelMatch','contains',8);
        $loraMatch=search_parameter('loraMatch','contains',8);
        if (!in_array($modelMatch,['contains','exact'],true) || !in_array($loraMatch,['contains','exact'],true))
            json_response(['ok'=>false,'error'=>'Use contains or exact for resource matching.'],400);
        $source=search_parameter('source','',10);
        $category=search_parameter('category','',20); $sort=search_parameter('sort','newest',30);
        $qMode=search_parameter('qMode','all',3); $tagMode=search_parameter('tagMode','all',3);
        $qScope=search_parameter('qScope','all',11);
        $tagMatch=search_parameter('tagMatch','list',5);
        $pg13Value=search_parameter('pg13','1',1);
        if (!in_array($pg13Value,['0','1'],true)) json_response(['ok'=>false,'error'=>'PG-13 filter must be 0 or 1.'],400);
        $pg13Enabled=$pg13Value==='1';
        $pageText=search_parameter('page','1',6); $limitText=search_parameter('limit','24',3);
        if (!ctype_digit($pageText) || !ctype_digit($limitText)) json_response(['ok'=>false,'error'=>'Page and limit must be positive numbers.'],400);
        $page=max(1,min(100000,(int)$pageText)); $limit=max(1,min(48,(int)$limitText));
        if (!in_array($sort, ['newest','upvotes','civitai_reactions','random'], true)) json_response(['ok'=>false,'error'=>'Invalid sort order.'], 400);
        if (!in_array($category, ['', 'anime', 'realistic', 'uncertain'], true)) json_response(['ok'=>false,'error'=>'Invalid category.'], 400);
        if (!in_array($source, ['', 'com', 'red', 'unknown'], true)) json_response(['ok'=>false,'error'=>'Source must be all, com, red or unknown.'], 400);
        if (!in_array($qMode,['all','any'],true) || !in_array($tagMode,['all','any'],true)) json_response(['ok'=>false,'error'=>'Use all or any for keyword and tag matching.'],400);
        if (!in_array($qScope,['all','prompt','prompt_tags'],true)) json_response(['ok'=>false,'error'=>'Use all, prompt or prompt_tags for keyword scope.'],400);
        if (!in_array($tagMatch,['list','exact'],true)) json_response(['ok'=>false,'error'=>'Use list or exact for tag input.'],400);
        if (!in_array($creatorMatch,['contains','exact'],true)) json_response(['ok'=>false,'error'=>'Use contains or exact for creator matching.'],400);
        $terms = discovery_search_terms($q);
        if ($q!=='' && !$terms) json_response(['ok'=>false,'error'=>'Enter at least one word or number to search.'],400);
        $tagValues=$tagMatch==='exact' ? [$tag] : (preg_split('/[,\r\n]+/u',$tag)?:[]);
        $tags=array_values(array_filter(array_map(static fn($value)=>lower_text(trim($value)),$tagValues),static fn($value)=>$value!==''));
        if (count($terms)>20 || count($tags)>20 || array_filter($tags,static fn($value)=>text_length($value)>200)) json_response(['ok'=>false,'error'=>'Use at most 20 keywords and 20 tags; each tag may contain up to 200 characters.'],400);
        $terms=array_values(array_unique($terms)); $tags=array_values(array_unique($tags));
        $where = ['NOT EXISTS (SELECT 1 FROM image_collection_skips sk WHERE sk.image_id=i.image_id)']; $args = [];
        if ($source === 'com') $where[] = "instr(catalog_lower(COALESCE(i.source_page_url,'')),'civitai.com')>0";
        if ($source === 'red') $where[] = "instr(catalog_lower(COALESCE(i.source_page_url,'')),'civitai.red')>0";
        if ($source === 'unknown') $where[] = "COALESCE(i.source_page_url,'')=''";
        if ($pg13Enabled) {
            // Keep the safety gate deterministic and server-side so filtered records never
            // affect pagination or category counts. Captured domains are contributor-supplied
            // attribution, never a safety bypass. Both sources are checked through prompts, tags and
            // LoRA metadata. Negative prompts are intentionally excluded because they commonly
            // contain terms the generator was told to avoid. The materialized safety table is
            // populated by the same Unicode-boundary matcher used for new records, so this
            // check does not rescan long prompts during every count and page query.
            $where[]='EXISTS (SELECT 1 FROM image_pg13_safety_v2 pg13 WHERE pg13.image_id=i.image_id AND pg13.pg13_safe=1)';
        }
        if ($terms) {
            $fts = implode($qMode==='any' ? ' OR ' : ' AND ',array_map(static fn($term)=>'"'.str_replace('"','""',$term).'"*',$terms));
            // Scope the entire AND/OR expression; resource filters remain separate
            // requirements. Only allowlisted FTS column names are interpolated.
            if ($qScope==='prompt') $fts='prompt : ('.$fts.')';
            elseif ($qScope==='prompt_tags') $fts='{prompt tags} : ('.$fts.')';
            $where[] = 'i.image_id IN (SELECT image_id FROM images_fts WHERE images_fts MATCH ?)'; $args[]=$fts;
        }
        if ($tags) {
            // Narrow candidates through the existing tag index before checking
            // exact tag values. Keep JSON equality so punctuation and full tag
            // boundaries retain their meaning. Non-ASCII/punctuation-only tags
            // use the original predicate rather than risk tokenizer differences.
            $indexedTags=array_values(array_filter($tags,static fn($name)=>preg_match('/^[\x20-\x7E]+$/D',$name) && preg_match('/[a-z0-9]/i',$name)));
            if ($indexedTags && ($tagMode==='all' || count($indexedTags)===count($tags))) {
                $tagFts='tags : ('.implode($tagMode==='any' ? ' OR ' : ' AND ',array_map(static fn($name)=>'"'.str_replace('"','""',$name).'"',$indexedTags)).')';
                $where[]='i.image_id IN (SELECT image_id FROM images_fts WHERE images_fts MATCH ?)'; $args[]=$tagFts;
            }
            $tagClauses=[];
            foreach ($tags as $name) { $tagClauses[]='EXISTS (SELECT 1 FROM json_each(i.tags_json) jt WHERE catalog_lower(CAST(jt.value AS TEXT))=?)'; $args[]=$name; }
            $where[]='('.implode($tagMode==='any' ? ' OR ' : ' AND ',$tagClauses).')';
        }
        // instr treats %, _, quotes, and backslashes as literal name characters.
        if ($lora!=='') {
            $predicate=$loraMatch==='exact'?'catalog_lower(trim(CAST(jl.value AS TEXT)))=?':'instr(catalog_lower(CAST(jl.value AS TEXT)),?)>0';
            $where[]='EXISTS (SELECT 1 FROM json_each(i.loras_json) jl WHERE '.$predicate.')'; $args[]=lower_text($lora);
        }
        if ($creator!=='') { $where[]=$creatorMatch==='exact' ? 'catalog_lower(i.creator_name)=?' : 'instr(catalog_lower(i.creator_name),?)>0'; $args[]=lower_text($creator); }
        if ($model!=='') { $where[]=$modelMatch==='exact'?'catalog_lower(trim(i.model_name))=?':'instr(catalog_lower(i.model_name),?)>0'; $args[]=lower_text($model); }
        $pdo=db();
        if ($image!=='') { $where[]='i.image_id=?';$args[]=$image; }
        if ($ready==='1' || $sort==='random') $where[]="i.download_status='ready'";
        if ($orientation!=='') {
            $where[]='i.image_width>0 AND i.image_height>0';
            $where[]=match($orientation) {
                'portrait'=>'i.image_height>i.image_width*1.05',
                'landscape'=>'i.image_width>i.image_height*1.05',
                default=>'i.image_width<=i.image_height*1.05 AND i.image_height<=i.image_width*1.05',
            };
        }
        foreach (['minWidth'=>['image_width','>='],'maxWidth'=>['image_width','<='],'minHeight'=>['image_height','>='],'maxHeight'=>['image_height','<=']] as $field=>[$column,$operator]) {
            if ($numbers[$field]>0) { $where[]="i.$column>0 AND i.$column $operator ?";$args[]=$numbers[$field]; }
        }
        if ($numbers['minReactions']>0) {
            $parts=[];foreach (['likeCount','heartCount','laughCount','cryCount'] as $reaction) $parts[]="COALESCE(json_extract(i.reactions_json,'$.".$reaction."'),0)";
            $where[]='('.implode('+',$parts).')>=CAST(? AS INTEGER)';$args[]=$numbers['minReactions'];
        }
        $excluded=discovery_search_terms($exclude);
        if ($excluded) {
            $fts='prompt : ('.implode(' OR ',array_map(static fn($term)=>'"'.str_replace('"','""',$term).'"*',$excluded)).')';
            $where[]='i.image_id NOT IN (SELECT image_id FROM images_fts WHERE images_fts MATCH ?)';$args[]=$fts;
        }
        if ($recipe!=='') {
            discovery_attach($pdo);
            $where[]="i.image_id IN (SELECT image_id FROM discovery.members WHERE kind='recipes' AND key=?)";$args[]=$recipe;
        }
        $similarIds=[];
        if ($similar!=='') {
            $check=$pdo->prepare('SELECT i.image_id FROM images i WHERE i.image_id=? AND NOT EXISTS(SELECT 1 FROM image_collection_skips s WHERE s.image_id=i.image_id)'.($pg13Enabled?' AND EXISTS(SELECT 1 FROM image_pg13_safety_v2 p WHERE p.image_id=i.image_id AND p.pg13_safe=1)':''));
            $check->execute([$similar]);
            $similarIds=$check->fetchColumn()?discovery_similar($similar,$pg13Enabled):[];
            $where[]=$similarIds?'i.image_id IN ('.implode(',',array_fill(0,count($similarIds),'?')).')':'0=1';
            $args=array_merge($args,$similarIds);
        }
        if ($sort==='random') $pdo->sqliteCreateFunction('discovery_shuffle',static fn($id)=>sprintf('%u',crc32($seed.':'.(string)$id)),1,PDO::SQLITE_DETERMINISTIC);
        $baseWhere=$where; $baseArgs=$args;
        if ($category !== '') { $where[] = 'i.style_category=?'; $args[] = $category; }
        $clause = $where ? ' WHERE ' . implode(' AND ', $where) : '';
        $searchStarted=microtime(true); $pdo = db(); $databaseReady=microtime(true);
        // Apply name/tag predicates once for all category counts, including the total.
        $counts=['anime'=>0,'realistic'=>0,'uncertain'=>0];
        $countStmt=$pdo->prepare('SELECT i.style_category,COUNT(*) total FROM images i WHERE '.implode(' AND ',$baseWhere).' GROUP BY i.style_category');
        $countStmt->execute($baseArgs);
        foreach ($countStmt->fetchAll() as $countRow) $counts[(string)$countRow['style_category']]=(int)$countRow['total'];
        $countFinished=microtime(true);
        $total=$category!=='' ? $counts[$category] : array_sum($counts);
        $offset = ($page-1)*$limit;
        $order = match($sort) {
            'random'=>'CAST(discovery_shuffle(i.image_id) AS INTEGER), ',
            'upvotes'=>'COALESCE(cr.upvote,0) DESC, ',
            'civitai_reactions'=>source_reaction_score_sql('i').' DESC, ',
            default=>'',
        } . 'length(i.image_id) DESC, i.image_id DESC';
        if ($similarIds) {
            $ranks=[];foreach ($similarIds as $rank=>$id) $ranks[]='WHEN '.$pdo->quote($id).' THEN '.$rank;
            $order='CASE i.image_id '.implode(' ',$ranks).' END, '.$order;
        }
        $stmt = $pdo->prepare('SELECT i.*, COALESCE(cr.upvote,0) community_upvote, COALESCE(cr.heart,0) community_heart, COALESCE(cr.laugh,0) community_laugh, COALESCE(cr.wow,0) community_wow FROM images i LEFT JOIN community_reaction_counts cr ON cr.image_id=i.image_id' . $clause . ' ORDER BY ' . $order . ' LIMIT ? OFFSET ?');
        foreach ($args as $index=>$value) $stmt->bindValue($index+1,$value,PDO::PARAM_STR);
        $stmt->bindValue(count($args)+1,$limit,PDO::PARAM_INT); $stmt->bindValue(count($args)+2,$offset,PDO::PARAM_INT); $stmt->execute();
        $items = array_map('public_image_row',$stmt->fetchAll());
        foreach ($items as &$item) $item['recipeKey']=discovery_recipe($item['modelName'],$item['loras']);
        unset($item);
        header(sprintf('Server-Timing: database;dur=%.1f, search_count;dur=%.1f, search_page;dur=%.1f',1000*($databaseReady-$searchStarted),1000*($countFinished-$databaseReady),1000*(microtime(true)-$countFinished)));
        json_response(['ok'=>true,'items'=>$items,'total'=>$total,'page'=>$page,'limit'=>$limit,'pages'=>(int)ceil($total/$limit),'categoryCounts'=>$counts,'sort'=>$sort,'qMode'=>$qMode,'qScope'=>$qScope,'tagMode'=>$tagMode,'creatorMatch'=>$creatorMatch,'source'=>$source,'pg13'=>$pg13Enabled]);
    }
    if ($action === 'images' && $_SERVER['REQUEST_METHOD'] === 'POST') {
        authenticate_writer();
        $body=json_input(); $items=$body['items'] ?? null;
        if (!is_array($items) || !array_is_list($items) || count($items)<1 || count($items)>100) json_response(['ok'=>false,'error'=>'Submit between 1 and 100 records.'],400);
        $validItems=[];$rejectedItems=[];
        foreach ($items as $index=>$rawItem) {
            $item=normalize_ingest_names($rawItem);
            try { validate_ingest_item($item);$validItems[]=$item; }
            catch (InvalidIngestRecord $error) {
                $id=is_array($item)&&valid_image_id($item['id']??null)?(string)$item['id']:null;
                $rejectedItems[]=['imageId'=>$id,'index'=>$index,'reason'=>'invalid-metadata','field'=>$error->field,'error'=>$error->getMessage()];
            }
        }
        $items=$validItems;
        if (!$items) json_response(['ok'=>true,'accepted'=>0,'skipped'=>0,'skippedItems'=>[],'rejectedItems'=>$rejectedItems,'imageCopiesQueued'=>0]);
        foreach ($items as $item) if (is_array($item) && array_key_exists('collectionToken',$item) && !valid_collection_token($item['collectionToken'])) {
            json_response(['ok'=>false,'error'=>'Invalid collection identity.'],400);
        }
        $pdo=db(); $now=gmdate('c'); $saved=0; $skipped=0; $queuedIds=[]; $skippedItems=[];
        $existing=$pdo->prepare('SELECT * FROM images WHERE image_id=?');
        $upsert=$pdo->prepare("INSERT INTO images(image_id,source_url,source_page_url,prompt,negative_prompt,tags_json,model_name,creator_name,loras_json,reactions_json,image_width,image_height,style_category,style_confidence,style_signals_json,download_status,discovered_at,updated_at)
          VALUES(:id,:url,:page_url,:prompt,:negative,:tags,:model,:creator,:loras,:reactions,:width,:height,:category,:confidence,:signals,'pending',:now,:now)
          ON CONFLICT(image_id) DO UPDATE SET source_url=excluded.source_url,source_page_url=excluded.source_page_url,prompt=excluded.prompt,negative_prompt=excluded.negative_prompt,tags_json=excluded.tags_json,model_name=excluded.model_name,creator_name=excluded.creator_name,loras_json=excluded.loras_json,reactions_json=excluded.reactions_json,image_width=excluded.image_width,image_height=excluded.image_height,style_category=excluded.style_category,style_confidence=excluded.style_confidence,style_signals_json=excluded.style_signals_json,updated_at=excluded.updated_at");
        $safetyUpsert=$pdo->prepare('INSERT INTO image_pg13_safety_v2(image_id,pg13_safe,checked_at) VALUES(?,?,?) ON CONFLICT(image_id) DO UPDATE SET pg13_safe=excluded.pg13_safe,checked_at=excluded.checked_at');
        $ftsDel=$pdo->prepare('DELETE FROM images_fts WHERE image_id=?');
        $ftsIns=$pdo->prepare('INSERT INTO images_fts(image_id,prompt,negative_prompt,tags,model_name,lora_names) VALUES(?,?,?,?,?,?)');
        $eligibleIds=[];
        foreach ($items as $item) {
            if (!is_array($item) || !valid_image_id($item['id']??null) || !safe_image_url($item['downloadUrl']??$item['sourceUrl']??null)) continue;
            $id=(string)$item['id'];
            $prompt=cut_text(trim(is_string($item['prompt']??null)?$item['prompt']:''),20000);
            if (has_positive_prompt($prompt)) $eligibleIds[$id]=true;
            else {
                $existing->execute([$id]); $prior=$existing->fetch(); $existing->closeCursor();
                if ($prior && has_positive_prompt((string)$prior['prompt'])) $eligibleIds[$id]=true;
            }
        }
        // Rejected new promptless records cannot leave arbitrary lock files. Only process IDs
        // selected here, even if another request creates a usable record before our transaction.
        $locks=$eligibleIds ? lock_image_ids(array_keys($eligibleIds)) : [];
        $ingestTransaction=false;
        try {
            $inspections=[];
            foreach (array_keys($eligibleIds) as $id) {
                $existing->execute([(string)$id]); $storedRow=$existing->fetch(); $existing->closeCursor();
                $inspections[$id]=$storedRow ? inspect_image_storage($storedRow) : null;
            }
            // Reserve the writer before reading rows that will be updated. A deferred
            // WAL read-to-write upgrade can fail immediately when another writer commits,
            // bypassing busy_timeout and forcing the extension to resend the whole batch.
            $pdo->exec('BEGIN IMMEDIATE'); $ingestTransaction=true;
            foreach ($items as $item) {
                if (!is_array($item) || !valid_image_id($item['id']??null) || !isset($eligibleIds[(string)$item['id']]) || !($url=safe_image_url($item['downloadUrl']??$item['sourceUrl']??null))) { $skipped++; continue; }
                $prompt=cut_text(trim(is_string($item['prompt']??null)?$item['prompt']:''),20000); $negative=cut_text(trim((string)($item['negativePrompt']??'')),10000);
                $tags=normalize_strings($item['tags']??[]); $loras=normalize_strings($item['loras']??[]); $model=cut_text(trim((string)($item['modelName']??'')),300);
                $creator=normalize_creator_name($item['creatorName']??null);
                $pageUrl=normalize_captured_page_url($item['capturedPageUrl']??null,(string)$item['id']);
                $reactions=normalize_reactions($item['reactions']??null); $width=image_dimension($item['width']??null); $height=image_dimension($item['height']??null);
                $existing->execute([(string)$item['id']]); $prior=$existing->fetch(); $existing->closeCursor();
                if (!$prior && image_size_exceeds_limits($item['width']??0,$item['height']??0)) {
                    // Client dimensions may reject this submission, but only the worker's
                    // inspection of actual bytes may permanently exclude an image ID.
                    $skipped++; $skippedItems[]=['imageId'=>(string)$item['id'],'reason'=>'oversize']; continue;
                }
                if ($prior) {
                    if (has_positive_prompt((string)$prior['prompt'])) $prompt=(string)$prior['prompt'];
                    if ((string)$prior['negative_prompt']!=='') $negative=(string)$prior['negative_prompt'];
                    if (json_decode($prior['tags_json'],true)) $tags=json_decode($prior['tags_json'],true);
                    if (json_decode($prior['loras_json'],true)) $loras=json_decode($prior['loras_json'],true);
                    if ((string)$prior['model_name']!=='') $model=(string)$prior['model_name'];
                    if ((string)$prior['creator_name']!=='') $creator=(string)$prior['creator_name'];
                    if ((string)$prior['source_url']!=='') $url=(string)$prior['source_url'];
                    $pageUrl=normalize_captured_page_url($prior['source_page_url']??null,(string)$item['id']) ?: $pageUrl;
                    $reactions=array_replace(json_decode($prior['reactions_json'],true) ?: [],$reactions);
                    if ((int)$prior['image_width']>0) $width=(int)$prior['image_width'];
                    if ((int)$prior['image_height']>0) $height=(int)$prior['image_height'];
                }
                if (!has_positive_prompt($prompt)) { $skipped++; continue; }
                if (image_size_exceeds_limits($width,$height)) {
                    $skipped++; $skippedItems[]=['imageId'=>(string)$item['id'],'reason'=>'oversize']; continue;
                }
                $storage=check_image_storage($pdo,$prior?:null,(string)$item['id'],$inspections[(string)$item['id']]??null);
                if ($storage['downloadStatus']==='skipped') {
                    $skipped++; $skippedItems[]=['imageId'=>(string)$item['id'],'reason'=>'oversize']; continue;
                }
                $style=classify_style($prompt,$model,$loras,$tags);
                $pg13Safe=pg13_safe_for_fields($prompt,$tags,$model,$loras);
                $values=[':id'=>(string)$item['id'],':url'=>$url,':page_url'=>$pageUrl,':prompt'=>$prompt,':negative'=>$negative,':tags'=>json_encode($tags),':model'=>$model,':creator'=>$creator,':loras'=>json_encode($loras),':reactions'=>json_encode((object)$reactions),':width'=>$width,':height'=>$height,':category'=>$style['category'],':confidence'=>$style['confidence'],':signals'=>json_encode($style['signals']),':now'=>$now];
                $searchFields=[$prompt,$negative,implode(' ',$tags),$model,implode(' ',$loras)];
                $priorSearchFields=$prior ? [(string)$prior['prompt'],(string)$prior['negative_prompt'],implode(' ',json_decode($prior['tags_json'],true)?:[]),(string)$prior['model_name'],implode(' ',json_decode($prior['loras_json'],true)?:[])] : null;
                $upsert->execute($values);
                $safetyUpsert->execute([(string)$item['id'],$pg13Safe,$now]);
                if ($priorSearchFields!==$searchFields) {
                    if ($prior) $ftsDel->execute([(string)$item['id']]);
                    $ftsIns->execute([(string)$item['id'],...$searchFields]);
                }
                $saved++;
                if ($storage['needsDownload'] && (!$prior || $storage['downloadStatus']==='pending')) $queuedIds[(string)$item['id']]=true;
                if (isset($item['collectionToken']) && (!$prior || $storage['downloadStatus']==='pending')) {
                    $laneKey=hash('sha256',$item['collectionToken']); ensure_download_lane($pdo,$laneKey);
                    $pdo->prepare('INSERT OR IGNORE INTO image_download_lanes(image_id,lane_key) VALUES(?,?)')->execute([(string)$item['id'],$laneKey]);
                }
            }
            $pdo->exec('COMMIT'); $ingestTransaction=false;
        } catch (Throwable $error) {
            // PDO does not track transactions opened with explicit BEGIN IMMEDIATE.
            if ($ingestTransaction) $pdo->exec('ROLLBACK');
            throw $error;
        }
        finally { unlock_image_ids($locks); }
        json_response(['ok'=>true,'accepted'=>$saved,'skipped'=>$skipped,'skippedItems'=>$skippedItems,'rejectedItems'=>$rejectedItems,'imageCopiesQueued'=>count($queuedIds)]);
    }
    json_response(['ok'=>false,'error'=>'Not found.'],404);
} catch (DownloadLaneCapacity $error) {
    header('Retry-After: 60'); json_response(['ok'=>false,'error'=>$error->getMessage()],503);
} catch (StorageLockBusy $error) {
    header('Retry-After: 2'); json_response(['ok'=>false,'error'=>'Image storage is busy; retry this batch shortly.'],503);
} catch (Throwable $error) {
    if ($error instanceof PDOException && in_array(((int)($error->errorInfo[1]??0))&255,[5,6],true)) {
        // Private operational evidence only; never include request bodies, tokens or SQL parameters.
        error_log('CIVITAI_STORAGE_BUSY '.json_encode(['action'=>$action,'file'=>basename($error->getFile()),'line'=>$error->getLine(),'code'=>(int)($error->errorInfo[1]??0)]));
        header('Retry-After: 2'); json_response(['ok'=>false,'error'=>'Catalog storage is busy; retry this batch shortly.'],503);
    }
    error_log('Civitai library API error: ' . $error->getMessage());
    json_response(['ok'=>false,'error'=>'The catalog request could not be completed.'],500);
}

