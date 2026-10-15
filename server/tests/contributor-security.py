#!/usr/bin/env python3
"""Isolated Index Civitai contributor auth tests; no remote requests or production data.

Run as root on the Linux PHP host: python3 tests/contributor-security.py
PHP_BINARY may select a PHP CLI with PDO SQLite. All writable paths are under a
fresh temporary directory, and the localhost PHP process is stopped on exit.
"""
import hashlib
import json
import os
import pathlib
import re
import shutil
import socket
import sqlite3
import stat
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
PHP = os.environ.get("PHP_BINARY", "php")
HOST, PORT = "127.0.0.1", 18258
BASE = f"http://{HOST}:{PORT}/api.php"
OWNER_TOKEN = "isolated-owner-fixture-never-a-production-secret"
checks = 0


def check(value, message):
    global checks
    if not value:
        raise AssertionError(message)
    checks += 1


def request(action, method="GET", body=None, token=None, authorization=None):
    data = None if body is None else json.dumps(body).encode()
    headers = {"Accept": "application/json"}
    if data is not None:
        headers["Content-Type"] = "application/json"
    if token is not None:
        headers["Authorization"] = "Bearer " + token
    if authorization is not None:
        headers["Authorization"] = authorization
    req = urllib.request.Request(BASE + "?action=" + action, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            return response.status, response.headers, json.loads(response.read())
    except urllib.error.HTTPError as error:
        return error.code, error.headers, json.loads(error.read())


def run():
    if hasattr(os, "geteuid") and os.geteuid() != 0:
        raise SystemExit("Run this isolated suite as root; contributor CLI management deliberately requires administrator access.")
    if not shutil.which(PHP):
        raise SystemExit("PHP CLI was not found; set PHP_BINARY to the PHP executable.")
    # Refuse to accidentally test an existing process listening on the fixture port.
    with socket.socket() as probe:
        probe.bind((HOST, PORT))
    with tempfile.TemporaryDirectory(prefix="index-civitai-auth-") as temporary:
        temp = pathlib.Path(temporary)
        registry_path = temp / "contributors.json"
        database_path = temp / "catalog.sqlite"
        settings_path = temp / "settings.json"
        config_path = temp / "config.php"
        media_path = temp / "media"
        media_path.mkdir(mode=0o750)
        owner_hash = subprocess.check_output(
            [PHP, "-r", "echo password_hash(getenv('INDEX_CIVITAI_TEST_TOKEN'),PASSWORD_DEFAULT);"],
            env={**os.environ, "INDEX_CIVITAI_TEST_TOKEN": OWNER_TOKEN}, text=True,
        )
        settings = {
            "public_ingest_enabled": False,
            "database_path": str(database_path), "storage_dir": str(media_path),
            "contributors_path": str(registry_path), "write_token_hash": owner_hash,
            "contributor_requests_per_minute": 120,
        }
        settings_path.write_text(json.dumps(settings), encoding="utf-8")
        config_path.write_text("<?php return json_decode(file_get_contents(__DIR__.'/settings.json'),true,512,JSON_THROW_ON_ERROR);\n", encoding="utf-8")
        env = {**os.environ, "CIVITAI_LIBRARY_CONFIG": str(config_path)}

        def cli(*args, success=True):
            result = subprocess.run([PHP, str(ROOT / "contributors.php"), *args], env=env, capture_output=True, text=True, timeout=10)
            if success:
                check(result.returncode == 0, "contributor CLI action succeeds: " + str(args[0]))
                return json.loads(result.stdout)
            check(result.returncode != 0 and not result.stdout.strip(), "invalid CLI action fails without emitting a credential")
            return result

        def save_registry(data):
            registry_path.write_text(json.dumps(data), encoding="utf-8")

        first = cli("create", "Alice fixture")
        second = cli("create", "Bob fixture")
        check(re.fullmatch(r"icv1_[a-f0-9]{16}_[A-Za-z0-9_-]{43}", first["token"]) is not None, "new credential has a random ID and 256-bit secret")
        check(first["scope"] == "catalog:submit" and first["id"] != second["id"] and first["token"] != second["token"], "independent contributors receive unique narrowly scoped credentials")
        registry = json.loads(registry_path.read_text())
        check(registry["keys"][first["id"]]["sha256"] == hashlib.sha256(first["token"].encode()).hexdigest(), "credential is stored as its SHA-256 digest")
        check(first["token"] not in registry_path.read_text() and second["token"] not in registry_path.read_text(), "registry does not contain raw credentials")
        check(stat.S_IMODE(registry_path.stat().st_mode) == 0o640 and stat.S_IMODE(pathlib.Path(str(registry_path) + ".lock").stat().st_mode) == 0o600, "registry and management lock have restricted modes")
        check(registry_path.stat().st_uid == 0, "contributor registry remains administrator-owned")
        listed = cli("list")
        check(len(listed) == 2 and {entry["label"] for entry in listed} == {"Alice fixture", "Bob fixture"}, "list returns the created contributor identities")
        check(all("token" not in entry and "sha256" not in entry for entry in listed), "list discloses neither raw credentials nor digests")
        before_invalid = registry_path.read_bytes()
        cli("create", "", success=False)
        cli("revoke", "../../etc/passwd", success=False)
        cli("execute", "id", success=False)
        check(registry_path.read_bytes() == before_invalid, "invalid management requests cannot mutate the registry")

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
                check(status == 200, "isolated API is ready")
                for action, method, body in (("writer-status", "GET", None), ("check", "POST", {"imageIds": ["42"]}), ("images", "POST", {"items": []})):
                    check(request(action, method, body)[0] == 401, action + " rejects missing authorization")
                invalid_tokens = ("wrong-token", "icv1_bad", "icv1_ffffffffffffffff_" + "A" * 43, first["token"][:-1] + ("A" if first["token"][-1] != "A" else "B"))
                for token in invalid_tokens:
                    check(request("writer-status", token=token)[0] == 401, "invalid, unknown or altered credential is rejected")
                for header in ("Basic " + first["token"], "Bearer " + first["token"] + " extra", "Bearer " + "a" * 2100):
                    check(request("writer-status", authorization=header)[0] == 401, "malformed authorization is rejected")
                status, _, result = request("writer-status", token=first["token"])
                check(status == 200 and result.get("writer") is True, "new contributor authenticates")
                check(request("writer-status", token=OWNER_TOKEN)[0] == 200, "existing owner credential stays compatible")

                registry["keys"][first["id"]]["scope"] = "catalog:read"
                save_registry(registry)
                check(request("writer-status", token=first["token"])[0] == 403, "a valid secret with a different scope cannot submit")
                registry["keys"][first["id"]]["scope"] = "catalog:submit"
                save_registry(registry)
                check(request("check", "POST", {"imageIds": ["../outside"]}, first["token"])[0] == 400, "storage preflight rejects path traversal IDs")
                evil_urls = ["file:///etc/passwd", "http://image.civitai.com/a.jpg", "https://127.0.0.1/a.jpg", "https://image.civitai.com.evil.invalid/a.jpg", "https://image.civitai.com@evil.invalid/a.jpg", "https://image.civitai.com:443/a.jpg"]
                records = [{"id": str(900000000 + i), "downloadUrl": url, "prompt": "fixture prompt"} for i, url in enumerate(evil_urls)]
                status, _, result = request("images", "POST", {"items": records}, first["token"])
                check(status == 200 and result.get("accepted") == 0 and result.get("skipped") == len(records), "contributor cannot queue local files, private addresses, foreign hosts, credentials, ports or HTTP sources")
                outside = temp / "must-not-exist.jpg"
                allowed = {"id": "900000099", "downloadUrl": "https://image.civitai.com/fixture.jpg", "prompt": "fixture prompt", "file_path": str(outside), "storage_dir": str(temp), "command": "touch " + str(outside)}
                status, _, result = request("images", "POST", {"items": [allowed], "path": str(outside), "command": "touch " + str(outside)}, first["token"])
                check(status == 200 and result.get("accepted") == 1 and result.get("imageCopiesQueued") == 1, "contributor may submit allowed metadata for server processing")
                with sqlite3.connect(database_path) as conn:
                    row = conn.execute("SELECT file_path,download_status FROM images WHERE image_id='900000099'").fetchone()
                check(row and not row[0] and row[1] == "pending" and not outside.exists(), "client paths and commands are ignored; metadata submission never writes image bytes")
                for action in ("delete", "upload", "execute", "contributors", "revoke"):
                    check(request(action, "POST", {"path": str(outside)}, first["token"])[0] == 404, "contributor API exposes no " + action + " operation")

                # The rate limit must isolate contributors and return a bounded retry delay.
                settings["contributor_requests_per_minute"] = 2
                settings_path.write_text(json.dumps(settings), encoding="utf-8")
                if time.time() % 60 > 57:
                    time.sleep(3)
                with sqlite3.connect(database_path) as conn:
                    conn.execute("DELETE FROM ingest_request_windows")
                check(request("writer-status", token=first["token"])[0] == 200, "first request within contributor quota succeeds")
                check(request("check", "POST", {"imageIds": ["42"]}, first["token"])[0] == 200, "second request within contributor quota succeeds")
                status, headers, _ = request("writer-status", token=first["token"])
                check(status == 429 and 1 <= int(headers.get("Retry-After", "0")) <= 60, "over-quota contributor receives HTTP 429 and Retry-After")
                check(request("writer-status", token=second["token"])[0] == 200, "one contributor cannot consume another contributor's quota")
                check(request("writer-status", token=OWNER_TOKEN)[0] == 200, "owner has a separate request quota")
                with sqlite3.connect(database_path) as conn:
                    conn.execute("UPDATE ingest_request_windows SET window_start=? WHERE contributor_id=?", (int(time.time() // 60) * 60 - 60, first["id"]))
                check(request("writer-status", token=first["token"])[0] == 200, "expired contributor request window resets normally")
                settings["contributor_requests_per_minute"] = 120
                settings_path.write_text(json.dumps(settings), encoding="utf-8")

                revoked = cli("revoke", first["id"])
                check(revoked.get("revoked") is True and request("writer-status", token=first["token"])[0] == 401, "revocation blocks the credential on the very next request")
                check(request("writer-status", token=second["token"])[0] == 200, "revoking one contributor keeps another working")
                check(next(entry for entry in cli("list") if entry["id"] == first["id"])["revoked"] is True, "management list reports revoked status")

                healthy_registry = registry_path.read_bytes()
                for malformed in ("not JSON", '{"version":2,"keys":{}}', '{"version":1,"keys":null}', '{"version":1,"keys":{', "x" * 1048577):
                    registry_path.write_text(malformed, encoding="utf-8")
                    status, _, result = request("writer-status", token=second["token"])
                    check(status == 500 and result.get("ok") is False and "token" not in result, "malformed or oversized registry fails closed without exposing credentials")
                    cli("list", success=False)
                registry_path.write_bytes(healthy_registry)
                check(request("writer-status", token=second["token"])[0] == 200, "restoring valid registry restores valid contributor access")
                with sqlite3.connect(database_path) as conn:
                    check(conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok", "isolated catalog integrity remains valid")
            finally:
                server.terminate()
                try:
                    server.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.wait(timeout=5)
    print(json.dumps({"ok": True, "checks": checks, "suite": "contributor-security", "productionTouched": False}))


if __name__ == "__main__":
    run()
