"""Scan the projects root (default ~/dev, override with DEV_ROOT) and return rich metadata per project.

Each project is auto-discovered: any direct subdirectory of PROJECTS_ROOT
that contains either a `.git` folder or a `README.md` is treated as a
project. The dashboard itself is excluded.
"""
from __future__ import annotations

import json
import os
import subprocess
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path

PROJECTS_ROOT = Path(os.environ.get("DEV_ROOT", "~/dev")).expanduser()
SELF_NAME = None  # set to "dashboard" to hide self; None to show all

# TTL cache for scan results — same project page can trigger 10+ concurrent
# requests, each was re-walking the whole file tree. The watchdog SSE delta
# path invalidates when files actually change, so a long TTL only bounds
# staleness for changes the watchdog misses; 30s keeps cold page loads from
# serializing a dozen 4-second scans.
import time as _time
_scan_cache: dict[str, tuple[float, "Project"]] = {}
_list_cache: tuple[float, list["Project"]] | None = None
_CACHE_TTL = 30.0


def invalidate_caches() -> None:
    """Called from the watchdog when files change."""
    global _list_cache
    _scan_cache.clear()
    _list_cache = None


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


def _run(cmd: list[str], cwd: Path) -> str:
    try:
        r = subprocess.run(cmd, cwd=str(cwd), capture_output=True, text=True, timeout=10)
        return r.stdout.strip()
    except Exception:
        return ""


def _git_commits_by_day(repo: Path, days: int = 30) -> list[int]:
    """Return [count_29_days_ago, ..., count_today] — len==days."""
    raw = _run(
        ["git", "log", f"--since={days} days ago", "--pretty=format:%aI"],
        repo,
    )
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
    out: list[int] = []
    from datetime import timedelta as _td
    for i in range(days - 1, -1, -1):
        d = (today - _td(days=i)).isoformat()
        out.append(counts.get(d, 0))
    return out


def _git_log_recent(repo: Path, n: int = 10) -> list[Commit]:
    raw = _run(
        ["git", "log", f"-{n}", "--pretty=format:%H|%h|%an|%aI|%s"],
        repo,
    )
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


def _file_stats(root: Path, ignore: set[str]) -> tuple[int, int, FileStat | None, dict[str, int]]:
    count = 0
    total = 0
    most_recent: FileStat | None = None
    langs: dict[str, int] = {}
    now = datetime.now(timezone.utc)
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in ignore and not d.startswith(".")]
        for name in filenames:
            if name.startswith(".") or name == ".DS_Store":
                continue
            p = Path(dirpath) / name
            try:
                st = p.stat()
            except OSError:
                continue
            count += 1
            total += st.st_size
            ext = p.suffix.lower().lstrip(".")
            if ext:
                langs[ext] = langs.get(ext, 0) + 1
            mtime = datetime.fromtimestamp(st.st_mtime, tz=timezone.utc)
            try:
                rel = str(p.relative_to(root))
            except ValueError:
                rel = name
            fs = FileStat(
                path=rel,
                size_bytes=st.st_size,
                modified_iso=mtime.isoformat(timespec="seconds"),
                age_seconds=int((now - mtime).total_seconds()),
            )
            if most_recent is None or fs.age_seconds < most_recent.age_seconds:
                most_recent = fs
    return count, total, most_recent, langs


def _summary_from_readme(path: Path) -> str:
    readme = path / "README.md"
    if not readme.exists():
        return ""
    try:
        text = readme.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return ""
    # Use the first non-empty paragraph after the first heading.
    lines = text.splitlines()
    paragraph: list[str] = []
    saw_heading = False
    for line in lines:
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
    return " ".join(paragraph)[:320]


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


def _momentum(commit: Commit | None, last_file: FileStat | None) -> str:
    candidates = []
    if commit:
        candidates.append(commit.age_seconds)
    if last_file:
        candidates.append(last_file.age_seconds)
    if not candidates:
        return "stale"
    age = min(candidates)
    if age < 6 * 3600:
        return "active"
    if age < 7 * 86400:
        return "recent"
    return "stale"


def _git_state(path: Path) -> dict:
    """Quick git status snapshot: dirty, ahead/behind origin/<branch>."""
    state = {"clean": True, "dirty_count": 0, "ahead": 0, "behind": 0, "has_remote": False}
    porcelain = _run(["git", "status", "--porcelain"], path)
    if porcelain:
        state["clean"] = False
        state["dirty_count"] = len([l for l in porcelain.splitlines() if l.strip()])
    branch = _run(["git", "branch", "--show-current"], path)
    if branch:
        # Check for upstream; don't fetch (too slow)
        upstream = _run(["git", "rev-parse", "--abbrev-ref", f"{branch}@{{upstream}}"], path)
        if upstream:
            state["has_remote"] = True
            ahead_behind = _run(["git", "rev-list", "--left-right", "--count",
                                 f"{branch}...{upstream}"], path)
            if ahead_behind:
                parts = ahead_behind.split()
                if len(parts) == 2:
                    state["ahead"] = int(parts[0]) if parts[0].isdigit() else 0
                    state["behind"] = int(parts[1]) if parts[1].isdigit() else 0
    return state


def scan_one(path: Path) -> Project:
    has_git = (path / ".git").exists()
    branch = _run(["git", "branch", "--show-current"], path) if has_git else None
    remote = _run(["git", "config", "--get", "remote.origin.url"], path) if has_git else None
    recent = _git_log_recent(path) if has_git else []
    commit_count = 0
    git_state = _git_state(path) if has_git else {}
    if has_git:
        out = _run(["git", "rev-list", "--count", "HEAD"], path)
        try:
            commit_count = int(out)
        except ValueError:
            commit_count = 0

    # Skip enormous trees inside git's pack files etc.
    ignore = {".git", ".venv", "venv", "node_modules", "__pycache__", ".obsidian"}
    file_count, total_size, last_file, langs = _file_stats(path, ignore)
    summary = _summary_from_readme(path)
    todos = _todos_from_build_log(path)
    momentum = _momentum(recent[0] if recent else None, last_file)

    from . import insights as ins
    project_insights = ins.insights_for(path)
    by_day = _git_commits_by_day(path) if has_git else [0] * 30
    framework = ins.detect_framework(path)

    from . import manifest as man
    project_manifest = man.load_manifest(path)
    service_up: bool | None = None
    if project_manifest and project_manifest.get("port"):
        service_up = man.port_alive(project_manifest["port"])

    # Cheap signals for the card path: file probes + checklists, no HTTP.
    # TCP service_up stands in for the health probe here; the full (slower)
    # probe set is served by /api/projects/{name}/signals.
    from . import probes
    scan_health = {"up": service_up} if service_up is not None else None
    project_signals = probes.signals_for(
        path, project_manifest, git_state, include_metrics=False)
    project_signals["health"] = scan_health
    project_signals["verdict"] = probes.verdict_for(
        project_manifest or {}, scan_health, project_signals["freshness"], git_state)

    return Project(
        name=path.name,
        path=str(path),
        has_git=has_git,
        remote_url=remote or None,
        branch=branch or None,
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
    )


def scan_one_cached(path: Path) -> Project:
    """scan_one() wrapped with a TTL cache."""
    now = _time.time()
    key = str(path)
    cached = _scan_cache.get(key)
    if cached and (now - cached[0]) < _CACHE_TTL:
        return cached[1]
    result = scan_one(path)
    _scan_cache[key] = (now, result)
    return result


def list_projects() -> list[Project]:
    """TTL-cached list. The watchdog-driven SSE delta path invalidates on
    file change, so staleness is bounded by the cache TTL or the next edit."""
    global _list_cache
    now = _time.time()
    if _list_cache and (now - _list_cache[0]) < _CACHE_TTL:
        return _list_cache[1]
    if not PROJECTS_ROOT.exists():
        _list_cache = (now, [])
        return []
    out: list[Project] = []
    for child in sorted(PROJECTS_ROOT.iterdir()):
        if not child.is_dir():
            continue
        if child.name.startswith(".") or (SELF_NAME and child.name == SELF_NAME):
            continue
        if not ((child / ".git").exists() or (child / "README.md").exists()):
            continue
        out.append(scan_one_cached(child))
    # Sort by momentum then last commit recency
    rank = {"active": 0, "recent": 1, "stale": 2}
    out.sort(key=lambda p: (
        rank.get(p.momentum, 3),
        p.last_commit.age_seconds if p.last_commit else 10**12,
    ))
    _list_cache = (now, out)
    return out


def get_one(name: str) -> Project | None:
    """Fast path: scan only the requested project, not all of them."""
    path = PROJECTS_ROOT / name
    if not path.is_dir():
        return None
    if not ((path / ".git").exists() or (path / "README.md").exists()):
        return None
    return scan_one_cached(path)


def project_to_dict(p: Project) -> dict:
    d = asdict(p)
    return d
