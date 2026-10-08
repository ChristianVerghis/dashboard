// Live classroom — websocket-driven board, grid and tape, plus the insight
// views (classroom_insights.js): which techniques are in play, which are
// working, and which bets paid and why.

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
let running = false;
let currentSession = null;

const INSIGHT_ROOTS = {
  banner: document.getElementById('source-banner'),
  kpis: document.getElementById('kpis'),
  equity: document.getElementById('equity'),
  scoreboard: document.getElementById('scoreboard'),
  bets: document.getElementById('bets'),
};

function ensureGridCell(student) {
  let entry = STUDENT_CELLS.get(student.name);
  if (entry) return entry;
  const grid = document.getElementById('student-grid');
  const cell = document.createElement('div');
  cell.className = 'st-cell';
  cell.dataset.name = student.name;
  cell.title = `${student.name}\n${student.technique}`;
  const nm = document.createElement('div');
  nm.className = 'st-cell-name';
  nm.textContent = initials(student.name);
  const pnl = document.createElement('div');
  pnl.className = 'st-cell-pnl';
  pnl.textContent = `${(student.pnl_pct || 0).toFixed(2)}%`;
  cell.append(nm, pnl);
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
  if (parts.length >= 3) return (parts[1][0] + parts[2][0]).toUpperCase();
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
    entry.cell.classList.toggle('has-open', s.open_positions > 0);
  }
}

// A replay can emit hundreds of events a second. Tape rows are buffered and
// flushed four times a second (only the newest 30 survive anyway), the grid
// refetch is coalesced to at most once a second, and board charts redraw at
// most once per frame — the old per-event fetch exhausted the browser.
const tapeBuffer = [];
let tapeTimer = null;
function addTapeEntry(parts, title) {
  tapeBuffer.push([parts, title]);
  if (tapeBuffer.length > 30) tapeBuffer.splice(0, tapeBuffer.length - 30);
  if (!tapeTimer) tapeTimer = setTimeout(flushTape, 250);
}

function flushTape() {
  tapeTimer = null;
  const list = document.getElementById('tape-list');
  const rows = tapeBuffer.splice(0);
  for (const [parts, title] of rows) {
    const li = document.createElement('li');
    if (title) li.title = title;
    for (const [cls, text, color] of parts) {
      const sp = document.createElement('span');
      if (cls) sp.className = cls;
      if (color) { sp.style.color = color; sp.style.fontWeight = '600'; }
      sp.textContent = text;
      li.appendChild(sp);
    }
    list.prepend(li);
  }
  while (list.children.length > 30) list.removeChild(list.lastChild);
}

let gridTimer = null;
function scheduleGrid(delay = 1000) {
  if (gridTimer) return;
  gridTimer = setTimeout(() => { gridTimer = null; refreshGrid(); }, delay);
}

const dirtySymbols = new Set();
let boardFrame = null;
function scheduleBoard(symbol) {
  dirtySymbols.add(symbol);
  if (boardFrame) return;
  boardFrame = requestAnimationFrame(() => {
    boardFrame = null;
    for (const s of dirtySymbols) redrawBoardChart(s);
    dirtySymbols.clear();
  });
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
  scheduleBoard(symbol);
}

function ensureBoardChart(symbol) {
  const wrap = document.getElementById('board-charts');
  const card = document.createElement('div');
  card.className = 'board-chart';
  card.dataset.symbol = symbol;
  card.innerHTML = `
    <div class="board-chart-head">
      <span class="board-chart-symbol"></span>
      <span class="board-chart-price">—</span>
    </div>
    <svg class="board-chart-svg" viewBox="0 0 200 60" preserveAspectRatio="none"></svg>
  `;
  card.querySelector('.board-chart-symbol').textContent = symbol;
  wrap.appendChild(card);
}

function redrawBoardChart(symbol) {
  const card = document.querySelector(`.board-chart[data-symbol="${CSS.escape(symbol)}"]`);
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

async function refreshInsights() {
  try {
    const r = await fetch('/api/classroom/live/insights');
    if (!r.ok) return;
    const d = await r.json();
    if (!d.session) {
      Insights.render({ banner: INSIGHT_ROOTS.banner }, { session: null, summary: {} });
      return;
    }
    Insights.render(INSIGHT_ROOTS, d, { sessionId: d.session.session_id });
    const firing = (d.techniques || []).filter(t => t.bets > 0).length;
    document.getElementById('tech-meta').textContent =
      `${firing} of ${(d.techniques || []).length} techniques have fired · ${d.running ? 'live' : 'session ended'}`;
  } catch (e) {
    console.error('insights', e);
  }
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
        rg.label === 'trending_up' || rg.label === 'trending_down' ? 'momentum armed'
          : rg.label === 'reverting' || rg.label === 'random' ? 'mean-revert armed'
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
      return `
        <li class="tb-row tb-${kind}" data-name="${escapeHtml(s.name)}">
          <span class="tb-initials">${escapeHtml(initials(s.name))}</span>
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

function sessionBadge(s) {
  if (s.is_synthetic) return ['synthetic', 'var(--warn)'];
  if (s.provider === 'yfinance') return ['replay', 'var(--accent)'];
  if (s.provider === 'alpaca') return ['live', 'var(--accent-2)'];
  if (s.is_synthetic === false) return ['real data', 'var(--accent)'];
  return ['?', 'var(--muted)'];
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
    const ul = document.createElement('ul');
    ul.className = 'sessions-ul';
    for (const s of d.sessions) {
      const li = document.createElement('li');
      const [badge, color] = sessionBadge(s);
      const b = document.createElement('span');
      b.className = 'vchip muted';
      b.style.color = color;
      b.textContent = badge;
      const a = document.createElement('a');
      a.href = `/classroom/live/sessions/${encodeURIComponent(s.session_id)}`;
      a.className = 'sessions-link';
      const code = document.createElement('code');
      code.textContent = s.session_id;
      a.appendChild(code);
      const info = document.createElement('span');
      const syms = (s.symbols || []).join(' ');
      const win = s.replay_start ? ` · ${Viz.fmtTime(s.replay_start, true)} → ${Viz.fmtTime(s.replay_end, true)}` : '';
      info.textContent = `${s.universe ? s.universe + ' · ' : ''}${syms}${win} · ${s.prediction_count.toLocaleString()} preds · ${s.resolution_count.toLocaleString()} resos`;
      li.append(b, a, info);
      ul.appendChild(li);
    }
    target.replaceChildren(ul);
  } catch {}
}

async function refreshStatus() {
  try {
    const r = await fetch('/api/classroom/live/status');
    const d = await r.json();
    running = !!d.running;
    document.getElementById('start-btn').disabled = d.running;
    document.getElementById('stop-btn').disabled = !d.running;
    if (d.session_id) document.getElementById('session-id').textContent = d.session_id;
    document.getElementById('bar-count').textContent = `bars: ${(d.bar_count || 0).toLocaleString()}`;
    document.getElementById('pred-count').textContent = `preds: ${(d.prediction_count || 0).toLocaleString()}`;
    document.getElementById('reso-count').textContent = `resos: ${(d.resolution_count || 0).toLocaleString()}`;
    if (d.symbols) document.getElementById('board-symbols').textContent = d.symbols.join(' · ');
    const cohortEl = document.getElementById('cohort-size');
    if (cohortEl) {
      cohortEl.textContent = d.n_students != null
        ? `${d.n_students}${d.n_strategies ? ` (${d.n_strategies} distinct strategies)` : ''}` : '—';
    }
    if (d.last_error) showMsg(`Last session stopped with an error: ${d.last_error.error}`);
    if (d.running && !connected) connectWS();
    if (d.session_id && d.session_id !== currentSession) {
      currentSession = d.session_id;
      refreshInsights();
    }
  } catch {}
}

function showMsg(text) {
  const el = document.getElementById('start-msg');
  el.textContent = text || '';
  el.hidden = !text;
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
      handleEvent(JSON.parse(ev.data));
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
    const up = msg.direction === 'up';
    addTapeEntry([
      ['tape-time', new Date().toLocaleTimeString()],
      [null, up ? '↑' : '↓', up ? 'var(--accent-2)' : 'var(--bad)'],
      ['tape-symbol', msg.symbol],
      ['tape-text', `@${msg.entry.toFixed(2)} · conf ${msg.confidence}${msg.regime ? ' · ' + msg.regime : ''}`],
      ['tape-meta', msg.technique],
    ], msg.reasoning || '');
    return;
  }
  if (msg.type === 'resolution') {
    const ok = msg.correct;
    const raw = msg.raw_return_bps != null ? `${msg.raw_return_bps >= 0 ? '+' : ''}${msg.raw_return_bps.toFixed(1)} bps` : '';
    addTapeEntry([
      ['tape-time', new Date().toLocaleTimeString()],
      [null, ok ? '✓' : '✗', ok ? 'var(--accent-2)' : 'var(--bad)'],
      ['tape-symbol', msg.symbol],
      ['tape-text', `${raw} · ${(msg.exit_reason || '').replace('_', ' ')}${msg.bars_held ? ` · ${msg.bars_held} bars` : ''}`],
      ['tape-meta', msg.technique || msg.student.split('-').slice(1, 3).join(' ')],
    ]);
    scheduleGrid();
  }
}

async function openStudent(name) {
  const modal = document.getElementById('student-modal');
  const body = document.getElementById('student-modal-body');
  modal.hidden = false;
  document.getElementById('student-modal-name').textContent = name;
  body.textContent = 'loading…';
  try {
    const r = await fetch(`/api/classroom/live/student/${encodeURIComponent(name)}`);
    if (!r.ok) {
      body.textContent = `not found (HTTP ${r.status})`;
      return;
    }
    const d = await r.json();
    const sc = d.session_score || d.score || {};
    const life = d.lifetime_score;
    const recent = (d.recent_predictions || []).slice().reverse();
    const opens = d.open_positions || [];
    const hitRate = sc.hit_rate != null ? (sc.hit_rate * 100).toFixed(1) + '%' : '—';
    const pnl = sc.total_pnl_pct || 0;
    body.innerHTML = `
      <div class="st-detail-stats">
        <div><div class="muted small">Technique</div><div>${escapeHtml(sc.technique || '')}</div></div>
        <div><div class="muted small">Params</div><div><code>${escapeHtml(JSON.stringify(sc.technique_params || {}))}</code></div></div>
        <div><div class="muted small">This session</div><div>${sc.total_resolved || 0} resolved (${sc.total_correct || 0} right, hit ${hitRate})</div></div>
        <div><div class="muted small">Session paper P&L</div><div style="color:${pnl >= 0 ? 'var(--accent-2)' : 'var(--bad)'}">${pnl.toFixed(3)}%</div></div>
        <div><div class="muted small">Streak</div><div>${sc.current_streak || 0} (best ${sc.best_streak || 0})</div></div>
        <div><div class="muted small">Lifetime</div><div>${life ? `${life.total_resolved || 0} resolved · ${(life.total_pnl_pct || 0).toFixed(3)}%` : 'not persisted (replay / synthetic sessions stay in their session folder)'}</div></div>
      </div>
      <h4 style="margin:14px 0 6px 0; font-size:12px; letter-spacing:0.04em; text-transform:uppercase; color:var(--muted)">Open positions (${opens.length})</h4>
      <ul class="st-detail-list" id="st-opens"></ul>
      <h4 style="margin:14px 0 6px 0; font-size:12px; letter-spacing:0.04em; text-transform:uppercase; color:var(--muted)">Recent calls (${recent.length})</h4>
      <ul class="st-detail-list" id="st-recent"></ul>
    `;
    const fill = (id, rows, render) => {
      const ul = body.querySelector(id);
      if (!rows.length) { ul.innerHTML = '<li class="muted small">none</li>'; return; }
      for (const p of rows) ul.appendChild(render(p));
    };
    fill('#st-opens', opens, p => {
      const li = document.createElement('li');
      li.title = p.reasoning || '';
      li.innerHTML = `<span class="${p.direction === 'up' ? 'good' : 'bad'}">${p.direction === 'up' ? '↑' : '↓'}</span><span class="st-symbol"></span><span class="muted small"></span>`;
      li.children[1].textContent = p.symbol;
      li.children[2].textContent = `@${p.entry_price.toFixed(2)} · conf ${p.confidence} · ${p.horizon}`;
      return li;
    });
    fill('#st-recent', recent.slice(0, 12), p => {
      const li = document.createElement('li');
      li.title = p.reasoning || '';
      const mark = p.correct === true ? ['good', '✓'] : p.correct === false ? ['bad', '✗'] : ['muted', '○'];
      li.innerHTML = `<span class="${mark[0]}">${mark[1]}</span><span class="st-symbol"></span><span class="muted small"></span>`;
      li.children[1].textContent = p.symbol;
      const raw = p.raw_return_bps != null ? `${p.raw_return_bps >= 0 ? '+' : ''}${p.raw_return_bps.toFixed(1)} bps` : (p.status === 'open' ? 'open' : '—');
      li.children[2].textContent = `${p.direction} ${p.horizon} · ${raw}${p.exit_reason ? ' · ' + p.exit_reason.replace('_', ' ') : ''}`;
      return li;
    });
  } catch (e) {
    body.textContent = `error: ${e.message}`;
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

function syncControls() {
  const provider = document.getElementById('provider-select').value;
  document.getElementById('scenario-select').disabled = provider !== 'mock';
  document.getElementById('speed-select').disabled = provider !== 'yfinance';
}
document.getElementById('provider-select').addEventListener('change', syncControls);
syncControls();

document.getElementById('start-btn').addEventListener('click', async () => {
  const provider = document.getElementById('provider-select').value;
  const scenario = document.getElementById('scenario-select').value;
  const universe = document.getElementById('universe-select').value;
  const symbols = UNIVERSES[universe] || UNIVERSES.SPX;
  const slippage_bps = parseFloat(document.getElementById('slippage-select').value) || 0;
  const replay_speed = provider === 'yfinance' ? parseFloat(document.getElementById('speed-select').value) : null;
  showMsg('');
  if (provider === 'alpaca') {
    const c = await fetch('/api/classroom/live/alpaca_check').then(r => r.json()).catch(() => null);
    if (c && !c.ready) {
      showMsg(`Alpaca isn't ready — ${c.next_step}. Keys present: ${c.keys_present}; alpaca-py installed: ${c.package_installed}.`);
      return;
    }
  }
  const r = await fetch('/api/classroom/live/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, scenario, symbols, universe, slippage_bps, replay_speed }),
  });
  const d = await r.json();
  if (!r.ok) {
    showMsg(`Start failed: ${JSON.stringify(d)}`);
    return;
  }
  STUDENT_CELLS.clear();
  document.getElementById('student-grid').replaceChildren();
  SYMBOL_SERIES.clear();
  document.getElementById('board-charts').replaceChildren();
  await refreshStatus();
  refreshInsights();
});

document.getElementById('stop-btn').addEventListener('click', async () => {
  await fetch('/api/classroom/live/stop', { method: 'POST' });
  if (socket) { socket.close(); socket = null; }
  await refreshStatus();
  refreshInsights();
  refreshSessions();
});

refreshStatus();
refreshGrid();
refreshInsights();
refreshTopBottom();
refreshRegimes();
refreshSessions();
setInterval(refreshStatus, 5000);
setInterval(refreshGrid, 10000);
setInterval(() => { if (running) refreshInsights(); }, 5000);
setInterval(() => { if (running) refreshTopBottom(); }, 7000);
setInterval(() => { if (running) refreshRegimes(); }, 4000);
setInterval(refreshSessions, 30000);
