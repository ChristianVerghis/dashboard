"""Thin client for the reef daemon (localhost:3738).

Reef is the agent-orchestration daemon (~/dev/reef). Every call here is
best-effort: if the daemon is down we return None/empty and the UI hides
the reef panels. Short timeouts — this runs inside request handlers.
"""
from __future__ import annotations

import json
import urllib.error
import urllib.request

REEF_DAEMON = "http://127.0.0.1:3738"
REEF_WEB = "http://localhost:3737"
_TIMEOUT = 1.5


def _get(path: str) -> dict | None:
    try:
        with urllib.request.urlopen(f"{REEF_DAEMON}{path}", timeout=_TIMEOUT) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception:
        return None


def _post(path: str, body: dict) -> dict | None:
    try:
        req = urllib.request.Request(
            f"{REEF_DAEMON}{path}",
            data=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=_TIMEOUT * 2) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            return {"error": e.read().decode("utf-8")[:300], "status": e.code}
        except Exception:
            return {"error": str(e), "status": e.code}
    except Exception:
        return None


def alive() -> bool:
    return _get("/api/health") is not None


def usage_summary(window: str = "day") -> dict | None:
    if window not in {"day", "week", "month", "all"}:
        window = "day"
    return _get(f"/api/usage/summary?window={window}")


def runs_for_repo(repo_path: str, limit: int = 5) -> list[dict]:
    data = _get("/api/runs")
    if not data:
        return []
    runs = [r for r in data.get("runs", []) if r.get("repoPath") == repo_path]
    runs.sort(key=lambda r: r.get("startedAt", 0), reverse=True)
    return runs[:limit]


def learnings_for_repo(repo_path: str) -> list[dict]:
    from urllib.parse import quote
    data = _get(f"/api/learnings?repo={quote(repo_path, safe='')}")
    return data.get("learnings", []) if data else []


def dispatch_run(repo_path: str, prompt: str, model: str | None = None) -> dict | None:
    body: dict = {"repoPath": repo_path, "prompt": prompt}
    if model:
        body["model"] = model
    return _post("/api/runs", body)
