function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function fmtCountdown(s) {
  if (s == null) return '—';
  const abs = Math.abs(s);
  const sign = s < 0 ? '-' : '';
  const d = Math.floor(abs / 86400);
  const h = Math.floor((abs % 86400) / 3600);
  const m = Math.floor((abs % 3600) / 60);
  const sec = abs % 60;
  if (d > 0) return `${sign}${d}d ${h}h ${m}m`;
  if (h > 0) return `${sign}${h}h ${m}m ${sec}s`;
  if (m > 0) return `${sign}${m}m ${sec}s`;
  return `${sign}${sec}s`;
}

// Track each routine's next-fire absolute time so we can tick the countdown
// every second locally without re-polling the API.
const fireTimesById = new Map();

function statusPill(r) {
  if (r.status === 'DISABLED_BY_SYSTEM') return `<span class="pill bad">DISABLED · ${escapeHtml(r.ended_reason || 'unknown')}</span>`;
  if (r.status && r.status.startsWith('WILL_FAIL')) return `<span class="pill warn">${escapeHtml(r.status)}</span>`;
  if (r.enabled === false) return `<span class="pill muted-pill">disabled</span>`;
  return `<span class="pill good">enabled</span>`;
}

function renderRoutine(r) {
  if (r.next_run_at) {
    fireTimesById.set(r.id, new Date(r.next_run_at).getTime());
  }
  return `
    <div class="routine-card ${r.status === 'DISABLED_BY_SYSTEM' ? 'is-disabled' : ''}" data-id="${escapeHtml(r.id)}">
      <div class="routine-head">
        <div>
          <div class="routine-name">${escapeHtml(r.name)}</div>
          <div class="routine-cron muted small">${escapeHtml(r.cron_human || r.cron || '')} · ${escapeHtml(r.model)}</div>
        </div>
        ${statusPill(r)}
      </div>
      <p class="routine-purpose muted">${escapeHtml(r.purpose || '')}</p>
      <div class="routine-stats">
        <div class="metric"><div class="k">Next fire</div><div class="v countdown" data-fire="${r.next_run_at || ''}">${r.next_run_at ? fmtCountdown(r.seconds_until_fire) : '—'}</div></div>
        <div class="metric"><div class="k">Cron</div><div class="v"><code>${escapeHtml(r.cron || '—')}</code></div></div>
        <div class="metric"><div class="k">Project</div><div class="v">${escapeHtml(r.project)}</div></div>
        <div class="metric"><div class="k">Model</div><div class="v">${escapeHtml((r.model || '').replace('claude-', ''))}</div></div>
      </div>
      <div class="routine-id muted small">id: <code>${escapeHtml(r.id)}</code></div>
    </div>
  `;
}

// Tick countdowns every second locally — no API call needed.
function tickCountdowns() {
  document.querySelectorAll('.countdown').forEach(el => {
    const fire = el.dataset.fire;
    if (!fire) return;
    const now = Date.now();
    const target = new Date(fire).getTime();
    const seconds = Math.floor((target - now) / 1000);
    el.textContent = fmtCountdown(seconds);
  });
}
setInterval(tickCountdowns, 1000);

async function load() {
  const r = await fetch('/api/routines').then(x => x.json());
  document.getElementById('captured-at').textContent = `snapshot ${r.captured_at}`;
  document.getElementById('now-label').textContent = `now ${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}`;

  const alertSection = document.getElementById('alert');
  if (r.stale) {
    alertSection.hidden = false;
    alertSection.classList.add('alert-panel');
    const age = r.stale.age_days != null ? `${Math.round(r.stale.age_days)} days old` : 'of unknown age';
    alertSection.innerHTML = `
      <div class="alert-head">
        <span class="alert-level">⚠ STALE</span>
        <span class="alert-title">This snapshot is ${escapeHtml(age)} — every countdown below is wrong</span>
      </div>
      <p class="muted">Re-capture <code>data/routines_snapshot.json</code> from claude.ai/code/routines to make this page truthful.</p>
    `;
  } else if (r.alert) {
    alertSection.hidden = false;
    alertSection.classList.add('alert-panel');
    alertSection.innerHTML = `
      <div class="alert-head">
        <span class="alert-level">⚠ ${escapeHtml(r.alert.level || 'warn').toUpperCase()}</span>
        <span class="alert-title">${escapeHtml(r.alert.title)}</span>
      </div>
      <p class="muted">${escapeHtml(r.alert.detail || '')}</p>
    `;
  }

  const grid = document.getElementById('grid');
  grid.innerHTML = (r.routines || []).map(renderRoutine).join('');
}

load();
setInterval(load, 5000);
