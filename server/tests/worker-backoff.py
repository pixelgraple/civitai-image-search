#!/usr/bin/env python3
"""Run the real worker with isolated SQLite/storage and a local cURL response fixture."""
import email.utils
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parent.parent
PHP = os.environ.get('PHP_BINARY', 'php')
checks = 0

def check(value, message):
    global checks
    if not value:
        raise AssertionError(message)
    checks += 1

def scenario(status, header, seconds):
    with tempfile.TemporaryDirectory(prefix='civitai-worker-backoff-') as temporary:
        temp = Path(temporary)
        app = temp / 'app'
        app.mkdir()
        media = temp / 'media'
        media.mkdir()
        database = temp / 'catalog.sqlite'
        for name in ('lib.php', 'schema.sql', 'style-classifier.php'):
            shutil.copy2(ROOT / name, app / name)
        (temp / 'settings.json').write_text(json.dumps({'database_path':str(database), 'storage_dir':str(media), 'image_download_concurrency':1}))
        config = temp / 'config.php'
        config.write_text("<?php return json_decode(file_get_contents(__DIR__.'/settings.json'),true);\n")
        with sqlite3.connect(database) as db:
            db.executescript((ROOT / 'schema.sql').read_text())
            for image_id in ('41','42'):
                db.execute("INSERT INTO images(image_id,source_url,prompt,discovered_at,updated_at) VALUES(?,'https://image.civitai.com/fixture.png','photo fixture','fixture','fixture')",(image_id,))
            before = db.execute('SELECT * FROM images ORDER BY image_id').fetchall()
        source = (ROOT / 'worker.php').read_text()
        source = re.sub(r'\bcurl_(init|setopt_array|getinfo|error|close|multi_[a-z_]+)\(', r'fixture_curl_\1(', source)
        source += '\n' + (ROOT / 'tests/worker-curl-fixture.php').read_text().removeprefix('<?php')
        worker = app / 'worker.php'
        worker.write_text(source)
        call_log = temp / 'calls.txt'
        env = {**os.environ,'CIVITAI_LIBRARY_CONFIG':str(config),'FIXTURE_HTTP_STATUS':str(status),'FIXTURE_RETRY_AFTER':header,'FIXTURE_CALL_LOG':str(call_log)}
        started = int(time.time())
        result = subprocess.run([PHP,str(worker),'2'],env=env,capture_output=True,text=True,timeout=10)
        check(result.returncode == 0, 'HTTP '+str(status)+' pauses cleanly: '+result.stderr[-250:])
        state_path = media / '.worker-backoff.json'
        check(state_path.is_file(), 'HTTP '+str(status)+' writes cooldown state: '+result.stdout+'\n'+result.stderr)
        state = json.loads(state_path.read_text())
        check(state['status'] == status, 'source HTTP status is persisted')
        check(abs(state['until'] - (started + seconds)) <= 3, 'Retry-After deadline and minimum pause honored')
        check(state_path.stat().st_mode & 0o777 == 0o640 and state_path.stat().st_size < 2048, 'cooldown state is small and private')
        check(call_log.read_text().splitlines() == ['called'], 'first throttled request stops the entire batch')
        with sqlite3.connect(database) as db:
            check(db.execute('SELECT * FROM images ORDER BY image_id').fetchall() == before, 'cooldown changes no image field or attempt counter')
        restarted = subprocess.run([PHP,str(worker),'2'],env=env,capture_output=True,text=True,timeout=10)
        check(restarted.returncode == 0 and 'cooldown active' in restarted.stdout, 'cooldown survives process restart')
        check(call_log.read_text().splitlines() == ['called'], 'active cooldown makes no source request')
        state['until'] = int(time.time()) - 1
        state_path.write_text(json.dumps(state))
        env['FIXTURE_HTTP_STATUS'] = '200'
        resumed = subprocess.run([PHP,str(worker),'2'],env=env,capture_output=True,text=True,timeout=10)
        check(resumed.returncode == 0, 'expired cooldown resumes worker: '+resumed.stderr[-250:])
        with sqlite3.connect(database) as db:
            check(db.execute("SELECT COUNT(*) FROM images WHERE download_status='ready' AND download_attempts=1").fetchone()[0] == 2, 'resumed images each use one successful attempt')
            check(db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok', 'catalog integrity preserved')

if __name__ == '__main__':
    scenario(429,'120',120)
    scenario(503,email.utils.formatdate(time.time()+300,usegmt=True),300)
    scenario(500,'',60)
    scenario(502,'invalid',60)
    scenario(429,'1',60)
    scenario(503,email.utils.formatdate(time.time()-300,usegmt=True),60)
    print(json.dumps({'ok':True,'suite':'worker-backoff','checks':checks,'productionTouched':False,'networkUsed':False}))
