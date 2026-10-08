"""Claude Code session history, read from ~/.claude/projects/*/*.jsonl.

Read-only. Each session file is parsed once per (size, mtime) and summarised:
title, first prompt, start/end, user turns, token usage, and which project it
was in (the most frequent cwd under the projects root). Sessions started at
~/dev that moved into a project are attributed to that project.
"""
from __future__ import annotations

import json
import os
import re
import threading
import time
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter

from . import projects as proj_mod

router = APIRouter()

CLAUDE_PROJECTS = Path(os.environ.get("CLAUDE_HOME", "~/.claude")).expanduser() / "projects"
_TYPE_RE = re.compile(r'"type":"(user|assistant|ai-title)"')
_ENTRY_RE = re.compile(r'"entrypoint":"([^"]+)"')
_list_cache: tuple[float, list[dict]] | None = None
STEWARD_PROMPT = "# Nightly steward"


class _Acc:
    """Running summary of one transcript.

    Transcripts only grow while a session runs, and a long one is tens of MB,
    so each file is read once and then only from the byte where the last read
    stopped (complete lines only). Token usage is counted once per API message:
    Claude Code writes one line per content block and repeats the message's
    usage on each, so summing every line overcounted output tokens ~2.8x.
    """
    __slots__ = ("offset", "ino", "mtime", "title", "first_prompt", "t0", "t1", "active", "prev_ts",
                 "cwds", "branch", "user_turns", "model", "usage", "out_tok", "in_tok", "entrypoint",
                 "summary")

    def __init__(self) -> None:
        self.offset = 0
        self.ino = 0
        self.mtime = 0.0
        self.title: str | None = None
        self.first_prompt: str | None = None
        self.t0: str | None = None
        self.t1: str | None = None
        self.active = 0.0  # seconds, gaps capped at 30 min so resumed sessions do not count idle days
        self.prev_ts: float | None = None
        self.cwds: Counter[str] = Counter()
        self.branch: str | None = None
        self.user_turns = 0
        self.model: str | None = None
        self.usage: dict[str, tuple[int, int]] = {}  # message id -> (output, input incl. cache)
        self.out_tok = 0
        self.in_tok = 0
        self.entrypoint: str | None = None
        self.summary: dict | None = None


_accs: dict[str, _Acc] = {}  # path -> accumulator


def _project_for(cwd: str | None) -> str | None:
    if not cwd:
        return None
    try:
        rel = Path(cwd).resolve().relative_to(proj_mod.PROJECTS_ROOT.resolve())
    except (ValueError, OSError):
        return None
    return rel.parts[0] if rel.parts else None


def _text_of(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        for b in content:
            if isinstance(b, dict) and b.get("type") == "text" and b.get("text"):
                return b["text"]
    return ""


def _feed(acc: _Acc, line: str) -> None:
    if acc.entrypoint is None:
        e = _ENTRY_RE.search(line)
        if e:
            acc.entrypoint = e.group(1)
    if not _TYPE_RE.search(line):
        return
    try:
        o = json.loads(line)
    except ValueError:
        return
    kind = o.get("type")
    if kind not in ("user", "assistant", "ai-title") or o.get("isSidechain"):
        return
    ts = o.get("timestamp")
    if ts:
        acc.t0 = acc.t0 or ts
        acc.t1 = ts
        try:
            cur = datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
            if acc.prev_ts is not None:
                acc.active += min(max(0.0, cur - acc.prev_ts), 1800.0)
            acc.prev_ts = cur
        except ValueError:
            pass
    if o.get("cwd"):
        acc.cwds[o["cwd"]] += 1
    if o.get("gitBranch"):
        acc.branch = o["gitBranch"]
    if kind == "ai-title":
        acc.title = o.get("aiTitle") or acc.title
    elif kind == "user":
        msg = o.get("message") or {}
        if msg.get("role") == "user" and not o.get("isMeta"):
            text = _text_of(msg.get("content"))
            # tool_result-only turns have no text; skip them
            if text and not text.startswith("<"):
                acc.user_turns += 1
                if acc.first_prompt is None:
                    acc.first_prompt = text.strip().replace("\n", " ")[:160]
    elif kind == "assistant":
        msg = o.get("message") or {}
        u = msg.get("usage") or {}
        out = u.get("output_tokens", 0) or 0
        inp = ((u.get("input_tokens", 0) or 0) + (u.get("cache_creation_input_tokens", 0) or 0)
               + (u.get("cache_read_input_tokens", 0) or 0))
        mid = msg.get("id") or o.get("requestId")
        if mid:
            prev_out, prev_in = acc.usage.get(mid, (0, 0))
            out, inp = max(prev_out, out), max(prev_in, inp)
            acc.out_tok += out - prev_out
            acc.in_tok += inp - prev_in
            acc.usage[mid] = (out, inp)
        else:
            acc.out_tok += out
            acc.in_tok += inp
        acc.model = msg.get("model") or acc.model


def _summary_of(acc: _Acc, path: Path) -> dict | None:
    if not acc.user_turns or not acc.t0:
        return None
    proj_counts: Counter[str] = Counter()
    for cwd, n in acc.cwds.items():
        p = _project_for(cwd)
        if p:
            proj_counts[p] += n
    primary = proj_counts.most_common(1)[0][0] if proj_counts else None
    try:
        start = datetime.fromisoformat(acc.t0.replace("Z", "+00:00"))
        end = datetime.fromisoformat(acc.t1.replace("Z", "+00:00"))
    except ValueError:
        return None
    top_cwd = acc.cwds.most_common(1)[0][0] if acc.cwds else None
    headless = (acc.entrypoint or "").startswith("sdk")
    steward = (acc.first_prompt or "").startswith(STEWARD_PROMPT)
    return {
        "id": path.stem,
        "title": ("Nightly steward" if steward else (acc.title or acc.first_prompt or "(untitled)"))[:120],
        "first_prompt": acc.first_prompt or "",
        "started": start.isoformat(),
        "ended": end.isoformat(),
        "duration_min": max(1, round(acc.active / 60)),
        "span_min": max(1, round((end - start).total_seconds() / 60)),
        "project": primary,
        "projects": sorted(proj_counts),
        "cwd": top_cwd,
        # headless `claude -p` runs (the steward, markets/classroom forecasters,
        # routines) are tagged by Claude Code itself: entrypoint "sdk-cli".
        # Keep them out of "my sessions" by default.
        "automated": headless or (primary is None and (not acc.cwds or top_cwd == "/")),
        "entrypoint": acc.entrypoint,
        "kind": "steward" if steward else ("headless" if headless else "interactive"),
        "branch": acc.branch,
        "user_turns": acc.user_turns,
        "output_tokens": acc.out_tok,
        "input_tokens": acc.in_tok,
        "model": acc.model,
    }


def _read_new(path: Path, acc: _Acc) -> None:
    start = acc.offset
    with open(path, "rb") as fh:
        fh.seek(start)
        chunk = fh.read()
    end = chunk.rfind(b"\n")
    if end < 0:
        return  # no complete line yet
    for raw in chunk[:end].split(b"\n"):
        if raw:
            _feed(acc, raw.decode("utf-8", "ignore"))
    acc.offset = start + end + 1


_read_lock = threading.Lock()


def all_sessions() -> list[dict]:
    """Every session summary, newest first. A file that grew is read only from
    where the last read stopped; a file that was replaced is read again. One
    reader at a time: two would feed the same accumulator twice."""
    global _list_cache
    if _list_cache and time.time() - _list_cache[0] < 30:
        return _list_cache[1]
    with _read_lock:
        if _list_cache and time.time() - _list_cache[0] < 30:
            return _list_cache[1]
        return _read_all()


def _read_all() -> list[dict]:
    global _list_cache
    now = time.time()
    out: list[dict] = []
    seen: set[str] = set()
    if CLAUDE_PROJECTS.exists():
        for f in CLAUDE_PROJECTS.glob("*/*.jsonl"):
            key = str(f)
            seen.add(key)
            try:
                st = f.stat()
            except OSError:
                continue
            acc = _accs.get(key)
            if acc is None or acc.ino != st.st_ino or st.st_size < acc.offset:
                acc = _Acc()
                acc.ino = st.st_ino
                _accs[key] = acc
            if st.st_size != acc.offset or st.st_mtime != acc.mtime:
                try:
                    if st.st_size > acc.offset:
                        _read_new(f, acc)
                except OSError:
                    continue
                acc.mtime = st.st_mtime
                acc.summary = _summary_of(acc, f)
            if acc.summary:
                out.append(acc.summary)
    for key in list(_accs):
        if key not in seen:
            _accs.pop(key, None)
    out.sort(key=lambda s: s["ended"], reverse=True)
    _list_cache = (now, out)
    return out


@router.get("/api/claude/sessions")
def api_sessions(project: str | None = None, limit: int = 12, automated: bool = False):
    sessions = all_sessions()
    if not automated:
        sessions = [s for s in sessions if not s["automated"]]
    if project:
        sessions = [s for s in sessions if s["project"] == project or project in s["projects"]]
    return {"sessions": sessions[:max(1, min(limit, 100))], "total": len(sessions)}


@router.get("/api/claude/spend")
def api_spend(days: int = 7, automated: bool = False):
    """Sessions and token usage per project over the last N days. Headless
    automated runs are excluded unless asked for."""
    cutoff = datetime.now(timezone.utc).timestamp() - days * 86400
    by: dict[str, dict] = defaultdict(lambda: {"sessions": 0, "output_tokens": 0, "input_tokens": 0, "minutes": 0})
    total = {"sessions": 0, "output_tokens": 0, "input_tokens": 0, "minutes": 0}
    for s in all_sessions():
        if datetime.fromisoformat(s["ended"]).timestamp() < cutoff:
            continue
        if s["automated"] and not automated:
            continue
        b = by[s["project"] or "(outside projects)"]
        for k, v in (("sessions", 1), ("output_tokens", s["output_tokens"]), ("input_tokens", s["input_tokens"]), ("minutes", s["duration_min"])):
            b[k] += v
            total[k] += v
    rows = [{"project": k, **v} for k, v in by.items()]
    rows.sort(key=lambda r: -r["output_tokens"])
    return {"days": days, "total": total, "by_project": rows}
