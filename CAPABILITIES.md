# Dashboard — Capabilities

A local cockpit for everything under the projects root (`~/dev/` by default, `DEV_ROOT` to override): it auto-discovers projects, watches the Claude Code sessions running on the machine, and puts what is broken, what needs a decision and what is next on one page.

## Mission control (`/control`)

Insights (`/`) is the landing page; mission control is one click away in the bar, where its link shows how many things are broken or waiting on you.

- **Readout** — one sentence built from live state: what is broken, how many things need you, how many agents are working, how long the longest-blocked one has waited; and the next scheduled run.
- **Needs you** — one ranked queue, worst first:
  - *broken*: an active service is down, a launchd job failed its last run, a freshness probe failed in a project touched in the last 14 days, a background agent failed;
  - *needs you*: a background agent is blocked on a question (shown verbatim), agent branches are waiting for review (one item per repo; branches that chase the same goal are grouped as repeats);
  - *drift*, folded into one row: unpushed commits, uncommitted work untouched for 3+ days, stale data in quiet projects, routine branches piling up on origin, declared blockers, an old routines snapshot.
  Triage with `e` done, `h` snooze (an hour, this evening, tomorrow, next Monday) or `m` mute (30 days), each with undo. Done and snoozed items return when they change (a new question, new commits, another failure). State lives in `data/inbox.json`.
- **Preview sheet** (`space`) — for a review item: every branch with its goal and size, repeats marked, the newest branch's files and diff, and copyable merge / delete commands; for an agent: its question, what it did, and recent output (`claude logs`); for a failed job: its log tail.
- **Next up** — the first open `GOALS.md` item of each project you are not parking, most recently worked first.
- **Projects** — active (touched this week or an agent is in it), then quiet and parked behind a row each; a row shows a status mark, the next step (failing probe or next goal), a 30-day sparkline, goal progress and last commit.
- **Agents** — every running Claude Code session from `~/.claude/sessions/<pid>.json` and `~/.claude/jobs/<id>/state.json` (the files `claude agents --json` reads), titled from its transcript: blocked, your turn (finished in the last 30 minutes), working, idle; headless `claude -p` runs counted on one line. `↵` attaches a background session in Terminal.
- **Scheduled**, **This week** (against the median of the eight weeks before), **Last night** (the steward digest in one sentence).
- Keyboard: `1`–`4` jump between regions, `j`/`k` move, `↵` acts, `o` opens the item's project, `c` starts Claude there. Every list paints from the browser cache first.

## Routines (`/routines`)

- **On this Mac:** launchd jobs that run something in your projects, with the configured schedule, the next run in local time, and the last run read from the job's own per-run log (careers `logs/daily`, steward `logs/steward`, markets and classroom `data/cron`). A run that did not happen after its scheduled time shows as missed; a non-zero exit as failed; *Run now* kickstarts the job.
- **launchd's clock:** launchd keeps the time zone it had at login. When the logs show jobs starting a consistent number of hours off their configured times (two or more jobs agreeing), the page says so and shows next runs on that real clock.
- **In the cloud:** routines grouped by project, judged by the newest commit a routine (author "Claude") made on that repo's origin against its usual gap: current, overdue (twice the usual gap) or stopped (four times). Names, models and schedules come from `data/routines_snapshot.json`; nothing depends on that snapshot being recent.

## System panel (Insights, `/api/perf`)

CPU, Memory, Energy, Disk and Network tabs like Activity Monitor. CPU: user, system and idle across all cores, load average, a stacked ten-minute chart. Memory: used of total with Activity Monitor's breakdown (app memory, wired, compressed, cached files from `vm_stat`), the kernel's memory-pressure level (the chart turns amber or red where it rose), swap used. Energy: the whole Mac's power draw in watts, live from the SMC (`PSTR`, read without root; the battery registry's once-a-minute reading is the fallback), battery level, power source, time left or until full, maximum capacity and cycle count, and the apps keeping the Mac awake (`pmset -g assertions`; `caffeinate` is credited to whoever started it, usually Claude Code); per-app energy impact is relative, from CPU time and wakeups, as Activity Monitor estimates it. Disk: read and write throughput, operations per second, and free space on the data volume. Network: receive and send rates, packets per second and totals since boot over Wi-Fi, Ethernet and AirDrop (`netstat -ib`, since psutil's counters wrap at 4 GB on macOS; loopback, VPN tunnels and bridges are left out so nothing counts twice), with per-app rates from `nettop` (localhost left out), which runs only while the Network tab is open. Each tab lists the eight apps using the most, with processes grouped by their outermost `.app` bundle (Chrome's helpers count as Google Chrome) and generic runtimes named after the project they run in (`next-server · portfolio`). Per-app CPU, memory (physical footprint) and disk come from the kernel's `proc_pid_rusage` for your own processes; system processes fall back to `ps` and have no disk figure. Full sampling runs every 2 s only while the panel is on screen; totals alone are taken every 10 s in the background so the chart opens with history.

## Data freshness (`/api/freshness`)

Every source the pages lean on, each with an expected cadence, a verdict (ok, warn, fail, unknown, info) and a fix: the nightly digest (warn at 30 h), each repo's last `git fetch` (the dashboard fetches any repo older than 6 h, every half hour, without prompting), every scheduled job, every cloud routine, showcase screenshots (retaken in the background when a project page is opened and the app is up), external activity files, the cloud routine list, and whether the server runs older Python than the checkout (*Restart the dashboard*). Insights shows a one-line summary under its header and the full list at the bottom; `warn` and `fail` become Needs-you items; the nightly steward lists them in its digest. Pages and static files are served with `Cache-Control: no-cache`, so an edited script is never stale in the browser.

## Shell (every page)

`static/shell.js` and `static/tokens.css` load in every page's head. A global bar (Insights, Mission control with its count, Digest, Journal, Routines, Apps), light and dark themes from the same tokens, private mode, and a status mark plus a "(n)" tab-title count when something is broken or waiting on you. Keys: `⌘K` or `/` palette, `g h` or `g i` for Insights, `g c` for mission control, `g d` / `g j` / `g r` to go, `g p` to pick a project, `t` theme, `p` private mode, `?` help. The palette searches pages, projects, actions (open in Terminal, start Claude in a project, copy a brief, start a down service) and recent commits; anything longer than two characters can be sent to Claude as a question, answered in the palette from a summary of all projects.

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
- **`watchdog` file observer** on the projects tree marks changed projects dirty (debounced 1.5 s, at most 5 s during a storm); a two-worker pool rescans them in the background, at most every 5 s each, and the SSE stream pushes the new payload when a rescan lands. Requests never wait on a rescan once a project has been scanned. Which paths count is one policy (`app/ignore.py`) for the watcher and the scanner: dependencies, build output, Unreal caches, logs, sqlite journals, dot-directories, plus `.git` except HEAD, refs and FETCH_HEAD.
- **Stall watchdog** — if request threads cannot run a no-op for three 20-second checks in a row, or the event loop stops for two minutes, the process exits non-zero and launchd restarts it (`DASHBOARD_WATCHDOG=0` turns it off).
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
| `/` | Insights, the landing page: week band, weekly review, services row, loose ends, maker blocks, code frequency, 12-month heatmap, activity feed, live log (`/insights` redirects here) |
| `/control` | Mission control: readout, Needs you, Next up, Projects, Agents, Scheduled, This week, Last night |
| `/project/{name}` | Project page: hero stats, GOALS progress (tickable), signals, insights, links, `CAPABILITIES.md` rendered as markdown |
| `/digest` | Nightly steward digest (latest `data/nightly/*.md`) |
| `/journal` | Cross-project commit timeline with search |
| `/stack` | Side-by-side columns of every project's insights |
| `/routines` | Scheduled-routine snapshot with countdowns |
| `/snapshot.html` | Self-contained HTML export of the current state |
| `/markets` | Market map: regime (nine cross-asset signals + six-month history), EV watchlist vs the market, rates & volatility, an 82-benchmark heat table, sector rotation, the day's largest σ moves, each watchlist name vs its best-fit benchmark, cross-asset correlation. Reads `markets/data/processed/market_map.json` (`MARKETS_ROOT` overrides the repo path to preview a branch) |
| `/classroom/live` | Short-term cohort, live: data-source banner (synthetic / replay / live), session KPIs and cumulative net-bps curve vs controls, a technique scoreboard (verdict after a one-tick cost, activity, hit vs break-even, per-symbol/regime/variant breakdowns), and bet cards that explain each trade — what the student saw, what happened, the regime, the cost, the technique's record — with the price path around it |
| `/classroom/live/sessions/{id}` | The same insight views for any past session |
| `/classroom/retest` | Track record from classroom's weekly re-test: does any short-term edge persist across weeks? Headline (persistent edges vs the number expected by chance), a technique × universe matrix of mean net bps, and a week-by-week grid per universe with t across weeks, t vs the coin-flip control and the bar each needs |

## API endpoints (main ones)

| Path | Returns |
|---|---|
| `GET /api/inbox` | The Needs-you queue (`?all=1` adds set-aside items); `POST /api/inbox/triage` `{id, action: done\|snooze\|mute\|restore, until?}`; `GET /api/inbox/preview?id=` |
| `GET /api/agents` | Live Claude Code sessions; `POST /api/agents/{id}/attach`, `GET /api/agents/{id}/logs` for background sessions |
| `GET /api/schedule` | launchd jobs: schedule, next run (on launchd's clock), last run from the job's log, missed, last exit; `POST /api/schedule/{label}/run` |
| `GET /api/routines` | The Routines page: local jobs plus cloud routines with commit-based health |
| `GET /api/freshness` | Every data source with its age, cadence, verdict and fix |
| `GET /api/fetch` | Last fetch per repo; `POST /api/fetch` fetches every repo now |
| `POST /api/self/restart` | Exit so launchd restarts the dashboard on the code on disk |
| `POST /api/projects/{name}/status` | Set `status:` in a project's project.yml |
| `GET /api/home` | Next goals, this week vs usual, last night's digest |
| `GET /api/palette` | Projects and recent commits for ⌘K |
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
| `GET /api/markets/map` · `/api/markets/series` | Market map + 1y chart series from the markets repo |
| `GET /api/classroom/live/insights` | Live session insights (classroom `session_analytics.py`) |
| `GET /api/classroom/live/session/{id}/insights` | Past-session insights (parsed sessions cached, two at a time) |
| `GET /api/classroom/live/bet/{bet_id}?session=` | One bet: explanation + price path |
| `GET /api/classroom/retest` | classroom `shortterm/retest/summary.json` + which weekly sessions still have payloads |

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

- Land agent branches from the page (merge / discard / revise): the preview gives the commands to copy.
- Start agents: dispatching a background session in a worktree from a goal or ⌘K is next.
- Approve an agent's permission prompts from the browser, or embed terminals: deliberately not; Terminal.app does that.
- Authentication. Localhost only.
- Live cloud routine status from an API (the routines page reads a static snapshot; launchd jobs are live).

## Private mode

The 👁 / 🙈 button in the top bar (or `P`, ignored while typing) blurs personal text on every page:
project names, commit subjects, goals, digests, log lines, session titles, file names in diffs. Numbers,
ages, badges, health dots, headings and buttons stay crisp, everything stays clickable, and hovering a
blurred value peeks at it. Meant for showing the dashboard to someone or screen-recording it without
hand redaction. Which projects keep their real names: `visibility: public` in a `project.yml`, or a name
listed in `data/privacy.json` (`{"public": [...]}`); everything else is private by default. Served by
`GET /api/privacy`; the switch is client-side (`static/privacy.js`, persisted in localStorage).
