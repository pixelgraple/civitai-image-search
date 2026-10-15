#!/usr/bin/env python3
"""Isolated keyless API tests. No external requests, worker run, or production data.

Run on Linux with PHP/PDO SQLite: PHP_BINARY=/path/to/php python3 tests/public-ingestion.py
"""
import hashlib
import json
import os
import pathlib
import shutil
import socket
import sqlite3
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
PHP = os.environ.get("PHP_BINARY", "php")
HOST, PORT = "127.0.0.1", 18259
BASE = f"http://{HOST}:{PORT}/api.php"
checks = 0


def check(value, message):
    global checks
    if not value:
        raise AssertionError(message)
    checks += 1


def request(action, method="GET", body=None, extra_headers=None):
    data = None if body is None else json.dumps(body).encode()
    headers = {"Accept": "application/json", **(extra_headers or {})}
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(BASE + "?action=" + action, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            return response.status, response.headers, json.loads(response.read())
    except urllib.error.HTTPError as error:
        return error.code, error.headers, json.loads(error.read())


def run():
    if not shutil.which(PHP):
        raise SystemExit("PHP CLI was not found; set PHP_BINARY to the PHP executable.")
    with socket.socket() as probe:
        probe.bind((HOST, PORT))
    with tempfile.TemporaryDirectory(prefix="index-civitai-public-") as temporary:
        temp = pathlib.Path(temporary)
        database = temp / "catalog.sqlite"
        settings_path = temp / "settings.json"
        config_path = temp / "config.php"
        media = temp / "media"
        media.mkdir(mode=0o750)
        settings = {
            "public_ingest_enabled": True,
            "public_ingest_requests_per_minute": 120,
            "ingest_max_active_clients": 10000,
            "database_path": str(database), "storage_dir": str(media),
            # Intentionally no key hash or registry: public operation must be independent of both.
        }

        def save_settings():
            settings_path.write_text(json.dumps(settings), encoding="utf-8")

        def reset_quota():
            with sqlite3.connect(database) as conn:
                conn.execute("DELETE FROM ingest_request_windows")

        save_settings()
        config_path.write_text("<?php return json_decode(file_get_contents(__DIR__.'/settings.json'),true,512,JSON_THROW_ON_ERROR);\n", encoding="utf-8")
        env = {**os.environ, "CIVITAI_LIBRARY_CONFIG": str(config_path)}
        with (temp / "php.log").open("wb") as log:
            server = subprocess.Popen([PHP, "-S", f"{HOST}:{PORT}", "-t", str(ROOT / "public")], env=env, stdout=log, stderr=subprocess.STDOUT)
            try:
                for _ in range(40):
                    if server.poll() is not None:
                        raise RuntimeError("Isolated PHP server exited during startup")
                    try:
                        status, _, _ = request("health")
                        if status == 200:
                            break
                    except (OSError, ValueError):
                        pass
                    time.sleep(0.1)
                else:
                    raise RuntimeError("Isolated PHP server did not become ready")
                check(status == 200, "isolated public API is ready")
                status, _, result = request("writer-status")
                check(status == 200 and result.get("writer") and result.get("publicIndexing"), "anonymous writer status confirms public indexing")
                for authorization in ("Bearer stale-legacy-key", "Bearer icv1_invalid", "Basic invalid", "Bearer " + "x" * 2100):
                    check(request("writer-status", extra_headers={"Authorization": authorization})[0] == 200, "stale or malformed credentials do not prevent public indexing")
                status, _, result = request("check", "POST", {"imageIds": ["42", "42"]})
                check(status == 200 and result.get("checked") == 1 and result.get("missing") == 1, "anonymous storage preflight deduplicates unknown IDs")
                check(not list(media.glob(".image-locks/*.lock")), "unknown preflight IDs leave no persistent image locks")
                for invalid in ([], ["../42"], ["0"], [1.5], ["42"] * 101, {"id": "42"}):
                    check(request("check", "POST", {"imageIds": invalid})[0] == 400, "anonymous preflight rejects malformed IDs and batches")
                source = "https://image.civitai.com/isolated-public-fixture.jpg"
                outside = temp / "outside-must-not-exist.jpg"
                item = {"id": "900000099", "downloadUrl": source, "prompt": "candid photo, golden meadow selfie <lora:StudioAnime:0>", "tags": ["selfie"], "modelName": "Studio SickRealism", "file_path": str(outside), "storage_dir": str(temp), "command": "touch " + str(outside)}
                status, _, result = request("images", "POST", {"items": [item], "path": str(outside)})
                check(status == 200 and result.get("accepted") == 1 and result.get("imageCopiesQueued") == 1, "anonymous metadata queues a server image copy")
                with sqlite3.connect(database) as conn:
                    row = conn.execute("SELECT prompt,file_path,download_status,source_url FROM images WHERE image_id='900000099'").fetchone()
                check(row == (item["prompt"], None, "pending", source) and not outside.exists(), "prompt and URL persist; supplied local paths and commands cannot write files")
                status, _, result = request("search&q=selfie&tag=selfie")
                check(status == 200 and result.get("total") == 1 and result["items"][0]["prompt"] == item["prompt"], "anonymous search returns the indexed prompt and correct matching count")
                check(result["items"][0]["category"] == "realistic", "metadata style classification remains available")
                with sqlite3.connect(database) as conn:
                    signals = json.loads(conn.execute("SELECT style_signals_json FROM images WHERE image_id='900000099'").fetchone()[0])
                check(not any(s["category"] == "anime" for s in signals), "new uploads ignore disabled anime LoRAs")
                check(any(s["source"] == "model" and s["rule"] == "realism" for s in signals), "new uploads recognize compound realism model names")
                status, _, result = request("images", "POST", {"items": [{"id": item["id"], "downloadUrl": source}]})
                check(status == 200 and result.get("accepted") == 1, "an incomplete rescan preserves a known positive prompt")
                check(request("search&q=meadow")[2]["items"][0]["prompt"] == item["prompt"], "rescan preserves searchable original prompt")
                promptless = [{"id": "900000100", "downloadUrl": source}, {"id": "900000101", "downloadUrl": source, "prompt": " \n\t\u00a0", "tags": ["selfie"]}, {"id": "900000102", "downloadUrl": source, "negativePrompt": "selfie"}]
                locks_before_promptless = set(media.glob(".image-locks/*.lock"))
                status, _, result = request("images", "POST", {"items": promptless})
                check(status == 200 and result.get("accepted") == 0 and result.get("skipped") == 3 and result.get("imageCopiesQueued") == 0, "anonymous promptless images are skipped without download jobs")
                check(set(media.glob(".image-locks/*.lock")) == locks_before_promptless, "new promptless submissions leave no additional persistent image locks")
                bad_urls = ["file:///etc/passwd", "http://image.civitai.com/a.jpg", "https://127.0.0.1/a.jpg", "https://image.civitai.com.evil.invalid/a.jpg", "https://image.civitai.com@evil.invalid/a.jpg", "https://image.civitai.com:443/a.jpg"]
                invalid = [{"id": str(900000200 + i), "downloadUrl": url, "prompt": "fixture"} for i, url in enumerate(bad_urls)]
                invalid.append({"id": "../../outside", "downloadUrl": source, "prompt": "fixture"})
                status, _, result = request("images", "POST", {"items": invalid})
                check(status == 200 and result.get("accepted") == 0 and result.get("skipped") == len(invalid), "public submissions cannot use local files, foreign hosts, private addresses, ports, credentials or path IDs")
                for action in ("delete", "upload", "execute", "contributors", "revoke"):
                    check(request(action, "POST", {"path": str(outside)})[0] == 404, "public API exposes no " + action + " operation")
                with sqlite3.connect(database) as conn:
                    check(conn.execute("SELECT COUNT(*) FROM images").fetchone()[0] == 1, "invalid and promptless submissions create no catalog records")
                    entries = conn.execute("SELECT contributor_id FROM ingest_request_windows").fetchall()
                expected_id = "public:" + hashlib.sha256(b"index-civitai-ingest:" + socket.inet_pton(socket.AF_INET, HOST)).hexdigest()
                check(entries == [(expected_id,)] and HOST not in expected_id, "quota stores a canonical address hash instead of a raw address or supplied token")

                # All requests originate at the same TCP peer. Headers must not create extra quotas.
                settings["public_ingest_requests_per_minute"] = 2
                save_settings()
                if time.time() % 60 > 55:
                    time.sleep(60 - time.time() % 60 + 0.1)
                reset_quota()
                check(request("writer-status")[0] == 200, "first public request inside quota succeeds")
                check(request("check", "POST", {"imageIds": ["42"]}, {"X-Forwarded-For": "198.51.100.1"})[0] == 200, "second public request inside quota succeeds")
                for headers in ({"X-Forwarded-For": "198.51.100.2"}, {"X-Real-IP": "198.51.100.3", "CF-Connecting-IP": "198.51.100.4"}, {"Forwarded": "for=198.51.100.5", "Authorization": "Bearer another-token"}):
                    status, response_headers, _ = request("writer-status", extra_headers=headers)
                    check(status == 429 and 1 <= int(response_headers.get("Retry-After", "0")) <= 60, "spoofed headers cannot bypass quota; retry delay is bounded")
                with sqlite3.connect(database) as conn:
                    check(conn.execute("SELECT COUNT(*),MAX(request_count) FROM ingest_request_windows").fetchone() == (1, 2), "over-quota requests cannot grow state or overflow counters")
                    conn.execute("UPDATE ingest_request_windows SET window_start=?", (int(time.time() // 60) * 60 - 60,))
                check(request("writer-status")[0] == 200, "expired request window is removed and collection resumes")

                settings["ingest_max_active_clients"] = 2
                save_settings()
                reset_quota()
                window = int(time.time() // 60) * 60
                with sqlite3.connect(database) as conn:
                    conn.executemany("INSERT INTO ingest_request_windows VALUES(?,?,?)", [("fixture-client-one", window, 1), ("fixture-client-two", window, 1)])
                check(request("writer-status")[0] == 429, "new client cannot grow quota state past configured capacity")
                with sqlite3.connect(database) as conn:
                    check(conn.execute("SELECT COUNT(*) FROM ingest_request_windows").fetchone()[0] == 2, "active quota row bound remains exact")
                    conn.execute("UPDATE ingest_request_windows SET window_start=?", (window - 60,))
                check(request("writer-status")[0] == 200, "expired clients release capacity for public collection")
                with sqlite3.connect(database) as conn:
                    check(conn.execute("SELECT COUNT(*) FROM ingest_request_windows").fetchone()[0] == 1, "expired quota rows are cleaned during ingestion")
                    check(conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok", "isolated database remains valid")

                settings["public_ingest_enabled"] = False
                save_settings()
                check(request("writer-status")[0] == 401, "explicit protected mode still requires credentials")
            finally:
                server.terminate()
                try:
                    server.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.wait(timeout=5)
    print(json.dumps({"ok": True, "checks": checks, "suite": "public-ingestion", "productionTouched": False}))


if __name__ == "__main__":
    run()
