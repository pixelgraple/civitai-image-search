#!/usr/bin/env python3
"""Isolated cache, partial preflight and FTS preservation checks; no external traffic."""
import base64
import fcntl
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
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMioAAAAASUVORK5CYII=')


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
    with tempfile.TemporaryDirectory(prefix='civitai-throughput-') as directory:
        temp = Path(directory)
        database, media = temp / 'catalog.sqlite', temp / 'media'
        media.mkdir()
        settings_file, config_file = temp / 'settings.json', temp / 'config.php'
        settings_file.write_text(json.dumps({'database_path': str(database), 'storage_dir': str(media),
                                            'public_ingest_enabled': True, 'public_ingest_requests_per_minute': 300}))
        config_file.write_text("<?php return json_decode(file_get_contents(__DIR__.'/settings.json'),true);\n")
        env = {**os.environ, 'CIVITAI_LIBRARY_CONFIG': str(config_file), 'PHP_CLI_SERVER_WORKERS': '4'}
        inspector = temp / 'inspect.php'
        inspector.write_text("<?php require $argv[1]; $in=json_decode(stream_get_contents(STDIN),true); if (($in['operation']??'')==='seed') { remember_stored_image_verification($in['row'],$in['verified']); echo '{}'; } else { echo json_encode(inspect_stored_image($in['row'])); }\n")

        def inspect(row, operation='inspect', verified=None):
            result = subprocess.run([PHP, str(inspector), str(ROOT / 'lib.php')], input=json.dumps({'row': row, 'operation': operation, 'verified': verified}),
                                    capture_output=True, text=True, timeout=10, env=env, check=True)
            return json.loads(result.stdout)

        def request(action, body=None):
            req = urllib.request.Request(base + action, data=None if body is None else json.dumps(body).encode(),
                headers={'Content-Type': 'application/json', 'Accept': 'application/json'})
            try:
                response = urllib.request.urlopen(req, timeout=15)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                return response.status, response.headers, json.loads(response.read())

        def row(image_id='41'):
            with sqlite3.connect(database) as db:
                db.row_factory = sqlite3.Row
                return dict(db.execute('SELECT * FROM images WHERE image_id=?', (image_id,)).fetchone())

        with (temp / 'php.log').open('wb') as log:
            process = subprocess.Popen([PHP, '-S', f'127.0.0.1:{port}', '-t', str(ROOT / 'public')], env=env,
                                       stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
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
                source = 'https://image.civitai.com/isolated.png'
                records = [{'id': str(image_id), 'downloadUrl': source, 'prompt': 'neutral throughput fixture ' + str(image_id)} for image_id in (41, 42)]
                result = request('images', {'items': records})[2]
                check(result['accepted'] == 2 and result['imageCopiesQueued'] == 2, 'new metadata inserts both catalog and FTS records')
                with sqlite3.connect(database) as db:
                    first_fts = db.execute("SELECT rowid,* FROM images_fts WHERE image_id='41'").fetchall()
                result = request('images', {'items': [{**records[0], 'reactions': {'likeCount': 8}}]})[2]
                with sqlite3.connect(database) as db:
                    check(db.execute("SELECT rowid,* FROM images_fts WHERE image_id='41'").fetchall() == first_fts, 'reaction-only rescan leaves original FTS row intact')
                check(result['accepted'] == 1 and json.loads(row()['reactions_json'])['likeCount'] == 8, 'metadata rescan still saves source counts')
                changed = {**records[0], 'prompt': 'changed searchable wording', 'tags': ['newtag']}
                request('images', {'items': [changed]})
                with sqlite3.connect(database) as db:
                    changed_fts = db.execute("SELECT rowid,* FROM images_fts WHERE image_id='41'").fetchall()
                check(len(changed_fts) == 1 and changed_fts != first_fts, 'changed searchable fields replace exactly one FTS record')
                check(request('search&q=changed')[2]['total'] == 1 and request('search&tag=newtag')[2]['total'] == 1, 'updated prompt and tag are searchable')

                original, thumbnail = media / '41.png', media / '41-thumb.png'
                original.write_bytes(PNG)
                thumbnail.write_bytes(PNG)
                digest = hashlib.sha256(PNG).hexdigest()
                with sqlite3.connect(database) as db:
                    db.execute("UPDATE images SET file_path=?,file_size=?,sha256=?,mime_type='image/png',download_status='ready' WHERE image_id='41'", (str(original), len(PNG), digest))
                known = row()
                verified = {'exists': True, 'sha256': digest, 'path': str(original), 'size': len(PNG), 'mime': 'image/png'}
                # A direct seed in this modification second must never create a usable cache entry.
                while time.time() % 1 > .5:
                    time.sleep(.02)
                original.write_bytes(PNG)
                inspect(known, 'seed', verified)
                cache = media / '.image-verifications' / (hashlib.sha256(str(original).encode()).hexdigest() + '.json')
                check(not cache.exists(), 'worker seed skips a file changed in the current second')
                time.sleep(1.05)
                check(inspect(known) == verified and cache.is_file(), 'stable file is hashed and verification cached')
                cached = json.loads(cache.read_text())
                check(cached['fingerprint']['expectedSha'] == digest and cached['fingerprint']['expectedSize'] == len(PNG) and cached['fingerprint']['expectedMime'] == 'image/png', 'cache binds expected digest, size and MIME')
                check(all(key in cached['fingerprint'] for key in ('path', 'dev', 'ino', 'size', 'mtime', 'ctime', 'mode', 'uid', 'gid')), 'cache binds full file and permission identity')
                cached['verifiedAt'] -= 120
                cache.write_text(json.dumps(cached))
                check(inspect(known) == verified and json.loads(cache.read_text())['verifiedAt'] == cached['verifiedAt'], 'unchanged file uses cached SHA without refreshing timestamp')
                cached['verifiedAt'] = int(time.time()) - 21601
                cache.write_text(json.dumps(cached))
                check(inspect(known) == verified and json.loads(cache.read_text())['verifiedAt'] > cached['verifiedAt'], 'expired six-hour verification is renewed from bytes')
                check(not inspect({**known, 'sha256': 'b' * 64})['exists'], 'different expected SHA cannot use prior verification')
                check(not inspect({**known, 'file_size': len(PNG) + 1})['exists'], 'different expected size cannot use prior verification')
                check(not inspect({**known, 'mime_type': 'image/jpeg'})['exists'], 'different expected MIME cannot use prior verification')
                original.write_bytes(PNG[:-1] + bytes([PNG[-1] ^ 1]))
                check(not inspect(known)['exists'], 'same-size changed bytes invalidate cached SHA immediately')
                status, _, checked = request('check', {'imageIds': ['41'], 'allowPartial': True})
                check(status == 200 and checked['items'][0]['needsDownload'] and row()['download_status'] == 'pending', 'corrupt original is requeued through partial preflight')
                original.write_bytes(PNG)
                checked = request('check', {'imageIds': ['41']})[2]
                check(checked['items'][0]['exists'] and row()['download_status'] == 'ready', 'restored bytes recover ready state through legacy preflight')
                thumbnail.unlink()
                checked = request('check', {'imageIds': ['41']})[2]
                check(checked['items'][0]['exists'] and not checked['items'][0]['needsDownload'] and row()['download_status'] == 'pending', 'missing thumbnail still queues local repair without original download')
                thumbnail.write_bytes(PNG)

                # A busy image must not hold up unrelated or unknown IDs for updated clients.
                lock_path = media / '.image-locks' / '41.lock'
                with lock_path.open('a+b') as held:
                    fcntl.flock(held, fcntl.LOCK_EX)
                    start = time.monotonic()
                    status, _, result = request('check', {'imageIds': ['41', '42', '999'], 'allowPartial': True})
                    check(status == 200 and time.monotonic() - start < 2, 'partial check does not wait on another worker image lock')
                    check(result['deferredIds'] == ['41'] and result['retryAfterMs'] == 1000, 'busy ID explicitly deferred with retry guidance')
                    check({item['imageId'] for item in result['items']} == {'42', '999'} and result['checked'] == 2, 'completed IDs returned independently of busy image')
                    check(result['existing'] + result['missing'] == result['checked'], 'partial result totals cover completed items only')
                    check(request('check', {'imageIds': ['41', '42']})[0] == 503, 'legacy clients retain full-batch retry semantics')
                    fcntl.flock(held, fcntl.LOCK_UN)
                result = request('check', {'imageIds': ['41', '42'], 'allowPartial': True})[2]
                check(result['deferredIds'] == [] and result['checked'] == 2, 'deferred ID completes after worker releases lock')
                check(not (media / '.image-locks' / '999.lock').exists(), 'unknown preflight ID leaves no lock file')

                before_fts = changed_fts
                result = request('images', {'items': [{**changed, 'reactions': {'heartCount': 4}}]})[2]
                with sqlite3.connect(database) as db:
                    check(db.execute("SELECT rowid,* FROM images_fts WHERE image_id='41'").fetchall() == before_fts, 'ready-image metadata refresh also preserves unchanged FTS')
                    check(db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok', 'isolated database remains valid')
                check(result['imageCopiesQueued'] == 0 and row()['sha256'] == digest, 'ready metadata update preserves validated original digest without another download')
            finally:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
    print(json.dumps({'ok': True, 'checks': checks, 'suite': 'storage-throughput', 'productionTouched': False}))


if __name__ == '__main__':
    run()
