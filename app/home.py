"""Home page data that is not a list of its own: what to work on next, how
this week compares with a usual one, and what the steward did last night;
plus the corpus the ⌘K palette searches.
"""
from __future__ import annotations

import os
import re
import statistics
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from fastapi import APIRouter

from . import insights as ins
from . import projects as proj_mod

router = APIRouter()

REPO_ROOT = Path(__file__).resolve().parent.parent
NIGHTLY_DIR = REPO_ROOT / "data" / "nightly"
_QUIET = {"parked", "dormant", "archived"}


def local_tz():
    """The Mac's own zone, so "today" follows you when you travel. An IANA
    zone (read from /etc/localtime) rather than today's fixed offset, so days
    and hours on the other side of a DST change land right. DASHBOARD_TZ (an
    IANA name) overrides it."""
    for name in (os.environ.get("DASHBOARD_TZ"), _system_zone_name()):
        if name:
            try:
                return ZoneInfo(name)
            except Exception:
                continue
    return datetime.now().astimezone().tzinfo


def _system_zone_name() -> str | None:
    try:
        target = os.path.realpath("/etc/localtime")
    except OSError:
        return None
    _, sep, name = target.partition("zoneinfo/")
    return name if sep else None


def next_up(projects: list, limit: int = 5) -> list[dict]:
    """The first open GOALS.md item of each project you are not parking,
    most recently worked first."""
    rows = []
    for p in projects:
        if (p.manifest or {}).get("status") in _QUIET:
            continue
        g = ins._parse_goals(Path(p.path))
        if not g or not g.get("next_undone"):
            continue
        rows.append({"project": p.name, "goal": _plain(g["next_undone"]), "done": g["done"], "total": g["total"],
                     "last_commit": p.last_commit.date_iso if p.last_commit else None})
    rows.sort(key=lambda r: r["last_commit"] or "", reverse=True)
    return rows[:limit]


def week(hm: dict) -> dict:
    """This week (the last 7 local days) against the median of the eight
    weeks before it: a number with a baseline instead of a bare count."""
    days = hm.get("days") or []
    if len(days) < 14:
        return {}
    weekly = [sum(d["count"] for d in days[i:i + 7]) for i in range(len(days) - 7 * 13, len(days), 7)]
    this = weekly[-1]
    usual = statistics.median(weekly[-9:-1])
    last7 = days[-7:]
    streak = 0
    for d in reversed(days if days[-1]["count"] else days[:-1]):  # today can still be empty
        if not d["count"]:
            break
        streak += 1
    return {
        "commits": this, "usual": round(usual), "weekly": weekly,
        "projects": len({name for d in last7 for name in d.get("by_project", {})}),
        "active_days": sum(1 for d in last7 if d["count"]),
        "streak": streak,
    }


_MD = re.compile(r"\*\*|__|`")


def _plain(text: str) -> str:
    return _MD.sub("", re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", text)).strip()


def last_night() -> dict | None:
    """The newest steward digest, boiled down to what it advanced and how
    many things it says need you."""
    files = sorted(NIGHTLY_DIR.glob("*.md")) if NIGHTLY_DIR.exists() else []
    if not files:
        return None
    f = files[-1]
    try:
        text = f.read_text(encoding="utf-8")
    except OSError:
        return None
    sections: dict[str, list[str]] = {}
    current = ""
    for line in text.splitlines():
        if line.startswith("## "):
            current = line[3:].strip().lower()
            sections[current] = []
        elif line.startswith("- ") and current:
            sections[current].append(_plain(line[2:]))
    work = next((v for k, v in sections.items() if k.startswith("work")), [])
    needs = next((v for k, v in sections.items() if k.startswith("needs")), [])
    headline = work[0] if work else ""
    first_sentence = re.split(r"(?<=[.!?])\s", headline, maxsplit=1)[0]
    return {"date": f.stem[:10], "headline": first_sentence[:240], "needs": len(needs),
            "url": "/digest"}


@router.get("/api/home")
def api_home():
    from .main import heatmap_if_ready  # cached; None while the first build runs
    projects = proj_mod.list_projects()
    hm = heatmap_if_ready(52)
    return {
        "next_up": next_up(projects),
        "week": week(hm) if hm else None,
        "last_night": last_night(),
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }


@router.get("/api/palette")
def api_palette():
    """Everything ⌘K can jump to or act on, in one small payload."""
    projects = proj_mod.list_projects()
    rows, commits = [], []
    for p in projects:
        m = p.manifest or {}
        rows.append({"name": p.name, "status": m.get("status"), "kind": m.get("kind"),
                     "framework": p.framework, "port": m.get("port"), "up": p.service_up,
                     "can_start": bool(m.get("start")), "description": m.get("description") or p.summary[:140]})
        for c in p.recent_commits[:6]:
            commits.append({"project": p.name, "sha": c.short_sha, "subject": c.subject,
                            "date": c.date_iso})
    commits.sort(key=lambda c: c["date"], reverse=True)
    return {"projects": rows, "commits": commits[:60]}
