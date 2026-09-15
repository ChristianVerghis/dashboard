// Projects dashboard — live SPA. Vanilla JS only.

const el = {
  feed: document.getElementById('feed'),
  feedCount: document.getElementById('activity-count'),
  terminal: document.getElementById('terminal'),
  lastUpdate: document.getElementById('last-update'),  // may be absent in new layout
};

let projects = [];

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

let searchQuery = '';

function projectMatches(p, q) {
  if (!q) return true;
  const hay = [
    p.name,
    p.summary,
    p.branch,
    ...(p.insights || []).map(i => `${i.label} ${i.value}`),
  ].join(' ').toLowerCase();
  return hay.includes(q);
}

// Per-card content fingerprint — flash + re-render only when this specific
// project's data actually changed. Without this, every SSE delta flashes
// every card because we re-render the whole list on every push.
function projectFingerprint(p) {
  const last = p.last_commit;
  const gs = p.git_state || {};
  return JSON.stringify({
    name: p.name,
    momentum: p.momentum,
    commits: p.commit_count,
    files: p.file_count,
    size: p.total_size_bytes,
    branch: p.branch,
    last_sha: last ? last.sha : null,
    last_subject: last ? last.subject : null,
    insights: (p.insights || []).map(i => `${i.label}=${i.value}`).join('|'),
    sparkline: (p.commits_by_day || []).join(','),
    framework: p.framework,
    git: `${gs.dirty_count || 0}/${gs.ahead || 0}/${gs.behind || 0}`,
  });
}

function gitStateBadge(p) {
  const gs = p.git_state || {};
  const bits = [];
  if (gs.dirty_count) bits.push(`<span class="gs-bit dirty" title="${gs.dirty_count} uncommitted change${gs.dirty_count === 1 ? '' : 's'}">●${gs.dirty_count}</span>`);
  if (gs.ahead) bits.push(`<span class="gs-bit ahead" title="${gs.ahead} commit${gs.ahead === 1 ? '' : 's'} ahead of origin">↑${gs.ahead}</span>`);
  if (gs.behind) bits.push(`<span class="gs-bit behind" title="${gs.behind} commit${gs.behind === 1 ? '' : 's'} behind origin">↓${gs.behind}</span>`);
  if (gs.clean && gs.has_remote && !gs.ahead && !gs.behind) {
    bits.push(`<span class="gs-bit clean" title="clean & up to date">✓</span>`);
  }
  return bits.length ? `<span class="git-state">${bits.join('')}</span>` : '';
}

function frameworkClass(fw) {
  const map = {
    'Next.js': 'badge-react', 'React': 'badge-react', 'Vite': 'badge-react',
    'Node': 'badge-node', 'Python': 'badge-python', 'FastAPI': 'badge-python',
    'Rust': 'badge-rust', 'Go': 'badge-go', 'Vault': 'badge-vault',
  };
  return map[fw] || 'badge-other';
}

function projectFingerprintForTile(p) {
  const last = p.last_commit;
  const goalIns = (p.insights || []).find(i => i.label === 'Goals');
  const v = p.signals?.verdict;
  return JSON.stringify({
    name: p.name,
    momentum: p.momentum,
    framework: p.framework,
    last_subject: last ? last.subject : null,
    goals: goalIns ? goalIns.value : null,
    verdict: v ? `${v.level}:${(v.reasons || []).join(';')}` : null,
  });
}

// Verdict (from manifest-declared probes) beats mtime-momentum when present.
function verdictDot(p) {
  const v = p.signals?.verdict;
  if (!v) return `<span class="pt-momentum ${p.momentum}" title="${escapeHtml(p.momentum)}"></span>`;
  const title = v.reasons?.length ? v.reasons.join(' · ') : v.level;
  return `<span class="pt-verdict v-${v.level}" title="${escapeHtml(title)}"></span>`;
}

// ---- Showcase shelf: each project's latest product ----
// app+up → live scaled iframe · app+down → last snapshot · file → /files
// iframe · markdown-latest → newest doc rendered with marked.

function fmtAsOf(iso) {
  if (!iso) return '';
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  return fmtAge(s).replace(' ago', '') + ' old';
}

function renderShowcaseCard(it) {
  const meta = [];
  if (it.title) meta.push(it.title);
  if (it.kind === 'app' && it.up) meta.push('live');
  else if (it.as_of) meta.push(fmtAsOf(it.as_of));
  let body = '';
  if (it.kind === 'app' && it.up) {
    body = `
      <div class="sc-frame-wrap">
        <iframe class="sc-frame" src="${escapeHtml(it.url)}" loading="lazy" title="${escapeHtml(it.project)} live preview"></iframe>
        <a class="sc-overlay" href="${escapeHtml(it.url)}" target="_blank" rel="noopener" aria-label="open ${escapeHtml(it.project)}"></a>
      </div>`;
  } else if (it.kind === 'app' && it.snapshot) {
    body = `
      <div class="sc-frame-wrap">
        <img class="sc-img" src="${escapeHtml(it.snapshot)}" alt="${escapeHtml(it.project)} snapshot" loading="lazy" />
        <span class="sc-down-badge">down · snapshot</span>
        <a class="sc-overlay" href="/project/${encodeURIComponent(it.project)}" aria-label="open ${escapeHtml(it.project)} page"></a>
      </div>`;
  } else if (it.kind === 'app') {
    body = `<div class="sc-frame-wrap sc-empty"><span>service down — no snapshot yet</span></div>`;
  } else if (it.kind === 'file') {
    body = `
      <div class="sc-frame-wrap">
        <iframe class="sc-frame" src="${escapeHtml(it.url)}" loading="lazy" sandbox="allow-same-origin" title="${escapeHtml(it.project)} artifact"></iframe>
        <a class="sc-overlay" href="${escapeHtml(it.url)}" target="_blank" rel="noopener" aria-label="open artifact"></a>
      </div>`;
  } else { // markdown-latest
    body = `<div class="sc-md md" data-md-url="${escapeHtml(it.url)}">loading…</div>`;
  }
  return `
    <div class="shelf-card">
      <div class="shelf-card-head">
        <a class="sc-proj" href="/project/${encodeURIComponent(it.project)}">${escapeHtml(it.project)}</a>
        <span class="sc-meta muted small">${escapeHtml(meta.join(' · '))}</span>
        <a class="sc-open muted small" href="${escapeHtml(it.url)}" target="_blank" rel="noopener">open ↗</a>
      </div>
      ${body}
    </div>`;
}

async function loadShowcase() {
  try {
    const r = await fetch('/api/showcase');
    if (!r.ok) return;
    const data = await r.json();
    const shelf = document.getElementById('showcase-shelf');
    if (!shelf) return;
    const items = data.items || [];
    if (!items.length) { shelf.hidden = true; return; }
    // Fingerprint: iframes reload on re-render, so only touch the DOM when
    // the shelf's content actually changed.
    const fp = JSON.stringify(items);
    if (shelf.dataset.fp === fp) return;
    shelf.dataset.fp = fp;
    shelf.hidden = false;
    shelf.innerHTML = `
      <div class="panel-head">
        <h2>Latest products</h2>
        <span class="muted small">what each project most recently made ·
          <button id="showcase-capture" class="linklike" title="screenshot every running service as a poster frame">capture snapshots</button>
        </span>
      </div>
      <div class="shelf-row">${items.map(renderShowcaseCard).join('')}</div>`;
    shelf.querySelectorAll('[data-md-url]').forEach(async (el) => {
      try {
        const t = await (await fetch(el.dataset.mdUrl)).text();
        const clipped = t.slice(0, 5000);
        el.innerHTML = window.marked ? marked.parse(clipped) : `<pre>${escapeHtml(clipped)}</pre>`;
      } catch { el.textContent = 'preview unavailable'; }
    });
    const cap = document.getElementById('showcase-capture');
    if (cap) cap.addEventListener('click', async () => {
      cap.disabled = true; cap.textContent = 'capturing…';
      try { await fetch('/api/showcase/capture', { method: 'POST' }); } catch {}
      cap.textContent = 'capture snapshots'; cap.disabled = false;
      delete document.getElementById('showcase-shelf').dataset.fp;
      loadShowcase();
    });
  } catch { /* network errors silenced */ }
}
loadShowcase();
setInterval(loadShowcase, 60000);

// Attention strip: the worst red/amber verdicts across the portfolio,
// each deep-linking to its project page.
function renderAttention(list) {
  const strip = document.getElementById('attention-strip');
  if (!strip) return;
  const items = [];
  for (const p of list) {
    const v = p.signals?.verdict;
    if (!v || (v.level !== 'red' && v.level !== 'amber') || !v.reasons?.length) continue;
    items.push({ name: p.name, level: v.level, reasons: v.reasons });
  }
  items.sort((a, b) => (a.level === b.level ? 0 : a.level === 'red' ? -1 : 1));
  if (!items.length) {
    strip.hidden = true;
    return;
  }
  strip.hidden = false;
  strip.innerHTML = items.slice(0, 5).map(it => `
    <a class="attn-item attn-${it.level}" href="/project/${encodeURIComponent(it.name)}">
      <span class="attn-dot"></span>
      <span class="attn-proj">${escapeHtml(it.name)}</span>
      <span class="attn-reason">${escapeHtml(it.reasons.slice(0, 2).join(' · '))}</span>
    </a>`).join('');
}

// New, simpler renderer: 4 project tiles at the top, each linking to /project/{name}.
function renderProjectNav(list) {
  const nav = document.getElementById('project-nav');
  if (!nav) return;
  // Stable name-keyed render: keep DOM nodes, only replace innerHTML if fingerprint changed.
  const existing = new Map([...nav.querySelectorAll('[data-name]')].map(n => [n.dataset.name, n]));
  const seen = new Set();
  const desiredOrder = list.map(p => p.name);
  for (const p of list) {
    seen.add(p.name);
    let tile = existing.get(p.name);
    const fresh = !tile;
    if (fresh) {
      tile = document.createElement('a');
      tile.dataset.name = p.name;
      tile.className = 'proj-tile';
      tile.href = `/project/${encodeURIComponent(p.name)}`;
      nav.appendChild(tile);
    }
    const fp = projectFingerprintForTile(p);
    if (tile.dataset.fp !== fp) {
      const goalIns = (p.insights || []).find(i => i.label === 'Goals');
      const goalText = goalIns ? goalIns.value : '';
      const color = projectColor(p.name);
      const fwBadge = p.framework
        ? `<span class="pt-fw ${frameworkClass(p.framework)}">${escapeHtml(p.framework)}</span>`
        : '';
      tile.innerHTML = `
        <span class="pt-icon" style="background:${color}1a; color:${color}; border-color:${color}40">${escapeHtml(initialsOf(p.name))}</span>
        <div class="pt-body">
          <div class="pt-name">${escapeHtml(p.name)}</div>
          <div class="pt-meta">${fwBadge}${goalText ? `<span class="pt-progress">${escapeHtml(goalText)}</span>` : ''}</div>
        </div>
        ${verdictDot(p)}
      `;
      tile.dataset.fp = fp;
    }
  }
  // Remove tiles for projects that no longer exist.
  for (const [name, node] of existing) {
    if (!seen.has(name)) node.remove();
  }
  // Reorder only if needed.
  const currentOrder = [...nav.children].map(n => n.dataset.name);
  if (currentOrder.length !== desiredOrder.length ||
      currentOrder.some((n, i) => n !== desiredOrder[i])) {
    for (const p of list) {
      const tile = nav.querySelector(`[data-name="${cssEscape(p.name)}"]`);
      if (tile) nav.appendChild(tile);
    }
  }
}

function initialsOf(name) {
  const parts = name.split(/[-_\s]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function renderSparkline(counts) {
  if (!counts || !counts.length) return '';
  const max = Math.max(1, ...counts);
  const w = 100, h = 24, n = counts.length;
  const bw = w / n;
  const bars = counts.map((c, i) => {
    const bh = (c / max) * (h - 2);
    const x = (i * bw).toFixed(2);
    const y = (h - bh).toFixed(2);
    const opacity = c === 0 ? 0.15 : 0.55 + 0.45 * (c / max);
    return `<rect x="${x}" y="${y}" width="${(bw - 0.5).toFixed(2)}" height="${bh.toFixed(2)}" fill="#7aa2f7" fill-opacity="${opacity.toFixed(2)}" rx="0.5"/>`;
  }).join('');
  const total = counts.reduce((a, b) => a + b, 0);
  return `
    <div class="sparkline-wrap">
      <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" class="sparkline">${bars}</svg>
      <div class="sparkline-label muted small">${total} commits · 30d</div>
    </div>`;
}

// Stable color from project name — used for icons + journal. HSL-based so we
// have unlimited distinct hues without recycling.
function projectColor(name) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) | 0;
  const hue = Math.abs(h * 47) % 320 + 20;
  const sat = 65 + (Math.abs(h * 7) % 25);
  const light = 60 + (Math.abs(h * 13) % 15);
  return `hsl(${hue} ${sat}% ${light}%)`;
}

function projectIcon(name) {
  // Use first letter of each word, max 2 chars
  const parts = name.split(/[-_\s]+/).filter(Boolean);
  let initials;
  if (parts.length >= 2) initials = (parts[0][0] + parts[1][0]).toUpperCase();
  else initials = name.slice(0, 2).toUpperCase();
  const color = projectColor(name);
  return `<span class="proj-icon" style="background:${color}1a; color:${color}; border-color:${color}40">${escapeHtml(initials)}</span>`;
}

function frameworkBadge(fw) {
  if (!fw) return '';
  const palette = {
    'Next.js': 'badge-react',
    'React': 'badge-react',
    'Vite': 'badge-react',
    'Node': 'badge-node',
    'Python': 'badge-python',
    'FastAPI': 'badge-python',
    'Rust': 'badge-rust',
    'Go': 'badge-go',
    'Vault': 'badge-vault',
  };
  const cls = palette[fw] || 'badge-other';
  return `<span class="fw-badge ${cls}">${escapeHtml(fw)}</span>`;
}

function renderCardHTML(p) {
  const last = p.last_commit;
  // Pull alert insights to the top, then up to 3 normal ones.
  const alerts = (p.insights || []).filter(i => i.kind === 'alert');
  const others = (p.insights || []).filter(i => i.kind !== 'alert');
  const showInsights = [...alerts, ...others].slice(0, alerts.length + 3);
  const insightsHtml = showInsights.length
    ? `<div class="insights">${showInsights.map(i => `
        <div class="insight" data-kind="${escapeHtml(i.kind || 'metric')}"><div class="k">${escapeHtml(i.label)}</div><div class="v">${escapeHtml(i.value)}</div></div>
      `).join('')}</div>`
    : '';
  return `
    <div class="card-head">
      <div class="card-name">${projectIcon(p.name)} <span>${escapeHtml(p.name)}</span> ${frameworkBadge(p.framework)} ${gitStateBadge(p)}</div>
      <span class="badge ${p.momentum}">${p.momentum}</span>
    </div>
    <div class="summary">${escapeHtml(p.summary || 'No README summary available.')}</div>
    ${insightsHtml}
    <div class="metrics">
      <div class="metric"><div class="k">Commits</div><div class="v">${fmtCount(p.commit_count)}</div></div>
      <div class="metric"><div class="k">Files</div><div class="v">${fmtCount(p.file_count)}</div></div>
      <div class="metric"><div class="k">Size</div><div class="v">${fmtBytes(p.total_size_bytes)}</div></div>
      <div class="metric"><div class="k">Branch</div><div class="v">${escapeHtml(p.branch || '—')}</div></div>
    </div>
    ${last ? `
      <div class="last-commit">
        <span class="sha">${last.short_sha}</span>
        ${escapeHtml(last.subject.slice(0, 80))}
        <span class="age">${fmtAge(last.age_seconds)}</span>
      </div>
    ` : '<div class="last-commit muted">No commits yet</div>'}
    ${renderSparkline(p.commits_by_day)}
    <div class="card-foot">
      <button class="pin-btn" data-name="${escapeHtml(p.name)}" title="pin to top" onclick="event.stopPropagation(); togglePin('${escapeHtml(p.name)}')">${isPinned(p.name) ? '★' : '☆'}</button>
      <a class="card-link" href="/project/${encodeURIComponent(p.name)}" onclick="event.stopPropagation()">View capabilities →</a>
    </div>
  `;
}

// Pinning — persist in localStorage, pinned projects render first.
function getPinned() {
  try { return new Set(JSON.parse(localStorage.getItem('dashboard-pins') || '[]')); }
  catch { return new Set(); }
}
function isPinned(name) { return getPinned().has(name); }
function togglePin(name) {
  const pins = getPinned();
  if (pins.has(name)) pins.delete(name); else pins.add(name);
  localStorage.setItem('dashboard-pins', JSON.stringify([...pins]));
  renderCards(projects);
}
window.togglePin = togglePin;  // accessible from inline onclick

let activityFilter = localStorage.getItem('dashboard-activity-filter') || 'all';
let lastActivity = [];

function renderActivityChips(items) {
  const counts = {};
  for (const it of items) counts[it.project] = (counts[it.project] || 0) + 1;
  const chips = ['all', ...Object.keys(counts).sort()];
  document.getElementById('activity-chips').innerHTML = chips.map(c => {
    const label = c === 'all' ? `all · ${items.length}` : `${c} · ${counts[c] || 0}`;
    return `<span class="act-chip ${activityFilter === c ? 'active' : ''}" data-chip="${escapeHtml(c)}">${escapeHtml(label)}</span>`;
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
      <span class="proj">${escapeHtml(it.project)}</span>
      <span class="title">${escapeHtml(it.title)}${link ? ' ' + link : ''}<div class="muted small">${escapeHtml(it.subtitle || '')}</div></span>
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
  el.feedCount.textContent = activityFilter === 'all'
    ? `${items.length} items`
    : `${filtered.length}/${items.length} (${activityFilter})`;
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
      det.innerHTML = `<pre class="commit-body">${escapeHtml(data.body)}</pre>`;
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

function openDetail(name) {
  const p = projects.find(x => x.name === name);
  if (!p) return;
  el.detailName.textContent = p.name;
  el.detail.hidden = false;
  el.detailBody.innerHTML = renderDetailHTML(p);
  loadActions(name);
  loadPreview(name);
  el.detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function loadPreview(name) {
  const target = document.getElementById('preview-' + name);
  if (!target) return;
  try {
    const r = await fetch(`/api/projects/${encodeURIComponent(name)}/preview`);
    const data = await r.json();
    if (data.markdown && window.marked) {
      target.innerHTML = `<h3>Preview · ${escapeHtml(data.path)}</h3>
        <div class="md">${marked.parse(data.markdown)}</div>`;
    } else if (data.markdown) {
      target.innerHTML = `<h3>Preview · ${escapeHtml(data.path)}</h3>
        <pre class="md-fallback">${escapeHtml(data.markdown.slice(0, 4000))}</pre>`;
    }
  } catch (e) { console.error(e); }
}

function renderDetailHTML(p) {
  const totalLangs = Object.values(p.languages).reduce((a, b) => a + b, 0);
  const palette = ['#7aa2f7','#9ece6a','#e0af68','#bb9af7','#f7768e','#7dcfff','#cfc9c2'];
  const langEntries = Object.entries(p.languages).sort((a,b) => b[1] - a[1]).slice(0, 7);

  const langBar = totalLangs ? `
    <div>
      <h3>Files by extension</h3>
      <div class="lang-bar">
        ${langEntries.map(([ext, n], i) => `<span style="background:${palette[i % palette.length]}; width:${(n/totalLangs*100).toFixed(1)}%"></span>`).join('')}
      </div>
      <div class="lang-legend" style="margin-top:8px">
        ${langEntries.map(([ext, n], i) => `<span><i style="background:${palette[i % palette.length]}"></i>.${escapeHtml(ext)} (${n})</span>`).join('')}
      </div>
    </div>
  ` : '';

  const commits = p.recent_commits.slice(0, 12).map(c => `
    <div class="commit-row">
      <span class="sha">${c.short_sha}</span>
      <span>${escapeHtml(c.subject)}</span>
      <span class="age">${fmtAge(c.age_seconds)}</span>
    </div>
  `).join('');

  const todos = (p.todos && p.todos.length) ? `
    <div>
      <h3>Open TODOs (from build_log.md)</h3>
      <ul>${p.todos.map(t => `<li>${escapeHtml(t)}</li>`).join('')}</ul>
    </div>
  ` : '';

  const insights = (p.insights && p.insights.length) ? `
    <div>
      <h3>Project insights</h3>
      <div class="insight-grid">
        ${p.insights.map(i => `
          <div class="insight"><div class="k">${escapeHtml(i.label)}</div><div class="v">${escapeHtml(i.value)}</div></div>
        `).join('')}
      </div>
    </div>
  ` : '';

  return `
    <div>
      <h3>Path</h3>
      <code>${escapeHtml(p.path)}</code>
    </div>
    ${p.remote_url ? `<div><h3>Remote</h3><code>${escapeHtml(p.remote_url)}</code></div>` : ''}
    <div id="actions-${escapeHtml(p.name)}" class="actions-wrap">
      <h3>Actions</h3>
      <div class="action-buttons" data-project="${escapeHtml(p.name)}"></div>
    </div>
    ${insights}
    <div>
      <h3>Recent commits</h3>
      ${commits || '<div class="muted">No commits yet</div>'}
    </div>
    ${langBar}
    ${todos}
    <div id="preview-${escapeHtml(p.name)}" class="preview-pane"></div>
  `;
}

async function loadActions(name) {
  try {
    const resp = await fetch(`/api/projects/${encodeURIComponent(name)}/actions`);
    const actions = await resp.json();
    const container = document.querySelector(`.action-buttons[data-project="${cssEscape(name)}"]`);
    if (!container) return;
    container.innerHTML = actions.map(a =>
      `<button class="action-btn" data-action="${escapeHtml(a)}">${escapeHtml(a)}</button>`
    ).join('');
    container.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        const a = btn.dataset.action;
        try {
          const r = await fetch('/api/exec', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ project: name, action: a }),
          });
          const data = await r.json();
          // Output appears in the live log pane via SSE.
        } catch (e) { console.error(e); }
        finally { btn.disabled = false; }
      });
    });
  } catch (e) { console.error(e); }
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

function toast({ title, body, kind = '' }) {
  const root = document.getElementById('toasts');
  if (!root) return;
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<div class="t-title">${escapeHtml(title)}</div>${body ? `<div class="t-body">${escapeHtml(body)}</div>` : ''}`;
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
        projects = data.projects;
        renderProjectNav(projects);
        renderAttention(projects);
        renderFeed(data.activity);
        setLastUpdate(data.type === 'snapshot' ? (data.stale ? 'refreshing…' : 'live') : `live · changed ${new Date().toLocaleTimeString()}`);
        if (data.type === 'delta') {
          const fresh = detectNewFeedItems(data.activity);
          for (const f of fresh.slice(0, 3)) {
            toast({
              title: `${f.project}: ${f.title.slice(0, 80)}`,
              body: f.subtitle || '',
              kind: f.kind === 'commit' ? 'commit' : (f.kind === 'file' ? 'file' : ''),
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
        const ts = new Date().toLocaleTimeString();
        el.terminal.textContent += `[${ts}] ${data.text}\n`;
        el.terminal.scrollTop = el.terminal.scrollHeight;
      } else if (data.type === 'hello') {
        el.terminal.textContent += `[ready] tailing ${data.path}\n`;
      }
    } catch (e) { /* ignore */ }
  };
}

function fmtCountdownLocal(seconds) {
  if (seconds == null) return '—';
  const abs = Math.abs(seconds);
  const sign = seconds < 0 ? '-' : '';
  const d = Math.floor(abs / 86400);
  const h = Math.floor((abs % 86400) / 3600);
  const m = Math.floor((abs % 3600) / 60);
  const s = abs % 60;
  if (d > 0) return `${sign}${d}d ${h}h ${m}m`;
  if (h > 0) return `${sign}${h}h ${m}m ${s}s`;
  if (m > 0) return `${sign}${m}m ${s}s`;
  return `${sign}${s}s`;
}

let _nextFireAt = null;
let _nextFireBlocked = false;

async function loadNow() {
  try {
    const r = await fetch('/api/now');
    if (!r.ok) return;
    const data = await r.json();
    const sec = document.getElementById('now-next');
    if (!data.next_routine && !data.next_goals?.length) {
      sec.hidden = true;
      return;
    }
    sec.hidden = false;
    const block = sec.querySelector('.now-block');
    if (data.routines_stale) {
      _nextFireAt = null;
      const age = data.routines_stale.age_days;
      document.getElementById('next-routine-name').textContent = 'routines snapshot stale';
      document.getElementById('next-routine-countdown').textContent = age ? `${Math.round(age)}d old` : 'unknown age';
      document.getElementById('next-routine-purpose').textContent = 'refresh data/routines_snapshot.json — countdowns are suppressed until it is current';
      block.classList.add('is-blocked');
    } else if (data.next_routine) {
      _nextFireAt = new Date(data.next_routine.next_run_at).getTime();
      _nextFireBlocked = !!data.next_routine.blocked;
      block.classList.toggle('is-blocked', _nextFireBlocked);
      document.getElementById('next-routine-name').textContent = data.next_routine.name;
      document.getElementById('next-routine-purpose').textContent = data.next_routine.purpose || '';
      tickNextFire();
    } else {
      _nextFireAt = null;
      document.getElementById('next-routine-name').textContent = 'no scheduled routines';
      document.getElementById('next-routine-countdown').textContent = '—';
    }
    const ul = document.getElementById('next-goals');
    if (data.next_goals?.length) {
      ul.innerHTML = data.next_goals.map(g =>
        `<li><span class="ng-proj">${escapeHtml(g.project)}</span>${escapeHtml(g.goal)}</li>`
      ).join('');
    } else {
      ul.innerHTML = '<li class="muted">No open goals.</li>';
    }
  } catch { /* network errors silenced */ }
}

function tickNextFire() {
  if (_nextFireAt == null) return;
  const seconds = Math.floor((_nextFireAt - Date.now()) / 1000);
  const el = document.getElementById('next-routine-countdown');
  if (el) el.textContent = fmtCountdownLocal(seconds);
}
setInterval(tickNextFire, 1000);

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
        <span class="r-proj">${escapeHtml(r.project)}</span>
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
    ind.textContent = `${r0.project} · ${r0.action}${more}`;
  } catch { /* swallow network errors during server restarts */ }
}
setInterval(loadRunning, 1500);
loadRunning();

async function loadOnboarding() {
  // Onboarding panel was removed from the new layout — no-op.
  if (!document.getElementById('onboarding')) return;
  if (localStorage.getItem('dashboard-onboarded') === 'true') return;
  try {
    const [predResp, projResp] = await Promise.all([
      fetch('/api/predictions').then(r => r.json()),
      fetch('/api/projects').then(r => r.json()),
    ]);
    const markets = projResp.find(p => p.name === 'markets');
    const briefings = markets ? (markets.insights || []).find(i => i.label === 'Latest briefing') : null;
    const briefingExists = briefings && briefings.value !== 'none yet';
    const predLogged = predResp.predictions && predResp.predictions.length > 0;
    const fredKey = false;  // can't see .env contents safely; assume false until they tell us

    const steps = [
      {
        done: projResp.length > 1,
        text: 'Discover your projects',
        action: `${projResp.length} found under <code>~/dev/</code>`,
      },
      {
        done: briefingExists,
        text: 'Generate your first daily briefing',
        action: `<a href="/project/markets">Open markets</a> → click <code>Show latest briefings</code>, or run <code>python scripts/daily_briefing.py</code>`,
      },
      {
        done: predLogged,
        text: 'Log your first prediction',
        action: `<a href="/project/markets">Open markets</a> → click <code>+ Log prediction</code>`,
      },
      {
        done: false,
        text: 'Press <kbd>⌘K</kbd> to jump anywhere',
        action: 'projects, pages, recent commits',
      },
      {
        done: false,
        text: 'Toggle theme with <kbd>T</kbd>, focus search with <kbd>/</kbd>',
        action: 'or click ◐ in the topbar',
      },
    ];
    if (steps.every(s => s.done) && localStorage.getItem('dashboard-onboarded') !== 'true') {
      // Auto-dismiss when everything's done
      localStorage.setItem('dashboard-onboarded', 'true');
      return;
    }
    document.getElementById('onboarding').hidden = false;
    document.getElementById('onboarding-steps').innerHTML = steps.map(s => `
      <li class="${s.done ? 'done' : ''}">
        <span>${s.done ? '✓ ' : ''}${s.text}</span>
        <span class="step-action">— ${s.action}</span>
      </li>
    `).join('');
    document.getElementById('onboarding-dismiss').onclick = () => {
      localStorage.setItem('dashboard-onboarded', 'true');
      document.getElementById('onboarding').hidden = true;
    };
  } catch (e) { console.error(e); }
}

async function loadHeatmap() {
  try {
    const r = await fetch('/api/heatmap?weeks=26');
    if (!r.ok) return;
    const data = await r.json();
    if (!data.days || !data.days.length) {
      document.getElementById('heatmap-panel').hidden = true;
      return;
    }
    document.getElementById('heatmap-panel').hidden = false;
    document.getElementById('heatmap-summary').textContent = `${data.total} commits · busiest day ${data.max}`;
    renderHeatmap(data);
  } catch { /* network errors silenced */ }
}

function renderHeatmap(data) {
  const svg = document.getElementById('heatmap');
  const cellSize = 22, gap = 4, leftPad = 32, topPad = 16;
  const weeks = data.weeks;
  const max = Math.max(1, data.max);
  const w = leftPad + weeks * (cellSize + gap);
  const h = topPad + 7 * (cellSize + gap) + 4;
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);

  // Color scale: 0 → muted, max → accent2
  const colorFor = (n) => {
    if (n === 0) return '#1a2236';
    const intensity = Math.min(1, n / max);
    // blend muted blue (0.2) → green (1.0)
    const r = Math.round(122 + (158 - 122) * intensity);
    const g = Math.round(162 + (206 - 162) * intensity);
    const b = Math.round(247 + (106 - 247) * intensity);
    return `rgb(${r},${g},${b})`;
  };

  // Build SVG: column = week, row = weekday (0=Sun)
  const todayIso = new Date().toISOString().slice(0, 10);
  const cells = data.days.map((d, idx) => {
    const col = Math.floor(idx / 7);
    const row = d.weekday;
    const x = leftPad + col * (cellSize + gap);
    const y = topPad + row * (cellSize + gap);
    const link = d.count > 0 ? `data-link="/journal?date=${d.date}"` : '';
    const isToday = d.date === todayIso;
    const cls = `heatmap-cell ${d.count > 0 ? 'clickable' : ''} ${isToday ? 'today' : ''}`;
    return `<rect class="${cls}" ${link}
      data-date="${d.date}" data-count="${d.count}" data-by="${escapeHtml(JSON.stringify(d.by_project))}"
      x="${x}" y="${y}" width="${cellSize}" height="${cellSize}" rx="2"
      fill="${colorFor(d.count)}"></rect>`;
  }).join('');

  // Day-of-week labels
  const dayLabels = ['', 'Mon', '', 'Wed', '', 'Fri', ''];
  const labels = dayLabels.map((label, row) => {
    if (!label) return '';
    const y = topPad + row * (cellSize + gap) + cellSize - 2;
    return `<text x="0" y="${y}" font-size="9" fill="#8b98ad">${label}</text>`;
  }).join('');

  svg.innerHTML = labels + cells;

  const tooltip = document.getElementById('heatmap-tooltip');
  svg.querySelectorAll('.heatmap-cell').forEach(rect => {
    if (rect.dataset.link) {
      rect.style.cursor = 'pointer';
      rect.addEventListener('click', () => { window.location = rect.dataset.link; });
    }
    rect.addEventListener('mouseenter', (ev) => {
      const date = rect.dataset.date;
      const count = parseInt(rect.dataset.count, 10);
      let by = {};
      try { by = JSON.parse(rect.dataset.by); } catch {}
      const rows = Object.entries(by).map(([k, v]) => `<div class="ht-row"><span>${escapeHtml(k)}</span><span>${v}</span></div>`).join('');
      tooltip.innerHTML = `<div class="ht-date">${date}</div><div class="ht-row"><span>commits</span><span><b>${count}</b></span></div>${rows}`;
      tooltip.hidden = false;
      const panelRect = document.getElementById('heatmap-panel').getBoundingClientRect();
      const cellRect = rect.getBoundingClientRect();
      tooltip.style.left = (cellRect.left - panelRect.left + 18) + 'px';
      tooltip.style.top = (cellRect.top - panelRect.top - 30) + 'px';
    });
    rect.addEventListener('mouseleave', () => { tooltip.hidden = true; });
  });
}

async function loadToday() {
  try {
    const r = await fetch('/api/today');
    if (!r.ok) return;
    const data = await r.json();
    const totalCommits = data.totals.commits;
    const totalPreds = data.totals.predictions;
    const totalFiles = data.totals.files;
    if (totalCommits === 0 && totalPreds === 0 && totalFiles === 0) {
      document.getElementById('today-panel').hidden = true;
      return;
    }
    document.getElementById('today-panel').hidden = false;
    document.getElementById('today-date').textContent = data.date;
    const tiles = [];
    for (const row of data.by_project) {
      const sum = row.commits + row.files + row.predictions;
      if (sum === 0) continue;
      const parts = [];
      if (row.commits) parts.push(`<div class="today-tile"><div class="v">${row.commits}</div><div class="k">${row.project} commits</div></div>`);
      if (row.predictions) parts.push(`<div class="today-tile"><div class="v">${row.predictions}</div><div class="k">${row.project} predictions</div></div>`);
      tiles.push(...parts);
    }
    if (!tiles.length) {
      tiles.push(`<div class="today-tile zero"><div class="v">0</div><div class="k">no commits yet</div></div>`);
    }
    document.getElementById('today-stats').innerHTML = tiles.join('');
  } catch { /* network errors silenced */ }
}

connectProjectStream();
loadNow();
// Defer the second SSE stream and the heavy git-walk endpoints past first
// paint: Chrome caps HTTP/1.1 at 6 connections per host, and the two
// persistent streams plus a burst of scan-triggering API calls were
// starving the tile/shelf fetches on cold load.
setTimeout(() => {
  connectLogStream();
  loadToday();
  loadHeatmap();
  loadOnboarding();
}, 4000);
setInterval(loadToday, 30000);
setInterval(loadNow, 30000);
setInterval(loadHeatmap, 60000);

// "Since you left" banner — show what's new since the user's last visit.
async function loadSince() {
  // Since-banner removed from the new layout — no-op.
  if (!document.getElementById('since-banner')) return;
  const lastVisit = localStorage.getItem('dashboard-last-visit');
  // Save fresh visit timestamp early so a 5-minute close-and-reopen doesn't show "since 5 min ago"
  // (we use the value from BEFORE this load).
  if (!lastVisit) {
    localStorage.setItem('dashboard-last-visit', new Date().toISOString());
    return;
  }
  // Only show if last visit was more than 5 minutes ago — avoid noise on quick reloads.
  const minsSince = (Date.now() - new Date(lastVisit).getTime()) / 60000;
  if (minsSince < 5) {
    localStorage.setItem('dashboard-last-visit', new Date().toISOString());
    return;
  }
  try {
    const r = await fetch(`/api/since?iso=${encodeURIComponent(lastVisit)}`);
    const data = await r.json();
    if (!data.total || data.total < 1) {
      localStorage.setItem('dashboard-last-visit', new Date().toISOString());
      return;
    }
    const banner = document.getElementById('since-banner');
    banner.hidden = false;
    const projParts = Object.entries(data.by_project)
      .map(([k, v]) => `<b>${v}</b> ${escapeHtml(k)}`)
      .join(' · ');
    document.getElementById('since-summary').innerHTML =
      `<b>${data.total} new commit${data.total === 1 ? '' : 's'}</b> in ${minsSince < 60 ? Math.round(minsSince) + ' min' : Math.round(minsSince/60) + ' h'} away — ${projParts}`;
    const detail = document.getElementById('since-detail');
    detail.hidden = false;
    detail.innerHTML = `<ul>${data.matches.slice(0, 8).map(m =>
      `<li><span class="ng-proj">${escapeHtml(m.project)}</span><code class="muted small">${escapeHtml(m.short_sha)}</code> ${escapeHtml(m.subject)}</li>`
    ).join('')}</ul>`;
    document.getElementById('since-dismiss').onclick = () => {
      banner.hidden = true;
      localStorage.setItem('dashboard-last-visit', new Date().toISOString());
    };
  } catch (e) { console.error(e); }
}
loadSince();

// Compact-mode toggle — persists across sessions in localStorage
const savedDensity = localStorage.getItem('dashboard-density');
if (savedDensity === 'compact') document.documentElement.classList.add('compact');
function toggleDensity() {
  document.documentElement.classList.toggle('compact');
  localStorage.setItem('dashboard-density',
    document.documentElement.classList.contains('compact') ? 'compact' : 'comfortable');
}
const densityBtn = document.getElementById('density-toggle');
if (densityBtn) densityBtn.addEventListener('click', toggleDensity);

// Theme toggle — persists across sessions in localStorage
const savedTheme = localStorage.getItem('dashboard-theme');
if (savedTheme === 'light') document.documentElement.classList.add('light');
function toggleTheme() {
  document.documentElement.classList.toggle('light');
  localStorage.setItem('dashboard-theme',
    document.documentElement.classList.contains('light') ? 'light' : 'dark');
}
const themeBtn = document.getElementById('theme-toggle');
if (themeBtn) themeBtn.addEventListener('click', toggleTheme);

// Keyboard shortcuts (no search bar in the new layout — just global keys)
document.addEventListener('keydown', (e) => {
  const inField = document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA';
  if (e.key === 't' && !inField) {
    toggleTheme();
  }
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
    e.preventDefault();
    openPalette();
  }
  if (e.key === '?' && !inField) {
    e.preventDefault();
    document.getElementById('shortcuts').hidden = false;
  }
  if (e.key === 'Escape' && !document.getElementById('shortcuts').hidden) {
    document.getElementById('shortcuts').hidden = true;
  }
});
document.getElementById('shortcuts-close').addEventListener('click', () => {
  document.getElementById('shortcuts').hidden = true;
});
document.getElementById('shortcuts').addEventListener('click', (e) => {
  if (e.target === document.getElementById('shortcuts')) {
    document.getElementById('shortcuts').hidden = true;
  }
});

// ---------- Cmd-K command palette ----------
const palette = document.getElementById('palette');
const paletteInput = document.getElementById('palette-input');
const paletteResults = document.getElementById('palette-results');
let paletteIdx = 0;
let paletteItems = [];

const STATIC_PAGES = [
  { kind: 'page', label: 'Dashboard', detail: '/', url: '/' },
  { kind: 'page', label: 'Journal', detail: '/journal', url: '/journal' },
  { kind: 'page', label: 'Predictions', detail: '/predictions', url: '/predictions' },
  { kind: 'page', label: 'Routines', detail: '/routines', url: '/routines' },
];

function openPalette() {
  palette.hidden = false;
  paletteInput.value = '';
  paletteIdx = 0;
  renderPalette('');
  setTimeout(() => paletteInput.focus(), 50);
}
function closePalette() { palette.hidden = true; }
palette.addEventListener('click', (e) => { if (e.target === palette) closePalette(); });

function fuzzyScore(haystack, needle) {
  if (!needle) return 1;
  haystack = haystack.toLowerCase();
  needle = needle.toLowerCase();
  if (haystack.includes(needle)) return 100 - Math.abs(haystack.length - needle.length) * 0.1;
  // Subsequence match
  let i = 0, j = 0, score = 0;
  while (i < haystack.length && j < needle.length) {
    if (haystack[i] === needle[j]) { score += 1; j += 1; }
    i += 1;
  }
  return j === needle.length ? score : 0;
}

async function buildPaletteCorpus() {
  const items = [];
  for (const p of STATIC_PAGES) items.push(p);
  for (const p of projects || []) {
    items.push({ kind: 'project', label: p.name, detail: p.summary || p.path, url: `/project/${encodeURIComponent(p.name)}` });
  }
  // Add recent commits from /api/journal
  try {
    const r = await fetch('/api/journal?days=7');
    const data = await r.json();
    for (const e of (data.entries || []).slice(0, 50)) {
      items.push({
        kind: 'commit',
        label: e.subject,
        detail: `${e.project} · ${e.short_sha}`,
        url: commitUrlFromRemote(e.remote_url, e.sha),
      });
    }
  } catch (e) { /* ignore */ }
  return items;
}

function commitUrlFromRemote(remote, sha) {
  if (!remote) return null;
  if (remote.startsWith('git@github.com:')) {
    const path = remote.replace('git@github.com:', '').replace(/\.git$/, '');
    return `https://github.com/${path}/commit/${sha}`;
  }
  if (remote.startsWith('https://github.com/')) {
    return `${remote.replace(/\.git$/, '')}/commit/${sha}`;
  }
  return null;
}

let paletteCorpus = [];
async function ensureCorpus() {
  if (paletteCorpus.length === 0) paletteCorpus = await buildPaletteCorpus();
}

async function renderPalette(q) {
  await ensureCorpus();
  paletteItems = paletteCorpus
    .map(it => ({ it, score: fuzzyScore(it.label + ' ' + (it.detail || ''), q) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 14)
    .map(x => x.it);
  if (!paletteItems.length) {
    paletteResults.innerHTML = `<li class="muted" style="text-align:center; padding:18px">No matches.</li>`;
    return;
  }
  paletteResults.innerHTML = paletteItems.map((it, i) => `
    <li data-idx="${i}" class="${i === paletteIdx ? 'active' : ''}">
      <span class="pl-kind">${escapeHtml(it.kind)}</span>
      <span class="pl-label">${escapeHtml(it.label)}</span>
      <span class="pl-detail">${escapeHtml(it.detail || '')}</span>
    </li>
  `).join('');
  paletteResults.querySelectorAll('li[data-idx]').forEach(li => {
    li.addEventListener('mouseenter', () => {
      paletteIdx = parseInt(li.dataset.idx, 10);
      updatePaletteActive();
    });
    li.addEventListener('click', () => activatePaletteItem());
  });
}

function updatePaletteActive() {
  paletteResults.querySelectorAll('li').forEach((li, i) => li.classList.toggle('active', i === paletteIdx));
}

function activatePaletteItem() {
  const it = paletteItems[paletteIdx];
  if (!it || !it.url) { closePalette(); return; }
  if (it.url.startsWith('http')) window.open(it.url, '_blank');
  else window.location = it.url;
  closePalette();
}

paletteInput.addEventListener('input', () => {
  paletteIdx = 0;
  renderPalette(paletteInput.value.trim());
});
paletteInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closePalette(); }
  else if (e.key === 'ArrowDown') {
    e.preventDefault();
    paletteIdx = Math.min(paletteIdx + 1, paletteItems.length - 1);
    updatePaletteActive();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    paletteIdx = Math.max(paletteIdx - 1, 0);
    updatePaletteActive();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    activatePaletteItem();
  }
});

// ---- Services health row (manifest-declared ports) ----
async function loadServices() {
  try {
    const r = await fetch('/api/services');
    if (!r.ok) return;
    const data = await r.json();
    const row = document.getElementById('services-row');
    if (!row) return;
    if (!data.services || !data.services.length) { row.hidden = true; return; }
    row.hidden = false;
    row.innerHTML = data.services.map(s => {
      const dot = s.up ? 'up' : 'down';
      const primary = (s.links || []).find(l => l.primary) || (s.links || [])[0];
      const openBtn = s.up && primary
        ? `<a class="svc-open" href="${primary.href}" target="_blank" rel="noopener">open ↗</a>`
        : '';
      const startBtn = !s.up && s.can_start
        ? `<button class="svc-start" data-svc="${escapeHtml(s.name)}">start</button>`
        : '';
      return `<div class="svc ${dot}">
        <span class="svc-dot ${dot}"></span>
        <a class="svc-name" href="/project/${encodeURIComponent(s.name)}">${escapeHtml(s.name)}</a>
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
  } catch { /* network errors silenced */ }
}
loadServices();
setInterval(loadServices, 15000);
