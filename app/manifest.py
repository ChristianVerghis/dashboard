"""Per-project manifest: project.yml at a project root.

Lets a project declare its own dashboard presence instead of hardcoding
plugins here. Everything is optional; a missing or malformed manifest
degrades to the plain auto-discovered card.

Schema v2:

  name: reef                # display name (defaults to folder name)
  kind: service             # app | service | tool | vault | library | docs | research
  status: active            # active | incubating | parked | dormant | archived
  description: one-liner
  repo: https://github.com/you/reef   # repo link (also inferred from git remote)
  port: 3737                # service health check + default link target
  health: http://localhost:3737/api/health  # HTTP health check (beats bare TCP port probe)
  start: pnpm dev           # how to start it (dashboard start button, detached)
  links:                    # list form or mapping form (label: url); path: serves via /files/
    - { label: "Open reef →", href: "http://localhost:3737", primary: true }
    - { label: "Build log", path: "build_log.md" }
  actions:                  # mapping form (name: cmd) or list form ({label|name, run})
    typecheck: pnpm typecheck   # string command, run via bash -lc in the repo
  freshness:                # staleness probes → green/amber/red verdicts
    - { label: "snapshot", glob: "public/data/snapshot.json", warn_days: 30, fail_days: 60 }
  metrics:                  # headline numbers, served by app/probes.py
    - { label: "jobs", type: http_json, url: "http://localhost:8770/api/jobs", path: "count" }
    - { label: "stations", type: file_json, file: "public/data/snapshot.json", path: "stations.len()" }
  checklists:               # markdown checkbox tallies beyond GOALS.md
    - { label: "v1 ship", file: "GOALS.md", section: "v1 ship" }
  blocker: "name + .ca domain decision"   # static banner shown on card + detail page
  tags: [agents, local-ai]
"""
from __future__ import annotations

import re
import socket
from pathlib import Path

import yaml

MANIFEST_NAMES = ("project.yml", "project.yaml")
KINDS = {"app", "service", "tool", "vault", "library", "docs", "research"}
STATUSES = {"active", "incubating", "parked", "dormant", "archived"}
_ACTION_NAME_RE = re.compile(r"^[a-z0-9_\-]{1,40}$")

# mtime-keyed cache: load_manifest is called from every scan AND from
# exec_actions per request — re-parsing YAML each time is pure waste.
_manifest_cache: dict[str, tuple[float, dict | None]] = {}


def _normalize_links(raw_links, project_name: str) -> list[dict]:
    """Accept list-of-dicts ({label, href|url|path, primary}) or a mapping
    (label: url). `path:` entries resolve to the dashboard's /files/ route."""
    items: list[tuple[str, dict | str]] = []
    if isinstance(raw_links, dict):
        items = [(str(k), v) for k, v in raw_links.items()]
    elif isinstance(raw_links, list):
        for item in raw_links:
            if isinstance(item, dict):
                items.append((str(item.get("label") or ""), item))
    links: list[dict] = []
    for label, item in items:
        href = None
        primary = False
        if isinstance(item, str):
            href = item
        elif isinstance(item, dict):
            href = item.get("href") or item.get("url")
            if not href and item.get("path"):
                rel = str(item["path"]).lstrip("/")
                href = f"/files/{project_name}/{rel}"
            primary = bool(item.get("primary"))
        if not label or not isinstance(href, str):
            continue
        if not href.startswith(("http://", "https://", "/", "obsidian://")):
            continue
        links.append({"label": label[:80], "href": href, "primary": primary})
    return links[:8]


def _normalize_actions(raw_actions) -> dict[str, str]:
    """Accept mapping (name: cmd) or list of {name|label, run}."""
    actions: dict[str, str] = {}
    if isinstance(raw_actions, dict):
        pairs = list(raw_actions.items())
    elif isinstance(raw_actions, list):
        pairs = []
        for item in raw_actions:
            if isinstance(item, dict) and isinstance(item.get("run"), str):
                name = str(item.get("name") or item.get("label") or "").strip()
                # slugify loose labels like "daily briefing (full ingest)"
                slug = re.sub(r"[^a-z0-9_\-]+", "-", name.lower()).strip("-")[:40]
                pairs.append((slug, item["run"]))
    else:
        pairs = []
    for k, v in pairs:
        if isinstance(v, str) and v.strip() and _ACTION_NAME_RE.match(str(k)):
            actions[str(k)] = v.strip()
    return actions


def _normalize_probe_list(raw, allowed_keys: set[str]) -> list[dict]:
    out: list[dict] = []
    if not isinstance(raw, list):
        return out
    for item in raw:
        if not isinstance(item, dict) or not item.get("label"):
            continue
        clean = {k: item[k] for k in allowed_keys if k in item}
        clean["label"] = str(item["label"])[:60]
        out.append(clean)
    return out[:8]


def load_manifest(root: Path) -> dict | None:
    """Read + normalize a project manifest. Returns None if absent/invalid.
    Cached by file mtime."""
    path = None
    for name in MANIFEST_NAMES:
        p = root / name
        if p.exists():
            path = p
            break
    if path is None:
        return None
    try:
        mtime = path.stat().st_mtime
    except OSError:
        return None
    cached = _manifest_cache.get(str(path))
    if cached and cached[0] == mtime:
        return cached[1]

    try:
        raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    except Exception:
        _manifest_cache[str(path)] = (mtime, None)
        return None
    if not isinstance(raw, dict):
        _manifest_cache[str(path)] = (mtime, None)
        return None

    m: dict = {}
    m["name"] = str(raw.get("name") or root.name)
    kind = str(raw.get("kind") or "app").lower()
    m["kind"] = kind if kind in KINDS else "app"
    status = str(raw.get("status") or "active").lower()
    m["status"] = status if status in STATUSES else "active"
    if raw.get("description"):
        m["description"] = str(raw["description"])[:300]
    if isinstance(raw.get("repo"), str) and raw["repo"].startswith("http"):
        m["repo"] = raw["repo"][:200]

    port = raw.get("port")
    m["port"] = port if isinstance(port, int) and 1 <= port <= 65535 else None
    m["start"] = str(raw["start"]).strip() if isinstance(raw.get("start"), str) and raw["start"].strip() else None
    m["health"] = str(raw["health"]).strip() if isinstance(raw.get("health"), str) and raw["health"].startswith("http") else None

    m["links"] = _normalize_links(raw.get("links"), root.name)
    m["actions"] = _normalize_actions(raw.get("actions"))

    m["freshness"] = _normalize_probe_list(
        raw.get("freshness"), {"label", "file", "glob", "warn_days", "fail_days"})
    m["metrics"] = _normalize_probe_list(
        raw.get("metrics"), {"label", "type", "url", "file", "glob", "path", "suffix"})
    m["checklists"] = _normalize_probe_list(
        raw.get("checklists"), {"label", "file", "section"})
    m["blocker"] = str(raw["blocker"])[:200] if isinstance(raw.get("blocker"), str) and raw["blocker"].strip() else None

    # showcase: the project's latest product, rendered on the index shelf +
    # project hero. kinds: app (live iframe / snapshot), file (/files iframe),
    # markdown-latest (newest glob match rendered as markdown).
    sc = raw.get("showcase")
    showcase = None
    if isinstance(sc, dict):
        kind = str(sc.get("kind") or "").lower()
        if kind in {"app", "file", "markdown-latest"}:
            showcase = {"kind": kind}
            for k in ("href", "path", "glob"):
                if isinstance(sc.get(k), str) and sc[k].strip():
                    showcase[k] = sc[k].strip()[:300]
    m["showcase"] = showcase

    tags = raw.get("tags")
    m["tags"] = [str(t)[:30] for t in tags[:8] if t] if isinstance(tags, list) else []
    _manifest_cache[str(path)] = (mtime, m)
    return m


def port_alive(port: int, timeout: float = 0.3) -> bool:
    """TCP connect check against localhost. Fast enough to run inside the
    TTL-cached project scan."""
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=timeout):
            return True
    except OSError:
        return False
