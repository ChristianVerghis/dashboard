function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function projectColor(name) {
  // Stable hash-ish color per project
  const palette = ['#7aa2f7', '#9ece6a', '#e0af68', '#bb9af7', '#7dcfff', '#f7768e'];
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) | 0;
  return palette[Math.abs(h) % palette.length];
}

function fmtTime(iso) {
  const dt = new Date(iso);
  return dt.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function commitUrl(remote, sha) {
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

function groupByHour(entries) {
  const groups = new Map();
  for (const e of entries) {
    const dt = new Date(e.iso);
    const hourKey = dt.toISOString().slice(0, 13);
    if (!groups.has(hourKey)) {
      groups.set(hourKey, { dt, label: dt.toLocaleString('en-US', {
        weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric',
      }), entries: [] });
    }
    groups.get(hourKey).entries.push(e);
  }
  return [...groups.values()];
}

function renderEntry(e) {
  const url = commitUrl(e.remote_url, e.sha);
  const linkBtn = url ? `<a href="${url}" target="_blank" rel="noopener" class="muted small">view ↗</a>` : '';
  const color = projectColor(e.project);
  return `
    <article class="jrnl-entry" data-project="${escapeHtml(e.project)}">
      <div class="jrnl-spine" style="background:${color}"></div>
      <div class="jrnl-body">
        <div class="jrnl-head">
          <span class="jrnl-proj" style="color:${color}">${escapeHtml(e.project)}</span>
          <span class="jrnl-sha muted small">${escapeHtml(e.short_sha)}</span>
          <span class="muted small">·</span>
          <span class="muted small">${fmtTime(e.iso)}</span>
          ${linkBtn ? `<span class="muted small">·</span> ${linkBtn}` : ''}
        </div>
        <h3 class="jrnl-subject">${escapeHtml(e.subject)}</h3>
        ${e.body ? `<pre class="jrnl-bodytext">${escapeHtml(e.body.slice(0, 800))}${e.body.length > 800 ? '\n…' : ''}</pre>` : ''}
      </div>
    </article>
  `;
}

function getQueryParam(name) {
  const u = new URL(window.location);
  return u.searchParams.get(name);
}

async function load(days, dateFilter) {
  const url = dateFilter ? `/api/journal?date=${dateFilter}` : `/api/journal?days=${days}`;
  const r = await fetch(url);
  const data = await r.json();
  const groups = groupByHour(data.entries);
  const summary = dateFilter
    ? `${data.entries.length} commits on ${dateFilter}`
    : `${data.entries.length} commits · last ${days}d`;
  document.getElementById('jrnl-summary').textContent = summary;
  const root = document.getElementById('journal');
  if (!data.entries.length) {
    root.innerHTML = `<div class="panel" style="padding:36px; text-align:center;"><p class="muted">No commits ${dateFilter ? 'on ' + dateFilter : 'in the last ' + days + ' day' + (days > 1 ? 's' : '')}.</p></div>`;
    return;
  }
  root.innerHTML = groups.map(g => `
    <section class="hour-group">
      <h2 class="hour-label">${escapeHtml(g.label)}</h2>
      <div class="hour-entries">${g.entries.map(renderEntry).join('')}</div>
    </section>
  `).join('');
}

const sel = document.getElementById('window-select');
const initialDate = getQueryParam('date');
sel.addEventListener('change', () => {
  // If user changes window selector, drop the date filter and update URL
  history.replaceState({}, '', window.location.pathname);
  load(parseInt(sel.value, 10), null);
});
if (initialDate) {
  // Add a small "back to last week" link
  const banner = document.createElement('div');
  banner.className = 'date-filter-banner';
  banner.innerHTML = `<span class="muted small">Filtered to <b>${initialDate}</b></span> <a href="/journal" class="topnav-link">show last 24h →</a>`;
  document.querySelector('main').prepend(banner);
}
load(parseInt(sel.value, 10), initialDate);
setInterval(() => load(parseInt(sel.value, 10), initialDate), 60000);

const search = document.getElementById('search-commits');
const clearBtn = document.getElementById('clear-search');
const searchPanel = document.getElementById('search-results');
let searchTimer = null;

function highlight(text, q) {
  if (!q) return escapeHtml(text);
  const escapedQ = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return escapeHtml(text).replace(new RegExp(escapedQ, 'gi'), m => `<mark>${m}</mark>`);
}

async function runSearch(q) {
  if (q.length < 2) {
    searchPanel.hidden = true;
    return;
  }
  const r = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
  const data = await r.json();
  searchPanel.hidden = false;
  document.getElementById('search-title').textContent = `Results for "${q}"`;
  const body = document.getElementById('search-body');
  if (!data.matches.length) {
    body.innerHTML = `<p class="muted">No matches in any project.</p>`;
    return;
  }
  body.innerHTML = `
    <p class="muted small">${data.total} match${data.total === 1 ? '' : 'es'}${data.total > data.matches.length ? ' (showing ' + data.matches.length + ')' : ''}</p>
    <ul class="search-list">
      ${data.matches.map(m => {
        const url = commitUrl(m.remote_url, m.sha);
        const link = url ? ` · <a href="${url}" target="_blank" rel="noopener" class="muted">↗</a>` : '';
        return `<li>
          <span class="proj-tag" style="color:${projectColor(m.project)}">${escapeHtml(m.project)}</span>
          <code class="muted small">${escapeHtml(m.short_sha)}</code>
          <span class="search-subject">${highlight(m.subject, q)}</span>
          <span class="muted small">${fmtTime(m.iso)}${link}</span>
        </li>`;
      }).join('')}
    </ul>
  `;
}

search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => runSearch(search.value.trim()), 200);
});
clearBtn.addEventListener('click', () => {
  search.value = '';
  searchPanel.hidden = true;
});
