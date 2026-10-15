#!/usr/bin/env python3
"""Offline regression tests: isolated catalogs, fake HTML fetches, no live writes."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import email.utils
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import threading
import time
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("reaction_backfill", ROOT / "reaction-backfill.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
checks = 0


def check(value, label):
    global checks
    if not value:
        raise AssertionError(label)
    checks += 1


def html(value):
    return '<!doctype html><script id="__NEXT_DATA__" type="application/json">' + json.dumps(value) + '</script>'


def page(image_id, stats=None):
    return html({"props": {"pageProps": {"image": {"id": str(image_id), "width": 768, "height": 1024, "stats": stats if stats is not None else {"likeCountAllTime": 10, "heartCountAllTime": 0, "laughCountAllTime": 2, "cryCountAllTime": 1, "tippedAmountCountAllTime": 0}}}}})


def allow_robots(*_):
    return "User-agent: *\nDisallow: /api/*\nAllow: /images/*\n"


fixture = json.loads((ROOT / 'tests/reaction-page-fixture.json').read_text())
expected = {"likeCount": 31, "heartCount": 18, "laughCount": 0, "cryCount": 1, "buzzCount": 0}
check(worker.parse_reactions(html(fixture), '145498895') == expected, 'sanitized real SSR page preserves all five observed counts')
check(worker.parse_reactions(html(fixture), '145498896') == {}, 'different image is never borrowed')
for invalid in (True, False, -1, 1.5, "20", None, [], {}, float('nan'), float('inf'), 9007199254740992, 10**1000):
    check(worker.normalize_reactions({'likeCount': invalid}) == {}, 'invalid reaction value ignored: ' + str(type(invalid)))
for valid in (0, 1, 11.0, 9007199254740991):
    check(worker.normalize_reactions({'likeCount': valid}) == {'likeCount': int(valid)}, 'known numeric count accepted')
check(worker.complete(dict.fromkeys(worker.CORE_REACTION_KEYS, 0)), 'four observed zeros are complete, buzz optional')
check(not worker.complete({'likeCount': 0}), 'partial zeros still incomplete')
check(worker.parse_reactions(page('41', {'statsUnknown': True, **dict.fromkeys(worker.REACTION_KEYS, 0)}), '41') == {}, 'unknown stats zero placeholders ignored')
check(worker.parse_reactions(page('41', {'statsUnknown': True, 'likeCountAllTime': 0}), '41') == {}, 'unknown AllTime placeholders ignored')
check(worker.parse_reactions(html({'id': '41', 'stats': {'likeCount': 8}}), '41') == {}, 'bare object cannot impersonate an image')
check(worker.parse_reactions(html({'user': {'id': '41', 'url': 'profile', 'stats': {'likeCount': 8}}}), '41') == {}, 'matching user id cannot impersonate image')
check(worker.parse_reactions(html({'comments': [{'id': 9, 'imageId': 41, 'stats': {'likeCount': 99}}]}), '41') == {}, 'comment with target imageId cannot impersonate aggregate image stats')
check(worker.parse_reactions(html({'comments': [{'id': 41, 'width': 3, 'height': 4, 'stats': {'likeCount': 99}}]}), '41') == {}, 'comment image dimensions cannot override ancestor context')
check(worker.parse_reactions(html({'posts': [{'id': 41, 'width': 3, 'height': 4, 'stats': {'likeCount': 99}}]}), '41') == {}, 'post with matching id cannot impersonate image')
check(worker.parse_reactions(html({'image': {'id': '41', 'statsUnknown': True, 'stats': {'likeCountAllTime': 0}}}), '41') == {}, 'parent unknown flag suppresses nested placeholders')
check(worker.parse_reactions(html({'image': {'id': '41', 'stats': {'likeCount': 2}, 'recommendations': [{'id': '99', 'width': 10, 'height': 10, 'stats': {'heartCount': 999}}]}}), '41') == {'likeCount': 2}, 'recommendation counts do not leak')
check(worker.parse_reactions(html({'image': {'id': '41', 'stats': {'likeCount': 0}, 'reactions': [{'reaction': 'Heart', 'userId': 7}]}}), '41') == {'likeCount': 0}, 'current-user reaction list is not aggregate totals')
check(worker.parse_reactions('<script>window.fake = {"id":41,"likeCount":9}</script>', '41') == {}, 'arbitrary scripts not executed or parsed')
check(worker.parse_reactions('<script id="__NEXT_DATA__">broken</script>', '41') == {}, 'malformed JSON is safely absent')
check(worker.retry_after_seconds('10', 100) == 10, 'numeric Retry-After')
check(worker.retry_after_seconds(email.utils.format_datetime(datetime.fromtimestamp(120, timezone.utc)), 100) == 20, 'dated Retry-After')
check(worker.retry_after_seconds('NaN', 100) == 0, 'invalid delay ignored')
check(worker.retry_after_seconds('9999999', 100) == 86400, 'delay capped at one day')
check(worker.failure_delay(worker.FetchFailure('429', status=429), 1) >= 60, 'rate-limit minimum pause')
check(worker.failure_delay(worker.FetchFailure('403', status=403), 1) >= 900, 'denied page pauses fifteen minutes')
check(worker.failure_delay(worker.FetchFailure('429', status=429, retry_after=3600), 1) == 3600, 'server Retry-After honored')

robots = worker.RobotsPolicy('User-agent: *\nDisallow: /\nAllow: /images/*\nDisallow: /images/private$\n')
check(robots.allows('/images/41'), 'wildcard allow beats shorter disallow')
check(not robots.allows('/images/private'), 'longer terminal disallow wins')
check(robots.allows('/images/private/41'), 'terminal robots rule matches only exact suffix')
check(not robots.allows('/api/test'), 'robots blocks non-image route')
robots = worker.RobotsPolicy('User-agent: *\nDisallow: /\nUser-agent: Index-Civitai-Reaction-Backfill\nAllow: /images/\nCrawl-delay: 5\n')
check(robots.allows('/images/41') and robots.delay == 5, 'specific agent and crawl delay honored')
check(worker.RobotsPolicy('User-agent: *\nAllow: /images/\nDisallow: /images/\n').allows('/images/41'), 'equal-specificity allow wins')
check(not worker.RobotsPolicy('User-agent: *\nAllow: /\nUser-agent: curl\nDisallow: /\n', 'curl/8.1.0').allows('/images/41'), 'robots follows selected transport user agent')

curl_calls = []


def curl_fixture(args, **kwargs):
    curl_calls.append(args)
    assert args[:2] == ['curl', '--disable'] and '--location' not in args and '--retry' not in args
    headers = Path(args[args.index('--dump-header') + 1])
    body = Path(args[args.index('--output') + 1])
    headers.write_text('HTTP/2 200\r\nContent-Type: text/html; charset=utf-8\r\n\r\n')
    body.write_text(page('41'))
    return worker.subprocess.CompletedProcess(args, 0, b'200', b'')


with patch.object(worker.subprocess, 'run', curl_fixture):
    check(worker.parse_reactions(worker.fetch_page_curl('https://civitai.red/images/41', '41'), '41')['likeCount'] == 10, 'curl adapter parses constrained HTML fixture')
    check(len(curl_calls) == 1, 'curl performs one explicit page request')
    check(not Path(curl_calls[0][curl_calls[0].index('--output') + 1]).parent.exists(), 'curl temporary page files removed')


def curl_redirect(args, **kwargs):
    headers = Path(args[args.index('--dump-header') + 1])
    Path(args[args.index('--output') + 1]).write_text('redirect')
    headers.write_text('HTTP/2 302\r\nLocation: https://image.civitai.com/secret.png\r\n\r\n')
    return worker.subprocess.CompletedProcess(args, 0, b'302', b'')


with patch.object(worker.subprocess, 'run', curl_redirect):
    try:
        worker.fetch_page_curl('https://civitai.red/images/41', '41')
        raise AssertionError('unsafe redirect accepted')
    except worker.FetchFailure as error:
        check(not error.retryable, 'redirect to media host rejected before following')


def curl_429(args, **kwargs):
    Path(args[args.index('--dump-header') + 1]).write_text('HTTP/2 429\r\nRetry-After: 240\r\n\r\n')
    return worker.subprocess.CompletedProcess(args, 0, b'429', b'')


with patch.object(worker.subprocess, 'run', curl_429):
    try:
        worker.fetch_page_curl('https://civitai.red/images/41', '41')
        raise AssertionError('rate limit ignored')
    except worker.FetchFailure as error:
        check(error.status == 429 and error.retry_after == 240 and error.global_pause, 'curl rate limit preserves global cooldown semantics')


def create_catalog(path, count=17):
    with worker.connect(path) as db:
        db.executescript((ROOT / 'schema.sql').read_text())
        for image_id in range(1, count + 1):
            db.execute("INSERT INTO images(image_id,source_url,prompt,negative_prompt,tags_json,model_name,loras_json,file_path,sha256,download_status,style_category,style_confidence,style_signals_json,discovered_at,updated_at) VALUES(?, 'https://image.civitai.com/media-never-requested','fixture positive prompt','fixture negative','[\"tag\"]','fixture model','[\"lora\"]','private/file.png','fixturehash','ready','realistic',0.7,'[\"style\"]','created','unchanged')", (str(image_id),))
        db.execute("INSERT INTO community_reactions(image_id,visitor_hash,reaction_type,created_at) VALUES('1',?,'heart',123)", ('a' * 64,))
        db.execute("INSERT INTO images_fts VALUES('1','fts fixture','negative','tag','model','lora')")


def protected_snapshot(path):
    with worker.connect(path) as db:
        columns = [row[1] for row in db.execute('PRAGMA table_info(images)') if row[1] != 'reactions_json']
        return {'images': db.execute('SELECT ' + ','.join(columns) + ' FROM images ORDER BY image_id').fetchall(),
                **{table: db.execute('SELECT * FROM ' + table).fetchall() for table in ('community_reactions', 'community_reaction_counts', 'images_fts')}}


with tempfile.TemporaryDirectory(prefix='reaction-backfill-offline-') as temporary:
    base = Path(temporary)
    catalog = base / 'catalog.sqlite'
    create_catalog(catalog)
    with worker.connect(catalog) as db:
        db.execute('UPDATE images SET reactions_json=? WHERE image_id=?', (json.dumps(dict.fromkeys(worker.CORE_REACTION_KEYS, 0)), '17'))
        db.execute('UPDATE images SET reactions_json=? WHERE image_id=?', ('{"heartCount":4,"legacy":"preserved"}', '1'))
    before = protected_snapshot(catalog)
    job = base / 'first-job'
    report = worker.snapshot(catalog, job, 'https://civitai.red')
    check(report['snapshotTotal'] == 17 and report['snapshotSelected'] == 16, 'snapshot selects missing and partial, skips known zeros')
    try:
        worker.snapshot(catalog, job, 'https://civitai.red')
        raise AssertionError('snapshot overwritten')
    except FileExistsError:
        check(True, 'existing snapshot immutable')
    active = 0
    peak = 0
    visited = []
    lock = threading.Lock()
    barrier = threading.Barrier(8)

    def fetch(url, image_id, timeout):
        global active, peak
        with lock:
            active += 1
            peak = max(active, peak)
            visited.append((url, image_id))
        barrier.wait(timeout=3)
        with lock:
            active -= 1
        return page(image_id)

    report = worker.run(job, once=True, fetcher=fetch, robots_fetcher=allow_robots, emit=lambda *_: None)
    check(peak == 8 and len(visited) == 8, 'exactly eight page visits run concurrently')
    check(report['counts'].get('done') == 8 and report['remaining'] == 8, 'first wave progress persisted')
    check(all(url == 'https://civitai.red/images/' + image_id for url, image_id in visited), 'only canonical image pages requested, no API or media')
    check(protected_snapshot(catalog) == before, 'all prompt/style/media/FTS/community fields unchanged')
    with worker.connect(catalog) as db:
        first = json.loads(db.execute('SELECT reactions_json FROM images WHERE image_id=?', ('1',)).fetchone()[0])
        check(first['likeCount'] == 10 and first['heartCount'] == 0 and first['legacy'] == 'preserved', 'fresh observed zero replaces prior count; other keys retained')
        db.execute("INSERT INTO images(image_id,source_url,prompt,discovered_at,updated_at) VALUES('999','https://image.civitai.com/later','new image','later','later')")
    report = worker.run(job, wave_wait=0, fetcher=lambda url, image_id, _: page(image_id), robots_fetcher=allow_robots, emit=lambda *_: None)
    check(report['remaining'] == 0 and report['counts']['done'] == 16, 'resume completes original snapshot')
    with worker.connect(catalog) as db:
        check(db.execute("SELECT reactions_json FROM images WHERE image_id='999'").fetchone()[0] == '{}', 'records added after snapshot untouched')
    with worker.open_state(job) as state:
        state.execute("UPDATE items SET status='leased',lease_until=? WHERE image_id='1'", (time.time() + 600,))
    worker.run(job, once=True, fetcher=lambda url, image_id, _: page(image_id), robots_fetcher=allow_robots, emit=lambda *_: None)
    check(worker.status(job)['remaining'] == 0, 'abandoned lease resumes after exclusive process lock')
    check(worker.merge_reactions(catalog, 'does-not-exist', {'likeCount': 1}) == 'removed', 'deleted catalog image never recreated')
    check(worker.merge_reactions(catalog, '999', {'likeCount': 0}) == 'partial', 'partial observation preserved without invented other zeros')
    with worker.connect(catalog) as db:
        check(json.loads(db.execute("SELECT reactions_json FROM images WHERE image_id='999'").fetchone()[0]) == {'likeCount': 0}, 'partial merge only contains observed fields')

    def new_job(name):
        target = base / name
        worker.snapshot(catalog, target, 'https://civitai.red')
        return target

    job429 = new_job('rate-limit')
    request_count = [0]

    def rate_limited(*_):
        request_count[0] += 1
        raise worker.FetchFailure('HTTP 429', status=429, retry_after=120, global_pause=True)

    report = worker.run(job429, once=True, fetcher=rate_limited, robots_fetcher=allow_robots, emit=lambda *_: None)
    check(report['cooldownUntil'] >= time.time() + 115 and report['counts']['retry'] == 1, 'global Retry-After cooldown persisted')
    worker.run(job429, once=True, fetcher=rate_limited, robots_fetcher=allow_robots, emit=lambda *_: None)
    check(request_count[0] == 1, 'restart respects cooldown without another request')
    with worker.open_state(job429) as state:
        worker.set_meta(state, 'cooldown_until', 0)
        state.execute("UPDATE items SET attempts=3,next_attempt=0")
    report = worker.run(job429, once=True, fetcher=rate_limited, robots_fetcher=allow_robots, emit=lambda *_: None)
    check(report['counts']['failed'] == 1 and report['remaining'] == 0, 'bounded retries terminate permanently failing image')

    missing_job = new_job('missing-page')
    report = worker.run(missing_job, once=True, fetcher=lambda *_: '<html>No counts here</html>', robots_fetcher=allow_robots, emit=lambda *_: None)
    check(report['counts']['unavailable'] == 1, 'no counts marked unavailable rather than falsely zero')
    denied_job = new_job('robots-denied')
    calls = []
    report = worker.run(denied_job, once=True, fetcher=lambda *_: calls.append(1), robots_fetcher=lambda *_: 'User-agent: *\nDisallow: /images/\n', emit=lambda *_: None)
    check(report['counts']['blocked'] == 1 and not calls, 'robots disallow prevents every image request')
    try:
        worker.run(denied_job, concurrency=9, once=True, robots_fetcher=allow_robots)
        raise AssertionError('concurrency cap ignored')
    except ValueError:
        check(True, 'concurrency above eight rejected')
    try:
        worker.snapshot(catalog, base / 'bad-origin', 'https://example.com')
        raise AssertionError('origin allowlist ignored')
    except ValueError:
        check(True, 'untrusted origin rejected')

print(json.dumps({'ok': True, 'checks': checks, 'liveNetworkUsed': False, 'productionTouched': False}))
