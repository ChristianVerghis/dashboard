"""Scheduled jobs on this Mac: the launchd agents that run your projects
(steward, careers, markets, classroom), read from their plists, with the next
fire time, the last exit code launchd recorded, and whether the last
scheduled run actually happened.

A job counts as yours when its label or its program path mentions the
projects root. Long-running services (KeepAlive, no calendar) are left to the
services row; this is the "what runs while you sleep" list.

Evidence of a run is the job's own log: the newest file in the folder its
StandardOutPath points into (careers logs/daily, steward logs/steward) or
the project's data/cron (markets, classroom). launchd's own counters cannot
be trusted for this, and its stdout files stay empty because the scripts log
for themselves.

launchd keeps the time zone it had at login. After the Mac moves zones (the
SF trip, 2026-10-04) jobs fire at the old zone's clock times until you log
out and back in: the 02:00 steward ran at 23:00 PDT. The offset is inferred
from the logs themselves: when at least two jobs started the same number of
hours away from their configured time, that is launchd's clock.
"""
from __future__ import annotations

import os
import plistlib
import re
import statistics
import subprocess
import threading
import time
from datetime import datetime, timedelta
from pathlib import Path

from fastapi import APIRouter

from . import projects as proj_mod

router = APIRouter()

AGENTS_DIR = Path("~/Library/LaunchAgents").expanduser()
_TTL = 60.0
_cache: tuple[float, dict] | None = None
_lock = threading.Lock()
_PRINT_FIELDS = {
    "state": re.compile(r"^\s*state = (.+)$", re.M),
    "runs": re.compile(r"^\s*runs = (\d+)$", re.M),
    "last_exit": re.compile(r"^\s*last exit code = (-?\d+)", re.M),
}


def local_now() -> datetime:
    """Zone-aware (IANA) now, so next_fire's replace() gets each date's own
    offset across a DST change."""
    from .home import local_tz
    return datetime.now(local_tz())


def _project_of(paths: list[str]) -> str | None:
    root = str(proj_mod.PROJECTS_ROOT.resolve()) + "/"
    for p in paths:
        if p and p.startswith(root):
            return p[len(root):].split("/", 1)[0]
    return None


def _name_of(label: str) -> str:
    """com.christian.devsteward -> steward, com.christian.careers.daily -> careers daily."""
    tail = re.sub(r"^(com|org|io)\.[^.]+\.", "", label)
    tail = tail.replace("devsteward", "steward")
    return re.sub(r"[._-]+", " ", tail).strip()


def next_fire(intervals: list[dict], now: datetime) -> datetime | None:
    """Earliest time after `now` matching any launchd StartCalendarInterval
    entry (missing keys are wildcards; Weekday 0 and 7 are Sunday)."""
    best: datetime | None = None
    for day in range(0, 8):
        date = (now + timedelta(days=day)).date()
        weekday = (date.isoweekday() % 7)  # Sunday 0 .. Saturday 6
        for e in intervals:
            if "Weekday" in e and int(e["Weekday"]) % 7 != weekday:
                continue
            if "Day" in e and int(e["Day"]) != date.day:
                continue
            if "Month" in e and int(e["Month"]) != date.month:
                continue
            hours = [int(e["Hour"])] if "Hour" in e else range(24)
            minutes = [int(e["Minute"])] if "Minute" in e else range(60)
            for h in hours:
                for m in minutes:
                    t = now.replace(year=date.year, month=date.month, day=date.day, hour=h, minute=m,
                                    second=0, microsecond=0)
                    if t > now and (best is None or t < best):
                        best = t
                        break  # later minutes in this hour cannot beat it
        if best is not None and best.date() == date:
            return best
    return best


def prev_fire(intervals: list[dict], now: datetime) -> datetime | None:
    """Latest time at or before `now` matching any calendar entry."""
    best: datetime | None = None
    for day in range(0, 8):
        date = (now - timedelta(days=day)).date()
        weekday = date.isoweekday() % 7
        for e in intervals:
            if "Weekday" in e and int(e["Weekday"]) % 7 != weekday:
                continue
            if "Day" in e and int(e["Day"]) != date.day:
                continue
            if "Month" in e and int(e["Month"]) != date.month:
                continue
            for h in ([int(e["Hour"])] if "Hour" in e else range(24)):
                for m in ([int(e["Minute"])] if "Minute" in e else range(60)):
                    t = now.replace(year=date.year, month=date.month, day=date.day, hour=h, minute=m,
                                    second=0, microsecond=0)
                    if t <= now and (best is None or t > best):
                        best = t
        if best is not None and best.date() == date:
            return best
    return best


def _evidence_files(d: dict, label: str, project: str | None) -> list[Path]:
    """Per-run log files for one job, newest first."""
    root = proj_mod.PROJECTS_ROOT.resolve()
    dirs: list[Path] = []
    out_path = d.get("StandardOutPath") or d.get("StandardErrorPath")
    if out_path and str(Path(out_path).resolve()).startswith(str(root)):
        dirs.append(Path(out_path).resolve().parent)
    if project:
        dirs.append(root / project / "data" / "cron")
    token = label.rsplit(".", 1)[-1]  # com.christianverghis.classroom.weekly-retest -> weekly-retest
    for folder in dirs:
        try:
            files = [f for f in folder.iterdir() if f.is_file() and f.suffix == ".log"
                     and not f.name.startswith("launchd.")]
        except OSError:
            continue
        if not files:
            continue
        mine = [f for f in files if token in f.name]
        # a folder shared by several jobs (classroom's daily and weekly re-test):
        # files named for another job are not this one's
        files = mine or [f for f in files if not re.match(r"^[a-z][a-z-]*-\d{4}-\d{2}-\d{2}", f.name)]
        return sorted(files, key=lambda f: f.stat().st_mtime, reverse=True)
    return []


def _started(f: Path) -> float:
    st = f.stat()
    return getattr(st, "st_birthtime", st.st_mtime)


_login: tuple[float, float] | None = None  # (checked_at, login epoch)


def login_time() -> float:
    """When this GUI session started (loginwindow's start): launchd's per-user
    domain, and the time zone it keeps, date from then. 0 if unknown."""
    global _login
    if _login and time.time() - _login[0] < 600:
        return _login[1]
    epoch = 0.0
    try:
        pid = subprocess.run(["pgrep", "-x", "loginwindow"], capture_output=True, text=True, timeout=5).stdout.split()
        if pid:
            started = subprocess.run(["ps", "-o", "lstart=", "-p", pid[0]], capture_output=True, text=True,
                                     timeout=5).stdout.strip()
            text = " ".join(started.split())  # "Sun  6 Sep 23:31:57 2026" on this Mac, month-first elsewhere
            for fmt in ("%a %d %b %H:%M:%S %Y", "%a %b %d %H:%M:%S %Y"):
                try:
                    epoch = datetime.strptime(text, fmt).timestamp()
                    break
                except ValueError:
                    continue
    except (OSError, subprocess.TimeoutExpired, ValueError):
        epoch = 0.0
    _login = (time.time(), epoch)
    return epoch


def _launchd_offset(samples: list[tuple[list[dict], list[Path]]], tz) -> int:
    """Minutes launchd's clock is ahead of the local one (positive: jobs fire
    earlier, local time, than configured). Needs two jobs to agree, and only
    counts runs since you logged in: logging out and back in realigns launchd,
    and older logs would keep reporting the old offset."""
    since_login = login_time()
    deltas: list[int] = []
    for intervals, files in samples:
        times = {(int(e["Hour"]), int(e["Minute"])) for e in intervals if "Hour" in e and "Minute" in e}
        if not times:
            continue
        for f in files[:3]:
            started = datetime.fromtimestamp(_started(f), tz)
            if (datetime.now(tz) - started).days > 4 or _started(f) < since_login:
                continue
            m = started.hour * 60 + started.minute
            best = min(((h * 60 + mi - m + 720) % 1440 - 720 for h, mi in times), key=abs)
            deltas.append(best)
            break  # one recent run per job
    near = [x for x in deltas if abs(x) >= 30]
    if len(near) < 2:
        return 0
    mode = statistics.median(near)
    agree = [x for x in near if abs(x - mode) <= 15]
    return int(round(statistics.median(agree) / 30) * 30) if len(agree) >= 2 else 0


def _describe(intervals: list[dict]) -> str:
    times = sorted({(int(e.get("Hour", 0)), int(e.get("Minute", 0))) for e in intervals})
    days = {int(e["Weekday"]) % 7 for e in intervals if "Weekday" in e}
    when = ", ".join(f"{h:02d}:{m:02d}" for h, m in times[:3]) + ("…" if len(times) > 3 else "")
    if not days or len(days) == 7:
        return f"daily {when}"
    if days == {1, 2, 3, 4, 5}:
        return f"weekdays {when}"
    if days == {1, 2, 3, 4, 5, 6}:
        return f"Mon–Sat {when}"
    names = "Sun Mon Tue Wed Thu Fri Sat".split()
    return f"{' '.join(names[d] for d in sorted(days))} {when}"


def _launchctl(label: str) -> dict:
    try:
        r = subprocess.run(["launchctl", "print", f"gui/{os.getuid()}/{label}"],
                           capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.TimeoutExpired):
        return {}
    out: dict = {"loaded": r.returncode == 0}
    for key, rx in _PRINT_FIELDS.items():
        m = rx.search(r.stdout)
        if m:
            out[key] = m.group(1).strip()
    return out


def _scan() -> dict:
    root = str(proj_mod.PROJECTS_ROOT.resolve())
    now = local_now()
    found: list[tuple[dict, str, list[dict], int | None, list[str]]] = []
    for plist in sorted(AGENTS_DIR.glob("*.plist")):
        try:
            with open(plist, "rb") as fh:
                d = plistlib.load(fh)
        except (OSError, plistlib.InvalidFileException, ValueError):
            continue
        label = str(d.get("Label") or plist.stem)
        args = [str(a) for a in (d.get("ProgramArguments") or [d.get("Program") or ""])]
        paths = args + [str(d.get("WorkingDirectory") or "")]
        if not any(root in a for a in paths):
            continue
        cal = d.get("StartCalendarInterval")
        intervals = [cal] if isinstance(cal, dict) else (cal if isinstance(cal, list) else [])
        interval_s = d.get("StartInterval")
        if not intervals and not interval_s:
            continue  # a service, not a schedule
        found.append((d, label, intervals, interval_s, paths))

    evidence = {label: _evidence_files(d, label, _project_of(paths)) for d, label, _, _, paths in found}
    offset = _launchd_offset([(iv, evidence[label]) for _, label, iv, _, _ in found], now.tzinfo)
    shift = timedelta(minutes=offset)

    jobs: list[dict] = []
    for d, label, intervals, interval_s, paths in found:
        status = _launchctl(label)
        # launchd evaluates the calendar on its own clock: shift into it and back
        nxt = (next_fire(intervals, now + shift) - shift) if intervals else None
        prev = (prev_fire(intervals, now + shift) - shift) if intervals else None
        files = evidence[label]
        # the last write marks the latest run (the steward appends a second run of a date to one log)
        last_write = datetime.fromtimestamp(files[0].stat().st_mtime, now.tzinfo) if files else None
        last_run = last_write
        # missed: the last scheduled time passed (plus 90 min for a Mac asleep
        # or a slow start) and nothing has run since shortly before it
        missed = bool(prev and files and now - prev > timedelta(minutes=90)
                      and last_write < prev - timedelta(minutes=10))
        jobs.append({
            "label": label,
            "name": _name_of(label),
            "project": _project_of(paths),
            "schedule": _describe(intervals) if intervals else f"every {int(interval_s) // 60} min",
            "next_run": nxt.isoformat(timespec="minutes") if nxt else None,
            "prev_run": prev.isoformat(timespec="minutes") if prev else None,
            "last_run": last_run.isoformat(timespec="minutes") if last_run else None,
            "last_log": str(files[0]) if files else None,
            "missed": missed,
            "evidence": bool(files),
            "loaded": status.get("loaded", False),
            "running": status.get("state") == "running",
            "runs": int(status["runs"]) if status.get("runs", "").isdigit() else None,
            "last_exit": int(status["last_exit"]) if status.get("last_exit") not in (None, "") else None,
            "log": str(files[0]) if files else (str(d.get("StandardOutPath") or "") or None),
        })
    jobs.sort(key=lambda j: j["next_run"] or "9999")
    return {"jobs": jobs, "launchd_offset_min": offset}


def scan() -> dict:
    global _cache
    with _lock:
        if _cache and time.time() - _cache[0] < _TTL:
            return _cache[1]
        data = _scan()
        _cache = (time.time(), data)
        return data


def jobs() -> list[dict]:
    return scan()["jobs"]


@router.get("/api/schedule")
def api_schedule():
    data = scan()
    return {**data, "now": local_now().isoformat(timespec="seconds")}


@router.post("/api/schedule/{label}/run")
def api_run_now(label: str):
    """Start a scheduled job now (`launchctl kickstart`); only labels the
    schedule found under ~/Library/LaunchAgents, nothing from the request."""
    from fastapi import HTTPException
    if label not in {j["label"] for j in jobs()}:
        raise HTTPException(404, "no such scheduled job")
    r = subprocess.run(["launchctl", "kickstart", f"gui/{os.getuid()}/{label}"],
                       capture_output=True, text=True, timeout=10)
    if r.returncode != 0:
        raise HTTPException(500, (r.stderr or "launchctl failed").strip()[:300])
    global _cache
    _cache = None
    return {"ok": True, "label": label}
