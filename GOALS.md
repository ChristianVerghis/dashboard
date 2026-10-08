# Dashboard — running goals

## Core

- [x] Auto-discover projects under ~/dev/
- [x] Per-project cards with metadata + insights
- [x] Live updates via SSE (file watcher)
- [x] Activity feed across projects
- [x] Live log pane (tail of feed.log)
- [x] Sparklines per project
- [x] Action buttons with whitelisted exec
- [x] Markdown preview in detail panel
- [x] Per-project capability page at /project/{name}
- [x] GOALS.md parsing
- [x] Routines snapshot integration with alert insights
- [x] macOS launchd autostart script
- [x] Self-aware — dashboard appears as a project

## Polish & nice-to-haves

- [x] Cross-project search bar (top toolbar, `/` to focus, `Esc` to clear)
- [x] Toast notifications for new commits / file changes
- [x] Per-project capability page rendered from CAPABILITIES.md
- [x] Project-specific quick-actions panel + prediction logger modal
- [x] Routines page with status pills and live countdowns
- [x] Diff viewer for changed files (uncommitted-changes panel, view-only)
- [x] Theme toggle (light/dark with `T` shortcut, persists in localStorage)
- [x] Activity heatmap (12-week SVG grid on main page)
- [x] Cross-project journal (chronological commit timeline)
- [x] Predictions page with calibration buckets
- [x] "Now & Next" ribbon (next routine fire + top undone goal per project)
- [x] "Today" summary panel (commits/files/predictions per project)
- [x] Tickable GOALS editor on every project page
- [x] Framework auto-detection badges (Next.js, FastAPI, Python, Vault)
- [x] Click-to-expand commit details in activity feed
- [x] Mobile-responsive layouts (single-column under 640px)
- [x] Cmd-K command palette (fuzzy search across projects/pages/recent commits)
- [x] "Since you left" banner (delta on returning visits)
- [x] macOS native notifications (toggle in topbar)
- [x] Cross-project commit search (journal page)
- [x] Brier score on calibration view
- [x] First-run onboarding panel
- [x] Project pinning (★ on each card, persists in localStorage)
- [x] Compact-mode toggle (⊟ in toolbar)
- [x] Project icons (auto-generated 2-letter avatar with stable color)
- [x] Git-state badges per card (dirty / ahead / behind / clean)
- [x] Inline diff viewer (click pending file → expand to see changes)
- [x] Keyboard shortcuts HUD (press ?)
- [x] Per-project notes scratchpad (markdown, auto-saves)
- [x] HTML snapshot export (`/snapshot.html` → self-contained file)
- Browser-based terminal (xterm.js + WebSocket PTY): dropped 2026-09-15, too risky; Terminal.app launchers instead
- [x] Live routine status: launchd jobs from their own logs (missed runs, launchd clock drift), cloud routines from what they commit (2026-10-05)

## Structure (2026-06-11)

- [x] project.yml manifest — projects declare kind/status/port/start/links/actions
- [x] Services health row (TCP check on manifest ports, start button, detached)
- [x] `bin/dev new` scaffolder — projects born dashboard-ready
- [x] Reef integration — per-repo agent runs/learnings panel + dispatch button
- Reef cost rollup page: superseded by the usage gauge in Mission control (2026-10-05)
- [x] Lifecycle states in UI (parked projects collapse to a row): home groups projects into active, quiet and parked

## Mission control (2026-10)

From the 2026-10-04 revamp: the home page answers what is broken, what needs me and what is next, and agents are first-class. Items marked (owner) are being built interactively; the steward skips them.

- [x] Scanner cannot wedge the server: one ignore policy, git-native file stats, background rescans, stall watchdog
- [x] Session history counts tokens once per message and tags headless runs by entrypoint
- [x] Shared shell on every page: navigation, ⌘K with actions and Ask, g-chords, help, theme, private mode
- [x] Mission control page (/control): readout sentence, Needs-you queue with done / snooze / mute, Next up, projects grouped active / quiet / parked
- [x] Insights is the landing page (2026-10-05); the mission control link carries the needs-you count
- [x] Live agents from Claude Code's own session and job files; attach background sessions in Terminal
- [x] Scheduled launchd jobs with next run and last exit code
- [ ] Review page: merge locally, discard or revise agent branches from the cockpit (owner)
- [ ] Steward work lands in the review queue, not only in the digest (owner)
- [ ] Dispatch: start a background agent in a worktree from a goal or ⌘K, with a budget and a RAM-aware cap (owner)
- [ ] Hooks feed: session events posted to the dashboard for instant state and notifications (owner; needs an OK to edit ~/.claude/settings.json)
- [ ] Usage gauge from the status line's rate_limits snapshot (owner)
- [ ] The dashboard as an MCP server for every Claude session (owner)
- [ ] Project page redesign on the new tokens (owner)
- [x] Freshness registry (/api/freshness): every data source with its age, expected cadence and fix; feeds Insights, Routines and the Needs-you queue (2026-10-05)
- [x] The dashboard fetches every repo itself every 6 h; static files are always revalidated (2026-10-05)
- [x] System panel on Insights: CPU, memory, disk and the apps using the most, live (2026-10-05)
- [x] Energy and Network tabs: live power from the SMC, battery, what keeps the Mac awake, network rates and totals, per-app traffic (2026-10-05)
