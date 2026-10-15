#!/usr/bin/env python3
"""Finish the existing preview snapshot in bounded, resumable PHP batches."""
import json
import os
from pathlib import Path
import subprocess
import time

php = os.environ.get('CIVITAI_PHP_BINARY', '/www/server/php/84/bin/php')
script = Path(__file__).with_name('preview_backfill.php')
for _ in range(2000):
    result = subprocess.run(
        [php, '-d', 'memory_limit=128M', str(script), '--limit=200',
         '--pause-ms=100', '--max-seconds=40'],
        text=True, capture_output=True, timeout=75,
    )
    if result.stderr:
        print(result.stderr, end='', flush=True)
    print(result.stdout, end='', flush=True)
    if result.returncode:
        raise SystemExit(result.returncode)
    try:
        progress = json.loads(result.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        raise SystemExit('Preview runner stopped: no valid batch progress.')
    if progress.get('completed'):
        raise SystemExit(0)
    if not progress.get('processed'):
        raise SystemExit('Preview runner stopped: batch made no progress.')
    time.sleep(2)
raise SystemExit('Preview runner batch limit reached; cursor retained.')
