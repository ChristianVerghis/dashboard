// Project capability page

const NAME = decodeURIComponent(window.location.pathname.replace(/^\/project\//, ''));

document.title = `${NAME} · capabilities`;
document.getElementById('proj-name').textContent = NAME;
document.getElementById('hero-name').textContent = NAME;

// Project-specific CTAs. Hardcoded fallbacks for projects without a
// project.yml; manifest links (pr.manifest.links) are merged in by load().
const PROJECT_DASHBOARDS = {
  classroom: [
    { href: '/classroom', label: 'Classroom dashboard →', primary: true },
    { href: '/classroom/live', label: 'Live session →' },
  ],
  reef: [
    { href: 'http://localhost:3737', label: 'Open reef on :3737 →', primary: true },
  ],
};
function renderProjectCTAs(manifestLinks) {
  const fallback = PROJECT_DASHBOARDS[NAME] || [];
  const links = (manifestLinks && manifestLinks.length) ? manifestLinks : fallback;
  if (!links.length) return;
  const hero = document.getElementById('hero');
  if (!hero) return;
  let div = hero.querySelector('.project-ctas');
  const fp = JSON.stringify(links);
  if (div && div.dataset.fp === fp) return;
  if (!div) {
    div = document.createElement('div');
    div.className = 'project-ctas';
    const head = hero.querySelector('.hero-head');
    if (head && head.nextSibling) hero.insertBefore(div, head.nextSibling);
    else hero.appendChild(div);
  }
  div.dataset.fp = fp;
  div.innerHTML = links.map(c =>
    `<a href="${escapeHtml(c.href)}" class="action-btn ${c.primary ? 'primary' : ''}">${escapeHtml(c.label)}</a>`
  ).join('');
}
renderProjectCTAs();

function renderManifestActions(manifest) {
  const panel = document.getElementById('manifest-actions');
  if (!panel) return;
  const actions = manifest && manifest.actions ? Object.keys(manifest.actions) : [];
  if (!actions.length) { panel.hidden = true; return; }
  panel.hidden = false;
  const body = document.getElementById('manifest-actions-body');
  const fp = actions.join(',');
  if (body.dataset.fp === fp) return;
  body.dataset.fp = fp;
  body.innerHTML = actions.map(a =>
    `<button class="action-btn" data-manifest-act="${escapeHtml(a)}" title="${escapeHtml(manifest.actions[a])}">${escapeHtml(a)}</button>`
  ).join('');
  body.querySelectorAll('[data-manifest-act]').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await fetch('/api/exec', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project: NAME, action: btn.dataset.manifestAct }),
        });
      } catch { /* network errors silenced */ }
      finally { btn.disabled = false; }
    });
  });
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function fmtAge(s) {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s/60)}m`;
  if (s < 86400) return `${Math.floor(s/3600)}h`;
  return `${Math.floor(s/86400)}d`;
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024*1024) return `${(n/1024).toFixed(1)} KB`;
  return `${(n/1024/1024).toFixed(1)} MB`;
}

async function load() {
  let pr, caps;
  try {
    const [prResp, capsResp] = await Promise.all([
      fetch(`/api/projects/${encodeURIComponent(NAME)}`),
      fetch(`/api/projects/${encodeURIComponent(NAME)}/capabilities`),
    ]);
    if (prResp.status === 404) {
      document.getElementById('caps-body').innerHTML = `<p class="muted">project not found.</p>`;
      return;
    }
    if (!prResp.ok || !capsResp.ok) return;  // server hiccup; will retry on next poll
    pr = await prResp.json();
    caps = await capsResp.json();
  } catch { return; }

  // Hero
  const m = document.getElementById('hero-momentum');
  m.textContent = pr.momentum;
  m.className = `badge ${pr.momentum}`;
  renderProjectCTAs(pr.manifest && pr.manifest.links);
  renderManifestActions(pr.manifest);
  // Service up/down badge when the manifest declares a port
  if (pr.manifest && pr.manifest.port) {
    let svc = document.getElementById('hero-service');
    if (!svc) {
      svc = document.createElement('span');
      svc.id = 'hero-service';
      m.parentElement.appendChild(svc);
    }
    const up = pr.service_up;
    svc.className = `badge ${up ? 'active' : 'stale'}`;
    svc.textContent = `:${pr.manifest.port} ${up ? 'up' : 'down'}`;
  }
  document.getElementById('hero-summary').textContent = pr.summary || '';
  document.getElementById('proj-meta').textContent = `${pr.commit_count} commits · ${pr.file_count} files · ${fmtBytes(pr.total_size_bytes)}`;
  if (pr.remote_url) {
    const a = document.getElementById('repo-link');
    a.href = pr.remote_url.replace(/\.git$/, '');
    a.textContent = pr.remote_url.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '') + ' ↗';
  }

  // Stats grid
  const stats = document.getElementById('hero-stats');
  const items = [
    { k: 'Commits', v: pr.commit_count },
    { k: 'Files', v: pr.file_count },
    { k: 'Branch', v: pr.branch || '—' },
    { k: 'Last commit', v: pr.last_commit ? fmtAge(pr.last_commit.age_seconds) + ' ago' : '—' },
  ];
  stats.innerHTML = items.map(i => `<div class="metric"><div class="k">${i.k}</div><div class="v">${escapeHtml(String(i.v))}</div></div>`).join('');

  // Insights including goals progress
  const ins = document.getElementById('hero-progress');
  const goalIns = (pr.insights || []).find(x => x.label === 'Goals');
  const nextIns = (pr.insights || []).find(x => x.label === 'Next up');
  let html = '';
  if (goalIns) {
    const m = goalIns.value.match(/(\d+)\/(\d+)\s+done\s*·\s*(\d+)%/);
    if (m) {
      const [_, done, total, pct] = m;
      html += `
        <div class="goal-block">
          <div class="goal-head">
            <span class="goal-label">Progress</span>
            <span class="goal-numbers">${done}/${total} done · ${pct}%</span>
          </div>
          <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
          ${nextIns ? `<div class="next-up muted">Next up — ${escapeHtml(nextIns.value)}</div>` : ''}
        </div>`;
    }
  }
  // Other insight chips
  const others = (pr.insights || []).filter(x => x.label !== 'Goals' && x.label !== 'Next up');
  if (others.length) {
    html += `<div class="insight-grid">` + others.map(i =>
      `<div class="insight"><div class="k">${escapeHtml(i.label)}</div><div class="v">${escapeHtml(i.value)}</div></div>`
    ).join('') + `</div>`;
  }
  ins.innerHTML = html;

  // Capabilities body
  const body = document.getElementById('caps-body');
  if (caps.markdown && window.marked) {
    body.innerHTML = marked.parse(caps.markdown);
  } else if (caps.markdown) {
    body.innerHTML = `<pre>${escapeHtml(caps.markdown)}</pre>`;
  } else {
    body.innerHTML = `<p class="muted">No <code>CAPABILITIES.md</code> yet. Drop one at the project root and refresh.</p>`;
  }
}

// Latest product: live iframe / snapshot / artifact / newest doc, from the
// manifest's showcase: block. Rendered once — iframes reload on re-render.
async function loadHeroShowcase() {
  try {
    const r = await fetch(`/api/projects/${encodeURIComponent(NAME)}/showcase`);
    if (!r.ok) return;
    const { item: it } = await r.json();
    const box = document.getElementById('hero-showcase');
    if (!box) return;
    if (!it) { box.hidden = true; return; }
    const fp = JSON.stringify(it);
    if (box.dataset.fp === fp) return;
    box.dataset.fp = fp;
    box.hidden = false;
    const label = it.kind === 'app' && it.up ? 'live'
      : it.as_of ? `as of ${new Date(it.as_of).toLocaleString()}` : '';
    let body = '';
    if (it.kind === 'app' && it.up) {
      body = `<div class="sc-frame-wrap sc-hero"><iframe class="sc-frame" src="${escapeHtml(it.url)}" loading="lazy" title="live preview"></iframe><a class="sc-overlay" href="${escapeHtml(it.url)}" target="_blank" rel="noopener" aria-label="open app"></a></div>`;
    } else if (it.kind === 'app' && it.snapshot) {
      body = `<div class="sc-frame-wrap sc-hero"><img class="sc-img" src="${escapeHtml(it.snapshot)}" alt="snapshot" /><span class="sc-down-badge">down · snapshot</span></div>`;
    } else if (it.kind === 'app') {
      box.hidden = true; return;
    } else if (it.kind === 'file') {
      body = `<div class="sc-frame-wrap sc-hero"><iframe class="sc-frame" src="${escapeHtml(it.url)}" loading="lazy" sandbox="allow-same-origin" title="artifact"></iframe><a class="sc-overlay" href="${escapeHtml(it.url)}" target="_blank" rel="noopener" aria-label="open artifact"></a></div>`;
    } else {
      body = `<div class="sc-md md" id="hero-showcase-md">loading…</div>`;
    }
    box.innerHTML = `<div class="shelf-card-head"><span class="sc-meta muted small">latest product${it.title ? ' · ' + escapeHtml(it.title) : ''}${label ? ' · ' + escapeHtml(label) : ''}</span><a class="sc-open muted small" href="${escapeHtml(it.url)}" target="_blank" rel="noopener">open ↗</a></div>${body}`;
    if (it.kind === 'markdown-latest') {
      try {
        const t = await (await fetch(it.url)).text();
        const el = document.getElementById('hero-showcase-md');
        if (el) el.innerHTML = window.marked ? marked.parse(t.slice(0, 8000)) : `<pre>${escapeHtml(t.slice(0, 4000))}</pre>`;
      } catch { /* leave the loading text */ }
    }
  } catch { /* network errors silenced */ }
}

// Signals: manifest-declared probes (health, freshness, metrics, checklists)
// executed server-side by /api/projects/{name}/signals.
async function loadSignals() {
  try {
    const r = await fetch(`/api/projects/${encodeURIComponent(NAME)}/signals`);
    if (!r.ok) return;
    const s = await r.json();
    const blocker = document.getElementById('signals-blocker');
    if (blocker) {
      blocker.hidden = !s.blocker;
      if (s.blocker) blocker.innerHTML = `<span class="attn-dot"></span> blocked — ${escapeHtml(s.blocker)}`;
    }
    const row = document.getElementById('signals-row');
    if (!row) return;
    const chips = [];
    if (s.health) {
      const d = s.health.detail ? ' · ' + Object.entries(s.health.detail).map(([k, v]) => `${k}: ${v}`).join(' · ') : '';
      chips.push(`<span class="sig-chip ${s.health.up ? 'sig-green' : 'sig-red'}">health ${s.health.up ? 'ok' : 'down'}${escapeHtml(d)}</span>`);
    }
    for (const m of s.metrics || []) {
      if (m.value == null) continue;
      chips.push(`<span class="sig-chip sig-metric">${escapeHtml(m.label)}: <b>${escapeHtml(String(m.value))}</b>${m.suffix ? ' ' + escapeHtml(m.suffix) : ''}</span>`);
    }
    for (const f of s.freshness || []) {
      const cls = f.state === 'red' ? 'sig-red' : f.state === 'amber' ? 'sig-amber' : 'sig-green';
      const age = f.missing ? 'missing' : (f.age_days != null ? `${Math.round(f.age_days)}d old` : '?');
      chips.push(`<span class="sig-chip ${cls}" title="${escapeHtml(f.path || '')}">${escapeHtml(f.label)}: ${escapeHtml(age)}</span>`);
    }
    for (const c of s.checklists || []) {
      if (c.missing) continue;
      const next = c.next_undone ? ` · next: ${c.next_undone}` : '';
      chips.push(`<span class="sig-chip sig-check" title="${escapeHtml(c.next_undone || '')}">${escapeHtml(c.label)}: ${c.done}/${c.total}${escapeHtml(next.slice(0, 60))}</span>`);
    }
    row.hidden = chips.length === 0;
    row.innerHTML = chips.join('');
  } catch { /* network errors silenced */ }
}

async function loadGoals() {
  try {
    const r = await fetch(`/api/projects/${encodeURIComponent(NAME)}/goals`);
    if (!r.ok) return;
    const data = await r.json();
    const panel = document.getElementById('goals-panel');
    if (!data.items || !data.items.length) { panel.hidden = true; return; }
    panel.hidden = false;
    const done = data.items.filter(i => i.done).length;
    document.getElementById('goals-summary').textContent = `${done}/${data.items.length} done · click to toggle`;
    const sections = data.sections.length ? data.sections : [{ name: 'Goals', items: data.items }];
    document.getElementById('goals-body').innerHTML = sections
      .filter(s => s.items.length)
      .map(s => `
        <div class="goals-section">
          <div class="goals-section-name">${escapeHtml(s.name)}</div>
          <ul class="goals-list">
            ${s.items.map(i => `
              <li class="goal-item ${i.done ? 'done' : ''}" data-line="${i.line}">
                <button class="goal-checkbox" data-line="${i.line}" aria-label="toggle">${i.done ? '✓' : ''}</button>
                <span class="goal-label">${escapeHtml(i.label).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')}</span>
              </li>
            `).join('')}
          </ul>
        </div>`).join('');
    document.querySelectorAll('#goals-body .goal-checkbox').forEach(btn => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          await fetch(`/api/projects/${encodeURIComponent(NAME)}/goals/toggle`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ line: parseInt(btn.dataset.line, 10) }),
          });
          await loadGoals();
        } catch { /* network errors silenced */ }
        finally { btn.disabled = false; }
      });
    });
  } catch { /* network errors silenced */ }
}

async function loadReadme() {
  try {
    const r = await fetch(`/api/projects/${encodeURIComponent(NAME)}/readme`);
    if (!r.ok) return;
    const data = await r.json();
    const panel = document.getElementById('readme-panel');
    if (!data.markdown) {
      panel.hidden = true;
      return;
    }
    panel.hidden = false;
    document.getElementById('readme-status').textContent = `${data.markdown.length.toLocaleString()} chars`;
    if (window.marked) {
      document.getElementById('readme-body').innerHTML = marked.parse(data.markdown);
    } else {
      document.getElementById('readme-body').innerHTML = `<pre>${escapeHtml(data.markdown)}</pre>`;
    }
  } catch { /* network errors silenced */ }
}

async function loadDiff() {
  try {
    const r = await fetch(`/api/projects/${encodeURIComponent(NAME)}/diff`);
    if (!r.ok) return;
    const data = await r.json();
    const panel = document.getElementById('diff-panel');
    if (data.clean) {
      panel.hidden = true;
      return;
    }
    panel.hidden = false;
    const fileTypes = { 'M': 'modified', 'A': 'added', 'D': 'deleted', 'R': 'renamed', 'C': 'copied', '?': 'untracked' };
    const fileRows = data.files.map(f => {
      const flag = f.x.trim() || f.y.trim() || '?';
      const label = fileTypes[flag] || flag;
      return `<li class="diff-file ${label}" data-path="${escapeHtml(f.path)}"><code>${escapeHtml(f.path)}</code><span class="diff-flag">${escapeHtml(label)}</span></li>`;
    }).join('');
    document.getElementById('diff-summary').textContent = `${data.files.length} file${data.files.length === 1 ? '' : 's'} pending · click any file for diff`;
    document.getElementById('diff-body').innerHTML = `
      <ul class="diff-files">${fileRows}</ul>
      ${data.stat ? `<pre class="diff-stat muted small">${escapeHtml(data.stat)}</pre>` : ''}
    `;
    document.querySelectorAll('.diff-file[data-path]').forEach(row => {
      row.addEventListener('click', async () => {
        const existing = row.querySelector('.file-diff-content');
        if (existing) { existing.remove(); return; }
        const path = row.dataset.path;
        const wrap = document.createElement('div');
        wrap.className = 'file-diff-content';
        wrap.innerHTML = '<pre class="muted small">loading…</pre>';
        row.appendChild(wrap);
        try {
          const r = await fetch(`/api/projects/${encodeURIComponent(NAME)}/file_diff?path=${encodeURIComponent(path)}`);
          if (!r.ok) { wrap.innerHTML = '<pre class="muted small">server error</pre>'; return; }
          const data = await r.json();
          if (!data.diff) {
            wrap.innerHTML = '<pre class="muted small">no diff</pre>';
            return;
          }
          // Colorize +/- lines
          const colored = data.diff.split('\n').map(line => {
            if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) return `<span class="diff-meta">${escapeHtml(line)}</span>`;
            if (line.startsWith('@@')) return `<span class="diff-hunk">${escapeHtml(line)}</span>`;
            if (line.startsWith('+')) return `<span class="diff-add">${escapeHtml(line)}</span>`;
            if (line.startsWith('-')) return `<span class="diff-del">${escapeHtml(line)}</span>`;
            return escapeHtml(line);
          }).join('\n');
          const banner = data.untracked ? '<div class="muted small">(untracked — showing full file as additions)</div>' : '';
          wrap.innerHTML = `${banner}<pre class="file-diff">${colored}</pre>`;
        } catch (e) {
          wrap.innerHTML = `<pre class="muted small">error: ${escapeHtml(e.message)}</pre>`;
        }
      });
    });
  } catch { /* network errors silenced */ }
}

async function loadNotes() {
  try {
    const r = await fetch(`/api/projects/${encodeURIComponent(NAME)}/notes`);
    if (!r.ok) return;
    const data = await r.json();
    const ta = document.getElementById('notes-textarea');
    if (document.activeElement !== ta) {
      ta.value = data.text || '';
      renderNotesPreview(data.text || '');
    }
    if (data.mtime) {
      const dt = new Date(data.mtime * 1000);
      document.getElementById('notes-status').textContent = `last saved ${dt.toLocaleString()}`;
    }
  } catch { /* network errors silenced */ }
}

function renderNotesPreview(text) {
  const target = document.getElementById('notes-rendered');
  if (!text || !text.trim()) { target.innerHTML = ''; target.style.display = 'none'; return; }
  target.style.display = '';
  if (window.marked) {
    target.innerHTML = marked.parse(text);
  } else {
    target.innerHTML = `<pre>${escapeHtml(text)}</pre>`;
  }
}

let notesSaveTimer = null;
function setupNotes() {
  const ta = document.getElementById('notes-textarea');
  if (!ta) return;
  ta.addEventListener('input', () => {
    renderNotesPreview(ta.value);
    clearTimeout(notesSaveTimer);
    notesSaveTimer = setTimeout(() => saveNotes(), 1500);
  });
  ta.addEventListener('blur', () => saveNotes());
}

async function saveNotes() {
  const ta = document.getElementById('notes-textarea');
  if (!ta) return;
  const status = document.getElementById('notes-status');
  status.textContent = 'saving…';
  try {
    const r = await fetch(`/api/projects/${encodeURIComponent(NAME)}/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: ta.value }),
    });
    const data = await r.json();
    if (data.ok) {
      const dt = new Date(data.mtime * 1000);
      status.textContent = `✓ saved ${dt.toLocaleTimeString()} · ${data.bytes} bytes`;
    } else {
      status.textContent = '✗ save failed';
    }
  } catch (e) {
    status.textContent = `✗ ${e.message}`;
  }
}

// Highlight the page-tab matching the section in view
function setupTabHighlighting() {
  const tabs = document.querySelectorAll('.page-tab');
  if (!tabs.length) return;
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const id = entry.target.id;
        tabs.forEach(t => t.classList.toggle('active', t.getAttribute('href') === '#' + id));
      }
    });
  }, { rootMargin: '-100px 0px -60% 0px' });
  ['notes-panel', 'goals-panel', 'diff-panel', 'readme-panel', 'caps'].forEach(id => {
    const el = document.getElementById(id);
    if (el) observer.observe(el);
  });
  tabs.forEach(t => {
    t.addEventListener('click', (e) => {
      e.preventDefault();
      const id = t.getAttribute('href').slice(1);
      const el = document.getElementById(id);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
}
setupTabHighlighting();

setupNotes();
load();
loadHeroShowcase();
loadSignals();
loadGoals();
loadDiff();
loadNotes();
loadReadme();
setInterval(load, 30000);
setInterval(loadHeroShowcase, 60000);
setInterval(loadSignals, 45000);
setInterval(loadGoals, 15000);
setInterval(loadDiff, 10000);
setInterval(loadNotes, 30000);
setInterval(loadReadme, 60000);

// ---- markets-only quick actions + prediction logger ----
async function checkBriefingStatus() {
  try {
    const r = await fetch(`/api/projects/markets`);
    if (!r.ok) return;
    const data = await r.json();
    const briefing = (data.insights || []).find(i => i.label === 'Latest briefing');
    const status = document.getElementById('briefing-status');
    if (!status) return;
    const today = new Date().toISOString().slice(0, 10);
    if (briefing && briefing.value === today) {
      status.textContent = `✓ today's briefing exists (${today})`;
      status.style.color = 'var(--accent-2)';
    } else if (briefing) {
      status.textContent = `latest: ${briefing.value} — today's missing`;
      status.style.color = 'var(--warn)';
    } else {
      status.textContent = 'no briefings yet';
    }
  } catch (e) { /* ignore */ }
}

// Stable, distinguishable color per ticker. 25+ tickers need >7 hues; use HSL
// distributed across the wheel with a deterministic hash. Avoid pure red (reserved
// for losses) by skipping a narrow band around hue 0/360.
function tickerColor(t) {
  let h = 0;
  for (const c of t) h = (h * 31 + c.charCodeAt(0)) | 0;
  const hue = Math.abs(h * 47) % 320 + 20;  // 20..340, skips red band
  // Pick a saturation/lightness pair so dark and light themes both look good
  const sat = 65 + (Math.abs(h * 7) % 25);  // 65..90
  const light = 60 + (Math.abs(h * 13) % 15);  // 60..75
  return `hsl(${hue} ${sat}% ${light}%)`;
}

async function loadAnalytics() {
  if (NAME !== 'markets') return;
  try {
    const r = await fetch('/api/markets/analytics');
    if (!r.ok) return;
    const data = await r.json();
    if (!data.analytics || !Object.keys(data.analytics).length) return;
    document.getElementById('markets-analytics').hidden = false;
    document.getElementById('analytics-as-of').textContent = `as of ${data.as_of || ''}`;
    renderMomentum(data.analytics);
    renderSectors(data.sectors);
    renderCorrelations(data.correlations);
    renderRiskReturn(data.analytics);
  } catch { /* ignore */ }
}

async function loadCumulativeReturns() {
  if (NAME !== 'markets') return;
  try {
    const r = await fetch('/api/markets/cumulative_returns?days=252');
    if (!r.ok) return;
    const data = await r.json();
    if (!data.series || !data.series.length) return;
    document.getElementById('markets-cumret').hidden = false;
    renderCumret(data);
  } catch { /* ignore */ }
}

function renderRiskReturn(analytics) {
  const svg = document.getElementById('rr-scatter');
  if (!svg) return;
  const W = 720, H = 360, pad = { l: 50, r: 16, t: 14, b: 36 };
  const points = Object.entries(analytics)
    .filter(([_, a]) => a.annualized_volatility != null && a.annualized_return != null)
    .map(([t, a]) => ({ t, vol: a.annualized_volatility, ret: a.annualized_return, sharpe: a.sharpe || 0 }));
  if (points.length < 2) return;
  document.getElementById('markets-risk-return').hidden = false;

  const xMin = Math.min(...points.map(p => p.vol)) * 0.9;
  const xMax = Math.max(...points.map(p => p.vol)) * 1.05;
  const yMin = Math.min(...points.map(p => p.ret), 0) - 10;
  const yMax = Math.max(...points.map(p => p.ret)) * 1.05;
  const xScale = v => pad.l + (v - xMin) / (xMax - xMin) * (W - pad.l - pad.r);
  const yScale = v => pad.t + (1 - (v - yMin) / (yMax - yMin)) * (H - pad.t - pad.b);

  // Grid
  const grid = [];
  const xTicks = 5, yTicks = 5;
  for (let i = 0; i <= xTicks; i++) {
    const v = xMin + (xMax - xMin) * (i / xTicks);
    const x = xScale(v);
    grid.push(`<line x1="${x.toFixed(1)}" y1="${pad.t}" x2="${x.toFixed(1)}" y2="${H - pad.b}" stroke="#233048" stroke-width="0.4"/>`);
    grid.push(`<text x="${x.toFixed(1)}" y="${H - pad.b + 14}" font-size="10" fill="#8b98ad" text-anchor="middle">${v.toFixed(0)}%</text>`);
  }
  for (let i = 0; i <= yTicks; i++) {
    const v = yMin + (yMax - yMin) * (i / yTicks);
    const y = yScale(v);
    grid.push(`<line x1="${pad.l}" y1="${y.toFixed(1)}" x2="${W - pad.r}" y2="${y.toFixed(1)}" stroke="#233048" stroke-width="0.4"/>`);
    grid.push(`<text x="${pad.l - 6}" y="${(y + 3).toFixed(1)}" font-size="10" fill="#8b98ad" text-anchor="end">${v.toFixed(0)}%</text>`);
  }
  // Zero return line
  if (yMin < 0 && yMax > 0) {
    const y0 = yScale(0);
    grid.push(`<line x1="${pad.l}" y1="${y0.toFixed(1)}" x2="${W - pad.r}" y2="${y0.toFixed(1)}" stroke="#8b98ad" stroke-width="0.7" stroke-dasharray="3,3" opacity="0.4"/>`);
  }

  // Axis labels
  const labels = `
    <text x="${(W) / 2}" y="${H - 4}" font-size="11" fill="#8b98ad" text-anchor="middle">Annualized volatility (σ)</text>
    <text x="14" y="${H/2}" font-size="11" fill="#8b98ad" text-anchor="middle" transform="rotate(-90, 14, ${H/2})">Annualized return (μ)</text>
  `;

  // Iso-Sharpe lines (dashed) at sharpe = 0.5, 1, 1.5, 2
  const isoLines = [];
  for (const sharpe of [0.5, 1, 1.5, 2]) {
    // Line: ret = 4 + sharpe * vol
    const points2 = [
      { vol: xMin, ret: 4 + sharpe * xMin },
      { vol: xMax, ret: 4 + sharpe * xMax },
    ];
    const ok = points2.every(p => p.ret >= yMin && p.ret <= yMax);
    if (!ok) continue;
    const x1 = xScale(points2[0].vol), y1 = yScale(points2[0].ret);
    const x2 = xScale(points2[1].vol), y2 = yScale(points2[1].ret);
    isoLines.push(`<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="#7aa2f7" stroke-width="0.4" stroke-dasharray="3,4" opacity="0.3"/>`);
    isoLines.push(`<text x="${(x2 - 4).toFixed(1)}" y="${(y2 - 4).toFixed(1)}" font-size="9" fill="#7aa2f7" opacity="0.55" text-anchor="end">SR=${sharpe}</text>`);
  }

  // Dots — color by ticker now (matches cumret chart), with green/red inner accent for sign
  const dots = points.map(p => {
    const x = xScale(p.vol), y = yScale(p.ret);
    const r = 4 + Math.min(9, Math.abs(p.sharpe) * 2.5);
    const tColor = tickerColor(p.t);
    const accent = p.ret >= 0 ? '#9ece6a' : '#f7768e';
    const stroke = p.sharpe >= 1 ? '#e6edf3' : tColor;
    const strokeWidth = p.sharpe >= 1 ? '1.5' : '1';
    return `<g class="rr-dot">
      <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" fill="${tColor}" fill-opacity="0.75" stroke="${stroke}" stroke-width="${strokeWidth}" shape-rendering="geometricPrecision">
        <title>${p.t}: σ ${p.vol.toFixed(1)}% · μ ${p.ret.toFixed(1)}% · Sharpe ${p.sharpe.toFixed(2)}</title>
      </circle>
      <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2" fill="${accent}" opacity="0.95"/>
      <a href="/ticker/${encodeURIComponent(p.t)}"><text x="${(x + r + 3).toFixed(1)}" y="${(y + 3.5).toFixed(1)}" font-size="11" font-weight="600" fill="#e6edf3" font-family="SF Mono, monospace">${p.t}</text></a>
    </g>`;
  }).join('');

  svg.innerHTML = grid.join('') + isoLines.join('') + dots + labels;
}

function renderCumret(data) {
  const svg = document.getElementById('cumret-chart');
  if (!svg) return;
  const W = 720, H = 380, pad = { l: 56, r: 78, t: 14, b: 32 };
  // Widen viewBox to give room for end-of-line labels
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const series = data.series;
  // Common dates union
  const allDates = new Set();
  for (const s of series) for (const p of s.points) allDates.add(p.date);
  const dates = [...allDates].sort();
  if (dates.length < 2) return;
  const dateIdx = Object.fromEntries(dates.map((d, i) => [d, i]));

  const allVals = series.flatMap(s => s.points.map(p => p.rebased));
  const yMin = Math.min(...allVals) * 0.95;
  const yMax = Math.max(...allVals) * 1.02;
  const xScale = i => pad.l + i / Math.max(1, dates.length - 1) * (W - pad.l - pad.r);
  const yScale = v => pad.t + (1 - (v - yMin) / (yMax - yMin)) * (H - pad.t - pad.b);

  // Grid
  const grid = [];
  const yTicks = 6;
  for (let i = 0; i <= yTicks; i++) {
    const v = yMin + (yMax - yMin) * (i / yTicks);
    const y = yScale(v);
    grid.push(`<line x1="${pad.l}" y1="${y.toFixed(1)}" x2="${W - pad.r}" y2="${y.toFixed(1)}" stroke="#2a3a55" stroke-width="0.5" opacity="0.6"/>`);
    grid.push(`<text x="${pad.l - 8}" y="${(y + 3).toFixed(1)}" font-size="11" fill="#8b98ad" text-anchor="end" font-family="SF Mono, monospace">${v.toFixed(0)}</text>`);
  }
  // Baseline at 100
  const y100 = yScale(100);
  grid.push(`<line x1="${pad.l}" y1="${y100.toFixed(1)}" x2="${W - pad.r}" y2="${y100.toFixed(1)}" stroke="#9ece6a" stroke-width="1.0" stroke-dasharray="4,4" opacity="0.55"/>`);
  grid.push(`<text x="${(W - pad.r - 4).toFixed(1)}" y="${(y100 - 4).toFixed(1)}" font-size="9" fill="#9ece6a" text-anchor="end" opacity="0.7">base 100</text>`);

  // Rank series so we can label only top/bottom at the right edge to avoid overlap
  const sortedByEnd = [...series].sort((a, b) => b.points[b.points.length - 1].rebased - a.points[a.points.length - 1].rebased);
  const labelSet = new Set([
    ...sortedByEnd.slice(0, 5).map(s => s.ticker),
    ...sortedByEnd.slice(-5).map(s => s.ticker),
  ]);

  // Lines — thicker stroke, geometricPrecision rendering, grouped for hover
  const lines = series.map(s => {
    const path = s.points.map((p, i) => {
      const x = xScale(dateIdx[p.date]);
      const y = yScale(p.rebased);
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    const color = tickerColor(s.ticker);
    return `<path class="cumret-line" data-ticker="${escapeHtml(s.ticker)}" d="${path}" fill="none" stroke="${color}" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round" opacity="0.9" shape-rendering="geometricPrecision"/>`;
  }).join('');

  // End-of-line labels for top/bottom performers
  const endLabels = sortedByEnd.filter(s => labelSet.has(s.ticker)).map(s => {
    const last = s.points[s.points.length - 1];
    const x = xScale(dateIdx[last.date]);
    const y = yScale(last.rebased);
    const color = tickerColor(s.ticker);
    return `<text class="cumret-label" data-ticker="${escapeHtml(s.ticker)}" x="${(x + 4).toFixed(1)}" y="${(y + 3.5).toFixed(1)}" font-size="10" font-weight="600" fill="${color}" font-family="SF Mono, monospace">${escapeHtml(s.ticker)}</text>`;
  }).join('');

  // X axis dates
  const xTicks = [];
  const stride = Math.max(1, Math.floor(dates.length / 7));
  for (let i = 0; i < dates.length; i += stride) {
    const x = xScale(i);
    xTicks.push(`<text x="${x.toFixed(1)}" y="${H - 8}" font-size="10" fill="#8b98ad" text-anchor="middle" font-family="SF Mono, monospace">${dates[i].slice(2, 7)}</text>`);
  }

  svg.innerHTML = grid.join('') + lines + endLabels + xTicks.join('');

  // Hover highlight: mousing over a legend chip dims all lines except matching
  function applyHighlight(focus) {
    svg.querySelectorAll('.cumret-line').forEach(p => {
      const isFocus = !focus || p.dataset.ticker === focus;
      p.setAttribute('stroke-width', isFocus ? '2.6' : '1.0');
      p.setAttribute('opacity', isFocus ? '1' : '0.18');
    });
    svg.querySelectorAll('.cumret-label').forEach(t => {
      t.setAttribute('opacity', !focus || t.dataset.ticker === focus ? '1' : '0.25');
    });
  }

  const legend = document.getElementById('cumret-legend');
  legend.innerHTML = sortedByEnd.map(s => {
    const cls = s.total_return_pct >= 0 ? 'up' : 'down';
    const sign = s.total_return_pct >= 0 ? '+' : '';
    return `<a class="legend-item legend-link cumret-legend-item" data-ticker="${escapeHtml(s.ticker)}" href="/ticker/${encodeURIComponent(s.ticker)}">
      <span class="legend-swatch" style="background:${tickerColor(s.ticker)}"></span>
      <span><b>${escapeHtml(s.ticker)}</b> <span class="legend-pct ${cls}">${sign}${s.total_return_pct.toFixed(0)}%</span></span>
    </a>`;
  }).join('');
  legend.querySelectorAll('.cumret-legend-item').forEach(item => {
    item.addEventListener('mouseenter', () => applyHighlight(item.dataset.ticker));
    item.addEventListener('mouseleave', () => applyHighlight(null));
  });
}

function renderMomentum(analytics) {
  const arr = Object.entries(analytics).map(([t, a]) => ({ t, ...a }));
  const cols = [
    { title: '3-month', field: 'returns_3m' },
    { title: '12-month', field: 'returns_12m' },
    { title: 'Sharpe', field: 'sharpe' },
    { title: 'Drawdown from 52w high', field: 'distance_to_52w_high_pct' },
  ];
  const html = cols.map(col => {
    const valid = arr.filter(x => x[col.field] != null);
    valid.sort((a, b) => (b[col.field] - a[col.field]));
    const max = Math.max(...valid.map(x => Math.abs(x[col.field])), 1);
    const top = valid.slice(0, 6);
    const bottom = valid.slice(-6).reverse();
    const renderRow = (x, color) => {
      const v = x[col.field];
      const cls = v >= 0 ? 'up' : 'down';
      const w = Math.min(100, Math.abs(v) / max * 100);
      const fill = v >= 0 ? 'var(--accent-2)' : 'var(--bad)';
      const fmt = col.field === 'sharpe' ? v.toFixed(2) : `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
      return `<div class="mom-row ${cls}">
        <span class="mom-tick"><a href="/ticker/${encodeURIComponent(x.t)}" style="color:inherit; text-decoration:none">${x.t}</a></span>
        <div class="mom-bar"><div style="width:${w.toFixed(0)}%; background:${fill}"></div></div>
        <span class="mom-pct">${fmt}</span>
      </div>`;
    };
    return `<div class="mom-block">
      <h3>${col.title} · top</h3>
      ${top.map(x => renderRow(x)).join('')}
      <h3 style="margin-top:14px">${col.title} · bottom</h3>
      ${bottom.map(x => renderRow(x)).join('')}
    </div>`;
  }).join('');
  document.getElementById('analytics-momentum').innerHTML = `<div class="mom-grid">${html}</div>`;
}

function renderSectors(sectors) {
  if (!sectors || !Object.keys(sectors).length) return;
  document.getElementById('markets-sectors').hidden = false;
  const arr = Object.entries(sectors)
    .filter(([_, s]) => s.annualized_return != null)
    .map(([name, s]) => ({ name, ...s }));
  arr.sort((a, b) => (b.annualized_return - a.annualized_return));
  const max = Math.max(...arr.map(s => Math.abs(s.annualized_return)), 1);
  const html = arr.map(s => {
    const cls = s.annualized_return >= 0 ? 'up' : 'down';
    const w = Math.abs(s.annualized_return) / max * 100;
    return `<div class="sector-row">
      <div>
        <div class="s-name">${escapeHtml(s.name)}</div>
        <div class="s-desc">${s.n_members} tickers · ${escapeHtml(s.description || '')}</div>
      </div>
      <div class="s-bar ${cls}"><div style="width:${w.toFixed(0)}%"></div></div>
      <span class="s-ret ${cls}">${s.annualized_return >= 0 ? '+' : ''}${s.annualized_return.toFixed(1)}%</span>
      <span class="s-vol">σ ${s.annualized_volatility ? s.annualized_volatility.toFixed(0) + '%' : '—'}</span>
    </div>`;
  }).join('');
  document.getElementById('sector-bars').innerHTML = `<div class="sector-rows">${html}</div>`;
}

function renderCorrelations(matrix) {
  if (!matrix || !Object.keys(matrix).length) return;
  document.getElementById('markets-correlations').hidden = false;
  const tickers = Object.keys(matrix).sort();
  const corrColor = (v) => {
    if (v == null || isNaN(v)) return 'var(--panel-2)';
    if (v > 0) {
      const a = Math.min(1, Math.abs(v));
      return `rgba(158, 206, 106, ${a.toFixed(2)})`;
    } else {
      const a = Math.min(1, Math.abs(v));
      return `rgba(247, 118, 142, ${a.toFixed(2)})`;
    }
  };
  const headerRow = `<tr><th></th>${tickers.map(t => `<th class="col">${t}</th>`).join('')}</tr>`;
  const rows = tickers.map(t1 => {
    const cells = tickers.map(t2 => {
      const v = matrix[t1] ? matrix[t1][t2] : null;
      return `<td style="background:${corrColor(v)}; color:${Math.abs(v||0) > 0.6 ? '#0b0f17' : 'var(--text)'}" title="${t1} vs ${t2}: ${v != null ? v.toFixed(3) : '—'}">${v != null ? v.toFixed(2) : ''}</td>`;
    }).join('');
    return `<tr><th class="row">${t1}</th>${cells}</tr>`;
  }).join('');
  document.getElementById('corr-heatmap').innerHTML = `<table class="corr-table">${headerRow}${rows}</table>`;
}

async function loadPriceChart() {
  if (NAME !== 'markets') return;
  try {
    const r = await fetch('/api/markets/prices?top=8&days=30');
    if (!r.ok) return;
    const data = await r.json();
    if (!data.series || !data.series.length) {
      document.getElementById('markets-prices').hidden = true;
      return;
    }
    document.getElementById('markets-prices').hidden = false;
    document.getElementById('prices-summary').textContent =
      `top ${data.series.length} by absolute move · rebased to 100 at start`;
    renderPriceChart(data);
  } catch { /* ignore */ }
}

let watchlistChartType = 'line';

function renderPriceChart(data) {
  const svg = document.getElementById('prices-chart');
  const W = 720, H = 240, pad = { l: 40, r: 12, t: 12, b: 24 };

  // Combine all dates across all series for x-axis
  const allDates = new Set();
  for (const s of data.series) for (const p of s.points) allDates.add(p.date);
  const dates = [...allDates].sort();
  if (dates.length < 2) return;
  const dateIdx = Object.fromEntries(dates.map((d, i) => [d, i]));

  let body = '';
  let yMin = Infinity, yMax = -Infinity;

  if (watchlistChartType === 'line') {
    // Rebased multi-line
    for (const s of data.series) for (const p of s.points) {
      if (p.rebased < yMin) yMin = p.rebased;
      if (p.rebased > yMax) yMax = p.rebased;
    }
    const yPad = (yMax - yMin) * 0.05 || 1;
    yMin -= yPad; yMax += yPad;
    const xScale = (i) => pad.l + i / Math.max(1, dates.length - 1) * (W - pad.l - pad.r);
    const yScale = (v) => pad.t + (1 - (v - yMin) / Math.max(0.01, yMax - yMin)) * (H - pad.t - pad.b);
    body = data.series.map(s => {
      const color = tickerColor(s.ticker);
      const path = s.points.map((p, i) => {
        const x = xScale(dateIdx[p.date]);
        const y = yScale(p.rebased);
        return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
      }).join(' ');
      return `<path d="${path}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round"/>`;
    }).join('');
    // 100 baseline
    const y100 = yScale(100);
    body += `<line x1="${pad.l}" y1="${y100.toFixed(1)}" x2="${W - pad.r}" y2="${y100.toFixed(1)}" stroke="#9ece6a" stroke-width="0.7" stroke-dasharray="3,3" opacity="0.4"/>`;
    body = renderGrid(yMin, yMax, dates, pad, W, H, 4) + body;
    svg.innerHTML = body + renderXTicks(dates, pad, W, H, 4);
  } else {
    // Mini-candle grid: stack up to 4 candle charts (one per top-volatility ticker)
    const cols = Math.min(2, data.series.length);
    const rows = Math.ceil(Math.min(4, data.series.length) / cols);
    const cellW = (W - pad.r - 4) / cols;
    const cellH = (H - 4) / rows;
    body = data.series.slice(0, 4).map((s, idx) => {
      const cx = (idx % cols) * cellW + 4;
      const cy = Math.floor(idx / cols) * cellH + 4;
      const innerPad = { l: 36, r: 4, t: 16, b: 4 };
      const ohlc = s.ohlc || [];
      if (!ohlc.length) return '';
      const yMin2 = Math.min(...ohlc.map(d => d.low)) * 0.99;
      const yMax2 = Math.max(...ohlc.map(d => d.high)) * 1.01;
      const xScale = (i) => cx + innerPad.l + i / Math.max(1, ohlc.length - 1) * (cellW - innerPad.l - innerPad.r);
      const yScale = (v) => cy + innerPad.t + (1 - (v - yMin2) / Math.max(0.01, yMax2 - yMin2)) * (cellH - innerPad.t - innerPad.b);
      const cw = Math.max(1.2, (cellW - innerPad.l - innerPad.r) / ohlc.length * 0.7);
      const candles = ohlc.map((d, i) => {
        const x = xScale(i);
        const yo = yScale(d.open), yc = yScale(d.close);
        const yh = yScale(d.high), yl = yScale(d.low);
        const up = d.close >= d.open;
        const color = up ? '#9ece6a' : '#f7768e';
        const bodyTop = Math.min(yo, yc);
        const bodyHeight = Math.max(0.8, Math.abs(yc - yo));
        return `<line x1="${x.toFixed(1)}" y1="${yh.toFixed(1)}" x2="${x.toFixed(1)}" y2="${yl.toFixed(1)}" stroke="${color}" stroke-width="0.6"/>
          <rect x="${(x - cw/2).toFixed(1)}" y="${bodyTop.toFixed(1)}" width="${cw.toFixed(1)}" height="${bodyHeight.toFixed(1)}" fill="${color}"/>`;
      }).join('');
      const label = `<text x="${(cx + 4).toFixed(1)}" y="${(cy + 12).toFixed(1)}" font-size="11" font-weight="600" fill="${tickerColor(s.ticker)}">${escapeHtml(s.ticker)}</text>
        <text x="${(cx + cellW - innerPad.r - 4).toFixed(1)}" y="${(cy + 12).toFixed(1)}" font-size="10" fill="#8b98ad" text-anchor="end">$${s.last_close} ${s.pct_change >= 0 ? '+' : ''}${s.pct_change}%</text>`;
      return label + candles;
    }).join('');
    svg.innerHTML = body;
  }

  // Legend (clickable to drill into ticker page)
  const legend = document.getElementById('prices-legend');
  legend.innerHTML = data.series.map(s => {
    const color = tickerColor(s.ticker);
    const dirCls = s.pct_change >= 0 ? 'up' : 'down';
    const sign = s.pct_change >= 0 ? '+' : '';
    return `<a class="legend-item legend-link" href="/ticker/${encodeURIComponent(s.ticker)}">
      <span class="legend-swatch" style="background:${color}"></span>
      <span><b>${escapeHtml(s.ticker)}</b> $${s.last_close} <span class="legend-pct ${dirCls}">${sign}${s.pct_change}%</span></span>
    </a>`;
  }).join('');
}

function renderGrid(yMin, yMax, dates, pad, W, H, ticks) {
  const lines = [];
  for (let i = 0; i <= ticks; i++) {
    const v = yMin + (yMax - yMin) * (i / ticks);
    const y = pad.t + (1 - (v - yMin) / Math.max(0.01, yMax - yMin)) * (H - pad.t - pad.b);
    lines.push(`<line x1="${pad.l}" y1="${y.toFixed(1)}" x2="${W - pad.r}" y2="${y.toFixed(1)}" stroke="#233048" stroke-width="0.5"/>`);
    lines.push(`<text x="${pad.l - 6}" y="${(y + 3).toFixed(1)}" font-size="10" fill="#8b98ad" text-anchor="end">${v.toFixed(0)}</text>`);
  }
  return lines.join('');
}

function renderXTicks(dates, pad, W, H, ticks) {
  const out = [];
  const stride = Math.max(1, Math.floor(dates.length / ticks));
  for (let i = 0; i < dates.length; i += stride) {
    const x = pad.l + i / Math.max(1, dates.length - 1) * (W - pad.l - pad.r);
    out.push(`<text x="${x.toFixed(1)}" y="${H - 6}" font-size="10" fill="#8b98ad" text-anchor="middle">${dates[i].slice(5)}</text>`);
  }
  return out.join('');
}

let predDemoMode = false;
async function loadPredictionChart() {
  if (NAME !== 'markets') return;
  try {
    const r = await fetch(`/api/markets/prediction_chart${predDemoMode ? '?demo=true' : ''}`);
    if (!r.ok) return;
    const data = await r.json();
    document.getElementById('markets-predictions-chart').hidden = false;
    if (!data.points.length) {
      document.getElementById('predchart').innerHTML = '';
      document.getElementById('predchart-empty').hidden = false;
      document.getElementById('predchart-summary').textContent = 'no data yet';
      return;
    }
    document.getElementById('predchart-empty').hidden = true;
    const flag = predDemoMode || (data.demo && data.points[0]?.id?.startsWith('demo-'))
      ? `${data.points.length} demo predictions · synthetic`
      : `${data.points.length} resolved · ${data.points.filter(p=>p.correct).length} correct`;
    document.getElementById('predchart-summary').textContent = flag;
    renderPredictionChart(data);
  } catch { /* ignore */ }
}

function renderPredictionChart(data) {
  const svg = document.getElementById('predchart');
  const W = 720, H = 280, pad = { l: 40, r: 60, t: 16, b: 28 };
  const points = data.points;
  if (points.length < 2) { svg.innerHTML = ''; return; }

  // X axis: index of resolution
  const n = points.length;
  const xScale = (i) => pad.l + i / Math.max(1, n - 1) * (W - pad.l - pad.r);
  // Y axis 0–100 (for confidence + hit rate)
  const yScale = (v) => pad.t + (1 - v / 100) * (H - pad.t - pad.b);

  // Grid
  const grid = [];
  for (const v of [0, 25, 50, 75, 100]) {
    const y = yScale(v);
    grid.push(`<line x1="${pad.l}" y1="${y.toFixed(1)}" x2="${W - pad.r}" y2="${y.toFixed(1)}" stroke="#233048" stroke-width="0.5"/>`);
    grid.push(`<text x="${pad.l - 6}" y="${(y + 3).toFixed(1)}" font-size="10" fill="#8b98ad" text-anchor="end">${v}%</text>`);
  }

  // Confidence dots — green if correct, red if wrong
  const dots = points.map((p, i) => {
    const x = xScale(i);
    const y = yScale(p.confidence);
    const color = p.correct ? '#9ece6a' : '#f7768e';
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.5" fill="${color}" stroke="#0b0f17" stroke-width="0.5">
      <title>${p.ticker || p.id} · ${p.confidence}% · ${p.correct ? 'correct' : 'wrong'}</title>
    </circle>`;
  }).join('');

  // Rolling hit rate line (if available)
  let rollingLine = '';
  if (data.rolling && data.rolling.length) {
    const path = data.rolling.map((r, i) => {
      const x = xScale(i);
      const y = yScale(r.hit_rate);
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    rollingLine = `<path d="${path}" fill="none" stroke="#7aa2f7" stroke-width="2" stroke-linejoin="round" opacity="0.85"/>`;
  }

  // Right-side legend
  const legendY = pad.t + 12;
  const legend = `
    <g transform="translate(${W - pad.r + 6}, ${legendY})">
      <text x="0" y="0" font-size="10" fill="#8b98ad">legend</text>
      <circle cx="6" cy="14" r="3.5" fill="#9ece6a"/>
      <text x="14" y="17" font-size="10" fill="#e6edf3">correct</text>
      <circle cx="6" cy="30" r="3.5" fill="#f7768e"/>
      <text x="14" y="33" font-size="10" fill="#e6edf3">wrong</text>
      <line x1="0" y1="46" x2="12" y2="46" stroke="#7aa2f7" stroke-width="2"/>
      <text x="14" y="49" font-size="10" fill="#e6edf3">hit rate</text>
      <text x="0" y="68" font-size="9" fill="#8b98ad">rolling 10</text>
    </g>
  `;

  // Y-axis title
  const ylabel = `<text x="14" y="${H/2}" font-size="10" fill="#8b98ad" transform="rotate(-90, 14, ${H/2})" text-anchor="middle">confidence / hit rate</text>`;
  // X-axis title
  const xlabel = `<text x="${(W - pad.r + pad.l) / 2}" y="${H - 4}" font-size="10" fill="#8b98ad" text-anchor="middle">prediction (chronological)</text>`;

  svg.innerHTML = grid.join('') + rollingLine + dots + legend + ylabel + xlabel;
}

async function loadBriefings() {
  if (NAME !== 'markets') return;
  try {
    const r = await fetch('/api/markets/briefings');
    if (!r.ok) return;
    const data = await r.json();
    document.getElementById('markets-briefings').hidden = false;
    const target = document.getElementById('briefings-grid');
    document.getElementById('briefings-count').textContent =
      `${data.total}/${data.window} days · ${data.window - data.total} missing · click any ✓/⏳ to read`;
    target.innerHTML = data.days.map(d => {
      const cls = ['brief-cell'];
      if (d.is_weekend) cls.push('weekend');
      if (d.is_today) cls.push('today');
      if (d.exists && !d.has_tbd) cls.push('exists');
      if (d.has_tbd) cls.push('has-tbd');
      if (d.exists) cls.push('clickable');
      const icon = d.has_tbd ? '⏳' : d.exists ? '✓' : '—';
      const day = d.date.slice(8);
      return `<div class="${cls.join(' ')}" data-date="${escapeHtml(d.date)}" ${d.exists ? `role="button" tabindex="0"` : ''} title="${d.date}${d.has_tbd ? ' (has TBD sections)' : ''}${d.exists ? ' — click to read' : ''}">
        <div class="b-weekday">${escapeHtml(d.weekday)}</div>
        <div class="b-date">${escapeHtml(day)}</div>
        <div class="b-icon">${icon}</div>
      </div>`;
    }).join('');
    target.querySelectorAll('.brief-cell.clickable').forEach(cell => {
      const open = () => openBriefingModal(cell.dataset.date);
      cell.addEventListener('click', open);
      cell.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      });
    });
  } catch { /* ignore */ }
}

async function openBriefingModal(date) {
  const modal = document.getElementById('briefing-modal');
  const titleEl = document.getElementById('briefing-modal-title');
  const bodyEl = document.getElementById('briefing-modal-body');
  if (!modal || !titleEl || !bodyEl) return;
  titleEl.textContent = `Daily briefing — ${date}`;
  bodyEl.innerHTML = '<p class="muted small">loading…</p>';
  modal.hidden = false;
  try {
    const r = await fetch(`/api/markets/briefing/${encodeURIComponent(date)}`);
    if (!r.ok) {
      bodyEl.innerHTML = `<p class="muted small">server error (${r.status})</p>`;
      return;
    }
    const data = await r.json();
    if (!data.exists) {
      bodyEl.innerHTML = `<p class="muted small">No briefing on disk for ${date}.</p>`;
      return;
    }
    const html = (window.marked && typeof marked.parse === 'function')
      ? marked.parse(data.markdown)
      : `<pre class="muted small">${escapeHtml(data.markdown)}</pre>`;
    bodyEl.innerHTML = `<div class="md preview-pane">${html}</div>`;
  } catch (e) {
    bodyEl.innerHTML = `<p class="muted small">error: ${escapeHtml(e.message)}</p>`;
  }
}

// Briefing modal close handlers (markets-only, but safe to register
// generically — the modal is only added on the markets project page).
(function setupBriefingModal() {
  const modal = document.getElementById('briefing-modal');
  if (!modal) return;
  const close = () => { modal.hidden = true; };
  document.getElementById('briefing-modal-close')?.addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden) close(); });
})();

if (NAME === 'markets') {
  document.getElementById('markets-actions').hidden = false;
  checkBriefingStatus();
  setInterval(checkBriefingStatus, 30000);
  loadBriefings();
  setInterval(loadBriefings, 30000);
  loadPriceChart();
  setInterval(loadPriceChart, 60000);
  loadAnalytics();
  setInterval(loadAnalytics, 60000);
  loadCumulativeReturns();
  setInterval(loadCumulativeReturns, 60000);
  document.querySelectorAll('#markets-prices .chart-type-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#markets-prices .chart-type-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      watchlistChartType = btn.dataset.type;
      loadPriceChart();
    });
  });
  loadPredictionChart();
  setInterval(loadPredictionChart, 30000);
  document.getElementById('demo-toggle').addEventListener('change', (e) => {
    predDemoMode = e.target.checked;
    loadPredictionChart();
  });
  document.querySelectorAll('#markets-actions [data-act]').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await fetch('/api/exec', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project: 'markets', action: btn.dataset.act }),
        });
      } catch { /* network errors silenced */ }
      finally { btn.disabled = false; }
    });
  });

  const modal = document.getElementById('pred-modal');
  const form = document.getElementById('pred-form');
  const status = document.getElementById('pred-status');
  document.getElementById('btn-log-prediction').addEventListener('click', () => { modal.hidden = false; });
  document.getElementById('pred-close').addEventListener('click', () => { modal.hidden = true; });
  document.getElementById('pred-cancel').addEventListener('click', () => { modal.hidden = true; });

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const fd = new FormData(form);
    const body = {
      ticker: fd.get('ticker').trim(),
      direction: fd.get('direction'),
      horizon: fd.get('horizon').trim(),
      confidence: parseInt(fd.get('confidence'), 10),
      reasoning: fd.get('reasoning').trim(),
      invalidation: fd.get('invalidation').split('\n').map(s => s.trim()).filter(Boolean),
      sources: fd.get('sources').split('\n').map(s => s.trim()).filter(Boolean),
      slug: fd.get('slug').trim(),
    };
    if (!body.invalidation.length) {
      status.textContent = 'At least one invalidation condition required.';
      return;
    }
    status.textContent = 'submitting…';
    try {
      const r = await fetch('/api/log_prediction', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      if (data.ok) {
        status.textContent = '✓ logged. See vault/Predictions/.';
        setTimeout(() => { modal.hidden = true; form.reset(); status.textContent = ''; }, 1500);
        load();
      } else {
        status.textContent = '✗ ' + (data.output || 'failed').slice(0, 200);
      }
    } catch (e) { status.textContent = 'error: ' + e.message; }
  });
}

// ---- reef integration: agent runs on this repo + dispatch ----
const REEF_STATUS_CLS = { running: 'active', queued: 'recent', done: 'active', failed: 'stale', paused: 'recent', 'handed-off': 'recent' };

async function loadReef() {
  try {
    const r = await fetch(`/api/projects/${encodeURIComponent(NAME)}/reef`);
    if (!r.ok) return;
    const data = await r.json();
    const panel = document.getElementById('reef-panel');
    if (!panel) return;
    if (!data.alive) { panel.hidden = true; return; }
    panel.hidden = false;
    const layers = data.learnings_by_layer || {};
    const layerStr = ['bedrock', 'loam', 'topsoil'].filter(l => layers[l]).map(l => `${layers[l]} ${l}`).join(' · ');
    document.getElementById('reef-meta').innerHTML =
      `${data.learnings_count} learning${data.learnings_count === 1 ? '' : 's'}${layerStr ? ` (${layerStr})` : ''} · <a href="${escapeHtml(data.web_url)}" target="_blank" rel="noopener">open reef ↗</a>`;
    const runs = data.runs || [];
    document.getElementById('reef-runs').innerHTML = runs.length ? runs.map(run => {
      const started = new Date(run.startedAt);
      const cost = run.costUsd != null ? ` · $${run.costUsd.toFixed(2)}` : '';
      const changes = run.changes ? ` · ${run.changes.filesChanged} files +${run.changes.insertions}/−${run.changes.deletions}` : '';
      return `<div class="reef-run">
        <span class="badge ${REEF_STATUS_CLS[run.status] || 'stale'}">${escapeHtml(run.status)}</span>
        <span class="reef-run-prompt" title="${escapeHtml(run.prompt)}">${escapeHtml(run.prompt.slice(0, 90))}${run.prompt.length > 90 ? '…' : ''}</span>
        <span class="muted small">${started.toLocaleString()}${cost}${changes}</span>
      </div>`;
    }).join('') : '<p class="muted small">No agent runs on this repo yet.</p>';
  } catch { /* network errors silenced */ }
}

const reefForm = document.getElementById('reef-dispatch');
if (reefForm) {
  reefForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const ta = document.getElementById('reef-prompt');
    const status = document.getElementById('reef-dispatch-status');
    const prompt = ta.value.trim();
    if (!prompt) { status.textContent = 'describe the task first'; return; }
    status.textContent = 'dispatching…';
    try {
      const r = await fetch(`/api/projects/${encodeURIComponent(NAME)}/reef/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
      });
      const data = await r.json();
      if (r.ok && data.ok) {
        status.innerHTML = `✓ dispatched — <a href="${escapeHtml(data.web_url)}" target="_blank" rel="noopener">watch in reef ↗</a>`;
        ta.value = '';
        loadReef();
      } else {
        status.textContent = '✗ ' + (data.detail || 'dispatch failed');
      }
    } catch (e) { status.textContent = '✗ ' + e.message; }
  });
}

loadReef();
setInterval(loadReef, 15000);
