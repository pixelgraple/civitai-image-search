<?php
declare(strict_types=1);
require dirname(__DIR__) . '/lib.php';
$action = is_string($_GET['action']??null) ? $_GET['action'] : '';
// Anonymous browser identity and CSRF responses must never inherit ingestion's wildcard CORS.
if ($action !== 'reactions') {
    cors_headers();
    if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(204); exit; }
}
try {
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
                    $items[]=[...check_image_storage($pdo,null,$id),'reactionsMissing'=>true,'creatorMissing'=>true]; continue;
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
        $q=search_parameter('q'); $tag=search_parameter('tag','',4000);
        $lora=search_parameter('lora','',200); $creator=ltrim(search_parameter('creator','',200),'@');
        $model=search_parameter('model','',300);
        $category=search_parameter('category','',20); $sort=search_parameter('sort','newest',30);
        $qMode=search_parameter('qMode','all',3); $tagMode=search_parameter('tagMode','all',3);
        $tagMatch=search_parameter('tagMatch','list',5);
        $pageText=search_parameter('page','1',6); $limitText=search_parameter('limit','24',3);
        if (!ctype_digit($pageText) || !ctype_digit($limitText)) json_response(['ok'=>false,'error'=>'Page and limit must be positive numbers.'],400);
        $page=max(1,min(100000,(int)$pageText)); $limit=max(1,min(48,(int)$limitText));
        if (!in_array($sort, ['newest','upvotes','civitai_reactions'], true)) json_response(['ok'=>false,'error'=>'Invalid sort order.'], 400);
        if (!in_array($category, ['', 'anime', 'realistic', 'uncertain'], true)) json_response(['ok'=>false,'error'=>'Invalid category.'], 400);
        if (!in_array($qMode,['all','any'],true) || !in_array($tagMode,['all','any'],true)) json_response(['ok'=>false,'error'=>'Use all or any for keyword and tag matching.'],400);
        if (!in_array($tagMatch,['list','exact'],true)) json_response(['ok'=>false,'error'=>'Use list or exact for tag input.'],400);
        $terms = preg_split('/[^\p{L}\p{N}]+/u', lower_text($q), -1, PREG_SPLIT_NO_EMPTY) ?: [];
        $tagValues=$tagMatch==='exact' ? [$tag] : (preg_split('/[,\r\n]+/u',$tag)?:[]);
        $tags=array_values(array_filter(array_map(static fn($value)=>lower_text(trim($value)),$tagValues),static fn($value)=>$value!==''));
        if (count($terms)>20 || count($tags)>20 || array_filter($tags,static fn($value)=>text_length($value)>200)) json_response(['ok'=>false,'error'=>'Use at most 20 keywords and 20 tags; each tag may contain up to 200 characters.'],400);
        $terms=array_values(array_unique($terms)); $tags=array_values(array_unique($tags));
        $where = ['NOT EXISTS (SELECT 1 FROM image_collection_skips sk WHERE sk.image_id=i.image_id)']; $args = [];
        if ($terms) {
            $fts = implode($qMode==='any' ? ' OR ' : ' AND ',array_map(static fn($term)=>'"'.str_replace('"','""',$term).'"*',$terms));
            $where[] = 'i.image_id IN (SELECT image_id FROM images_fts WHERE images_fts MATCH ?)'; $args[]=$fts;
        }
        if ($tags) {
            $tagClauses=[];
            foreach ($tags as $name) { $tagClauses[]='EXISTS (SELECT 1 FROM json_each(i.tags_json) jt WHERE catalog_lower(CAST(jt.value AS TEXT))=?)'; $args[]=$name; }
            $where[]='('.implode($tagMode==='any' ? ' OR ' : ' AND ',$tagClauses).')';
        }
        // instr treats %, _, quotes, and backslashes as literal name characters.
        if ($lora!=='') { $where[]='EXISTS (SELECT 1 FROM json_each(i.loras_json) jl WHERE instr(catalog_lower(CAST(jl.value AS TEXT)),?)>0)'; $args[]=lower_text($lora); }
        if ($creator!=='') { $where[]='instr(catalog_lower(i.creator_name),?)>0'; $args[]=lower_text($creator); }
        if ($model!=='') { $where[]='instr(catalog_lower(i.model_name),?)>0'; $args[]=lower_text($model); }
        $baseWhere=$where; $baseArgs=$args;
        if ($category !== '') { $where[] = 'i.style_category=?'; $args[] = $category; }
        $clause = $where ? ' WHERE ' . implode(' AND ', $where) : '';
        $pdo = db();
        // Apply name/tag predicates once for all category counts, including the total.
        $counts=['anime'=>0,'realistic'=>0,'uncertain'=>0];
        $countStmt=$pdo->prepare('SELECT i.style_category,COUNT(*) total FROM images i WHERE '.implode(' AND ',$baseWhere).' GROUP BY i.style_category');
        $countStmt->execute($baseArgs);
        foreach ($countStmt->fetchAll() as $countRow) $counts[(string)$countRow['style_category']]=(int)$countRow['total'];
        $total=$category!=='' ? $counts[$category] : array_sum($counts);
        $offset = ($page-1)*$limit;
        $order = match($sort) {
            'upvotes'=>'COALESCE(cr.upvote,0) DESC, ',
            'civitai_reactions'=>source_reaction_score_sql('i').' DESC, ',
            default=>'',
        } . 'length(i.image_id) DESC, i.image_id DESC';
        $stmt = $pdo->prepare('SELECT i.*, COALESCE(cr.upvote,0) community_upvote, COALESCE(cr.heart,0) community_heart, COALESCE(cr.laugh,0) community_laugh, COALESCE(cr.wow,0) community_wow FROM images i LEFT JOIN community_reaction_counts cr ON cr.image_id=i.image_id' . $clause . ' ORDER BY ' . $order . ' LIMIT ? OFFSET ?');
        foreach ($args as $index=>$value) $stmt->bindValue($index+1,$value,PDO::PARAM_STR);
        $stmt->bindValue(count($args)+1,$limit,PDO::PARAM_INT); $stmt->bindValue(count($args)+2,$offset,PDO::PARAM_INT); $stmt->execute();
        $items = array_map('public_image_row',$stmt->fetchAll());
        json_response(['ok'=>true,'items'=>$items,'total'=>$total,'page'=>$page,'limit'=>$limit,'pages'=>(int)ceil($total/$limit),'categoryCounts'=>$counts,'sort'=>$sort,'qMode'=>$qMode,'tagMode'=>$tagMode]);
    }
    if ($action === 'images' && $_SERVER['REQUEST_METHOD'] === 'POST') {
        authenticate_writer();
        $body=json_input(); $items=$body['items'] ?? null;
        if (!is_array($items) || !array_is_list($items) || count($items)<1 || count($items)>100) json_response(['ok'=>false,'error'=>'Submit between 1 and 100 records.'],400);
        foreach ($items as $item) if (is_array($item) && array_key_exists('collectionToken',$item) && !valid_collection_token($item['collectionToken'])) {
            json_response(['ok'=>false,'error'=>'Invalid collection identity.'],400);
        }
        $pdo=db(); $now=gmdate('c'); $saved=0; $skipped=0; $queuedIds=[]; $skippedItems=[];
        $existing=$pdo->prepare('SELECT * FROM images WHERE image_id=?');
        $upsert=$pdo->prepare("INSERT INTO images(image_id,source_url,prompt,negative_prompt,tags_json,model_name,creator_name,loras_json,reactions_json,image_width,image_height,style_category,style_confidence,style_signals_json,download_status,discovered_at,updated_at)
          VALUES(:id,:url,:prompt,:negative,:tags,:model,:creator,:loras,:reactions,:width,:height,:category,:confidence,:signals,'pending',:now,:now)
          ON CONFLICT(image_id) DO UPDATE SET source_url=excluded.source_url,prompt=excluded.prompt,negative_prompt=excluded.negative_prompt,tags_json=excluded.tags_json,model_name=excluded.model_name,creator_name=excluded.creator_name,loras_json=excluded.loras_json,reactions_json=excluded.reactions_json,image_width=excluded.image_width,image_height=excluded.image_height,style_category=excluded.style_category,style_confidence=excluded.style_confidence,style_signals_json=excluded.style_signals_json,updated_at=excluded.updated_at");
        $ftsDel=$pdo->prepare('DELETE FROM images_fts WHERE image_id=?');
        $ftsIns=$pdo->prepare('INSERT INTO images_fts(image_id,prompt,negative_prompt,tags,model_name,lora_names) VALUES(?,?,?,?,?,?)');
        $eligibleIds=[];
        foreach ($items as $item) {
            if (!is_array($item) || !valid_image_id($item['id']??null) || !safe_image_url($item['downloadUrl']??$item['sourceUrl']??null)) continue;
            $id=(string)$item['id'];
            $prompt=cut_text(trim(is_string($item['prompt']??null)?$item['prompt']:''),20000);
            if (has_positive_prompt($prompt)) $eligibleIds[$id]=true;
            else {
                $existing->execute([$id]); $prior=$existing->fetch();
                if ($prior && has_positive_prompt((string)$prior['prompt'])) $eligibleIds[$id]=true;
            }
        }
        // Rejected new promptless records cannot leave arbitrary lock files. Only process IDs
        // selected here, even if another request creates a usable record before our transaction.
        $locks=$eligibleIds ? lock_image_ids(array_keys($eligibleIds)) : [];
        try {
            $inspections=[];
            foreach (array_keys($eligibleIds) as $id) {
                $existing->execute([(string)$id]); $storedRow=$existing->fetch(); $existing->closeCursor();
                $inspections[$id]=$storedRow ? inspect_image_storage($storedRow) : null;
            }
            $pdo->beginTransaction();
            foreach ($items as $item) {
                if (!is_array($item) || !valid_image_id($item['id']??null) || !isset($eligibleIds[(string)$item['id']]) || !($url=safe_image_url($item['downloadUrl']??$item['sourceUrl']??null))) { $skipped++; continue; }
                $prompt=cut_text(trim(is_string($item['prompt']??null)?$item['prompt']:''),20000); $negative=cut_text(trim((string)($item['negativePrompt']??'')),10000);
                $tags=normalize_strings($item['tags']??[]); $loras=normalize_strings($item['loras']??[]); $model=cut_text(trim((string)($item['modelName']??'')),300);
                $creator=normalize_creator_name($item['creatorName']??null);
                $reactions=normalize_reactions($item['reactions']??null); $width=image_dimension($item['width']??null); $height=image_dimension($item['height']??null);
                $existing->execute([(string)$item['id']]); $prior=$existing->fetch();
                if (image_size_exceeds_limits($item['width']??0,$item['height']??0)) {
                    skip_image_collection($pdo,(string)$item['id'],$item['width']??0,$item['height']??0);
                    $skipped++; $skippedItems[]=['imageId'=>(string)$item['id'],'reason'=>'oversize']; continue;
                }
                if ($prior) {
                    if (!has_positive_prompt($prompt)) $prompt=(string)$prior['prompt'];
                    if ($negative==='') $negative=(string)$prior['negative_prompt'];
                    if (!$tags) $tags=json_decode($prior['tags_json'],true) ?: [];
                    if (!$loras) $loras=json_decode($prior['loras_json'],true) ?: [];
                    if ($model==='') $model=(string)$prior['model_name'];
                    if ($creator==='') $creator=(string)$prior['creator_name'];
                    $reactions=array_replace(json_decode($prior['reactions_json'],true) ?: [],$reactions);
                    if (!$width) $width=(int)$prior['image_width'];
                    if (!$height) $height=(int)$prior['image_height'];
                }
                if (!has_positive_prompt($prompt)) { $skipped++; continue; }
                if (image_size_exceeds_limits($width,$height)) {
                    skip_image_collection($pdo,(string)$item['id'],$width,$height);
                    $skipped++; $skippedItems[]=['imageId'=>(string)$item['id'],'reason'=>'oversize']; continue;
                }
                $storage=check_image_storage($pdo,$prior?:null,(string)$item['id'],$inspections[(string)$item['id']]??null);
                if ($storage['downloadStatus']==='skipped') {
                    $skipped++; $skippedItems[]=['imageId'=>(string)$item['id'],'reason'=>'oversize']; continue;
                }
                $style=classify_style($prompt,$model,$loras,$tags);
                $values=[':id'=>(string)$item['id'],':url'=>$url,':prompt'=>$prompt,':negative'=>$negative,':tags'=>json_encode($tags),':model'=>$model,':creator'=>$creator,':loras'=>json_encode($loras),':reactions'=>json_encode((object)$reactions),':width'=>$width,':height'=>$height,':category'=>$style['category'],':confidence'=>$style['confidence'],':signals'=>json_encode($style['signals']),':now'=>$now];
                $searchFields=[$prompt,$negative,implode(' ',$tags),$model,implode(' ',$loras)];
                $priorSearchFields=$prior ? [(string)$prior['prompt'],(string)$prior['negative_prompt'],implode(' ',json_decode($prior['tags_json'],true)?:[]),(string)$prior['model_name'],implode(' ',json_decode($prior['loras_json'],true)?:[])] : null;
                $upsert->execute($values);
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
            $pdo->commit();
        } catch (Throwable $error) { if ($pdo->inTransaction()) $pdo->rollBack(); throw $error; }
        finally { unlock_image_ids($locks); }
        json_response(['ok'=>true,'accepted'=>$saved,'skipped'=>$skipped,'skippedItems'=>$skippedItems,'imageCopiesQueued'=>count($queuedIds)]);
    }
    json_response(['ok'=>false,'error'=>'Not found.'],404);
} catch (DownloadLaneCapacity $error) {
    header('Retry-After: 60'); json_response(['ok'=>false,'error'=>$error->getMessage()],503);
} catch (StorageLockBusy $error) {
    header('Retry-After: 2'); json_response(['ok'=>false,'error'=>'Image storage is busy; retry this batch shortly.'],503);
} catch (Throwable $error) {
    if ($error instanceof PDOException && in_array(((int)($error->errorInfo[1]??0))&255,[5,6],true)) {
        header('Retry-After: 2'); json_response(['ok'=>false,'error'=>'Catalog storage is busy; retry this batch shortly.'],503);
    }
    error_log('Civitai library API error: ' . $error->getMessage());
    json_response(['ok'=>false,'error'=>'The catalog request could not be completed.'],500);
}
