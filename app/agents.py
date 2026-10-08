"""Live Claude Code sessions on this machine.

Read straight from Claude Code's own state files, the ones `claude agents
--json` reads, so the cockpit can poll every few seconds without starting a
node process each time:

  ~/.claude/sessions/<pid>.json     one per running `claude` process: status
                                    busy | idle, name, cwd, entrypoint
  ~/.claude/jobs/<id>/state.json    background sessions (`claude --bg`): state,
                                    `needs` (the question it is waiting on),
                                    `detail` (what it did)

Titles and last activity come from the transcripts (app/claude_sessions.py).
Read-only, except attach, which opens Terminal.app on `claude attach <id>`:
the same command you would type yourself.
"""
from __future__ import annotations

import json
import os
import re
import shlex
import shutil
import subprocess
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, HTTPException

from . import projects as proj_mod

router = APIRouter()

CLAUDE_HOME = Path(os.environ.get("CLAUDE_HOME", "~/.claude")).expanduser()
_JOB_ID = re.compile(r"^[0-9a-f]{6,16}$")
_ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07")
_TTL = 2.0
# An interactive session that went idle this recently has just finished a
# turn and is waiting for you; after that it is simply open.
YOUR_TURN_S = 30 * 60
_cache: tuple[float, dict] | None = None

# Background job states, as Claude Code writes them, folded into the few the
# cockpit acts on. Unknown values pass through unchanged.
_BG_STATE = {
    "blocked": "blocked", "waiting": "blocked", "needs_input": "blocked", "needs-input": "blocked",
    "running": "working", "working": "working", "busy": "working", "active": "working",
    "idle": "idle",
    "done": "done", "completed": "done", "complete": "done", "finished": "done", "exited": "done",
    "failed": "failed", "error": "failed", "crashed": "failed",
    "stopped": "stopped", "killed": "stopped",
}
_RANK = {"blocked": 0, "failed": 1, "your_turn": 2, "working": 3, "idle": 4, "headless": 5,
         "done": 6, "stopped": 7}


def claude_exe() -> str:
    return shutil.which("claude") or os.path.expanduser("~/.local/bin/claude")


def _load(path: Path) -> dict | None:
    try:
        d = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return d if isinstance(d, dict) else None


def _iso(value) -> str | None:
    """Epoch milliseconds or an ISO string -> ISO (UTC)."""
    if value is None:
        return None
    try:
        if isinstance(value, (int, float)):
            dt = datetime.fromtimestamp(float(value) / 1000, tz=timezone.utc)
        else:
            dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc).isoformat(timespec="seconds")
    except (ValueError, OSError, OverflowError):
        return None


def _age_s(iso: str | None) -> float:
    if not iso:
        return float("inf")
    try:
        return time.time() - datetime.fromisoformat(iso).timestamp()
    except ValueError:
        return float("inf")


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def _project_of(cwd: str | None) -> str | None:
    if not cwd:
        return None
    try:
        rel = Path(cwd).resolve().relative_to(proj_mod.PROJECTS_ROOT.resolve())
    except (ValueError, OSError):
        return None
    return rel.parts[0] if rel.parts else None


def _transcripts() -> dict[str, dict]:
    try:
        from . import claude_sessions as cs
        return {s["id"]: s for s in cs.all_sessions()}
    except Exception:
        return {}


def _scan() -> dict:
    rows: dict[str, dict] = {}  # keyed by session id, so a background job's process merges into its job

    for f in (CLAUDE_HOME / "sessions").glob("*.json"):
        d = _load(f)
        pid = d.get("pid") if d else None
        if not isinstance(pid, int) or not _alive(pid):
            continue
        headless = str(d.get("entrypoint") or "").startswith("sdk")
        status = str(d.get("status") or "")
        sid = d.get("sessionId") or f"pid-{pid}"
        rows[sid] = {
            "id": str(pid), "pid": pid,
            "kind": "headless" if headless else "interactive",
            "session_id": d.get("sessionId"), "name": d.get("name"),
            "cwd": d.get("cwd"), "project": _project_of(d.get("cwd")),
            # "shell": running a ! command for you, which is still work in progress
            "state": {"busy": "working", "shell": "working", "idle": "idle"}.get(status, status or "unknown"),
            "since": _iso(d.get("statusUpdatedAt") or d.get("updatedAt") or d.get("startedAt")),
            "started": _iso(d.get("startedAt")),
            "needs": None, "detail": None, "can_attach": False,
        }

    for f in (CLAUDE_HOME / "jobs").glob("*/state.json"):
        d = _load(f)
        if not d:
            continue
        job = f.parent.name
        raw = str(d.get("state") or "")
        state = _BG_STATE.get(raw, raw or "unknown")
        updated = _iso(d.get("updatedAt"))
        if state in ("done", "stopped") and _age_s(updated) > 86400:
            continue  # finished more than a day ago: history, not cockpit
        sid = d.get("sessionId") or f"job-{job}"
        row = rows.get(sid, {})
        cwd = d.get("cwd") or row.get("cwd")
        row.update({
            "id": job, "pid": row.get("pid"), "kind": "background",
            "session_id": d.get("sessionId") or row.get("session_id"),
            "name": d.get("name") or row.get("name"),
            "cwd": cwd, "project": _project_of(cwd),
            "state": state, "since": updated or row.get("since"),
            "started": _iso(d.get("createdAt")) or row.get("started"),
            "needs": d.get("needs") or None, "detail": d.get("detail") or None,
            "tokens": d.get("tokens"),
            "can_attach": bool(_JOB_ID.fullmatch(job)),
        })
        rows[sid] = row

    transcripts = _transcripts()
    for r in rows.values():
        t = transcripts.get(r.get("session_id") or "")
        if t:
            r["title"] = t.get("title")
            r["last_activity"] = t.get("ended")
            r["output_tokens"] = t.get("output_tokens")
            r["project"] = r.get("project") or t.get("project")
        r["your_turn"] = r["kind"] == "interactive" and r["state"] == "idle" and _age_s(r.get("since")) < YOUR_TURN_S

    def rank(a: dict) -> tuple:
        key = "your_turn" if a["your_turn"] else ("headless" if a["kind"] == "headless" else a["state"])
        age = _age_s(a.get("since"))
        # the longest-blocked agent first; everything else most recent first
        return (_RANK.get(key, 5), -age if key == "blocked" else age)

    agents = sorted(rows.values(), key=rank)
    counts = Counter(a["state"] for a in agents if a["kind"] != "headless")
    return {
        "agents": agents,
        "counts": {
            "working": counts.get("working", 0),
            "idle": counts.get("idle", 0),
            "blocked": counts.get("blocked", 0),
            "failed": counts.get("failed", 0),
            "your_turn": sum(1 for a in agents if a["your_turn"]),
            "headless": sum(1 for a in agents if a["kind"] == "headless"),
        },
        "checked_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }


def live_agents() -> dict:
    global _cache
    now = time.time()
    if _cache and now - _cache[0] < _TTL:
        return _cache[1]
    data = _scan()
    _cache = (now, data)
    return data


def _job(job_id: str) -> Path:
    if not _JOB_ID.fullmatch(job_id):
        raise HTTPException(400, "not a background session id")
    path = CLAUDE_HOME / "jobs" / job_id / "state.json"
    if not path.exists():
        raise HTTPException(404, "no such background session")
    return path


@router.get("/api/agents")
def api_agents():
    return live_agents()


@router.post("/api/agents/{job_id}/attach")
def api_attach(job_id: str):
    """Open the background session in a new Terminal window."""
    _job(job_id)
    from .launch import run_in_terminal
    run_in_terminal(f"{shlex.quote(claude_exe())} attach {job_id}")
    return {"ok": True, "command": f"claude attach {job_id}"}


@router.get("/api/agents/{job_id}/logs")
def api_logs(job_id: str, lines: int = 120):
    """The background session's recent terminal output (`claude logs`)."""
    _job(job_id)
    try:
        r = subprocess.run([claude_exe(), "logs", job_id], capture_output=True, text=True, timeout=15)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise HTTPException(502, f"claude logs failed: {exc}")
    text = _ANSI.sub("", r.stdout or r.stderr or "")
    tail = text.splitlines()[-max(10, min(lines, 400)):]
    return {"id": job_id, "lines": tail}
