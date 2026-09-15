"""Per-project deep-dive insights.

Adds richer signal to a project beyond commit/file stats. Each plugin
function takes a project root and returns a list of `Insight` dicts:

  {"label": "...", "value": "...", "kind": "metric|status|note"}

Plugins are tried in order; the first one whose `applies()` returns
True is used. Falls back to a generic insight if nothing matches.

Easy to extend: add a new function here and wire it into the registry
at the bottom.
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path

DASHBOARD_ROOT = Path(__file__).resolve().parent.parent
ROUTINES_PATH = DASHBOARD_ROOT / "data" / "routines_snapshot.json"


def _load_routines_for(project: str) -> list[dict]:
    if not ROUTINES_PATH.exists():
        return []
    try:
        data = json.loads(ROUTINES_PATH.read_text())
    except Exception:
        return []
    return [r for r in data.get("routines", []) if r.get("project") == project]


def _next_fire_label(iso: str) -> str:
    try:
        dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except ValueError:
        return iso
    now = datetime.now(timezone.utc)
    delta = dt - now
    s = int(delta.total_seconds())
    if s < 0:
        return f"due {abs(s)//60}m ago"
    if s < 3600:
        return f"in {s//60}m"
    if s < 86400:
        return f"in {s//3600}h{(s%3600)//60}m"
    return f"in {s//86400}d{(s%86400)//3600}h"


def _parse_goals(root: Path) -> dict | None:
    """Parse GOALS.md checkboxes. Returns {done, total, next_undone, percent}."""
    path = root / "GOALS.md"
    if not path.exists():
        return None
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return None
    done = 0
    total = 0
    next_undone: str | None = None
    for line in text.splitlines():
        m = re.match(r"^\s*[-*]\s*\[([ xX])\]\s*(.+?)\s*$", line)
        if not m:
            continue
        total += 1
        checked = m.group(1).lower() == "x"
        label = m.group(2)
        # Strip emphasis markers and trailing notes
        label = re.sub(r"\*\*", "", label)
        if checked:
            done += 1
        elif next_undone is None:
            next_undone = label
    if total == 0:
        return None
    return {
        "done": done,
        "total": total,
        "percent": int(done / total * 100),
        "next_undone": next_undone or "",
    }


def _goal_insights(root: Path) -> list[dict]:
    g = _parse_goals(root)
    if g is None:
        return []
    out = [{
        "label": "Goals",
        "value": f"{g['done']}/{g['total']} done · {g['percent']}%",
        "kind": "metric",
    }]
    if g["next_undone"]:
        nxt = g["next_undone"]
        if len(nxt) > 90:
            nxt = nxt[:87] + "…"
        out.append({"label": "Next up", "value": nxt, "kind": "status"})
    return out


def _markets_applies(root: Path) -> bool:
    return (root / "scripts" / "ingest_prices.py").exists() and (root / "config" / "watchlist.yml").exists()


def _markets_insights(root: Path) -> list[dict]:
    out: list[dict] = []

    # Watchlist size
    wl_path = root / "config" / "watchlist.yml"
    if wl_path.exists():
        try:
            text = wl_path.read_text(encoding="utf-8")
            tickers = re.findall(r"^\s*-\s+\"?([A-Z][A-Z0-9.\-]*)\"?\s*(?:#.*)?$", text, re.MULTILINE)
            tickers = [t for t in tickers if t not in {"DGS10", "DCOILWTICO", "CPIAUCSL", "UNRATE", "DEXCAUS", "INDPRO"}]
            unique = sorted(set(tickers))
            out.append({"label": "Watchlist", "value": f"{len(unique)} tickers", "kind": "metric"})
        except Exception:
            pass

    # Predictions logged vs resolved
    pred_dir = root / "data" / "predictions"
    out_dir = root / "data" / "outcomes"
    if pred_dir.exists():
        all_preds = list(pred_dir.glob("*.json"))
        open_preds = []
        for p in all_preds:
            try:
                d = json.loads(p.read_text())
                if d.get("status") == "open":
                    open_preds.append(d)
            except Exception:
                continue
        resolved = list(out_dir.glob("*.json")) if out_dir.exists() else []
        out.append({
            "label": "Predictions",
            "value": f"{len(all_preds)} logged · {len(open_preds)} open · {len(resolved)} resolved",
            "kind": "metric",
        })
        if resolved:
            correct = 0
            for p in resolved:
                try:
                    d = json.loads(p.read_text())
                    if d.get("correct"):
                        correct += 1
                except Exception:
                    pass
            rate = correct / len(resolved) * 100
            out.append({"label": "Hit rate", "value": f"{rate:.0f}% of {len(resolved)}", "kind": "metric"})

    # Latest daily briefing
    briefings = sorted((root / "vault" / "Daily Briefings").glob("[0-9]*.md")) if (root / "vault" / "Daily Briefings").exists() else []
    if briefings:
        latest = briefings[-1]
        date_str = latest.stem
        out.append({"label": "Latest briefing", "value": date_str, "kind": "status"})
    else:
        out.append({"label": "Latest briefing", "value": "none yet", "kind": "status"})

    # Filings indexed
    filings_index = root / "data" / "processed" / "filings_index.csv"
    if filings_index.exists():
        try:
            n = sum(1 for _ in open(filings_index)) - 1  # minus header
            if n > 0:
                out.append({"label": "Filings indexed", "value": f"{n}", "kind": "metric"})
        except Exception:
            pass

    # Company notes
    companies_dir = root / "vault" / "Companies"
    if companies_dir.exists():
        n = len([p for p in companies_dir.glob("*.md") if not p.name.startswith("_")])
        if n > 0:
            out.append({"label": "Company notes", "value": f"{n}", "kind": "metric"})

    # Routines (from snapshot)
    try:
        snap = json.loads(ROUTINES_PATH.read_text()) if ROUTINES_PATH.exists() else {}
    except Exception:
        snap = {}
    routines = [r for r in snap.get("routines", []) if r.get("project") == "markets"]
    if snap.get("alert"):
        out.append({
            "label": "⚠ Alert",
            "value": snap["alert"]["title"],
            "kind": "alert",
        })
    if routines:
        active = [r for r in routines if r.get("enabled")]
        any_blocked = any(r.get("status", "").startswith(("WILL_FAIL", "DISABLED")) for r in routines)
        upcoming = [r for r in active if r.get("next_run_at")]
        if upcoming:
            soonest = min(upcoming, key=lambda r: r.get("next_run_at", "9999"))
            short_name = soonest['name'].replace('markets-', '')
            if any_blocked:
                value = f"{len(active)} scheduled (BLOCKED) · next {short_name} {_next_fire_label(soonest['next_run_at'])}"
            else:
                value = f"{len(active)} scheduled · next {short_name} {_next_fire_label(soonest['next_run_at'])}"
            out.append({
                "label": "Routines",
                "value": value,
                "kind": "status",
            })

    return out


def _charger_tracker_applies(root: Path) -> bool:
    return root.name == "charger-tracker" and (root / "package.json").exists()


def _charger_tracker_insights(root: Path) -> list[dict]:
    out: list[dict] = []
    pkg_path = root / "package.json"
    if pkg_path.exists():
        try:
            pkg = json.loads(pkg_path.read_text())
            framework = "Next.js" if "next" in (pkg.get("dependencies", {}) or {}) else "Node"
            out.append({"label": "Framework", "value": framework, "kind": "metric"})
            scripts = list((pkg.get("scripts", {}) or {}).keys())
            if scripts:
                out.append({"label": "Scripts", "value": ", ".join(scripts[:5]), "kind": "status"})
        except Exception:
            pass
    data_dir = root / "data"
    if data_dir.exists():
        json_files = list(data_dir.glob("*.json"))
        csv_files = list(data_dir.glob("*.csv"))
        if json_files or csv_files:
            out.append({
                "label": "Data files",
                "value": f"{len(json_files)} json · {len(csv_files)} csv",
                "kind": "metric",
            })
    if (root / "next.config.mjs").exists() or (root / "next.config.js").exists():
        public = root / "public"
        if public.exists():
            n_assets = len([p for p in public.rglob("*") if p.is_file()])
            if n_assets:
                out.append({"label": "Public assets", "value": f"{n_assets}", "kind": "metric"})
    return out


def _ev_network_applies(root: Path) -> bool:
    return (root / "build_log.md").exists() and (root / "04_career_roadmap").exists()


def _ev_network_insights(root: Path) -> list[dict]:
    out: list[dict] = []

    # Count build_log entries (heuristic: lines starting with "**Update")
    bl = root / "build_log.md"
    if bl.exists():
        try:
            text = bl.read_text(encoding="utf-8")
            updates = re.findall(r"^\*\*Update\s+([^:*]+)\*?\*?:", text, re.MULTILINE)
            out.append({"label": "Build log entries", "value": f"{len(updates)}", "kind": "metric"})
            if updates:
                out.append({"label": "Last entry", "value": updates[-1].strip(), "kind": "status"})
        except Exception:
            pass

    # Sub-project folders (each top-level numbered dir)
    folders = sorted([p for p in root.iterdir() if p.is_dir() and re.match(r"^\d+_", p.name)])
    if folders:
        out.append({"label": "Strategic areas", "value": f"{len(folders)}", "kind": "metric"})

    # Credibility builds (subprojects under 02_credibility_builds)
    cb = root / "02_credibility_builds"
    if cb.exists():
        sub = [p for p in cb.iterdir() if p.is_dir()]
        if sub:
            out.append({"label": "Credibility builds in flight", "value": f"{len(sub)}", "kind": "metric"})

    return out


def _generic_insights(root: Path) -> list[dict]:
    out: list[dict] = []
    # Just count markdown vs other files for a sense of doc-vs-code
    md = sum(1 for _ in root.rglob("*.md"))
    py = sum(1 for _ in root.rglob("*.py"))
    if md or py:
        out.append({"label": "Markdown", "value": f"{md}", "kind": "metric"})
        out.append({"label": "Python", "value": f"{py}", "kind": "metric"})
    return out


REGISTRY = [
    (_markets_applies, _markets_insights),
    (_ev_network_applies, _ev_network_insights),
    (_charger_tracker_applies, _charger_tracker_insights),
]


def detect_framework(root: Path) -> str | None:
    """Quick framework guess for the card badge."""
    if (root / "next.config.mjs").exists() or (root / "next.config.js").exists() or (root / "next.config.ts").exists():
        return "Next.js"
    if (root / "package.json").exists():
        try:
            pkg = json.loads((root / "package.json").read_text())
            deps = {**(pkg.get("dependencies") or {}), **(pkg.get("devDependencies") or {})}
            if "next" in deps: return "Next.js"
            if "react" in deps: return "React"
            if "vite" in deps: return "Vite"
            return "Node"
        except Exception:
            return "Node"
    if (root / "pyproject.toml").exists() or (root / "requirements.txt").exists():
        if (root / "uvicorn").exists() or any((root / "app").rglob("*.py")) if (root / "app").exists() else False:
            return "FastAPI"
        return "Python"
    if (root / "Cargo.toml").exists():
        return "Rust"
    if (root / "go.mod").exists():
        return "Go"
    if any(root.glob("*.md")):
        return "Vault"
    return None


def insights_for(root: Path) -> list[dict]:
    base: list[dict] = _goal_insights(root)
    for applies, fn in REGISTRY:
        try:
            if applies(root):
                base.extend(fn(root))
                return base
        except Exception:
            continue
    base.extend(_generic_insights(root))
    return base
