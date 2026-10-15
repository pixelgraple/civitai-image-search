#!/usr/bin/env python3
"""Snapshot and repair source reactions using public image pages, never image bytes.

Each invocation of ``snapshot`` creates a fixed set of existing catalog IDs.
``run`` resumes that set, with at most eight page requests in flight. No Civitai
API, browser session, account cookie, media request, or third-party service is
used. Unknown counts remain unknown; only explicitly observed counts are saved.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import contextmanager
from datetime import datetime, timezone
import email.utils
from html.parser import HTMLParser
import json
import math
import os
from pathlib import Path
import re
import signal
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
from typing import Callable
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

REACTION_KEYS = ("likeCount", "heartCount", "laughCount", "cryCount", "buzzCount")
CORE_REACTION_KEYS = REACTION_KEYS[:4]
USER_AGENT = "Index-Civitai-Reaction-Backfill/1.0 (+https://search-civitai.xyz)"
ALLOWED_ORIGINS = ("https://civitai.com", "https://civitai.red")
MAX_SAFE_INTEGER = 9007199254740991
MAX_PAGE_BYTES = 16 * 1024 * 1024
SCHEMA_VERSION = "1"
STOP = threading.Event()


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def normalize_reactions(value: object) -> dict[str, int]:
    """Same numeric whitelist as the PHP ingestion normalizer (booleans excluded)."""
    if not isinstance(value, dict):
        return {}
    return {key: int(number) for key in REACTION_KEYS
            if isinstance((number := value.get(key)), (int, float))
            and not isinstance(number, bool) and 0 <= number <= MAX_SAFE_INTEGER
            and math.isfinite(number) and int(number) == number}


def load_reactions(value: object) -> dict[str, int]:
    try:
        return normalize_reactions(json.loads(value)) if isinstance(value, str) else normalize_reactions(value)
    except (ValueError, TypeError):
        return {}


def valid_image_id(value: object) -> bool:
    return isinstance(value, (str, int)) and not isinstance(value, bool) and bool(re.fullmatch(r"[1-9]\d{0,19}", str(value)))


def complete(value: dict) -> bool:
    return all(key in value for key in CORE_REACTION_KEYS)


def page_reactions(value: object) -> dict[str, int]:
    """Civitai SSR uses AllTime fields; unknown stats placeholders are not zeros."""
    if not isinstance(value, dict) or value.get("statsUnknown") is True:
        return {}
    aliases = {key: key + "AllTime" for key in CORE_REACTION_KEYS}
    aliases["buzzCount"] = "tippedAmountCountAllTime"
    result = normalize_reactions(value)
    for key, alias in aliases.items():
        count = normalize_reactions({key: value.get(alias)})
        result.update(count)
    return result


class JSONScripts(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.documents: list[object] = []
        self.capturing = False
        self.parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list) -> None:
        attrs = dict(attrs)
        if tag == "script":
            self.capturing = attrs.get("id") == "__NEXT_DATA__" or attrs.get("type") in ("application/json", "application/ld+json")
            self.parts = []

    def handle_data(self, data: str) -> None:
        if self.capturing:
            self.parts.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag != "script" or not self.capturing:
            return
        try:
            self.documents.append(json.loads("".join(self.parts)))
        except (ValueError, RecursionError):
            pass
        self.capturing = False
        self.parts = []


def parse_reactions(html: str, image_id: str) -> dict[str, int]:
    """Read counts attached to the exact image, never recommendations or comments.

    Only direct counts and named stats/reaction containers of a matched image
    object are considered. Descendant objects must establish their own ID.
    """
    parser = JSONScripts()
    parser.feed(html)
    result: dict[str, int] = {}
    stack = [(document, ()) for document in parser.documents]
    nodes = 0
    while stack:
        value, path = stack.pop()
        nodes += 1
        if nodes > 250000:
            raise ValueError("Page JSON exceeds the structural limit")
        if isinstance(value, list):
            stack.extend((item, path) for item in value)
        elif isinstance(value, dict):
            if any(part.lower() in ("comment", "comments", "user", "users", "creator", "creators", "profile", "profiles", "author", "authors", "post", "posts") for part in path):
                continue
            context = path[-1] if path else ""
            explicit_image_id = value.get("imageId")
            ordinary_id = value.get("id")
            image_shape = context.lower() in ("image", "images", "imagebyid", "imagedata") or ("width" in value and "height" in value) or ("url" in value and ("postId" in value or "meta" in value))
            metric_shape = image_shape or context.lower() in ("imagestats", "imagemetrics", "imagereactions")
            matches = (metric_shape and valid_image_id(explicit_image_id) and str(explicit_image_id) == str(image_id)) or (image_shape and valid_image_id(ordinary_id) and str(ordinary_id) == str(image_id))
            if matches:
                if value.get("statsUnknown") is True:
                    continue
                observed = page_reactions(value)
                for field in ("stats", "metrics", "reactionCounts", "reactions"):
                    observed.update(page_reactions(value.get(field)))
                # Multiple independent matched records can carry different keys.
                # Conflicting same-key observations use the last structured record.
                result.update(observed)
            stack.extend((item, (*path, key)) for key, item in value.items() if isinstance(item, (dict, list)))
    return result


class FetchFailure(Exception):
    def __init__(self, reason: str, *, status: int = 0, retry_after: float = 0,
                 retryable: bool = True, global_pause: bool = False) -> None:
        super().__init__(reason)
        self.status = status
        self.retry_after = retry_after
        self.retryable = retryable
        self.global_pause = global_pause


def retry_after_seconds(value: str | None, now: float | None = None) -> float:
    if not value:
        return 0
    now = time.time() if now is None else now
    try:
        seconds = float(value)
    except (ValueError, OverflowError):
        try:
            seconds = email.utils.parsedate_to_datetime(value).timestamp() - now
        except (ValueError, TypeError, OverflowError):
            return 0
    return max(0, min(seconds, 86400)) if math.isfinite(seconds) else 0


class ImagePageRedirect(HTTPRedirectHandler):
    def __init__(self, image_id: str) -> None:
        self.image_id = image_id

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        parsed = urlsplit(newurl)
        expected_path = "/images/" + self.image_id if self.image_id else "/robots.txt"
        if parsed.scheme != "https" or parsed.netloc not in ("civitai.com", "civitai.red") or parsed.path.rstrip("/") != expected_path:
            raise FetchFailure("Image page redirected outside its public image URL", status=code, retryable=False)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def fetch_page(url: str, image_id: str, timeout: float = 25) -> str:
    parsed = urlsplit(url)
    if parsed.scheme != "https" or parsed.netloc not in ("civitai.com", "civitai.red") or parsed.path != "/images/" + image_id or parsed.query or parsed.fragment:
        raise FetchFailure("Invalid public image page URL", retryable=False)
    request = Request(url, headers={
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml", "Accept-Encoding": "identity",
        "Accept-Language": "en-US,en;q=0.9",
    })
    try:
        with build_opener(ImagePageRedirect(image_id)).open(request, timeout=timeout) as response:
            content_type = response.headers.get_content_type()
            if content_type not in ("text/html", "application/xhtml+xml"):
                raise FetchFailure("Page response is not HTML; media was not read", retryable=False)
            declared = response.headers.get("Content-Length", "")
            if declared.isdigit() and int(declared) > MAX_PAGE_BYTES:
                raise FetchFailure("Image page exceeds the response size limit", retryable=False)
            data = response.read(MAX_PAGE_BYTES + 1)
            if len(data) > MAX_PAGE_BYTES:
                raise FetchFailure("Image page exceeds the response size limit", retryable=False)
            return data.decode(response.headers.get_content_charset() or "utf-8", errors="replace")
    except HTTPError as error:
        status = error.code
        delay = retry_after_seconds(error.headers.get("Retry-After"))
        error.close()
        raise FetchFailure("HTTP " + str(status), status=status, retry_after=delay,
                           retryable=status in (401, 403, 408, 425, 429) or status >= 500,
                           global_pause=status in (401, 403, 429)) from None
    except (URLError, TimeoutError, OSError) as error:
        raise FetchFailure("Page connection failed: " + type(error).__name__) from None


def fetch_robots(origin: str, timeout: float = 25) -> str:
    if origin not in ALLOWED_ORIGINS:
        raise ValueError("Invalid robots origin")
    request = Request(origin + "/robots.txt", headers={"User-Agent": USER_AGENT, "Accept": "text/plain", "Accept-Encoding": "identity"})
    try:
        with build_opener(ImagePageRedirect("")).open(request, timeout=timeout) as response:
            if response.headers.get_content_type() not in ("text/plain", "application/octet-stream"):
                raise FetchFailure("Robots response is not plain text")
            body = response.read(512 * 1024 + 1)
            if len(body) > 512 * 1024:
                raise FetchFailure("Robots response exceeds size limit", retryable=False)
            return body.decode("utf-8", errors="replace")
    except HTTPError as error:
        status_code = error.code
        delay = retry_after_seconds(error.headers.get("Retry-After"))
        error.close()
        if status_code == 404:
            return "User-agent: *\nAllow: /\n"
        raise FetchFailure("Robots HTTP " + str(status_code), status=status_code,
                           retry_after=delay, global_pause=True) from None
    except (URLError, TimeoutError, OSError) as error:
        raise FetchFailure("Robots connection failed: " + type(error).__name__) from None


def curl_request(url: str, image_id: str, timeout: float, *, robots: bool = False) -> tuple[int, dict, str]:
    """Explicit curl transport with bounded files and no automatic redirects/retries.

    curl's own configuration is disabled, so no credentials, cookies, request
    hooks, or custom redirects can be inherited from the service account.
    Each redirect is checked before the next request is issued.
    """
    limit = 512 * 1024 if robots else MAX_PAGE_BYTES
    for redirect in range(4):
        parsed = urlsplit(url)
        expected_path = "/robots.txt" if robots else "/images/" + image_id
        if parsed.scheme != "https" or parsed.netloc not in ("civitai.com", "civitai.red") or parsed.path.rstrip("/") != expected_path or parsed.query or parsed.fragment:
            raise FetchFailure("Invalid public source URL", retryable=False)
        with tempfile.TemporaryDirectory(prefix="index-civitai-reactions-") as directory:
            headers_path = Path(directory) / "headers.txt"
            body_path = Path(directory) / "page.html"
            args = ["curl", "--disable", "--silent", "--show-error", "--proto", "=https",
                    "--connect-timeout", str(min(timeout, 10)), "--max-time", str(timeout),
                    "--max-filesize", str(limit), "--max-redirs", "0",
                    "--header", "Accept-Encoding: identity", "--header", "Accept: text/plain" if robots else "Accept: text/html,application/xhtml+xml",
                    "--dump-header", str(headers_path), "--output", str(body_path),
                    "--write-out", "%{http_code}", "--url", url]
            try:
                result = subprocess.run(args, capture_output=True, timeout=timeout + 5, check=False)
            except (OSError, subprocess.TimeoutExpired) as error:
                raise FetchFailure("curl transport failed: " + type(error).__name__) from None
            code_text = result.stdout.decode("ascii", errors="ignore").strip()
            status_code = int(code_text) if re.fullmatch(r"\d{3}", code_text) else 0
            headers = {}
            if headers_path.exists():
                if headers_path.stat().st_size > 262144:
                    raise FetchFailure("Source response headers exceed size limit", retryable=False)
                for line in headers_path.read_text(encoding="latin-1").splitlines():
                    if line.startswith("HTTP/"):
                        headers = {}
                    elif ":" in line:
                        key, value = line.split(":", 1)
                        headers[key.strip().lower()] = value.strip()
            if status_code in (301, 302, 303, 307, 308):
                if redirect == 3:
                    raise FetchFailure("Too many source-page redirects", status=status_code, retryable=False)
                # Relative redirects may refer only to the same source host.
                destination = headers.get("location", "")
                if destination.startswith("/") and not destination.startswith("//"):
                    destination = parsed.scheme + "://" + parsed.netloc + destination
                url = destination
                continue
            if status_code >= 400:
                return status_code, headers, ""
            if result.returncode:
                raise FetchFailure("curl page request failed with code " + str(result.returncode))
            if status_code != 200:
                raise FetchFailure("Unexpected page HTTP " + str(status_code), status=status_code, retryable=False)
            content_type = headers.get("content-type", "").split(";", 1)[0].strip().lower()
            allowed_types = ("text/plain", "application/octet-stream") if robots else ("text/html", "application/xhtml+xml")
            if content_type not in allowed_types:
                raise FetchFailure("Source response is not " + ("robots text" if robots else "page HTML"), retryable=False)
            if not body_path.is_file() or body_path.stat().st_size > limit:
                raise FetchFailure("Source response exceeds size limit", retryable=False)
            return status_code, headers, body_path.read_text(encoding="utf-8", errors="replace")
    raise FetchFailure("Source redirect limit exceeded", retryable=False)


def fetch_page_curl(url: str, image_id: str, timeout: float = 25) -> str:
    status_code, headers, body = curl_request(url, image_id, timeout)
    if status_code >= 400:
        raise FetchFailure("HTTP " + str(status_code), status=status_code,
                           retry_after=retry_after_seconds(headers.get("retry-after")),
                           retryable=status_code in (401, 403, 408, 425, 429) or status_code >= 500,
                           global_pause=status_code in (401, 403, 429))
    return body


def fetch_robots_curl(origin: str, timeout: float = 25) -> str:
    if origin not in ALLOWED_ORIGINS:
        raise ValueError("Invalid robots origin")
    status_code, headers, body = curl_request(origin + "/robots.txt", "", timeout, robots=True)
    if status_code == 404:
        return "User-agent: *\nAllow: /\n"
    if status_code >= 400:
        raise FetchFailure("Robots HTTP " + str(status_code), status=status_code,
                           retry_after=retry_after_seconds(headers.get("retry-after")), global_pause=True)
    return body


def curl_user_agent() -> str:
    result = subprocess.run(["curl", "--disable", "--version"], capture_output=True, check=True, timeout=5)
    first_line = result.stdout.decode("ascii", errors="ignore").splitlines()[0]
    match = re.match(r"curl ([0-9.]+)", first_line)
    if not match:
        raise ValueError("Unable to identify curl transport")
    return "curl/" + match.group(1)


class RobotsPolicy:
    """Robots group selection and longest-match rules, including * and terminal $."""
    def __init__(self, text: str, user_agent: str = USER_AGENT) -> None:
        groups: list[dict] = []
        current: dict | None = None
        has_directives = False
        for raw in text.splitlines():
            line = raw.split("#", 1)[0].strip()
            if ":" not in line:
                continue
            key, value = (part.strip() for part in line.split(":", 1))
            key = key.lower()
            if key == "user-agent":
                if current is None or has_directives:
                    current = {"agents": [], "rules": [], "delay": 0.0}
                    groups.append(current)
                    has_directives = False
                current["agents"].append(value.lower())
            elif current is not None:
                has_directives = True
                if key in ("allow", "disallow") and value:
                    current["rules"].append((key == "allow", value))
                elif key == "crawl-delay":
                    try:
                        delay = float(value)
                        if math.isfinite(delay) and delay >= 0:
                            current["delay"] = max(current["delay"], delay)
                    except ValueError:
                        pass
        matches = []
        agent = user_agent.lower()
        for group in groups:
            rank = max((0 if item == "*" else len(item) for item in group["agents"] if item == "*" or item in agent), default=-1)
            if rank >= 0:
                matches.append((rank, group))
        best = max((rank for rank, _ in matches), default=-1)
        selected = [group for rank, group in matches if rank == best]
        self.rules = [rule for group in selected for rule in group["rules"]]
        self.delay = max((group["delay"] for group in selected), default=0.0)

    def allows(self, path: str) -> bool:
        matches = []
        for allow, rule in self.rules:
            end = rule.endswith("$")
            literal = rule[:-1] if end else rule
            expression = "^" + ".*".join(re.escape(part) for part in literal.split("*")) + ("$" if end else "")
            if re.search(expression, path):
                matches.append((len(literal.replace("*", "")), allow))
        return max(matches, default=(0, True))[1]


class Database(sqlite3.Connection):
    def __exit__(self, *args):
        try:
            return super().__exit__(*args)
        finally:
            self.close()


def connect(path: Path, *, readonly: bool = False) -> sqlite3.Connection:
    if readonly:
        db = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=15, factory=Database)
    else:
        db = sqlite3.connect(path, timeout=15, factory=Database)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA busy_timeout=15000")
    return db


def open_state(job_dir: Path) -> sqlite3.Connection:
    path = job_dir / "job.sqlite"
    if not path.is_file():
        raise ValueError("Job not found; create a snapshot first")
    state = connect(path)
    if state.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()[0] != SCHEMA_VERSION:
        state.close()
        raise ValueError("Unsupported reaction job schema")
    return state


def meta(state: sqlite3.Connection, key: str, default: str = "") -> str:
    row = state.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
    return row[0] if row else default


def set_meta(state: sqlite3.Connection, key: str, value: object) -> None:
    state.execute("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, str(value)))


def snapshot(catalog: Path, job_dir: Path, origin: str) -> dict:
    if origin not in ALLOWED_ORIGINS:
        raise ValueError("Only public Civitai image-page origins are allowed")
    if not catalog.is_file():
        raise ValueError("Catalog database does not exist")
    job_dir.mkdir(parents=True, exist_ok=True, mode=0o750)
    path = job_dir / "job.sqlite"
    # Exclusive creation prevents replacing or extending a previous snapshot.
    descriptor = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o640)
    os.close(descriptor)
    with connect(path) as state:
        state.executescript("""
            PRAGMA journal_mode=WAL;
            CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
            CREATE TABLE items(
                image_id TEXT PRIMARY KEY,page_url TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,
                next_attempt REAL NOT NULL DEFAULT 0,lease_until REAL NOT NULL DEFAULT 0,
                last_error TEXT NOT NULL DEFAULT '',observed_json TEXT NOT NULL DEFAULT '{}',
                completed_at TEXT NOT NULL DEFAULT ''
            );
            CREATE INDEX items_ready ON items(status,next_attempt,lease_until);
        """)
        with connect(catalog, readonly=True) as source:
            source.execute("BEGIN")
            total = source.execute("SELECT COUNT(*) FROM images").fetchone()[0]
            selected = 0
            for row in source.execute("SELECT image_id,reactions_json FROM images ORDER BY rowid"):
                if valid_image_id(row["image_id"]) and not complete(load_reactions(row["reactions_json"])):
                    state.execute("INSERT INTO items(image_id,page_url) VALUES(?,?)", (str(row["image_id"]), origin + "/images/" + str(row["image_id"])))
                    selected += 1
            for key, value in {"schema_version": SCHEMA_VERSION, "catalog": str(catalog.resolve()),
                               "origin": origin, "created_at": utc_now(), "snapshot_total": total,
                               "snapshot_selected": selected, "cooldown_until": 0,
                               "last_status": "snapshot created"}.items():
                set_meta(state, key, value)
        state.commit()
    return status(job_dir)


def status(job_dir: Path) -> dict:
    with open_state(job_dir) as state:
        counts = {row["status"]: row["count"] for row in state.execute("SELECT status,COUNT(*) AS count FROM items GROUP BY status")}
        return {"job": str(job_dir), "createdAt": meta(state, "created_at"),
                "snapshotTotal": int(meta(state, "snapshot_total", "0")),
                "snapshotSelected": int(meta(state, "snapshot_selected", "0")),
                "counts": counts, "attempts": state.execute("SELECT COALESCE(SUM(attempts),0) FROM items").fetchone()[0],
                "cooldownUntil": float(meta(state, "cooldown_until", "0")),
                "lastStatus": meta(state, "last_status"),
                "remaining": sum(counts.get(name, 0) for name in ("pending", "retry", "leased"))}


def merge_reactions(catalog: Path, image_id: str, observed: dict) -> str:
    """Read+merge under the writer lock, updating exactly one source-metadata field."""
    observed = normalize_reactions(observed)
    if not observed:
        return "unavailable"
    with connect(catalog) as db:
        db.execute("BEGIN IMMEDIATE")
        row = db.execute("SELECT reactions_json FROM images WHERE image_id=?", (image_id,)).fetchone()
        if not row:
            return "removed"
        try:
            existing = json.loads(row[0])
        except (ValueError, TypeError):
            existing = {}
        if not isinstance(existing, dict):
            existing = {}
        merged = {**existing, **observed}
        db.execute("UPDATE images SET reactions_json=? WHERE image_id=?", (json.dumps(merged, separators=(",", ":")), image_id))
        return "done" if complete(normalize_reactions(merged)) else "partial"


@contextmanager
def process_lock(job_dir: Path):
    handle = open(job_dir / "worker.lock", "a+b")
    try:
        if os.name == "nt":
            import msvcrt
            if handle.tell() == 0:
                handle.write(b"0")
                handle.flush()
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            os.fchmod(handle.fileno(), 0o640)
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        handle.close()


def failure_delay(error: FetchFailure, attempts: int) -> float:
    minimum = 900 if error.status in (401, 403) else 60 if error.status == 429 else 15
    return max(error.retry_after, min(3600, minimum * (2 ** max(0, attempts - 1))))


def process_item(item: dict, timeout: float, fetcher: Callable = fetch_page) -> dict:
    try:
        html = fetcher(item["page_url"], item["image_id"], timeout)
        observed = parse_reactions(html, item["image_id"])
        return {"observed": observed, "error": None}
    except FetchFailure as error:
        return {"observed": {}, "error": error}
    except Exception as error:
        return {"observed": {}, "error": FetchFailure("Page processing failed: " + type(error).__name__)}


def run(job_dir: Path, *, concurrency: int = 8, wave_wait: float = 3, timeout: float = 25,
        max_attempts: int = 4, once: bool = False, fetcher: Callable = fetch_page,
        robots_fetcher: Callable = fetch_robots, user_agent: str = USER_AGENT, emit: Callable = print) -> dict:
    if not 1 <= concurrency <= 8 or not 0 <= wave_wait <= 3600 or not 1 <= timeout <= 120 or not 1 <= max_attempts <= 10:
        raise ValueError("Invalid worker limits")
    with process_lock(job_dir), open_state(job_dir) as state, ThreadPoolExecutor(max_workers=concurrency) as pool:
        catalog = Path(meta(state, "catalog"))
        if not catalog.is_file():
            raise ValueError("Catalog database disappeared")
        # The process lock proves the previous process exited. Its uncommitted
        # leases can resume immediately; repeating a reaction merge is idempotent.
        state.execute("UPDATE items SET status='retry',lease_until=0 WHERE status='leased'")
        state.commit()
        while not STOP.is_set():
            now = time.time()
            cooldown = float(meta(state, "cooldown_until", "0"))
            if cooldown > now:
                set_meta(state, "last_status", "source cooldown")
                state.commit()
                if once:
                    break
                STOP.wait(min(30, cooldown - now))
                continue
            if now - float(meta(state, "robots_checked_at", "0")) >= 86400:
                try:
                    robots_text = robots_fetcher(meta(state, "origin"), timeout)
                except FetchFailure as error:
                    set_meta(state, "last_status", str(error))
                    set_meta(state, "cooldown_until", time.time() + max(60, failure_delay(error, 1)))
                    state.commit()
                    emit(json.dumps(status(job_dir), separators=(",", ":")))
                    if once:
                        break
                    continue
                set_meta(state, "robots_text", robots_text)
                set_meta(state, "robots_checked_at", now)
                state.commit()
            policy = RobotsPolicy(meta(state, "robots_text"), user_agent)
            page_concurrency = 1 if policy.delay else concurrency
            rows = [dict(row) for row in state.execute("SELECT * FROM items WHERE status IN ('pending','retry') AND next_attempt<=? ORDER BY attempts,image_id LIMIT ?", (now, page_concurrency))]
            if not rows:
                pending = state.execute("SELECT MIN(next_attempt) FROM items WHERE status IN ('pending','retry')").fetchone()[0]
                if pending is None:
                    set_meta(state, "last_status", "snapshot complete")
                    state.commit()
                    break
                if once:
                    break
                STOP.wait(min(30, max(0.2, pending - now)))
                continue
            permitted = []
            for item in rows:
                if policy.allows("/images/" + item["image_id"]):
                    permitted.append(item)
                else:
                    state.execute("UPDATE items SET status='blocked',last_error='Disallowed by source robots.txt',completed_at=? WHERE image_id=?", (utc_now(), item["image_id"]))
            rows = permitted
            for item in rows:
                item["attempts"] += 1
                state.execute("UPDATE items SET status='leased',attempts=?,lease_until=? WHERE image_id=?", (item["attempts"], now + timeout + 60, item["image_id"]))
            set_meta(state, "last_status", "visiting " + str(len(rows)) + " image pages")
            state.commit()
            futures = {pool.submit(process_item, item, timeout, fetcher): item for item in rows}
            for future in as_completed(futures):
                item = futures[future]
                result = future.result()
                error = result["error"]
                next_attempt = 0
                observed = result["observed"]
                if error is None:
                    try:
                        outcome = merge_reactions(catalog, item["image_id"], observed)
                    except sqlite3.Error as db_error:
                        error = FetchFailure("Catalog update delayed: " + type(db_error).__name__)
                if error is not None:
                    delay = failure_delay(error, item["attempts"])
                    if error.global_pause:
                        set_meta(state, "cooldown_until", max(float(meta(state, "cooldown_until", "0")), time.time() + delay))
                    outcome = "retry" if error.retryable and item["attempts"] < max_attempts else "failed"
                    next_attempt = time.time() + delay if outcome == "retry" else 0
                    message = str(error)[:240]
                else:
                    message = "No explicit source reaction counts in page HTML" if outcome == "unavailable" else ""
                state.execute("UPDATE items SET status=?,next_attempt=?,lease_until=0,last_error=?,observed_json=?,completed_at=? WHERE image_id=?", (outcome, next_attempt, message, json.dumps(observed, separators=(",", ":")), "" if outcome == "retry" else utc_now(), item["image_id"]))
                state.commit()
            emit(json.dumps(status(job_dir), separators=(",", ":")))
            if once:
                break
            STOP.wait(max(wave_wait, policy.delay))
        if STOP.is_set():
            set_meta(state, "last_status", "stopped; snapshot can resume")
            state.commit()
    return status(job_dir)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("snapshot", "run", "status"))
    parser.add_argument("--job-dir", type=Path, required=True)
    parser.add_argument("--catalog", type=Path, default=Path("/data/civitai/database/catalog.sqlite"))
    parser.add_argument("--origin", choices=ALLOWED_ORIGINS, default=ALLOWED_ORIGINS[0])
    parser.add_argument("--concurrency", type=int, default=8)
    parser.add_argument("--wave-wait", type=float, default=3)
    parser.add_argument("--timeout", type=float, default=25)
    parser.add_argument("--max-attempts", type=int, default=4)
    parser.add_argument("--transport", choices=("urllib", "curl"), default="urllib")
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    os.umask(0o027)
    signal.signal(signal.SIGTERM, lambda *_: STOP.set())
    signal.signal(signal.SIGINT, lambda *_: STOP.set())
    try:
        if args.command == "snapshot":
            result = snapshot(args.catalog, args.job_dir, args.origin)
        elif args.command == "status":
            result = status(args.job_dir)
        else:
            options = {"fetcher": fetch_page_curl, "robots_fetcher": fetch_robots_curl, "user_agent": curl_user_agent()} if args.transport == "curl" else {}
            result = run(args.job_dir, concurrency=args.concurrency, wave_wait=args.wave_wait,
                         timeout=args.timeout, max_attempts=args.max_attempts, once=args.once, **options)
        print(json.dumps(result, separators=(",", ":")))
        return 0
    except (OSError, ValueError, sqlite3.Error, subprocess.SubprocessError) as error:
        print(json.dumps({"ok": False, "error": str(error)[:300]}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
