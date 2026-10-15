<?php
declare(strict_types=1);
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
require __DIR__.'/lib.php';
require_once __DIR__.'/style-classifier.php';
$apply = in_array('--apply', $argv, true);
$uncertainOnly = in_array('--uncertain-only', $argv, true);
$cfg = config();
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
