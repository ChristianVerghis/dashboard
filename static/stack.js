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

function projectIcon(name) {
  const parts = name.split(/[-_\s]+/).filter(Boolean);
  let initials;
  if (parts.length >= 2) initials = (parts[0][0] + parts[1][0]).toUpperCase();
  else initials = name.slice(0, 2).toUpperCase();
  const color = projectColor(name);
  return `<span class="proj-icon" style="background:${color}1a; color:${color}; border-color:${color}40">${escapeHtml(initials)}</span>`;
}

async function load() {
  const r = await fetch('/api/stack');
  const data = await r.json();
  document.getElementById('stack-count').textContent = `${data.projects.length} projects`;
  const root = document.getElementById('stack-grid');
  root.innerHTML = data.projects.map(p => {
    const insights = (p.insights || []).slice(0, 6).map(i =>
      `<div class="stack-insight"><div class="k">${escapeHtml(i.label)}</div><div class="v">${escapeHtml(i.value)}</div></div>`
    ).join('');
    const cap = p.capabilities && window.marked
      ? marked.parse(p.capabilities)
      : `<p class="muted small">No CAPABILITIES.md yet — drop one in the project root.</p>`;
    const fwBadge = p.framework
      ? `<span class="fw-badge ${frameworkClass(p.framework)}">${escapeHtml(p.framework)}</span>`
      : '';
    return `
      <article class="stack-col" data-name="${escapeHtml(p.name)}">
        <header>
          <h2>${projectIcon(p.name)} <a href="/project/${encodeURIComponent(p.name)}">${escapeHtml(p.name)}</a> ${fwBadge}</h2>
          <span class="badge ${p.momentum}">${p.momentum}</span>
        </header>
        <p class="stack-summary">${escapeHtml(p.summary || '')}</p>
        ${insights ? `<div class="stack-insights">${insights}</div>` : ''}
        <div class="md">${cap}</div>
      </article>
    `;
  }).join('');
}

function frameworkClass(fw) {
  const map = {
    'Next.js': 'badge-react', 'React': 'badge-react', 'Vite': 'badge-react',
    'Node': 'badge-node', 'Python': 'badge-python', 'FastAPI': 'badge-python',
    'Rust': 'badge-rust', 'Go': 'badge-go', 'Vault': 'badge-vault',
  };
  return map[fw] || 'badge-other';
}

load();
setInterval(load, 60000);
