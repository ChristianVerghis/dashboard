"""Live update streams using SSE.

Two streams:
  /api/stream/projects  — emits when any tracked file changes (debounced 500ms)
  /api/stream/log       — tails ./logs/feed.log so you can `echo "msg" >> logs/feed.log`
                          and see it appear in the UI in real time.
"""
from __future__ import annotations

import asyncio
import json
import os
import threading
import time
from collections import deque
from pathlib import Path
from typing import AsyncIterator

from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer

from . import ignore
from . import projects as proj_mod
from . import activity as act_mod

REPO_ROOT = Path(__file__).resolve().parent.parent
LOG_PATH = REPO_ROOT / "logs" / "feed.log"
LOG_PATH.parent.mkdir(exist_ok=True)
LOG_PATH.touch(exist_ok=True)


class _ChangeBus:
    """Fan-out bus: every SSE client gets its own queue, so a file change
    reaches all open tabs (a single shared queue handed each event to only
    one subscriber)."""
    def __init__(self) -> None:
        self._subs: set[asyncio.Queue[dict]] = set()
        self._loop: asyncio.AbstractEventLoop | None = None

    def attach_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    def subscribe(self) -> "asyncio.Queue[dict]":
        q: asyncio.Queue[dict] = asyncio.Queue()
        self._subs.add(q)
        return q

    def unsubscribe(self, q: "asyncio.Queue[dict]") -> None:
        self._subs.discard(q)

    def _fanout(self, item: dict) -> None:
        for q in list(self._subs):
            q.put_nowait(item)

    def post(self, item: dict) -> None:
        if self._loop:
            self._loop.call_soon_threadsafe(self._fanout, item)

    async def stream(self) -> AsyncIterator[dict]:
        q = self.subscribe()
        try:
            while True:
                yield await q.get()
        finally:
            self.unsubscribe(q)


bus = _ChangeBus()


# ---------------------------------------------------------------------------
# Snapshot cache. A full project rescan takes seconds on this machine, and the
# UI paints nothing until the first snapshot arrives. So: remember the last
# payload we sent, hand it to new clients immediately (flagged stale), and build
# the fresh one in a worker thread so the event loop stays responsive.
# ---------------------------------------------------------------------------
_last_payload: dict | None = None
_built_at = 0.0
_dirty_at = time.time()
_build_lock: asyncio.Lock | None = None


def _build_payload() -> dict:
    return {
        "projects": [proj_mod.project_to_dict(p) for p in proj_mod.list_projects()],
        "activity": act_mod.recent_activity(),
    }


async def fresh_payload() -> dict:
    """Current projects + activity, rebuilt at most once per invalidation."""
    global _last_payload, _built_at, _build_lock
    if _build_lock is None:
        _build_lock = asyncio.Lock()
    async with _build_lock:
        if _last_payload is not None and _built_at >= _dirty_at:
            return _last_payload
        started = time.time()
        payload = await asyncio.to_thread(_build_payload)
        _last_payload = payload
        _built_at = started  # a change during the build leaves us dirty, as it should
        return payload


class _Debouncer:
    """Collect items and flush them once no new item has arrived for `quiet`
    seconds, or `max_wait` seconds after the first one during a storm."""

    def __init__(self, quiet: float, max_wait: float, flush) -> None:
        self.quiet, self.max_wait, self._flush = quiet, max_wait, flush
        self._pending: set[str] = set()
        self._first: float | None = None
        self._timer: threading.Timer | None = None
        self._lock = threading.Lock()

    def add(self, item: str) -> None:
        now = time.time()
        with self._lock:
            self._pending.add(item)
            if self._first is None:
                self._first = now
            if self._timer is not None:
                self._timer.cancel()
            delay = min(self.quiet, max(0.0, self._first + self.max_wait - now))
            self._timer = threading.Timer(delay, self._fire)
            self._timer.daemon = True
            self._timer.start()

    def _fire(self) -> None:
        with self._lock:
            items = sorted(self._pending)
            self._pending.clear()
            self._first = None
            self._timer = None
        if items:
            self._flush(items)


def _mark_projects_dirty(paths: list[str]) -> None:
    for path in paths:
        proj_mod.mark_dirty(path)


def _post_rescanned(keys: list[str]) -> None:
    """A background rescan changed the cached scan: the next payload is
    different, so tell every open tab."""
    global _dirty_at
    _dirty_at = time.time()
    bus.post({"type": "filechange", "ts": time.time(),
              "sample": [Path(k).name for k in keys][:5]})


# Rescans land one project at a time; group them into one push per moment.
_rescans = _Debouncer(0.4, 2.0, _post_rescanned)
proj_mod.add_listener(_rescans.add)


class _Handler(FileSystemEventHandler):
    """File events only mark projects dirty (debounced per quiet window); the
    scanner rescans them on its own pool and its listener pushes the result.
    Which paths count is decided by app/ignore.py, the same policy the
    scanner's file stats use."""

    def __init__(self, root: str) -> None:
        self._root = root
        self._events = _Debouncer(1.5, 5.0, _mark_projects_dirty)

    def _record(self, path: str) -> None:
        if ignore.watcher_should_ignore(path, self._root) or "/.#" in path:
            return
        key = proj_mod.project_key_for(path)
        if key:
            self._events.add(key)

    def on_modified(self, event):
        if not event.is_directory:
            self._record(event.src_path)

    def on_created(self, event):
        if not event.is_directory:
            self._record(event.src_path)

    def on_deleted(self, event):
        if not event.is_directory:
            self._record(event.src_path)


_observer: Observer | None = None


def start_observer() -> None:
    global _observer
    if _observer is not None:
        return
    _observer = Observer()
    root = proj_mod.PROJECTS_ROOT
    handler = _Handler(str(root.resolve()) if root.exists() else str(root))
    if root.exists():
        _observer.schedule(handler, str(root), recursive=True)
    _observer.start()


def stop_observer() -> None:
    global _observer
    if _observer:
        _observer.stop()
        _observer.join(timeout=2)
        _observer = None


async def project_change_stream() -> AsyncIterator[str]:
    """SSE-formatted stream.

    Order of events for a new client:
      1. the last payload we have, immediately, flagged ``stale`` (if any) — so
         the page paints in milliseconds instead of waiting on a rescan;
      2. a fresh ``snapshot`` once the (threaded) rescan completes;
      3. ``delta`` events as files change.
    """
    if _last_payload is not None:
        yield _sse({"type": "snapshot", "stale": True, "built_at": _built_at, **_last_payload})
    fresh = await fresh_payload()
    yield _sse({"type": "snapshot", "built_at": _built_at, **fresh})
    async for item in bus.stream():
        if item.get("type") == "filechange":
            payload = await fresh_payload()
            yield _sse({"type": "delta", "ts": item["ts"], "sample": item["sample"], **payload})


async def log_tail_stream() -> AsyncIterator[str]:
    """Tail logs/feed.log line-by-line. Survive truncation/rotation."""
    LOG_PATH.touch(exist_ok=True)
    pos = LOG_PATH.stat().st_size
    yield _sse({"type": "hello", "path": str(LOG_PATH)})
    while True:
        await asyncio.sleep(0.5)
        try:
            size = LOG_PATH.stat().st_size
        except OSError:
            await asyncio.sleep(1.0)
            continue
        if size < pos:  # rotated/truncated
            pos = 0
        if size > pos:
            with open(LOG_PATH, "r", encoding="utf-8", errors="ignore") as f:
                f.seek(pos)
                chunk = f.read()
                pos = f.tell()
            for line in chunk.splitlines():
                if line.strip():
                    yield _sse({"type": "line", "text": line})


def _sse(obj: dict) -> str:
    return f"data: {json.dumps(obj)}\n\n"
