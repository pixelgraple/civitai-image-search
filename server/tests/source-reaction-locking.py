#!/usr/bin/env python3
"""Exercise reaction writes against a held WAL writer using an isolated catalog."""
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile

PHP = os.environ.get('PHP_BINARY', 'php')
LIB = Path(os.environ.get('REACTION_TEST_LIB', Path(__file__).resolve().parents[1] / 'lib.php'))

with tempfile.TemporaryDirectory(prefix='civitai-reaction-locking-') as directory:
    root = Path(directory)
    database = root / 'fixture.sqlite'
    with sqlite3.connect(database) as db:
        db.execute('PRAGMA journal_mode=WAL')
        db.execute("CREATE TABLE images(image_id TEXT PRIMARY KEY,reactions_json TEXT,creator_name TEXT DEFAULT '',source_page_url TEXT DEFAULT '',updated_at TEXT)")
        db.executemany('INSERT INTO images(image_id,reactions_json) VALUES(?,?)', [('41', '{"likeCount":7}'), ('42', '{}')])
    runner = root / 'runner.php'
    runner.write_text('''<?php
require $argv[1];
$pdo=new PDO('sqlite:'.$argv[2],null,null,[PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION,PDO::ATTR_DEFAULT_FETCH_MODE=>PDO::FETCH_ASSOC]);
$pdo->exec('PRAGMA busy_timeout=2000');
echo "READY\\n"; fflush(STDOUT); fgets(STDIN);
$started=microtime(true);
try {
 $result=update_source_reactions($pdo,json_decode($argv[3],true,32,JSON_THROW_ON_ERROR));
 echo json_encode(['ok'=>true,'elapsed'=>microtime(true)-$started,'result'=>$result]);
} catch(Throwable $error) {
 echo json_encode(['ok'=>false,'error'=>$error->getMessage(),'elapsed'=>microtime(true)-$started]);
}
''')

    def start(items):
        child = subprocess.Popen([PHP, str(runner), str(LIB), str(database), json.dumps(items)],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        assert child.stdout.readline().strip() == 'READY'
        return child

    # Launch PHP before taking the writer lock, so process startup time cannot
    # hide a deferred read-to-write upgrade failure.
    child = start([{'id': '41', 'reactions': {'likeCount': 11}}])
    writer = sqlite3.connect(database)
    writer.execute('BEGIN IMMEDIATE')
    writer.execute('UPDATE images SET reactions_json=? WHERE image_id=?', ('{"likeCount":7,"heartCount":12}', '41'))
    child.stdin.write('GO\n'); child.stdin.flush()
    try:
        child.wait(timeout=.4)
        exited_while_locked = True
    except subprocess.TimeoutExpired:
        exited_while_locked = False
    finally:
        writer.commit(); writer.close()
    stdout, stderr = child.communicate(timeout=5)
    result = json.loads(stdout)
    assert not exited_while_locked and result['ok'], result
    with sqlite3.connect(database) as db:
        counts = json.loads(db.execute("SELECT reactions_json FROM images WHERE image_id='41'").fetchone()[0])
        assert counts == {'likeCount': 11, 'heartCount': 12}, counts
        db.execute("CREATE TRIGGER fail_second BEFORE UPDATE ON images WHEN NEW.image_id='42' BEGIN SELECT RAISE(ABORT,'fixture failure'); END")
    child = start([{'id': '41', 'reactions': {'likeCount': 999}}, {'id': '42', 'reactions': {'likeCount': 2}}])
    stdout, stderr = child.communicate('GO\n', timeout=5)
    assert not json.loads(stdout)['ok']
    with sqlite3.connect(database) as db:
        assert json.loads(db.execute("SELECT reactions_json FROM images WHERE image_id='41'").fetchone()[0]) == counts
        db.execute('DROP TRIGGER fail_second')
    child = start([{'id': '41', 'reactions': {'likeCount': 11}}])
    stdout, stderr = child.communicate('GO\n', timeout=5)
    assert json.loads(stdout)['result']['updated'] == 0
    print(json.dumps({'ok': True, 'checks': 4, 'suite': 'source-reaction-locking', 'productionTouched': False}))
