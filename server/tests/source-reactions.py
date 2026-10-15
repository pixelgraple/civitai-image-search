#!/usr/bin/env python3
"""Isolated source-reaction refresh checks. No external requests or production data."""
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import signal
import socket
import sqlite3
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
PHP = os.environ.get('PHP_BINARY', 'php')
checks = 0


def check(value, label):
    global checks
    if not value:
        raise AssertionError(label)
    checks += 1


def run():
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        port = probe.getsockname()[1]
    base = f'http://127.0.0.1:{port}/api.php?action='
    with tempfile.TemporaryDirectory(prefix='civitai-source-reactions-') as directory:
        temp = Path(directory)
        database = temp / 'catalog.sqlite'
        media = temp / 'media'
        media.mkdir()
        untouched_file = media / 'do-not-read-or-change.bin'
        untouched_file.write_bytes(b'Fixture bytes which are deliberately not an image.')
        settings_file, config_file = temp / 'settings.json', temp / 'config.php'
        settings = {'database_path': str(database), 'storage_dir': str(media),
                    'public_ingest_enabled': True, 'public_ingest_requests_per_minute': 300}

        def save_settings():
            settings_file.write_text(json.dumps(settings))

        save_settings()
        config_file.write_text("<?php return json_decode(file_get_contents(__DIR__.'/settings.json'),true);\n")

        def request(action, body=None, method=None):
            req = urllib.request.Request(base + action,
                data=None if body is None else json.dumps(body).encode(),
                headers={'Content-Type': 'application/json', 'Accept': 'application/json'},
                method=method or ('POST' if body is not None else 'GET'))
            try:
                response = urllib.request.urlopen(req, timeout=10)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                return response.status, response.headers, json.loads(response.read())

        def refresh(items):
            return request('source-reactions', {'items': items})

        def record(image_id='41'):
            with sqlite3.connect(database) as db:
                db.row_factory = sqlite3.Row
                return dict(db.execute('SELECT * FROM images WHERE image_id=?', (image_id,)).fetchone())

        def counts(image_id='41'):
            return json.loads(record(image_id)['reactions_json'])

        def state_except_source_counts():
            with sqlite3.connect(database) as db:
                db.row_factory = sqlite3.Row
                rows = [{k: v for k, v in dict(row).items() if k not in ('reactions_json', 'updated_at')}
                        for row in db.execute('SELECT * FROM images ORDER BY image_id')]
                related = {table: [tuple(row) for row in db.execute('SELECT * FROM ' + table + ' ORDER BY 1')]
                           for table in ('images_fts', 'community_reactions', 'community_reaction_counts')}
            return rows, related, hashlib.sha256(untouched_file.read_bytes()).hexdigest()

        with (temp / 'php.log').open('wb') as log:
            process = subprocess.Popen([PHP, '-S', f'127.0.0.1:{port}', '-t', str(ROOT / 'public')],
                stdout=log, stderr=subprocess.STDOUT, start_new_session=True,
                env={**os.environ, 'CIVITAI_LIBRARY_CONFIG': str(config_file), 'PHP_CLI_SERVER_WORKERS': '4'})
            try:
                for _ in range(60):
                    try:
                        if request('health')[0] == 200:
                            break
                    except OSError:
                        pass
                    time.sleep(.1)
                else:
                    raise RuntimeError('Isolated PHP server did not start')
                check(request('health')[0] == 200, 'isolated API is ready')
                with sqlite3.connect(database) as db:
                    for image_id, status, initial in [('41', 'ready', {'likeCount': 7, 'buzzCount': 5}), ('42', 'pending', {})]:
                        db.execute('INSERT INTO images(image_id,source_url,file_path,sha256,prompt,negative_prompt,tags_json,model_name,loras_json,reactions_json,style_category,style_confidence,style_signals_json,download_status,download_attempts,discovered_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                            (image_id, 'https://image.civitai.com/fixture.jpg', str(untouched_file), 'a' * 64,
                             'Neutral source reaction fixture ' + image_id, 'fixture negative', '["fixture"]', 'fixture model', '["fixture lora"]', json.dumps(initial),
                             'anime', .71, '[{"fixture":true}]', status, 3, 'fixture-created', 'fixture-updated'))
                        db.execute('INSERT INTO images_fts(image_id,prompt,tags) VALUES(?,?,?)', (image_id, 'fixture ' + image_id, 'fixture'))
                    db.execute('INSERT INTO community_reactions(image_id,visitor_hash,reaction_type,created_at) VALUES(?,?,?,?)', ('41', 'b' * 64, 'heart', 10))
                before = state_except_source_counts()
                check(request('source-reactions')[0] == 404, 'refresh requires POST')
                for invalid in (None, [], {}, ['x'] * 101):
                    check(request('source-reactions', {'items': invalid})[0] == 400, 'invalid batch rejected')

                status, _, result = refresh([{'id': '41', 'reactions': {'heartCount': 0, 'laughCount': 12}}])
                check(status == 200 and result == {'ok': True, 'accepted': 1, 'updated': 1, 'skipped': 0, 'missingIds': []}, 'known ID refresh accepted without URL or prompt')
                check(counts() == {'likeCount': 7, 'buzzCount': 5, 'heartCount': 0, 'laughCount': 12}, 'partial refresh merges and preserves known zero')
                check(record()['download_status'] == 'ready', 'ready media is not inspected or requeued')
                check(record()['updated_at'] != 'fixture-updated', 'changed source counts update timestamp')
                previous = record()
                check(refresh([{'id': '41', 'reactions': {'heartCount': 0}}])[2]['updated'] == 0, 'same counts are idempotent')
                check(record() == previous, 'idempotent refresh does not touch timestamp')

                invalid_values = [None, '', '0', True, False, -1, 1.5, 9007199254740992, [], {}]
                for value in invalid_values:
                    result = refresh([{'id': '41', 'reactions': {'likeCount': value}}])[2]
                    check(result['accepted'] == 0 and result['skipped'] == 1 and record() == previous, 'invalid count is not coerced into zero')
                for invalid in ({}, {'statsUnknown': True, 'likeCount': 0}, {'unknownCount': 7}, None, []):
                    check(refresh([{'id': '41', 'reactions': invalid}])[2]['accepted'] == 0, 'absent or unknown stats are not submitted as known zero')
                result = refresh([{'id': '41', 'reactions': {'cryCount': 0, 'buzzCount': None}}])[2]
                check(result['accepted'] == 1 and counts()['cryCount'] == 0 and counts()['buzzCount'] == 5, 'valid sibling survives invalid sibling without erasing prior count')
                result = refresh([{'id': '41', 'reactions': {'likeCount': 0}}, {'id': '41', 'reactions': {'heartCount': 9}}])[2]
                check(result['accepted'] == 1 and result['updated'] == 1 and counts()['likeCount'] == 0 and counts()['heartCount'] == 9, 'duplicate IDs merge once; observed zero can replace a positive count')
                check(refresh([{'id': '41', 'reactions': {'likeCount': 9007199254740991}}])[2]['accepted'] == 1, 'safe integer maximum accepted')

                result = refresh([{'id': '999', 'reactions': {'likeCount': 1}}, {'id': '999', 'reactions': {'heartCount': 2}}, {'id': '../../escape', 'reactions': {'likeCount': 1}}])[2]
                check(result['missingIds'] == ['999'] and result['accepted'] == 0 and result['skipped'] == 1, 'unknown IDs returned once for bounded insertion-race retry')
                with sqlite3.connect(database) as db:
                    check(db.execute('SELECT COUNT(*) FROM images').fetchone()[0] == 2, 'reaction refresh creates no image or download job')
                payload = {'id': '41', 'reactions': {'likeCount': 6}, 'prompt': 'must not replace', 'category': 'realistic',
                           'downloadUrl': 'https://127.0.0.1/no-request', 'file_path': str(temp / 'escape'), 'command': 'must not run'}
                check(refresh([payload])[2]['accepted'] == 1 and state_except_source_counts() == before, 'source refresh preserves prompt, classification, FTS, media, download state and community votes')
                check(not list(media.glob('.image-locks/*')), 'source refresh creates no image lock files')
                visible = next(item for item in request('search&q=fixture')[2]['items'] if item['id'] == '41')
                check(visible['reactions']['likeCount'] == 6, 'refreshed counts are visible through normal search')

                # Preflight exposes completeness without treating zero as absent. Use pending ID so no real media needed.
                with sqlite3.connect(database) as db:
                    db.execute("UPDATE images SET file_path=NULL WHERE image_id='42'")
                checked = request('check', {'imageIds': ['42', '999']})[2]['items']
                check(all(item['reactionsMissing'] for item in checked), 'empty and unknown image reactions are missing')
                refresh([{'id': '42', 'reactions': {'likeCount': 0, 'heartCount': 0, 'laughCount': 0}}])
                check(request('check', {'imageIds': ['42']})[2]['items'][0]['reactionsMissing'], 'partial core counts remain incomplete')
                refresh([{'id': '42', 'reactions': {'cryCount': 0}}])
                check(not request('check', {'imageIds': ['42']})[2]['items'][0]['reactionsMissing'], 'four known zero counts are complete without Buzz')

                def concurrent_refresh(key, value):
                    for _ in range(8):
                        status, _, result = refresh([{'id': '42', 'reactions': {key: value}}])
                        if status == 200:
                            return result['accepted'] == 1
                        if status != 503:
                            return False
                        time.sleep(.05)
                    return False
                with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                    futures = [pool.submit(concurrent_refresh, 'likeCount', 25), pool.submit(concurrent_refresh, 'heartCount', 17)]
                    check(all(future.result() for future in futures), 'concurrent partial refreshes finish or retry busy transactions')
                check(counts('42') == {'likeCount': 25, 'heartCount': 17, 'laughCount': 0, 'cryCount': 0}, 'concurrent partial merges cannot lose another reaction update')
                check(request('source-reactions', {'items': [{'id': '41', 'reactions': {'likeCount': 1}}], 'padding': 'x' * 1048576})[0] == 413, 'refresh obeys normal request byte limit')

                settings['public_ingest_requests_per_minute'] = 1
                save_settings()
                with sqlite3.connect(database) as db:
                    db.execute('DELETE FROM ingest_request_windows')
                check(refresh([{'id': '41', 'reactions': {'likeCount': 6}}])[0] == 200, 'refresh uses public writer quota')
                status, headers, _ = refresh([{'id': '41', 'reactions': {'likeCount': 6}}])
                check(status == 429 and headers.get('Retry-After'), 'excess refresh requests are rate limited')
                settings['public_ingest_enabled'] = False
                save_settings()
                check(refresh([{'id': '41', 'reactions': {'likeCount': 6}}])[0] == 401, 'protected mode retains writer authentication')
            finally:
                if os.name == 'posix':
                    os.killpg(process.pid, signal.SIGTERM)
                else:
                    process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
    print(json.dumps({'ok': True, 'checks': checks, 'suite': 'source-reactions', 'productionTouched': False}))


if __name__ == '__main__':
    run()
