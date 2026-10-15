<?php
declare(strict_types=1);
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
require __DIR__.'/lib.php';
require_once __DIR__.'/style-classifier.php';
$apply = in_array('--apply', $argv, true);
$uncertainOnly = in_array('--uncertain-only', $argv, true);
$cfg = config();
// Live catalogs use short, optimistic updates so ingestion can continue. The
// original exclusive mode remains available for offline preservation audits.
if (in_array('--online', $argv, true)) {
    reclassification_online($cfg, $apply, $uncertainOnly, $argv);
    exit;
}
$pdo = new PDO('sqlite:'.$cfg['database_path'], null, null, [PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE=>PDO::FETCH_ASSOC]);
$pdo->exec('PRAGMA busy_timeout=15000');
if (!$apply) $pdo->exec('PRAGMA query_only=ON');
$pdo->exec($apply ? 'BEGIN IMMEDIATE' : 'BEGIN');
try {
    $before=[]; $after=[]; $transitions=[]; $changed=[]; $count=0; $metadataUpdates=0;
    $update=$apply ? $pdo->prepare('UPDATE images SET style_category=?,style_confidence=?,style_signals_json=? WHERE image_id=?') : null;
    $rows=$pdo->query('SELECT * FROM images ORDER BY image_id')->fetchAll();
    $relatedBefore=reclassification_related_digest($pdo);
    $preservedBefore=hash_init('sha256');
    foreach ($rows as $row) {
        $unchanged=$row; unset($unchanged['style_category'],$unchanged['style_confidence'],$unchanged['style_signals_json']);
        hash_update($preservedBefore,json_encode($unchanged,JSON_UNESCAPED_SLASHES|JSON_THROW_ON_ERROR));
        if ($uncertainOnly && $row['style_category'] !== 'uncertain') {
            $old=$row['style_category']; $count++;
            $before[$old]=($before[$old]??0)+1; $after[$old]=($after[$old]??0)+1;
            $transition=$old.' -> '.$old; $transitions[$transition]=($transitions[$transition]??0)+1;
            continue;
        }
        $style=classify_style((string)$row['prompt'],(string)$row['model_name'],json_decode($row['loras_json'],true)?:[],json_decode($row['tags_json'],true)?:[]);
        $old=$row['style_category']; $new=$style['category']; $count++;
        $before[$old]=($before[$old]??0)+1; $after[$new]=($after[$new]??0)+1;
        $transition=$old.' -> '.$new; $transitions[$transition]=($transitions[$transition]??0)+1;
        if ($old!==$new) $changed[]=['imageId'=>$row['image_id'],'from'=>$old,'to'=>$new];
        $signals=json_encode($style['signals'],JSON_UNESCAPED_SLASHES|JSON_THROW_ON_ERROR);
        if ($old!==$new || (float)$row['style_confidence']!==(float)$style['confidence'] || $row['style_signals_json']!==$signals) {
            $metadataUpdates++;
            if ($apply) $update->execute([$new,$style['confidence'],$signals,$row['image_id']]);
        }
    }
    $preservedDigest=hash_final($preservedBefore);
    if ($apply) {
        $preservedAfter=hash_init('sha256');
        foreach ($pdo->query('SELECT * FROM images ORDER BY image_id') as $row) {
            unset($row['style_category'],$row['style_confidence'],$row['style_signals_json']);
            hash_update($preservedAfter,json_encode($row,JSON_UNESCAPED_SLASHES|JSON_THROW_ON_ERROR));
        }
        if (!hash_equals($preservedDigest,hash_final($preservedAfter))) throw new RuntimeException('Non-style catalog fields changed; rolling back.');
        if (!hash_equals($relatedBefore,reclassification_related_digest($pdo))) throw new RuntimeException('Search index or community reactions changed; rolling back.');
    }
    $pdo->exec('COMMIT');
    ksort($before);ksort($after);ksort($transitions);
    echo json_encode(['ok'=>true,'applied'=>$apply,'scope'=>$uncertainOnly?'uncertain':'all','classifierVersion'=>CIVITAI_STYLE_CLASSIFIER_VERSION,'rows'=>$count,'changedCategories'=>count($changed),'updatedStyleMetadata'=>$metadataUpdates,'before'=>$before,'after'=>$after,'transitions'=>$transitions,'changedExamples'=>array_slice($changed,0,30),'nonStyleFieldsSha256'=>$preservedDigest,'relatedTablesSha256'=>$relatedBefore],JSON_PRETTY_PRINT|JSON_UNESCAPED_SLASHES|JSON_THROW_ON_ERROR)."\n";
} catch (Throwable $error) {
    $pdo->exec('ROLLBACK');fwrite(STDERR,$error->getMessage()."\n");exit(1);
}

function reclassification_related_digest(PDO $pdo): string {
    $hash=hash_init('sha256');
    foreach (['images_fts'=>'image_id','community_reactions'=>'image_id,visitor_hash,reaction_type','community_reaction_counts'=>'image_id'] as $table=>$order) {
        hash_update($hash,$table);
        foreach ($pdo->query('SELECT * FROM '.$table.' ORDER BY '.$order) as $row) hash_update($hash,json_encode($row,JSON_UNESCAPED_SLASHES|JSON_THROW_ON_ERROR));
    }
    return hash_final($hash);
}

/** Reclassify a bounded catalog snapshot without holding a writer lock to read prompts. */
function reclassification_online(array $cfg, bool $apply, bool $uncertainOnly, array $arguments): void {
    $startedAt = gmdate('c');
    $started = microtime(true);
    $batchSize = 100;
    $report = [
        'ok'=>false, 'applied'=>$apply, 'mode'=>'online', 'scope'=>$uncertainOnly ? 'uncertain' : 'all',
        'classifierVersion'=>CIVITAI_STYLE_CLASSIFIER_VERSION,
        'minimumIndependentAnimeCues'=>defined('CIVITAI_STYLE_ANIME_MINIMUM_CUES') ? CIVITAI_STYLE_ANIME_MINIMUM_CUES : null,
        'startedAt'=>$startedAt, 'snapshotUpperRowid'=>0, 'snapshotRows'=>0,
        'rows'=>0, 'resolvedRows'=>0, 'changedCategories'=>0, 'updatedStyleMetadata'=>0,
        'before'=>[], 'after'=>[], 'transitions'=>[], 'changedExamples'=>[],
        'sourceAnimeRows'=>0, 'sourceAnimeCorrectedToRealistic'=>0, 'sourceAnimeCorrectedExamples'=>[],
        'concurrentConflictsEncountered'=>0, 'unresolvedConflicts'=>[],
        'updatedColumns'=>['style_category','style_confidence','style_signals_json'],
    ];
    try {
        foreach ($arguments as $argument) {
            if (!str_starts_with($argument, '--batch-size=')) continue;
            $value = substr($argument, strlen('--batch-size='));
            if (!ctype_digit($value) || (int)$value < 1 || (int)$value > 500) {
                throw new InvalidArgumentException('Batch size must be between 1 and 500.');
            }
            $batchSize = (int)$value;
        }
        $path = (string)($cfg['database_path'] ?? '');
        if ($path === '' || !is_file($path)) throw new RuntimeException('The existing catalog database was not found.');
        $pdo = new PDO('sqlite:'.$path, null, null, [PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE=>PDO::FETCH_ASSOC]);
        $pdo->exec('PRAGMA busy_timeout=5000');
        if (!$apply) $pdo->exec('PRAGMA query_only=ON');
        $report['batchSize'] = $batchSize;
        $report['snapshotUpperRowid'] = (int)$pdo->query('SELECT COALESCE(MAX(rowid),0) FROM images')->fetchColumn();
        $report['snapshotRows'] = (int)$pdo->query('SELECT COUNT(*) FROM images WHERE rowid<='.$report['snapshotUpperRowid'])->fetchColumn();
        $columns = 'rowid AS catalog_rowid,image_id,prompt,model_name,loras_json,tags_json,style_category,style_confidence,style_signals_json';
        $scan = $pdo->prepare('SELECT '.$columns.' FROM images WHERE rowid>? AND rowid<=? ORDER BY rowid LIMIT ?');
        $find = $pdo->prepare('SELECT '.$columns.' FROM images WHERE rowid=? AND image_id=?');
        $update = $pdo->prepare('UPDATE images SET style_category=?,style_confidence=?,style_signals_json=? WHERE rowid=? AND image_id=? AND prompt=? AND model_name=? AND loras_json=? AND tags_json=? AND style_category=? AND style_confidence=? AND style_signals_json=?');
        $lastRowid = 0;
        $lastProgressAt = microtime(true);
        $lastProgressRows = 0;
        fwrite(STDERR, json_encode(['event'=>'started','applied'=>$apply,'snapshotRows'=>$report['snapshotRows'],'snapshotUpperRowid'=>$report['snapshotUpperRowid'],'batchSize'=>$batchSize], JSON_THROW_ON_ERROR)."\n");
        while ($lastRowid < $report['snapshotUpperRowid']) {
            $scan->bindValue(1, $lastRowid, PDO::PARAM_INT);
            $scan->bindValue(2, $report['snapshotUpperRowid'], PDO::PARAM_INT);
            $scan->bindValue(3, $batchSize, PDO::PARAM_INT);
            $scan->execute();
            $rows = $scan->fetchAll();
            $scan->closeCursor();
            if (!$rows) break;
            $lastRowid = (int)$rows[array_key_last($rows)]['catalog_rowid'];
            $report['rows'] += count($rows);
            $pending = [];
            foreach ($rows as $row) {
                $plan = reclassification_online_plan($row, $uncertainOnly);
                if (!$apply || !$plan['changed']) {
                    reclassification_online_record($report, $plan);
                } else {
                    $pending[] = $plan;
                }
            }
            // Source/style guards reject a stale calculation if an extension or
            // repair worker updated this row after it was read. Re-read outside
            // the transaction, then retry at most three times.
            for ($attempt = 0; $pending && $attempt < 4; $attempt++) {
                $conflicts = reclassification_online_write($pdo, $update, $pending);
                foreach ($pending as $plan) {
                    if (!isset($conflicts[(string)$plan['row']['image_id']])) reclassification_online_record($report, $plan);
                }
                $report['concurrentConflictsEncountered'] += count($conflicts);
                $pending = [];
                foreach ($conflicts as $row) {
                    if ($attempt === 3) {
                        $report['unresolvedConflicts'][] = ['imageId'=>(string)$row['image_id'],'reason'=>'Source or style kept changing during four attempts.'];
                        continue;
                    }
                    $find->execute([(int)$row['catalog_rowid'],(string)$row['image_id']]);
                    $fresh = $find->fetch();
                    $find->closeCursor();
                    if (!$fresh) {
                        $report['unresolvedConflicts'][] = ['imageId'=>(string)$row['image_id'],'reason'=>'Image was removed during reclassification.'];
                        continue;
                    }
                    $plan = reclassification_online_plan($fresh, $uncertainOnly);
                    if (!$plan['changed']) reclassification_online_record($report, $plan);
                    else $pending[] = $plan;
                }
            }
            if ($report['rows'] - $lastProgressRows >= 1000 || microtime(true) - $lastProgressAt >= 5) {
                fwrite(STDERR, json_encode(['event'=>'progress','rows'=>$report['rows'],'snapshotRows'=>$report['snapshotRows'],'changedCategories'=>$report['changedCategories'],'updatedStyleMetadata'=>$report['updatedStyleMetadata'],'unresolvedConflicts'=>count($report['unresolvedConflicts'])], JSON_THROW_ON_ERROR)."\n");
                $lastProgressAt = microtime(true);
                $lastProgressRows = $report['rows'];
            }
            if ($apply) usleep(10000); // Give normal catalog writes a turn between batches.
        }
        $report['currentCatalogCounts'] = [];
        foreach ($pdo->query('SELECT style_category,COUNT(*) total FROM images GROUP BY style_category') as $row) {
            $report['currentCatalogCounts'][(string)$row['style_category']] = (int)$row['total'];
        }
        $report['ok'] = !$report['unresolvedConflicts'];
    } catch (Throwable $error) {
        $report['error'] = $error->getMessage();
        fwrite(STDERR, "Online reclassification stopped. Earlier applied batches remain committed; rerunning is safe.\n");
    }
    foreach (['before','after','transitions'] as $key) ksort($report[$key]);
    $report['elapsedSeconds'] = round(microtime(true) - $started, 3);
    echo json_encode($report, JSON_PRETTY_PRINT|JSON_UNESCAPED_SLASHES|JSON_THROW_ON_ERROR)."\n";
    if (!$report['ok']) exit(1);
}

function reclassification_online_plan(array $row, bool $uncertainOnly): array {
    $old = (string)$row['style_category'];
    if ($uncertainOnly && $old !== 'uncertain') {
        return ['row'=>$row,'category'=>$old,'confidence'=>(float)$row['style_confidence'],'signals'=>(string)$row['style_signals_json'],'changed'=>false];
    }
    $loras = json_decode((string)$row['loras_json'], true);
    $tags = json_decode((string)$row['tags_json'], true);
    if (!is_array($loras) || !is_array($tags)) throw new RuntimeException('Invalid stored classifier inputs for image '.(string)$row['image_id']);
    $style = classify_style((string)$row['prompt'], (string)$row['model_name'], $loras, $tags);
    $signals = json_encode($style['signals'], JSON_UNESCAPED_SLASHES|JSON_THROW_ON_ERROR);
    return ['row'=>$row,'category'=>$style['category'],'confidence'=>$style['confidence'],'signals'=>$signals,
        'changed'=>$old !== $style['category'] || (float)$row['style_confidence'] !== (float)$style['confidence'] || (string)$row['style_signals_json'] !== $signals];
}

/** Write only style fields; no classification, metadata reads or FTS work under this lock. */
function reclassification_online_write(PDO $pdo, PDOStatement $update, array $plans): array {
    $conflicts = [];
    $transaction = false;
    try {
        $pdo->exec('BEGIN IMMEDIATE');
        $transaction = true;
        foreach ($plans as $plan) {
            $row = $plan['row'];
            $update->execute([$plan['category'],$plan['confidence'],$plan['signals'],(int)$row['catalog_rowid'],
                $row['image_id'],$row['prompt'],$row['model_name'],$row['loras_json'],$row['tags_json'],
                $row['style_category'],$row['style_confidence'],$row['style_signals_json']]);
            if ($update->rowCount() !== 1) $conflicts[(string)$row['image_id']] = $row;
        }
        $pdo->exec('COMMIT');
        $transaction = false;
    } catch (Throwable $error) {
        if ($transaction) $pdo->exec('ROLLBACK');
        throw $error;
    }
    return $conflicts;
}

function reclassification_online_record(array &$report, array $plan): void {
    $row = $plan['row'];
    $old = (string)$row['style_category'];
    $new = (string)$plan['category'];
    $report['resolvedRows']++;
    $report['before'][$old] = ($report['before'][$old] ?? 0) + 1;
    $report['after'][$new] = ($report['after'][$new] ?? 0) + 1;
    $transition = $old.' -> '.$new;
    $report['transitions'][$transition] = ($report['transitions'][$transition] ?? 0) + 1;
    if ($plan['changed']) $report['updatedStyleMetadata']++;
    if ($old !== $new) {
        $report['changedCategories']++;
        if (count($report['changedExamples']) < 30) $report['changedExamples'][] = ['imageId'=>(string)$row['image_id'],'from'=>$old,'to'=>$new];
    }
    if (preg_match('~\bsource[ _-]+anime\b~i', implode(' ', [$row['prompt'],$row['model_name'],$row['loras_json'],$row['tags_json']]))) {
        $report['sourceAnimeRows']++;
        if ($old === 'anime' && $new === 'realistic') {
            $report['sourceAnimeCorrectedToRealistic']++;
            if (count($report['sourceAnimeCorrectedExamples']) < 30) $report['sourceAnimeCorrectedExamples'][] = (string)$row['image_id'];
        }
    }
}
