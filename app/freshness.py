"""Is what the dashboard shows still current?

One registry for every source the pages lean on, each with the cadence it is
expected to keep and a verdict, so staleness shows up as a state instead of
as quietly old numbers. Feeds /api/freshness, the Data freshness panel on
Insights, the Routines page and (warn / fail) the Needs-you queue.

A check: {id, group, title, label, state (ok | warn | fail | unknown | info),
age_h, detail, action?}. Thresholds are deliberately tied to how often the
source is supposed to change: the steward writes nightly, the dashboard
fetches every six hours, a cloud routine is judged against its own usual gap.
"""
from __future__ import annotations

import json
import statistics
import subprocess
import threading
import time
from datetime import date, datetime, timezone
from pathlib import Path

from fastapi import APIRouter

from . import fetcher
from . import projects as proj_mod
from . import schedule as sched

router = APIRouter()

REPO_ROOT = Path(__file__).resolve().parent.parent
DATA = REPO_ROOT / "data"
_TTL = 60.0
_cache: tuple[float, dict] | None = None
_lock = threading.Lock()


def _code_mtime() -> float:
    return max((p.stat().st_mtime for p in (REPO_ROOT / "app").glob("*.py")), default=0.0)


def _head() -> str:
    try:
        return subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=str(REPO_ROOT),
                              capture_output=True, text=True, timeout=5).stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        return ""


# project probes a check here already reports (with its fix): the queue shows the check, not both
COVERS = {("dashboard", "nightly digest")}

# what this process loaded; compared with the disk to spot a server running old code
BOOT = {"code_mtime": _code_mtime(), "head": _head(), "at": time.time()}


def _ago(hours: float | None) -> str:
    if hours is None:
        return "never"
    if hours < 1:
        return f"{max(1, round(hours * 60))} min"
    if hours < 48:
        return f"{round(hours)} h"
    return f"{round(hours / 24)} days"


def _check(id: str, group: str, title: str, age_h: float | None, warn_h: float | None, fail_h: float | None,
           detail: str, *, label: str | None = None, action: dict | None = None, state: str | None = None,
           project: str | None = None) -> dict:
    if state is None:
        if age_h is None:
            state = "unknown"
        elif fail_h is not None and age_h >= fail_h:
            state = "fail"
        elif warn_h is not None and age_h >= warn_h:
            state = "warn"
        else:
            state = "ok"
    return {"id": id, "group": group, "title": title, "label": label or title, "state": state,
            "age_h": None if age_h is None else round(age_h, 1), "detail": detail, "action": action,
            "project": project}


def _steward() -> dict:
    # newest by the date in its name; a copied or restored folder resets mtimes
    files = sorted((DATA / "nightly").glob("*.md")) if (DATA / "nightly").exists() else []
    age = (time.time() - files[-1].stat().st_mtime) / 3600 if files else None
    detail = (f"Newest digest {files[-1].stem}, written {_ago(age)} ago. It should be under a day old."
              if files else "No digest has been written yet.")
    return _check("steward", "automation", "The nightly steward has not written a digest", age, 30, 54, detail,
                  label="Nightly steward digest",
                  action={"label": "Run the steward now", "type": "post",
                          "url": "/api/schedule/com.christian.devsteward/run"})


def _fetches(state: dict) -> dict:
    repos = state["repos"]
    if not repos:
        return _check("fetch", "git", "No repos with a remote", None, None, None, "", state="info",
                      label="Remote branches")
    ages = {n: r["age_h"] for n, r in repos.items()}
    oldest_name = max(ages, key=lambda n: float("inf") if ages[n] is None else ages[n])
    oldest = ages[oldest_name]
    failing = [n for n, r in repos.items() if r["last_result"] and not r["last_result"]["ok"]
               and not r["last_result"].get("skipped")]
    detail = (f"{len(repos)} repos with a remote; the oldest view is {oldest_name}'s, {_ago(oldest)} old. "
              "Ahead/behind counts and routine branches are only as fresh as this. The dashboard fetches every 6 h.")
    if failing:
        detail += f" Last fetch failed for {', '.join(failing)}."
    return _check("fetch", "git", "Remote branches are out of date", oldest, 12, 48, detail,
                  label="Remote branches (git fetch)",
                  state="warn" if failing and (oldest or 0) < 12 else None,
                  action={"label": "Fetch all now", "type": "post", "url": "/api/fetch"})


def routine_activity(path: Path) -> dict | None:
    """Commits by cloud routines (author "Claude") on origin refs in the last
    60 days: when the newest landed and how far apart runs usually are."""
    try:
        r = subprocess.run(["git", "log", "--remotes=origin", "--author=^Claude <", "--since=60.days",
                            "--format=%ct%x09%s"], cwd=str(path), capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        return None
    rows = []
    for line in r.stdout.splitlines():
        ts, _, subject = line.partition("\t")
        if ts.isdigit():
            rows.append((int(ts), subject))
    if len(rows) < 3:
        return None
    rows.sort(reverse=True)
    runs: list[int] = []  # commits within 3 h of each other are one run
    for ts, _ in rows:
        if not runs or runs[-1] - ts > 3 * 3600:
            runs.append(ts)
    gaps = [(a - b) / 3600 for a, b in zip(runs, runs[1:])][:12]
    return {"last": rows[0][0], "subject": rows[0][1], "runs": len(runs),
            "gap_h": statistics.median(gaps) if gaps else None}


def _routines(fetch_state: dict) -> list[dict]:
    out = []
    now = time.time()
    for p in proj_mod.list_projects():
        if not p.has_git or p.name not in fetch_state["repos"]:
            continue
        act = routine_activity(Path(p.path))
        if not act:
            continue
        age = (now - act["last"]) / 3600
        gap = act["gap_h"] or 24
        fetched = fetch_state["repos"][p.name]["age_h"]
        every = "about daily" if 18 <= gap <= 30 else f"about every {_ago(gap)}"
        detail = f"Last commit by a routine {_ago(age)} ago: “{act['subject'][:90]}”. Runs land {every}."
        state = None
        if fetched is None or fetched > 48:
            state = "unknown"
            detail += f" Can't tell if it is still running: this repo was last fetched {_ago(fetched)} ago."
        out.append(_check(f"routine:{p.name}", "cloud", f"{p.name}'s cloud routine has gone quiet", age,
                          max(2 * gap, 36), max(4 * gap, 72), detail, label=f"{p.name} cloud routine",
                          state=state, project=p.name))
    return out


def _jobs() -> list[dict]:
    data = sched.scan()
    out = []
    offset = data.get("launchd_offset_min") or 0
    if offset:
        hours = abs(offset) / 60
        word = "earlier" if offset > 0 else "later"
        out.append(_check("launchd-clock", "automation",
                          f"Scheduled jobs run {hours:g} h {word} than configured", None, None, None,
                          f"launchd keeps the time zone it had when you logged in, and the job logs show every "
                          f"job starting {hours:g} h {word} than its plist says (the 02:00 steward runs at "
                          f"{(2 - offset / 60) % 24:02.0f}:00). Times on the Routines page are shifted to match. "
                          "Log out and back in to realign, or leave it while you travel.",
                          label="launchd clock", state="warn"))
    for j in data["jobs"]:
        age = None
        if j.get("last_run"):
            age = (datetime.now(timezone.utc) - datetime.fromisoformat(j["last_run"])).total_seconds() / 3600
        if not j.get("evidence"):
            state, detail = "unknown", "No per-run log found, so a missed run would go unnoticed."
        elif j.get("missed"):
            state = "warn"
            detail = f"Its {j['prev_run'][11:16]} run did not happen; the last run was {_ago(age)} ago."
        else:
            state, detail = "ok", f"Last ran {_ago(age)} ago."
        out.append(_check(f"job:{j['label']}", "automation", f"{j['name']} missed its last run", age, None, None,
                          detail, label=f"{j['name']} (launchd)", state=state, project=j.get("project"),
                          action={"label": "Run now", "type": "post", "url": f"/api/schedule/{j['label']}/run"}))
    return out


def _showcases() -> list[dict]:
    out = []
    folder = DATA / "showcase"
    if not folder.exists():
        return out
    for png in sorted(folder.glob("*.png")):
        age = (time.time() - png.stat().st_mtime) / 3600
        p = proj_mod.get_one(png.stem)
        m = (p.manifest or {}) if p else {}
        sc = m.get("showcase") or {}
        if sc.get("kind") != "app" or str(sc.get("href") or "").startswith("/"):
            continue  # never displayed: the project page shows the live page instead
        parked = m.get("status") in ("dormant", "parked", "archived")
        up = bool(p and p.service_up)
        action = ({"label": "Retake the screenshot", "type": "post", "url": f"/api/showcase/capture?name={png.stem}"}
                  if up else None)
        has_app = bool(p and (p.manifest or {}).get("port"))
        detail = (f"The project page shows a {_ago(age)}-old screenshot of {png.stem}. "
                  + ("Its app is running, so it can be retaken now." if up else
                     "Start its app to retake it; until then the page labels the picture with its date." if has_app else
                     "Its project declares no app port, so it cannot be retaken from here; the page labels it with its date."))
        if parked:
            detail = (f"A {_ago(age)}-old screenshot of {png.stem}, kept as its last look while the project is "
                      f"{m.get('status')}; it goes stale only once you pick the project up again.")
        out.append(_check(f"showcase:{png.stem}", "pages", f"{png.stem}'s screenshot is {_ago(age)} old", age,
                          30 * 24, None, detail, label=f"{png.stem} screenshot", action=action, project=png.stem,
                          state="info" if parked else None))
    return out


def _external() -> list[dict]:
    out = []
    for f in sorted((DATA / "external_activity").glob("*.json")) if (DATA / "external_activity").exists() else []:
        try:
            d = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        days = sorted(d.get("days") or {})
        if not days:
            continue
        last = date.fromisoformat(days[-1])
        age = (date.today() - last).days * 24
        approx = " Counts are approximate." if d.get("approximate") else ""
        out.append(_check(f"external:{f.stem}", "pages", f"{d.get('name', f.stem)} activity stops on {last}", age,
                          21 * 24, None,
                          f"External activity in the heatmap and share card runs to {last}.{approx} "
                          f"Replace data/external_activity/{f.name} with a fresh export to extend it.",
                          label=f"{d.get('name', f.stem)} (external activity)"))
    return out


def _routine_config() -> dict:
    path = DATA / "routines_snapshot.json"
    try:
        snap = json.loads(path.read_text(encoding="utf-8"))
        captured = datetime.fromisoformat(str(snap.get("captured_at")).replace("Z", "+00:00"))
        age = (datetime.now(timezone.utc) - captured).total_seconds() / 3600
    except (OSError, ValueError, TypeError):
        return _check("routine-config", "cloud", "Cloud routine list", None, None, None,
                      "No snapshot of the cloud routine list.", state="info")
    return _check("routine-config", "cloud", "Cloud routine list", age, None, None,
                  f"Names and schedules as captured {captured.date()}. Whether each routine is still running "
                  "comes from what it commits (above), so this list only goes stale when routines are added or "
                  "renamed. Refresh it from a Claude Code session that can see your routines.",
                  label="Cloud routine list (names, schedules)", state="info")


def _self() -> dict:
    changed = _code_mtime() > BOOT["code_mtime"] + 1
    head = _head()
    if not changed and head == BOOT["head"]:
        return _check("self", "dashboard", "Dashboard code", 0, None, None,
                      f"Running the code on disk ({head}).", label="Dashboard server", state="ok")
    detail = (f"The server started at {BOOT['head'] or 'an older commit'}; the checkout is now at {head}. "
              "Pages are served fresh, but the Python side keeps the old behaviour until a restart.")
    return _check("self", "dashboard", "The dashboard is running older code than the checkout", 0, None, None,
                  detail, label="Dashboard server", state="warn",
                  action={"label": "Restart the dashboard", "type": "post", "url": "/api/self/restart"})


def all_checks() -> dict:
    global _cache
    with _lock:
        if _cache and time.time() - _cache[0] < _TTL:
            return _cache[1]
    fetch_state = fetcher.status()
    checks = [_self(), _steward(), _fetches(fetch_state), *_jobs(), *_routines(fetch_state),
              _routine_config(), *_showcases(), *_external()]
    counts = {s: sum(1 for c in checks if c["state"] == s) for s in ("ok", "warn", "fail", "unknown", "info")}
    data = {"checks": checks, "counts": counts,
            "checked_at": datetime.now(timezone.utc).isoformat(timespec="seconds")}
    with _lock:
        _cache = (time.time(), data)
    return data


def invalidate() -> None:
    global _cache
    with _lock:
        _cache = None


@router.get("/api/freshness")
def api_freshness():
    return all_checks()
