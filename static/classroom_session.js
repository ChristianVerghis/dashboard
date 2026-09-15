// Past-session detail viewer. Reads /api/classroom/live/session/{id}.

const SESSION_ID = decodeURIComponent(window.location.pathname.replace(/^\/classroom\/live\/sessions\//, ''));
document.title = `${SESSION_ID} · session detail`;
document.getElementById('session-id-label').textContent = SESSION_ID;

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

async function load() {
  const r = await fetch(`/api/classroom/live/session/${encodeURIComponent(SESSION_ID)}`);
  if (!r.ok) {
    document.querySelector('main').innerHTML = `<section class="panel"><p class="muted">Session not found (HTTP ${r.status}).</p></section>`;
    return;
  }
  const d = await r.json();

  const summaryGrid = document.getElementById('summary-grid');
  const cards = [
    { k: 'Bars', v: d.bar_count.toLocaleString() },
    { k: 'Predictions', v: d.prediction_count.toLocaleString() },
    { k: 'Resolutions', v: d.resolution_count.toLocaleString() },
    { k: 'Open at end', v: (d.prediction_count - d.resolution_count).toLocaleString() },
    { k: 'Techniques', v: d.techniques.length },
  ];
  summaryGrid.innerHTML = cards.map(c => `
    <div class="cls-card">
      <div class="cls-card-label">${escapeHtml(c.k)}</div>
      <div class="cls-card-val">${escapeHtml(String(c.v))}</div>
    </div>
  `).join('');
  document.getElementById('summary-meta').textContent = `${d.resolution_count} of ${d.prediction_count} predictions resolved`;

  const techDetail = document.getElementById('tech-detail');
  if (d.techniques.length === 0) {
    techDetail.innerHTML = '<p class="muted small" style="padding:8px">No resolved predictions in this session.</p>';
    return;
  }
  techDetail.innerHTML = `
    <table class="tech-table-grid">
      <thead><tr>
        <th>Technique</th>
        <th class="num">Resolved</th>
        <th class="num">Correct</th>
        <th class="num">Hit rate</th>
        <th class="num">Total P&amp;L (sum)</th>
        <th class="num">Avg P&amp;L per trade</th>
      </tr></thead>
      <tbody>${d.techniques.map(t => {
        const hit = t.hit_rate != null ? (t.hit_rate * 100).toFixed(1) + '%' : '—';
        const totalPnl = t.pnl_sum != null ? t.pnl_sum : (t.avg_pnl_pct * t.resolved);
        const sumColor = totalPnl > 0 ? 'var(--accent-2)' : totalPnl < 0 ? 'var(--bad)' : 'var(--muted)';
        const avgColor = t.avg_pnl_pct > 0 ? 'var(--accent-2)' : t.avg_pnl_pct < 0 ? 'var(--bad)' : 'var(--muted)';
        return `<tr>
          <td><code>${escapeHtml(t.technique)}</code></td>
          <td class="num">${t.resolved}</td>
          <td class="num">${t.correct}</td>
          <td class="num">${hit}</td>
          <td class="num" style="color:${sumColor}; font-variant-numeric: tabular-nums">${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(3)}%</td>
          <td class="num" style="color:${avgColor}; font-variant-numeric: tabular-nums">${t.avg_pnl_pct >= 0 ? '+' : ''}${t.avg_pnl_pct.toFixed(4)}%</td>
        </tr>`;
      }).join('')}</tbody>
    </table>
  `;
}

load();
