function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function fmtAge(iso) {
  if (!iso) return '';
  const dt = new Date(iso);
  const now = Date.now();
  const seconds = Math.floor((now - dt.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds/60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds/3600)}h ago`;
  return `${Math.floor(seconds/86400)}d ago`;
}

function statusOf(p) {
  if (p.outcome) {
    return p.outcome.correct ? 'correct' : 'wrong';
  }
  return p.status === 'open' ? 'open' : (p.status || 'open');
}

function statusBadge(p) {
  const s = statusOf(p);
  const cls = s === 'correct' ? 'good' : s === 'wrong' ? 'bad' : 'muted-pill';
  return `<span class="pill ${cls}">${escapeHtml(s)}</span>`;
}

function renderBuckets(buckets, overall) {
  const entries = Object.entries(buckets).filter(([_, v]) => v.total > 0);
  if (!entries.length) {
    document.getElementById('calibration-panel').hidden = true;
    return;
  }
  document.getElementById('calibration-panel').hidden = false;
  const html = entries.map(([range, v]) => {
    const rate = v.total > 0 ? Math.round(v.correct / v.total * 100) : 0;
    const target = parseInt(range.split('-')[0], 10) + 5;
    const delta = rate - target;
    const flag = Math.abs(delta) < 5 ? 'calibrated' : (delta < 0 ? 'overconfident' : 'underconfident');
    const brier = v.brier != null ? v.brier.toFixed(3) : '—';
    return `
      <div class="bucket">
        <div class="bucket-range">${escapeHtml(range)}%</div>
        <div class="bucket-rate">${rate}%</div>
        <div class="bucket-detail muted small">${v.correct}/${v.total} · brier ${brier} · ${flag}</div>
      </div>
    `;
  }).join('');
  let head = '';
  if (overall.overall_brier != null) {
    head = `<p class="muted small" style="margin:0 0 12px">Overall Brier: <b>${overall.overall_brier.toFixed(3)}</b> across ${overall.overall_n} resolved · 0.25 is pure coin flip · lower is better</p>`;
  }
  document.getElementById('buckets').innerHTML = head + `<div class="bucket-grid">${html}</div>`;
}

function renderGrid(preds) {
  const grid = document.getElementById('pred-grid');
  if (!preds.length) {
    grid.innerHTML = `
      <div class="panel" style="padding: 36px; text-align: center;">
        <p class="muted">No predictions logged yet.</p>
        <p class="muted small">Open <a href="/project/markets">markets</a> and click <code>+ Log prediction</code>, or run <code>python scripts/log_prediction.py</code> in the markets folder.</p>
      </div>`;
    return;
  }
  grid.innerHTML = preds.map(p => `
    <div class="pred-card">
      <div class="pred-head">
        <div class="pred-title">
          <span class="pred-ticker">${escapeHtml(p.ticker)}</span>
          <span class="muted small">${escapeHtml(p.direction)}</span>
        </div>
        ${statusBadge(p)}
      </div>
      <div class="pred-meta">
        <span><b>${escapeHtml(String(p.confidence))}%</b> · horizon ${escapeHtml(p.time_horizon)}</span>
        <span class="muted small">${fmtAge(p.created_at)}</span>
      </div>
      <p class="pred-reasoning">${escapeHtml((p.reasoning || '').slice(0, 240))}${(p.reasoning || '').length > 240 ? '…' : ''}</p>
      ${(p.invalidation_conditions || []).length ? `
        <details class="pred-inval">
          <summary>Invalidation conditions (${p.invalidation_conditions.length})</summary>
          <ul>${p.invalidation_conditions.map(c => `<li>${escapeHtml(c)}</li>`).join('')}</ul>
        </details>` : ''}
      <div class="pred-id muted small">${escapeHtml(p.id)}</div>
    </div>
  `).join('');
}

let reliabilityDemo = false;

async function loadReliability() {
  try {
    const r = await fetch(`/api/markets/reliability${reliabilityDemo ? '?demo=true' : ''}`);
    if (!r.ok) return;
    const data = await r.json();
    const panel = document.getElementById('reliability-panel');
    if (!data.bins.length) { panel.hidden = true; return; }
    panel.hidden = false;
    document.getElementById('reliability-summary').textContent =
      `${data.total} resolved across ${data.bins.length} bins${data.demo ? ' · demo data' : ''}`;
    renderReliability(data);
  } catch { /* ignore */ }
}

function renderReliability(data) {
  const svg = document.getElementById('reliability-chart');
  const W = 480, H = 480, pad = { l: 56, r: 16, t: 14, b: 50 };
  const xScale = v => pad.l + (v - 50) / 50 * (W - pad.l - pad.r);
  const yScale = v => pad.t + (1 - v / 100) * (H - pad.t - pad.b);

  // Grid + axis labels
  const grid = [];
  for (const v of [50, 60, 70, 80, 90, 100]) {
    const x = xScale(v), y = yScale(v);
    grid.push(`<line x1="${x}" y1="${pad.t}" x2="${x}" y2="${H - pad.b}" stroke="#233048" stroke-width="0.4"/>`);
    grid.push(`<line x1="${pad.l}" y1="${y}" x2="${W - pad.r}" y2="${y}" stroke="#233048" stroke-width="0.4"/>`);
    grid.push(`<text x="${x}" y="${H - pad.b + 14}" font-size="10" fill="#8b98ad" text-anchor="middle">${v}%</text>`);
    grid.push(`<text x="${pad.l - 6}" y="${(y + 3).toFixed(1)}" font-size="10" fill="#8b98ad" text-anchor="end">${v}%</text>`);
  }
  // Diagonal (perfect calibration)
  const x1 = xScale(50), y1 = yScale(50), x2 = xScale(100), y2 = yScale(100);
  const diagonal = `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#9ece6a" stroke-width="1" stroke-dasharray="4,4" opacity="0.6"/>`;

  // Dots
  const maxN = Math.max(...data.bins.map(b => b.n), 1);
  const dots = data.bins.map(b => {
    const x = xScale(b.midpoint);
    const y = yScale(b.hit_rate);
    const r = 4 + Math.sqrt(b.n / maxN) * 16;
    const delta = b.hit_rate - b.midpoint;
    const color = Math.abs(delta) < 5 ? '#9ece6a' : (delta < 0 ? '#f7768e' : '#7aa2f7');
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" fill="${color}" fill-opacity="0.5" stroke="${color}" stroke-width="1.5">
      <title>${b.bin_lo}-${b.bin_hi}%: ${b.correct || Math.round(b.n * b.hit_rate / 100)}/${b.n} = ${b.hit_rate}% hit rate (Δ ${delta.toFixed(1)})</title>
    </circle>`;
  }).join('');

  // Axis titles
  const labels = `
    <text x="${(W) / 2}" y="${H - 8}" font-size="12" fill="#8b98ad" text-anchor="middle">Forecast confidence</text>
    <text x="14" y="${H/2}" font-size="12" fill="#8b98ad" text-anchor="middle" transform="rotate(-90, 14, ${H/2})">Observed hit rate</text>
  `;
  // Legend
  const legend = `
    <g transform="translate(${W - pad.r - 130}, ${pad.t + 10})">
      <text x="0" y="0" font-size="10" fill="#8b98ad">Δ vs diagonal:</text>
      <circle cx="6" cy="14" r="4" fill="#9ece6a"/><text x="14" y="17" font-size="10" fill="#e6edf3">|Δ| &lt; 5</text>
      <circle cx="6" cy="30" r="4" fill="#7aa2f7"/><text x="14" y="33" font-size="10" fill="#e6edf3">under-confident</text>
      <circle cx="6" cy="46" r="4" fill="#f7768e"/><text x="14" y="49" font-size="10" fill="#e6edf3">over-confident</text>
    </g>
  `;
  svg.innerHTML = grid.join('') + diagonal + dots + labels + legend;
}

document.getElementById('reliability-demo').addEventListener('change', (e) => {
  reliabilityDemo = e.target.checked;
  loadReliability();
});

async function load() {
  const r = await fetch('/api/predictions');
  const data = await r.json();
  document.getElementById('pred-count').textContent = `${data.predictions.length} total · ${data.outcomes.length} resolved`;
  renderBuckets(data.buckets, data);
  renderGrid(data.predictions);
  loadReliability();
}

load();
setInterval(load, 15000);
