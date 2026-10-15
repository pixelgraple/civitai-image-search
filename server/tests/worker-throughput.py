#!/usr/bin/env python3
"""Real worker with deterministic curl_multi fixtures; no network/live catalog."""
import base64
import hashlib
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
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=')
checks = 0


def check(value, message):
    global checks
    if not value:
        raise AssertionError(message)
    checks += 1


def fixture_source():
    source = (ROOT / 'worker.php').read_text()
    source = re.sub(r'\bcurl_(init|setopt_array|getinfo|error|close|multi_[a-z_]+)\(', r'fixture_curl_\1(', source)
    return source + '\n' + (ROOT / 'tests/worker-curl-fixture.php').read_text().removeprefix('<?php')


def scenario(kind, count=9, concurrency=4, http_status=200):
    with tempfile.TemporaryDirectory(prefix='civitai-worker-throughput-') as temporary:
        temp = Path(temporary)
        app = temp / 'app'
        app.mkdir()
        media = temp / 'media'
        media.mkdir()
        database = temp / 'catalog.sqlite'
        for name in ('lib.php', 'schema.sql', 'style-classifier.php'):
            shutil.copy2(ROOT / name, app / name)
        settings = {'database_path': str(database), 'storage_dir': str(media),
                    'image_download_concurrency': concurrency, 'max_image_bytes': 1048576,
                    'storage_max_bytes': 1048576 if kind == 'storage-cap' else 104857600}
        (temp / 'settings.json').write_text(json.dumps(settings))
        config = temp / 'config.php'
        config.write_text("<?php return json_decode(file_get_contents(__DIR__.'/settings.json'),true);\n")
        with sqlite3.connect(database) as db:
            db.executescript((ROOT / 'schema.sql').read_text())
            for image_id in range(41, 41 + count):
                db.execute("INSERT INTO images(image_id,source_url,prompt,negative_prompt,reactions_json,style_category,discovered_at,updated_at) VALUES(?,?,'photo fixture','negative fixture','{\"heartCount\":2}','realistic','fixture','fixture')", (str(image_id), f'https://image.civitai.com/{image_id}.png'))
            db.execute("INSERT INTO images(image_id,source_url,prompt,discovered_at,updated_at) VALUES('999','https://image.civitai.com/999.png','','fixture','fixture')")
            db.execute("INSERT INTO community_reactions VALUES('41',?,'heart',123)", ('a' * 64,))
        worker = app / 'worker.php'
        worker.write_text(fixture_source())
        if kind == 'thumbnail-repair-failure':
            (media / 'images/41/41-thumb.png').mkdir(parents=True)
        calls = temp / 'calls.txt'
        meta_log = temp / 'meta.json'
        env = {**os.environ, 'CIVITAI_LIBRARY_CONFIG': str(config), 'FIXTURE_SCENARIO': kind,
               'FIXTURE_CALL_LOG': str(calls), 'FIXTURE_META_LOG': str(meta_log),
               'FIXTURE_HTTP_STATUS': str(http_status), 'FIXTURE_RETRY_AFTER': '120'}
        result = subprocess.run([PHP, '-d', 'memory_limit=64M', str(worker), str(count + 1)], env=env, capture_output=True, text=True, timeout=45)
        if kind == 'thumbnail-repair-failure':
            for _ in range(2):
                result = subprocess.run([PHP, '-d', 'memory_limit=64M', str(worker), str(count + 1)], env=env, capture_output=True, text=True, timeout=45)
        check(result.returncode == 0, kind + ' exits cleanly: ' + result.stderr[-400:])
        check('Fatal error' not in result.stderr + result.stdout, kind + ' no PHP fatal')
        with sqlite3.connect(database) as db:
            db.row_factory = sqlite3.Row
            rows = [dict(row) for row in db.execute("SELECT * FROM images WHERE image_id<>'999' ORDER BY CAST(image_id AS INTEGER)")]
            check(db.execute("SELECT download_attempts FROM images WHERE image_id='999'").fetchone()[0] == 0, kind + ' skips promptless record')
            check(db.execute('SELECT COUNT(*) FROM community_reactions').fetchone()[0] == 1, kind + ' preserves community vote')
            check(db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok', kind + ' isolated catalog integrity')
        check(all(row['prompt'] == 'photo fixture' and row['negative_prompt'] == 'negative fixture' and row['reactions_json'] == '{"heartCount":2}' and row['style_category'] == 'realistic' for row in rows), kind + ' preserves collected metadata')
        check(not list((media / '.download-tmp').glob('*.part')), kind + ' cleans transfer spool')
        if meta_log.exists():
            metadata = json.loads(meta_log.read_text())
            check(metadata['peak'] <= min(8, max(1, concurrency)), kind + ' bounded simultaneous handles')
            check(metadata['networkLocksReleased'], kind + ' releases image locks during network')
        if kind in ('normal', 'redirect-safe', 'write-during-transfer', 'oversized-header'):
            check(all(row['download_status'] == 'ready' and row['download_attempts'] == 1 for row in rows), kind + ' every eligible image ready once')
            check(len({row['file_path'] for row in rows}) == 1, kind + ' identical hashes share one original: ' + json.dumps([{'id': row['image_id'], 'path': row['file_path'], 'sha': row['sha256']} for row in rows]) + '\n' + result.stdout + '\n' + result.stderr)
            for row in rows:
                stored = Path(row['file_path'])
                check(stored.is_file() and hashlib.sha256(stored.read_bytes()).hexdigest() == row['sha256'], kind + ' original digest valid')
                check(stored.with_name(stored.stem + '-thumb' + stored.suffix).is_file(), kind + ' thumbnail present')
            if kind == 'normal':
                check(metadata['peak'] == min(count, concurrency, 8), 'normal reaches configured concurrency')
                check(len(calls.read_text().splitlines()) == count, 'normal exactly one source transfer per image')
            if kind == 'oversized-header':
                check('GD memory limit protected' in result.stdout, 'dangerous dimensions skip GD and remain viewable')
            if kind == 'write-during-transfer':
                check(rows[1]['updated_at'] != 'fixture', 'concurrent SQLite writer completed during transfer')
        elif kind in ('overflow', 'invalid-image', 'redirect-unsafe', 'redirect-loop'):
            check(all(row['download_status'] == 'pending' and row['download_attempts'] == 1 for row in rows), kind + ' failed transfer records one bounded attempt')
            check(not list(media.glob('images/**/*.*')), kind + ' no invalid original committed')
        elif kind == 'source-changed':
            check(rows[0]['source_url'].endswith('/changed.png') and rows[0]['download_attempts'] == 0 and rows[0]['download_status'] == 'pending', 'changed source remains queued without stale commit')
            check(rows[1]['download_status'] == 'ready', 'changed source does not block other image')
        elif kind == 'storage-cap':
            check(sum(row['download_status'] == 'ready' for row in rows) == 1, 'unique-file accounting allows only first file under cap')
            check(sum(path.stat().st_size for path in media.glob('images/**/*.*') if '-thumb.' not in path.name) <= settings['storage_max_bytes'], 'original cap preserved across parallel wave')
        elif kind in ('busy-during-transfer', 'busy-recording-error'):
            check(all(row['download_status'] == 'pending' and row['download_attempts'] == 0 for row in rows), kind + ' contention preserves attempts')
        elif kind == 'backoff':
            check(all(row['download_status'] == 'pending' and row['download_attempts'] == 0 for row in rows), 'source cooldown preserves entire in-flight wave')
            check((media / '.worker-backoff.json').is_file(), 'source cooldown persisted')
        elif kind == 'thumbnail-repair-failure':
            check(rows[0]['download_status'] == 'failed' and rows[0]['download_attempts'] == 3, 'three thumbnail failures terminate poison queue item')
            check(Path(rows[0]['file_path']).read_bytes() == PNG, 'failed thumbnail preserves original bytes')
            check(rows[1]['download_status'] == 'ready', 'thumbnail failure does not block following image')
            check(len(calls.read_text().splitlines()) == 2, 'local thumbnail failures never re-download saved original')


if __name__ == '__main__':
    scenario('normal')
    scenario('normal', 9, 20)
    for name in ('redirect-safe', 'redirect-unsafe', 'redirect-loop', 'overflow', 'invalid-image', 'storage-cap', 'source-changed', 'write-during-transfer', 'oversized-header', 'thumbnail-repair-failure'):
        scenario(name, 2)
    scenario('busy-during-transfer', 1)
    scenario('busy-recording-error', 1)
    scenario('backoff', 4, 4, 429)
    scenario('backoff', 4, 4, 503)
    print(json.dumps({'ok': True, 'checks': checks, 'productionTouched': False, 'networkUsed': False}))
