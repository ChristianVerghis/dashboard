"""Quick questions about the projects, answered by Claude Code in print mode.

POST /api/ask {question, history:[{role, content}]} streams SSE events:
  {"type":"delta","text":...} ... {"type":"done"} | {"type":"error","message":...}

The answer is grounded in a context pack built from what the dashboard already
knows (manifest, README summary, goals, last commit, git state, todos). Tools
are disabled so a question costs one model turn and returns in a few seconds.
Uses the local `claude` CLI, so it bills against the same plan as your normal
Claude Code sessions and needs no API key.
"""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import time
from datetime import datetime, timezone
from typing import AsyncIterator

from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from . import projects as proj_mod

router = APIRouter()

MODEL = os.environ.get("DASHBOARD_ASK_MODEL", "claude-sonnet-5")
_pack_cache: tuple[float, str] | None = None


def _age(seconds: int | None) -> str:
    if seconds is None:
        return "never"
    d = seconds // 86400
    if d < 1:
        h = seconds // 3600
        return f"{h}h ago" if h else "just now"
    return f"{d}d ago"


def build_context_pack() -> str:
    global _pack_cache
    now = time.time()
    if _pack_cache and now - _pack_cache[0] < 60:
        return _pack_cache[1]
    lines = [f"Snapshot taken {datetime.now(timezone.utc).astimezone().strftime('%Y-%m-%d %H:%M')}.",
             f"Projects root: {proj_mod.PROJECTS_ROOT}", ""]
    for p in proj_mod.list_projects():
        m = p.manifest or {}
        sig = p.signals or {}
        v = sig.get("verdict") or {}
        goals = []
        for c in sig.get("checklists", []) or []:
            g = f"{c.get('done', 0)}/{c.get('total', 0)} {c.get('label', 'goals')}"
            if c.get("next_undone"):
                g += f" (next: {c['next_undone']})"
            goals.append(g)
        gs = p.git_state or {}
        git_bits = []
        if gs.get("dirty_count"):
            git_bits.append(f"{gs['dirty_count']} uncommitted")
        if gs.get("ahead"):
            git_bits.append(f"{gs['ahead']} unpushed")
        if gs.get("behind"):
            git_bits.append(f"{gs['behind']} behind")
        lines.append(f"## {p.name}")
        meta = [x for x in [m.get("kind"), m.get("status"), p.framework, f"port {m['port']}" if m.get("port") else None,
                            f"branch {p.branch}" if p.branch else None] if x]
        if meta:
            lines.append("- " + " · ".join(str(x) for x in meta))
        if m.get("description"):
            lines.append(f"- {m['description']}")
        elif p.summary:
            lines.append(f"- {p.summary[:300]}")
        if p.last_commit:
            lines.append(f"- last commit {_age(p.last_commit.age_seconds)}: {p.last_commit.subject[:120]}")
        if p.service_up is not None:
            lines.append(f"- service {'up' if p.service_up else 'down'}")
        if v.get("level"):
            lines.append(f"- health: {v['level']}" + (f" — {'; '.join(v.get('reasons', [])[:3])}" if v.get("reasons") else ""))
        if goals:
            lines.append("- goals: " + "; ".join(goals))
        if p.todos:
            lines.append("- open todos: " + " | ".join(t[:100] for t in p.todos[:3]))
        if git_bits:
            lines.append("- git: " + ", ".join(git_bits))
        for l in (m.get("links") or [])[:3]:
            if isinstance(l, dict) and l.get("href"):
                lines.append(f"- link: {l.get('label', '')} {l['href']}")
        lines.append("")
    pack = "\n".join(lines)
    _pack_cache = (now, pack)
    return pack


SYSTEM = """You are the assistant built into a personal projects dashboard. The owner has ~20 side projects and asks quick, surface-level questions when they forget something: what a project is, what's blocked, what's next, where something lives, what changed recently.

Answer from the project snapshot below. Be brief: one to four sentences, or a short list when comparing projects. Name projects exactly as they appear. Give relative times as they appear in the snapshot. If the snapshot does not contain the answer, say so in one sentence and name the file that would (README.md, GOALS.md, build_log.md or project.yml in that project's folder) instead of guessing. Do not invent commits, goals or files. Plain prose, no headings, no emoji.

Each project has a page at http://localhost:8765/project/<name>.

PROJECT SNAPSHOT
"""


class AskRequest(BaseModel):
    question: str
    history: list[dict] = []


def _sse(obj: dict) -> str:
    return f"data: {json.dumps(obj)}\n\n"


async def _stream_answer(req: AskRequest) -> AsyncIterator[str]:
    exe = shutil.which("claude") or os.path.expanduser("~/.local/bin/claude")
    if not os.path.exists(exe):
        yield _sse({"type": "error", "message": "claude CLI not found on PATH"})
        return
    system = SYSTEM + build_context_pack()
    convo = []
    for turn in req.history[-6:]:
        role = "Owner" if turn.get("role") == "user" else "Assistant"
        convo.append(f"{role}: {str(turn.get('content', ''))[:1500]}")
    convo.append(f"Owner: {req.question.strip()[:2000]}")
    prompt = "\n\n".join(convo) if len(convo) > 1 else req.question.strip()[:2000]
    argv = [exe, "-p", prompt, "--output-format", "stream-json", "--verbose",
            "--include-partial-messages", "--tools", "", "--no-session-persistence",
            "--model", MODEL, "--append-system-prompt", system]
    env = dict(os.environ)
    env.pop("CLAUDECODE", None)  # allow spawning from inside a Claude-launched server
    try:
        proc = await asyncio.create_subprocess_exec(
            *argv, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            cwd=str(proj_mod.PROJECTS_ROOT), env=env)
    except OSError as e:
        yield _sse({"type": "error", "message": str(e)})
        return
    yield _sse({"type": "start", "model": MODEL})
    got_text = False
    try:
        assert proc.stdout is not None
        while True:
            line = await asyncio.wait_for(proc.stdout.readline(), timeout=120)
            if not line:
                break
            try:
                ev = json.loads(line)
            except ValueError:
                continue
            if ev.get("type") == "stream_event":
                e = ev.get("event", {})
                if e.get("type") == "content_block_delta" and e.get("delta", {}).get("type") == "text_delta":
                    got_text = True
                    yield _sse({"type": "delta", "text": e["delta"]["text"]})
            elif ev.get("type") == "result":
                if ev.get("is_error"):
                    yield _sse({"type": "error", "message": str(ev.get("result") or ev.get("error") or "claude returned an error")[:500]})
                elif not got_text and ev.get("result"):
                    yield _sse({"type": "delta", "text": str(ev["result"])})
        await proc.wait()
        if proc.returncode not in (0, None) and not got_text:
            err = (await proc.stderr.read()).decode(errors="ignore")[-500:] if proc.stderr else ""
            yield _sse({"type": "error", "message": err.strip() or f"claude exited {proc.returncode}"})
    except asyncio.TimeoutError:
        proc.kill()
        yield _sse({"type": "error", "message": "timed out after 120s"})
    finally:
        if proc.returncode is None:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
    yield _sse({"type": "done"})


@router.post("/api/ask")
async def api_ask(req: AskRequest):
    return StreamingResponse(_stream_answer(req), media_type="text/event-stream")


@router.get("/api/ask/context")
def api_ask_context():
    """The exact snapshot the assistant sees. Handy for checking what it knows."""
    return {"model": MODEL, "context": build_context_pack()}
