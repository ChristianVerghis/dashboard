# dev dashboard

**A live cockpit for every side project under `~/dev`: one page that shows what is running, what is stale, what is blocked, and what to do next.**

## What it is

A small FastAPI service plus a vanilla-JS single-page app, no build step. On start it scans the projects root (`~/dev` by default) and treats every direct subdirectory with a `.git` folder or a `README.md` as a project. For each one it shows commit activity, git state, a 30-day sparkline, `GOALS.md` progress, and a red / amber / green verdict computed from probes the project declares in its own `project.yml`.

The main pieces:

- **Project tiles and an attention strip** — every project with its verdict, momentum (active / recent / stale), last commit, framework badge, and pinned-project ordering.
- **Services health row** — projects declared as `kind: service` get a TCP or HTTP health check on their port and a start button that launches their `start:` command detached, logging to `logs/services/<name>.log`.
- **Project pages** at `/project/{name}` — hero stats, a tickable `GOALS.md` editor, manifest signals and links, insights, recent commits, an uncommitted-changes diff viewer, whitelisted action buttons, and the project's own `CAPABILITIES.md` rendered as markdown.
- **Live updates** — a `watchdog` observer on the whole tree pushes changes to the browser over Server-Sent Events; a live log pane tails `logs/feed.log` so any shell can `echo` into the UI.
- **Cross-project views** — activity feed and heatmap, `/journal` commit timeline with search, `/stack` insight columns, `/routines` for scheduled-routine countdowns, a Cmd-K command palette, and `/snapshot.html` for a self-contained HTML export.
- **Nightly steward** (`steward/`) — a launchd job at 02:00 that runs an unattended agent against written standing orders: survey the API, do hygiene (fetch, fast-forward pull, restart down services), advance one project's top goal on a `nightly/<date>` branch, and write a digest to `data/nightly/`. The dashboard points a freshness probe at those digests so it goes red if the steward stops firing.
- **`bin/dev` CLI** — `dev new <name>` scaffolds a project with `README.md`, `GOALS.md`, `build_log.md`, and a `project.yml` so it is dashboard-ready from its first commit; `dev ls` lists every project with kind / status / port / running; `dev up <name> [--bg]` starts one using its manifest's `start:` command.

## Why I built it

I run a dozen or so side projects at once, and the cost of that is not writing code but remembering state: which service is down, which repo has a dirty tree, which goal is next, which data file has quietly gone stale. This gives all of that a single page, and the `project.yml` convention means each project describes itself instead of the dashboard hardcoding plugins for it. The nightly steward came later, once the page could tell an agent enough to act safely on its own.

## Status

As of 2026-09-15: in daily use on one machine. Manifest schema v2 with the probe engine, services row, steward, and `bin/dev` are all live. Open items are a browser-based terminal (xterm.js + PTY), reading routine status live from an API rather than a snapshot file, and a cost rollup page for agent runs. macOS-only in the launchd scripts and a couple of `open`-based actions; the server itself is plain Python.

## Stack

- Python 3.13, FastAPI, uvicorn, `watchdog`, `sse-starlette`, PyYAML
- Vanilla JavaScript and CSS, vendored `marked.js`; no bundler, no framework
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
│   ├── main.py             FastAPI app, routes, pages
│   ├── projects.py         project scanner (git log, file walk, README parse), TTL cache
│   ├── manifest.py         project.yml loading + normalisation (schema v2)
│   ├── probes.py           health / freshness / metrics / checklist probes → verdict
│   ├── insights.py         GOALS.md tally, framework detection, insight plugins
│   ├── exec_actions.py     whitelisted actions, detached service start
│   ├── activity.py         cross-project commit / file-change feed
│   ├── streams.py          SSE streams + watchdog observer
│   ├── showcase.py         "latest product" panel (live iframe, file, or newest markdown)
│   ├── reef.py             optional client for a local agent-orchestration daemon
│   └── classroom.py, shortterm.py   read-only views for a sibling project (optional)
├── static/                 index, project, digest, journal, stack, routines pages; vanilla JS/CSS
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
