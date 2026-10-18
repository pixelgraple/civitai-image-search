<?php
declare(strict_types=1);

/** Keep request accounting independent of the image catalog's writer lock. */
function ingest_limits_db(): PDO {
    static $connection;
    if ($connection instanceof PDO) return $connection;
    $catalog=(string)(config()['database_path']??'');
    if ($catalog==='' || !str_starts_with($catalog,'/')) throw new RuntimeException('Database path must be absolute.');
    $dir=dirname($catalog);
    if (!is_dir($dir) && !mkdir($dir,0750,true) && !is_dir($dir)) throw new RuntimeException('Could not create database directory.');
    $path=$catalog.'.ingest-limits.sqlite';
    if (is_link($path)) throw new RuntimeException('Invalid indexing limit database.');
    $new=!is_file($path);
    $pdo=new PDO('sqlite:'.$path,null,null,[PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION,PDO::ATTR_DEFAULT_FETCH_MODE=>PDO::FETCH_ASSOC]);
    if ($new) @chmod($path,0640);
    $pdo->exec('PRAGMA busy_timeout=5000');
    if (strtolower((string)$pdo->query('PRAGMA journal_mode')->fetchColumn())!=='wal') $pdo->exec('PRAGMA journal_mode=WAL');
    $version=(int)$pdo->query('PRAGMA user_version')->fetchColumn();
    if ($version===0) {
        $pdo->exec('BEGIN IMMEDIATE');
        try {
            // A concurrent first request may have finished setup while we waited.
            if ((int)$pdo->query('PRAGMA user_version')->fetchColumn()===0) {
                $pdo->exec('CREATE TABLE ingest_request_windows (contributor_id TEXT PRIMARY KEY, window_start INTEGER NOT NULL, request_count INTEGER NOT NULL);
                    CREATE INDEX ingest_request_windows_expiry ON ingest_request_windows(window_start)');
                // Carry existing quotas forward once, without taking the catalog writer.
                // Keep the old table for rollback compatibility; it is no longer written.
                if (is_file($catalog)) {
                    $old=new PDO('sqlite:'.$catalog,null,null,[PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION]);
                    $old->exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000');
                    if ($old->query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ingest_request_windows'")->fetchColumn()) {
                        $window=intdiv(time(),60)*60;
                        $read=$old->prepare('SELECT contributor_id,window_start,request_count FROM ingest_request_windows WHERE window_start=? LIMIT 100000');
                        $read->execute([$window]);
                        $insert=$pdo->prepare('INSERT INTO ingest_request_windows VALUES(?,?,?)');
                        while ($row=$read->fetch(PDO::FETCH_NUM)) $insert->execute($row);
                        $read->closeCursor();
                    }
                    $old=null;
                }
                $pdo->exec('PRAGMA user_version=1');
            }
            $pdo->exec('COMMIT');
        } catch (Throwable $error) { $pdo->exec('ROLLBACK'); throw $error; }
    } elseif ($version!==1) throw new RuntimeException('Unsupported indexing limit database version.');
    return $connection=$pdo;
}
