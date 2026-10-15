#!/usr/bin/env python3
"""Repair missing metadata on a fixed snapshot of existing Civitai image links.

This worker visits public image HTML only. It uses the reaction worker's bounded
transport, robots policy, leases, locking, retries, and cooldowns. A successful
visit is terminal even when the source does not publish a creator or resource
list: an empty LoRA list can be legitimate and must not become an endless job.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import sqlite3
import subprocess
import sys
from typing import Callable


def load_sibling(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    if spec is None or spec.loader is None:
        raise RuntimeError("Required backfill module could not be loaded")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


base = load_sibling("index_civitai_reaction_backfill", "reaction-backfill.py")
FIELDS = ("creatorName", "prompt", "modelName", "loras", "tags", "reactions")
AUDIT_FIELDS = (*FIELDS, "negativePrompt", "classification")
JOB_TYPE = "metadata"
JOB_VERSION = "1"
MAX_MERGE_BYTES = 256 * 1024


def names_present(value: object) -> bool:
    try:
        values = json.loads(value) if isinstance(value, str) else value
    except (ValueError, TypeError):
        return False
    return isinstance(values, list) and any(isinstance(item, str) and item.strip() for item in values)


def wanted_fields(row: sqlite3.Row) -> list[str]:
    wanted = []
    if not str(row["creator_name"] or "").strip():
        wanted.append("creatorName")
    if row["missing_prompt"]:
        wanted.append("prompt")
    if not str(row["model_name"] or "").strip():
        wanted.append("modelName")
    if not names_present(row["loras_json"]):
        wanted.append("loras")
    if not names_present(row["tags_json"]):
        wanted.append("tags")
    if not base.complete(base.load_reactions(row["reactions_json"])):
        wanted.append("reactions")
    return wanted


def open_state(job_dir: Path) -> sqlite3.Connection:
    state = base.open_state(job_dir, job_type=JOB_TYPE)
    if base.meta(state, "metadata_version") != JOB_VERSION:
        state.close()
        raise ValueError("Unsupported metadata job schema")
    return state


def snapshot(catalog: Path, job_dir: Path, origin: str) -> dict:
    if origin not in base.ALLOWED_ORIGINS:
        raise ValueError("Only public Civitai image-page origins are allowed")
    if not catalog.is_file():
        raise ValueError("Catalog database does not exist")
    job_dir.mkdir(parents=True, exist_ok=True, mode=0o750)
    path = job_dir / "job.sqlite"
    descriptor = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o640)
    os.close(descriptor)
    with base.connect(path) as state:
        state.executescript("""
            PRAGMA journal_mode=WAL;
            CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
            CREATE TABLE items(
                image_id TEXT PRIMARY KEY,page_url TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,
                next_attempt REAL NOT NULL DEFAULT 0,lease_until REAL NOT NULL DEFAULT 0,
                last_error TEXT NOT NULL DEFAULT '',observed_json TEXT NOT NULL DEFAULT '{}',
                completed_at TEXT NOT NULL DEFAULT '',wanted_json TEXT NOT NULL,
                changed_json TEXT NOT NULL DEFAULT '[]',missing_json TEXT NOT NULL DEFAULT '[]',
                available_json TEXT NOT NULL DEFAULT '[]',matched_image INTEGER NOT NULL DEFAULT 0,
                audit_recorded INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX items_ready ON items(status,next_attempt,lease_until);
            CREATE TABLE field_counts(
                field TEXT PRIMARY KEY,wanted INTEGER NOT NULL DEFAULT 0,
                observed INTEGER NOT NULL DEFAULT 0,changed INTEGER NOT NULL DEFAULT 0,
                still_missing INTEGER NOT NULL DEFAULT 0
            );
        """)
        state.executemany("INSERT INTO field_counts(field) VALUES(?)", [(field,) for field in AUDIT_FIELDS])
        selected = 0
        excluded = 0
        field_counts = dict.fromkeys(FIELDS, 0)
        # One streaming scan avoids retaining prompts or collecting a growing
        # list in memory. The read transaction fixes this snapshot's membership.
        with base.connect(catalog, readonly=True) as source:
            source.execute("BEGIN")
            total = source.execute("SELECT COUNT(*) FROM images").fetchone()[0]
            excluded = source.execute("SELECT COUNT(*) FROM images i JOIN image_collection_skips s ON s.image_id=i.image_id").fetchone()[0]
            rows = source.execute("""
                SELECT i.image_id,i.creator_name,i.model_name,i.loras_json,i.tags_json,i.reactions_json,
                       CASE WHEN trim(COALESCE(i.prompt,''))='' THEN 1 ELSE 0 END AS missing_prompt
                FROM images i
                WHERE NOT EXISTS(SELECT 1 FROM image_collection_skips s WHERE s.image_id=i.image_id)
                ORDER BY i.rowid
            """)
            for row in rows:
                if not base.valid_image_id(row["image_id"]):
                    continue
                wanted = wanted_fields(row)
                if not wanted:
                    continue
                image_id = str(row["image_id"])
                state.execute("INSERT INTO items(image_id,page_url,wanted_json) VALUES(?,?,?)", (
                    image_id, origin + "/images/" + image_id, json.dumps(wanted, separators=(",", ":"))))
                selected += 1
                for field in wanted:
                    field_counts[field] += 1
        for field, count in field_counts.items():
            state.execute("UPDATE field_counts SET wanted=? WHERE field=?", (count, field))
        for key, value in {
            "schema_version": base.SCHEMA_VERSION, "job_type": JOB_TYPE,
            "metadata_version": JOB_VERSION, "catalog": str(catalog.resolve()),
            "origin": origin, "created_at": base.utc_now(), "snapshot_total": total,
            "snapshot_selected": selected, "snapshot_excluded": excluded,
            "cooldown_until": 0, "last_status": "snapshot created",
        }.items():
            base.set_meta(state, key, value)
        state.commit()
    return status(job_dir)


def status(job_dir: Path) -> dict:
    with open_state(job_dir) as state:
        counts = {row["status"]: row["count"] for row in state.execute("SELECT status,COUNT(*) AS count FROM items GROUP BY status")}
        fields = {row["field"]: {"wanted": row["wanted"], "observed": row["observed"],
                  "changed": row["changed"], "stillMissing": row["still_missing"]}
                  for row in state.execute("SELECT * FROM field_counts ORDER BY field")}
        remaining = sum(counts.get(key, 0) for key in ("pending", "retry", "leased"))
        return {
            "job": str(job_dir), "type": JOB_TYPE, "createdAt": base.meta(state, "created_at"),
            "snapshotTotal": int(base.meta(state, "snapshot_total", "0")),
            "snapshotSelected": int(base.meta(state, "snapshot_selected", "0")),
            "snapshotExcluded": int(base.meta(state, "snapshot_excluded", "0")),
            "counts": counts, "fields": fields,
            "attempts": state.execute("SELECT COALESCE(SUM(attempts),0) FROM items").fetchone()[0],
            "cooldownUntil": float(base.meta(state, "cooldown_until", "0")),
            "lastStatus": base.meta(state, "last_status"), "remaining": remaining,
            "changedImages": int(base.meta(state, "changed_images", "0")),
            "sourceMatched": int(base.meta(state, "source_matched", "0")),
        }


def field_names(value: object) -> list[str]:
    return [name for name in AUDIT_FIELDS if isinstance(value, list) and name in value]


def record_result(state: sqlite3.Connection, item: dict, observed: dict,
                  outcome: str, merge_result: object) -> None:
    if not isinstance(merge_result, dict) or outcome not in ("done", "partial", "unavailable", "removed", "skipped"):
        return
    if item.get("audit_recorded"):
        return
    changed = field_names(merge_result.get("changedFields"))
    missing = field_names(merge_result.get("missingFields"))
    available = field_names(observed.get("availableFields"))
    matched = observed.get("matchedImage") is True
    state.execute("""UPDATE items SET changed_json=?,missing_json=?,available_json=?,
                     matched_image=?,audit_recorded=1 WHERE image_id=?""", (
        json.dumps(changed, separators=(",", ":")), json.dumps(missing, separators=(",", ":")),
        json.dumps(available, separators=(",", ":")), int(matched), item["image_id"]))
    for field in AUDIT_FIELDS:
        state.execute("UPDATE field_counts SET observed=observed+?,changed=changed+?,still_missing=still_missing+? WHERE field=?", (
            int(field in available), int(field in changed), int(field in missing), field))
    if changed:
        base.set_meta(state, "changed_images", int(base.meta(state, "changed_images", "0")) + 1)
    if matched:
        base.set_meta(state, "source_matched", int(base.meta(state, "source_matched", "0")) + 1)


def php_merger(php_binary: str, helper: Path) -> Callable:
    if not helper.is_file():
        raise ValueError("Metadata repair helper is missing")

    def merge(catalog: Path, image_id: str, observed: dict) -> dict:
        if not isinstance(observed, dict):
            raise base.FetchFailure("Metadata parser returned an invalid record", retryable=False)
        payload = json.dumps({**observed, "id": image_id}, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if len(payload) > MAX_MERGE_BYTES:
            raise base.FetchFailure("Observed metadata exceeds repair size limit", retryable=False)
        try:
            completed = subprocess.run([php_binary, str(helper), "--catalog", str(catalog.resolve())],
                input=payload, capture_output=True, timeout=40, check=False)
        except OSError:
            raise RuntimeError("Metadata repair helper could not be started; snapshot remains resumable") from None
        except subprocess.TimeoutExpired:
            raise base.FetchFailure("Metadata repair helper timed out") from None
        if len(completed.stdout) > MAX_MERGE_BYTES:
            raise base.FetchFailure("Metadata repair helper response exceeds limit", retryable=False)
        try:
            result = json.loads(completed.stdout)
        except (ValueError, UnicodeError):
            raise RuntimeError("Metadata repair helper returned invalid JSON; snapshot remains resumable") from None
        if completed.returncode != 0 or not isinstance(result, dict) or result.get("ok") is not True:
            # Do not copy PHP diagnostics, paths, or source content into logs.
            code = result.get("code") if isinstance(result, dict) else None
            if code not in ("catalog_busy", "invalid_record"):
                raise RuntimeError("Metadata repair configuration or catalog error; snapshot remains resumable")
            retryable = isinstance(result, dict) and result.get("retryable") is True
            raise base.FetchFailure("Metadata repair helper could not apply this record", retryable=retryable)
        return result

    return merge


def preflight(php_binary: str, helper: Path, catalog: Path) -> None:
    try:
        completed = subprocess.run([php_binary, str(helper), "--catalog", str(catalog.resolve()), "--check"],
            capture_output=True, timeout=30, check=False)
        result = json.loads(completed.stdout)
    except (OSError, subprocess.TimeoutExpired, ValueError, UnicodeError):
        raise RuntimeError("Metadata repair preflight could not complete; no image pages were requested") from None
    if completed.returncode != 0 or not isinstance(result, dict) or result.get("ok") is not True or result.get("outcome") != "ready":
        raise RuntimeError("Metadata repair preflight failed; check PHP, catalog, and CIVITAI_LIBRARY_CONFIG")


def page_parser(parse_metadata: Callable) -> Callable:
    def parse(html: str, image_id: str) -> dict:
        observed = parse_metadata(html, image_id)
        if observed.get("matchedImage") is not True:
            challenge_title = re.search(r"<title[^>]*>\s*(?:just a moment|attention required|checking your browser)", html, re.I)
            challenge_script = "window._cf_chl_opt" in html or "window.__cf_chl_opt" in html
            if challenge_title or challenge_script:
                raise base.FetchFailure("Source returned a browser challenge", status=403,
                    retry_after=900, retryable=True, global_pause=True)
        return observed
    return parse


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("snapshot", "run", "status"))
    parser.add_argument("--job-dir", type=Path, required=True)
    parser.add_argument("--catalog", type=Path, default=Path("/data/civitai/database/catalog.sqlite"))
    parser.add_argument("--origin", choices=base.ALLOWED_ORIGINS, default=base.ALLOWED_ORIGINS[0])
    parser.add_argument("--concurrency", type=int, default=8)
    parser.add_argument("--wave-wait", type=float, default=3)
    parser.add_argument("--timeout", type=float, default=25)
    parser.add_argument("--max-attempts", type=int, default=4)
    parser.add_argument("--transport", choices=("urllib", "curl"), default="curl")
    parser.add_argument("--php", default="/www/server/php/84/bin/php")
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    os.umask(0o027)
    signal.signal(signal.SIGTERM, lambda *_: base.STOP.set())
    signal.signal(signal.SIGINT, lambda *_: base.STOP.set())
    try:
        if args.command == "snapshot":
            result = snapshot(args.catalog, args.job_dir, args.origin)
        elif args.command == "status":
            result = status(args.job_dir)
        else:
            with open_state(args.job_dir) as state:
                catalog = Path(base.meta(state, "catalog"))
            helper = Path(__file__).with_name("metadata-repair.php")
            preflight(args.php, helper, catalog)
            metadata = load_sibling("index_civitai_metadata_page", "metadata-page.py")
            options = {"fetcher": base.fetch_page_curl, "robots_fetcher": base.fetch_robots_curl,
                       "user_agent": base.curl_user_agent()} if args.transport == "curl" else {}
            result = base.run(args.job_dir, concurrency=args.concurrency, wave_wait=args.wave_wait,
                timeout=args.timeout, max_attempts=args.max_attempts, once=args.once,
                parser=page_parser(metadata.parse_metadata), merger=php_merger(args.php, helper),
                status_reader=status, result_recorder=record_result, job_type=JOB_TYPE,
                unavailable_message="Requested metadata was not exposed in public image HTML", **options)
        print(json.dumps(result, separators=(",", ":")))
        return 0
    except (OSError, ValueError, RuntimeError, sqlite3.Error, subprocess.SubprocessError) as error:
        print(json.dumps({"ok": False, "error": str(error)[:300]}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
