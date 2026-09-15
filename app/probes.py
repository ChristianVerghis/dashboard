"""Generic probe engine: executes manifest-declared signals server-side.

One executor covers what most projects need using files/endpoints they
already expose — no CORS issues, no new endpoints required in sibling
projects. Probe types:

  health      — GET a localhost URL, expect HTTP 200 (manifest `health:`)
  freshness   — file/glob newest-mtime age vs warn_days/fail_days thresholds
  metrics     — http_json (URL + dotted path) or file_json (file + dotted path);
                dotted paths support a trailing `len()`, e.g. "stations.len()"
  checklists  — markdown checkbox tally, optionally scoped to a `## section`

All results are cached with a short TTL so card renders and the signals
endpoint don't hammer files or sibling services.
"""
from __future__ import annotations

import json
import re
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

_TTL = 45.0
_cache: dict[str, tuple[float, dict]] = {}


def _cached(key: str, compute):
    now = time.time()
    hit = _cache.get(key)
    if hit and (now - hit[0]) < _TTL:
        return hit[1]
    val = compute()
    _cache[key] = (now, val)
    return val


def invalidate() -> None:
    _cache.clear()


# ---- individual probe executors ----

def _http_get(url: str, timeout: float = 1.5) -> tuple[int, bytes]:
    req = urllib.request.Request(url, headers={"User-Agent": "dev-dashboard-probe"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.status, resp.read()


def _dotted_get(data, path: str):
    """Resolve 'a.b.c' in nested dicts; trailing 'len()' returns length."""
    want_len = False
    if path.endswith(".len()"):
        want_len, path = True, path[: -len(".len()")]
    elif path == "len()":
        return len(data) if hasattr(data, "__len__") else None
    cur = data
    for part in path.split("."):
        if not part:
            continue
        if isinstance(cur, dict) and part in cur:
            cur = cur[part]
        else:
            return None
    if want_len:
        return len(cur) if hasattr(cur, "__len__") else None
    return cur


def probe_health(url: str) -> dict:
    def compute():
        try:
            status, body = _http_get(url)
            detail = None
            try:
                d = json.loads(body)
                if isinstance(d, dict):
                    detail = {k: d[k] for k in list(d)[:4]}
            except Exception:
                pass
            return {"up": status == 200, "status": status, "detail": detail}
        except Exception as e:
            return {"up": False, "status": None, "error": type(e).__name__}
    return _cached(f"health:{url}", compute)


def probe_freshness(root: Path, spec: dict) -> dict:
    """Newest mtime of file/glob vs warn/fail thresholds → green/amber/red."""
    def compute():
        pattern = spec.get("glob") or spec.get("file")
        out = {"label": spec.get("label", "freshness"), "state": "unknown",
               "age_days": None, "path": None}
        if not pattern:
            return out
        newest: float | None = None
        newest_path = None
        try:
            for p in (root.glob(pattern) if any(c in pattern for c in "*?[") else [root / pattern]):
                try:
                    mt = p.stat().st_mtime
                except OSError:
                    continue
                if newest is None or mt > newest:
                    newest, newest_path = mt, p
        except (OSError, ValueError):
            return out
        if newest is None:
            out["state"] = "red"
            out["missing"] = True
            return out
        age_days = (time.time() - newest) / 86400
        warn = spec.get("warn_days")
        fail = spec.get("fail_days")
        state = "green"
        if isinstance(fail, (int, float)) and age_days >= fail:
            state = "red"
        elif isinstance(warn, (int, float)) and age_days >= warn:
            state = "amber"
        out.update({
            "state": state,
            "age_days": round(age_days, 1),
            "path": str(newest_path.relative_to(root)) if newest_path else None,
            "as_of": datetime.fromtimestamp(newest, tz=timezone.utc).isoformat(timespec="seconds"),
        })
        return out
    return _cached(f"fresh:{root}:{json.dumps(spec, sort_keys=True)}", compute)


def probe_metric(root: Path, spec: dict) -> dict:
    def compute():
        out = {"label": spec.get("label", "metric"), "value": None}
        kind = spec.get("type")
        path_expr = str(spec.get("path") or "")
        try:
            if kind == "http_json" and spec.get("url"):
                status, body = _http_get(str(spec["url"]))
                if status != 200:
                    out["error"] = f"http {status}"
                    return out
                out["value"] = _dotted_get(json.loads(body), path_expr)
            elif kind == "file_json" and spec.get("file"):
                p = root / str(spec["file"])
                if not p.exists():
                    out["error"] = "missing"
                    return out
                out["value"] = _dotted_get(json.loads(p.read_text(encoding="utf-8")), path_expr)
            elif kind == "jsonl_count" and (spec.get("file") or spec.get("glob")):
                pattern = spec.get("glob") or spec.get("file")
                n = 0
                for p in (root.glob(pattern) if any(c in pattern for c in "*?[") else [root / pattern]):
                    try:
                        with open(p, encoding="utf-8", errors="ignore") as f:
                            n += sum(1 for line in f if line.strip())
                    except OSError:
                        continue
                out["value"] = n
            elif kind == "glob_count" and spec.get("glob"):
                out["value"] = sum(1 for _ in root.glob(str(spec["glob"])))
        except Exception as e:
            out["error"] = type(e).__name__
        if spec.get("suffix") and out["value"] is not None:
            out["suffix"] = str(spec["suffix"])[:20]
        return out
    return _cached(f"metric:{root}:{json.dumps(spec, sort_keys=True)}", compute)


_CHECKBOX_RE = re.compile(r"^\s*[-*]\s*\[([ xX])\]\s*(.+?)\s*$")
_SECTION_RE = re.compile(r"^##\s+(.+?)\s*$")


def probe_checklist(root: Path, spec: dict) -> dict:
    def compute():
        out = {"label": spec.get("label", "checklist"), "done": 0, "total": 0,
               "next_undone": None}
        p = root / str(spec.get("file") or "GOALS.md")
        if not p.exists():
            out["missing"] = True
            return out
        try:
            text = p.read_text(encoding="utf-8")
        except OSError:
            out["missing"] = True
            return out
        want_section = spec.get("section")
        in_section = want_section is None
        for line in text.splitlines():
            sec = _SECTION_RE.match(line)
            if sec:
                in_section = want_section is None or want_section.lower() in sec.group(1).lower()
                continue
            if not in_section:
                continue
            cb = _CHECKBOX_RE.match(line)
            if not cb:
                continue
            out["total"] += 1
            if cb.group(1).lower() == "x":
                out["done"] += 1
            elif out["next_undone"] is None:
                out["next_undone"] = re.sub(r"\*\*", "", cb.group(2))[:90]
        return out
    return _cached(f"check:{root}:{json.dumps(spec, sort_keys=True)}", compute)


# ---- aggregate signals + verdict ----

def signals_for(root: Path, manifest: dict | None, git_state: dict | None = None,
                include_metrics: bool = True) -> dict:
    """Everything the manifest declares, executed. `include_metrics=False` is
    the fast card-scan path: file probes only, no HTTP (the caller substitutes
    its TCP port check for health)."""
    m = manifest or {}
    health = probe_health(m["health"]) if (include_metrics and m.get("health")) else None
    freshness = [probe_freshness(root, s) for s in m.get("freshness", [])]
    checklists = [probe_checklist(root, s) for s in m.get("checklists", [])]
    metrics = [probe_metric(root, s) for s in m.get("metrics", [])] if include_metrics else []
    return {
        "health": health,
        "freshness": freshness,
        "metrics": metrics,
        "checklists": checklists,
        "blocker": m.get("blocker"),
        "verdict": verdict_for(m, health, freshness, git_state or {}),
    }


def verdict_for(manifest: dict, health: dict | None, freshness: list[dict],
                git_state: dict) -> dict:
    """One attention level per project: red > amber > green; finished
    docs/vault artifacts get 'complete' so they don't read as neglected."""
    m = manifest or {}
    status = m.get("status", "active")
    kind = m.get("kind", "app")
    reasons: list[str] = []
    level = "green"

    def worsen(new_level: str, reason: str):
        nonlocal level
        order = {"green": 0, "amber": 1, "red": 2}
        if order[new_level] > order[level]:
            level = new_level
        reasons.append(reason)

    for f in freshness:
        if f.get("state") == "red":
            age = f.get("age_days")
            worsen("red", f"{f['label']} {'missing' if f.get('missing') else f'{age:.0f}d stale'}")
        elif f.get("state") == "amber":
            worsen("amber", f"{f['label']} {f['age_days']:.0f}d old")

    if health is not None and not health.get("up") and status == "active":
        worsen("amber", "service down")

    ahead = git_state.get("ahead") or 0
    dirty = git_state.get("dirty_count") or 0
    if ahead:
        worsen("amber", f"{ahead} unpushed commit{'s' if ahead != 1 else ''}")
    if dirty >= 20:
        worsen("amber", f"{dirty} dirty files")

    if m.get("blocker"):
        worsen("amber", f"blocked: {m['blocker']}")

    # Finished artifacts: quiet unless a probe actively failed.
    if level == "green" and (status == "archived" or (kind in {"docs", "vault"} and status in {"dormant", "parked", "archived"})):
        return {"level": "complete", "reasons": reasons}
    return {"level": level, "reasons": reasons[:5]}
