"""Keep every repo's view of its remote current.

Ahead/behind counts, unpushed work and the branches cloud routines push are
only as fresh as the last `git fetch`. That used to happen only inside the
nightly steward, so the one night it skipped (2026-10-05, after a time zone
change) left twenty repos' remote view two days old and made two healthy
cloud routines look dead. The dashboard now fetches every repo with an origin
itself: any repo whose last fetch is older than six hours, checked every
half hour, never prompting for credentials and never touching a working tree.
"""
from __future__ import annotations

import asyncio
import os
import subprocess
import threading
import time
from pathlib import Path

from fastapi import APIRouter

from . import projects as proj_mod

router = APIRouter()

MAX_AGE_S = 6 * 3600
CHECK_EVERY_S = 30 * 60
_ENV = {
    **os.environ,
    "GIT_TERMINAL_PROMPT": "0",  # a missing credential fails fast instead of waiting on a prompt
    "GIT_SSH_COMMAND": "ssh -o BatchMode=yes -o ConnectTimeout=10",
}
_results: dict[str, dict] = {}  # project -> {at, ok, error}
_lock = threading.Lock()
_running = False


_seen: dict[str, float] = {}


def last_fetch(path: Path) -> float | None:
    """When the repo last fetched, by anyone (us, the steward, you). A fetch
    in flight briefly removes FETCH_HEAD; the last value seen stands in."""
    try:
        t = (path / ".git" / "FETCH_HEAD").stat().st_mtime
    except OSError:
        return _seen.get(str(path))
    _seen[str(path)] = t
    return t


def has_origin(path: Path) -> bool:
    try:
        r = subprocess.run(["git", "config", "--get", "remote.origin.url"], cwd=str(path),
                           capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.TimeoutExpired):
        return False
    return bool(r.stdout.strip())


def _busy(path: Path) -> str | None:
    git = path / ".git"
    for name, why in (("index.lock", "a git command is running"), ("rebase-merge", "a rebase is in progress"),
                      ("rebase-apply", "a rebase is in progress"), ("MERGE_HEAD", "a merge is in progress")):
        if (git / name).exists():
            return why
    return None


def fetch_one(path: Path) -> dict:
    if not (path / ".git").is_dir():
        return {"at": time.time(), "ok": False, "error": "not a plain git checkout"}
    busy = _busy(path)
    if busy:
        return {"at": time.time(), "ok": False, "error": f"skipped: {busy}", "skipped": True}
    try:
        r = subprocess.run(
            ["git", "-c", "http.lowSpeedLimit=1000", "-c", "http.lowSpeedTime=20",
             "fetch", "--prune", "--quiet", "origin"],
            cwd=str(path), capture_output=True, text=True, timeout=90, env=_ENV)
        ok, error = r.returncode == 0, None if r.returncode == 0 else (r.stderr or "fetch failed").strip()[-300:]
    except subprocess.TimeoutExpired:
        ok, error = False, "timed out after 90 s"
    except OSError as exc:
        ok, error = False, str(exc)
    result = {"at": time.time(), "ok": ok, "error": error}
    with _lock:
        _results[path.name] = result
    if ok:
        proj_mod.mark_dirty(path / ".git" / "FETCH_HEAD")  # refs moved: ahead/behind and branches change
    return result


def repos() -> list[Path]:
    return [p for p in proj_mod._discover() if (p / ".git").is_dir() and has_origin(p)]


def fetch_due(max_age_s: float = MAX_AGE_S) -> dict:
    """Fetch every repo whose last fetch is older than max_age_s, one at a time."""
    global _running
    with _lock:
        if _running:
            return {"running": True}
        _running = True
    try:
        now = time.time()
        done = {}
        for p in repos():
            last = last_fetch(p)
            if last is None or now - last >= max_age_s:
                done[p.name] = fetch_one(p)
        return done
    finally:
        with _lock:
            _running = False


def status() -> dict:
    now = time.time()
    out = {}
    for p in repos():
        last = last_fetch(p)
        with _lock:
            res = dict(_results.get(p.name) or {})
        out[p.name] = {"last_fetch": last, "age_h": round((now - last) / 3600, 1) if last else None,
                       "last_result": res or None}
    return {"repos": out, "running": _running, "max_age_h": MAX_AGE_S / 3600}


async def loop() -> None:
    """Started from the app lifespan: a first pass a minute after start, then
    every half hour for whatever has gone stale since."""
    await asyncio.sleep(60)
    while True:
        try:
            await asyncio.to_thread(fetch_due)
        except Exception:
            pass
        await asyncio.sleep(CHECK_EVERY_S)


@router.get("/api/fetch")
def api_fetch_status():
    return status()


@router.post("/api/fetch")
def api_fetch_now():
    """Fetch every repo now, in the background (the page polls /api/fetch)."""
    if _running:
        return {"started": False, "running": True}
    threading.Thread(target=fetch_due, kwargs={"max_age_s": 0}, name="fetch-all", daemon=True).start()
    return {"started": True}
