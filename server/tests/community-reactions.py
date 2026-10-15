#!/usr/bin/env python3
"""Isolated anonymous reaction API checks; never uses the production catalog."""
import concurrent.futures
import http.cookies
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
    origin = f'http://127.0.0.1:{port}'
    with tempfile.TemporaryDirectory(prefix='civitai-reactions-test-') as directory:
        temp = Path(directory)
        database = temp / 'catalog.sqlite'
        media = temp / 'media'
        media.mkdir()
        settings = {'database_path': str(database), 'storage_dir': str(media),
                    'public_ingest_enabled': True, 'public_origin': origin}
        settings_file = temp / 'settings.json'
        config_file = temp / 'config.php'
        def save_settings():
            settings_file.write_text(json.dumps(settings))
        save_settings()
        config_file.write_text("<?php return json_decode(file_get_contents(__DIR__.'/settings.json'),true);\n")

        def request(action, body=None, cookie='', csrf='', headers=None, method=None):
            actual_headers = {'Accept': 'application/json', 'Origin': origin,
                              'Sec-Fetch-Site': 'same-origin', **(headers or {})}
            if cookie:
                actual_headers['Cookie'] = cookie
            if body is not None:
                body = {**body}
                if csrf:
                    body['csrfToken'] = csrf
                actual_headers['Content-Type'] = 'application/json'
            req = urllib.request.Request(origin + '/api.php?action=' + action,
                data=None if body is None else json.dumps(body).encode(),
                headers=actual_headers, method=method or ('POST' if body is not None else 'GET'))
            try:
                response = urllib.request.urlopen(req, timeout=10)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                return response.status, response.headers, json.loads(response.read())

        def visitor(image_id='41'):
            status, headers, data = request('reactions&id=' + image_id)
            check(status == 200 and data['ok'], 'new visitor can read reactions')
            cookies = http.cookies.SimpleCookie()
            cookies.load(headers.get('Set-Cookie', ''))
            check(len(cookies) == 1, 'one visitor identity cookie issued')
            morsel = next(iter(cookies.values()))
            check(bool(morsel['secure']) and bool(morsel['httponly']) and morsel['samesite'].lower() in ('lax', 'strict'), 'visitor cookie is protected')
            check(bool(data['csrfToken']), 'csrf token returned')
            return f'{morsel.key}={morsel.value}', data['csrfToken'], data

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
                check(request('reactions&id=999')[0] == 404, 'unknown image rejected')
                check(request('reactions&id=../41')[0] == 400, 'malformed image rejected')
                with sqlite3.connect(database) as db:
                    check(db.execute('SELECT COUNT(*) FROM community_reaction_settings').fetchone()[0] == 0, 'unknown image creates no signing secret')
                    check(db.execute('SELECT COUNT(*) FROM community_reaction_windows').fetchone()[0] == 0, 'unknown image creates no quota state')
                    for image_id, category, tags in [('41','realistic','["portrait"]'), ('42','anime','["portrait"]'), ('43','realistic','["landscape"]')]:
                        db.execute('INSERT INTO images(image_id,source_url,prompt,tags_json,style_category,reactions_json,discovered_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
                            (image_id, 'https://image.civitai.com/fixture.jpg', 'photo fixture '+image_id, tags, category, '{"likeCount":77}', 'fixture', 'fixture'))
                        db.execute('INSERT INTO images_fts(image_id,prompt,tags) VALUES(?,?,?)', (image_id,'photo fixture '+image_id,tags))
                    initial_images = db.execute('SELECT * FROM images ORDER BY image_id').fetchall()
                    initial_fts = db.execute('SELECT * FROM images_fts ORDER BY image_id').fetchall()
                cookie1, csrf1, first = visitor()
                check(first['counts'] == dict.fromkeys(('upvote','heart','laugh','wow'), 0), 'community totals start at zero, not source counts')
                check(not any(first['mine'].values()), 'new visitor has no selections')
                check(request('reactions&id=41', cookie=cookie1)[2]['csrfToken'] == csrf1, 'visitor token stable')
                body = {'id':'41', 'type':'upvote', 'active':True}
                check(request('reactions', body)[0] == 403, 'anonymous write without identity rejected')
                check(request('reactions', body, cookie1)[0] == 403, 'missing csrf rejected')
                check(request('reactions', body, cookie1, 'invalid')[0] == 403, 'invalid csrf rejected')
                check(request('reactions', body, cookie1, csrf1, {'Origin':'https://attacker.invalid'})[0] == 403, 'cross-origin write rejected')
                check(request('reactions', body, cookie1, csrf1, {'Sec-Fetch-Site':'cross-site'})[0] == 403, 'cross-site fetch rejected')
                check(request('reactions', body, cookie1, csrf1, {'Origin':''})[0] == 403, 'missing origin rejected')
                check(request('reactions', body, cookie1[:-1]+('a' if cookie1[-1]!='a' else 'b'), csrf1)[0] == 403, 'tampered identity rejected')
                check(request('reactions', {**body,'type':'money'}, cookie1, csrf1)[0] == 400, 'unknown reaction rejected')
                check(request('reactions', {**body,'active':'yes'}, cookie1, csrf1)[0] == 400, 'active state requires boolean')
                check(request('reactions', {**body,'id':'999'}, cookie1, csrf1)[0] == 404, 'unknown write target rejected')
                status, _, data = request('reactions', {**body,'counts':{'upvote':999999}}, cookie1, csrf1)
                check(status == 200 and data['counts']['upvote'] == 1 and data['mine']['upvote'], 'first vote saved; supplied count ignored')
                check(request('reactions', body, cookie1, csrf1)[2]['counts']['upvote'] == 1, 'repeated active request is idempotent')
                cookie2, csrf2, second = visitor()
                check(second['counts']['upvote'] == 1 and not second['mine']['upvote'], 'second visitor sees shared total with independent state')
                check(request('reactions', body, cookie2, csrf2)[2]['counts']['upvote'] == 2, 'independent visitor adds one vote')
                for kind in ('heart','laugh','wow'):
                    result = request('reactions', {**body,'type':kind}, cookie1, csrf1)[2]
                    check(result['counts'][kind] == 1 and result['mine'][kind], kind+' reaction saved')
                with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
                    results = list(pool.map(lambda _: request('reactions', {**body,'id':'43'}, cookie1, csrf1), range(4)))
                check(all(result[0] == 200 for result in results), 'concurrent same-state writes succeed: '+repr([(result[0],result[2].get('error')) for result in results]))
                check(request('reactions&id=43', cookie=cookie1)[2]['counts']['upvote'] == 1, 'concurrent votes deduplicate')
                ranked = request('search&sort=upvotes&limit=2')[2]
                check([row['id'] for row in ranked['items']] == ['41','43'] and ranked['total'] == 3, 'most-upvoted sorting and pagination')
                check(ranked['items'][0]['communityReactions']['upvote'] == 2 and ranked['items'][0]['reactions']['likeCount'] == 77, 'community and source counts separate')
                check(request('search&sort=upvotes&limit=2&page=2')[2]['items'][0]['id'] == '42', 'ranked second page')
                check([row['id'] for row in request('search&sort=newest')[2]['items']] == ['43','42','41'], 'newest order preserved')
                check(request('search&sort=upvotes&tag=portrait&category=realistic&q=fixture')[2]['total'] == 1, 'ranking respects prompt/tag/style filters')
                check(request('search&sort=invalid')[0] == 400, 'invalid sort rejected')
                removed = request('reactions', {**body,'active':False}, cookie1, csrf1)[2]
                check(removed['counts']['upvote'] == 1 and not removed['mine']['upvote'], 'visitor can remove only own vote')
                check(request('reactions', {**body,'active':False}, cookie1, csrf1)[2]['counts']['upvote'] == 1, 'repeat removal idempotent')
                check(request('reactions&id=41', cookie=cookie2)[2]['mine']['upvote'], 'other visitor vote preserved')
                with sqlite3.connect(database) as db:
                    check(db.execute('SELECT * FROM images ORDER BY image_id').fetchall() == initial_images, 'reactions preserve every image field')
                    check(db.execute('SELECT * FROM images_fts ORDER BY image_id').fetchall() == initial_fts, 'reactions preserve search index')
                    check(db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok', 'database remains valid')
                    db.execute('DELETE FROM community_reaction_windows')
                settings['reaction_writes_per_minute'] = 2
                save_settings()
                check(request('reactions', body, cookie1, csrf1)[0] == 200, 'first write inside limit')
                check(request('reactions', body, cookie1, csrf1)[0] == 200, 'second write inside limit')
                limited = request('reactions', body, cookie1, csrf1)
                check(limited[0] == 429 and int(limited[1].get('Retry-After', '0')) > 0, 'per-visitor limit reports retry delay')
                with sqlite3.connect(database) as db:
                    db.execute('DELETE FROM community_reaction_windows')
                settings['reaction_writes_per_minute'] = 60
                settings['reaction_ip_writes_per_minute'] = 1
                save_settings()
                check(request('reactions', body, cookie1, csrf1)[0] == 200, 'first address write succeeds')
                check(request('reactions', body, cookie2, csrf2, {'X-Forwarded-For':'198.51.100.1'})[0] == 429, 'new visitor and spoofed headers cannot bypass address limit')
                with sqlite3.connect(database) as db:
                    db.execute('DELETE FROM community_reaction_windows')
                settings['reaction_identities_per_hour'] = 1
                save_settings()
                visitor()
                check(request('reactions&id=41')[0] == 429, 'identity creation is bounded')
                check(request('reactions&id=41', cookie=cookie1)[0] == 200, 'existing visitor can read while identity minting limited')
                check(request('writer-status')[0] == 200, 'reaction quotas do not block indexing')
            except Exception:
                log.flush()
                print((temp / 'php.log').read_text()[-6000:])
                raise
            finally:
                os.killpg(process.pid, signal.SIGTERM)
                process.wait(timeout=5)
    print(json.dumps({'ok':True,'suite':'community-reactions','checks':checks,'productionTouched':False}))

if __name__ == '__main__':
    run()
