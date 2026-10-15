#!/usr/bin/env python3
"""Exercise the real worker against isolated SQLite writes; use a tiny fixture, no network."""
import base64
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent.parent
PHP = os.environ.get('PHP_BINARY', 'php')
PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='
checks = 0

def check(value, message):
    global checks
    if not value:
        raise AssertionError(message)
    checks += 1

def scenario(kind):
    with tempfile.TemporaryDirectory(prefix='civitai-worker-concurrency-') as temporary:
        temp = Path(temporary)
        app = temp / 'app'
        app.mkdir()
        media = temp / 'media'
        media.mkdir()
        database = temp / 'catalog.sqlite'
        for name in ('lib.php', 'schema.sql', 'style-classifier.php'):
            shutil.copy2(ROOT / name, app / name)
        settings = {'database_path': str(database), 'storage_dir': str(media)}
        (temp / 'settings.json').write_text(json.dumps(settings))
        config = temp / 'config.php'
        config.write_text("<?php return json_decode(file_get_contents(__DIR__.'/settings.json'),true);\n")
        with sqlite3.connect(database) as db:
            db.executescript((ROOT / 'schema.sql').read_text())
            db.execute("INSERT INTO images(image_id,source_url,prompt,discovered_at,updated_at) VALUES('41','https://image.civitai.com/fixture.png','photo fixture','fixture','fixture')")
            db.execute("INSERT INTO images(image_id,source_url,prompt,download_status,discovered_at,updated_at) VALUES('42','https://image.civitai.com/other.png','photo other','ready','fixture','fixture')")
        source = (ROOT / 'worker.php').read_text()
        source = re.sub(r'\bcurl_(init|setopt_array|getinfo|error|close|multi_[a-z_]+)\(', r'fixture_curl_\1(', source)
        writer = "$fixtureWriter=new PDO('sqlite:'.config()['database_path']); $fixtureWriter->setAttribute(PDO::ATTR_ERRMODE,PDO::ERRMODE_EXCEPTION);"
        source += '\n' + (ROOT / 'tests/worker-curl-fixture.php').read_text().removeprefix('<?php')
        if kind == 'write-after-size-query':
            marker = "            mark_stored_ready($pdo,$id,['path'=>$path"
            check(source.count(marker) == 1, 'storage write hook remains unique')
            source = source.replace(marker, '        ' + writer + "$fixtureWriter->exec(\"UPDATE images SET updated_at='concurrent-writer' WHERE image_id='42'\");\n" + marker)
        (app / 'worker.php').write_text(source)
        result = subprocess.run([PHP, str(app / 'worker.php'), '1'], env={**os.environ, 'CIVITAI_LIBRARY_CONFIG': str(config), 'FIXTURE_SCENARIO': kind}, capture_output=True, text=True, timeout=20)
        check(result.returncode == 0, kind + ' exits successfully: ' + result.stderr[-300:])
        check('Fatal error' not in result.stderr + result.stdout, kind + ' has no fatal error')
        with sqlite3.connect(database) as db:
            db.row_factory = sqlite3.Row
            row = dict(db.execute("SELECT * FROM images WHERE image_id='41'").fetchone())
            other = dict(db.execute("SELECT * FROM images WHERE image_id='42'").fetchone())
            check(db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok', kind + ' preserves integrity')
        if kind.startswith('write-'):
            check(row['download_status'] == 'ready', kind + ' stores the original and thumbnail')
            check(other['updated_at'] == 'concurrent-writer', kind + ' concurrent write committed')
            check(Path(row['file_path']).read_bytes() == base64.b64decode(PNG), kind + ' original bytes preserved')
            check(row['download_attempts'] == 1 and not row['download_error'], kind + ' completes one transfer')
        else:
            check(row['download_status'] == 'pending' and row['download_attempts'] == 0 and not row['download_error'], kind + ' retains pending state and retry count')
            check('database busy' in result.stdout, kind + ' reports transient database contention')
        check(row['prompt'] == 'photo fixture' and row['source_url'] == 'https://image.civitai.com/fixture.png', kind + ' preserves metadata')

if __name__ == '__main__':
    for kind in ('write-during-transfer', 'write-after-size-query', 'busy-during-transfer', 'busy-recording-error'):
        scenario(kind)
    print(json.dumps({'ok': True, 'suite': 'worker-concurrency', 'checks': checks, 'productionTouched': False, 'networkUsed': False}))
