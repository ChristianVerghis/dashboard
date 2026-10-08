"""Private mode: which projects may keep their real names on screen.

Everything is private by default. A project is public when its project.yml says
`visibility: public` or its name is listed in data/privacy.json ({"public": [...]}).
The page-side switch lives in static/privacy.js; this only answers "who is public".
"""
import json
from pathlib import Path

from . import projects as proj

ALLOWLIST = Path(__file__).resolve().parent.parent / "data" / "privacy.json"


def public_projects() -> list[str]:
    names: set[str] = set()
    try:
        if ALLOWLIST.exists():
            raw = json.loads(ALLOWLIST.read_text())
            names.update(str(n) for n in raw.get("public", []))
    except (OSError, ValueError):
        pass
    for p in proj.list_projects():
        m = getattr(p, "manifest", None) or {}
        if str(m.get("visibility", "")).lower() == "public":
            names.add(p.name)
    return sorted(names)
