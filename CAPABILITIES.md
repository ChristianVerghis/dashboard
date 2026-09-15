# Dashboard — Capabilities

The single-page web app you're looking at right now. Auto-discovers projects under the projects root (`~/dev/` by default, `DEV_ROOT` to override) and surfaces their state.

## Per-project metadata

For every git repo or README-bearing folder discovered:

- Commit count, recent commits with author + relative age + GitHub commit URL
- File count, total size on disk, language/extension breakdown
- Branch, remote URL, git state (dirty / ahead / behind / clean)
- Last-modified file (any non-hidden file under the tree)
- README-derived 1-paragraph summary
- Momentum classification — `active` (changed in last 6h), `recent` (last 7d), `stale` (older)
- Open TODOs from `build_log.md` checkboxes
- 30-day commit sparkline (SVG, pure data)
- Framework badge (Next.js / React / Vite / Node / FastAPI / Python / Rust / Go / Vault)

## Manifest-driven signals (`project.yml`)

A project can declare its own dashboard presence with a `project.yml` at its root (schema in `app/manifest.py` and the README). The probe engine in `app/probes.py` executes the declared signals server-side and rolls them into a red / amber / green / complete verdict per project:

- `health:` — HTTP 200 check on a localhost URL (falls back to a TCP probe on `port:`)
- `freshness:` — newest-mtime age of a file or glob vs `warn_days` / `fail_days`
- `metrics:` — headline numbers from a JSON file or a localhost JSON endpoint
- `checklists:` — markdown checkbox tallies beyond `GOALS.md`
- `blocker:` — a static banner shown on the card and detail page

Verdicts drive the attention strip on the index, the dots on each tile, and the signals row on the project page.

## Per-project insights

- Any project with `GOALS.md`: counts markdown checkboxes, surfaces "X/Y done · NN%" plus the next undone item.
- Plugin-style insight functions in `app/insights.py` (`REGISTRY`) can add project-shaped facts when a project matches a known layout; otherwise a generic markdown/python file count is shown.

## Services

- Projects with `kind: service` and a `port:` appear in the services health row.
- A start button runs the manifest's `start:` command detached; output lands in `logs/services/<name>.log`.
- `bin/dev up <name> [--bg]` does the same from the shell; `bin/dev new <name>` scaffolds a project that is dashboard-ready from its first commit.

## Live updates

- **Server-Sent Events** push state to the browser as files change. No manual refresh.
- **`watchdog` file observer** on the entire projects tree (debounced 500ms) triggers re-scan.
- **Live log pane** tails `logs/feed.log`. Append a line from any shell:
  ```bash
  echo "$(date) deploy started" >> logs/feed.log
  ```

## Action buttons (per-project)

Whitelisted shell commands. Output streams to the live log pane.

- Globally available: `status` · `pull` · `log` · `fetch` · `open_in_editor` · `reveal_in_finder`
- Project-specific: declared in `project.yml` under `actions:`, or in `PROJECT_ACTIONS` in `app/exec_actions.py`

## Pages

| Path | What |
|---|---|
| `/` | Index: project tiles, attention strip, services row, activity feed, live log |
| `/project/{name}` | Project page: hero stats, GOALS progress (tickable), signals, insights, links, `CAPABILITIES.md` rendered as markdown |
| `/digest` | Nightly steward digest (latest `data/nightly/*.md`) |
| `/journal` | Cross-project commit timeline with search |
| `/stack` | Side-by-side columns of every project's insights |
| `/routines` | Scheduled-routine snapshot with countdowns |
| `/snapshot.html` | Self-contained HTML export of the current state |

## API endpoints (main ones)

| Path | Returns |
|---|---|
| `GET /api/projects` | All projects with full metadata, manifest and signals |
| `GET /api/projects/{name}` | One project |
| `GET /api/projects/{name}/signals` | Probe results + verdict |
| `GET /api/projects/{name}/actions` | Whitelisted action names |
| `GET /api/projects/{name}/preview` | Most-relevant markdown file (README by default) |
| `GET /api/projects/{name}/capabilities` | That project's `CAPABILITIES.md` |
| `GET /files/{name}/{path}` | Read-only file serving for manifest `path:` links |
| `POST /api/exec` | `{project, action}` runs a whitelisted action; output streams to feed.log |
| `GET /api/activity?limit=N` | Cross-project activity feed |
| `GET /api/now` | "What's happening / what's next" summary |
| `GET /api/stream/projects` | SSE — snapshot then deltas |
| `GET /api/stream/log` | SSE — tail of `logs/feed.log` |

## Nightly steward

`steward/run_steward.sh` (launchd, 02:00 local) runs an unattended agent against the standing orders in `steward/STEWARD.md`: survey `/api/projects`, hygiene (fetch / fast-forward pull / restart down services), advance one eligible project's top `GOALS.md` item on a `nightly/<date>` branch, and write `data/nightly/<date>.md`. The dashboard's own `project.yml` points a freshness probe at those digests, so the cockpit goes red if the steward stops firing.

## Persistence

- Auto-start at macOS login via `scripts/install_autostart.sh` (renders and installs a LaunchAgent).
- Crashes auto-restart via launchd's `KeepAlive`.
- Logs at `logs/launchd.{out,err}.log`; runtime data under `data/` (both git-ignored).

## Tech

- Backend: FastAPI + uvicorn + watchdog + sse-starlette + PyYAML · Python 3.13
- Frontend: vanilla JS + vendored marked.js · no build step
- Discovery: any folder directly under the projects root with `.git` or `README.md`
- Excluded from scan: `.git`, `.venv`, `venv`, `node_modules`, `__pycache__`, `.obsidian`

## What it does NOT do (yet)

- Embed terminal sessions (PTY in browser).
- Authentication. Localhost only.
- Live routine status from an API (the routines page reads a static snapshot).
