"""Cross-project activity feed: most recent commits and file changes."""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from . import projects as proj_mod


def recent_activity(limit: int = 30) -> list[dict]:
    """Combine commits across all projects into a single chronological feed."""
    items: list[dict] = []
    for p in proj_mod.list_projects():
        for c in p.recent_commits:
            items.append({
                "kind": "commit",
                "project": p.name,
                "title": c.subject,
                "subtitle": f"{c.short_sha} · {c.author}",
                "iso": c.date_iso,
                "age_seconds": c.age_seconds,
                "url": _commit_url(p.remote_url, c.sha),
            })
        if p.last_modified_file and p.last_modified_file.age_seconds < 6 * 3600:
            items.append({
                "kind": "file",
                "project": p.name,
                "title": f"Edited {p.last_modified_file.path}",
                "subtitle": f"{p.last_modified_file.size_bytes} bytes",
                "iso": p.last_modified_file.modified_iso,
                "age_seconds": p.last_modified_file.age_seconds,
                "url": None,
            })
    items.sort(key=lambda i: i["age_seconds"])
    return items[:limit]


def _commit_url(remote: str | None, sha: str) -> str | None:
    if not remote:
        return None
    if remote.startswith("git@github.com:"):
        path = remote.replace("git@github.com:", "").removesuffix(".git")
        return f"https://github.com/{path}/commit/{sha}"
    if remote.startswith("https://github.com/"):
        return f"{remote.removesuffix('.git')}/commit/{sha}"
    return None
