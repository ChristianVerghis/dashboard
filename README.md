# dev dashboard

**A live cockpit for every side project under `~/dev`: one page that shows what is running, what is stale, what is blocked, and what to do next.**

## What it is

A small FastAPI service plus vanilla-JS pages, no build step. On start it scans the projects root (`~/dev` by default) and treats every direct subdirectory with a `.git` folder or a `README.md` as a project. For each one it tracks commit activity, git state, `GOALS.md` progress, and a red / amber / green verdict computed from probes the project declares in its own `project.yml`. It also watches the Claude Code sessions running on the machine, so its mission control page can answer three questions in order: is anything broken, what needs me, and what should I do next.

The main pieces:

- **Insights** (`/`, the landing page) — the week against your usual one, where the commits went, services, what is going stale or unpushed, commit rhythm, a 12-month heatmap, the activity feed and the live log.
- **Mission control** (`/control`; the nav link carries a count when something needs you) — one sentence that sums up the state of everything ("Two things need you. Three agents are working."), then a ranked **Needs you** queue: broken things (a service down, a scheduled job that failed, a failing probe in a project you are working on), decisions (an agent waiting on a question, agent branches to review, repeated attempts at the same goal grouped), and drift folded away (unpushed or long-uncommitted work, stale data, blockers you noted). Keyboard triage: `e` done, `h` snooze, `m` mute, each with undo; a done item comes back when it changes. `space` previews an item in a side sheet, including a branch's commits and diff. Below it: the next open goal per project, and projects grouped active / quiet / parked.
- **Live agents** — every running Claude Code session (interactive, background, headless), read from Claude Code's own state files under `~/.claude` instead of spawning the CLI. A background session shows the question it is waiting on and opens in Terminal with `claude attach`; its recent output previews in the sheet.
- **Routines** (`/routines`) — everything that runs on its own and whether it actually ran: launchd jobs checked against their own per-run logs (missed runs, failed exits, and launchd's clock when it lags a time zone change), cloud routines judged by what they commit against their usual gap.
- **System** (on Insights) — CPU, memory, energy, disk and network the way Activity Monitor shows them: live every 2 s while the panel is on screen, ten minutes of history (system totals are sampled every 10 s in the background), memory pressure and swap, the whole Mac's power draw, battery and what is keeping the Mac awake, free disk space, network rates and totals, and the apps using the most of each, grouped by app bundle, with dev servers labelled by project.
- **Data freshness** — one registry (`/api/freshness`) of every source the pages depend on, with its age, expected cadence and a one-click fix: the nightly digest, each repo's last fetch (the dashboard fetches every repo itself every 6 h), every scheduled job and cloud routine, screenshots, external activity, and whether the server is running older code than the checkout. Insights says in one line whether everything is current; stale sources land in the Needs-you queue.
- **Services health row** — projects declared as `kind: service` get a TCP or HTTP health check on their port and a start button that launches their `start:` command detached, logging to `logs/services/<name>.log`.
- **Project pages** at `/project/{name}` — hero stats, a tickable `GOALS.md` editor, manifest signals and links, insights, recent commits, an uncommitted-changes diff viewer, whitelisted action buttons, and the project's own `CAPABILITIES.md` rendered as markdown.
- **Live updates** — a `watchdog` observer on the whole tree pushes changes to the browser over Server-Sent Events; a live log pane tails `logs/feed.log` so any shell can `echo` into the UI.
- **External activity** — drop `{name, days: {date: count}}` JSON files into `data/external_activity/` (a work GitLab calendar, for example) and they join the heatmap totals and the share card, flagged approximate when they are.
- **One shell on every page** — a global bar, light and dark themes on design tokens, a private mode that blurs personal text for screen recordings, `g`-key navigation, and a ⌘K palette that jumps to any page or project, runs actions (open a project in Terminal, start Claude there, copy a project brief, start a service) and can ask Claude a question about your projects.
- **Cross-project views** — `/journal` commit timeline with search, `/stack` insight columns, `/routines`, and `/snapshot.html` for a self-contained HTML export.
- **Nightly steward** (`steward/`) — a launchd job at 02:00 that runs an unattended agent against written standing orders: survey the API, do hygiene (fetch, fast-forward pull, restart down services), advance one project's top goal on a `nightly/<date>` branch (skipping goals marked `(owner)` and goals an unmerged nightly branch already attempts), and write a digest to `data/nightly/`. The dashboard points a freshness probe at those digests so it goes red if the steward stops firing, and lists the branches it leaves in the Needs-you queue.
- **`bin/dev` CLI** — `dev new <name>` scaffolds a project with `README.md`, `GOALS.md`, `build_log.md`, and a `project.yml` so it is dashboard-ready from its first commit; `dev ls` lists every project with kind / status / port / running; `dev up <name> [--bg]` starts one using its manifest's `start:` command.

## Why I built it

I run a dozen or so side projects at once, and the cost of that is not writing code but remembering state: which service is down, which repo has a dirty tree, which goal is next, which data file has quietly gone stale. This gives all of that a single page, and the `project.yml` convention means each project describes itself instead of the dashboard hardcoding plugins for it. The nightly steward came later, once the page could tell an agent enough to act safely on its own.

## Status

As of 2026-10-05: in daily use on one machine. The mission control rework is in: a scanner that serves cached results and rescans changed projects in the background (it used to stall after a few days up), the shared shell, Insights as the landing page, and the mission control page with live agents and the Needs-you queue. Next, in `GOALS.md`: reviewing and landing agent branches from the page, starting background agents in worktrees, a hooks feed for instant session events, a usage gauge, and serving the dashboard to Claude sessions over MCP. macOS-only in the launchd scripts, Terminal launchers and a couple of `open`-based actions; the server itself is plain Python.

## Stack

- Python 3.13, FastAPI, uvicorn, `watchdog`, PyYAML
- Vanilla JavaScript and CSS, vendored `marked.js`, self-hosted Geist and Geist Mono (OFL); no bundler, no framework
- SQLite is not used; state is the filesystem (git repos, markdown, `project.yml`, JSON snapshots)
- macOS launchd for auto-start and the nightly steward

## Run it

```bash
./run.sh
# open http://localhost:8765
```

The first run creates `.venv/` and installs `requirements.txt`; later runs just start uvicorn. Options:

```bash
PORT=8080 ./run.sh              # different port
DEV_ROOT=~/code ./run.sh        # scan a different projects root (default ~/dev)
```

Stop with `Ctrl-C`, or `pkill -f 'uvicorn app.main'`.

Optional extras:

```bash
./scripts/install_autostart.sh     # macOS: render + install a LaunchAgent (start at login, restart on crash)
./scripts/uninstall_autostart.sh   # remove it
./scripts/live_tail_demo.sh        # stream a few demo lines into the live log pane
bin/dev ls                         # list projects from the shell (needs PyYAML; re-execs under .venv if missing)
```

The steward has its own launchd template at `scripts/com.christian.devsteward.plist`; the install one-liner is in the file header. It requires the `claude` CLI on `PATH`.

## The project.yml manifest

Any project can drop a `project.yml` (or `project.yaml`) in its root to declare its own presence. Everything is optional; a missing or malformed manifest falls back to the plain auto-discovered card. Manifests are cached by mtime.

```yaml
name: reef                # display name (defaults to folder name)
kind: service             # app | service | tool | vault | library | docs | research
status: active            # active | incubating | parked | dormant | archived
description: one-liner
repo: https://github.com/you/reef        # repo link (also inferred from git remote)
port: 3737                # service health check + default link target
health: http://localhost:3737/api/health # HTTP health check (beats bare TCP port probe)
start: pnpm dev           # how to start it (dashboard start button, `dev up`; runs detached)
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
blocker: "waiting on domain decision"   # static banner shown on card + detail page
showcase:                 # what the "latest product" panel renders
  kind: markdown-latest   # app (live iframe / snapshot) | file (served via /files/) | markdown-latest (newest match)
  glob: data/nightly/*.md
tags: [agents, local-ai]
```

Notes on the probe fields (`app/probes.py`):

- `health` — GET a localhost URL, expect HTTP 200. Without it, `port` gets a bare TCP probe.
- `freshness` — newest mtime of `file:` or `glob:`, compared against `warn_days` / `fail_days`.
- `metrics` — `http_json` (URL + dotted path) or `file_json` (file + dotted path); a trailing `len()` counts a list, e.g. `stations.len()`.
- `checklists` — counts `- [ ]` / `- [x]` lines, optionally scoped to a `## section`.
- Results are cached server-side (45s TTL) and rolled into one verdict per project: `red` when a freshness probe fails, `amber` for warnings (stale-but-not-failed files, service down, unpushed commits, dirty tree, a declared blocker), `green` otherwise, and `complete` for a green project whose status is `archived` (or a docs/vault project that is parked or dormant).

Two other conventions the dashboard reads without a manifest:

- `GOALS.md` — markdown checkboxes; the card shows "X/Y done · NN%" and the next undone item, and the project page lets you tick them.
- `CAPABILITIES.md` — rendered on the project page as the long-form description.

## Layout

```
dashboard/
├── app/
│   ├── main.py             FastAPI app, routes, pages, stall watchdog
│   ├── projects.py         project scanner (git status/log, git ls-files stats, README), background-refreshed cache
│   ├── ignore.py           what counts as project work, for the scanner and the watcher alike
│   ├── agents.py           live Claude Code sessions from ~/.claude/sessions and ~/.claude/jobs
│   ├── inbox.py            the Needs-you queue: items, agent branches, triage state
│   ├── schedule.py         launchd jobs: next run, last exit
│   ├── home.py             next goals, this week vs usual, last night, palette corpus
│   ├── claude_sessions.py  session history from transcripts (incremental, deduped usage)
│   ├── ask.py / brief.py / launch.py   ask Claude, project briefs, Terminal launchers
│   ├── manifest.py         project.yml loading + normalisation (schema v2)
│   ├── probes.py           health / freshness / metrics / checklist probes → verdict
│   ├── insights.py         GOALS.md tally, framework detection, insight plugins
│   ├── exec_actions.py     whitelisted actions, detached service start
│   ├── activity.py         cross-project commit / file-change feed
│   ├── streams.py          SSE streams + watchdog observer
│   ├── showcase.py         "latest product" panel (live iframe, file, or newest markdown)
│   ├── reef.py             optional client for a local agent-orchestration daemon
│   └── classroom.py, shortterm.py   read-only views for a sibling project (optional)
├── static/                 tokens.css + shell.js on every page; index (Insights), control (mission control), project, digest, journal, stack, routines; fonts/
├── steward/
│   ├── STEWARD.md          standing orders for the nightly agent
│   └── run_steward.sh      launchd entry point: lock, watchdog, digest fallback
├── bin/dev                 new / ls / up CLI
├── scripts/                launchd templates, install/uninstall, demo
├── data/                   runtime state (nightly digests, notes, snapshots) — git-ignored
├── logs/                   feed.log, launchd + service logs — git-ignored
├── project.yml             the dashboard's own manifest (it appears as a project too)
├── requirements.txt
└── run.sh                  venv bootstrap + uvicorn on :8765
```

## License

MIT — see [LICENSE](LICENSE).
