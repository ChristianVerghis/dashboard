"""The Routines page's data: what runs on its own, and whether it is.

Local launchd jobs come from app/schedule.py (real next-run times, last run
from each job's own log). Cloud routines are judged by what they commit: the
newest commit by a routine (author "Claude") on each repo's origin, against
that routine's usual gap. The snapshot in data/routines_snapshot.json only
contributes names, models and cron schedules; nothing on the page depends on
it being recent.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import APIRouter

from . import freshness
from . import projects as proj_mod
from . import schedule as sched
from .home import local_tz

router = APIRouter()

SNAPSHOT = Path(__file__).resolve().parent.parent / "data" / "routines_snapshot.json"


def _field(spec: str, lo: int, hi: int) -> set[int]:
    out: set[int] = set()
    for part in spec.split(","):
        step = 1
        if "/" in part:
            part, s = part.split("/", 1)
            step = int(s)
        if part == "*":
            a, b = lo, hi
        elif "-" in part:
            a, b = (int(x) for x in part.split("-", 1))
        else:
            a = b = int(part)
        out.update(range(a, b + 1, step))
    return out


def cron_next(expr: str, after: datetime) -> datetime | None:
    """Next UTC time for a five-field cron expression (minute hour day month
    weekday, 0 or 7 = Sunday), searched minute by minute over the hours that
    can match; enough for routine schedules."""
    try:
        m, h, dom, mon, dow = expr.split()
        minutes, hours = _field(m, 0, 59), _field(h, 0, 23)
        days, months = _field(dom, 1, 31), _field(mon, 1, 12)
        weekdays = {d % 7 for d in _field(dow, 0, 7)}
    except (ValueError, TypeError):
        return None
    t = after.astimezone(timezone.utc).replace(second=0, microsecond=0) + timedelta(minutes=1)
    for _ in range(0, 60 * 24 * 32):
        day_ok = (dom == "*" or t.day in days) and (dow == "*" or t.isoweekday() % 7 in weekdays) \
            if not (dom != "*" and dow != "*") else (t.day in days or t.isoweekday() % 7 in weekdays)
        if t.month in months and day_ok and t.hour in hours:
            if t.minute in minutes:
                return t
            t += timedelta(minutes=1)
        else:
            t = (t + timedelta(hours=1)).replace(minute=0)
    return None


def _describe_local(expr: str) -> str:
    """A cron schedule in words and local time, read off its next fortnight
    of runs: 'daily 00:00', 'weekdays 04:00', 'Fridays 18:00'."""
    t = datetime.now(timezone.utc)
    runs = []
    for _ in range(40):
        t = cron_next(expr, t)
        if t is None or (runs and t - runs[0] > timedelta(days=14)):
            break
        runs.append(t)
    if not runs:
        return expr
    local = [r.astimezone(local_tz()) for r in runs]
    clocks = {x.strftime("%H:%M") for x in local}
    if len(clocks) > 1:
        gaps = {round((b - a).total_seconds() / 60) for a, b in zip(runs, runs[1:])}
        return f"every {gaps.pop()} min" if len(gaps) == 1 else f"{expr} (UTC)"
    when = clocks.pop()
    days = sorted({x.isoweekday() % 7 for x in local})
    names = "Sun Mon Tue Wed Thu Fri Sat".split()
    if len(days) == 7:
        return f"daily {when}"
    if days == [1, 2, 3, 4, 5]:
        return f"weekdays {when}"
    if len(days) == 1:
        return f"{['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'][days[0]]} {when}"
    return f"{', '.join(names[d] for d in days)} {when}"


def _snapshot() -> dict:
    try:
        return json.loads(SNAPSHOT.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


@router.get("/api/routines")
def api_routines():
    snap = _snapshot()
    checks = {c["id"]: c for c in freshness.all_checks()["checks"]}
    now = datetime.now(timezone.utc)
    by_project: dict[str, dict] = {}
    for r in snap.get("routines", []):
        nxt = cron_next(r["cron"], now) if r.get("enabled") and r.get("cron") else None
        by_project.setdefault(r.get("project") or "other", {"routines": []})["routines"].append({
            "name": r.get("name"), "enabled": bool(r.get("enabled")), "model": r.get("model"),
            "schedule": _describe_local(r["cron"]) if r.get("cron") else None,
            "next_run": nxt.astimezone(local_tz()).isoformat(timespec="minutes") if nxt else None,
            "note": None if r.get("enabled") else (r.get("status") or "disabled"),
        })
    # projects whose routines commit, even if the snapshot predates them
    for cid, c in checks.items():
        if cid.startswith("routine:"):
            by_project.setdefault(c["project"], {"routines": []})
    cloud = []
    for project, entry in by_project.items():
        check = checks.get(f"routine:{project}")
        p = proj_mod.get_one(project)
        act = freshness.routine_activity(Path(p.path)) if p and p.has_git else None
        cloud.append({
            "project": project,
            "state": check["state"] if check else ("off" if not any(r["enabled"] for r in entry["routines"]) else "unknown"),
            "detail": check["detail"] if check else "No commits by a routine on this repo's origin in the last 60 days.",
            "last": datetime.fromtimestamp(act["last"], timezone.utc).isoformat(timespec="minutes") if act else None,
            "gap_h": act["gap_h"] if act else None,
            "subject": act["subject"] if act else None,
            "routines": sorted(entry["routines"], key=lambda r: (not r["enabled"], r["name"] or "")),
        })
    rank = {"fail": 0, "warn": 1, "unknown": 2, "ok": 3, "off": 4}
    cloud.sort(key=lambda c: (rank.get(c["state"], 5), c["project"]))
    local = sched.scan()
    captured = snap.get("captured_at")
    return {
        "jobs": local["jobs"], "launchd_offset_min": local["launchd_offset_min"],
        "cloud": cloud, "snapshot_captured_at": captured,
        "checked_at": now.isoformat(timespec="seconds"),
    }
