// Home: the readout sentence and four keyboard regions (Needs you, Next up,
// Projects, Agents) with the side blocks. Data comes from /api/inbox,
// /api/agents, /api/schedule, /api/home and the projects SSE stream; each is
// cached in localStorage so a reload paints at once, then refreshed.
(function () {
  const S = window.Shell;
  S.statusOwner = 'home'; // the shell's status mark is fed from our own inbox loads
  const $ = (id) => document.getElementById(id);
  const { esc, pv, px, ago, mark } = S;

  const state = { inbox: null, agents: null, schedule: null, home: null, projects: null, loadedAt: {} };
  const showQuiet = { quiet: false, parked: false };

  // ---------- data ----------
  const SOURCES = { inbox: '/api/inbox', agents: '/api/agents', schedule: '/api/schedule', home: '/api/home' };
  function cached(name) { try { return JSON.parse(localStorage.getItem(`mc:${name}`) || 'null'); } catch { return null; } }
  function remember(name, data) { try { localStorage.setItem(`mc:${name}`, JSON.stringify(data)); } catch { /* quota or private window */ } }

  async function load(name) {
    try {
      const data = await S.getJSON(SOURCES[name]);
      state[name] = data;
      state.loadedAt[name] = Date.now();
      remember(name, data);
      render(name);
    } catch { /* keep showing the last good data; the readout says how old it is */ }
  }

  function slimProject(p) {
    const goals = (p.insights || []).find((i) => i.label === 'Goals');
    const next = (p.insights || []).find((i) => i.label === 'Next up');
    const m = goals && /(\d+)\/(\d+)/.exec(goals.value || '');
    return {
      name: p.name, status: (p.manifest || {}).status || null, kind: (p.manifest || {}).kind || null,
      momentum: p.momentum, last: p.last_commit ? p.last_commit.date_iso : null,
      touched: p.last_modified_file ? p.last_modified_file.modified_iso : null,
      byDay: p.commits_by_day || [], verdict: ((p.signals || {}).verdict || {}).level || 'green',
      reasons: ((p.signals || {}).verdict || {}).reasons || [],
      done: m ? +m[1] : null, total: m ? +m[2] : null, next: next ? next.value : null,
      branch: p.branch, ahead: (p.git_state || {}).ahead || 0, dirty: (p.git_state || {}).dirty_count || 0,
      framework: p.framework, summary: p.summary, port: (p.manifest || {}).port || null, up: p.service_up,
    };
  }

  function connectProjects() {
    let es;
    try { es = new EventSource('/api/stream/projects'); } catch { return; }
    es.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (!msg.projects) return;
      state.projects = msg.projects.map(slimProject);
      state.loadedAt.projects = Date.now();
      remember('projects', state.projects);
      renderProjects();
    };
    es.onerror = () => { /* EventSource reconnects on its own */ };
  }

  // ---------- regions, selection, keys ----------
  const REGIONS = ['inbox', 'next', 'projects', 'agents'];
  const LIST = { inbox: 'inbox-list', next: 'next-list', projects: 'project-list', agents: 'agent-list' };
  const SECTION = { inbox: 'r-inbox', next: 'r-next', projects: 'r-projects', agents: 'r-agents' };
  const entries = { inbox: [], next: [], projects: [], agents: [] }; // [{key, data, kind}]
  const selKey = { inbox: null, next: null, projects: null, agents: null };
  let region = 'inbox';

  function rowsOf(r) { return [...document.querySelectorAll(`#${LIST[r]} > .row`)]; }
  function indexOf(r) {
    const i = entries[r].findIndex((e) => e.key === selKey[r]);
    return i < 0 ? 0 : i;
  }
  function paintSelection() {
    for (const r of REGIONS) {
      document.getElementById(SECTION[r]).classList.toggle('focused', r === region);
      const i = indexOf(r);
      const list = $(LIST[r]);
      rowsOf(r).forEach((el, n) => { el.id = `row-${r}-${n}`; el.setAttribute('aria-selected', String(n === i)); });
      if (rowsOf(r)[i]) list.setAttribute('aria-activedescendant', `row-${r}-${i}`); else list.removeAttribute('aria-activedescendant');
    }
    renderKeybar();
  }
  function select(r, i, scroll = true) {
    const list = entries[r];
    if (!list.length) return;
    region = r;
    const n = Math.max(0, Math.min(list.length - 1, i));
    selKey[r] = list[n].key;
    paintSelection();
    if (scroll) {
      const el = rowsOf(r)[n];
      if (el) el.scrollIntoView({ block: 'nearest' });
    }
  }
  function move(delta) {
    moveSelection(delta);
    if (S.sheet.isOpen) preview();
  }
  function moveSelection(delta) {
    const i = indexOf(region) + delta;
    const pos = REGIONS.indexOf(region);
    if (i >= entries[region].length && pos < REGIONS.length - 1) {
      const next = REGIONS.slice(pos + 1).find((r) => entries[r].length);
      if (next) return select(next, 0);
    }
    if (i < 0 && pos > 0) {
      const prev = REGIONS.slice(0, pos).reverse().find((r) => entries[r].length);
      if (prev) return select(prev, entries[prev].length - 1);
    }
    select(region, i);
  }
  function current() { return entries[region][indexOf(region)] || null; }

  function wireRows(r) {
    rowsOf(r).forEach((el, n) => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('a,button')) return;
        select(r, n, false);
      });
      el.addEventListener('dblclick', () => { select(r, n, false); primary(); });
    });
  }

  // ---------- readout ----------
  const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
  const say = (n) => (n < WORDS.length ? WORDS[n] : String(n));
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  function waited(iso) {
    const d = (Date.now() - new Date(iso).getTime()) / 86400000;
    if (d >= 2) return `${Math.floor(d)} days`;
    const h = d * 24;
    return h >= 2 ? `${Math.floor(h)} hours` : 'a while';
  }

  function renderReadout() {
    const el = $('readout');
    const inbox = state.inbox;
    const agents = state.agents;
    if (!inbox && !agents) return;
    const c = (inbox && inbox.counts) || { broken: 0, needs: 0, drift: 0 };
    const a = (agents && agents.counts) || {};
    const parts = [];
    if (c.broken) parts.push(`<a class="clause" href="#r-inbox" data-region="inbox">${mark('broken')}${cap(say(c.broken))} ${c.broken === 1 ? 'thing is' : 'things are'} broken</a>`);
    if (c.needs) {
      const lead = c.broken ? say(c.needs) : cap(say(c.needs));
      parts.push(`<a class="clause" href="#r-inbox" data-region="inbox">${c.broken ? '' : mark('needs')}${lead} ${c.needs === 1 ? 'thing needs' : 'things need'} you</a>`);
    }
    let first = parts.length === 2 ? `${parts[0]} and ${parts[1]}.` : parts.length ? `${parts[0]}.` : 'Nothing needs you.';
    if (!parts.length && c.drift) first = `Nothing needs you; ${say(c.drift)} ${c.drift === 1 ? 'thing is' : 'things are'} drifting.`;

    let second = '';
    if (agents) {
      const working = a.working || 0;
      const blocked = (agents.agents || []).filter((x) => x.state === 'blocked');
      const turn = a.your_turn || 0;
      const bits = [];
      bits.push(working ? `${cap(say(working))} ${working === 1 ? 'agent is' : 'agents are'} working` : 'No agent is working');
      if (turn) bits.push(`${say(turn)} finished and ${turn === 1 ? 'waits' : 'wait'} for your reply`);
      if (blocked.length) {
        const oldest = blocked.reduce((m, x) => (!m || x.since < m.since ? x : m), null);
        bits.push(blocked.length === 1 ? `one has waited ${waited(oldest.since)} on a question` : `${say(blocked.length)} are blocked on questions`);
      }
      second = ` <a class="clause" href="#r-agents" data-region="agents">${bits.join('; ')}.</a>`;
    }
    el.innerHTML = first + second;
    el.querySelectorAll('a.clause').forEach((x) => x.addEventListener('click', (e) => { e.preventDefault(); select(x.dataset.region, 0); }));
    S.status(c);
    renderReadoutSub();
  }

  function renderReadoutSub() {
    const jobs = (state.schedule && state.schedule.jobs) || [];
    const next = jobs.find((j) => j.next_run);
    $('readout-next').innerHTML = next ? `${next.project ? pv(cap(next.name), next.project) : esc(cap(next.name))} runs at ${clock(next.next_run)}${dayWord(next.next_run)}` : '';
    // the age of the older of the two feeds the sentence is built from, once both have answered
    const live = ['inbox', 'agents'].map((k) => state.loadedAt[k]).filter(Boolean);
    if (live.length < 2) {
      $('readout-checked').textContent = state.inbox || state.agents ? 'Showing what was here last time' : 'Checking…';
      return;
    }
    const age = (Date.now() - Math.min(...live)) / 1000;
    $('readout-checked').textContent = age < 15 ? 'Up to date' : `Last checked ${ago(new Date(Date.now() - age * 1000).toISOString())} ago`;
    $('readout').classList.toggle('stale', age > 90);
  }

  function clock(iso) {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  }
  function dayWord(iso) {
    const d = new Date(iso);
    const today = new Date();
    const tomorrow = new Date(); tomorrow.setDate(today.getDate() + 1);
    if (d.toDateString() === today.toDateString()) return '';
    if (d.toDateString() === tomorrow.toDateString()) return d.getHours() < 6 ? ' tonight' : ' tomorrow';
    return ` ${d.toLocaleDateString([], { weekday: 'short' })}`;
  }

  // ---------- Needs you ----------
  const SEV_MARK = { broken: 'broken', needs: 'needs', drift: 'drift' };
  let showDrift = false;
  function quoteAsk(text) {
    const t = String(text || '').trim();
    return `“${t.charAt(0).toUpperCase()}${t.slice(1)}”`;
  }
  function inboxRow(it) {
    const primaryAct = (it.actions || [])[0];
    const title = it.kind === 'agent' && it.severity === 'needs' ? quoteAsk(it.title) : it.title;
    const detail = it.detail ? `<span class="detail">${px(it.detail)}</span>` : '';
    const meta = it.meta ? `<span class="meta">${esc(it.meta)}</span>` : '';
    return `<li class="row" role="option" data-key="${esc(it.id)}">
      <span class="lead">${mark(SEV_MARK[it.severity] || 'drift')}</span>
      <span class="main"><div class="title">${px(title)}</div>${detail || meta ? `<div class="line2 split">${detail}${meta}</div>` : ''}</span>
      <span class="end">${it.project ? `<span class="proj">${pv(it.project, it.project)}</span>` : ''}${it.since ? `<span>${ago(it.since)}</span>` : ''}
        ${primaryAct ? `<span class="act">${esc(primaryAct.label)} <kbd>↵</kbd></span>` : ''}</span>
    </li>`;
  }
  function renderInbox() {
    const data = state.inbox;
    const list = $('inbox-list');
    if (!data) return;
    const items = data.items || [];
    const urgent = items.filter((it) => it.severity !== 'drift');
    const drift = items.filter((it) => it.severity === 'drift');
    entries.inbox = urgent.map((it) => ({ key: it.id, data: it, kind: 'inbox' }));
    const rows = urgent.map(inboxRow);
    if (drift.length) {
      entries.inbox.push({ key: 'group:drift', data: { group: 'drift' }, kind: 'drift-group' });
      const kinds = [...new Set(drift.map((it) => ({ unpushed: 'unpushed work', dirty: 'uncommitted changes', fresh: 'stale data', blocker: 'blockers you noted', 'routine-branches': 'routine branches', routines: 'an old schedule' }[it.kind] || 'housekeeping')))];
      rows.push(`<li class="row group" role="option" data-key="group:drift"><span class="lead" aria-hidden="true">${showDrift ? '▾' : '▸'}</span>
        <span class="main"><div class="title">${showDrift ? 'Hide' : 'Show'} ${drift.length} drifting</div><div class="line2">${esc(kinds.slice(0, 4).join(', '))}</div></span><span class="end"></span></li>`);
      if (showDrift) for (const it of drift) { entries.inbox.push({ key: it.id, data: it, kind: 'inbox' }); rows.push(inboxRow(it)); }
    }
    const hidden = data.hidden || {};
    const nHidden = (hidden.done || 0) + (hidden.snoozed || 0) + (hidden.muted || 0);
    $('inbox-count').textContent = urgent.length ? String(urgent.length) : '';
    const hiddenBtn = $('inbox-hidden');
    hiddenBtn.hidden = !nHidden;
    hiddenBtn.textContent = nHidden ? `${nHidden} set aside` : '';
    list.innerHTML = urgent.length || drift.length ? rows.join('')
      : `<li class="empty"><strong>All clear.</strong> Nothing is broken and no agent is waiting on you.</li>`;
    if (!urgent.length && drift.length) list.insertAdjacentHTML('afterbegin', `<li class="empty"><strong>All clear.</strong> Nothing is broken and no agent is waiting on you.</li>`);
    wireRows('inbox');
    paintSelection();
  }

  // ---------- Next up ----------
  function renderNext() {
    if (!state.home) return; // not loaded yet: an empty list here would claim there are no goals
    const rows = state.home.next_up || [];
    const list = $('next-list');
    entries.next = rows.map((r) => ({ key: `${r.project}:${r.goal}`, data: r, kind: 'next' }));
    list.innerHTML = rows.length ? rows.map((r) => `<li class="row" role="option" data-key="${esc(r.project)}">
        <span class="lead"></span>
        <span class="name">${pv(r.project, r.project)}</span>
        <span class="goal">${px(r.goal)}</span>
        <span class="end"><span>${r.done}/${r.total}</span></span>
      </li>`).join('')
      : `<li class="empty">No open goals in GOALS.md files. Add one and it shows up here.</li>`;
    wireRows('next');
    paintSelection();
  }

  // ---------- Projects ----------
  const QUIET_STATUS = new Set(['parked', 'dormant', 'archived']);
  function liveProjects() {
    const set = new Set();
    for (const a of ((state.agents && state.agents.agents) || [])) if (a.project && a.kind !== 'headless') set.add(a.project);
    return set;
  }
  function daysSince(iso) { return iso ? (Date.now() - new Date(iso).getTime()) / 86400000 : Infinity; }
  function nextStep(p) {
    const r = (p.reasons || []).find((x) => !/unpushed|dirty files/.test(x)) || null;
    if (p.verdict === 'red' && r) return r;
    if (p.next) return p.next;
    if (r) return r;
    return p.summary ? p.summary.split(/(?<=\.)\s/)[0] : '';
  }
  function spark(values, w = 60, h = 14) {
    const v = (values || []).slice(-30);
    if (!v.length || !v.some((x) => x)) return `<svg width="${w}" height="${h}" aria-hidden="true"><line class="base" x1="0" x2="${w}" y1="${h - 1}" y2="${h - 1}"/></svg>`;
    const max = Math.max(...v, 1);
    const step = w / Math.max(1, v.length - 1);
    const pts = v.map((x, i) => [i * step, h - 1 - (x / max) * (h - 2)]);
    const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');
    const [lx, ly] = pts[pts.length - 1];
    return `<svg width="${w}" height="${h}" aria-hidden="true"><path d="${d}"/><circle cx="${lx}" cy="${ly}" r="1.6"/></svg>`;
  }
  function projectRow(p, live) {
    const broken = p.verdict === 'red' && daysSince(p.last) < 14;
    const lead = live.has(p.name) ? mark('working') : broken ? mark('broken') : p.verdict === 'red' || p.verdict === 'amber' ? mark('drift') : '';
    return `<li class="row" role="option" data-key="${esc(p.name)}">
      <span class="lead">${lead}</span>
      <span class="name">${pv(p.name, p.name)}</span>
      <span class="step">${px(nextStep(p))}</span>
      <span class="spark">${spark(p.byDay)}</span>
      <span class="num goals">${p.total ? `${p.done}/${p.total}` : ''}</span>
      <span class="num">${p.last ? ago(p.last) : ''}</span>
    </li>`;
  }
  function renderProjects() {
    const all = state.projects;
    if (!all) return;
    const live = liveProjects();
    const parked = all.filter((p) => QUIET_STATUS.has(p.status));
    const rest = all.filter((p) => !QUIET_STATUS.has(p.status));
    const active = rest.filter((p) => live.has(p.name) || daysSince(p.last) < 7 || daysSince(p.touched) < 3)
      .sort((x, y) => (y.last || '').localeCompare(x.last || ''));
    const quiet = rest.filter((p) => !active.includes(p)).sort((x, y) => (y.last || '').localeCompare(x.last || ''));
    $('projects-count').textContent = `${active.length} active`;
    const list = [];
    const out = [];
    for (const p of active) { list.push({ key: p.name, data: p, kind: 'project' }); out.push(projectRow(p, live)); }
    const group = (name, label, members) => {
      if (!members.length) return;
      list.push({ key: `group:${name}`, data: { group: name }, kind: 'group' });
      out.push(`<li class="row group" role="option" data-key="group:${name}"><span class="lead" aria-hidden="true">${showQuiet[name] ? '▾' : '▸'}</span><span class="name">${showQuiet[name] ? 'Hide' : 'Show'} ${members.length} ${label}</span></li>`);
      if (showQuiet[name]) for (const p of members) { list.push({ key: p.name, data: p, kind: 'project' }); out.push(projectRow(p, live)); }
    };
    group('quiet', `quiet project${quiet.length === 1 ? '' : 's'} (nothing in 7 days)`, quiet);
    group('parked', `parked or archived`, parked);
    entries.projects = list;
    $('project-list').innerHTML = out.join('') || `<li class="empty">No projects found under the projects root.</li>`;
    wireRows('projects');
    paintSelection();
  }

  // ---------- Agents ----------
  const AGENT_MARK = { blocked: 'needs', failed: 'broken', working: 'working', idle: 'idle', done: 'done', stopped: 'idle' };
  function renderAgents() {
    const data = state.agents;
    if (!data) return;
    const all = data.agents || [];
    const shown = all.filter((a) => a.kind !== 'headless');
    const headless = all.filter((a) => a.kind === 'headless');
    entries.agents = shown.map((a) => ({ key: a.session_id || a.id, data: a, kind: 'agent' }));
    const c = data.counts || {};
    $('agents-count').textContent = shown.length ? `${c.working || 0} working` : '';
    const rows = shown.map((a) => {
      const kind = a.your_turn ? 'needs' : (AGENT_MARK[a.state] || 'idle');
      const state2 = a.state === 'blocked' ? 'waiting on you' : a.your_turn ? 'your turn' : a.state;
      const where = a.project ? pv(a.project, a.project) : '~/dev';
      const second = a.state === 'blocked' && a.needs
        ? `<div class="line2 ask">${px(quoteAsk(a.needs))}</div>`
        : `<div class="line2">${where}  <span class="mono">${pv(a.name || a.id, a.project)}</span></div>`;
      return `<li class="row" role="option" data-key="${esc(a.session_id || a.id)}">
        <span class="lead">${mark(kind)}</span>
        <span class="main"><div class="title">${px(a.title || a.name || a.id)}</div>${second}</span>
        <span class="end"><span title="${esc(state2)}">${ago(a.since)}</span></span>
      </li>`;
    });
    if (headless.length) rows.push(`<li class="empty">${headless.length} automated run${headless.length === 1 ? '' : 's'} in progress (claude -p)</li>`);
    $('agent-list').innerHTML = rows.join('') || `<li class="empty">No Claude sessions are running.</li>`;
    wireRows('agents');
    paintSelection();
    renderProjects(); // live-agent marks on project rows
  }

  // ---------- side blocks ----------
  function renderSchedule() {
    if (!state.schedule) { renderReadoutSub(); return; }
    const jobs = state.schedule.jobs || [];
    $('tonight-list').innerHTML = jobs.length ? jobs.map((j) => `<li>
        <span class="when">${j.next_run ? clock(j.next_run) : '—'}</span>
        <span class="what">${j.project ? pv(j.name, j.project) : esc(j.name)}${j.last_exit ? ` ${mark('broken')}` : ''}</span>
        <span class="who" title="${esc(j.schedule)}">${j.next_run ? dayWord(j.next_run).trim() || 'today' : ''}</span>
      </li>`).join('') : `<li class="empty">No scheduled jobs found in ~/Library/LaunchAgents.</li>`;
    renderReadoutSub();
  }

  function renderWeek() {
    const w = state.home && state.home.week;
    const el = $('week');
    if (!w || w.commits == null) {
      el.innerHTML = '<p class="empty">Counting commits across your repos…</p>';
      renderWeek.tries = renderWeek.tries || 0;
      if (state.home && !state.home.week && !renderWeek.retry && renderWeek.tries < 6) {
        renderWeek.tries += 1;
        renderWeek.retry = setTimeout(() => { renderWeek.retry = null; load('home'); }, 8000);
      }
      return;
    }
    const diff = w.commits - w.usual;
    const vs = diff === 0 ? 'the same as a usual week' : `${Math.abs(diff)} ${diff > 0 ? 'more' : 'fewer'} than a usual week`;
    el.innerHTML = `<div class="week-top"><div><div class="week-num">${w.commits} commits</div></div><span class="spark" title="Commits per week, last 13 weeks">${spark(w.weekly, 120, 22)}</span></div>
      <div class="week-vs">${vs} (median ${w.usual})</div>
      <dl class="week-facts"><dt>Projects</dt><dd>${w.projects}</dd><dt>Days with commits</dt><dd>${w.active_days} of 7</dd><dt>Streak</dt><dd>${w.streak} day${w.streak === 1 ? '' : 's'}</dd></dl>`;
  }

  function renderNight() {
    if (!state.home) return;
    const n = state.home.last_night;
    const el = $('last-night');
    if (!n) { el.innerHTML = '<p class="empty">No steward digest yet.</p>'; return; }
    const d = new Date(`${n.date}T12:00:00`);
    el.innerHTML = `<div class="night-date">${d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })}</div>
      <p class="night-line">${px(n.headline || 'The steward ran and changed nothing.')}</p>
      <a class="link-btn" href="${esc(n.url)}">${n.needs ? `Read the digest (${n.needs} note${n.needs === 1 ? '' : 's'} for you)` : 'Read the digest'}</a>`;
  }

  function render(name) {
    if (name === 'inbox') { renderInbox(); renderReadout(); }
    else if (name === 'agents') { renderAgents(); renderReadout(); }
    else if (name === 'schedule') renderSchedule();
    else if (name === 'home') { renderNext(); renderWeek(); renderNight(); }
  }

  // ---------- actions ----------
  async function runAction(act, item) {
    if (!act) return;
    if (act.type === 'link') { if (/^\/(?!\/)/.test(act.url || '')) window.location.href = act.url; return; } // same-origin paths only
    if (act.type === 'preview') { preview(); return; }
    if (act.type === 'copy') { await navigator.clipboard.writeText(act.text); S.toast('Copied'); return; }
    if (act.type === 'post') {
      try {
        await S.postJSON(act.url, act.body || {});
        S.toast(`${act.label}: done${item && item.project ? ` for ${window.Privacy ? window.Privacy.label(item.project) : item.project}` : ''}`);
        setTimeout(() => { load('inbox'); load('agents'); }, 800);
      } catch (e) { S.toast(`${act.label} failed: ${e.message}`, { kind: 'broken' }); }
    }
  }

  function primary() {
    const e = current();
    if (!e) return;
    if (e.kind === 'inbox') return runAction((e.data.actions || [])[0], e.data);
    if (e.kind === 'next' || e.kind === 'project') { window.location.href = `/project/${encodeURIComponent(e.data.project || e.data.name)}`; return; }
    if (e.kind === 'group') { showQuiet[e.data.group] = !showQuiet[e.data.group]; renderProjects(); return; }
    if (e.kind === 'drift-group') { showDrift = !showDrift; renderInbox(); return; }
    if (e.kind === 'agent') {
      if (e.data.can_attach) return runAction({ type: 'post', label: 'Attach', url: `/api/agents/${e.data.id}/attach` });
      return preview();
    }
  }

  async function triage(action, until) {
    const e = current();
    if (!e || e.kind !== 'inbox') return;
    const it = e.data;
    const row = rowsOf('inbox')[indexOf('inbox')];
    try {
      await S.postJSON('/api/inbox/triage', { id: it.id, action, until, fingerprint: it.fingerprint });
      if (row) row.classList.add('leaving');
      const i = indexOf('inbox');
      const after = entries.inbox[i + 1] || entries.inbox[i - 1];
      selKey.inbox = after ? after.key : null;
      const words = { done: 'Marked done', snooze: `Snoozed until ${until ? new Date(until).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : 'later'}`, mute: 'Muted for 30 days' };
      S.toast(words[action], {
        action: 'Undo',
        onAction: async () => { try { await S.postJSON('/api/inbox/triage', { id: it.id, action: 'restore' }); selKey.inbox = it.id; load('inbox'); } catch (err) { S.toast(`Undo failed: ${err.message}`, { kind: 'broken' }); } },
      });
      setTimeout(() => load('inbox'), 180);
    } catch (err) { S.toast(`Could not update: ${err.message}`, { kind: 'broken' }); }
  }

  let snoozeEl = null;
  function closeSnooze() { if (snoozeEl) { snoozeEl.remove(); snoozeEl = null; return true; } return false; }
  function snoozeMenu() {
    const e = current();
    if (!e || e.kind !== 'inbox') return;
    closeSnooze();
    const at = (h, m, addDays) => { const d = new Date(); d.setDate(d.getDate() + addDays); d.setHours(h, m, 0, 0); return d; };
    const now = new Date();
    const evening = now.getHours() < 18 ? at(18, 0, 0) : at(9, 0, 1);
    const monday = (() => { const d = at(9, 0, 0); d.setDate(d.getDate() + (((8 - d.getDay()) % 7) || 7)); return d; })();
    const opts = [
      ['1', 'In an hour', new Date(Date.now() + 3600e3)],
      ['2', now.getHours() < 18 ? 'This evening' : 'Tomorrow morning', evening],
      ['3', 'Tomorrow at 9', at(9, 0, 1)],
      ['4', 'Next Monday', monday],
    ];
    snoozeEl = document.createElement('div');
    snoozeEl.className = 'snooze';
    snoozeEl.setAttribute('role', 'menu');
    snoozeEl.innerHTML = opts.map(([k, label, d]) => `<button type="button" role="menuitem" data-k="${k}"><kbd>${k}</kbd><span>${label}</span><span class="when">${d.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}</span></button>`).join('');
    document.body.appendChild(snoozeEl);
    const row = rowsOf('inbox')[indexOf('inbox')];
    const r = row.getBoundingClientRect();
    snoozeEl.style.top = `${window.scrollY + r.bottom + 4}px`;
    snoozeEl.style.left = `${window.scrollX + Math.max(16, r.right - 260)}px`;
    snoozeEl.querySelectorAll('button').forEach((b, i) => b.addEventListener('click', () => { closeSnooze(); triage('snooze', opts[i][2].toISOString()); }));
    snoozeEl.pick = (k) => { const o = opts.find((x) => x[0] === k); if (o) { closeSnooze(); triage('snooze', o[2].toISOString()); } };
  }

  // ---------- preview sheet ----------
  const facts = (rows) => `<dl class="facts">${rows.filter(([, v]) => v != null && v !== '').map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;
  const btns = (list) => `<div class="sheet-actions">${list.join('')}</div>`;

  function renderDiff(text) {
    return text.split('\n').map((l) => {
      const cls = l.startsWith('diff --git') ? 'file' : l.startsWith('@@') ? 'hunk' : l.startsWith('+') && !l.startsWith('+++') ? 'add' : l.startsWith('-') && !l.startsWith('---') ? 'del' : '';
      return cls ? `<span class="${cls}">${esc(l)}</span>` : esc(l);
    }).join('\n');
  }
  function cmd(text) {
    return `<div class="cmd"><code class="pv">${esc(text)}</code><button type="button" class="link-btn" data-copy="${esc(text)}">Copy</button></div>`;
  }
  function wireSheet(body) {
    body.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => { await navigator.clipboard.writeText(b.dataset.copy); S.toast('Copied'); }));
    body.querySelectorAll('[data-post]').forEach((b) => b.addEventListener('click', () => runAction({ type: 'post', label: b.dataset.label || b.textContent.trim(), url: b.dataset.post, body: b.dataset.body ? JSON.parse(b.dataset.body) : {} })));
  }

  async function previewAgent(a) {
    const body = S.sheet.open({
      title: px(a.title || a.name || a.id),
      sub: `${a.kind} session${a.project ? ` in ${pv(a.project, a.project)}` : ''}`,
      body: `${a.needs ? `<p class="quote">${px(a.needs)}</p>` : ''}
        ${facts([['State', esc(a.your_turn ? 'finished, waiting for your reply' : a.state)], ['Since', a.since ? `${ago(a.since)} ago` : ''], ['Started', a.started ? new Date(a.started).toLocaleString() : ''],
          ['Name', `<span class="mono">${pv(a.name || '', a.project)}</span>`], ['Folder', `<span class="mono">${pv(a.cwd || '', a.project)}</span>`], ['Session', `<span class="mono">${esc(a.session_id || '')}</span>`]])}
        ${a.detail ? `<h4>What it did</h4><p>${px(a.detail)}</p>` : ''}
        ${btns([a.can_attach ? `<button type="button" class="btn primary" data-post="/api/agents/${esc(a.id)}/attach" data-label="Attach">Attach in Terminal <kbd>↵</kbd></button>` : '',
          a.session_id && !a.can_attach ? cmd(`claude --resume ${a.session_id}`) : ''])}
        ${a.can_attach ? '<h4>Recent output</h4><pre class="logtail pv-block" id="agent-log">Loading…</pre>' : ''}`,
    });
    wireSheet(body);
    if (a.can_attach) {
      try {
        const d = await S.getJSON(`/api/agents/${encodeURIComponent(a.id)}/logs`);
        const pre = body.querySelector('#agent-log');
        if (pre) pre.textContent = (d.lines || []).join('\n') || 'No output yet.';
      } catch (e) { const pre = body.querySelector('#agent-log'); if (pre) pre.textContent = `Could not read the log: ${e.message}`; }
    }
  }

  async function previewInbox(it) {
    if (it.kind === 'agent' && it.data && it.data.agent) return previewAgent(it.data.agent);
    const base = `${it.detail ? `<p>${px(it.detail)}</p>` : ''}${facts([['Project', it.project ? pv(it.project, it.project) : ''], ['Since', it.since ? `${ago(it.since)} ago` : ''], ['Detail', it.meta ? esc(it.meta) : '']])}`;
    const actions = (it.actions || []).filter((x) => x.type !== 'preview').map((x) =>
      x.type === 'link' ? `<a class="btn" href="${esc(x.url)}">${esc(x.label)}</a>`
        : x.type === 'post' ? `<button type="button" class="btn" data-post="${esc(x.url)}" data-label="${esc(x.label)}" data-body='${esc(JSON.stringify(x.body || {}))}'>${esc(x.label)}</button>`
          : '');
    const body = S.sheet.open({ title: px(it.title), sub: it.project ? pv(it.project, it.project) : '', body: `${base}${btns(actions)}<div id="sheet-more"></div>` });
    wireSheet(body);
    if (!['review', 'routine-branches', 'job'].includes(it.kind)) return;
    const more = body.querySelector('#sheet-more');
    more.innerHTML = '<p>Loading…</p>';
    try {
      const d = await S.getJSON(`/api/inbox/preview?id=${encodeURIComponent(it.id)}`);
      if (d.log_tail) { more.innerHTML = `<h4>Log tail</h4><pre class="logtail pv-block">${esc(d.log_tail.join('\n'))}</pre>`; return; }
      const groups = (it.data && it.data.groups) || [];
      const repeat = new Set(groups.filter((g) => g.length > 1).flat());
      const branches = d.branches || [];
      const newest = branches[branches.length - 1];
      more.innerHTML = `
        <h4>${branches.length} branch${branches.length === 1 ? '' : 'es'}</h4>
        <table class="branch-table"><tbody>${branches.slice().reverse().map((b) => `<tr>
          <td class="mono">${esc(b.branch)}</td>
          <td>${px(b.goal)}${repeat.has(b.branch) ? ' <span class="repeat">repeats a goal</span>' : ''}</td>
          <td class="stat">+${b.adds} −${b.dels}</td></tr>`).join('')}</tbody></table>
        ${repeat.size ? '<p>Branches marked as repeats chase the same goal. Keep the best one and delete the rest; the steward re-attempts a goal until its checkbox is ticked on the base branch.</p>' : ''}
        ${newest ? `<h4>Newest: <span class="mono">${esc(newest.branch)}</span></h4>
          <ul class="file-list pv-block">${(newest.file_list || []).map((f) => `<li><span class="n">+${esc(f.adds)} −${esc(f.dels)}</span><span>${esc(f.path)}</span></li>`).join('')}</ul>
          <h4>Land it from a terminal</h4>${cmd(d.commands.merge)}${cmd(d.commands.delete)}
          <h4>Diff against ${esc(newest.base)}${d.diff_truncated ? ' (first 200 KB)' : ''}</h4><pre class="diff pv-block">${renderDiff(d.diff || '')}</pre>` : ''}`;
      wireSheet(more);
    } catch (e) { more.innerHTML = `<p>Could not load the details: ${esc(e.message)}</p>`; }
  }

  function previewProject(p) {
    const body = S.sheet.open({
      title: pv(p.name, p.name),
      sub: [p.status, p.kind, p.framework].filter(Boolean).map(esc).join(', '),
      body: `${p.summary ? `<p>${px(p.summary)}</p>` : ''}
        ${facts([['Next goal', p.next ? px(p.next) : ''], ['Goals', p.total ? `${p.done} of ${p.total} done` : ''], ['Last commit', p.last ? `${ago(p.last)} ago` : 'none'],
          ['Branch', p.branch ? `<span class="mono">${esc(p.branch)}</span>` : ''], ['Unpushed', p.ahead ? String(p.ahead) : ''], ['Uncommitted', p.dirty ? `${p.dirty} files` : ''],
          ['Signals', (p.reasons || []).length ? p.reasons.map(px).join('<br>') : ''], ['Service', p.port ? `port ${p.port}, ${p.up ? 'up' : 'down'}` : '']])}
        ${btns([`<a class="btn primary" href="/project/${encodeURIComponent(p.name)}">Open project <kbd>↵</kbd></a>`,
          `<button type="button" class="btn" data-post="/api/open_terminal" data-label="Open in Terminal" data-body='${esc(JSON.stringify({ project: p.name }))}'>Terminal</button>`,
          `<button type="button" class="btn" data-post="/api/open_terminal" data-label="Start Claude" data-body='${esc(JSON.stringify({ project: p.name, claude: true }))}'>Start Claude here</button>`])}`,
    });
    wireSheet(body);
  }

  function preview() {
    const e = current();
    if (!e) return;
    if (e.kind === 'inbox') return previewInbox(e.data);
    if (e.kind === 'agent') return previewAgent(e.data);
    if (e.kind === 'project') return previewProject(e.data);
    if (e.kind === 'next') {
      const p = (state.projects || []).find((x) => x.name === e.data.project);
      if (p) return previewProject(p);
    }
  }

  // ---------- keyboard ----------
  const HINTS = {
    inbox: [['j k', 'move'], ['↵', 'act'], ['space', 'preview'], ['e', 'done'], ['h', 'snooze'], ['m', 'mute'], ['o', 'project']],
    next: [['j k', 'move'], ['↵', 'open project'], ['space', 'preview']],
    projects: [['j k', 'move'], ['↵', 'open'], ['space', 'preview'], ['c', 'start Claude']],
    agents: [['j k', 'move'], ['↵', 'attach'], ['space', 'preview and output']],
  };
  function renderKeybar() {
    const kb = (list) => list.map(([k, v]) => `<span>${k.split(' ').map((x) => `<kbd>${esc(x)}</kbd>`).join('')} ${esc(v)}</span>`).join('');
    $('keybar').innerHTML = `${kb(HINTS[region] || [])}<span class="spacer"></span>${kb([['1–4', 'region'], ['⌘K', 'search'], ['?', 'all keys']])}`;
  }
  S.keys.register('Home', [
    ['1 2 3 4', 'Needs you, Next up, Projects, Agents'], ['j k', 'Move down or up'], ['↵', 'Primary action'],
    ['space', 'Preview in a side sheet'], ['e', 'Done (comes back if it changes)'], ['h', 'Snooze'], ['m', 'Mute for 30 days'],
    ['o', "Open the item's project"], ['c', 'Start Claude in the project'],
  ]);

  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || S.isTyping(e) || S.overlayOpen() || e.metaKey || e.ctrlKey || e.altKey) return;
    if ((e.key === ' ' || e.key === 'Enter') && e.target.closest && e.target.closest('a, button, summary, [role="menuitem"]')) return;
    if (snoozeEl) {
      if (e.key === 'Escape') { closeSnooze(); e.preventDefault(); return; }
      if (/^[1-4]$/.test(e.key)) { snoozeEl.pick(e.key); e.preventDefault(); return; }
      closeSnooze();
    }
    const k = e.key;
    if (/^[1-4]$/.test(k)) { e.preventDefault(); const r = REGIONS[+k - 1]; if (entries[r].length) select(r, indexOf(r)); else document.getElementById(SECTION[r]).scrollIntoView({ block: 'nearest' }); return; }
    if (k === 'j' || k === 'ArrowDown') { e.preventDefault(); move(1); return; }
    if (k === 'k' || k === 'ArrowUp') { e.preventDefault(); move(-1); return; }
    if (k === 'Enter') { e.preventDefault(); primary(); return; }
    if (k === ' ') { e.preventDefault(); if (S.sheet.isOpen) S.sheet.close(); else preview(); return; }
    const cur = current();
    if (!cur) return;
    if (k === 'e' && cur.kind === 'inbox') { e.preventDefault(); triage('done'); return; }
    if (k === 'h' && cur.kind === 'inbox') { e.preventDefault(); snoozeMenu(); return; }
    if (k === 'm' && cur.kind === 'inbox') { e.preventDefault(); triage('mute'); return; }
    const projectName = cur.data.project || cur.data.name;
    if (k === 'o' && projectName) { e.preventDefault(); window.location.href = `/project/${encodeURIComponent(projectName)}`; return; }
    if (k === 'c' && projectName) { e.preventDefault(); runAction({ type: 'post', label: 'Start Claude', url: '/api/open_terminal', body: { project: projectName, claude: true } }); }
  });
  document.addEventListener('click', (e) => { if (snoozeEl && !snoozeEl.contains(e.target)) closeSnooze(); });
  // the snooze menu sits above the sheet, so Escape closes it first (capture
  // runs before the shell's own Escape handling)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && snoozeEl) { closeSnooze(); e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);
  $('inbox-hidden').addEventListener('click', () => S.toast('Set-aside items come back when they change or when their snooze ends.'));

  for (const r of REGIONS) {
    const list = $(LIST[r]);
    list.tabIndex = 0;
    list.addEventListener('focus', () => { if (entries[r].length) select(r, indexOf(r), false); });
  }

  // ---------- boot ----------
  for (const name of ['inbox', 'agents', 'schedule', 'home', 'projects']) {
    const c = cached(name);
    if (c) { state[name] = c; }
  }
  renderInbox(); renderAgents(); renderSchedule(); renderNext(); renderWeek(); renderNight(); renderProjects(); renderReadout();
  renderKeybar();

  load('inbox'); load('agents'); load('schedule'); load('home');
  connectProjects();
  const every = (ms, fn) => setInterval(() => { if (!document.hidden) fn(); }, ms);
  every(4000, () => load('agents'));
  every(15000, () => load('inbox'));
  every(60000, () => { load('schedule'); load('home'); });
  every(10000, renderReadoutSub);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { load('inbox'); load('agents'); } });
  window.addEventListener('privacy', () => { renderInbox(); renderAgents(); renderNext(); renderProjects(); renderNight(); });
})();
