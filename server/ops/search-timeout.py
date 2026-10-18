#!/usr/bin/env python3
"""Limit root SSH diagnostic searches, without applying limits to service jobs."""
import json
import os
from pathlib import Path
import select
import signal
import sys
import time

PROC = Path('/proc')
TICKS = os.sysconf('SC_CLK_TCK')

def process(pid):
    try:
        p = PROC / str(pid)
        tail = (p / 'stat').read_text().rsplit(')', 1)[1].split()
        return {'pid': int(pid), 'parent': int(tail[1]), 'start': int(tail[19]),
                'name': (p / 'comm').read_text().strip(), 'uid': p.stat().st_uid}
    except (OSError, ValueError, IndexError):
        return None

def from_ssh(row):
    seen = set()
    for _ in range(64):
        if not row or row['pid'] in seen or row['pid'] <= 1: return False
        if row['name'] in ('sshd', 'sshd-session'): return True
        seen.add(row['pid']); row = process(row['parent'])
    return False

def search_arguments(executable, args):
    if executable == '/usr/bin/rg': return True
    if executable != '/usr/bin/grep': return False
    # Exclude continuous pipe/log filters; only recursive file searches qualify.
    for arg in args[1:]:
        if arg == '--': break
        if arg in ('--recursive', '--dereference-recursive'): return True
        if arg.startswith('-') and not arg.startswith('--') and any(c in arg[1:] for c in 'rR'): return True
    return False

def candidates():
    uptime = float((PROC / 'uptime').read_text().split()[0])
    for p in PROC.iterdir():
        if not p.name.isdecimal(): continue
        try:
            if (p / 'comm').read_text().strip() not in ('grep', 'rg'): continue
        except OSError: continue
        row = process(p.name)
        if not row or row['uid'] != 0 or row['name'] not in ('grep', 'rg'): continue
        try:
            executable = os.path.realpath(p / 'exe')
            args = (p / 'cmdline').read_bytes().decode('utf-8', 'replace').rstrip('\0').split('\0')
        except OSError: continue
        if search_arguments(executable, args) and from_ssh(row):
            yield {**row, 'age': uptime - row['start'] / TICKS}

def log(**values): print(json.dumps(values), flush=True)

def run():
    pending = {}
    try:
        while True:
            now = time.monotonic()
            for pid, (fd, deadline) in list(pending.items()):
                if select.select([fd], [], [], 0)[0]:
                    os.close(fd); del pending[pid]
                elif now >= deadline:
                    try: signal.pidfd_send_signal(fd, signal.SIGKILL)
                    except ProcessLookupError: pass
                    log(pid=pid, action='kill', reason='60-second search deadline')
                    os.close(fd); del pending[pid]
            for row in candidates():
                if row['age'] < 59 or row['pid'] in pending: continue
                fd = None
                try:
                    fd = os.pidfd_open(row['pid'])
                    current = process(row['pid'])
                    if not current or current['start'] != row['start']:
                        os.close(fd); continue
                    signal.pidfd_send_signal(fd, signal.SIGTERM)
                    pending[row['pid']] = (fd, time.monotonic() + .5)
                    log(pid=row['pid'], action='terminate', age=round(row['age'], 2), reason='60-second search deadline')
                except ProcessLookupError:
                    if fd is not None: os.close(fd)
            time.sleep(.25)
    finally:
        for fd, _ in pending.values(): os.close(fd)

if __name__ == '__main__':
    if '--dry-run' in sys.argv:
        print(json.dumps([{'pid':r['pid'],'age':round(r['age'],2)} for r in candidates()]))
    else: run()
