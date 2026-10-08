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
    meta = getattr(s, "meta", {}) or {}
    return {
        "running": _session_task is not None and not _session_task.done(),
        "session_id": s.session_id,
        "symbols": s.symbols,
        "n_students": len(s.students),
        "n_strategies": meta.get("n_strategies"),
        "bar_count": s.bar_count,
        "prediction_count": s.prediction_count,
        "resolution_count": s.resolution_count,
        "n_open_predictions": len(s.open_predictions),
        "provider": meta.get("provider") or getattr(s, "provider_name", None),
        "is_synthetic": meta.get("is_synthetic"),
        "scenario": meta.get("scenario"),
        "seed": meta.get("seed"),
        "universe": meta.get("universe"),
        "slippage_bps": meta.get("slippage_bps"),
        "persist_lifetime": meta.get("persist_lifetime"),
        "replay_start": meta.get("replay_start"),
        "replay_end": meta.get("replay_end"),
        "first_bar_ts": getattr(s, "first_bar_ts", None),
        "last_bar_ts": getattr(s, "last_bar_ts", None),
        "last_error": _last_session_error,
    }


async def start_session(
    symbols: list[str] | None = None,
    provider: str = "mock",
    scenario: str = "random_walk",
    universe: str | None = None,
    slippage_bps: float = 0.0,
    replay_speed: float | None = None,
    seed: int | None = None,
) -> dict:
    """Spawn the LiveSession as an asyncio task. Idempotent — if already
    running, returns the current status.

    scenario: only used when provider='mock'. Picks the synthetic regime
    (random_walk, trending_up, volatile_revert, breakout_event, choppy).
    seed: pins the mock price path; default is a fresh path per session.
    slippage_bps: stop-fill slippage applied by the paper book.
    replay_speed: yfinance replay compression (60 = a minute per second).
    """
    global _session_instance, _session_task
    if _session_task is not None and not _session_task.done():
        return {"ok": True, "already_running": True, **session_status()}
    _ensure_path()
    # PROVIDER env governs which data source the classroom uses
    import os
    os.environ["PROVIDER"] = provider
    os.environ["MOCK_SCENARIO"] = scenario
    os.environ["STOP_SLIPPAGE_BPS"] = str(max(0.0, float(slippage_bps or 0)))
    if seed is not None:
        os.environ["MOCK_SEED"] = str(int(seed))
    else:
        os.environ.pop("MOCK_SEED", None)
    if replay_speed is not None:
        os.environ["REPLAY_SPEED"] = str(replay_speed)
    else:
        os.environ.pop("REPLAY_SPEED", None)
    # Import here — first-time imports trigger sys.path setup above
    live_session_mod = importlib.import_module("live_session")
    importlib.reload(live_session_mod)
    Session = live_session_mod.Session
    if symbols is None:
        import yaml
        cfg = yaml.safe_load((SHORTTERM_ROOT / "config" / "techniques.yml").read_text())
        symbols = cfg["universe"]["symbols"]
    session = Session(symbols=symbols, universe=universe)
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
    if _session_instance is not None and hasattr(_session_instance, "write_meta"):
        from datetime import datetime, timezone
        try:
            _session_instance.write_meta(
                None, ended_at=datetime.now(timezone.utc).isoformat(timespec="seconds"))
        except Exception:
            pass
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
    session_score = None
    session_recent: list[dict] = []
    if _session_instance is not None:
        open_positions = [
            e["pred"] for e in _session_instance.open_predictions
            if e["pred"].get("student") == name
        ]
        stu = _session_instance.students_by_name.get(name)
        if stu is not None:
            session_score = stu.score
            recent = getattr(_session_instance, "recent_by_student", {}).get(name)
            session_recent = list(recent) if recent else []
    return {
        "name": name,
        # The session score is what the grid colours by; lifetime is only
        # written by sessions that persist (live Alpaca by default).
        "score": session_score or score,
        "session_score": session_score,
        "lifetime_score": score or None,
        "recent_predictions": session_recent or predictions,
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
        out.append({"session_id": d.name, **counts, **_session_label(d)})
        if len(out) >= limit:
            break
    return {"sessions": out}


_label_cache: dict[str, tuple[float, dict]] = {}


def _session_label(d: Path) -> dict:
    """What kind of session this was — from meta.json, or inferred from the
    first bar for sessions recorded before meta.json existed."""
    mp = d / "meta.json"
    try:
        mt = mp.stat().st_mtime if mp.exists() else (d / "bars.jsonl").stat().st_mtime
    except OSError:
        mt = 0.0
    hit = _label_cache.get(d.name)
    if hit and hit[0] == mt:
        return hit[1]
    meta: dict = {}
    if mp.exists():
        try:
            meta = json.loads(mp.read_text())
        except (OSError, json.JSONDecodeError):
            meta = {}
    if "is_synthetic" not in meta:
        try:
            with open(d / "bars.jsonl") as f:
                first = json.loads(f.readline() or "{}")
            meta["is_synthetic"] = bool(first.get("is_synthetic"))
            meta["provider"] = "mock" if meta["is_synthetic"] else None
            meta.setdefault("symbols", [first.get("symbol")] if first.get("symbol") else [])
        except (OSError, json.JSONDecodeError):
            pass
    label = {
        "provider": meta.get("provider"),
        "is_synthetic": meta.get("is_synthetic"),
        "scenario": meta.get("scenario"),
        "universe": meta.get("universe"),
        "symbols": meta.get("symbols"),
        "replay_start": meta.get("replay_start"),
        "replay_end": meta.get("replay_end"),
        "started_at": meta.get("started_at"),
    }
    _label_cache[d.name] = (mt, label)
    return label


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


# ---------------------------------------------------------------- insights
#
# "Which techniques are in play, which are working, which bets paid and why"
# — computed by classroom/shortterm/scripts/session_analytics.py so the logic
# lives (and is tested) next to the engine. The dashboard only adds caching
# and the live roster.

_insights_cache: dict[str, tuple[tuple, float, dict]] = {}
_INSIGHTS_TTL = 2.0


def _analytics():
    _ensure_path()
    return importlib.import_module("session_analytics")


def _live_roster(session) -> dict[str, dict]:
    """{technique: {students, strategies, suspended}} for the running cohort."""
    roster: dict[str, dict] = {}
    strategies: dict[str, set] = {}
    for stu in session.students:
        r = roster.setdefault(stu.technique, {"students": 0, "strategies": 0, "suspended": 0})
        r["students"] += 1
        strategies.setdefault(stu.technique, set()).add(json.dumps(stu.params, sort_keys=True))
        try:
            if stu.position_size_scale() == 0.0:
                r["suspended"] += 1
        except Exception:
            pass
    for t, ss in strategies.items():
        roster[t]["strategies"] = len(ss)
    return roster


def live_insights(top_n: int = 12) -> dict:
    """Insights for the running (or last-run) in-process session."""
    s = _session_instance
    if s is None:
        return {"running": False, "session": None}
    key = (s.session_id, s.prediction_count, s.resolution_count, top_n)
    import time as _time
    now = _time.monotonic()
    hit = _insights_cache.get("live")
    if hit and hit[0] == key and now - hit[1] < 30:
        return hit[2]
    if hit and hit[0][0] == s.session_id and now - hit[1] < _INSIGHTS_TTL:
        return hit[2]
    sa = _analytics()
    meta = dict(getattr(s, "meta", {}) or {})
    meta.update({
        "session_id": s.session_id,
        "symbols": s.symbols,
        "first_bar_ts": s.first_bar_ts,
        "last_bar_ts": s.last_bar_ts,
        "bar_count": s.bar_count,
        "running": _session_task is not None and not _session_task.done(),
    })
    rep = sa.insights_from_bets(meta, s.book.bets(), n_predictions=s.book.n_predictions,
                                roster=_live_roster(s), top_n=top_n)
    rep["running"] = meta["running"]
    _insights_cache["live"] = (key, now, rep)
    return rep


# Past sessions parsed into a BetBook, kept for the two most recently viewed
# sessions: a replay is ~100k student predictions, and every bet card on the
# page asks for its own price path.
_book_cache: dict[str, tuple[float, dict]] = {}


def _session_mtime(sdir: Path) -> float:
    try:
        return max((p.stat().st_mtime for p in sdir.iterdir() if p.is_file()), default=0.0)
    except OSError:
        return 0.0


def _past_book(session_id: str) -> dict | None:
    """{meta, bets, by_id, n_predictions, cohort} for a session on disk."""
    if not session_id or "/" in session_id or ".." in session_id:
        return None
    sdir = SHORTTERM_ROOT / "sessions" / session_id
    if not sdir.is_dir():
        return None
    mt = _session_mtime(sdir)
    hit = _book_cache.get(session_id)
    if hit and hit[0] == mt:
        return hit[1]
    loaded = _analytics().load_session_book(session_id)
    if loaded is None:
        return None
    meta, book, cohort = loaded
    bets = book.bets()
    entry = {"meta": meta, "bets": bets, "by_id": {b["bet_id"]: b for b in bets},
             "n_predictions": book.n_predictions, "cohort": cohort}
    _book_cache[session_id] = (mt, entry)
    while len(_book_cache) > 2:
        _book_cache.pop(next(iter(_book_cache)))
    return entry


def session_insights(session_id: str, top_n: int = 12) -> dict | None:
    """Insights for a past session on disk (cached until its files change)."""
    if not session_id or "/" in session_id or ".." in session_id:
        return None
    if _session_instance is not None and session_id == _session_instance.session_id:
        return live_insights(top_n=top_n)
    sdir = SHORTTERM_ROOT / "sessions" / session_id
    if not sdir.is_dir():
        return None
    mt = _session_mtime(sdir)
    ck = f"past:{session_id}:{top_n}"
    hit = _insights_cache.get(ck)
    if hit and hit[0] == (mt,):
        return hit[2]
    entry = _past_book(session_id)
    if entry is None:
        return None
    rep = _analytics().insights_from_book(entry["meta"], entry["bets"], entry["n_predictions"],
                                          entry["cohort"], top_n=top_n)
    rep["running"] = False
    _insights_cache[ck] = ((mt,), 0.0, rep)
    if len(_insights_cache) > 16:
        _insights_cache.pop(next(k for k in _insights_cache if k != "live"))
    return rep


_bars_cache: dict[tuple, tuple[float, list]] = {}


def bet_detail(session_id: str, bet: str) -> dict | None:
    """One bet with its explanation and the price path around it."""
    if not bet or not bet.isalnum():
        return None
    sa = _analytics()
    s = _session_instance
    if s is not None and (not session_id or session_id == s.session_id):
        b = s.book.get(bet)
        if b is None:
            return None
        rep = live_insights()
        bars = list(s.bar_history.get(b["symbol"], []))
        session_id = s.session_id
    else:
        entry = _past_book(session_id)
        if entry is None:
            return None
        b = entry["by_id"].get(bet)
        if b is None:
            return None
        rep = session_insights(session_id) or {}
        sdir = SHORTTERM_ROOT / "sessions" / session_id
        try:
            mt = (sdir / "bars.jsonl").stat().st_mtime
        except OSError:
            mt = 0.0
        ck = (session_id, b["symbol"])
        hit = _bars_cache.get(ck)
        if hit and hit[0] == mt:
            bars = hit[1]
        else:
            bars = sa.load_bars(session_id, b["symbol"])
            _bars_cache[ck] = (mt, bars)
            if len(_bars_cache) > 24:
                _bars_cache.pop(next(iter(_bars_cache)))
    tech = next((t for t in rep.get("techniques", []) if t["technique"] == b["technique"]), None)
    return {
        "session_id": session_id,
        "bet": {**b, "why": sa.explain(b, tech)},
        "technique": tech,
        "path": sa.bet_path(bars, b),
    }


# ---------------------------------------------------------------- weekly re-test

def retest_view() -> dict:
    """Track record from classroom/shortterm/retest/summary.json (written by
    weekly_retest.py), plus which weekly sessions still have their payload on
    disk so the page can link a week to its session view."""
    path = SHORTTERM_ROOT / "retest" / "summary.json"
    if not path.exists():
        return {"missing": True}
    try:
        data = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return {"missing": True}
    sessions = SHORTTERM_ROOT / "sessions"
    available = set()
    for pair in data.get("pairs", []):
        for w in pair.get("weeks", []):
            sid = w.get("session_id")
            if sid and sid not in available and (sessions / sid / "predictions.jsonl").exists():
                available.add(sid)
    data["sessions_available"] = sorted(available)
    log_dir = CLASSROOM_ROOT / "data" / "cron"
    logs = sorted(log_dir.glob("weekly-retest-*.log")) if log_dir.exists() else []
    data["last_log"] = logs[-1].name if logs else None
    return data
