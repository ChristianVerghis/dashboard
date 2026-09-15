"""Short-term classroom controller — manages live sessions in-process.

A single global LiveSession runs in the dashboard's asyncio event loop. Start
and stop it via HTTP endpoints. The websocket bridge in main.py subscribes
client queues to the active session for realtime updates.

The classroom code is imported via sys.path manipulation so we stay
single-process (no IPC, no subprocess management).
"""
from __future__ import annotations

import asyncio
import importlib
import json
import sys
from pathlib import Path
from typing import Any

from . import projects as proj

CLASSROOM_ROOT = proj.PROJECTS_ROOT / "classroom"
SHORTTERM_ROOT = CLASSROOM_ROOT / "shortterm"


def _ensure_path() -> None:
    """Add shortterm dirs to sys.path so we can import its modules."""
    p = str(SHORTTERM_ROOT)
    if p not in sys.path:
        sys.path.insert(0, p)
    s = str(SHORTTERM_ROOT / "scripts")
    if s not in sys.path:
        sys.path.insert(0, s)


# Lazy globals — we import the Session class only when start_session is called
# so the dashboard can boot without alpaca-py installed.
_session_instance: Any = None
_session_task: asyncio.Task | None = None


def is_ready() -> dict:
    """Check whether the short-term cohort is initialized."""
    students_yml = SHORTTERM_ROOT / "config" / "students.yml"
    students_dir = SHORTTERM_ROOT / "students"
    n_students = 0
    if students_dir.exists():
        n_students = sum(1 for p in students_dir.iterdir() if p.is_dir())
    return {
        "cohort_path": str(SHORTTERM_ROOT),
        "students_yml_exists": students_yml.exists(),
        "n_students": n_students,
        "session_running": _session_task is not None and not _session_task.done(),
    }


def session_status() -> dict:
    """Snapshot of the active session, or null."""
    if _session_instance is None:
        return {"running": False, "last_error": _last_session_error}
    s = _session_instance
    return {
        "running": _session_task is not None and not _session_task.done(),
        "session_id": s.session_id,
        "symbols": s.symbols,
        "n_students": len(s.students),
        "bar_count": s.bar_count,
        "prediction_count": s.prediction_count,
        "resolution_count": s.resolution_count,
        "n_open_predictions": len(s.open_predictions),
        "last_error": _last_session_error,
    }


async def start_session(
    symbols: list[str] | None = None,
    provider: str = "mock",
    scenario: str = "random_walk",
) -> dict:
    """Spawn the LiveSession as an asyncio task. Idempotent — if already
    running, returns the current status.

    scenario: only used when provider='mock'. Picks the synthetic regime
    (random_walk, trending_up, volatile_revert, breakout_event, choppy).
    """
    global _session_instance, _session_task
    if _session_task is not None and not _session_task.done():
        return {"ok": True, "already_running": True, **session_status()}
    _ensure_path()
    # PROVIDER env governs which data source the classroom uses
    import os
    os.environ["PROVIDER"] = provider
    os.environ["MOCK_SCENARIO"] = scenario
    # Import here — first-time imports trigger sys.path setup above
    live_session_mod = importlib.import_module("live_session")
    importlib.reload(live_session_mod)
    Session = live_session_mod.Session
    if symbols is None:
        import yaml
        cfg = yaml.safe_load((SHORTTERM_ROOT / "config" / "techniques.yml").read_text())
        symbols = cfg["universe"]["symbols"]
    session = Session(symbols=symbols)
    session.load_students()
    # Transfer websocket subscribers from the prior (now-stopped) session
    # so live UI clients don't go silent across stop+start cycles. Without
    # this, the WS queue was registered on the old Session.subscribers
    # list, orphaned when _session_instance gets replaced.
    if _session_instance is not None:
        session.subscribers = list(_session_instance.subscribers)
    _session_instance = session
    _session_task = asyncio.create_task(_guarded_run(session))
    return {"ok": True, "already_running": False, **session_status()}


# Last session crash, surfaced via session_status() so failures aren't
# silent ("Task exception was never retrieved" killed sessions invisibly
# and per-bar errors once spammed gigabytes of launchd.out.log).
_last_session_error: dict | None = None


async def _guarded_run(session) -> None:
    global _last_session_error
    try:
        await session.run()
        _last_session_error = None
    except asyncio.CancelledError:
        raise
    except Exception as e:
        from datetime import datetime, timezone
        _last_session_error = {
            "error": f"{type(e).__name__}: {e}"[:300],
            "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }


def stop_session() -> dict:
    """Cancel the running session task. Idempotent."""
    global _session_task
    if _session_task is None or _session_task.done():
        return {"ok": True, "was_running": False}
    _session_task.cancel()
    return {"ok": True, "was_running": True}


def subscribe(queue: asyncio.Queue) -> None:
    """Register a client queue for live event broadcast."""
    if _session_instance is not None:
        _session_instance.subscribers.append(queue)


def unsubscribe(queue: asyncio.Queue) -> None:
    if _session_instance is not None and queue in _session_instance.subscribers:
        _session_instance.subscribers.remove(queue)


def student_detail(name: str) -> dict | None:
    """Detailed view of one student: score, last 20 predictions, open positions."""
    if not name or ".." in name or "/" in name:
        return None
    student_dir = SHORTTERM_ROOT / "students" / name
    if not student_dir.exists():
        return None
    score_path = student_dir / "score.json"
    log_path = student_dir / "log.jsonl"
    score = {}
    if score_path.exists():
        try:
            score = json.loads(score_path.read_text())
        except json.JSONDecodeError:
            pass
    predictions: list[dict] = []
    if log_path.exists():
        try:
            lines = log_path.read_text(encoding="utf-8").splitlines()
            for line in lines[-20:]:
                line = line.strip()
                if not line:
                    continue
                try:
                    predictions.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
        except OSError:
            pass
    open_positions = []
    if _session_instance is not None:
        open_positions = [
            e["pred"] for e in _session_instance.open_predictions
            if e["pred"].get("student") == name
        ]
    return {
        "name": name,
        "score": score,
        "recent_predictions": predictions,
        "open_positions": open_positions,
    }


def alpaca_check() -> dict:
    """Report whether Alpaca is ready to use: keys present + package installed."""
    import os
    key = os.environ.get("ALPACA_API_KEY")
    secret = os.environ.get("ALPACA_SECRET_KEY")
    if not key or not secret:
        env_file = CLASSROOM_ROOT / ".env"
        if env_file.exists():
            try:
                for line in env_file.read_text().splitlines():
                    line = line.strip()
                    if line.startswith("ALPACA_API_KEY=") and not key:
                        key = line.split("=", 1)[1].strip().strip('"').strip("'")
                    elif line.startswith("ALPACA_SECRET_KEY=") and not secret:
                        secret = line.split("=", 1)[1].strip().strip('"').strip("'")
            except OSError:
                pass
    try:
        importlib.import_module("alpaca")
        package_installed = True
    except ImportError:
        package_installed = False
    return {
        "keys_present": bool(key and secret),
        "package_installed": package_installed,
        "ready": bool(key and secret and package_installed),
        "next_step": (
            "ready" if (key and secret and package_installed)
            else "install alpaca-py" if (key and secret)
            else "drop ALPACA_API_KEY + ALPACA_SECRET_KEY in classroom/.env"
        ),
    }


def technique_leaderboard() -> dict:
    """Aggregate per-technique stats across the current cohort's in-memory state.

    Same data the grid endpoint exposes, rolled up by technique so the UI can
    answer "which technique is winning this session?" at a glance.
    """
    if _session_instance is None:
        return {"techniques": []}
    # Precompute open-position counts by student in one pass — same
    # O(N²) trap as latest_grid_state.
    open_by_student: dict[str, int] = {}
    for e in _session_instance.open_predictions:
        name = e["pred"].get("student")
        if name:
            open_by_student[name] = open_by_student.get(name, 0) + 1
    by_tech: dict[str, dict] = {}
    for s in _session_instance.students:
        sc = s.score
        t = s.technique
        rec = by_tech.setdefault(t, {
            "technique": t,
            "students": 0,
            "total_predictions": 0,
            "total_resolved": 0,
            "total_correct": 0,
            "pnl_sum": 0.0,
            "open_positions": 0,
        })
        rec["students"] += 1
        rec["total_predictions"] += sc.get("total_predictions", 0)
        rec["total_resolved"] += sc.get("total_resolved", 0)
        rec["total_correct"] += sc.get("total_correct", 0)
        rec["pnl_sum"] += sc.get("total_pnl_pct", 0.0)
        rec["open_positions"] += open_by_student.get(s.name, 0)
    for rec in by_tech.values():
        rec["hit_rate"] = (
            round(rec["total_correct"] / rec["total_resolved"], 4)
            if rec["total_resolved"] else None
        )
        rec["avg_pnl_pct"] = (
            round(rec["pnl_sum"] / rec["students"], 4)
            if rec["students"] else 0.0
        )
    return {"techniques": sorted(by_tech.values(), key=lambda r: -r["pnl_sum"])}


def session_detail(session_id: str) -> dict | None:
    """Read predictions + resolutions + bar count for a past session by id.

    Aggregates per-technique stats from disk. Safe for path traversal — only
    accepts session IDs matching the orchestrator's timestamp pattern.
    """
    if not session_id or "/" in session_id or ".." in session_id:
        return None
    sdir = SHORTTERM_ROOT / "sessions" / session_id
    if not sdir.is_dir():
        return None
    bars = sdir / "bars.jsonl"
    preds = sdir / "predictions.jsonl"
    resos = sdir / "resolutions.jsonl"

    def _read_jsonl(p):
        if not p.exists():
            return []
        out = []
        with open(p) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    out.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
        return out

    pred_records = _read_jsonl(preds)
    reso_records = _read_jsonl(resos)
    pred_by_id = {p["id"]: p for p in pred_records}

    by_tech: dict[str, dict] = {}
    for r in reso_records:
        pred = pred_by_id.get(r.get("id"))
        if not pred:
            continue
        t = pred.get("technique", "unknown")
        rec = by_tech.setdefault(t, {"technique": t, "resolved": 0, "correct": 0, "pnl_sum": 0.0})
        rec["resolved"] += 1
        if r.get("correct"):
            rec["correct"] += 1
        rec["pnl_sum"] += r.get("pnl_pct", 0.0)
    for rec in by_tech.values():
        rec["hit_rate"] = round(rec["correct"] / rec["resolved"], 4) if rec["resolved"] else None
        rec["avg_pnl_pct"] = round(rec["pnl_sum"] / rec["resolved"], 4) if rec["resolved"] else 0.0
        rec["pnl_sum"] = round(rec["pnl_sum"], 4)

    bar_count = 0
    if bars.exists():
        try:
            bar_count = sum(1 for _ in open(bars))
        except OSError:
            pass

    return {
        "session_id": session_id,
        "bar_count": bar_count,
        "prediction_count": len(pred_records),
        "resolution_count": len(reso_records),
        "techniques": sorted(by_tech.values(), key=lambda r: -r["pnl_sum"]),
    }


def per_symbol_regimes() -> dict:
    """Current regime classification per symbol in the active session.

    Reads each symbol's BarWindow.regime() so users can see why the gating
    logic is firing/suppressing techniques in real time.
    """
    if _session_instance is None:
        return {"regimes": []}
    out = []
    for symbol, w in _session_instance.windows.items():
        # regime() needs 32+ bars (window+2=30+2) to classify. Before that
        # it returns "unknown" — which the UI was rendering as a default
        # gray cell that looked like an error state. Label as "warmup"
        # explicitly so the UI's yellow warmup styling applies.
        if len(w) < 32:
            out.append({"symbol": symbol, "label": "warmup", "bars": len(w)})
            continue
        r = w.regime(window=30)
        out.append({
            "symbol": symbol,
            "label": r["label"],
            "autocorr": r["autocorr"],
            "drift_pct": r["drift_pct"],
            "vol_pct": r["vol_pct"],
            "bars": len(w),
        })
    return {"regimes": out}


def top_bottom_students(n: int = 5) -> dict:
    """Top-N and bottom-N students by paper P&L across the current session.

    Reads in-memory state from active session — no disk reads.
    """
    if _session_instance is None:
        return {"top": [], "bottom": []}
    scored = []
    for s in _session_instance.students:
        sc = s.score
        if sc.get("total_resolved", 0) == 0:
            continue
        scored.append({
            "name": s.name,
            "technique": s.technique,
            "pnl_pct": sc.get("total_pnl_pct", 0.0),
            "resolved": sc.get("total_resolved", 0),
            "correct": sc.get("total_correct", 0),
            "hit_rate": sc.get("hit_rate"),
        })
    scored.sort(key=lambda s: -s["pnl_pct"])
    return {"top": scored[:n], "bottom": list(reversed(scored[-n:]))}


# Cache of per-session counts keyed by session_id. Each entry is
# (max(mtime of bars/preds/resos), counts_dict). Invalidates only when
# one of the session's files changes — finished sessions never re-read.
_session_counts_cache: dict[str, tuple[float, dict]] = {}


def _count_lines(p: Path) -> int:
    if not p.exists():
        return 0
    try:
        with open(p, "rb") as f:
            return sum(1 for _ in f)
    except OSError:
        return 0


def list_sessions(limit: int = 20) -> dict:
    """List past sessions from sessions/ directory, most recent first.

    Returns: [{session_id, started_at, bar_count, prediction_count, resolution_count}]
    """
    sessions_dir = SHORTTERM_ROOT / "sessions"
    if not sessions_dir.exists():
        return {"sessions": []}
    out: list[dict] = []
    for d in sorted(sessions_dir.iterdir(), reverse=True):
        if not d.is_dir():
            continue
        bars = d / "bars.jsonl"
        preds = d / "predictions.jsonl"
        resos = d / "resolutions.jsonl"
        # mtime-keyed cache. Finished sessions hit cache after first read;
        # active session's files update mtime and we recompute.
        try:
            max_mtime = max(
                (p.stat().st_mtime for p in (bars, preds, resos) if p.exists()),
                default=0.0,
            )
        except OSError:
            max_mtime = 0.0
        cached = _session_counts_cache.get(d.name)
        if cached and cached[0] == max_mtime:
            counts = cached[1]
        else:
            counts = {
                "bar_count": _count_lines(bars),
                "prediction_count": _count_lines(preds),
                "resolution_count": _count_lines(resos),
            }
            _session_counts_cache[d.name] = (max_mtime, counts)
        out.append({"session_id": d.name, **counts})
        if len(out) >= limit:
            break
    return {"sessions": out}


def latest_grid_state() -> dict:
    """Snapshot of all students' performance for grid coloring."""
    if _session_instance is None:
        return {"students": []}
    # Precompute open-position counts in one pass — was O(students × opens)
    # which at 500 students with hundreds of opens hit ~250k ops per call.
    open_by_student: dict[str, int] = {}
    for e in _session_instance.open_predictions:
        name = e["pred"].get("student")
        if name:
            open_by_student[name] = open_by_student.get(name, 0) + 1
    students = []
    for s in _session_instance.students:
        sc = s.score
        pnl = sc.get("total_pnl_pct", 0.0)
        students.append({
            "name": s.name,
            "technique": s.technique,
            "pnl_pct": pnl,
            "current_capital": sc.get("current_capital", 100000.0),
            "total_resolved": sc.get("total_resolved", 0),
            "total_correct": sc.get("total_correct", 0),
            "hit_rate": sc.get("hit_rate"),
            "open_positions": open_by_student.get(s.name, 0),
        })
    return {"students": students}
