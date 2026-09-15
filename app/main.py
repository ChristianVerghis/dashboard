"""FastAPI app — project dashboard."""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from fastapi import HTTPException
from pydantic import BaseModel

from . import activity as act
from . import exec_actions as ex
from . import projects as proj
from . import streams
from . import classroom as cls
from . import shortterm as st

REPO_ROOT = Path(__file__).resolve().parent.parent
STATIC_DIR = REPO_ROOT / "static"


@asynccontextmanager
async def lifespan(app: FastAPI):
    streams.bus.attach_loop(asyncio.get_running_loop())
    streams.start_observer()
    try:
        yield
    finally:
        streams.stop_observer()


app = FastAPI(title="Projects dashboard", lifespan=lifespan)


@app.get("/api/projects")
def api_projects():
    return [proj.project_to_dict(p) for p in proj.list_projects()]


@app.get("/api/projects/{name}")
def api_project(name: str):
    """Fast path: scan only the requested project (was scanning all 4)."""
    p = proj.get_one(name)
    if p is None:
        raise HTTPException(404, "project not found")
    return proj.project_to_dict(p)


@app.get("/api/projects/{name}/signals")
def api_signals(name: str):
    """Full probe set for one project: health (HTTP), freshness, metrics,
    checklists, blocker, verdict. Slower than the scan path — may hit
    sibling services — so it's a dedicated endpoint the detail page calls."""
    from . import probes
    p = proj.get_one(name)
    if p is None:
        raise HTTPException(404, "project not found")
    return probes.signals_for(
        Path(p.path), p.manifest, p.git_state, include_metrics=True)


# ---- showcase (latest product per project) ----

@app.get("/api/showcase")
def api_showcase():
    from . import showcase as sc
    return {"items": sc.shelf()}


@app.get("/api/projects/{name}/showcase")
def api_project_showcase(name: str):
    from . import showcase as sc
    p = proj.get_one(name)
    if p is None:
        raise HTTPException(404, "project not found")
    return {"item": sc.resolve(p)}


@app.get("/api/showcase/{name}.png")
def api_showcase_snapshot(name: str):
    from . import showcase as sc
    if "/" in name or ".." in name:
        raise HTTPException(400, "bad name")
    p = sc.SNAP_DIR / f"{name}.png"
    if not p.is_file():
        raise HTTPException(404, "no snapshot")
    return FileResponse(str(p))


@app.post("/api/showcase/capture")
def api_showcase_capture(name: str | None = None):
    """Screenshot every up service (headless Chrome) → poster frames for
    the shelf. Sync endpoint; FastAPI runs it in the threadpool."""
    from . import showcase as sc
    result = sc.capture(name)
    ex._append_log(f"$ (dashboard) showcase capture: {result}")
    return result


_FILE_WHITELIST = {".html", ".htm", ".svg", ".png", ".jpg", ".jpeg", ".gif",
                   ".md", ".json", ".csv", ".txt", ".pdf", ".css", ".js"}


@app.get("/files/{name}/{path:path}")
def api_project_file(name: str, path: str):
    """Read-only file serving from a project root, so manifests can link to
    local artifacts (file:// hrefs are blocked from an http page)."""
    base = (proj.PROJECTS_ROOT / name).resolve()
    if not base.is_dir() or base.parent != proj.PROJECTS_ROOT:
        raise HTTPException(404, "project not found")
    target = (base / path).resolve()
    if not str(target).startswith(str(base) + "/"):
        raise HTTPException(400, "bad path")
    if not target.is_file():
        raise HTTPException(404, "file not found")
    if target.suffix.lower() not in _FILE_WHITELIST:
        raise HTTPException(403, "file type not served")
    return FileResponse(str(target))


@app.get("/api/activity")
def api_activity(limit: int = 30):
    return act.recent_activity(limit=limit)


@app.get("/api/projects/{name}/commit/{sha}")
def api_commit(name: str, sha: str):
    """Return file list + stats for a single commit on a project."""
    import subprocess
    base = proj.PROJECTS_ROOT / name
    if not base.exists():
        raise HTTPException(404, "project not found")
    if not all(c.isalnum() for c in sha) or len(sha) > 64:
        raise HTTPException(400, "bad sha")
    try:
        info = subprocess.run(
            ["git", "show", "--stat", "--format=%H%n%an <%ae>%n%aI%n%s%n%n%b", sha],
            cwd=str(base), capture_output=True, text=True, timeout=10,
        )
    except Exception as e:
        raise HTTPException(500, f"git show failed: {e}")
    if info.returncode != 0:
        raise HTTPException(404, "commit not found in this project")
    body = info.stdout.split("\n", 4)
    if len(body) < 5:
        return {"sha": sha, "raw": info.stdout}
    full_sha, author, iso, subject, rest = body
    # rest contains commit body + blank line + file stats; split on first occurrence of " files? changed"
    # Just return the full rest verbatim — easier to render.
    return {
        "sha": full_sha,
        "author": author,
        "date": iso,
        "subject": subject,
        "body": rest,
    }


NOTES_DIR = REPO_ROOT / "data" / "notes"
NOTES_DIR.mkdir(parents=True, exist_ok=True)


@app.get("/snapshot.html")
def page_snapshot():
    """Return a self-contained HTML file with the current dashboard state."""
    from datetime import datetime, timezone
    import html
    from fastapi.responses import HTMLResponse

    projects = proj.list_projects()
    activity = act.recent_activity(20)

    def esc(s):
        return html.escape(str(s)) if s else ""

    rows = []
    for p in projects:
        gs = p.git_state or {}
        gs_bits = []
        if gs.get("dirty_count"): gs_bits.append(f"●{gs['dirty_count']} dirty")
        if gs.get("ahead"): gs_bits.append(f"↑{gs['ahead']} ahead")
        if gs.get("behind"): gs_bits.append(f"↓{gs['behind']} behind")
        if gs.get("clean") and gs.get("has_remote") and not gs.get("ahead") and not gs.get("behind"):
            gs_bits.append("✓ clean")
        gs_str = " · ".join(gs_bits) or "—"
        last_commit = ""
        if p.last_commit:
            last_commit = f"{esc(p.last_commit.short_sha)} {esc(p.last_commit.subject[:60])}"
        insights = "<br>".join(
            f"<small>{esc(i['label'])}: <b>{esc(i['value'])}</b></small>"
            for i in (p.insights or [])[:6]
        )
        rows.append(f"""
        <article class="card">
          <header>
            <h2>{esc(p.name)} <span class="fw">{esc(p.framework or '')}</span></h2>
            <span class="m">{esc(p.momentum)}</span>
          </header>
          <p class="summary">{esc(p.summary)}</p>
          <p class="git">{esc(gs_str)}</p>
          <p class="last-commit"><code>{last_commit}</code></p>
          <div class="insights">{insights}</div>
        </article>
        """)

    feed_rows = []
    for it in activity[:25]:
        kind_label = "commit" if it["kind"] == "commit" else "edit"
        feed_rows.append(f"""
        <li>
          <span class="proj">{esc(it['project'])}</span>
          <span class="kind">{kind_label}</span>
          <span class="title">{esc(it['title'])}</span>
        </li>
        """)

    captured = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")

    html_doc = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Dashboard snapshot — {captured}</title>
<style>
:root {{
  --bg:#0b0f17;--panel:#121826;--panel-2:#182032;--border:#233048;
  --text:#e6edf3;--muted:#8b98ad;--accent:#7aa2f7;--accent-2:#9ece6a;
}}
body{{margin:0;background:var(--bg);color:var(--text);font:14px -apple-system,BlinkMacSystemFont,sans-serif;-webkit-font-smoothing:antialiased}}
header.top{{padding:20px 28px;border-bottom:1px solid var(--border)}}
header.top h1{{margin:0;font-size:18px;font-weight:600;letter-spacing:-0.01em}}
header.top .when{{color:var(--muted);font-size:12px;margin-top:4px}}
main{{padding:20px 28px;display:grid;gap:24px}}
section h2{{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:0.08em;margin:0 0 12px;font-weight:700}}
.cards{{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:14px}}
article.card{{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:14px 16px}}
article.card header{{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px}}
article.card h2{{margin:0;font-size:14px;font-weight:600;color:var(--text);text-transform:none;letter-spacing:0}}
article.card .fw{{font-size:10px;color:var(--accent);text-transform:uppercase;letter-spacing:0.04em}}
article.card .m{{font-size:10px;padding:2px 6px;border-radius:4px;background:rgba(122,162,247,0.15);color:var(--accent);text-transform:uppercase;letter-spacing:0.04em}}
article.card .summary{{color:var(--muted);font-size:12px;margin:6px 0;line-height:1.5}}
article.card .git{{font-size:11px;color:var(--accent-2);font-family:"SF Mono",monospace;margin:6px 0}}
article.card .last-commit{{font-size:11px;color:var(--muted);margin:6px 0}}
article.card .insights{{margin-top:8px;display:flex;flex-direction:column;gap:3px}}
article.card .insights small{{font-size:11px;color:var(--muted)}}
ul.feed{{list-style:none;padding:0;margin:0}}
ul.feed li{{display:grid;grid-template-columns:120px 60px 1fr;gap:12px;padding:6px 0;border-bottom:1px dashed var(--border);font-size:12px}}
ul.feed .proj{{color:var(--accent);font-weight:600}}
ul.feed .kind{{color:var(--muted)}}
footer{{padding:14px 28px;border-top:1px solid var(--border);color:var(--muted);font-size:11px}}
</style>
</head>
<body>
<header class="top">
  <h1>Projects dashboard · snapshot</h1>
  <div class="when">{esc(captured)} · {len(projects)} projects · self-contained HTML, openable offline</div>
</header>
<main>
  <section>
    <h2>Projects</h2>
    <div class="cards">{"".join(rows)}</div>
  </section>
  <section>
    <h2>Recent activity</h2>
    <ul class="feed">{"".join(feed_rows)}</ul>
  </section>
</main>
<footer>Generated by the projects dashboard at <code>localhost:8765</code>. Data captured at the time above.</footer>
</body>
</html>"""
    return HTMLResponse(html_doc)


@app.get("/api/projects/{name}/notes")
def api_get_notes(name: str):
    base = proj.PROJECTS_ROOT / name
    if not base.exists():
        raise HTTPException(404, "project not found")
    p = NOTES_DIR / f"{name}.md"
    if not p.exists():
        return {"text": "", "mtime": None}
    return {
        "text": p.read_text(encoding="utf-8"),
        "mtime": p.stat().st_mtime,
    }


class NotesUpdate(BaseModel):
    text: str


@app.post("/api/projects/{name}/notes")
def api_save_notes(name: str, req: NotesUpdate):
    base = proj.PROJECTS_ROOT / name
    if not base.exists():
        raise HTTPException(404, "project not found")
    if len(req.text) > 200_000:
        raise HTTPException(413, "notes too large (max 200KB)")
    p = NOTES_DIR / f"{name}.md"
    p.write_text(req.text, encoding="utf-8")
    return {"ok": True, "mtime": p.stat().st_mtime, "bytes": len(req.text)}


@app.get("/api/projects/{name}/file_diff")
def api_file_diff(name: str, path: str):
    """Return git diff for a single file (working tree vs HEAD)."""
    import subprocess
    base = proj.PROJECTS_ROOT / name
    if not base.exists():
        raise HTTPException(404, "project not found")
    if ".." in path or path.startswith("/"):
        raise HTTPException(400, "bad path")
    file_path = base / path
    # Untracked? show as fully-new
    porcelain = subprocess.run(
        ["git", "status", "--porcelain", "--", path],
        cwd=str(base), capture_output=True, text=True, timeout=10,
    )
    if porcelain.returncode != 0:
        raise HTTPException(500, "git status failed")
    is_untracked = porcelain.stdout.startswith("??")
    if is_untracked and file_path.exists() and file_path.is_file():
        try:
            content = file_path.read_text(encoding="utf-8", errors="replace")[:20_000]
            lines = content.splitlines()
            diff_lines = [f"+{line}" for line in lines]
            return {"path": path, "untracked": True, "diff": "\n".join(diff_lines)}
        except OSError as e:
            raise HTTPException(500, f"read failed: {e}")
    # Tracked file: regular diff
    diff = subprocess.run(
        ["git", "diff", "HEAD", "--", path],
        cwd=str(base), capture_output=True, text=True, timeout=10,
    )
    return {"path": path, "untracked": False, "diff": diff.stdout[:30_000]}


@app.get("/api/projects/{name}/diff")
def api_diff(name: str):
    """Return git status + diff stats for uncommitted changes."""
    import subprocess
    base = proj.PROJECTS_ROOT / name
    if not base.exists():
        raise HTTPException(404, "project not found")
    if not (base / ".git").exists():
        return {"clean": True, "files": [], "stat": ""}
    status = subprocess.run(
        ["git", "status", "--porcelain"],
        cwd=str(base), capture_output=True, text=True, timeout=10,
    )
    if status.returncode != 0:
        return {"clean": True, "files": [], "stat": "", "error": status.stderr}
    files: list[dict] = []
    for line in status.stdout.splitlines():
        if not line.strip():
            continue
        x, y = line[0], line[1]
        path = line[3:]
        files.append({"x": x, "y": y, "path": path,
                      "kind": "tracked" if x.strip() or y.strip() != "?" else "untracked"})
    if not files:
        return {"clean": True, "files": [], "stat": ""}
    stat = subprocess.run(
        ["git", "diff", "--stat"],
        cwd=str(base), capture_output=True, text=True, timeout=10,
    )
    return {
        "clean": False,
        "files": files[:60],
        "stat": stat.stdout.strip(),
    }


@app.get("/api/projects/{name}/goals")
def api_get_goals(name: str):
    """Parse GOALS.md into a list with section headings + checkbox state."""
    base = proj.PROJECTS_ROOT / name
    if not base.exists():
        raise HTTPException(404, "project not found")
    goals_path = base / "GOALS.md"
    if not goals_path.exists():
        return {"path": None, "items": [], "sections": []}
    import re
    text = goals_path.read_text(encoding="utf-8")
    items = []
    sections: list[dict] = []
    current_section = None
    for line_no, line in enumerate(text.splitlines()):
        sec = re.match(r"^##\s+(.+?)\s*$", line)
        if sec:
            current_section = {"name": sec.group(1), "items": []}
            sections.append(current_section)
            continue
        cb = re.match(r"^(\s*[-*]\s*)\[([ xX])\]\s+(.+?)\s*$", line)
        if cb:
            done = cb.group(2).lower() == "x"
            label = cb.group(3)
            entry = {
                "line": line_no,
                "done": done,
                "label": label,
                "section": current_section["name"] if current_section else None,
            }
            items.append(entry)
            if current_section:
                current_section["items"].append(entry)
    return {"path": "GOALS.md", "items": items, "sections": sections}


class GoalToggle(BaseModel):
    line: int


@app.post("/api/projects/{name}/goals/toggle")
def api_toggle_goal(name: str, req: GoalToggle):
    """Flip the checkbox on the line at the given index in GOALS.md."""
    base = proj.PROJECTS_ROOT / name
    if not base.exists():
        raise HTTPException(404, "project not found")
    goals_path = base / "GOALS.md"
    if not goals_path.exists():
        raise HTTPException(404, "no GOALS.md")
    import re
    lines = goals_path.read_text(encoding="utf-8").splitlines(keepends=True)
    if req.line < 0 or req.line >= len(lines):
        raise HTTPException(400, "line out of range")
    target = lines[req.line]
    cb = re.match(r"^(\s*[-*]\s*)\[([ xX])\](.+)$", target)
    if not cb:
        raise HTTPException(400, "line is not a checkbox")
    new_state = " " if cb.group(2).lower() == "x" else "x"
    new_line = f"{cb.group(1)}[{new_state}]{cb.group(3)}"
    if not target.endswith("\n"):
        new_line += "\n" if "\n" in "\n".join(lines)[len("\n".join(lines))-1:] else ""
    else:
        new_line += "\n"
    lines[req.line] = new_line
    goals_path.write_text("".join(lines), encoding="utf-8")
    return {"ok": True, "new_state": new_state.strip() or "off"}


class NotifyRequest(BaseModel):
    title: str
    body: str = ""
    sound: bool = False


@app.post("/api/notify")
async def api_notify(req: NotifyRequest):
    """Fire a macOS notification via osascript. Localhost-only is enforced
    by FastAPI's bind to 127.0.0.1; nothing else needed."""
    import asyncio
    title = req.title.strip()[:80]
    body = req.body.strip()[:200]
    if not title:
        raise HTTPException(400, "title required")

    # AppleScript string quoting: double-quote, escape internal " and \
    def aq(s: str) -> str:
        return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'

    parts = [f"display notification {aq(body)} with title {aq(title)}"]
    if req.sound:
        parts.append('sound name "Glass"')
    script = " ".join(parts)
    try:
        proc = await asyncio.create_subprocess_exec(
            "osascript", "-e", script,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        out, err = await proc.communicate()
        return {
            "ok": proc.returncode == 0,
            "stderr": err.decode("utf-8", errors="ignore")[:200] if proc.returncode != 0 else None,
        }
    except FileNotFoundError:
        return {"ok": False, "error": "osascript not available (non-macOS host)"}


@app.get("/api/digest")
def api_digest(days: int = 7):
    """Aggregate stats across all projects for the last N days."""
    import subprocess
    from collections import Counter, defaultdict
    from datetime import datetime, timezone, timedelta
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days))
    cutoff_iso = cutoff.isoformat()
    by_project: dict[str, dict] = {}
    all_subjects: list[dict] = []
    most_changed_files: Counter = Counter()
    for p in proj.list_projects():
        if not p.has_git:
            continue
        # Commit count + subjects
        try:
            log = subprocess.run(
                ["git", "log", f"--since={cutoff_iso}",
                 "--pretty=format:%aI|%s"],
                cwd=p.path, capture_output=True, text=True, timeout=10,
            )
            commits = [
                {"iso": parts[0], "subject": parts[1]}
                for line in log.stdout.splitlines()
                if (parts := line.split("|", 1)) and len(parts) == 2
            ]
        except Exception:
            commits = []
        # Most-touched files
        try:
            stat = subprocess.run(
                ["git", "log", f"--since={cutoff_iso}", "--name-only",
                 "--pretty=format:"],
                cwd=p.path, capture_output=True, text=True, timeout=10,
            )
            for line in stat.stdout.splitlines():
                line = line.strip()
                if line:
                    most_changed_files[f"{p.name}/{line}"] += 1
        except Exception:
            pass
        by_project[p.name] = {
            "commits": len(commits),
            "subjects": [c["subject"] for c in commits[:10]],
            "remote_url": p.remote_url,
        }
        for c in commits:
            all_subjects.append({"project": p.name, **c})

    # Predictions this week (markets)
    pred_count = 0
    outcome_count = 0
    markets_base = proj.PROJECTS_ROOT / "markets"
    pred_dir = markets_base / "data" / "predictions"
    out_dir = markets_base / "data" / "outcomes"
    if pred_dir.exists():
        import json as _json
        for pf in pred_dir.glob("*.json"):
            try:
                d = _json.loads(pf.read_text())
                created = d.get("created_at", "")
                if created and datetime.fromisoformat(created.replace("Z", "+00:00")) > cutoff:
                    pred_count += 1
            except Exception:
                continue
    if out_dir.exists():
        for of in out_dir.glob("*.json"):
            try:
                d = _json.loads(of.read_text())
                resolved = d.get("resolved_at", "")
                if resolved and datetime.fromisoformat(resolved.replace("Z", "+00:00")) > cutoff:
                    outcome_count += 1
            except Exception:
                continue

    # Briefings this week (markets)
    briefings = []
    bdir = markets_base / "vault" / "Daily Briefings"
    if bdir.exists():
        for f in sorted(bdir.glob("[0-9]*.md")):
            try:
                d = datetime.fromisoformat(f.stem)
                if d.replace(tzinfo=timezone.utc) > cutoff:
                    briefings.append(f.stem)
            except (ValueError, TypeError):
                continue

    total_commits = sum(p["commits"] for p in by_project.values())
    busiest = max(by_project.items(), key=lambda x: x[1]["commits"], default=(None, {"commits": 0}))

    return {
        "days": days,
        "since": cutoff_iso,
        "total_commits": total_commits,
        "by_project": by_project,
        "busiest_project": busiest[0] if busiest[1]["commits"] > 0 else None,
        "most_changed_files": [{"path": p, "count": c} for p, c in most_changed_files.most_common(15)],
        "predictions_logged": pred_count,
        "outcomes_resolved": outcome_count,
        "briefings": briefings,
    }


@app.get("/digest")
def page_digest():
    return FileResponse(str(STATIC_DIR / "digest.html"))


@app.get("/api/since")
def api_since(iso: str | None = None):
    """Commits across all projects since the given ISO timestamp."""
    import subprocess
    from datetime import datetime, timezone, timedelta
    if not iso:
        return {"since": None, "matches": [], "by_project": {}}
    try:
        cutoff = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except ValueError:
        return {"since": iso, "matches": [], "by_project": {}, "error": "bad iso"}
    matches: list[dict] = []
    by_project: dict[str, int] = {}
    for p in proj.list_projects():
        if not p.has_git:
            continue
        # Use --since with a clean ISO; git accepts that
        since_str = cutoff.isoformat()
        try:
            r = subprocess.run(
                ["git", "log", f"--since={since_str}",
                 "--pretty=format:%H|%h|%aI|%s", "-n", "100"],
                cwd=p.path, capture_output=True, text=True, timeout=10,
            )
        except Exception:
            continue
        if r.returncode != 0:
            continue
        n = 0
        for line in r.stdout.splitlines():
            parts = line.split("|", 3)
            if len(parts) != 4:
                continue
            sha, short, iso2, subject = parts
            matches.append({
                "project": p.name,
                "sha": sha,
                "short_sha": short,
                "iso": iso2,
                "subject": subject,
                "remote_url": p.remote_url,
            })
            n += 1
        if n:
            by_project[p.name] = n
    matches.sort(key=lambda m: m["iso"], reverse=True)
    return {"since": iso, "matches": matches, "by_project": by_project, "total": len(matches)}


@app.get("/api/search")
def api_search(q: str, limit: int = 50):
    """Full-text grep across commit messages in every project."""
    import subprocess
    if len(q.strip()) < 2:
        return {"q": q, "matches": []}
    matches: list[dict] = []
    for p in proj.list_projects():
        if not p.has_git:
            continue
        try:
            r = subprocess.run(
                ["git", "log", "--all", f"--grep={q}", "-i",
                 "--pretty=format:%H|%h|%aI|%s", "-n", "100"],
                cwd=p.path, capture_output=True, text=True, timeout=10,
            )
        except Exception:
            continue
        if r.returncode != 0:
            continue
        for line in r.stdout.splitlines():
            parts = line.split("|", 3)
            if len(parts) != 4:
                continue
            sha, short, iso, subject = parts
            matches.append({
                "project": p.name,
                "sha": sha,
                "short_sha": short,
                "iso": iso,
                "subject": subject,
                "remote_url": p.remote_url,
            })
    matches.sort(key=lambda m: m["iso"], reverse=True)
    return {"q": q, "matches": matches[:limit], "total": len(matches)}


@app.get("/api/heatmap")
def api_heatmap(weeks: int = 12):
    """Per-day commit count summed across all projects, last N weeks."""
    import subprocess
    from datetime import datetime, timezone, timedelta
    from collections import defaultdict
    cutoff = (datetime.now(timezone.utc) - timedelta(weeks=weeks)).date()
    counts: dict[str, int] = defaultdict(int)
    by_project_day: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    for p in proj.list_projects():
        if not p.has_git:
            continue
        try:
            r = subprocess.run(
                ["git", "log", f"--since={weeks} weeks ago", "--pretty=format:%aI"],
                cwd=p.path, capture_output=True, text=True, timeout=10,
            )
        except Exception:
            continue
        if r.returncode != 0:
            continue
        for line in r.stdout.splitlines():
            try:
                d = datetime.fromisoformat(line.strip().replace("Z", "+00:00")).date()
                if d < cutoff:
                    continue
                counts[d.isoformat()] += 1
                by_project_day[d.isoformat()][p.name] += 1
            except (ValueError, AttributeError):
                continue
    # Build the grid: weeks columns, 7 rows (Sun-Sat or Mon-Sun)
    today = datetime.now(timezone.utc).date()
    days = []
    for i in range(weeks * 7 - 1, -1, -1):
        d = today - timedelta(days=i)
        days.append({
            "date": d.isoformat(),
            "weekday": d.isoweekday() % 7,  # 0=Sun, 6=Sat for SVG layout
            "count": counts.get(d.isoformat(), 0),
            "by_project": dict(by_project_day.get(d.isoformat(), {})),
        })
    total = sum(d["count"] for d in days)
    max_count = max((d["count"] for d in days), default=0)
    return {"days": days, "weeks": weeks, "total": total, "max": max_count}


@app.get("/api/journal")
def api_journal(days: int = 1, date: str | None = None):
    """All commits across all projects in the last N days OR a specific date.

    Pass `date=YYYY-MM-DD` to filter to a single calendar day (UTC).
    Otherwise uses `days` as the rolling window.
    """
    import subprocess
    from datetime import datetime, timezone, timedelta
    if date:
        try:
            day = datetime.strptime(date, "%Y-%m-%d").replace(tzinfo=timezone.utc)
            since = day.isoformat()
            until = (day + timedelta(days=1)).isoformat()
        except ValueError:
            raise HTTPException(400, "bad date format, want YYYY-MM-DD")
        log_args = ["git", "log", f"--since={since}", f"--until={until}",
                    "--pretty=format:%H|%h|%an|%aI|%s|%b%x00"]
    else:
        cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
        log_args = ["git", "log", f"--since={cutoff}",
                    "--pretty=format:%H|%h|%an|%aI|%s|%b%x00"]
    entries: list[dict] = []
    for p in proj.list_projects():
        if not p.has_git:
            continue
        try:
            r = subprocess.run(
                log_args,
                cwd=p.path, capture_output=True, text=True, timeout=15,
            )
        except Exception:
            continue
        if r.returncode != 0:
            continue
        for raw in r.stdout.split("\x00"):
            raw = raw.strip()
            if not raw:
                continue
            parts = raw.split("|", 5)
            if len(parts) < 6:
                continue
            sha, short, author, iso, subject, body = parts
            entries.append({
                "project": p.name,
                "remote_url": p.remote_url,
                "sha": sha,
                "short_sha": short,
                "author": author,
                "iso": iso,
                "subject": subject,
                "body": body.strip(),
            })
    entries.sort(key=lambda e: e["iso"], reverse=True)
    return {"entries": entries, "since_days": days, "date_filter": date}


@app.get("/journal")
def page_journal():
    return FileResponse(str(STATIC_DIR / "journal.html"))


_markets_cache: dict[str, tuple[float, dict]] = {}
_MARKETS_TTL = 30.0  # seconds — prices only change ~once/day, can cache aggressively


def _markets_cached(key: str, compute):
    import time as _t
    now = _t.time()
    hit = _markets_cache.get(key)
    if hit and (now - hit[0]) < _MARKETS_TTL:
        return hit[1]
    val = compute()
    _markets_cache[key] = (now, val)
    return val


@app.get("/api/markets/cumulative_returns")
def api_markets_cumulative_returns(days: int = 252):
    """Cumulative return series per ticker, rebased to 100. For comparison plot.

    Cached for 30s — walks 25 CSVs which is the slowest endpoint on this page."""
    return _markets_cached(f"cumret:{days}", lambda: _compute_cumret(days))


def _compute_cumret(days: int):
    import csv as _csv
    from datetime import datetime, timezone, timedelta
    base = proj.PROJECTS_ROOT / "markets" / "data" / "raw" / "prices"
    if not base.exists():
        return {"series": []}
    cutoff = datetime.now(timezone.utc).date() - timedelta(days=days)
    series = []
    for csv_path in base.glob("*.csv"):
        rows: list[tuple[str, float]] = []
        try:
            with open(csv_path, newline="") as f:
                for r in _csv.DictReader(f):
                    try:
                        d = datetime.fromisoformat(r["date"].split(" ")[0]).date()
                    except (ValueError, KeyError):
                        continue
                    if d < cutoff:
                        continue
                    try:
                        close = float(r.get("close") or 0)
                    except ValueError:
                        continue
                    if close > 0:
                        rows.append((d.isoformat(), close))
        except OSError:
            continue
        if len(rows) < 5:
            continue
        rows.sort(key=lambda r: r[0])
        first = rows[0][1]
        normalized = [{"date": d, "rebased": round(c / first * 100, 2)} for d, c in rows]
        last = rows[-1][1]
        series.append({
            "ticker": csv_path.stem,
            "points": normalized,
            "total_return_pct": round((last - first) / first * 100, 2),
        })
    series.sort(key=lambda s: -s["total_return_pct"])
    return {"series": series, "days": days}


@app.get("/api/markets/analytics")
def api_markets_analytics():
    """Read pre-computed analytics from data/processed/analytics.json."""
    import json as _json
    base = proj.PROJECTS_ROOT / "markets" / "data" / "processed"
    out = {"analytics": {}, "correlations": {}, "sectors": {}, "as_of": None}
    for key, fname in [("analytics", "analytics.json"), ("correlations", "correlations.json"), ("sectors", "sectors.json")]:
        p = base / fname
        if p.exists():
            try:
                d = _json.loads(p.read_text())
                if key == "analytics":
                    out["analytics"] = d.get("tickers", {})
                    out["as_of"] = d.get("as_of")
                elif key == "correlations":
                    out["correlations"] = d.get("matrix", {})
                else:
                    out["sectors"] = d.get("sectors", {})
            except Exception:
                pass
    return out


@app.get("/api/markets/ticker/{symbol}")
def api_markets_ticker(symbol: str, days: int = 90):
    """Full per-ticker drill-down: OHLC + volume + ticker-tagged news +
    recent filings + open predictions.
    """
    import csv as _csv
    import json as _json
    from datetime import datetime, timezone, timedelta
    base = proj.PROJECTS_ROOT / "markets"
    symbol = symbol.upper()
    if not symbol.replace(".", "").replace("-", "").isalnum():
        raise HTTPException(400, "bad symbol")

    # OHLC series
    csv_path = base / "data" / "raw" / "prices" / f"{symbol}.csv"
    cutoff = datetime.now(timezone.utc).date() - timedelta(days=days)
    series: list[dict] = []
    if csv_path.exists():
        try:
            with open(csv_path, newline="") as f:
                for r in _csv.DictReader(f):
                    try:
                        d = datetime.fromisoformat(r["date"].split(" ")[0]).date()
                    except (ValueError, KeyError):
                        continue
                    if d < cutoff:
                        continue
                    try:
                        series.append({
                            "date": d.isoformat(),
                            "open": float(r.get("open") or 0),
                            "high": float(r.get("high") or 0),
                            "low": float(r.get("low") or 0),
                            "close": float(r.get("close") or 0),
                            "volume": int(float(r.get("volume") or 0)),
                        })
                    except (ValueError, TypeError):
                        continue
        except OSError:
            pass
    series.sort(key=lambda r: r["date"])

    # News items mentioning this ticker
    news_path = base / "data" / "processed" / "news_latest.jsonl"
    news_items: list[dict] = []
    if news_path.exists():
        for line in news_path.read_text().splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                item = _json.loads(line)
                if symbol in (item.get("tickers_mentioned") or []):
                    news_items.append(item)
            except _json.JSONDecodeError:
                continue
    news_items.sort(key=lambda i: i.get("published") or i.get("ingested_at", ""), reverse=True)

    # Filings for this ticker
    filings_path = base / "data" / "processed" / "filings_index.csv"
    filings: list[dict] = []
    if filings_path.exists():
        try:
            with open(filings_path, newline="") as f:
                for r in _csv.DictReader(f):
                    if r.get("ticker") == symbol:
                        filings.append(r)
        except OSError:
            pass
    filings.sort(key=lambda r: r.get("filing_date", ""), reverse=True)

    # Predictions for this ticker
    predictions: list[dict] = []
    pred_dir = base / "data" / "predictions"
    if pred_dir.exists():
        for p in sorted(pred_dir.glob("*.json"), reverse=True):
            try:
                d = _json.loads(p.read_text())
                if d.get("ticker") == symbol:
                    predictions.append(d)
            except Exception:
                continue

    # Compute summary stats
    summary = {}
    if series:
        first = series[0]
        last = series[-1]
        highest = max(r["high"] for r in series)
        lowest = min(r["low"] for r in series)
        avg_vol = sum(r["volume"] for r in series) / len(series)
        summary = {
            "first_close": round(first["close"], 2),
            "last_close": round(last["close"], 2),
            "pct_change": round((last["close"] - first["close"]) / first["close"] * 100, 2) if first["close"] else 0,
            "high": round(highest, 2),
            "low": round(lowest, 2),
            "avg_volume": int(avg_vol),
            "n_days": len(series),
        }

    return {
        "ticker": symbol,
        "summary": summary,
        "series": series,
        "news": news_items[:30],
        "filings": filings[:20],
        "predictions": predictions,
    }


@app.get("/ticker/{symbol}")
def page_ticker(symbol: str):
    return FileResponse(str(STATIC_DIR / "ticker.html"))


@app.get("/api/markets/prices")
def api_markets_prices(top: int = 8, days: int = 30):
    """Cached 30s. Walks 25 CSVs to pick top movers."""
    return _markets_cached(f"prices:{top}:{days}", lambda: _compute_prices(top, days))


def _compute_prices(top: int = 8, days: int = 30):
    """Return recent price series for the top-N most-volatile watchlist tickers.

    Reads each ticker's CSV in data/raw/prices/, picks the top N by recent
    absolute pct change, returns normalized series (each ticker rebased to
    100 at the first day in window) so they can share one chart.
    """
    import csv as _csv
    from datetime import datetime, timezone, timedelta
    base = proj.PROJECTS_ROOT / "markets" / "data" / "raw" / "prices"
    if not base.exists():
        return {"tickers": [], "series": [], "days": days}
    cutoff = datetime.now(timezone.utc).date() - timedelta(days=days)
    series_by_ticker: dict[str, list[dict]] = {}
    for csv_path in base.glob("*.csv"):
        rows: list[dict] = []
        try:
            with open(csv_path, newline="") as f:
                for r in _csv.DictReader(f):
                    try:
                        d = datetime.fromisoformat(r["date"].split(" ")[0]).date()
                    except (ValueError, KeyError):
                        continue
                    if d < cutoff:
                        continue
                    try:
                        close = float(r.get("close") or 0)
                    except ValueError:
                        continue
                    if close <= 0:
                        continue
                    rows.append({"date": d.isoformat(), "close": close})
        except OSError:
            continue
        if rows:
            rows.sort(key=lambda r: r["date"])
            series_by_ticker[csv_path.stem] = rows

    # Score each ticker by absolute pct change over the window for "most-active" sort
    scored = []
    for ticker, rows in series_by_ticker.items():
        if len(rows) < 2:
            continue
        first = rows[0]["close"]
        last = rows[-1]["close"]
        if first <= 0:
            continue
        pct = (last - first) / first * 100.0
        scored.append((ticker, abs(pct), pct, rows))
    scored.sort(key=lambda x: -x[1])
    top_pick = scored[:top]

    # Re-read OHLC for top picks (we only kept close before)
    import csv as _csv
    out_series = []
    all_dates: set[str] = set()
    for ticker, abs_pct, signed_pct, rows in top_pick:
        ohlc_rows: list[dict] = []
        csv_path = base / f"{ticker}.csv"
        if csv_path.exists():
            try:
                with open(csv_path, newline="") as f:
                    for r in _csv.DictReader(f):
                        try:
                            d = datetime.fromisoformat(r["date"].split(" ")[0]).date()
                            if d < cutoff:
                                continue
                            ohlc_rows.append({
                                "date": d.isoformat(),
                                "open": float(r.get("open") or 0),
                                "high": float(r.get("high") or 0),
                                "low": float(r.get("low") or 0),
                                "close": float(r.get("close") or 0),
                                "volume": int(float(r.get("volume") or 0)),
                            })
                        except (ValueError, KeyError):
                            continue
            except OSError:
                pass
        ohlc_rows.sort(key=lambda r: r["date"])
        first = rows[0]["close"]
        normalized = [{"date": r["date"], "rebased": r["close"] / first * 100.0,
                       "raw": r["close"]} for r in rows]
        out_series.append({
            "ticker": ticker,
            "pct_change": round(signed_pct, 2),
            "first_close": round(first, 2),
            "last_close": round(rows[-1]["close"], 2),
            "points": normalized,
            "ohlc": ohlc_rows,
        })
        for r in rows:
            all_dates.add(r["date"])

    return {
        "tickers": [s["ticker"] for s in out_series],
        "series": out_series,
        "days": days,
        "date_range": [min(all_dates), max(all_dates)] if all_dates else [],
    }


@app.get("/api/markets/reliability")
def api_markets_reliability(demo: bool = False):
    """Reliability diagram data: bin predictions by confidence, compute hit rate per bin."""
    import json as _json
    base = proj.PROJECTS_ROOT / "markets"
    out_dir = base / "data" / "outcomes"
    points: list[dict] = []
    if out_dir.exists() and not demo:
        for p in sorted(out_dir.glob("*.json")):
            try:
                d = _json.loads(p.read_text())
                points.append({"confidence": d.get("confidence", 0), "correct": bool(d.get("correct"))})
            except Exception:
                continue
    if not points and demo:
        import random as _random
        _random.seed(7)
        for _ in range(80):
            c = _random.choice([55, 60, 65, 70, 75, 80, 85, 90, 95])
            correct = _random.random() < (c / 100 + _random.uniform(-0.06, 0.06))
            points.append({"confidence": c, "correct": correct})

    # 5-percent bins from 50 to 100
    bins: dict[int, dict] = {}
    for lo in range(50, 100, 5):
        bins[lo] = {"lo": lo, "hi": lo + 5, "n": 0, "correct": 0}
    for p in points:
        c = p["confidence"]
        bin_lo = (c // 5) * 5
        if bin_lo not in bins:
            continue
        bins[bin_lo]["n"] += 1
        if p["correct"]:
            bins[bin_lo]["correct"] += 1
    out_bins = []
    for lo, b in bins.items():
        if b["n"] == 0:
            continue
        out_bins.append({
            "bin_lo": b["lo"],
            "bin_hi": b["hi"],
            "midpoint": b["lo"] + 2.5,
            "n": b["n"],
            "hit_rate": round(b["correct"] / b["n"] * 100, 1),
        })
    return {
        "bins": out_bins,
        "total": len(points),
        "demo": demo or not (out_dir.exists() and any(out_dir.glob("*.json"))),
    }


@app.get("/api/markets/prediction_chart")
def api_markets_prediction_chart(demo: bool = False):
    """Return time-series of prediction confidence vs eventual outcome.

    Real mode: reads data/outcomes/*.json (resolved predictions only) and
    plots them as (resolved_at, confidence, correct boolean).

    Demo mode: synthesizes 30 sample predictions to illustrate the layout
    when no real predictions exist yet. Clearly flagged so the UI can
    label it.
    """
    import json as _json
    base = proj.PROJECTS_ROOT / "markets"
    out_dir = base / "data" / "outcomes"
    points: list[dict] = []
    if out_dir.exists() and not demo:
        for p in sorted(out_dir.glob("*.json")):
            try:
                d = _json.loads(p.read_text())
            except Exception:
                continue
            points.append({
                "id": d.get("id", p.stem),
                "ticker": d.get("ticker", ""),
                "resolved_at": d.get("resolved_at", ""),
                "confidence": d.get("confidence", 0),
                "correct": bool(d.get("correct")),
            })

    if not points and demo:
        # Synthetic data for the demo: 30 predictions varying in confidence,
        # with hit-rate roughly proportional to confidence (a well-calibrated
        # forecaster). Some noise for realism.
        import random as _random
        from datetime import datetime, timezone, timedelta
        _random.seed(42)
        demo_tickers = ["TSLA", "RIVN", "GM", "F", "CHPT", "QS", "WOLF"]
        now = datetime.now(timezone.utc)
        for i in range(30):
            confidence = _random.choice([55, 60, 65, 70, 75, 80, 85, 90])
            correct = _random.random() < (confidence / 100 + _random.uniform(-0.08, 0.08))
            resolved = now - timedelta(days=30 - i, hours=_random.randint(0, 23))
            points.append({
                "id": f"demo-{i}",
                "ticker": _random.choice(demo_tickers),
                "resolved_at": resolved.isoformat(),
                "confidence": confidence,
                "correct": correct,
            })

    # Compute rolling Brier (window of last 10) and rolling hit rate
    if points:
        points.sort(key=lambda p: p.get("resolved_at", ""))
        rolling = []
        window = 10
        for i, p in enumerate(points):
            sub = points[max(0, i - window + 1):i + 1]
            sse = sum(((q["confidence"] / 100) - (1 if q["correct"] else 0)) ** 2 for q in sub)
            brier = sse / len(sub)
            hit_rate = sum(1 for q in sub if q["correct"]) / len(sub)
            rolling.append({
                "resolved_at": p["resolved_at"],
                "brier": round(brier, 4),
                "hit_rate": round(hit_rate * 100, 1),
                "window_size": len(sub),
            })
    else:
        rolling = []

    return {
        "points": points,
        "rolling": rolling,
        "demo": demo or (not (out_dir.exists() and any(out_dir.glob("*.json")))),
        "total": len(points),
    }


@app.get("/api/markets/briefing/{date}")
def api_markets_briefing(date: str):
    """Return the markdown content for a specific daily briefing.
    Path-traversal-safe: only accepts YYYY-MM-DD."""
    import re as _re
    if not _re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
        return {"date": date, "exists": False, "markdown": "", "error": "bad date"}
    base = proj.PROJECTS_ROOT / "markets" / "vault" / "Daily Briefings"
    path = base / f"{date}.md"
    if not path.exists():
        return {"date": date, "exists": False, "markdown": ""}
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as e:
        return {"date": date, "exists": False, "markdown": "", "error": str(e)}
    return {"date": date, "exists": True, "markdown": text[:200_000]}


@app.get("/api/markets/briefings")
def api_markets_briefings(days: int = 14):
    """Return per-day briefing existence map for the markets project."""
    from datetime import datetime, timezone, timedelta
    base = proj.PROJECTS_ROOT / "markets" / "vault" / "Daily Briefings"
    if not base.exists():
        return {"days": [], "total": 0}
    today = datetime.now(timezone.utc).date()
    out = []
    total = 0
    for i in range(days - 1, -1, -1):
        d = today - timedelta(days=i)
        date_str = d.isoformat()
        path = base / f"{date_str}.md"
        exists = path.exists()
        size = path.stat().st_size if exists else 0
        # Detect TBD status: file exists but still has _TBD_ markers
        has_tbd = False
        if exists:
            try:
                text = path.read_text(encoding="utf-8")
                has_tbd = "_TBD_" in text or "_TBD —" in text
            except OSError:
                pass
        out.append({
            "date": date_str,
            "weekday": d.strftime("%a"),
            "is_weekend": d.isoweekday() >= 6,
            "is_today": d == today,
            "exists": exists,
            "size": size,
            "has_tbd": has_tbd,
        })
        if exists:
            total += 1
    return {"days": out, "total": total, "window": days}


@app.get("/api/predictions")
def api_predictions():
    """List every prediction (markets project)."""
    import json as _json
    base = proj.PROJECTS_ROOT / "markets"
    pred_dir = base / "data" / "predictions"
    out_dir = base / "data" / "outcomes"
    if not pred_dir.exists():
        return {"predictions": [], "outcomes": [], "buckets": {}}
    preds: list[dict] = []
    for p in sorted(pred_dir.glob("*.json"), reverse=True):
        try:
            d = _json.loads(p.read_text())
            preds.append(d)
        except Exception:
            continue
    outcomes: list[dict] = []
    if out_dir.exists():
        for p in out_dir.glob("*.json"):
            try:
                outcomes.append(_json.loads(p.read_text()))
            except Exception:
                continue
    by_id_outcome = {o.get("id"): o for o in outcomes}
    for pred in preds:
        pred["outcome"] = by_id_outcome.get(pred.get("id"))
    # Bucket the resolutions; track sum-of-squared-errors per bucket for Brier
    buckets: dict[str, dict] = {
        "55-64": {"correct": 0, "total": 0, "sse": 0.0},
        "65-74": {"correct": 0, "total": 0, "sse": 0.0},
        "75-84": {"correct": 0, "total": 0, "sse": 0.0},
        "85-94": {"correct": 0, "total": 0, "sse": 0.0},
        "95+":   {"correct": 0, "total": 0, "sse": 0.0},
    }
    overall_sse = 0.0
    overall_n = 0
    for o in outcomes:
        c = o.get("confidence", 0)
        key = "55-64" if c < 65 else "65-74" if c < 75 else "75-84" if c < 85 else "85-94" if c < 95 else "95+"
        forecast = c / 100.0
        outcome_val = 1.0 if o.get("correct") else 0.0
        sse_term = (forecast - outcome_val) ** 2
        buckets[key]["total"] += 1
        buckets[key]["sse"] += sse_term
        if o.get("correct"):
            buckets[key]["correct"] += 1
        overall_sse += sse_term
        overall_n += 1
    # Compute Brier per bucket
    for k, v in buckets.items():
        v["brier"] = (v["sse"] / v["total"]) if v["total"] else None
    overall_brier = (overall_sse / overall_n) if overall_n else None
    return {
        "predictions": preds,
        "outcomes": outcomes,
        "buckets": buckets,
        "overall_brier": overall_brier,
        "overall_n": overall_n,
    }


@app.get("/predictions")
def page_predictions():
    return FileResponse(str(STATIC_DIR / "predictions.html"))


@app.get("/api/now")
def api_now():
    """One-stop 'what's happening / what's next' summary."""
    import json as _json
    from datetime import datetime, timezone, timedelta
    snap_path = REPO_ROOT / "data" / "routines_snapshot.json"
    next_routine = None
    routines_stale = None
    if snap_path.exists():
        try:
            snap = _json.loads(snap_path.read_text())
            now = datetime.now(timezone.utc)
            routines_stale = _snapshot_stale(snap, now)
            candidates = []
            for r in snap.get("routines", []):
                if not r.get("enabled") or not r.get("next_run_at"):
                    continue
                try:
                    dt = datetime.fromisoformat(r["next_run_at"].replace("Z", "+00:00"))
                    if dt > now:
                        candidates.append((dt, r))
                except (ValueError, KeyError):
                    pass
            if candidates:
                candidates.sort(key=lambda x: x[0])
                dt, r = candidates[0]
                next_routine = {
                    "name": r["name"],
                    "project": r["project"],
                    "next_run_at": r["next_run_at"],
                    "seconds_until": int((dt - now).total_seconds()),
                    "blocked": r.get("status", "").startswith("WILL_FAIL"),
                    "purpose": r.get("purpose", ""),
                }
        except Exception:
            pass
    # Top "next up" goals across projects
    next_goals = []
    for p in proj.list_projects():
        goals_path = Path(p.path) / "GOALS.md"
        if not goals_path.exists():
            continue
        try:
            text = goals_path.read_text(encoding="utf-8")
        except OSError:
            continue
        import re
        for line in text.splitlines():
            m = re.match(r"^\s*[-*]\s*\[\s\]\s*(.+?)\s*$", line)
            if m:
                next_goals.append({"project": p.name, "goal": m.group(1)})
                break
    return {
        "next_routine": next_routine,
        "next_goals": next_goals[:4],
        "routines_stale": routines_stale,
    }


def _snapshot_stale(snap: dict, now, max_age_days: float = 7.0) -> dict | None:
    """The routines snapshot is hand-captured; when it's old every countdown
    it produces is a lie. Returns {captured_at, age_days} once it crosses
    the threshold, else None."""
    from datetime import datetime as _dt
    captured = snap.get("captured_at")
    if not captured:
        return {"captured_at": None, "age_days": None}
    try:
        dt = _dt.fromisoformat(str(captured).replace("Z", "+00:00"))
    except ValueError:
        return {"captured_at": captured, "age_days": None}
    age_days = (now - dt).total_seconds() / 86400
    if age_days < max_age_days:
        return None
    return {"captured_at": captured, "age_days": round(age_days, 1)}


@app.get("/api/today")
def api_today():
    """Per-project counts for the current local day (America/Toronto).

    "Today" means the date as seen by the user, not UTC — otherwise late-night
    work in ET shows up as zero because UTC has rolled over.
    """
    from datetime import datetime, timezone
    from zoneinfo import ZoneInfo
    LOCAL_TZ = ZoneInfo("America/Toronto")
    now_utc = datetime.now(timezone.utc)
    local_date = now_utc.astimezone(LOCAL_TZ).date()
    summary = {
        "date": local_date.isoformat(),
        "totals": {"commits": 0, "files": 0, "predictions": 0},
        "by_project": [],
    }
    for p in proj.list_projects():
        commits_today = 0
        for c in p.recent_commits:
            try:
                dt = datetime.fromisoformat(c.date_iso.replace("Z", "+00:00"))
                local_dt = dt.astimezone(LOCAL_TZ)
                if local_dt.date() == local_date:
                    commits_today += 1
            except (ValueError, AttributeError):
                pass
        files_today = 0
        if p.last_modified_file and p.last_modified_file.age_seconds < 86400:
            try:
                dt = datetime.fromisoformat(p.last_modified_file.modified_iso)
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                local_dt = dt.astimezone(LOCAL_TZ)
                if local_dt.date() == local_date:
                    files_today = 1
            except ValueError:
                pass
        preds_today = 0
        if p.name == "markets":
            pred_dir = Path(p.path) / "data" / "predictions"
            if pred_dir.exists():
                for pf in pred_dir.glob("*.json"):
                    if pf.name.startswith(local_date.isoformat()) or pf.name.startswith(now_utc.date().isoformat()):
                        preds_today += 1
        summary["by_project"].append({
            "project": p.name,
            "commits": commits_today,
            "files": files_today,
            "predictions": preds_today,
        })
        summary["totals"]["commits"] += commits_today
        summary["totals"]["files"] += files_today
        summary["totals"]["predictions"] += preds_today
    return summary


class ExecRequest(BaseModel):
    project: str
    action: str


@app.post("/api/exec")
async def api_exec(req: ExecRequest):
    if req.action not in ex.actions_for(req.project):
        raise HTTPException(status_code=400, detail=f"unknown action: {req.action}")
    return await ex.run_action(req.project, req.action)


class PredictionRequest(BaseModel):
    ticker: str
    direction: str
    horizon: str
    confidence: int
    reasoning: str
    invalidation: list[str]
    sources: list[str] = []
    slug: str = "prediction"


@app.post("/api/log_prediction")
async def api_log_prediction(req: PredictionRequest):
    """Run log_prediction.py --non-interactive in the markets project."""
    import asyncio
    cwd = proj.PROJECTS_ROOT / "markets"
    if not cwd.exists():
        raise HTTPException(status_code=404, detail="markets project not found")
    argv = ex.run_log_prediction(req.model_dump())
    ex._append_log(f"$ (markets) log_prediction.py --non-interactive --ticker {req.ticker} --confidence {req.confidence}%")
    proc = await asyncio.create_subprocess_exec(
        *argv,
        cwd=str(cwd),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    stdout, _ = await proc.communicate()
    output = stdout.decode("utf-8", errors="ignore") if stdout else ""
    for line in output.splitlines():
        if line.strip():
            ex._append_log(line)
    ex._append_log(f"# exit {proc.returncode}")
    return {"ok": proc.returncode == 0, "exit_code": proc.returncode, "output": output}


@app.get("/api/projects/{name}/actions")
def api_actions(name: str):
    return ex.actions_for(name)


@app.get("/api/running")
def api_running():
    """Snapshot of currently-running exec actions."""
    return {"running": ex.running_actions()}


@app.get("/api/recent_runs")
def api_recent_runs():
    """Last 100 completed exec actions."""
    return {"runs": ex.recent_actions()}


# ---- services (manifest-declared) ----

@app.get("/api/services")
def api_services():
    """Every project whose manifest declares a port → health row."""
    out = []
    for p in proj.list_projects():
        m = p.manifest
        if not m or not m.get("port"):
            continue
        out.append({
            "name": p.name,
            "kind": m.get("kind"),
            "status": m.get("status"),
            "port": m["port"],
            "up": p.service_up,
            "can_start": bool(m.get("start")),
            "links": m.get("links", []),
        })
    return {"services": out}


@app.post("/api/services/{name}/start")
def api_service_start(name: str):
    result = ex.start_service(name)
    if not result.get("ok"):
        raise HTTPException(status_code=400, detail=result.get("error", "failed"))
    proj.invalidate_caches()
    return result


# ---- reef integration (agent runs per repo, dispatch) ----

@app.get("/api/reef/summary")
def api_reef_summary():
    from . import reef
    if not reef.alive():
        return {"alive": False}
    return {
        "alive": True,
        "web_url": reef.REEF_WEB,
        "today": reef.usage_summary("day"),
        "week": reef.usage_summary("week"),
    }


@app.get("/api/projects/{name}/reef")
def api_project_reef(name: str):
    from . import reef
    p = proj.get_one(name)
    if p is None:
        raise HTTPException(status_code=404, detail="not found")
    if not reef.alive():
        return {"alive": False}
    learnings = reef.learnings_for_repo(p.path)
    by_layer: dict[str, int] = {}
    for l in learnings:
        by_layer[l.get("layer", "?")] = by_layer.get(l.get("layer", "?"), 0) + 1
    return {
        "alive": True,
        "web_url": reef.REEF_WEB,
        "runs": reef.runs_for_repo(p.path),
        "learnings_count": len(learnings),
        "learnings_by_layer": by_layer,
    }


class ReefDispatchRequest(BaseModel):
    prompt: str
    model: str | None = None


@app.post("/api/projects/{name}/reef/dispatch")
def api_project_reef_dispatch(name: str, req: ReefDispatchRequest):
    from . import reef
    p = proj.get_one(name)
    if p is None:
        raise HTTPException(status_code=404, detail="not found")
    if not req.prompt.strip():
        raise HTTPException(status_code=400, detail="empty prompt")
    result = reef.dispatch_run(p.path, req.prompt.strip(), req.model)
    if result is None:
        raise HTTPException(status_code=502, detail="reef daemon unreachable on :3738")
    if result.get("error"):
        raise HTTPException(status_code=502, detail=str(result["error"]))
    ex._append_log(f"$ ({name}) reef dispatch: {req.prompt.strip()[:80]}")
    return {"ok": True, "run": result, "web_url": reef.REEF_WEB}


@app.get("/stack")
def page_stack():
    return FileResponse(str(STATIC_DIR / "stack.html"))


@app.get("/api/stack")
def api_stack():
    """Return CAPABILITIES.md + headline metrics for every project,
    side-by-side ready."""
    out = []
    for p in proj.list_projects():
        path = proj.PROJECTS_ROOT / p.name / "CAPABILITIES.md"
        capabilities = ""
        if path.exists():
            try:
                capabilities = path.read_text(encoding="utf-8")[:60_000]
            except OSError:
                pass
        out.append({
            "name": p.name,
            "framework": p.framework,
            "summary": p.summary,
            "momentum": p.momentum,
            "commit_count": p.commit_count,
            "file_count": p.file_count,
            "remote_url": p.remote_url,
            "insights": p.insights[:6],
            "capabilities": capabilities,
        })
    return {"projects": out}


@app.get("/api/projects/{name}/readme")
def api_readme(name: str):
    """Return the project's README.md content."""
    base = proj.PROJECTS_ROOT / name
    if not base.exists():
        raise HTTPException(404, "project not found")
    p = base / "README.md"
    if not p.exists():
        return {"path": None, "markdown": ""}
    try:
        return {"path": "README.md", "markdown": p.read_text(encoding="utf-8")[:80_000]}
    except OSError:
        return {"path": None, "markdown": ""}


@app.get("/api/projects/{name}/capabilities")
def api_capabilities(name: str):
    """Return CAPABILITIES.md as markdown text. Empty if missing."""
    base = proj.PROJECTS_ROOT / name
    if not base.exists():
        raise HTTPException(404, "project not found")
    p = base / "CAPABILITIES.md"
    if not p.exists():
        return {"path": None, "markdown": ""}
    try:
        return {"path": "CAPABILITIES.md", "markdown": p.read_text(encoding="utf-8")[:80_000]}
    except OSError:
        return {"path": None, "markdown": ""}


@app.get("/project/{name}")
def page_project(name: str):
    return FileResponse(str(STATIC_DIR / "project.html"))


@app.get("/routines")
def page_routines():
    return FileResponse(str(STATIC_DIR / "routines.html"))


@app.get("/api/routines")
def api_routines():
    """Return the routines snapshot file plus computed time-to-fire."""
    import json
    from datetime import datetime, timezone
    snap_path = REPO_ROOT / "data" / "routines_snapshot.json"
    if not snap_path.exists():
        return {"captured_at": None, "routines": [], "alert": None}
    data = json.loads(snap_path.read_text())
    now = datetime.now(timezone.utc)
    data["stale"] = _snapshot_stale(data, now)
    for r in data.get("routines", []):
        nra = r.get("next_run_at")
        if not nra:
            r["seconds_until_fire"] = None
            continue
        try:
            dt = datetime.fromisoformat(nra.replace("Z", "+00:00"))
            r["seconds_until_fire"] = int((dt - now).total_seconds())
        except (ValueError, TypeError):
            r["seconds_until_fire"] = None
    return data


@app.get("/api/projects/{name}/preview")
def api_preview(name: str):
    """Return the most-relevant preview file for this project as markdown text.

    Markets: latest daily briefing.
    Others: README.md.
    """
    base = proj.PROJECTS_ROOT / name
    if not base.exists():
        raise HTTPException(404, "project not found")
    candidates: list[Path] = []
    bdir = base / "vault" / "Daily Briefings"
    if bdir.exists():
        candidates += sorted(bdir.glob("[0-9]*.md"), reverse=True)
    candidates += [base / "README.md"]
    for c in candidates:
        if c.exists() and c.is_file():
            try:
                return {"path": c.name, "markdown": c.read_text(encoding="utf-8")[:50_000]}
            except OSError:
                continue
    return {"path": None, "markdown": ""}


@app.get("/api/stream/projects")
async def stream_projects():
    return StreamingResponse(
        streams.project_change_stream(),
        media_type="text/event-stream",
    )


@app.get("/api/stream/log")
async def stream_log():
    return StreamingResponse(
        streams.log_tail_stream(),
        media_type="text/event-stream",
    )


# ----- Classroom -----

@app.get("/classroom")
def page_classroom():
    return FileResponse(str(STATIC_DIR / "classroom.html"))


@app.get("/classroom/student/{name}")
def page_classroom_student(name: str):
    return FileResponse(str(STATIC_DIR / "classroom_student.html"))


@app.get("/api/classroom/overview")
def api_classroom_overview():
    return cls.overview()


@app.get("/api/classroom/leaderboard")
def api_classroom_leaderboard(limit: int = 50):
    return {"students": cls.leaderboard(limit=limit), "unresolved": cls.unresolved_students()}


@app.get("/api/classroom/by_technique")
def api_classroom_by_technique():
    return {"techniques": cls.by_technique()}


@app.get("/api/classroom/students/{name}")
def api_classroom_student(name: str):
    d = cls.student_detail(name)
    if d is None:
        raise HTTPException(404, "student not found")
    return d


@app.get("/api/classroom/hall_of_fame")
def api_classroom_hof(limit: int = 50):
    return {"entries": cls.hall_entries("fame", limit=limit)}


@app.get("/api/classroom/wall_of_shame")
def api_classroom_wos(limit: int = 50):
    return {"entries": cls.hall_entries("shame", limit=limit)}


@app.get("/api/classroom/usage")
def api_classroom_usage(days: int = 14):
    return cls.usage_summary(days=days)


@app.get("/api/classroom/latest_predictions")
def api_classroom_latest(limit: int = 50):
    return {"predictions": cls.latest_predictions(limit=limit)}


@app.get("/api/classroom/projections")
def api_classroom_projections():
    return cls.projections()


# ----- Short-term cohort / Live sessions -----

@app.get("/classroom/live")
def page_classroom_live():
    return FileResponse(str(STATIC_DIR / "classroom_live.html"))


@app.get("/api/classroom/live/status")
def api_st_status():
    return {**st.is_ready(), **st.session_status()}


class StartSessionBody(BaseModel):
    symbols: list[str] | None = None
    provider: str = "mock"
    scenario: str = "random_walk"


@app.post("/api/classroom/live/start")
async def api_st_start(body: StartSessionBody):
    return await st.start_session(
        symbols=body.symbols,
        provider=body.provider,
        scenario=body.scenario,
    )


@app.post("/api/classroom/live/stop")
def api_st_stop():
    return st.stop_session()


@app.get("/api/classroom/live/grid")
def api_st_grid():
    return st.latest_grid_state()


@app.get("/api/classroom/live/student/{name}")
def api_st_student(name: str):
    d = st.student_detail(name)
    if d is None:
        raise HTTPException(404, "student not found")
    return d


@app.get("/api/classroom/live/alpaca_check")
def api_st_alpaca():
    return st.alpaca_check()


@app.get("/api/classroom/live/leaderboard")
def api_st_leaderboard():
    return st.technique_leaderboard()


@app.get("/api/classroom/live/sessions")
def api_st_sessions(limit: int = 20):
    return st.list_sessions(limit=limit)


@app.get("/api/classroom/live/session/{session_id}")
def api_st_session_detail(session_id: str):
    d = st.session_detail(session_id)
    if d is None:
        raise HTTPException(404, "session not found")
    return d


@app.get("/classroom/live/sessions/{session_id}")
def page_classroom_session(session_id: str):
    return FileResponse(str(STATIC_DIR / "classroom_session.html"))


@app.get("/api/classroom/live/top_bottom")
def api_st_top_bottom(n: int = 5):
    return st.top_bottom_students(n=n)


@app.get("/api/classroom/live/regimes")
def api_st_regimes():
    return st.per_symbol_regimes()


@app.websocket("/ws/classroom/live")
async def ws_classroom_live(ws: WebSocket):
    await ws.accept()
    queue: asyncio.Queue = asyncio.Queue(maxsize=500)
    st.subscribe(queue)
    try:
        # Send initial grid snapshot
        await ws.send_json({"type": "grid", "data": st.latest_grid_state()})
        while True:
            event = await queue.get()
            await ws.send_json(event)
    except WebSocketDisconnect:
        pass
    finally:
        st.unsubscribe(queue)


@app.get("/api/classroom/learning_lab")
def api_classroom_learning_lab():
    return cls.learning_lab()


app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/")
def root():
    return FileResponse(str(STATIC_DIR / "index.html"))
