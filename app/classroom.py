"""Classroom data layer for the dashboard.

Reads from the `classroom` project under the projects root.
Read-only — never writes to the classroom directory.
"""
from __future__ import annotations

import json
import math
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

from . import projects as proj

CLASSROOM_ROOT = proj.PROJECTS_ROOT / "classroom"
STUDENTS_DIR = CLASSROOM_ROOT / "students"
DAILY_DIR = CLASSROOM_ROOT / "data" / "daily"
USAGE_LOG = CLASSROOM_ROOT / "data" / "usage_log.jsonl"
HOF_DIR = CLASSROOM_ROOT / "vault" / "Hall of Fame"
WOS_DIR = CLASSROOM_ROOT / "vault" / "Wall of Shame"
ROSTER_PATH = CLASSROOM_ROOT / "config" / "students.yml"
PROJECTIONS_PATH = CLASSROOM_ROOT / "data" / "projections.json"


def _safe_name(name: str) -> bool:
    """Sanity-check student name to keep filesystem reads safe."""
    return bool(name) and all(c.isalnum() or c in "-_" for c in name) and ".." not in name


def _read_score(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return None


def _read_jsonl(path: Path, last_n: int | None = None) -> list[dict]:
    if not path.exists():
        return []
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    if last_n is not None and len(lines) > last_n:
        lines = lines[-last_n:]
    out = []
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return out


def _score_sortkey(s: dict) -> float:
    """Lower is better — Brier preferred; fall back to negative hit rate so
    high-hit-rate-low-Brier rises to the top together."""
    b = s.get("rolling_brier_30")
    if b is not None:
        return float(b)
    hr = s.get("hit_rate")
    if hr is not None:
        return 1.0 - float(hr)  # convert to "Brier-ish" loss
    return 0.9  # unresolved students sink toward the bottom


def _roster_names() -> set[str]:
    """Names of students in the current config/students.yml (so we filter
    out orphans left over from earlier param-grid configurations)."""
    if not ROSTER_PATH.exists():
        return set()
    try:
        import yaml  # FastAPI app already depends on PyYAML transitively
        data = yaml.safe_load(ROSTER_PATH.read_text()) or {}
        return {s["name"] for s in (data.get("students") or []) if "name" in s}
    except Exception:
        return set()


def list_students() -> list[dict]:
    out = []
    if not STUDENTS_DIR.exists():
        return out
    live = _roster_names()
    for d in sorted(STUDENTS_DIR.iterdir()):
        if not d.is_dir():
            continue
        if live and d.name not in live:
            continue
        score = _read_score(d / "score.json")
        log_path = d / "log.jsonl"
        n_open = 0
        n_total = 0
        last_pred_at = None
        if log_path.exists():
            for p in _read_jsonl(log_path):
                n_total += 1
                if p.get("status") == "open":
                    n_open += 1
                last_pred_at = p.get("created_at") or last_pred_at
        out.append({
            "name": d.name,
            "technique": (score or {}).get("technique"),
            "params": (score or {}).get("technique_params"),
            "total_predictions": n_total,
            "open_predictions": n_open,
            "total_resolved": (score or {}).get("total_resolved", 0),
            "total_correct": (score or {}).get("total_correct", 0),
            "hit_rate": (score or {}).get("hit_rate"),
            "rolling_brier_30": (score or {}).get("rolling_brier_30"),
            "lifetime_brier": (score or {}).get("lifetime_brier"),
            "current_streak": (score or {}).get("current_streak", 0),
            "best_streak": (score or {}).get("best_streak", 0),
            "calibration_shift": (score or {}).get("calibration_shift", 0),
            "last_prediction_at": last_pred_at,
        })
    return out


def leaderboard(limit: int = 50) -> list[dict]:
    rows = list_students()
    # Only rank students with at least one resolved prediction; the rest sit
    # in an unresolved bucket on the page.
    ranked = [r for r in rows if (r.get("total_resolved") or 0) > 0]
    ranked.sort(key=_score_sortkey)
    return ranked[:limit]


def unresolved_students() -> list[dict]:
    rows = list_students()
    return [r for r in rows if (r.get("total_resolved") or 0) == 0]


def by_technique() -> list[dict]:
    rows = list_students()
    agg = defaultdict(lambda: {"n": 0, "resolved": 0, "correct": 0, "brier_sum": 0.0, "brier_n": 0,
                                "open": 0, "students": []})
    for r in rows:
        t = r.get("technique") or "unknown"
        a = agg[t]
        a["n"] += 1
        a["resolved"] += r.get("total_resolved", 0)
        a["correct"] += r.get("total_correct", 0)
        a["open"] += r.get("open_predictions", 0)
        if r.get("lifetime_brier") is not None:
            a["brier_sum"] += float(r["lifetime_brier"])
            a["brier_n"] += 1
        a["students"].append(r["name"])
    out = []
    for t, a in agg.items():
        hit_rate = (a["correct"] / a["resolved"]) if a["resolved"] else None
        avg_brier = (a["brier_sum"] / a["brier_n"]) if a["brier_n"] else None
        out.append({
            "technique": t,
            "n_students": a["n"],
            "total_resolved": a["resolved"],
            "total_correct": a["correct"],
            "total_open": a["open"],
            "hit_rate": hit_rate,
            "avg_lifetime_brier": avg_brier,
            "students": a["students"],
        })
    out.sort(key=lambda x: (x["avg_lifetime_brier"] is None, x["avg_lifetime_brier"] or 1.0))
    return out


def student_detail(name: str) -> dict | None:
    if not _safe_name(name):
        return None
    base = STUDENTS_DIR / name
    if not base.exists():
        return None
    score = _read_score(base / "score.json") or {}
    log = _read_jsonl(base / "log.jsonl", last_n=200)
    profile_path = base / "profile.md"
    profile_md = ""
    if profile_path.exists():
        try:
            profile_md = profile_path.read_text(encoding="utf-8")[:20_000]
        except OSError:
            pass
    # Sort log: most recent first
    log.sort(key=lambda p: p.get("created_at", ""), reverse=True)
    return {
        "name": name,
        "score": score,
        "profile_md": profile_md,
        "log": log,
    }


def hall_entries(kind: str, limit: int = 50) -> list[dict]:
    """List Hall-of-Fame or Wall-of-Shame markdown entries."""
    target = HOF_DIR if kind == "fame" else WOS_DIR
    if not target.exists():
        return []
    out = []
    for path in sorted(target.glob("*.md"), reverse=True)[:limit]:
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            continue
        out.append({
            "slug": path.stem,
            "filename": path.name,
            "markdown": text[:15_000],
        })
    return out


def usage_summary(days: int = 14) -> dict:
    if not USAGE_LOG.exists():
        return {"by_day": [], "by_persona": [], "total_calls": 0, "exists": False}
    records = _read_jsonl(USAGE_LOG)
    if not records:
        return {"by_day": [], "by_persona": [], "total_calls": 0, "exists": True}
    cutoff_date = (datetime.now(timezone.utc).date()).isoformat()
    # Window: last N days inclusive of today
    from datetime import timedelta
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%d")
    by_day = defaultdict(lambda: {"calls": 0, "skipped": 0, "errors": 0, "duration_ms": 0})
    by_persona = defaultdict(lambda: {"calls": 0, "errors": 0, "duration_ms": 0})
    total_calls = 0
    for r in records:
        day = r.get("at", "")[:10]
        if day < cutoff:
            continue
        kind = r.get("kind")
        if kind == "llm_persona_call":
            by_day[day]["calls"] += 1
            by_day[day]["duration_ms"] += int(r.get("duration_ms", 0))
            persona = r.get("persona", "?")
            by_persona[persona]["calls"] += 1
            by_persona[persona]["duration_ms"] += int(r.get("duration_ms", 0))
            if int(r.get("exit_code", 0)) != 0:
                by_day[day]["errors"] += 1
                by_persona[persona]["errors"] += 1
            total_calls += 1
        elif kind == "llm_persona_skipped":
            by_day[day]["skipped"] += 1
    out_days = []
    for day in sorted(by_day):
        s = by_day[day]
        avg_ms = (s["duration_ms"] // s["calls"]) if s["calls"] else 0
        out_days.append({"date": day, "calls": s["calls"], "skipped": s["skipped"],
                          "errors": s["errors"], "avg_ms": avg_ms})
    out_personas = []
    for persona in sorted(by_persona, key=lambda p: -by_persona[p]["calls"]):
        s = by_persona[persona]
        avg_ms = (s["duration_ms"] // s["calls"]) if s["calls"] else 0
        out_personas.append({"persona": persona, "calls": s["calls"], "errors": s["errors"],
                              "avg_ms": avg_ms})
    return {"by_day": out_days, "by_persona": out_personas, "total_calls": total_calls,
            "exists": True, "today": cutoff_date}


def overview() -> dict:
    """Top-level numbers for the page header."""
    students = list_students()
    n_students = len(students)
    n_open = sum(s.get("open_predictions", 0) for s in students)
    n_resolved = sum(s.get("total_resolved", 0) for s in students)
    n_correct = sum(s.get("total_correct", 0) for s in students)
    classroom_hit = (n_correct / n_resolved) if n_resolved else None
    # Brier across all resolved (approximate, uses each student's lifetime
    # Brier weighted by their resolved count)
    weighted_brier = 0.0
    brier_n = 0
    for s in students:
        b = s.get("lifetime_brier")
        r = s.get("total_resolved") or 0
        if b is not None and r > 0:
            weighted_brier += float(b) * r
            brier_n += r
    overall_brier = (weighted_brier / brier_n) if brier_n else None
    # Today's predictions
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    today_path = DAILY_DIR / today / "predictions.jsonl"
    today_count = 0
    if today_path.exists():
        for _ in _read_jsonl(today_path):
            today_count += 1
    # Recent days that have predictions
    days = []
    if DAILY_DIR.exists():
        for d in sorted(DAILY_DIR.iterdir(), reverse=True):
            if not d.is_dir():
                continue
            pred_path = d / "predictions.jsonl"
            n = 0
            if pred_path.exists():
                n = len(_read_jsonl(pred_path))
            if n:
                days.append({"date": d.name, "n": n})
            if len(days) >= 14:
                break
    return {
        "classroom_root": str(CLASSROOM_ROOT),
        "n_students": n_students,
        "n_open_predictions": n_open,
        "n_resolved": n_resolved,
        "n_correct": n_correct,
        "classroom_hit_rate": classroom_hit,
        "overall_brier": overall_brier,
        "today_date": today,
        "today_predictions": today_count,
        "recent_days": days,
    }


def projections() -> dict:
    """Load the per-student projection bundle written by project_scores.py.
    Filter to live roster + sort by trajectory delta."""
    if not PROJECTIONS_PATH.exists():
        return {"exists": False, "students": [], "classroom": {}, "generated_at": None}
    try:
        data = json.loads(PROJECTIONS_PATH.read_text())
    except json.JSONDecodeError:
        return {"exists": False, "students": [], "classroom": {}, "generated_at": None}
    live = _roster_names()
    rows = [r for r in data.get("students", []) if not live or r.get("name") in live]
    # Sort: smallest projected Brier first (best forecasters)
    rows.sort(key=lambda r: (r.get("projected_brier") is None, r.get("projected_brier") or 1.0))
    return {
        "exists": True,
        "generated_at": data.get("generated_at"),
        "classroom": data.get("classroom", {}),
        "students": rows,
    }


def learning_lab() -> dict:
    """Step-back synthesis for the Learning Lab panel: who's improving, who's
    plateauing, who should be retired."""
    p = projections()
    if not p["exists"]:
        return {"exists": False}
    students = p["students"]
    # Improving = positive trajectory_delta (observed worse than projected)
    improving = [s for s in students if (s.get("trajectory_delta") or 0) > 0.02]
    improving.sort(key=lambda s: -(s.get("trajectory_delta") or 0))
    # Deteriorating = negative trajectory (projected worse than observed)
    deteriorating = [s for s in students if (s.get("trajectory_delta") or 0) < -0.02]
    deteriorating.sort(key=lambda s: (s.get("trajectory_delta") or 0))
    # Most-learned = highest learning_gain (vs naive 70%)
    most_learned = [s for s in students if (s.get("learning_gain") or 0) > 0]
    most_learned.sort(key=lambda s: -(s.get("learning_gain") or 0))
    # Candidates for full-student retirement: all their active setups are bad
    # i.e., zero setups firing recently AND many retired setups.
    full_retire = [s for s in students
                   if s.get("n_setups_retired", 0) >= 2
                   and s.get("n_setups_active_recent", 0) == 0]
    return {
        "exists": True,
        "generated_at": p["generated_at"],
        "classroom": p["classroom"],
        "improving": improving[:10],
        "deteriorating": deteriorating[:10],
        "most_learned": most_learned[:10],
        "retirement_candidates": full_retire[:20],
    }


def latest_predictions(limit: int = 50) -> list[dict]:
    """Most recent predictions across all students."""
    out: list[dict] = []
    if not DAILY_DIR.exists():
        return out
    # Walk recent days until we have enough
    for d in sorted(DAILY_DIR.iterdir(), reverse=True):
        if not d.is_dir():
            continue
        pred_path = d / "predictions.jsonl"
        if not pred_path.exists():
            continue
        rows = _read_jsonl(pred_path)
        out.extend(rows)
        if len(out) >= limit * 2:
            break
    out.sort(key=lambda p: p.get("created_at", ""), reverse=True)
    return out[:limit]
