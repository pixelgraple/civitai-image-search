<?php
declare(strict_types=1);

// Private worker entry point. Never expose a catalog repair through HTTP.
if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}
ini_set('display_errors', 'stderr');
require_once __DIR__ . '/lib.php';

function repair_reply(array $result, int $exitCode = 0): never {
    echo json_encode($result, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE | JSON_THROW_ON_ERROR) . "\n";
    exit($exitCode);
}

function repair_text(mixed $value, int $limit): string {
    if (!is_string($value) || !preg_match('//u', $value) || str_contains($value, "\0")) return '';
    return cut_text(trim($value), $limit);
}

/** Preserve every stored name and its spelling; only append newly observed names. */
function repair_union_names(array $prior, array $observed): array {
    $merged = $prior;
    $known = [];
    foreach ($prior as $name) {
        if (is_string($name)) $known[lower_text(trim($name))] = true;
    }
    foreach ($observed as $name) {
        $key = lower_text(trim($name));
        if (isset($known[$key])) continue;
        $known[$key] = true;
        $merged[] = $name;
    }
    return array_values($merged);
}

function repair_stored_names(string $json): array {
    $names = json_decode($json, true);
    if (!is_array($names)) return [];
    return array_values(array_filter($names, static fn($name) => is_string($name) && trim($name) !== ''));
}

function repair_missing_fields(array $record): array {
    $missing = [];
    if (trim($record['creatorName']) === '') $missing[] = 'creatorName';
    if (!has_positive_prompt($record['prompt'])) $missing[] = 'prompt';
    if (trim($record['modelName']) === '') $missing[] = 'modelName';
    if (!$record['loras']) $missing[] = 'loras';
    if (!$record['tags']) $missing[] = 'tags';
    if (source_reactions_missing($record['reactions'])) $missing[] = 'reactions';
    return $missing;
}

function repair_connection(string $path, bool $readonly = false): PDO {
    $connection = new PDO('sqlite:' . $path, null, null, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::SQLITE_ATTR_OPEN_FLAGS => $readonly ? PDO::SQLITE_OPEN_READONLY : PDO::SQLITE_OPEN_READWRITE,
    ]);
    $connection->exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    return $connection;
}

function repair_check_schema(PDO $connection): void {
    $tables = [
        'images' => ['image_id', 'prompt', 'negative_prompt', 'model_name', 'creator_name', 'loras_json',
            'tags_json', 'reactions_json', 'style_category', 'style_confidence', 'style_signals_json', 'updated_at'],
        'images_fts' => ['image_id', 'prompt', 'negative_prompt', 'tags', 'model_name', 'lora_names'],
        'image_collection_skips' => ['image_id'],
    ];
    foreach ($tables as $table => $required) {
        // Names come only from the fixed schema list above.
        $columns = array_column($connection->query('PRAGMA table_info(' . $table . ')')->fetchAll(), 'name');
        if (array_diff($required, $columns)) {
            repair_reply(['ok' => false, 'error' => 'Configured catalog is missing required metadata fields.', 'code' => 'catalog_schema'], 2);
        }
    }
    $definition = $connection->query("SELECT sql FROM sqlite_master WHERE type='table' AND name='images_fts'")->fetchColumn();
    if (!is_string($definition) || !preg_match('/\\bUSING\\s+fts5\\s*\\(/i', $definition)) {
        repair_reply(['ok' => false, 'error' => 'Configured catalog does not have its expected search index.', 'code' => 'catalog_schema'], 2);
    }
}

$pdo = null;
$transaction = false;
try {
    if (!in_array($argc, [3, 4], true) || $argv[1] !== '--catalog' || !str_starts_with($argv[2], '/') ||
        ($argc === 4 && $argv[3] !== '--check')) {
        repair_reply(['ok' => false, 'error' => 'Expected --catalog with an existing absolute catalog path.', 'code' => 'invalid_arguments'], 2);
    }
    $configPath = getenv('CIVITAI_LIBRARY_CONFIG');
    if (!is_string($configPath) || !str_starts_with($configPath, '/') || !is_file($configPath)) {
        repair_reply(['ok' => false, 'error' => 'An existing absolute CIVITAI_LIBRARY_CONFIG is required.', 'code' => 'invalid_config'], 2);
    }
    $cfg = config();
    $configuredPath = $cfg['database_path'] ?? null;
    $expectedPath = realpath($argv[2]);
    if (!is_string($configuredPath) || !str_starts_with($configuredPath, '/') || !is_file($configuredPath) ||
        $expectedPath === false || !is_file($expectedPath) || realpath($configuredPath) !== $expectedPath) {
        repair_reply(['ok' => false, 'error' => 'Configured catalog does not match the existing worker catalog.', 'code' => 'catalog_mismatch'], 2);
    }
    if ($argc === 4) {
        $pdo = repair_connection($expectedPath, true);
        repair_check_schema($pdo);
        repair_reply(['ok' => true, 'outcome' => 'ready']);
    }

    $raw = stream_get_contents(STDIN, 262145);
    if ($raw === false || strlen($raw) > 262144) {
        repair_reply(['ok' => false, 'error' => 'Record exceeds the 262144 byte limit.', 'code' => 'invalid_record'], 2);
    }
    $input = json_decode($raw, true, 64, JSON_THROW_ON_ERROR);
    if (!is_array($input) || array_is_list($input) || !valid_image_id($input['id'] ?? null)) {
        repair_reply(['ok' => false, 'error' => 'Expected one image record with a valid id.', 'code' => 'invalid_record'], 2);
    }
    $id = (string)$input['id'];
    $observed = [
        'creatorName' => normalize_creator_name($input['creatorName'] ?? null),
        'prompt' => repair_text($input['prompt'] ?? null, 20000),
        'negativePrompt' => repair_text($input['negativePrompt'] ?? null, 10000),
        'modelName' => repair_text($input['modelName'] ?? null, 300),
        'loras' => normalize_strings($input['loras'] ?? []),
        'tags' => normalize_strings($input['tags'] ?? []),
        'reactions' => normalize_reactions($input['reactions'] ?? null),
    ];

    // The validated catalog already exists. Opening it directly avoids running schema
    // migrations for every repaired image or creating a new catalog by mistake.
    $pdo = repair_connection($expectedPath);
    $pdo->exec('BEGIN IMMEDIATE');
    $transaction = true;
    $find = $pdo->prepare('SELECT image_id,prompt,negative_prompt,model_name,creator_name,loras_json,tags_json,reactions_json,style_category,style_confidence,style_signals_json FROM images WHERE image_id=?');
    $find->execute([$id]);
    $row = $find->fetch();
    $find->closeCursor();
    $skip = $pdo->prepare('SELECT 1 FROM image_collection_skips WHERE image_id=?');
    $skip->execute([$id]);
    $terminalSkip = (bool)$skip->fetchColumn();
    $skip->closeCursor();
    if (!$row || $terminalSkip) {
        $pdo->exec('COMMIT');
        $transaction = false;
        repair_reply(['ok' => true, 'outcome' => 'removed', 'changedFields' => [], 'missingFields' => [],
            'counts' => ['fieldsUpdated' => 0, 'lorasAdded' => 0, 'tagsAdded' => 0, 'reactionsAdded' => 0]]);
    }

    $prior = [
        'creatorName' => (string)$row['creator_name'],
        'prompt' => (string)$row['prompt'],
        'negativePrompt' => (string)$row['negative_prompt'],
        'modelName' => (string)$row['model_name'],
        'loras' => repair_stored_names((string)$row['loras_json']),
        'tags' => repair_stored_names((string)$row['tags_json']),
        'reactions' => normalize_reactions(json_decode((string)$row['reactions_json'], true)),
    ];
    $merged = $prior;
    foreach (['creatorName', 'prompt', 'negativePrompt', 'modelName'] as $field) {
        if (trim($prior[$field]) === '' && $observed[$field] !== '') $merged[$field] = $observed[$field];
    }
    foreach (['loras', 'tags'] as $field) $merged[$field] = repair_union_names($prior[$field], $observed[$field]);
    // A background visit has no reliable source timestamp. Preserve every known count,
    // including explicit zero, so this repair cannot replace a newer extension snapshot.
    $merged['reactions'] = $prior['reactions'] + $observed['reactions'];

    $columns = ['creatorName' => 'creator_name', 'prompt' => 'prompt', 'negativePrompt' => 'negative_prompt',
        'modelName' => 'model_name', 'loras' => 'loras_json', 'tags' => 'tags_json', 'reactions' => 'reactions_json'];
    $changedFields = [];
    $assignments = [];
    $values = [];
    foreach ($columns as $field => $column) {
        if ($merged[$field] === $prior[$field]) continue;
        $changedFields[] = $field;
        $assignments[] = $column . '=?';
        $values[] = is_array($merged[$field])
            ? json_encode($field === 'reactions' ? (object)$merged[$field] : $merged[$field], JSON_THROW_ON_ERROR)
            : $merged[$field];
    }
    $searchChanged = (bool)array_intersect(['prompt', 'negativePrompt', 'modelName', 'loras', 'tags'], $changedFields);
    if (array_intersect(['prompt', 'modelName', 'loras', 'tags'], $changedFields)) {
        $style = classify_style($merged['prompt'], $merged['modelName'], $merged['loras'], $merged['tags']);
        if ($style['category'] !== $row['style_category'] || (float)$style['confidence'] !== (float)$row['style_confidence'] ||
            $style['signals'] !== json_decode((string)$row['style_signals_json'], true)) {
            $assignments[] = 'style_category=?';
            $assignments[] = 'style_confidence=?';
            $assignments[] = 'style_signals_json=?';
            array_push($values, $style['category'], $style['confidence'], json_encode($style['signals'], JSON_THROW_ON_ERROR));
            $changedFields[] = 'classification';
        }
    }
    if ($assignments) {
        $assignments[] = 'updated_at=?';
        array_push($values, gmdate('c'), $id);
        $pdo->prepare('UPDATE images SET ' . implode(',', $assignments) . ' WHERE image_id=?')->execute($values);
    }
    if ($searchChanged) {
        $pdo->prepare('DELETE FROM images_fts WHERE image_id=?')->execute([$id]);
        $pdo->prepare('INSERT INTO images_fts(image_id,prompt,negative_prompt,tags,model_name,lora_names) VALUES(?,?,?,?,?,?)')
            ->execute([$id, $merged['prompt'], $merged['negativePrompt'], implode(' ', $merged['tags']), $merged['modelName'], implode(' ', $merged['loras'])]);
    }
    $pdo->exec('COMMIT');
    $transaction = false;
    $missingFields = repair_missing_fields($merged);
    $observedAny = (bool)array_filter($observed, static fn($value) => $value !== '' && $value !== []);
    repair_reply([
        'ok' => true,
        'outcome' => !$missingFields ? 'done' : ($observedAny ? 'partial' : 'unavailable'),
        'changedFields' => $changedFields,
        'missingFields' => $missingFields,
        'counts' => ['fieldsUpdated' => count($changedFields), 'lorasAdded' => count($merged['loras']) - count($prior['loras']),
            'tagsAdded' => count($merged['tags']) - count($prior['tags']), 'reactionsAdded' => count($merged['reactions']) - count($prior['reactions'])],
    ]);
} catch (JsonException $error) {
    if ($transaction && $pdo instanceof PDO) {
        try { $pdo->exec('ROLLBACK'); } catch (Throwable $ignored) {}
    }
    repair_reply(['ok' => false, 'error' => 'Record is not valid JSON.', 'code' => 'invalid_record'], 2);
} catch (Throwable $error) {
    if ($transaction && $pdo instanceof PDO) {
        try { $pdo->exec('ROLLBACK'); } catch (Throwable $ignored) {}
    }
    $busy = $error instanceof PDOException && in_array(((int)($error->errorInfo[1] ?? 0)) & 255, [5, 6], true);
    repair_reply(['ok' => false, 'error' => $busy ? 'Catalog is busy; retry this record.' : 'Metadata repair could not be completed.',
        'code' => $busy ? 'catalog_busy' : 'repair_failed', 'retryable' => $busy], 1);
}
