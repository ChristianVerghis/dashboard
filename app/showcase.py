"""Latest-product showcase: resolve each project's `showcase:` manifest block.

Three kinds:
  app             — a running service. Preview = live scaled iframe when the
                    port is up, else the last headless-Chrome snapshot.
  file            — a static artifact inside the repo, served via /files/.
  markdown-latest — newest file matching a glob (briefing, build log),
                    rendered client-side with marked.

Snapshots live in data/showcase/{name}.png, captured on demand via
capture() (headless Chrome) — button in the UI, cron-able later.
"""
from __future__ import annotations

import subprocess
from datetime import datetime, timezone
from pathlib import Path

from . import projects as proj

SNAP_DIR = Path(__file__).resolve().parent.parent / "data" / "showcase"

CHROME_CANDIDATES = (
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
)


def _iso_mtime(p: Path) -> str:
    return datetime.fromtimestamp(p.stat().st_mtime, tz=timezone.utc).isoformat(timespec="seconds")


def resolve(p: "proj.Project") -> dict | None:
    """Turn a project's showcase block into a renderable entry, or None."""
    m = p.manifest or {}
    sc = m.get("showcase")
    if not sc:
        return None
    root = Path(p.path)
    kind = sc["kind"]
    out: dict = {"project": p.name, "kind": kind, "as_of": None, "title": None}

    if kind == "app":
        url = sc.get("href")
        if not url and m.get("port"):
            url = f"http://localhost:{m['port']}"
        if not url:
            return None
        out["url"] = url
        # same-origin dashboard pages (href "/classroom") are up iff we are
        out["up"] = True if url.startswith("/") else bool(p.service_up)
        snap = SNAP_DIR / f"{p.name}.png"
        if snap.exists():
            out["snapshot"] = f"/api/showcase/{p.name}.png"
            out["as_of"] = _iso_mtime(snap)
        return out

    if kind == "file":
        rel = str(sc.get("path") or "").lstrip("/")
        f = root / rel
        if not f.is_file():
            return None
        out["url"] = f"/files/{p.name}/{rel}"
        out["title"] = f.name
        out["as_of"] = _iso_mtime(f)
        return out

    if kind == "markdown-latest":
        pattern = sc.get("glob") or ""
        if not pattern:
            return None
        try:
            newest = max(
                (f for f in root.glob(pattern) if f.is_file()),
                key=lambda f: f.stat().st_mtime,
                default=None,
            )
        except (OSError, ValueError):
            return None
        if newest is None:
            return None
        rel = newest.relative_to(root)
        out["url"] = f"/files/{p.name}/{rel}"
        out["title"] = newest.name
        out["as_of"] = _iso_mtime(newest)
        return out

    return None


def shelf() -> list[dict]:
    """Every project's showcase entry for the index shelf. The dashboard
    itself is excluded — an iframe of the page it's embedded in recurses."""
    items: list[dict] = []
    for p in proj.list_projects():
        if p.name == "dashboard":
            continue
        entry = resolve(p)
        if entry:
            items.append(entry)
    # live apps first, then newest artifacts
    items.sort(key=lambda i: (
        0 if (i["kind"] == "app" and i.get("up")) else 1,
        -(datetime.fromisoformat(i["as_of"]).timestamp() if i.get("as_of") else 0),
    ))
    return items


def _chrome() -> str | None:
    for c in CHROME_CANDIDATES:
        if Path(c).exists():
            return c
    return None


def capture(name: str | None = None) -> dict:
    """Screenshot every up `app` showcase (or one project) with headless
    Chrome into data/showcase/{name}.png — the poster frame shown when the
    service is down."""
    chrome = _chrome()
    if chrome is None:
        return {"ok": False, "error": "no headless Chrome found"}
    SNAP_DIR.mkdir(parents=True, exist_ok=True)
    results: list[dict] = []
    for p in proj.list_projects():
        if name and p.name != name:
            continue
        entry = resolve(p)
        if not entry or entry["kind"] != "app" or not entry.get("up"):
            continue
        url = entry["url"]
        if url.startswith("/"):
            url = f"http://localhost:8765{url}"
        out_path = SNAP_DIR / f"{p.name}.png"
        try:
            r = subprocess.run(
                [chrome, "--headless", "--disable-gpu", "--hide-scrollbars",
                 f"--screenshot={out_path}", "--window-size=1280,800",
                 "--virtual-time-budget=6000", url],
                capture_output=True, timeout=45,
            )
            results.append({"project": p.name, "ok": r.returncode == 0 and out_path.exists()})
        except Exception as e:
            results.append({"project": p.name, "ok": False, "error": type(e).__name__})
    return {"ok": True, "captured": results}
