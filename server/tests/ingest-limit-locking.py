#!/usr/bin/env python3
"""Real API preflight with a held catalog writer; no production/external requests."""
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
PHP = os.environ.get('PHP_BINARY', 'php')
checks = 0

def check(value, message):
    global checks
    assert value, message
    checks += 1

with tempfile.TemporaryDirectory(prefix='civitai-ingest-locking-') as temporary:
    tmp = Path(temporary)
    database = tmp / 'catalog.sqlite'
    quota = Path(str(database) + '.ingest-limits.sqlite')
    config = tmp / 'config.php'
    (tmp / 'settings.json').write_text(json.dumps({
        'database_path': str(database), 'storage_dir': str(tmp / 'media'),
        'public_ingest_enabled': True, 'public_ingest_requests_per_minute': 4,
    }))
    (tmp / 'media').mkdir()
    config.write_text("<?php return json_decode(file_get_contents(__DIR__.'/settings.json'),true);")
    env = {**os.environ, 'CIVITAI_LIBRARY_CONFIG': str(config)}
    subprocess.run([PHP, '-r', 'require $argv[1]; db();', str(ROOT / 'lib.php')], env=env, check=True, capture_output=True)
    # Leave enough time for all assertions to share a minute, including slow CI.
    if time.time() % 60 > 40:
        time.sleep(60 - time.time() % 60 + .05)
    window = int(time.time() // 60) * 60
    client = 'public:' + hashlib.sha256(b'index-civitai-ingest:' + socket.inet_pton(socket.AF_INET, '127.0.0.1')).hexdigest()
    with sqlite3.connect(database) as conn:
        conn.execute('INSERT INTO ingest_request_windows VALUES(?,?,?)', (client, window, 2))
        conn.execute("INSERT INTO images(image_id,source_url,prompt,discovered_at,updated_at) VALUES('42','https://image.civitai.com/fixture.jpg','fixture photograph','fixture','fixture')")
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0)); port = probe.getsockname()[1]
    with (tmp / 'php.log').open('wb') as log:
        server = subprocess.Popen([PHP, '-S', f'127.0.0.1:{port}', '-t', str(ROOT / 'public')], env=env, stdout=log, stderr=log)
        try:
            for _ in range(50):
                try:
                    with socket.create_connection(('127.0.0.1', port), .1): break
                except OSError: time.sleep(.1)
            else: raise AssertionError('PHP server did not start')
            def request():
                req = urllib.request.Request(f'http://127.0.0.1:{port}/api.php?action=check',
                    data=json.dumps({'imageIds': ['42', '43'], 'allowPartial': True}).encode(),
                    headers={'Content-Type': 'application/json'}, method='POST')
                try:
                    with urllib.request.urlopen(req, timeout=8) as response:
                        return response.status, json.load(response)
                except urllib.error.HTTPError as response:
                    return response.code, json.load(response)
            with sqlite3.connect(database) as writer:
                writer.execute('BEGIN IMMEDIATE')
                started = time.monotonic()
                status, body = request()
                elapsed = time.monotonic() - started
                check(status == 200 and body['checked'] == 2 and not body['deferredIds'], f'first setup and known/unknown preflight pass while catalog writer is held: {status} {body}')
                check(elapsed < 2, f'check does not wait on the catalog writer: {elapsed}')
                check(request()[0] == 200, 'last allowed request succeeds')
                check(request()[0] == 429, 'migration preserves current-minute quota')
                writer.rollback()
            with sqlite3.connect(database) as conn:
                check(conn.execute('SELECT request_count FROM ingest_request_windows').fetchone()[0] == 2, 'preflight does not mutate legacy catalog accounting')
                check(conn.execute('SELECT COUNT(*) FROM images').fetchone()[0] == 1, 'checks do not create images')
            with sqlite3.connect(quota) as conn:
                check(conn.execute('SELECT request_count FROM ingest_request_windows').fetchone()[0] == 4, 'quota is persistent and capped')
                check(conn.execute('PRAGMA integrity_check').fetchone()[0] == 'ok', 'quota database integrity')
            # Independent PHP processes share the same accounting transaction.
            def quota_request(_):
                result = subprocess.run([PHP, '-r', "require $argv[1]; limit_contributor_requests('parallel',true); echo json_encode(['ok'=>true]);", str(ROOT / 'lib.php')],
                    env=env, capture_output=True, text=True, timeout=12)
                check(result.returncode == 0, result.stderr)
                return json.loads(result.stdout)['ok']
            with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
                allowed = list(pool.map(quota_request, range(12)))
            check(sum(allowed) == 4, f'parallel requests cannot exceed quota: {allowed}')
            with sqlite3.connect(quota) as conn:
                check(conn.execute("SELECT request_count FROM ingest_request_windows WHERE contributor_id='parallel'").fetchone()[0] == 4, 'parallel quota count remains exact')
        finally:
            server.terminate(); server.wait(timeout=5)
    print(json.dumps({'ok': True, 'checks': checks, 'heldWriterCheckSeconds': round(elapsed, 3), 'productionTouched': False}))
