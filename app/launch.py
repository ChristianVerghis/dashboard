"""Open the user's own terminal in a project folder, optionally running claude.

Terminal.app (via AppleScript) only ever runs a command built here: `cd
<project> && claude`, just the cd, or `claude attach <id>` for a background
session (app/agents.py). The project must be a direct child of the projects
root and the session id must match a job on disk, so no path or command from
the request reaches the shell unvalidated. Guarded by the cross-site write
middleware like every POST.
"""
from __future__ import annotations

import shlex
import subprocess
import sys

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from . import projects as proj_mod

router = APIRouter()


class OpenRequest(BaseModel):
    project: str | None = None
    claude: bool = False


def _project_dir(name: str | None):
    root = proj_mod.PROJECTS_ROOT.resolve()
    if not name:
        return root
    cand = (root / name).resolve()
    if cand.parent != root or not cand.is_dir():
        raise HTTPException(404, "unknown project")
    return cand


def run_in_terminal(shell_cmd: str) -> None:
    """Open a new Terminal.app window running `shell_cmd`, built by the caller
    from validated parts only."""
    if sys.platform != "darwin":
        raise HTTPException(501, "only implemented for macOS Terminal.app")
    # AppleScript string literal: escape backslashes and double quotes.
    lit = shell_cmd.replace("\\", "\\\\").replace('"', '\\"')
    script = f'tell application "Terminal"\n  activate\n  do script "{lit}"\nend tell'
    try:
        r = subprocess.run(["osascript", "-e", script], capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired) as e:
        raise HTTPException(500, str(e))
    if r.returncode != 0:
        raise HTTPException(500, r.stderr.strip()[:300] or "osascript failed")


@router.post("/api/open_terminal")
def api_open_terminal(req: OpenRequest):
    target = _project_dir(req.project)
    run_in_terminal(f"cd {shlex.quote(str(target))} && clear" + (" && claude" if req.claude else ""))
    return {"ok": True, "cwd": str(target), "claude": req.claude}
