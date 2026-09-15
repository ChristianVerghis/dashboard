// Live classroom — websocket-driven grid + board.

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

// Map a P&L percent to a heatmap color.
// 0% -> neutral gray. Positive -> green. Negative -> red. Saturate at ±2%.
function pnlColor(pnlPct) {
  const clamped = Math.max(-2, Math.min(2, pnlPct));
  const intensity = Math.abs(clamped) / 2;
  if (clamped > 0) {
    // green: hsl(140, 60%, L) — lighter for stronger gain
    const light = 30 + intensity * 35;
    return `hsl(140, 60%, ${light}%)`;
  } else if (clamped < 0) {
    const light = 30 + intensity * 35;
    return `hsl(0, 60%, ${light}%)`;
  }
  return 'hsl(220, 5%, 28%)';
}

const STUDENT_CELLS = new Map();  // name -> {cell, last_pnl}
const SYMBOL_SERIES = new Map();  // symbol -> [{ts, close}]
const MAX_SERIES = 120;
let socket = null;
let connected = false;

function ensureGridCell(student) {
  let entry = STUDENT_CELLS.get(student.name);
  if (entry) {
    return entry;
  }
  const grid = document.getElementById('student-grid');
  const cell = document.createElement('div');
  cell.className = 'st-cell';
  cell.dataset.name = student.name;
  cell.title = `${student.name}\n${student.technique}`;
  cell.innerHTML = `
    <div class="st-cell-name">${escapeHtml(initials(student.name))}</div>
    <div class="st-cell-pnl">${(student.pnl_pct || 0).toFixed(2)}%</div>
  `;
  cell.style.background = pnlColor(student.pnl_pct || 0);
  cell.addEventListener('click', () => openStudent(student.name));
  grid.appendChild(cell);
  entry = { cell, last_pnl: student.pnl_pct || 0 };
  STUDENT_CELLS.set(student.name, entry);
  return entry;
}

function initials(name) {
  // Names look like "st-ada-kim-vwap_revert-00". Pull first letters of parts 2 and 3.
  const parts = name.split('-');
  if (parts.length >= 3) {
    return (parts[1][0] + parts[2][0]).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

function updateGrid(students) {
  for (const s of students) {
    const entry = ensureGridCell(s);
    const pnl = s.pnl_pct || 0;
    entry.cell.querySelector('.st-cell-pnl').textContent = pnl.toFixed(2) + '%';
    entry.cell.style.background = pnlColor(pnl);
    if (Math.abs(pnl - entry.last_pnl) > 0.001) {
      entry.cell.classList.add('pulse');
      setTimeout(() => entry.cell.classList.remove('pulse'), 400);
      entry.last_pnl = pnl;
    }
    if (s.open_positions > 0) {
      entry.cell.classList.add('has-open');
    } else {
      entry.cell.classList.remove('has-open');
    }
  }
}

function addTapeEntry(html) {
  const list = document.getElementById('tape-list');
  const li = document.createElement('li');
  li.innerHTML = html;
  list.prepend(li);
  while (list.children.length > 30) list.removeChild(list.lastChild);
}

function updateBoardSymbol(symbol, close, ts) {
  let series = SYMBOL_SERIES.get(symbol);
  if (!series) {
    series = [];
    SYMBOL_SERIES.set(symbol, series);
    ensureBoardChart(symbol);
  }
  series.push({ ts, close });
  if (series.length > MAX_SERIES) series.shift();
  redrawBoardChart(symbol);
}

function ensureBoardChart(symbol) {
  const wrap = document.getElementById('board-charts');
  const card = document.createElement('div');
  card.className = 'board-chart';
  card.dataset.symbol = symbol;
  card.innerHTML = `
    <div class="board-chart-head">
      <span class="board-chart-symbol">${escapeHtml(symbol)}</span>
      <span class="board-chart-price">—</span>
    </div>
    <svg class="board-chart-svg" viewBox="0 0 200 60" preserveAspectRatio="none"></svg>
  `;
  wrap.appendChild(card);
}

function redrawBoardChart(symbol) {
  const card = document.querySelector(`.board-chart[data-symbol="${symbol}"]`);
  if (!card) return;
  const series = SYMBOL_SERIES.get(symbol);
  if (!series || series.length < 2) return;
  const svg = card.querySelector('svg');
  const closes = series.map(p => p.close);
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const range = max - min || 1;
  const n = closes.length;
  const points = closes.map((c, i) => {
    const x = (i / (n - 1)) * 200;
    const y = 60 - ((c - min) / range) * 56 - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const last = closes[closes.length - 1];
  const first = closes[0];
  const color = last >= first ? 'var(--accent-2)' : 'var(--bad)';
  svg.innerHTML = `<polyline fill="none" stroke="${color}" stroke-width="1.5" points="${points}"/>`;
  card.querySelector('.board-chart-price').textContent = '$' + last.toFixed(2);
  card.querySelector('.board-chart-price').style.color = color;
}

async function refreshGrid() {
  try {
    const r = await fetch('/api/classroom/live/grid');
    if (!r.ok) return;
    const d = await r.json();
    if (d.students) updateGrid(d.students);
  } catch {}
}

async function refreshTechLeaderboard() {
  try {
    const r = await fetch('/api/classroom/live/leaderboard');
    if (!r.ok) return;
    const d = await r.json();
    const target = document.getElementById('tech-table');
    if (!target) return;
    if (!d.techniques || d.techniques.length === 0) return;
    target.innerHTML = `
      <table class="tech-table-grid">
        <thead><tr>
          <th>Technique</th>
          <th class="num">Students</th>
          <th class="num">Open</th>
          <th class="num">Resolved</th>
          <th class="num">Hit rate</th>
          <th class="num">Avg P&amp;L</th>
        </tr></thead>
        <tbody>${d.techniques.map(t => {
          const hit = t.hit_rate != null ? (t.hit_rate * 100).toFixed(1) + '%' : '—';
          const pnl = t.avg_pnl_pct;
          const color = pnl > 0 ? 'var(--accent-2)' : pnl < 0 ? 'var(--bad)' : 'var(--muted)';
          return `<tr>
            <td><code>${escapeHtml(t.technique)}</code></td>
            <td class="num">${t.students}</td>
            <td class="num">${t.open_positions}</td>
            <td class="num">${t.total_resolved}</td>
            <td class="num">${hit}</td>
            <td class="num" style="color:${color}; font-variant-numeric: tabular-nums">${pnl >= 0 ? '+' : ''}${pnl.toFixed(3)}%</td>
          </tr>`;
        }).join('')}</tbody>
      </table>
    `;
  } catch {}
}

async function refreshRegimes() {
  try {
    const r = await fetch('/api/classroom/live/regimes');
    if (!r.ok) return;
    const d = await r.json();
    const target = document.getElementById('regime-strip');
    if (!target || !d.regimes || d.regimes.length === 0) return;
    target.innerHTML = d.regimes.map(rg => {
      const color = (
        rg.label === 'trending_up' ? 'hsl(140, 60%, 45%)' :
        rg.label === 'trending_down' ? 'hsl(0, 60%, 50%)' :
        rg.label === 'reverting' ? 'hsl(220, 60%, 55%)' :
        rg.label === 'random' ? 'hsl(220, 5%, 40%)' :
        rg.label === 'warmup' ? 'hsl(40, 50%, 40%)' :
        'hsl(220, 5%, 30%)'
      );
      const driftStr = rg.drift_pct != null ? `${rg.drift_pct >= 0 ? '+' : ''}${rg.drift_pct.toFixed(2)}%` : '';
      const acStr = rg.autocorr != null ? `ac=${rg.autocorr >= 0 ? '+' : ''}${rg.autocorr.toFixed(2)}` : '';
      const techNote = (
        rg.label === 'trending_up' || rg.label === 'trending_down'
          ? 'momentum armed'
          : rg.label === 'reverting' || rg.label === 'random'
          ? 'mean-revert armed'
          : 'warmup'
      );
      return `
        <div class="regime-cell" style="border-color: ${color}">
          <div class="regime-symbol">${escapeHtml(rg.symbol)}</div>
          <div class="regime-label" style="color: ${color}">${escapeHtml(rg.label)}</div>
          <div class="regime-detail muted small">${driftStr} ${acStr}</div>
          <div class="regime-armed muted small">${techNote}</div>
        </div>
      `;
    }).join('');
  } catch {}
}

async function refreshTopBottom() {
  try {
    const r = await fetch('/api/classroom/live/top_bottom');
    if (!r.ok) return;
    const d = await r.json();
    const target = document.getElementById('top-bottom-body');
    if (!target) return;
    if ((!d.top || d.top.length === 0) && (!d.bottom || d.bottom.length === 0)) return;
    const renderRow = (s, kind) => {
      const color = s.pnl_pct >= 0 ? 'var(--accent-2)' : 'var(--bad)';
      const sign = s.pnl_pct >= 0 ? '+' : '';
      const initials = (() => {
        const parts = s.name.split('-');
        return parts.length >= 3 ? (parts[1][0] + parts[2][0]).toUpperCase() : s.name.slice(0, 2).toUpperCase();
      })();
      return `
        <li class="tb-row tb-${kind}" data-name="${escapeHtml(s.name)}">
          <span class="tb-initials">${initials}</span>
          <span class="tb-name">${escapeHtml(s.name.split('-').slice(1, 3).join(' '))}</span>
          <span class="tb-tech muted small">${escapeHtml(s.technique)}</span>
          <span class="tb-resos muted small">${s.resolved}r · ${s.correct}w</span>
          <span class="tb-pnl" style="color:${color}">${sign}${s.pnl_pct.toFixed(3)}%</span>
        </li>`;
    };
    target.innerHTML = `
      <div class="tb-col">
        <h4 class="tb-head">★ Top ${d.top.length}</h4>
        <ul class="tb-list">${d.top.map(s => renderRow(s, 'top')).join('')}</ul>
      </div>
      <div class="tb-col">
        <h4 class="tb-head">↓ Bottom ${d.bottom.length}</h4>
        <ul class="tb-list">${d.bottom.map(s => renderRow(s, 'bottom')).join('')}</ul>
      </div>
    `;
    target.querySelectorAll('.tb-row').forEach(row => {
      row.addEventListener('click', () => openStudent(row.dataset.name));
    });
  } catch {}
}

async function refreshSessions() {
  try {
    const r = await fetch('/api/classroom/live/sessions');
    if (!r.ok) return;
    const d = await r.json();
    const target = document.getElementById('sessions-list');
    if (!target) return;
    document.getElementById('sessions-count').textContent = `${d.sessions.length} captured`;
    if (!d.sessions.length) {
      target.innerHTML = '<p>No past sessions yet. Start one to capture artifacts.</p>';
      return;
    }
    target.innerHTML = `
      <ul class="sessions-ul">
        ${d.sessions.map(s => `
          <li>
            <a href="/classroom/live/sessions/${encodeURIComponent(s.session_id)}" class="sessions-link">
              <code>${escapeHtml(s.session_id)}</code>
            </a>
            <span class="muted">·</span>
            <span>${s.bar_count} bars</span>
            <span class="muted">·</span>
            <span>${s.prediction_count} preds</span>
            <span class="muted">·</span>
            <span>${s.resolution_count} resos</span>
          </li>`).join('')}
      </ul>
    `;
  } catch {}
}

async function refreshStatus() {
  try {
    const r = await fetch('/api/classroom/live/status');
    const d = await r.json();
    document.getElementById('start-btn').disabled = d.running;
    document.getElementById('stop-btn').disabled = !d.running;
    if (d.session_id) {
      document.getElementById('session-id').textContent = d.session_id;
    }
    document.getElementById('bar-count').textContent = `bars: ${d.bar_count || 0}`;
    document.getElementById('pred-count').textContent = `preds: ${d.prediction_count || 0}`;
    document.getElementById('reso-count').textContent = `resos: ${d.resolution_count || 0}`;
    if (d.symbols) {
      document.getElementById('board-symbols').textContent = d.symbols.join(' · ');
    }
    const cohortEl = document.getElementById('cohort-size');
    if (cohortEl) {
      cohortEl.textContent = d.n_students != null ? d.n_students : '—';
    }
    if (d.running && !connected) {
      connectWS();
    }
  } catch {}
}

function connectWS() {
  if (socket) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  socket = new WebSocket(`${proto}://${location.host}/ws/classroom/live`);
  socket.onopen = () => { connected = true; document.getElementById('provider-label').textContent = 'ws: connected'; };
  socket.onclose = () => { connected = false; socket = null; document.getElementById('provider-label').textContent = 'ws: closed'; };
  socket.onerror = () => { document.getElementById('provider-label').textContent = 'ws: error'; };
  socket.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      handleEvent(msg);
    } catch (e) {
      console.error('bad ws message', e);
    }
  };
}

function handleEvent(msg) {
  if (msg.type === 'grid') {
    updateGrid(msg.data.students || []);
    return;
  }
  if (msg.type === 'bar') {
    updateBoardSymbol(msg.symbol, msg.close, msg.ts);
    return;
  }
  if (msg.type === 'prediction') {
    const sign = msg.direction === 'up' ? '↑' : '↓';
    const color = msg.direction === 'up' ? 'var(--accent-2)' : 'var(--bad)';
    addTapeEntry(`
      <span class="tape-time">${new Date().toLocaleTimeString()}</span>
      <span style="color:${color}; font-weight:600">${sign}</span>
      <span class="tape-symbol">${escapeHtml(msg.symbol)}</span>
      <span class="tape-text">@${msg.entry.toFixed(2)} · conf ${msg.confidence}</span>
      <span class="tape-meta">${escapeHtml(msg.technique)}</span>
    `);
    return;
  }
  if (msg.type === 'resolution') {
    const ok = msg.correct;
    const color = ok ? 'var(--accent-2)' : 'var(--bad)';
    const pnl = msg.pnl_pct >= 0 ? '+' : '';
    addTapeEntry(`
      <span class="tape-time">${new Date().toLocaleTimeString()}</span>
      <span style="color:${color}; font-weight:600">${ok ? '✓' : '✗'}</span>
      <span class="tape-symbol">${escapeHtml(msg.symbol)}</span>
      <span class="tape-text">${pnl}${msg.pnl_pct.toFixed(3)}% · ${escapeHtml(msg.exit_reason || '')}</span>
      <span class="tape-meta">${escapeHtml(msg.student.split('-').slice(1, 3).join(' '))}</span>
    `);
    // Update the student cell — fresh resolution probably moved their P&L
    setTimeout(refreshGrid, 100);
    return;
  }
}

async function openStudent(name) {
  document.getElementById('student-modal').hidden = false;
  document.getElementById('student-modal-name').textContent = name;
  document.getElementById('student-modal-body').innerHTML = 'loading…';
  try {
    const r = await fetch(`/api/classroom/live/student/${encodeURIComponent(name)}`);
    if (!r.ok) {
      document.getElementById('student-modal-body').innerHTML = `<p class="muted">not found (HTTP ${r.status})</p>`;
      return;
    }
    const d = await r.json();
    const sc = d.score || {};
    const recent = (d.recent_predictions || []).slice().reverse();
    const opens = d.open_positions || [];
    const hitRate = sc.hit_rate != null ? (sc.hit_rate * 100).toFixed(1) + '%' : '—';
    document.getElementById('student-modal-body').innerHTML = `
      <div class="st-detail-stats">
        <div><div class="muted small">Technique</div><div>${escapeHtml(sc.technique || '')}</div></div>
        <div><div class="muted small">Params</div><div><code>${escapeHtml(JSON.stringify(sc.technique_params || {}))}</code></div></div>
        <div><div class="muted small">Resolved</div><div>${sc.total_resolved || 0} (${sc.total_correct || 0} correct, hit ${hitRate})</div></div>
        <div><div class="muted small">Paper P&L</div><div style="color:${(sc.total_pnl_pct||0) >= 0 ? 'var(--accent-2)' : 'var(--bad)'}">${(sc.total_pnl_pct || 0).toFixed(3)}%</div></div>
        <div><div class="muted small">Capital</div><div>$${(sc.current_capital || 0).toFixed(0)}</div></div>
        <div><div class="muted small">Streak</div><div>${sc.current_streak || 0} (best ${sc.best_streak || 0})</div></div>
      </div>
      <h4 style="margin:14px 0 6px 0; font-size:12px; letter-spacing:0.04em; text-transform:uppercase; color:var(--muted)">Open positions (${opens.length})</h4>
      ${opens.length ? `<ul class="st-detail-list">${opens.map(p => `
        <li>
          <span class="${p.direction === 'up' ? 'good' : 'bad'}">${p.direction === 'up' ? '↑' : '↓'}</span>
          <span class="st-symbol">${escapeHtml(p.symbol)}</span>
          <span class="muted small">@${p.entry_price.toFixed(2)} · conf ${p.confidence} · ${escapeHtml(p.horizon)}</span>
        </li>`).join('')}</ul>` : '<p class="muted small">none</p>'}
      <h4 style="margin:14px 0 6px 0; font-size:12px; letter-spacing:0.04em; text-transform:uppercase; color:var(--muted)">Recent (${recent.length})</h4>
      ${recent.length ? `<ul class="st-detail-list">${recent.slice(0, 10).map(p => `
        <li>
          <span class="${p.correct === true ? 'good' : p.correct === false ? 'bad' : 'muted'}">${p.correct === true ? '✓' : p.correct === false ? '✗' : '○'}</span>
          <span class="st-symbol">${escapeHtml(p.symbol)}</span>
          <span class="muted small">${p.direction} ${p.horizon} · pnl ${p.pnl_pct != null ? (p.pnl_pct).toFixed(3) + '%' : '—'}</span>
        </li>`).join('')}</ul>` : '<p class="muted small">none</p>'}
    `;
  } catch (e) {
    document.getElementById('student-modal-body').innerHTML = `<p class="muted">error: ${escapeHtml(e.message)}</p>`;
  }
}

document.getElementById('student-modal-close').addEventListener('click', () => {
  document.getElementById('student-modal').hidden = true;
});

const UNIVERSES = {
  EV: ['TSLA', 'RIVN', 'LCID', 'F', 'NIO'],
  SPX: ['SPY', 'QQQ', 'AAPL', 'MSFT', 'NVDA'],
  DEF: ['JNJ', 'PG', 'KO', 'WMT', 'V'],
  SEMI: ['AMD', 'AVGO', 'MU', 'INTC', 'TSM'],
  FIN: ['JPM', 'BAC', 'GS', 'MA', 'AXP'],
};

document.getElementById('start-btn').addEventListener('click', async () => {
  const provider = document.getElementById('provider-select').value;
  const scenario = document.getElementById('scenario-select').value;
  const universeKey = document.getElementById('universe-select').value;
  const symbols = UNIVERSES[universeKey] || UNIVERSES.EV;
  if (provider === 'alpaca') {
    const c = await fetch('/api/classroom/live/alpaca_check').then(r => r.json()).catch(() => null);
    if (c && !c.ready) {
      alert(`Alpaca not ready — ${c.next_step}.\n\nKeys present: ${c.keys_present}\nalpaca-py installed: ${c.package_installed}`);
      return;
    }
  }
  const r = await fetch('/api/classroom/live/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, scenario, symbols }),
  });
  const d = await r.json();
  if (!r.ok) {
    alert(`Start failed: ${JSON.stringify(d)}`);
    return;
  }
  await refreshStatus();
});

document.getElementById('stop-btn').addEventListener('click', async () => {
  await fetch('/api/classroom/live/stop', { method: 'POST' });
  if (socket) { socket.close(); socket = null; }
  await refreshStatus();
});

refreshStatus();
refreshGrid();
refreshTechLeaderboard();
refreshTopBottom();
refreshRegimes();
refreshSessions();
setInterval(refreshStatus, 5000);
setInterval(refreshGrid, 10000);
setInterval(refreshTechLeaderboard, 5000);
setInterval(refreshTopBottom, 7000);
setInterval(refreshRegimes, 4000);
setInterval(refreshSessions, 30000);
