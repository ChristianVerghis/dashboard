// Insights: the commit rhythm, activity feed, live log and services row that
// used to make up the index. The cockpit itself (needs-you queue, agents,
// projects) moved to the home page; the theme, palette and keys to shell.js.
// overview.js renders the week band, rhythm and heatmap side panels from the
// globals below (projects, cache, escapeHtml, projectColor).

const el = {
  feed: document.getElementById('feed'),
  feedCount: document.getElementById('activity-count'),
  terminal: document.getElementById('terminal'),
  lastUpdate: document.getElementById('last-update'),  // may be absent in new layout
};

let projects = [];

// Instant paint: the last payloads are kept in localStorage so a refresh
// renders the whole page from cache in the first frame, then live data
// replaces it in place (every renderer is idempotent). Nothing here is
// authoritative; it is only what the page last saw.
const cache = {
  get(key) { try { const v = localStorage.getItem('dash:' + key); return v ? JSON.parse(v) : null; } catch { return null; } },
  set(key, value) { try { localStorage.setItem('dash:' + key, JSON.stringify(value)); } catch { /* quota or private mode */ } },
};

function fmtAge(seconds) {
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 2592000) return `${Math.floor(seconds / 86400)}d ago`;
  return `${Math.floor(seconds / 2592000)}mo ago`;
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fmtCount(n) {
  return n.toLocaleString();
}

// Stable color from project name — used for icons + journal. HSL-based so we
// have unlimited distinct hues without recycling.
function projectColor(name) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) | 0;
  const hue = Math.abs(h * 47) % 320 + 20;
  // muted: these tell projects apart, they do not signal anything
  const sat = 30 + (Math.abs(h * 7) % 14);
  const light = 58 + (Math.abs(h * 13) % 12);
  return `hsl(${hue} ${sat}% ${light}%)`;
}

let activityFilter = localStorage.getItem('dashboard-activity-filter') || 'all';
let lastActivity = [];

function renderActivityChips(items) {
  const counts = {};
  for (const it of items) counts[it.project] = (counts[it.project] || 0) + 1;
  const chips = ['all', ...Object.keys(counts).sort()];
  document.getElementById('activity-chips').innerHTML = chips.map(c => {
    const label = c === 'all' ? `all · ${items.length}` : `${Privacy.pv(c, c)} · ${counts[c] || 0}`;
    return `<span class="act-chip ${activityFilter === c ? 'active' : ''}" data-chip="${escapeHtml(c)}">${label}</span>`;
  }).join('');
  document.querySelectorAll('.act-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      activityFilter = chip.dataset.chip;
      localStorage.setItem('dashboard-activity-filter', activityFilter);
      renderActivityChips(lastActivity);
      renderFeed(lastActivity);
    });
  });
}

function renderFeed(items) {
  lastActivity = items;
  el.feed.innerHTML = '';
  const filtered = activityFilter === 'all' ? items : items.filter(it => it.project === activityFilter);
  for (const it of filtered) {
    const li = document.createElement('li');
    li.className = it.kind;
    const link = it.url ? `<a href="${it.url}" target="_blank" rel="noopener">↗</a>` : '';
    li.innerHTML = `
      <span class="proj">${Privacy.pv(it.project, it.project)}</span>
      <span class="title">${Privacy.pv(it.title, it.project)}${link ? ' ' + link : ''}<div class="muted small">${Privacy.pv(it.subtitle || '', it.project)}</div></span>
      <span class="age">${fmtAge(it.age_seconds)}</span>
    `;
    if (it.kind === 'commit') {
      // Pull short sha from subtitle "abcdef0 · author"
      const m = (it.subtitle || '').match(/^([a-f0-9]{6,40})/i);
      if (m) {
        li.classList.add('expandable');
        li.dataset.sha = m[1];
        li.dataset.project = it.project;
        li.addEventListener('click', (ev) => {
          if (ev.target.tagName === 'A') return;
          toggleCommitDetails(li);
        });
      }
    }
    el.feed.appendChild(li);
  }
  el.feedCount.innerHTML = activityFilter === 'all'
    ? `${items.length} items`
    : `${filtered.length}/${items.length} (${Privacy.pv(activityFilter, activityFilter)})`;
  renderActivityChips(items);
}

async function toggleCommitDetails(li) {
  if (li.querySelector('.commit-details')) {
    li.querySelector('.commit-details').remove();
    return;
  }
  const project = li.dataset.project;
  const sha = li.dataset.sha;
  const det = document.createElement('div');
  det.className = 'commit-details';
  det.innerHTML = `<pre class="muted small">loading…</pre>`;
  li.appendChild(det);
  try {
    const r = await fetch(`/api/projects/${encodeURIComponent(project)}/commit/${encodeURIComponent(sha)}`);
    const data = await r.json();
    if (data.body) {
      det.innerHTML = `<pre class="commit-body">${Privacy.pv(data.body, project)}</pre>`;
    } else {
      det.innerHTML = `<pre class="muted small">no details</pre>`;
    }
  } catch (e) {
    det.innerHTML = `<pre class="muted small">error: ${escapeHtml(e.message)}</pre>`;
  }
}

function flash(node) {
  node.classList.remove('flash');
  // force reflow
  void node.offsetWidth;
  node.classList.add('flash');
}

function cssEscape(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, c => '\\' + c);
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function setLastUpdate(label) {
  if (el.lastUpdate) el.lastUpdate.textContent = label;
}

let lastFeedIds = new Set();

function toast({ title, body, kind = '', proj }) {
  const root = document.getElementById('toasts');
  if (!root) return;
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  // proj: the project the toast is about, so a public project's toast stays readable in private mode
  el.innerHTML = `<div class="t-title">${Privacy.pv(title, proj)}</div>${body ? `<div class="t-body">${Privacy.pv(body, proj)}</div>` : ''}`;
  root.appendChild(el);
  setTimeout(() => el.remove(), 5000);

  // Forward to macOS notification center if user has opted in.
  if (localStorage.getItem('dashboard-notify') === 'on' && document.hidden) {
    fetch('/api/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, body }),
    }).catch(() => {});
  }
}

// macOS notification toggle
const notifyBtn = document.getElementById('notify-toggle');
function refreshNotifyBtn() {
  const on = localStorage.getItem('dashboard-notify') === 'on';
  if (notifyBtn) notifyBtn.textContent = on ? '🔔' : '🔕';
  if (notifyBtn) notifyBtn.title = on ? 'macOS notifications on (click to disable)' : 'macOS notifications off (click to enable)';
}
if (notifyBtn) {
  refreshNotifyBtn();
  notifyBtn.addEventListener('click', () => {
    const on = localStorage.getItem('dashboard-notify') === 'on';
    localStorage.setItem('dashboard-notify', on ? 'off' : 'on');
    refreshNotifyBtn();
    if (!on) {
      // Fire a confirmation notification
      fetch('/api/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Dashboard', body: 'Notifications enabled', sound: false }),
      });
    }
  });
}

function detectNewFeedItems(activity) {
  const fresh = [];
  const newIds = new Set();
  for (const it of activity) {
    const id = `${it.kind}:${it.project}:${it.iso}:${it.title}`;
    newIds.add(id);
    if (lastFeedIds.size > 0 && !lastFeedIds.has(id)) fresh.push(it);
  }
  lastFeedIds = newIds;
  return fresh;
}

let _projectsES = null;
function connectProjectStream() {
  if (_projectsES) try { _projectsES.close(); } catch {}
  const es = new EventSource('/api/stream/projects');
  _projectsES = es;
  let backoff = 2000;
  es.onopen = () => { setLastUpdate('connected'); backoff = 2000; };
  es.onerror = () => {
    setLastUpdate('reconnecting…');
    es.close();
    setTimeout(connectProjectStream, backoff);
    backoff = Math.min(backoff * 2, 30000);
  };
  es.onmessage = (ev) => {
    try {
      const data = JSON.parse(ev.data);
      if (data.type === 'snapshot' || data.type === 'delta') {
        if (!data.stale) cache.set('snapshot', { projects: data.projects, activity: data.activity });
        projects = data.projects;
        renderFeed(data.activity);
        if (typeof renderOverview === 'function') renderOverview();
        document.dispatchEvent(new CustomEvent('projects:loaded'));
        setLastUpdate(data.type === 'snapshot' ? (data.stale ? 'refreshing…' : 'live') : `live · changed ${new Date().toLocaleTimeString()}`);
        if (data.type === 'delta') {
          const fresh = detectNewFeedItems(data.activity);
          for (const f of fresh.slice(0, 3)) {
            toast({
              title: `${f.project}: ${f.title.slice(0, 80)}`,
              body: f.subtitle || '',
              kind: f.kind === 'commit' ? 'commit' : (f.kind === 'file' ? 'file' : ''),
              proj: f.project,
            });
          }
        } else if (data.type === 'snapshot') {
          // Initialize the seen-set without firing toasts
          detectNewFeedItems(data.activity);
        }
      }
    } catch (e) { console.error(e); }
  };
}

let _logES = null;
function connectLogStream() {
  if (_logES) try { _logES.close(); } catch {}
  const es = new EventSource('/api/stream/log');
  _logES = es;
  let backoff = 2000;
  es.onerror = () => {
    es.close();
    setTimeout(connectLogStream, backoff);
    backoff = Math.min(backoff * 2, 30000);
  };
  es.onopen = () => { backoff = 2000; };
  es.onmessage = (ev) => {
    try {
      const data = JSON.parse(ev.data);
      if (data.type === 'line') {
        // #terminal is a pv-block (index.html): every line lands blurred in private mode
        const ts = new Date().toLocaleTimeString();
        el.terminal.textContent += `[${ts}] ${data.text}\n`;
        el.terminal.scrollTop = el.terminal.scrollHeight;
      } else if (data.type === 'hello') {
        el.terminal.textContent += `[ready] tailing ${data.path}\n`;
      }
    } catch (e) { /* ignore */ }
  };
}

async function loadRecentRuns() {
  try {
    const r = await fetch('/api/recent_runs');
    const data = await r.json();
    const target = document.getElementById('recent-runs');
    if (!target) return;
    if (!data.runs.length) {
      target.innerHTML = '<p class="muted small" style="padding:14px">No actions run yet. Click any action button on a project page.</p>';
      return;
    }
    target.innerHTML = data.runs.slice(0, 30).map(r => {
      const dur = r.duration_seconds < 1 ? `${(r.duration_seconds*1000)|0}ms` : `${r.duration_seconds.toFixed(1)}s`;
      return `<div class="run-row">
        <span class="r-proj">${Privacy.pv(r.project, r.project)}</span>
        <span class="r-action">${escapeHtml(r.action)}</span>
        <span class="r-duration">${dur}</span>
        <span class="r-status ${r.ok ? 'ok' : 'err'}">${r.ok ? '✓' : '✗ ' + r.exit_code}</span>
      </div>`;
    }).join('');
  } catch (e) { /* ignore */ }
}

// Tab switch for live log / recent runs
document.querySelectorAll('.log-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.log-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const which = tab.dataset.tab;
    document.getElementById('terminal').hidden = which !== 'log';
    document.getElementById('recent-runs').hidden = which !== 'runs';
    if (which === 'runs') loadRecentRuns();
  });
});
setInterval(() => {
  if (!document.getElementById('recent-runs').hidden) loadRecentRuns();
}, 3000);

async function loadRunning() {
  try {
    const r = await fetch('/api/running');
    if (!r.ok) return;
    const data = await r.json();
    const ind = document.getElementById('running-indicator');
    if (!ind) return;
    if (!data.running || !data.running.length) {
      ind.hidden = true;
      return;
    }
    ind.hidden = false;
    const r0 = data.running[0];
    const more = data.running.length > 1 ? ` +${data.running.length - 1}` : '';
    ind.innerHTML = `${Privacy.pv(r0.project, r0.project)} · ${escapeHtml(r0.action)}${escapeHtml(more)}`;
  } catch { /* swallow network errors during server restarts */ }
}
setInterval(loadRunning, 1500);
loadRunning();

function applyHeatmap(data) {
  if (!data.days || !data.days.length) {
    document.getElementById('heatmap-panel').hidden = true;
    return;
  }
  if (typeof overviewSetHeatmap === 'function') overviewSetHeatmap(data);
  document.getElementById('heatmap-panel').hidden = false;
  const wk = data.days.slice(-7).reduce((a, d) => a + d.count, 0);
  document.getElementById('heatmap-summary').textContent = `${data.total} commits · ${wk} this week · busiest day ${data.max}`;
  renderHeatmap(data);
}

async function loadHeatmap() {
  try {
    const r = await fetch('/api/heatmap?weeks=52');
    if (!r.ok) return;
    const data = await r.json();
    cache.set('heatmap', data);
    applyHeatmap(data);
  } catch { /* network errors silenced */ }
}


// Companion to the heatmap: when commits happen, weekday x hour, last 90 days.
function renderWeekdayBars(data) {
  const host = document.getElementById('heatmap-side');
  if (!host || !data.punch) return;
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const order = [1, 2, 3, 4, 5, 6, 0];
  const cellW = 13, cellH = 15, left = 30, top = 14;
  const w = left + 24 * cellW, h = top + 7 * cellH + 14;
  const max = Math.max(1, ...data.punch.flat());
  let out = '';
  order.forEach((wd, r) => {
    out += `<text class="hm-day" x="0" y="${top + r * cellH + cellH / 2 + 3}">${names[wd]}</text>`;
    data.punch[wd].forEach((n, hour) => {
      if (!n) return;
      const rad = 1.6 + 4.4 * Math.sqrt(n / max);
      out += `<circle class="pc" cx="${left + hour * cellW + cellW / 2}" cy="${top + r * cellH + cellH / 2}" r="${rad.toFixed(1)}" fill-opacity="${(0.45 + 0.55 * n / max).toFixed(2)}"><title>${names[wd]} ${String(hour).padStart(2, '0')}:00 · ${n} commit${n === 1 ? '' : 's'}</title></circle>`;
    });
  });
  [0, 6, 12, 18].forEach(hh => {
    out += `<text class="hm-day" x="${left + hh * cellW + cellW / 2}" y="${h - 2}" text-anchor="middle">${hh}h</text>`;
  });
  const rows = data.punch.map(r => r.reduce((a, b) => a + b, 0));
  const best = rows.indexOf(Math.max(...rows));
  const hours = Array.from({ length: 24 }, (_, hh) => data.punch.reduce((a, r) => a + r[hh], 0));
  const peak = hours.indexOf(Math.max(...hours));
  host.innerHTML = `<div class="hs-title">When I commit · last 90 days</div>
    <svg class="punch" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${out}</svg>
    <div class="hs-note">Most on ${names[best]}s, peak hour ${peak}:00</div>`;
}

function renderHeatmap(data) {
  const svg = document.getElementById('heatmap');
  const cell = 14, gap = 3, leftPad = 30, topPad = 18;
  const pitch = cell + gap;
  const weeks = data.weeks;
  const w = leftPad + weeks * pitch;
  const h = topPad + 7 * pitch;
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('width', w);
  svg.setAttribute('height', h);

  // Quantile buckets over non-zero days so one outlier does not flatten the rest.
  const nz = data.days.map(d => d.count).filter(c => c > 0).sort((a, b) => a - b);
  const q = (f) => nz.length ? nz[Math.min(nz.length - 1, Math.floor(f * nz.length))] : 1;
  const cuts = [q(0.25), q(0.5), q(0.75)];
  const levelFor = (n) => n === 0 ? 0 : n <= cuts[0] ? 1 : n <= cuts[1] ? 2 : n <= cuts[2] ? 3 : 4;

  const todayIso = data.days[data.days.length - 1]?.date;
  let lastMonth = -1;
  const months = [];
  const cells = data.days.map((d, idx) => {
    const col = Math.floor(idx / 7);
    const row = d.weekday;
    const x = leftPad + col * pitch;
    const y = topPad + row * pitch;
    const m = new Date(d.date + 'T00:00:00').getMonth();
    if (m !== lastMonth && row === 0 && idx > 0 && col < weeks - 1) {
      months.push(`<text class="hm-month" x="${x}" y="${topPad - 7}">${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m]}</text>`);
    }
    if (row === 0) lastMonth = m;
    const link = d.count > 0 ? `data-link="/journal?date=${d.date}"` : '';
    const cls = `heatmap-cell hm-${levelFor(d.count)} ${d.count > 0 ? 'clickable' : ''} ${d.date === todayIso ? 'today' : ''}`;
    return `<rect class="${cls}" ${link}
      data-date="${d.date}" data-count="${d.count}" data-by="${escapeHtml(JSON.stringify(d.by_project))}"
      x="${x}" y="${y}" width="${cell}" height="${cell}" rx="2.5"></rect>`;
  }).join('');

  const dayLabels = ['', 'Mon', '', 'Wed', '', 'Fri', ''];
  const labels = dayLabels.map((label, row) => label
    ? `<text class="hm-day" x="0" y="${topPad + row * pitch + cell - 2}">${label}</text>` : '').join('');

  svg.innerHTML = months.join('') + labels + cells;
  renderWeekdayBars(data);

  const tooltip = document.getElementById('heatmap-tooltip');
  svg.querySelectorAll('.heatmap-cell').forEach(rect => {
    if (rect.dataset.link) {
      rect.style.cursor = 'pointer';
      rect.addEventListener('click', () => { window.location = rect.dataset.link; });
    }
    rect.addEventListener('mouseenter', () => {
      const count = parseInt(rect.dataset.count, 10);
      let by = {};
      try { by = JSON.parse(rect.dataset.by); } catch {}
      const rows = Object.entries(by).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<div class="ht-row"><span>${Privacy.pv(k, k)}</span><span>${v}</span></div>`).join('');
      const date = new Date(rect.dataset.date + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
      tooltip.innerHTML = `<div class="ht-date">${date}</div><div class="ht-row"><span>${count === 1 ? 'commit' : 'commits'}</span><span><b>${count}</b></span></div>${rows}`;
      tooltip.hidden = false;
      const panelRect = document.getElementById('heatmap-panel').getBoundingClientRect();
      const cellRect = rect.getBoundingClientRect();
      tooltip.style.left = Math.min(cellRect.left - panelRect.left + 16, panelRect.width - 250) + 'px';
      tooltip.style.top = (cellRect.top - panelRect.top - 8) + 'px';
    });
    rect.addEventListener('mouseleave', () => { tooltip.hidden = true; });
  });
}

{
  const snap = cache.get('snapshot');
  if (snap && Array.isArray(snap.projects)) {
    projects = snap.projects;
    renderFeed(snap.activity || []);
    detectNewFeedItems(snap.activity || []);
    setLastUpdate('cached · connecting…');
  }
  const hm = cache.get('heatmap');
  if (hm) applyHeatmap(hm);
  else {
    // First visit: hold the band's space so tiles do not jump when it lands.
    const band = document.getElementById('week-band');
    if (band) { band.hidden = false; band.classList.add('skeleton'); }
  }
  if (typeof renderOverview === 'function') renderOverview();
}
connectProjectStream();
// Private-mode toggle (or the public list arriving): re-render what gates on Privacy.on at render time
// (tile / allocation tooltips); the blur itself is pure CSS and needs no re-render.
window.addEventListener('privacy', () => { if (typeof renderOverview === 'function') renderOverview(); });
// Defer the second SSE stream and the aggregate endpoints slightly past
// first paint: Chrome caps HTTP/1.1 at 6 connections per host and the two
// persistent streams used to starve the tile fetches on cold load. The
// aggregate is pre-warmed server-side and the page already painted from the
// browser cache, so this only needs to clear the first frame.
setTimeout(() => {
  connectLogStream();
  loadHeatmap();
}, 1200);
setInterval(loadHeatmap, 300000);

// ---- Services health row (manifest-declared ports) ----
async function loadServices() {
  try {
    const r = await fetch('/api/services');
    if (!r.ok) return;
    const data = await r.json();
    cache.set('services', data);
    applyServices(data);
  } catch { /* network errors silenced */ }
}

function applyServices(data) {
  {
    if (typeof overviewSetServices === 'function') overviewSetServices(data);
    const row = document.getElementById('services-row');
    if (!row) return;
    if (!data.services || !data.services.length) { row.hidden = true; return; }
    row.hidden = false;
    // parked services (dormant, incubating) are listed after the live ones with a quiet dot: being off is expected
    const parked = s => (s.status || 'active') !== 'active';
    const ordered = [...data.services].sort((a, b) => parked(a) - parked(b));
    row.innerHTML = ordered.map(s => {
      const dot = s.up ? 'up' : parked(s) ? 'parked' : 'down';
      const primary = (s.links || []).find(l => l.primary) || (s.links || [])[0];
      const openBtn = s.up && primary
        ? `<a class="svc-open" href="${primary.href}" target="_blank" rel="noopener">open ↗</a>`
        : '';
      const startBtn = !s.up && s.can_start
        ? `<button class="svc-start" data-svc="${escapeHtml(s.name)}">start</button>`
        : '';
      return `<div class="svc ${dot}" title="${escapeHtml(s.status || 'active')}">
        <span class="svc-dot ${dot}"></span>
        <a class="svc-name" href="/project/${encodeURIComponent(s.name)}">${Privacy.pv(s.name, s.name)}</a>
        <span class="svc-port muted">:${s.port}</span>
        ${openBtn}${startBtn}
      </div>`;
    }).join('');
    row.querySelectorAll('.svc-start').forEach(btn => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.textContent = 'starting…';
        try {
          await fetch(`/api/services/${encodeURIComponent(btn.dataset.svc)}/start`, { method: 'POST' });
          // Give the process a moment to bind before re-checking.
          setTimeout(loadServices, 2500);
        } catch { /* network errors silenced */ }
      });
    });
  }
}
{
  const cachedSvc = cache.get('services');
  if (cachedSvc) applyServices(cachedSvc);
}
loadServices();
setInterval(loadServices, 15000);

// ---- Data freshness: is what this page shows still current? (/api/freshness)
// A line under the header says so at a glance; the panel at the bottom lists
// every source with its age and how to bring it back.
const FRESH_MARK = { fail: 'broken', warn: 'needs', unknown: 'drift' };
async function loadFreshness() {
  let d;
  try { d = await (await fetch('/api/freshness')).json(); } catch { return; }
  const rank = { fail: 0, warn: 1, unknown: 2, info: 3, ok: 4 };
  const checks = [...d.checks].sort((a, b) => rank[a.state] - rank[b.state]);
  const bad = checks.filter(c => c.state === 'fail' || c.state === 'warn');
  const strip = document.getElementById('fresh-strip');
  if (strip) {
    strip.hidden = false;
    const total = checks.filter(c => c.state !== 'info').length;
    strip.innerHTML = bad.length
      ? `${Shell.mark(bad.some(c => c.state === 'fail') ? 'broken' : 'needs')}<span>${bad.length} of ${total} data sources need attention: ${bad.map(c => Privacy.px(c.label)).join(', ')}.</span> <a href="#fresh-panel" class="link-btn">Details</a>`
      : `<span>All ${total} data sources are current.</span> <a href="#fresh-panel" class="link-btn">Details</a>`;
  }
  const table = document.getElementById('fresh-table');
  if (!table) return;
  document.getElementById('fresh-summary').textContent = `checked ${new Date(d.checked_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  const age = h => h == null ? '' : h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : h < 48 ? `${Math.round(h)} h` : `${Math.round(h / 24)} d`;
  // sources that are fine fold into one row; what needs a look stays open
  const quiet = c => c.state === 'ok' || c.state === 'info';
  const nQuiet = checks.filter(quiet).length;
  const open = loadFreshness.open || !bad.length;
  table.innerHTML = checks.map((c, i) => quiet(c) && !open ? '' : `<tr class="fresh-${c.state}">
      <td class="lead">${FRESH_MARK[c.state] ? Shell.mark(FRESH_MARK[c.state]) : ''}</td>
      <td class="name">${c.project ? Privacy.pv(c.label, c.project) : escapeHtml(c.label)}<span class="sub">${Privacy.px(c.detail)}</span></td>
      <td class="num">${age(c.age_h)}</td>
      <td class="act">${c.action && c.state !== 'ok' && c.state !== 'info' ? `<button type="button" class="btn" data-i="${i}">${escapeHtml(c.action.label)}</button>` : ''}</td>
    </tr>`).join('') + (bad.length && nQuiet ? `<tr><td></td><td colspan="3"><button type="button" class="link-btn" id="fresh-toggle">${open ? 'Hide' : 'Show'} the ${nQuiet} sources that are current</button></td></tr>` : '');
  document.getElementById('fresh-toggle')?.addEventListener('click', () => { loadFreshness.open = !open; loadFreshness(); });
  table.querySelectorAll('[data-i]').forEach(b => b.addEventListener('click', async () => {
    const act = checks[+b.dataset.i].action;
    b.disabled = true;
    try { await Shell.postJSON(act.url, act.body || {}); Shell.toast(`${act.label}: started`); setTimeout(loadFreshness, 5000); }
    catch (e) { Shell.toast(`${act.label} failed: ${e.message}`, { kind: 'broken' }); b.disabled = false; }
  }));
}
loadFreshness();
setInterval(() => { if (!document.hidden) loadFreshness(); }, 60000);

