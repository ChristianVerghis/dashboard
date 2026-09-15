function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function projectColor(name) {
  const palette = ['#7aa2f7', '#9ece6a', '#e0af68', '#bb9af7', '#7dcfff', '#f7768e'];
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) | 0;
  return palette[Math.abs(h) % palette.length];
}

function renderHero(d) {
  const days = d.days;
  const projParts = Object.entries(d.by_project)
    .filter(([_, v]) => v.commits > 0)
    .sort((a, b) => b[1].commits - a[1].commits)
    .map(([k, v]) => `<div class="hero-tile"><div class="v">${v.commits}</div><div class="k">${escapeHtml(k)}</div></div>`)
    .join('');
  const briefings = d.briefings || [];
  const briefingsList = briefings.length
    ? briefings.map(b => `<a href="https://github.com/ChristianVerghis/markets/blob/main/vault/Daily%20Briefings/${b}.md" target="_blank">${b}</a>`).join(' · ')
    : '<span class="muted">none</span>';
  document.getElementById('hero-summary').innerHTML = `
    <div class="panel-head"><h2>Last ${days}d in numbers</h2><span class="muted small">${d.busiest_project ? `busiest: ${d.busiest_project}` : ''}</span></div>
    <div class="hero-grid">
      <div class="hero-tile big"><div class="v">${d.total_commits}</div><div class="k">commits</div></div>
      <div class="hero-tile"><div class="v">${d.predictions_logged}</div><div class="k">predictions logged</div></div>
      <div class="hero-tile"><div class="v">${d.outcomes_resolved}</div><div class="k">outcomes resolved</div></div>
      <div class="hero-tile"><div class="v">${(d.briefings || []).length}</div><div class="k">briefings</div></div>
    </div>
    <div class="hero-grid" style="margin-top:14px">${projParts}</div>
    <p class="muted small" style="margin-top:14px">Briefings: ${briefingsList}</p>
  `;
}

function renderByProject(d) {
  const html = Object.entries(d.by_project)
    .filter(([_, v]) => v.commits > 0)
    .sort((a, b) => b[1].commits - a[1].commits)
    .map(([k, v]) => `
      <div class="bp-block" style="border-left-color:${projectColor(k)}">
        <div class="bp-head">
          <span class="bp-name" style="color:${projectColor(k)}">${escapeHtml(k)}</span>
          <span class="muted small">${v.commits} commit${v.commits === 1 ? '' : 's'}</span>
        </div>
        <ul class="bp-subjects">
          ${v.subjects.map(s => `<li>${escapeHtml(s)}</li>`).join('')}
          ${v.commits > v.subjects.length ? `<li class="muted small">+ ${v.commits - v.subjects.length} more</li>` : ''}
        </ul>
      </div>
    `).join('');
  document.getElementById('by-project').innerHTML = html || '<p class="muted">No commits in this period.</p>';
}

function renderMostChanged(d) {
  if (!d.most_changed_files.length) {
    document.getElementById('most-changed').innerHTML = '<p class="muted">No file activity in this period.</p>';
    return;
  }
  const max = Math.max(...d.most_changed_files.map(f => f.count));
  document.getElementById('most-changed').innerHTML = `
    <ul class="mc-list">
      ${d.most_changed_files.map(f => {
        const w = (f.count / max) * 100;
        return `<li>
          <code class="mc-path">${escapeHtml(f.path)}</code>
          <div class="mc-bar"><div style="width:${w.toFixed(0)}%"></div></div>
          <span class="muted small">${f.count}×</span>
        </li>`;
      }).join('')}
    </ul>
  `;
}

async function load() {
  const days = parseInt(document.getElementById('digest-window').value, 10);
  const r = await fetch(`/api/digest?days=${days}`);
  const data = await r.json();
  document.getElementById('digest-summary').textContent = `${data.total_commits} commits · ${data.predictions_logged} predictions logged`;
  renderHero(data);
  renderByProject(data);
  renderMostChanged(data);
  // All commits list
  const all = [];
  for (const [proj, v] of Object.entries(data.by_project)) {
    for (const s of v.subjects) all.push({ project: proj, subject: s });
  }
  document.getElementById('all-commits').innerHTML = all.map(c =>
    `<li><span class="proj-tag" style="color:${projectColor(c.project)}">${escapeHtml(c.project)}</span><span>${escapeHtml(c.subject)}</span></li>`
  ).join('');
}

document.getElementById('digest-window').addEventListener('change', load);
load();
setInterval(load, 60000);
