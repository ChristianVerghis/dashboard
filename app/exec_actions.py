"""Whitelisted shell actions per project.

Output is streamed line-by-line to logs/feed.log so it appears in the
dashboard's live log pane. Localhost only — no auth, no remote exec.
"""
from __future__ import annotations

import asyncio
import itertools
import os
import shlex
import subprocess
from datetime import datetime, timezone
from pathlib import Path

from . import projects as proj_mod
from .streams import LOG_PATH

# Global registry of in-flight exec calls so the UI can show a "running" indicator.
_running: dict[int, dict] = {}
_run_counter = itertools.count()
_history: list[dict] = []  # last N completed runs; bounded
_HISTORY_MAX = 100


def running_actions() -> list[dict]:
    """Snapshot of currently-running exec calls."""
    return list(_running.values())


def recent_actions() -> list[dict]:
    """Newest-first list of recently-completed exec calls."""
    return list(reversed(_history))


# Every action is a list-of-strings argv. No shell strings.
GLOBAL_ACTIONS: dict[str, list[str]] = {
    "status": ["git", "status", "--short"],
    "pull": ["git", "pull", "--ff-only"],
    "log": ["git", "log", "--oneline", "-10"],
    "fetch": ["git", "fetch", "--all", "--quiet"],
    # macOS: open the project in the user's default GUI editor.
    # Tries Cursor first, falls back to Code.app, then plain `open` (Finder).
    "open_in_editor": ["bash", "-lc",
        "open -a 'Cursor' . 2>/dev/null || "
        "open -a 'Visual Studio Code' . 2>/dev/null || "
        "open . 2>/dev/null"],
    "reveal_in_finder": ["open", "."],
}

# Project-specific actions (additive on top of global).
PROJECT_ACTIONS: dict[str, dict[str, list[str]]] = {
    "markets": {
        "smoketest": [".venv/bin/python", "scripts/smoketest.py", "--no-net"],
        "ingest_prices": [".venv/bin/python", "scripts/ingest_prices.py"],
        "daily_briefing": [".venv/bin/python", "scripts/daily_briefing.py"],
        "weekly_synthesis": [".venv/bin/python", "scripts/weekly_synthesis.py", "--force"],
        "refresh_analytics": [".venv/bin/python", "scripts/markets_analytics.py"],
        "show_briefing": ["bash", "-lc", "ls -la 'vault/Daily Briefings'/[0-9]*.md | tail -5"],
        "list_predictions": ["bash", "-lc", "ls -la data/predictions/*.json 2>/dev/null | tail -10 || echo 'none yet'"],
    },
    "charger-tracker": {
        "build": ["bash", "-lc", "pnpm build 2>&1 | tail -50 || npm run build 2>&1 | tail -50"],
        "test": ["bash", "-lc", "pnpm test 2>&1 | tail -50 || npm test 2>&1 | tail -50"],
        "lint": ["bash", "-lc", "pnpm lint 2>&1 | tail -50 || npm run lint 2>&1 | tail -50"],
    },
}


def run_log_prediction(fields: dict) -> list[str]:
    """Build the argv for log_prediction.py --non-interactive from a dict."""
    invalidation = " | ".join(fields.get("invalidation", []))
    sources = " | ".join(fields.get("sources", []))
    args = [
        ".venv/bin/python", "scripts/log_prediction.py",
        "--non-interactive",
        "--ticker", fields["ticker"],
        "--direction", fields["direction"],
        "--horizon", fields["horizon"],
        "--confidence", str(fields["confidence"]),
        "--reasoning", fields["reasoning"],
        "--invalidation", invalidation,
        "--slug", fields.get("slug", "prediction"),
    ]
    if sources:
        args.extend(["--sources", sources])
    return args


def _manifest_actions(name: str) -> dict[str, list[str]]:
    """Actions declared in the project's own project.yml. String commands
    run via bash -lc in the repo, same trust model as PROJECT_ACTIONS
    (localhost only, user-owned files)."""
    path = _project_path(name)
    if path is None:
        return {}
    from . import manifest as man
    m = man.load_manifest(path)
    if not m:
        return {}
    return {k: ["bash", "-lc", v] for k, v in m.get("actions", {}).items()}


def actions_for(name: str) -> list[str]:
    base = list(GLOBAL_ACTIONS.keys())
    extras = list(PROJECT_ACTIONS.get(name, {}).keys())
    manifest = list(_manifest_actions(name).keys())
    # Dedup, manifest last so the UI shows it after the built-ins.
    seen: set[str] = set()
    out: list[str] = []
    for a in base + extras + manifest:
        if a not in seen:
            seen.add(a)
            out.append(a)
    return out


def _resolve(name: str, action: str) -> list[str] | None:
    # Manifest wins: the project owns its own verbs.
    manifest = _manifest_actions(name)
    if action in manifest:
        return manifest[action]
    if action in PROJECT_ACTIONS.get(name, {}):
        return PROJECT_ACTIONS[name][action]
    if action in GLOBAL_ACTIONS:
        return GLOBAL_ACTIONS[action]
    return None


def _project_path(name: str) -> Path | None:
    p = proj_mod.PROJECTS_ROOT / name
    return p if p.exists() else None


def _append_log(line: str) -> None:
    with open(LOG_PATH, "a", encoding="utf-8") as f:
        f.write(line + "\n")


def _nvm_default_bin() -> str | None:
    """Locate the nvm default Node's bin dir. Launchd runs us with a bare
    login-shell PATH where /usr/local/bin/node (v18) shadows nvm's Node 22,
    because nvm is only sourced in ~/.zshrc. Every Node service we start
    (reef, portfolio, model-f1…) needs 20+, so put the right one first."""
    nvm = Path.home() / ".nvm"
    versions = nvm / "versions" / "node"
    if not versions.is_dir():
        return None
    def key(d: Path) -> list[int]:
        try:
            return [int(x) for x in d.name.lstrip("v").split(".")]
        except ValueError:
            return [0]
    dirs = sorted((d for d in versions.iterdir() if d.is_dir() and d.name.startswith("v")), key=key)
    if not dirs:
        return None
    want = ""
    alias = nvm / "alias" / "default"
    if alias.exists():
        want = alias.read_text().strip().lstrip("v")
    pick: Path | None = None
    if want and not want.startswith("lts"):
        for d in reversed(dirs):
            v = d.name.lstrip("v")
            if v == want or v.startswith(want + "."):
                pick = d
                break
    return str((pick or dirs[-1]) / "bin")


def service_env() -> dict[str, str]:
    """Environment for spawned actions/services: current env + nvm Node first on PATH."""
    env = os.environ.copy()
    node_bin = _nvm_default_bin()
    if node_bin:
        env["PATH"] = node_bin + os.pathsep + env.get("PATH", "")
    return env


def with_node_path(argv: list[str]) -> list[str]:
    """`bash -lc` re-runs /etc/profile → path_helper, which pushes system dirs
    back in front of anything we prepended in env. So for login-shell commands
    also export the nvm bin inside the command itself."""
    node_bin = _nvm_default_bin()
    if node_bin and len(argv) >= 3 and argv[0] == "bash" and argv[1] == "-lc":
        return ["bash", "-lc", f'export PATH="{node_bin}:$PATH"; {argv[2]}']
    return argv


async def run_action(name: str, action: str) -> dict:
    """Run a whitelisted action and stream output to feed.log."""
    cwd = _project_path(name)
    if cwd is None:
        return {"ok": False, "error": f"unknown project '{name}'"}
    argv = _resolve(name, action)
    if argv is None:
        return {"ok": False, "error": f"action '{action}' not allowed for {name}"}
    argv = with_node_path(argv)

    pretty = " ".join(shlex.quote(a) for a in argv)
    _append_log(f"$ ({name}) {pretty}")

    run_id = next(_run_counter)
    started_at = datetime.now(timezone.utc)
    _running[run_id] = {
        "id": run_id,
        "project": name,
        "action": action,
        "started_at": started_at.isoformat(),
    }
    rc = -1
    try:
        proc = await asyncio.create_subprocess_exec(
            *argv,
            cwd=str(cwd),
            env=service_env(),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        if proc.stdout is None:
            return {"ok": False, "error": "no stdout"}

        while True:
            raw = await proc.stdout.readline()
            if not raw:
                break
            line = raw.decode(errors="ignore").rstrip()
            _append_log(line)

        rc = await proc.wait()
        _append_log(f"# exit {rc}")
        return {"ok": rc == 0, "exit_code": rc}
    finally:
        _running.pop(run_id, None)
        ended_at = datetime.now(timezone.utc)
        _history.append({
            "id": run_id,
            "project": name,
            "action": action,
            "started_at": started_at.isoformat(),
            "ended_at": ended_at.isoformat(),
            "duration_seconds": (ended_at - started_at).total_seconds(),
            "exit_code": rc,
            "ok": rc == 0,
        })
        # Bound the history
        while len(_history) > _HISTORY_MAX:
            _history.pop(0)


SERVICE_LOG_DIR = Path(__file__).resolve().parent.parent / "logs" / "services"


def start_service(name: str) -> dict:
    """Start a manifest-declared service detached. Unlike run_action this
    doesn't wait: the process outlives the request, output goes to
    logs/services/<name>.log."""
    cwd = _project_path(name)
    if cwd is None:
        return {"ok": False, "error": f"unknown project '{name}'"}
    from . import manifest as man
    m = man.load_manifest(cwd)
    if not m or not m.get("start"):
        return {"ok": False, "error": f"no start command declared for {name}"}
    port = m.get("port")
    if port and man.port_alive(port):
        return {"ok": False, "error": f"{name} already listening on :{port}"}

    SERVICE_LOG_DIR.mkdir(parents=True, exist_ok=True)
    log_file = open(SERVICE_LOG_DIR / f"{name}.log", "a")
    try:
        proc = subprocess.Popen(
            with_node_path(["bash", "-lc", m["start"]]),
            cwd=str(cwd),
            env=service_env(),
            stdout=log_file,
            stderr=subprocess.STDOUT,
            start_new_session=True,  # survives dashboard restarts
        )
    except OSError as e:
        return {"ok": False, "error": str(e)}
    finally:
        log_file.close()
    _append_log(f"$ ({name}) start: {m['start']}  [detached pid {proc.pid}]")
    return {"ok": True, "pid": proc.pid, "log": f"logs/services/{name}.log"}
