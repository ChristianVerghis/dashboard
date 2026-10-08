"""Scan the projects root (default ~/dev, override with DEV_ROOT) and return rich metadata per project.

Each project is auto-discovered: any direct subdirectory of PROJECTS_ROOT
that contains either a `.git` folder or a `README.md` is treated as a
project.
"""
from __future__ import annotations

import os
import re
import stat
import subprocess
import sys
import threading
import time as _time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable

from . import ignore

PROJECTS_ROOT = Path(os.environ.get("DEV_ROOT", "~/dev")).expanduser()
SELF_NAME = None  # set to "dashboard" to hide self; None to show all


@dataclass
class Commit:
    sha: str
    short_sha: str
    author: str
    date_iso: str
    age_seconds: int
    subject: str


@dataclass
class FileStat:
    path: str
    size_bytes: int
    modified_iso: str
    age_seconds: int


@dataclass
class Project:
    name: str
    path: str
    has_git: bool
    remote_url: str | None
    branch: str | None
    commit_count: int
    last_commit: Commit | None
    recent_commits: list[Commit] = field(default_factory=list)
    file_count: int = 0
    total_size_bytes: int = 0
    last_modified_file: FileStat | None = None
    summary: str = ""
    momentum: str = "stale"  # active | recent | stale
    todos: list[str] = field(default_factory=list)
    languages: dict[str, int] = field(default_factory=dict)
    insights: list[dict] = field(default_factory=list)
    commits_by_day: list[int] = field(default_factory=list)
    framework: str | None = None
    git_state: dict = field(default_factory=dict)
    manifest: dict | None = None
    service_up: bool | None = None  # only set when manifest declares a port
    signals: dict | None = None  # probe results + verdict (app/probes.py)
    scanned_at: float = 0.0  # epoch seconds; ages above are as of this moment


# ---------------------------------------------------------------------------
# Cache: stale-while-revalidate, single-flight.
#
# Once a project has been scanned, nobody waits on it again: callers get the
# last result, and a project that changed or expired is rescanned on a small
# background pool. The file watcher only marks projects dirty. A churning
# project is rescanned at most every _MIN_RESCAN_GAP seconds, two projects at
# a time, so a chatty log writer can no longer turn into a 300 % CPU rescan
# loop that blocks every request. When a background rescan lands, listeners
# (the SSE stream) hear about it and push the new payload.
# ---------------------------------------------------------------------------
_CACHE_TTL = 300.0       # the watcher sees edits and git ref moves; this only bounds the rest
_SERVICE_TTL = 20.0      # TCP re-check for manifest-declared ports
_MIN_RESCAN_GAP = 5.0
_DISCOVER_TTL = 10.0


@dataclass
class _Entry:
    project: Project
    scanned_at: float        # when the scan that produced `project` started
    finished_at: float       # last attempt, successful or not: the rescan gap counts from here
    dirty_at: float = 0.0    # dirty while dirty_at > scanned_at
    failures: int = 0        # consecutive failed rescans; each doubles the gap


_lock = threading.Lock()
_entries: dict[str, _Entry] = {}
_inflight: dict[str, threading.Event] = {}
_timers: dict[str, threading.Timer] = {}
_service_checked: dict[str, float] = {}
_pending_dirty: dict[str, float] = {}  # changes seen while a project's first scan runs
_pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="scan")
_listeners: list[Callable[[str], None]] = []
_discovered: tuple[float, list[Path]] | None = None


def add_listener(fn: Callable[[str], None]) -> None:
    """fn(project_key) runs (on a worker thread) whenever a project's cached
    scan changes."""
    _listeners.append(fn)


def _notify(key: str) -> None:
    for fn in list(_listeners):
        try:
            fn(key)
        except Exception:
            pass


def project_key_for(path: str | Path) -> str | None:
    """Map any path under PROJECTS_ROOT to its top-level project key, or None
    if it is outside."""
    try:
        rel = Path(path).resolve().relative_to(PROJECTS_ROOT.resolve())
    except (ValueError, OSError):
        return None
    if not rel.parts:
        return None
    return str(PROJECTS_ROOT / rel.parts[0])


def mark_dirty(path: str | Path | None = None) -> None:
    """Something under `path`'s project changed; with no path, anything may
    have (a service was started, an explicit refresh). Never blocks: the
    rescan runs on the background pool."""
    global _discovered
    now = _time.time()
    with _lock:
        if path is None:
            keys = list(_entries)
        else:
            key = project_key_for(path)
            if key is None:
                return
            keys = [key]
        for key in keys:
            entry = _entries.get(key)
            if entry is not None:
                entry.dirty_at = now
            elif key in _inflight:
                _pending_dirty[key] = now  # its first scan may already have read the old state
            elif _is_project_dir(Path(key)):
                _discovered = None  # a new project folder: let the next list see it
            else:
                continue
            _schedule_locked(key)


# the watcher and the service-start route still call it by its old name
invalidate_caches = mark_dirty


def _schedule_locked(key: str) -> None:
    """Queue a background rescan unless one is already running or queued.
    Caller holds _lock."""
    if key in _inflight or key in _timers:
        return
    entry = _entries.get(key)
    wait = 0.0
    if entry is not None:
        gap = min(_MIN_RESCAN_GAP * (2 ** entry.failures), _CACHE_TTL)
        wait = gap - (_time.time() - entry.finished_at)
    if wait > 0:
        timer = threading.Timer(wait, _timer_fired, args=(key,))
        timer.daemon = True
        _timers[key] = timer
        timer.start()
        return
    done = threading.Event()
    _inflight[key] = done
    _pool.submit(_background_scan, key, done)


def _timer_fired(key: str) -> None:
    with _lock:
        _timers.pop(key, None)
        _schedule_locked(key)


def _background_scan(key: str, done: threading.Event) -> None:
    ok = False
    try:
        _scan_into_cache(key)
        ok = True
    except Exception as exc:  # keep serving the last good scan, and back off
        print(f"[projects] rescan of {key} failed: {exc!r}", file=sys.stderr)
        with _lock:
            entry = _entries.get(key)
            if entry is not None:
                entry.finished_at = _time.time()
                entry.failures += 1
                entry.scanned_at = max(entry.scanned_at, entry.dirty_at)  # this change was tried; wait for the next
    finally:
        with _lock:
            _inflight.pop(key, None)
            entry = _entries.get(key)
            if entry is not None and entry.dirty_at > entry.scanned_at:
                _schedule_locked(key)  # changed again mid-scan
        done.set()
    if ok:
        _notify(key)


def _scan_into_cache(key: str) -> Project:
    started = _time.time()
    project = scan_one(Path(key))
    project.scanned_at = started
    finished = _time.time()
    with _lock:
        prev = _entries.get(key)
        _entries[key] = _Entry(project=project, scanned_at=started, finished_at=finished,
                               dirty_at=max(prev.dirty_at if prev else 0.0, _pending_dirty.pop(key, 0.0)))
        _service_checked[key] = finished
        if _entries[key].dirty_at > started:
            _schedule_locked(key)  # something changed while it was being read
    return project


def _scan_blocking(key: str) -> Project | None:
    """Cold path: the first scan of a project. Concurrent callers share one."""
    with _lock:
        entry = _entries.get(key)
        if entry is not None:
            return entry.project
        done = _inflight.get(key)
        owner = done is None
        if owner:
            done = threading.Event()
            _inflight[key] = done
    if owner:
        try:
            return _scan_into_cache(key)
        except Exception as exc:
            print(f"[projects] first scan of {key} failed: {exc!r}", file=sys.stderr)
            return None
        finally:
            with _lock:
                _inflight.pop(key, None)
                entry = _entries.get(key)
                if entry is not None and entry.dirty_at > entry.scanned_at:
                    _schedule_locked(key)
            done.set()
    done.wait(timeout=60)
    with _lock:
        entry = _entries.get(key)
    return entry.project if entry else None


def _refresh_service(key: str, project: Project) -> None:
    """Ports go up and down without touching a file, so re-check them on
    their own short clock instead of rescanning the repo."""
    from . import manifest as man
    from . import probes
    with _lock:
        _service_checked[key] = _time.time()
    up = man.port_alive(project.manifest["port"])
    if up == project.service_up:
        return
    project.service_up = up
    signals = project.signals if project.signals is not None else {}
    signals["health"] = {"up": up}
    signals["verdict"] = probes.verdict_for(
        project.manifest or {}, signals["health"], signals.get("freshness") or [], project.git_state)
    project.signals = signals
    _notify(key)


def scan_one_cached(path: Path) -> Project | None:
    key = str(path)
    now = _time.time()
    check_service = False
    with _lock:
        entry = _entries.get(key)
        if entry is not None:
            if entry.dirty_at > entry.scanned_at or now - entry.scanned_at >= _CACHE_TTL:
                _schedule_locked(key)
            elif (entry.project.manifest or {}).get("port") and \
                    now - _service_checked.get(key, 0.0) >= _SERVICE_TTL:
                check_service = True
            project = entry.project
        else:
            project = None
    if project is None:
        return _scan_blocking(key)
    if check_service:
        _refresh_service(key, project)
    return project


def _is_project_dir(path: Path) -> bool:
    return (path.is_dir() and not path.name.startswith(".")
            and not (SELF_NAME and path.name == SELF_NAME)
            and ((path / ".git").exists() or (path / "README.md").exists()))


def _discover() -> list[Path]:
    global _discovered
    now = _time.time()
    if _discovered and now - _discovered[0] < _DISCOVER_TTL:
        return _discovered[1]
    found = sorted(c for c in PROJECTS_ROOT.iterdir() if _is_project_dir(c)) if PROJECTS_ROOT.exists() else []
    _discovered = (now, found)
    return found


def list_projects() -> list[Project]:
    """Every project, most recently active first. Only a project that has
    never been scanned makes the caller wait."""
    out = [p for p in (scan_one_cached(c) for c in _discover()) if p is not None]
    rank = {"active": 0, "recent": 1, "stale": 2}
    now = _time.time()

    def order(p: Project):
        elapsed = int(now - p.scanned_at) if p.scanned_at else 0
        commit_age = p.last_commit.age_seconds + elapsed if p.last_commit else 10**12
        file_age = p.last_modified_file.age_seconds + elapsed if p.last_modified_file else None
        return (rank.get(_momentum_from_ages(commit_age if p.last_commit else None, file_age), 3), commit_age)

    out.sort(key=order)
    return out


def get_one(name: str) -> Project | None:
    """Fast path: scan only the requested project, not all of them."""
    path = PROJECTS_ROOT / name
    if "/" in name or name.startswith(".") or not _is_project_dir(path):
        return None
    return scan_one_cached(path)


def project_to_dict(p: Project) -> dict:
    """Ages are recorded at scan time; serve them as of now, so a project
    rescanned five minutes ago does not claim its last commit is five minutes
    younger than it is."""
    d = asdict(p)
    elapsed = int(_time.time() - p.scanned_at) if p.scanned_at else 0
    if elapsed > 0:
        for c in [d.get("last_commit"), *d.get("recent_commits", [])]:
            if c:
                c["age_seconds"] += elapsed
        if d.get("last_modified_file"):
            d["last_modified_file"]["age_seconds"] += elapsed
        d["momentum"] = _momentum_from_ages(
            d["last_commit"]["age_seconds"] if d.get("last_commit") else None,
            d["last_modified_file"]["age_seconds"] if d.get("last_modified_file") else None)
    return d


# ---------------------------------------------------------------------------
# The scan itself: six git calls and one stat per file git knows about.
# ---------------------------------------------------------------------------

def _run(cmd: list[str], cwd: Path, timeout: float = 10) -> str:
    try:
        r = subprocess.run(cmd, cwd=str(cwd), capture_output=True, text=True, timeout=timeout)
        return r.stdout.strip()
    except Exception:
        return ""


def _git_commits_by_day(repo: Path, days: int = 30) -> list[int]:
    """Return [count_29_days_ago, ..., count_today] — len==days."""
    raw = _run(["git", "log", f"--since={days} days ago", "--pretty=format:%aI"], repo)
    if not raw:
        return [0] * days
    from collections import Counter
    counts: Counter = Counter()
    for line in raw.splitlines():
        try:
            d = datetime.fromisoformat(line.strip().replace("Z", "+00:00")).date()
        except ValueError:
            continue
        counts[d.isoformat()] += 1
    today = datetime.now(timezone.utc).date()
    return [counts.get((today - timedelta(days=i)).isoformat(), 0) for i in range(days - 1, -1, -1)]


def _git_log_recent(repo: Path, n: int = 10) -> list[Commit]:
    raw = _run(["git", "log", f"-{n}", "--pretty=format:%H|%h|%an|%aI|%s"], repo)
    if not raw:
        return []
    out = []
    now = datetime.now(timezone.utc)
    for line in raw.splitlines():
        parts = line.split("|", 4)
        if len(parts) < 5:
            continue
        sha, short, author, date_iso, subject = parts
        try:
            dt = datetime.fromisoformat(date_iso.replace("Z", "+00:00"))
            age = int((now - dt).total_seconds())
        except ValueError:
            age = 0
        out.append(Commit(sha=sha, short_sha=short, author=author,
                          date_iso=date_iso, age_seconds=age, subject=subject))
    return out


def _git_status(path: Path) -> tuple[str | None, dict]:
    """Branch, dirty count and ahead/behind from one `git status` call.
    --no-optional-locks keeps the scan from taking index.lock out from under
    a commit you are making at the same moment."""
    state = {"clean": True, "dirty_count": 0, "ahead": 0, "behind": 0, "has_remote": False}
    branch: str | None = None
    raw = _run(["git", "--no-optional-locks", "status", "--porcelain=v2", "--branch"], path)
    for line in raw.splitlines():
        if line.startswith("# branch.head "):
            head = line[len("# branch.head "):].strip()
            branch = None if head == "(detached)" else head
        elif line.startswith("# branch.upstream "):
            state["has_remote"] = True
        elif line.startswith("# branch.ab "):
            parts = line.split()
            try:
                state["ahead"] = abs(int(parts[2]))
                state["behind"] = abs(int(parts[3]))
            except (IndexError, ValueError):
                pass
        elif line and not line.startswith("#"):
            state["dirty_count"] += 1
    state["clean"] = state["dirty_count"] == 0
    return branch, state


def _git_files(root: Path) -> list[str] | None:
    """Tracked plus untracked-but-not-ignored files, so .gitignore decides
    what counts as the project (ATLA is 1.8k files, not the 11k Unreal
    leaves around it)."""
    try:
        r = subprocess.run(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
                           cwd=str(root), capture_output=True, timeout=15)
    except Exception:
        return None
    if r.returncode != 0:
        return None
    return list(dict.fromkeys(p for p in r.stdout.decode("utf-8", "replace").split("\0") if p))


def _walk_files(root: Path) -> list[str]:
    out: list[str] = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if not ignore.skip_dir(d)]
        rel_dir = os.path.relpath(dirpath, root)
        for name in filenames:
            out.append(name if rel_dir == "." else f"{rel_dir}/{name}")
    return out


def _file_stats(root: Path, has_git: bool) -> tuple[int, int, FileStat | None, dict[str, int]]:
    rels = _git_files(root) if has_git else None
    if rels is None:
        rels = _walk_files(root)
    count = total = 0
    newest: tuple[float, str, int] | None = None
    langs: dict[str, int] = {}
    for rel in rels:
        if ignore.skip_rel_path(rel):
            continue
        try:
            st = os.stat(root / rel)
        except OSError:
            continue
        if not stat.S_ISREG(st.st_mode):
            continue
        count += 1
        total += st.st_size
        ext = os.path.splitext(rel)[1].lower().lstrip(".")
        if ext:
            langs[ext] = langs.get(ext, 0) + 1
        if newest is None or st.st_mtime > newest[0]:
            newest = (st.st_mtime, rel, st.st_size)
    last: FileStat | None = None
    if newest:
        mtime = datetime.fromtimestamp(newest[0], tz=timezone.utc)
        last = FileStat(path=newest[1], size_bytes=newest[2],
                        modified_iso=mtime.isoformat(timespec="seconds"),
                        age_seconds=int((datetime.now(timezone.utc) - mtime).total_seconds()))
    return count, total, last, langs


_MD_LINK = re.compile(r"\[([^\]]+)\]\([^)]*\)")
_MD_EMPHASIS = re.compile(r"(\*\*|__|\*|`)")


def _plain(text: str) -> str:
    """README paragraphs are markdown; tiles and heroes show plain text."""
    return _MD_EMPHASIS.sub("", _MD_LINK.sub(r"\1", text)).strip()


def _summary_from_readme(path: Path) -> str:
    readme = path / "README.md"
    if not readme.exists():
        return ""
    try:
        text = readme.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return ""
    # Use the first non-empty paragraph after the first heading.
    paragraph: list[str] = []
    saw_heading = False
    for line in text.splitlines():
        s = line.strip()
        if not saw_heading:
            if s.startswith("#"):
                saw_heading = True
            continue
        if not s:
            if paragraph:
                break
            continue
        if s.startswith("#"):
            if paragraph:
                break
            continue
        paragraph.append(s)
        if len(" ".join(paragraph)) > 280:
            break
    return _plain(" ".join(paragraph))[:320]


def _todos_from_build_log(path: Path) -> list[str]:
    bl = path / "build_log.md"
    if not bl.exists():
        return []
    try:
        text = bl.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return []
    todos: list[str] = []
    for line in text.splitlines():
        s = line.strip()
        if s.startswith("- [ ]") or s.startswith("* [ ]"):
            todos.append(s[5:].strip())
        if len(todos) >= 10:
            break
    return todos


def _momentum_from_ages(commit_age: int | None, file_age: int | None) -> str:
    ages = [a for a in (commit_age, file_age) if a is not None]
    if not ages:
        return "stale"
    age = min(ages)
    if age < 6 * 3600:
        return "active"
    if age < 7 * 86400:
        return "recent"
    return "stale"


def _safe(fn, default, path: Path, what: str):
    try:
        return fn()
    except Exception as exc:
        print(f"[projects] {path.name}: {what} skipped: {exc!r}", file=sys.stderr)
        return default


def scan_one(path: Path) -> Project:
    has_git = (path / ".git").exists()
    branch: str | None = None
    git_state: dict = {}
    remote = None
    recent: list[Commit] = []
    commit_count = 0
    if has_git:
        branch, git_state = _git_status(path)
        remote = _run(["git", "config", "--get", "remote.origin.url"], path)
        recent = _git_log_recent(path)
        try:
            commit_count = int(_run(["git", "rev-list", "--count", "HEAD"], path))
        except ValueError:
            commit_count = 0

    file_count, total_size, last_file, langs = _file_stats(path, has_git)
    summary = _summary_from_readme(path)
    todos = _todos_from_build_log(path)
    momentum = _momentum_from_ages(recent[0].age_seconds if recent else None,
                                   last_file.age_seconds if last_file else None)

    # Each section below reads files the project owns (GOALS.md, project.yml,
    # probe targets); one unreadable file degrades that section, not the scan.
    from . import insights as ins
    project_insights = _safe(lambda: ins.insights_for(path, langs), [], path, "insights")
    by_day = _git_commits_by_day(path) if has_git else [0] * 30
    framework = _safe(lambda: ins.detect_framework(path, langs), None, path, "framework")

    from . import manifest as man
    project_manifest = _safe(lambda: man.load_manifest(path), None, path, "manifest")
    service_up: bool | None = None
    if project_manifest and project_manifest.get("port"):
        service_up = man.port_alive(project_manifest["port"])

    # Cheap signals for the card path: file probes + checklists, no HTTP.
    # TCP service_up stands in for the health probe here; the full (slower)
    # probe set is served by /api/projects/{name}/signals.
    from . import probes
    scan_health = {"up": service_up} if service_up is not None else None
    project_signals = _safe(lambda: probes.signals_for(path, project_manifest, git_state, include_metrics=False),
                            {"freshness": [], "metrics": [], "checklists": [], "blocker": None}, path, "probes")
    project_signals["health"] = scan_health
    project_signals["verdict"] = probes.verdict_for(
        project_manifest or {}, scan_health, project_signals.get("freshness") or [], git_state)

    return Project(
        name=path.name,
        path=str(path),
        has_git=has_git,
        remote_url=remote or None,
        branch=branch,
        commit_count=commit_count,
        last_commit=recent[0] if recent else None,
        recent_commits=recent,
        file_count=file_count,
        total_size_bytes=total_size,
        last_modified_file=last_file,
        summary=summary,
        momentum=momentum,
        todos=todos,
        languages=langs,
        insights=project_insights,
        commits_by_day=by_day,
        framework=framework,
        git_state=git_state,
        manifest=project_manifest,
        service_up=service_up,
        signals=project_signals,
        scanned_at=_time.time(),
    )
