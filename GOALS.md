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
- [ ] Browser-based terminal (xterm.js + WebSocket PTY)
- [ ] Live routine status from API (vs static snapshot)

## Structure (2026-06-11)

- [x] project.yml manifest — projects declare kind/status/port/start/links/actions
- [x] Services health row (TCP check on manifest ports, start button, detached)
- [x] `bin/dev new` scaffolder — projects born dashboard-ready
- [x] Reef integration — per-repo agent runs/learnings panel + dispatch button
- [ ] Reef cost rollup page (/usage across all repos)
- [ ] Lifecycle states in UI (parked projects collapse to a row)
