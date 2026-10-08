"""The Needs-you queue: one ranked list of things that want a decision from
you, rebuilt from live state on every read, plus the triage you apply to it,
kept in data/inbox.json.

Severity, worst first:
  broken  red     something that should work does not: an active service is
                  down, a scheduled job failed, a probe failed in a project
                  you touched this fortnight, an agent failed
  needs   amber   a decision is waiting on you: an agent is blocked on a
                  question, an agent branch is ready to review
  drift   gray    hygiene: unpushed commits, uncommitted work left for days,
                  stale data in a quiet project, a blocker you declared

Triage:
  done    hidden until the item changes (its fingerprint: a new question, new
          commits, a different failure)
  snooze  hidden until a time, or until the item changes, whichever is first
  mute    hidden for 30 days whatever happens (a parked project you already
          know about)
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shlex
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from . import agents as agents_mod
from . import projects as proj_mod

router = APIRouter()

REPO_ROOT = Path(__file__).resolve().parent.parent
STATE_PATH = REPO_ROOT / "data" / "inbox.json"
_SEVERITY = {"broken": 0, "needs": 1, "drift": 2}
_KIND_ORDER = {"agent": 0, "job": 1, "data": 2, "service": 3, "review": 4, "fresh": 5, "unpushed": 6,
               "dirty": 7, "status": 8, "routine-branches": 9, "blocker": 10}
QUIET_DAYS = 60  # an "active" project with nothing on any branch for this long is probably parked
MUTE_DAYS = 30
RECENT_DAYS = 14  # a probe failing in a project touched this recently is broken, not drift
DIRTY_DAYS = 3

_state_lock = threading.Lock()
_build_lock = threading.Lock()
_built: tuple[float, list[dict]] | None = None
_BUILD_TTL = 5.0


# ---------------------------------------------------------------------------
# Agent branches: what the nightly steward and background sessions left for
# review. Cached per repo on the refs themselves, so a poll costs one
# for-each-ref per repo until a branch moves.
# ---------------------------------------------------------------------------
AGENT_BRANCH_PREFIXES = ("nightly/", "claude/", "worktree-", "bg/", "agent/")
_branch_cache: dict[str, tuple[str, list[dict]]] = {}
_WORD = re.compile(r"[a-z0-9]+")
_STOP = {"the", "and", "for", "into", "with", "from", "all", "row", "rows", "page", "add", "nightly"}


def _git(path: str | Path, *args: str, timeout: float = 15) -> str:
    try:
        r = subprocess.run(["git", *args], cwd=str(path), capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired):
        return ""
    return r.stdout if r.returncode == 0 else ""


def base_branch(heads: dict[str, str]) -> str | None:
    return "main" if "main" in heads else ("master" if "master" in heads else None)


def agent_branches(path: str) -> list[dict]:
    """Unmerged agent branches in one repo, oldest first. Cloud routines push
    theirs straight to origin, so remote-only ones (origin/nightly/...) count
    too; a local branch of the same name wins."""
    raw = _git(path, "for-each-ref", "--format=%(refname:short)%09%(objectname)%09%(committerdate:iso-strict)",
               "refs/heads", "refs/remotes/origin")
    heads: dict[str, str] = {}
    dates: dict[str, str] = {}
    for line in raw.splitlines():
        parts = line.split("\t")
        if len(parts) == 3:
            heads[parts[0]] = parts[1]
            dates[parts[0]] = parts[2]
    base = base_branch(heads)
    mine = sorted(n for n in heads if n.startswith(AGENT_BRANCH_PREFIXES)
                  or (n.startswith("origin/") and n[7:].startswith(AGENT_BRANCH_PREFIXES) and n[7:] not in heads))
    if not base or not mine:
        return []
    fp = ";".join(f"{n}:{heads[n]}" for n in [base, *mine] + ([f"origin/{base}"] if f"origin/{base}" in heads else []))
    cached = _branch_cache.get(path)
    if cached and cached[0] == fp:
        return cached[1]
    out: list[dict] = []
    remote_base = f"origin/{base}" if f"origin/{base}" in heads else base
    for name in mine:
        b = remote_base if name.startswith("origin/") else base  # a routine's branch is measured against origin
        counts = _git(path, "rev-list", "--left-right", "--count", f"{b}...{name}").split()
        if len(counts) != 2:
            continue
        behind, ahead = int(counts[0]), int(counts[1])
        if ahead == 0:
            continue  # merged, or nothing on it: nothing to review
        subjects = [s for s in _git(path, "log", "--format=%s", f"{b}..{name}").splitlines() if s]
        files = adds = dels = 0
        for row in _git(path, "diff", "--numstat", f"{b}...{name}").splitlines():
            a, _, rest = row.partition("\t")
            d, _, _ = rest.partition("\t")
            files += 1
            adds += int(a) if a.isdigit() else 0
            dels += int(d) if d.isdigit() else 0
        first = subjects[-1] if subjects else name  # the oldest commit names the goal
        out.append({"branch": name, "base": b, "sha": heads[name], "date": dates[name],
                    "ahead": ahead, "behind": behind, "commits": len(subjects),
                    "goal": re.sub(r"^\s*\[[^\]]*\]\s*", "", first),  # drop the "[nightly] " tag
                    "files": files, "adds": adds, "dels": dels})
    out.sort(key=lambda b: b["date"])
    _branch_cache[path] = (fp, out)
    return out


def _goal_words(goal: str) -> set[str]:
    goal = re.sub(r"^\s*\[[^\]]*\]\s*", "", goal.lower())
    return {w for w in _WORD.findall(goal) if len(w) > 2 and w not in _STOP}


def _similar(a: set[str], b: set[str]) -> bool:
    """Two goals match when they share at least two content words and those
    cover 40 % of the shorter one: "Add optional MQTT transport alongside raw
    UDP/TCP" ~ "Add opt-in MQTT transport for telemetry", but "Add recurring
    requests" !~ "Coordinator call sheet for requests with no offers"."""
    shared = len(a & b)
    return shared >= 2 and shared / min(len(a), len(b)) >= 0.4


def group_attempts(branches: list[dict]) -> list[list[dict]]:
    """Branches that chase the same goal (the steward re-did one goal four
    times because its GOALS tick only lands on a branch nobody merged)."""
    groups: list[tuple[list[set[str]], list[dict]]] = []
    for b in branches:
        words = _goal_words(b["goal"])
        for word_sets, members in groups:
            if any(_similar(words, w) for w in word_sets):
                word_sets.append(words)
                members.append(b)
                break
        else:
            groups.append(([words], [b]))
    return [members for _, members in groups]


# ---------------------------------------------------------------------------
# Item builders
# ---------------------------------------------------------------------------

def _item(kind: str, severity: str, key: str, title: str, *, project: str | None = None,
          detail: str | None = None, meta: str | None = None, since: str | None = None,
          fingerprint: str = "", actions: list[dict] | None = None, data: dict | None = None) -> dict:
    return {"id": f"{kind}:{key}", "kind": kind, "severity": severity, "project": project,
            "title": title, "detail": detail, "meta": meta, "since": since,
            "fingerprint": fingerprint, "actions": actions or [], "data": data or {}}


def _days_since(iso: str | None) -> float | None:
    if not iso:
        return None
    try:
        dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except ValueError:
        return None
    return (datetime.now(timezone.utc) - dt).total_seconds() / 86400


def _agent_items(live: dict) -> list[dict]:
    out = []
    for a in live.get("agents", []):
        name = a.get("title") or a.get("name") or a["id"]
        actions = [{"label": "Attach", "type": "post", "url": f"/api/agents/{a['id']}/attach", "key": "enter"}] \
            if a.get("can_attach") else []
        if a["state"] == "blocked":
            out.append(_item("agent", "needs", a["id"], a.get("needs") or f"{name} is waiting on you",
                             project=a.get("project"), detail=name, meta="background session",
                             since=a.get("since"), fingerprint=a.get("needs") or a["state"], actions=actions,
                             data={"agent": a}))
        elif a["state"] == "failed":
            out.append(_item("agent", "broken", a["id"], f"{name} failed", project=a.get("project"),
                             detail=a.get("detail"), meta="background session",
                             since=a.get("since"), fingerprint="failed", actions=actions, data={"agent": a}))
    return out


def _review_items(projects: list) -> list[dict]:
    """One review item per repo for the agent branches you have locally
    (the steward's, background sessions'), and one drift item per repo for
    branches cloud routines keep pushing to origin."""
    out = []
    repos = [p for p in projects if p.has_git]
    # one git round per repo; the first build after a restart diffs every
    # agent branch, so fan the repos out instead of walking them in turn
    with ThreadPoolExecutor(max_workers=4, thread_name_prefix="branches") as pool:
        found = dict(zip((p.path for p in repos), pool.map(agent_branches, (p.path for p in repos))))
    for p in repos:
        branches = found[p.path]
        local = [b for b in branches if not b["branch"].startswith("origin/")]
        remote = [b for b in branches if b["branch"].startswith("origin/")]
        if local:
            groups = group_attempts(local)
            repeats = sum(len(g) for g in groups if len(g) > 1)
            newest = local[-1]
            adds, dels = sum(b["adds"] for b in local), sum(b["dels"] for b in local)
            title = (f"Review {newest['branch']}" if len(local) == 1
                     else f"{len(local)} agent branches to review")
            meta = f"+{adds} −{dels}" + (f", {repeats} repeat a goal" if repeats else "")
            out.append(_item("review", "needs", p.name, title, project=p.name, detail=newest["goal"],
                             meta=meta, since=local[0]["date"],
                             fingerprint=",".join(b["sha"] for b in local),
                             actions=[{"label": "Review", "type": "preview", "key": "enter"}],
                             data={"branches": local, "groups": [[b["branch"] for b in g] for g in groups]}))
        if len(remote) >= 3:
            out.append(_item("routine-branches", "drift", p.name,
                             f"{len(remote)} routine branches piling up on origin",
                             project=p.name, detail=f"newest {remote[-1]['branch']}: {remote[-1]['goal']}",
                             meta=f"oldest {remote[0]['date'][:10]}", since=remote[0]["date"],
                             fingerprint=str(len(remote)),
                             actions=[{"label": "Show", "type": "preview", "key": "enter"}],
                             data={"branches": remote, "groups": [[b["branch"] for b in remote]]}))
    return out


def _project_items(projects: list) -> list[dict]:
    out = []
    for p in projects:
        m = p.manifest or {}
        status = m.get("status", "active")
        if status == "archived":
            continue
        last_touch = p.last_commit.date_iso if p.last_commit else None
        touched_days = _days_since(last_touch)
        recent = touched_days is not None and touched_days < RECENT_DAYS
        open_term = {"label": "Open in Terminal", "type": "post", "url": "/api/open_terminal",
                     "body": {"project": p.name}}
        open_proj = {"label": "Open project", "type": "link", "url": f"/project/{p.name}"}

        if m.get("kind") == "service" and status == "active" and m.get("port") and p.service_up is False:
            acts = [{"label": "Start", "type": "post", "url": f"/api/services/{p.name}/start", "key": "enter"}] \
                if m.get("start") else []
            out.append(_item("service", "broken", p.name, f"{p.name} is down", project=p.name,
                             meta=f"port {m['port']}", fingerprint="down", actions=acts + [open_proj]))

        from .freshness import COVERS
        for f in (p.signals or {}).get("freshness") or []:
            if (p.name, f.get("label")) in COVERS:
                continue
            state = f.get("state")
            if state not in ("red", "amber"):
                continue
            if state == "amber" and not recent:
                continue
            age = f.get("age_days")
            what = "is missing" if f.get("missing") else (f"is {age:.0f} days old" if age is not None else "is stale")
            out.append(_item("fresh", "broken" if state == "red" and recent else "drift",
                             f"{p.name}:{f.get('label')}", f"{f.get('label')} {what}", project=p.name,
                             meta=Path(f["path"]).name if f.get("path") else None,
                             fingerprint=state, actions=[open_proj]))

        gs = p.git_state or {}
        ahead = gs.get("ahead") or 0
        if ahead:
            out.append(_item("unpushed", "drift", p.name, f"{ahead} unpushed commit{'s' if ahead != 1 else ''}",
                             project=p.name, meta=f"on {p.branch}" if p.branch else None, since=last_touch,
                             fingerprint=f"{ahead}:{p.last_commit.sha if p.last_commit else ''}",
                             actions=[open_term, open_proj]))

        dirty = gs.get("dirty_count") or 0
        idle_days = (p.last_modified_file.age_seconds / 86400) if p.last_modified_file else None
        if dirty and idle_days is not None and idle_days >= DIRTY_DAYS:
            out.append(_item("dirty", "drift", p.name,
                             f"Uncommitted changes, untouched for {idle_days:.0f} days", project=p.name,
                             meta=f"{dirty} file{'s' if dirty != 1 else ''}", fingerprint=str(dirty),
                             actions=[open_term, open_proj]))

        if m.get("blocker"):
            out.append(_item("blocker", "drift", p.name, f"Blocked: {m['blocker']}", project=p.name,
                             fingerprint=str(m["blocker"]), actions=[open_proj]))

        # the manifest's status against what is actually happening on any branch,
        # including the ones routines and the steward push
        if m and p.has_git:
            last_any = _latest_activity(p.path)
            quiet_days = (time.time() - last_any) / 86400 if last_any else None
            set_status = lambda st: {"label": f"Mark it {st}", "type": "post",
                                     "url": f"/api/projects/{p.name}/status", "body": {"status": st}}
            if status in ("active", "incubating") and quiet_days is not None and quiet_days >= QUIET_DAYS:
                out.append(_item("status", "drift", p.name,
                                 f"Marked {status}, but nothing has moved in {quiet_days:.0f} days",
                                 project=p.name, meta="no commit on any branch",
                                 detail="Parking it keeps it out of Next up and the active list until you pick it up again.",
                                 fingerprint=status, actions=[set_status("dormant"), open_proj]))
            elif status in ("dormant", "parked") and quiet_days is not None and quiet_days < 3:
                out.append(_item("status", "drift", p.name,
                                 f"Marked {status}, but it changed {quiet_days * 24:.0f} h ago",
                                 project=p.name, fingerprint=status, actions=[set_status("active"), open_proj]))
    return out


def _latest_activity(path: str) -> float | None:
    raw = _git(path, "for-each-ref", "--sort=-committerdate", "--count=1",
               "--format=%(committerdate:unix)", "refs/heads", "refs/remotes")
    return float(raw.strip()) if raw.strip().isdigit() else None


def _job_items(jobs: list[dict]) -> list[dict]:
    out = []
    for j in jobs:
        code = j.get("last_exit")
        if code in (None, 0) or j.get("running"):
            continue
        out.append(_item("job", "broken", j["label"], f"{j['name']} failed its last run",
                         project=j.get("project"), meta=f"exit code {code}",
                         fingerprint=f"{j.get('runs')}:{code}",
                         actions=[{"label": "Show log", "type": "preview", "key": "enter"}], data={"job": j}))
    return out


def _freshness_items() -> list[dict]:
    """Sources gone stale (app/freshness.py): a failure is broken, a warning
    drift; a server running old code needs a decision (restart)."""
    from . import freshness
    out = []
    for c in freshness.all_checks()["checks"]:
        if c["state"] not in ("warn", "fail"):
            continue
        sev = "needs" if c["id"] == "self" else ("broken" if c["state"] == "fail" else "drift")
        out.append(_item("data", sev, c["id"], c["title"], project=c.get("project"), detail=c["detail"],
                         meta=c["label"], fingerprint=c["state"],
                         actions=[c["action"]] if c.get("action") else []))
    return out


def _build() -> list[dict]:
    from . import schedule as sched
    projects = proj_mod.list_projects()
    items = (_agent_items(agents_mod.live_agents()) + _job_items(sched.jobs()) + _freshness_items()
             + _review_items(projects) + _project_items(projects))

    def order(it: dict):
        days = _days_since(it.get("since"))
        return (_SEVERITY[it["severity"]], _KIND_ORDER.get(it["kind"], 9), -(days if days is not None else 0))

    items.sort(key=order)
    return items


_refreshing = False


def _refresh() -> None:
    global _built, _refreshing
    try:
        with _build_lock:
            _built = (time.time(), _build())
    except Exception:
        pass
    finally:
        _refreshing = False


def all_items() -> list[dict]:
    """Stale-while-revalidate: the first build diffs every agent branch
    (seconds); after that a poll gets the last build at once and at most one
    rebuild runs behind it."""
    global _built, _refreshing
    if _built:
        if time.time() - _built[0] >= _BUILD_TTL and not _refreshing:
            _refreshing = True
            threading.Thread(target=_refresh, name="inbox", daemon=True).start()
        return _built[1]
    with _build_lock:
        if not _built:
            _built = (time.time(), _build())
        return _built[1]


# ---------------------------------------------------------------------------
# Triage state
# ---------------------------------------------------------------------------

def _load_state() -> dict:
    try:
        d = json.loads(STATE_PATH.read_text(encoding="utf-8"))
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def _save_state(state: dict) -> None:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = STATE_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(state, indent=1, sort_keys=True), encoding="utf-8")
    os.replace(tmp, STATE_PATH)


def _parse(iso: str | None) -> datetime | None:
    if not iso:
        return None
    try:
        dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def triage_of(item: dict, state: dict, now: datetime) -> str | None:
    """The triage that currently hides this item, or None if it shows."""
    t = state.get(item["id"])
    if not t:
        return None
    until = _parse(t.get("until"))
    if t.get("action") == "mute":
        return "muted" if until is None or now < until else None
    if t.get("fingerprint") != item["fingerprint"]:
        return None  # it changed since you looked
    if t.get("action") == "done":
        return "done"
    if t.get("action") == "snooze" and until is not None and now < until:
        return "snoozed"
    return None


def _forget_resolved(items: list[dict]) -> dict:
    """Done and snooze are about one occurrence: once the item is gone from a
    build (the service came back, the commits were pushed), drop the entry so
    the next outage shows. Mutes keep their 30 days."""
    state = _load_state()
    live = {it["id"] for it in items}
    stale = [k for k, v in state.items() if k not in live and v.get("action") in ("done", "snooze")]
    if stale:
        with _state_lock:
            state = _load_state()
            for k in stale:
                state.pop(k, None)
            _save_state(state)
    return state


@router.get("/api/inbox")
def api_inbox(all: bool = False):
    items = all_items()
    state = _forget_resolved(items)
    now = datetime.now(timezone.utc)
    visible, hidden = [], {"done": 0, "snoozed": 0, "muted": 0}
    for it in items:
        t = triage_of(it, state, now)
        if t:
            hidden[t] += 1
            if all:
                visible.append({**it, "triage": t, "until": state[it["id"]].get("until")})
        else:
            visible.append(it)
    counts = {s: sum(1 for it in visible if it["severity"] == s and not it.get("triage")) for s in _SEVERITY}
    return {"items": visible, "counts": counts, "hidden": hidden,
            "checked_at": now.isoformat(timespec="seconds")}


class Triage(BaseModel):
    id: str
    action: str  # done | snooze | mute | restore
    until: str | None = None
    fingerprint: str | None = None  # what the page showed; an item that changed since then stays visible


@router.post("/api/inbox/triage")
def api_triage(req: Triage):
    if req.action not in ("done", "snooze", "mute", "restore"):
        raise HTTPException(400, "action must be done, snooze, mute or restore")
    item = next((it for it in all_items() if it["id"] == req.id), None)
    if item is None and req.action != "restore":
        raise HTTPException(404, "no such item (it may have resolved itself)")
    until = req.until
    if req.action == "snooze" and not _parse(until):
        raise HTTPException(400, "snooze needs an ISO `until`")
    if req.action == "mute":
        until = (datetime.now(timezone.utc) + timedelta(days=MUTE_DAYS)).isoformat(timespec="seconds")
    with _state_lock:
        state = _load_state()
        if req.action == "restore":
            state.pop(req.id, None)
        else:
            state[req.id] = {"action": req.action, "until": until, "fingerprint": req.fingerprint or item["fingerprint"],
                             "at": datetime.now(timezone.utc).isoformat(timespec="seconds")}
        # forget triage for items that have been gone for a month
        live = {it["id"] for it in all_items()}
        cutoff = datetime.now(timezone.utc) - timedelta(days=MUTE_DAYS)
        for key in [k for k, v in state.items() if k not in live and (_parse(v.get("at")) or cutoff) < cutoff]:
            state.pop(key, None)
        _save_state(state)
    return {"ok": True, "id": req.id, "action": req.action, "until": until}


@router.get("/api/inbox/preview")
def api_preview(id: str):
    """What the side sheet shows for one item: for a branch, its commits and
    diff against the base branch; for a job, its log tail."""
    item = next((it for it in all_items() if it["id"] == id), None)
    if item is None:
        raise HTTPException(404, "no such item")
    out: dict = {"item": item}
    if item["kind"] in ("review", "routine-branches") and item["project"]:
        path = proj_mod.PROJECTS_ROOT / item["project"]
        branches = []
        for b in item["data"].get("branches", []):
            log = _git(path, "log", "--format=%h%x09%aI%x09%s", f"{b['base']}..{b['branch']}")
            files = []
            for row in _git(path, "diff", "--numstat", f"{b['base']}...{b['branch']}").splitlines():
                parts = row.split("\t")
                if len(parts) == 3:
                    files.append({"path": parts[2], "adds": parts[0], "dels": parts[1]})
            branches.append({**b, "log": [dict(zip(("sha", "date", "subject"), l.split("\t", 2)))
                                         for l in log.splitlines() if l],
                             "file_list": files})
        newest = item["data"]["branches"][-1]
        diff = _git(path, "diff", "--no-color", f"{newest['base']}...{newest['branch']}", timeout=20)
        q = shlex.quote
        name = newest["branch"]
        delete = (f"git -C {q(str(path))} push origin --delete {q(name[len('origin/'):])}" if name.startswith("origin/")
                  else f"git -C {q(str(path))} branch -D {q(name)}")
        out.update({"branches": branches, "diff": diff[:200_000], "diff_truncated": len(diff) > 200_000,
                    "commands": {"merge": f"git -C {q(str(path))} merge --no-ff {q(name)}", "delete": delete}})
    elif item["kind"] == "job":
        log = (item["data"].get("job") or {}).get("log")
        if log and Path(log).is_file():
            try:
                with open(log, "rb") as fh:
                    fh.seek(0, os.SEEK_END)
                    fh.seek(max(0, fh.tell() - 16_000))
                    out["log_tail"] = fh.read().decode("utf-8", "replace").splitlines()[-80:]
            except OSError:
                pass
    return out
