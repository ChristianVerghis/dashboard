# dashboard build log


**Update 2026-07-06**: manifest schema v2 + probe engine. `app/manifest.py` now accepts kinds docs/research, statuses dormant/archived, `repo:`/`health:` fields, `freshness:`/`metrics:`/`checklists:`/`blocker:` probe blocks, mapping-form links and `path:` links (served by new read-only `GET /files/{project}/{path}`); manifest loads cached by mtime. New `app/probes.py` executes probes server-side (TTL 45s) and computes a red/amber/green/complete verdict per project — surfaced as an attention strip on the index, verdict dots on tiles, and a signals row on the project page (`GET /api/projects/{name}/signals`). Wrote/updated project.yml for all 10 projects (5 were invisible before). Fixes: `/api/projects/{name}` 404 tuple bug, zoneinfo instead of hardcoded UTC-4, `removesuffix('.git')`, `datetime.utcnow()` deprecations, guarded the shortterm live-session task (its unhandled per-bar errors filled launchd.out.log to 26 GB — truncated, tail sample kept, uvicorn now runs `--no-access-log` with a 200 MB rotation guard in run.sh). Routines snapshot staleness (57d) now flagged in `/api/now`, `/api/routines`, and both UIs instead of showing negative countdowns. marked.js vendored into static/.

**Update 2026-06-11**: project.yml manifest system (app/manifest.py), services health row with detached start, reef daemon integration (app/reef.py — per-repo runs/learnings + dispatch), `bin/dev new` scaffolder. Fixed a stale hardcoded projects path in api_log_prediction.

**Update 2026-09-01**: nightly automation. New local **steward** (`steward/STEWARD.md` standing orders + `steward/run_steward.sh` wrapper, launchd `com.christian.devsteward` at 02:00 local, 75-min watchdog, lock file, logs in `logs/steward/`). It surveys `/api/projects`, does hygiene (fetch/ff-pull, restart down active services), advances ONE eligible project's top GOALS item on a `nightly/<date>` branch (never main), and writes `data/nightly/<date>.md` — now the dashboard's own showcase (markdown-latest) with a freshness probe (warn 2d / fail 4d) so the cockpit goes red if the steward stops firing. Projects that already have their own scheduled automation are left alone by the steward (report-only). `data/routines_snapshot.json` refreshed from the live API (was 114d stale).

**Update 2026-09-01 (later)**: steward orders updated — projects with their own launchd/cloud schedules are routine-owned; the steward only reads their `data/cron/` logs and flags `!!` failures or missing runs. Routines snapshot refreshed again after re-enabling several cloud routines; manifests flipped back to active, blockers cleared.

## 2026-09-19 — external activity sources in the heatmap

- `data/external_activity/<id>.json` = `{name, kind, source, approximate, days: {"YYYY-MM-DD": n}}`. `heatmap_data()` adds each file's counts to the day totals and to `by_project` under its name, and reports them in a new `external` list on `/api/heatmap`. No times, so punch card, sessions and code frequency ignore them. First source: `enedym-gitlab.json`, per-day levels transcribed from a photo of the GitLab contribution calendar (approximate).
- `/share.html`: external sources get a project row (kind "work, approx.") and a footer note naming them. Payload gains `external`.
- The portfolio's `scripts/pull_activity.py` now takes `work_total` from that payload instead of merging its own copy.
- Restart after code changes: `launchctl kickstart -k gui/$(id -u)/com.christian.projectsdashboard`.

## 2026-10-04 — market map + live classroom insights

- `/markets` page (`static/markets.{html,js}`) on the new whole-market layer from the markets repo; `/api/markets/map`, `/api/markets/series`; nav link on the index.
- Live classroom rebuilt around "which techniques are working and which bets paid, and why": `static/classroom_insights.js` (banner, KPIs, scoreboard, bet cards + modal) shared by the live and past-session pages, backed by classroom's `session_analytics.py` through `/api/classroom/live/insights`, `/session/{id}/insights`, `/bet/{id}`. Session controls moved to their own row; start takes universe, replay speed and slippage.
- `static/viz.{js,css}`: shared chart primitives (sparkline, columns, line chart with crosshair, bet price path, labelled scatter, heatmap) on a palette validated against this dashboard's surfaces.
- Watcher ignores `shortterm/{sessions,students,data}/`: session writes forced a classroom rescan + git status per event and pinned the process at ~300% CPU.
- Live page throttles grid refetch / tape / board redraw (one fetch per resolution exhausted the browser during replays).

## 2026-10-05 — Mission control, phases 0 and 1

Why: the dashboard stalled after days up (300 % CPU, /api/projects, /now and /heatmap timing out, so the index showed empty panels), could not see the six Claude sessions running, and 23 agent branches sat unreviewed across six repos; the steward had built "collapse parked projects" four times because its goal tick only reaches main on merge.

- Scanner: one ignore policy for watcher and scanner (`app/ignore.py`), file stats from `git ls-files`, one `git status --porcelain=v2 --branch --no-optional-locks` instead of four calls, stale-while-revalidate cache with single-flight cold scans and a background rescan pool. Full scan 6.8 s → 2.2 s; idle CPU ~1 %. Same treatment for the 52-week heatmap. Stall watchdog exits for a launchd restart if request threads or the event loop stop answering.
- Session history: usage counted once per message id (was 2.2–3.6× high), transcripts read incrementally, headless runs tagged by `entrypoint`.
- Backend for the home page: `agents.py`, `inbox.py`, `schedule.py`, `home.py`; times follow the Mac's zone instead of a hardcoded Toronto.
- Front end: design tokens and Geist; `shell.js` on every page (bar, ⌘K with actions and Ask, g-chords, help, private mode); the new home; the old index is `/insights` on a 547-line `insights.js` (was `app.js`, 1491 lines; `ask.js` folded into ⌘K).
- Share card hides external source names with `?names=0`. reef daemon (separate repo) now refuses foreign origins.
- Steward: skips `(owner)` goals and goals an unmerged nightly branch already attempts.
- Built on branch `revamp/mission-control`; tested on a second instance (:8767) with headless Chrome screenshots in both themes, private mode and at phone width.

## 2026-10-05 — classroom track record

- `/classroom/retest` (`static/classroom_retest.{html,js}`, `GET /api/classroom/retest`): the short-term cohort's weekly re-test — each completed week replayed on the current engine, techniques judged across weeks. Linked from the live page and the shell's Apps menu ("Track record").

## 2026-10-05 — Insights is the landing page

The owner preferred opening on Insights and navigating from there. `/` now serves Insights (`static/index.html`); mission control moved to `/control` (`static/control.html`); `/insights` redirects to `/`. The shell bar reads Insights, Mission control (with an amber or red count when something is broken or waiting on you), Digest, Journal, Routines; `g h` / `g i` go to Insights, `g c` to mission control.

## 2026-10-05 — Staleness pass: revive and guard

What was stale: the Routines page showed a Sep 2 snapshot as "armed" countdowns (and this machine's routines API sees none of them); twenty repos had not been fetched since Oct 3, which made the careers and EV-Network routines look dead when they were fine; the steward lost the night of Oct 5 because launchd kept Toronto time after the Mac moved to Pacific, started it at 23:00 and it dated itself into the previous night's digest; launchd's next-run times were off by 3 h on every page; Insights counted dormant services as down; the Stack page was empty for 18 of 22 projects; every project page showed an empty reef panel; showcase screenshots were 91 days old.

- `app/freshness.py` + `/api/freshness`: one registry of every source with cadence, verdict and fix; Insights summary line and panel, Needs-you items, steward digest.
- `app/fetcher.py`: the dashboard fetches any repo older than 6 h itself (never prompts, skips repos mid-operation).
- `app/schedule.py`: last run from each job's own log, missed-run detection, and launchd's real clock inferred from the logs (+180 min while traveling).
- `app/routines.py` + rebuilt `/routines`: local jobs and cloud routines judged by evidence; the snapshot only names things.
- `steward/run_steward.sh`: a run after 18:00 is dated as the coming night.
- Project pages: live sessions in the project, the reef panel only when it has runs, Capabilities hidden when missing, screenshots dated and retaken when two weeks old; Stack falls back to the README; relative README links point at the project's files.
- Status mismatch suggestions (active but quiet 60 days on every branch, or dormant but just worked on) with a one-click fix; `Cache-Control: no-cache` on pages and static files; self-restart when the server runs older code than the checkout.

## 2026-10-05 — System panel on Insights

Activity Monitor's CPU, Memory and Disk tabs as one panel at the top of Insights (`app/perf.py`, `static/perf.js`, `static/perf.css`, `/api/perf`): live numbers, a ten-minute chart, and the eight apps using the most of each resource. psutil for system counters (new dependency), `vm_stat` for the memory breakdown, the kernel's pressure level via sysctl, and `proc_pid_rusage` (ctypes) for per-app physical footprint and disk bytes, which psutil does not provide on macOS. On first run it showed swap 16 of 17 GB, 60 GB free of 995, Chrome at 17.6 GB across 129 processes and Docker at 10.7 GB.

Then Energy and Network tabs. Power is the SMC's `PSTR` key through the AppleSMC user client (ctypes, no root, 0.2 ms a read): the battery registry's `SystemLoad` read 3 W while Chrome ran at 110% CPU because it only refreshes about once a minute, while the SMC read 10 to 15 W. The kernel's per-process `ri_billed_energy` is near zero on this Mac, so per-app energy impact is estimated from CPU time and wakeups. psutil's interface counters wrap at 4 GB here (en0 read 344 MB against netstat's 120.6 GB), so totals come from `netstat -ibn` (3 ms). `nettop -n -t external` costs 16 ms without name lookups (seconds with them) and runs only while the Network tab is open; a 3 MB/s curl download showed up as curl at 3.1 MB/s. Claude Code keeps the Mac awake through `caffeinate`, now shown under Claude Code. The server costs about 2% of one core on every tab.

