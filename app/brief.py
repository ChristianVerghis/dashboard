"""A short, pasteable brief for starting a Claude session on a project."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException
from fastapi.responses import PlainTextResponse

from . import projects as proj_mod

router = APIRouter()


def build_brief(p) -> str:
    m = p.manifest or {}
    sig = p.signals or {}
    lines = [f"Project: {p.name}  ({p.path})"]
    meta = [x for x in [m.get("kind"), m.get("status"), p.framework, f"branch {p.branch}" if p.branch else None] if x]
    if meta:
        lines.append("Type: " + " · ".join(str(x) for x in meta))
    desc = m.get("description") or p.summary
    if desc:
        lines.append(f"What it is: {desc.strip()[:400]}")
    if m.get("port"):
        lines.append(f"Runs on: localhost:{m['port']}" + (f"  (start: {m['start']})" if m.get("start") else ""))
    v = sig.get("verdict") or {}
    if v.get("reasons"):
        lines.append("Current state: " + "; ".join(v["reasons"][:3]))
    nxt = []
    for c in sig.get("checklists", []) or []:
        if c.get("next_undone"):
            nxt.append(f"{c['next_undone']}  [{c.get('done', 0)}/{c.get('total', 0)} {c.get('label', 'goals')}]")
    if nxt:
        lines.append("Next goals:")
        lines += [f"  - {n}" for n in nxt[:4]]
    if p.todos:
        lines.append("Open todos:")
        lines += [f"  - {t[:140]}" for t in p.todos[:4]]
    if p.recent_commits:
        lines.append("Recent commits:")
        lines += [f"  - {c.short_sha} {c.subject[:100]}" for c in p.recent_commits[:5]]
    gs = p.git_state or {}
    bits = []
    if gs.get("dirty_count"):
        bits.append(f"{gs['dirty_count']} uncommitted files")
    if gs.get("ahead"):
        bits.append(f"{gs['ahead']} unpushed commits")
    if bits:
        lines.append("Working tree: " + ", ".join(bits))
    lines.append("")
    lines.append("Read README.md, GOALS.md and build_log.md before changing anything. "
                 "Append a dated entry to build_log.md when you finish.")
    return "\n".join(lines)


@router.get("/api/projects/{name}/brief", response_class=PlainTextResponse)
def api_brief(name: str):
    p = proj_mod.get_one(name)
    if not p:
        raise HTTPException(404, "unknown project")
    return build_brief(p)
