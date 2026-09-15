const SYMBOL = decodeURIComponent(window.location.pathname.replace(/^\/ticker\//, '')).toUpperCase();
document.title = `${SYMBOL} · ticker`;
document.getElementById('ticker-symbol').textContent = SYMBOL;

let currentDays = parseInt(document.getElementById('window-select').value, 10);
let chartType = 'candle';

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function fmtNum(n) {
  if (n == null) return '—';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

function fmtAge(iso) {
  if (!iso) return '';
  const dt = new Date(iso);
  const now = Date.now();
  const s = Math.floor((now - dt.getTime()) / 1000);
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  if (s < 86400) return `${Math.floor(s/3600)}h ago`;
  return `${Math.floor(s/86400)}d ago`;
}

async function load() {
  const [tickerR, analR] = await Promise.all([
    fetch(`/api/markets/ticker/${encodeURIComponent(SYMBOL)}?days=${currentDays}`),
    fetch(`/api/markets/analytics`),
  ]);
  if (!tickerR.ok) {
    document.getElementById('ticker-summary').textContent = 'error';
    return;
  }
  const data = await tickerR.json();
  let analytics = null;
  if (analR.ok) {
    const al = await analR.json();
    analytics = (al.analytics || {})[SYMBOL] || null;
  }
  renderStats(data);
  renderPriceChart(data.series);
  renderVolumeChart(data.series);
  renderRSIChart(data.series);
  renderMACDChart(data.series);
  renderAnalytics(analytics);
  renderFilings(data.filings);
  renderNews(data.news);
  renderPredictions(data.predictions);
  const s = data.summary;
  document.getElementById('ticker-summary').textContent =
    s.last_close ? `$${s.last_close} · ${s.pct_change >= 0 ? '+' : ''}${s.pct_change}% over ${s.n_days}d` : 'no data';
}

function sma(values, window) {
  // Returns array with null for first (window-1) entries
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= window) sum -= values[i - window];
    if (i >= window - 1) out[i] = sum / window;
  }
  return out;
}

function rollingStd(values, window) {
  const out = new Array(values.length).fill(null);
  for (let i = window - 1; i < values.length; i++) {
    let mean = 0;
    for (let j = i - window + 1; j <= i; j++) mean += values[j];
    mean /= window;
    let varSum = 0;
    for (let j = i - window + 1; j <= i; j++) varSum += (values[j] - mean) ** 2;
    out[i] = Math.sqrt(varSum / window);
  }
  return out;
}

function ema(values, window) {
  const out = new Array(values.length).fill(null);
  if (values.length === 0) return out;
  const k = 2 / (window + 1);
  let prev = values[0];
  out[0] = prev;
  for (let i = 1; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function computeMACD(closes) {
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const macd = closes.map((_, i) => (ema12[i] != null && ema26[i] != null) ? ema12[i] - ema26[i] : null);
  const macdValid = macd.filter(v => v != null);
  const signalValid = ema(macdValid, 9);
  // Reattach to original index positions
  const signal = new Array(macd.length).fill(null);
  let j = 0;
  for (let i = 0; i < macd.length; i++) {
    if (macd[i] != null) {
      signal[i] = signalValid[j];
      j++;
    }
  }
  const hist = macd.map((m, i) => (m != null && signal[i] != null) ? m - signal[i] : null);
  return { macd, signal, hist };
}

function computeRSI(closes, window = 14) {
  // Wilder's RSI
  const out = new Array(closes.length).fill(null);
  if (closes.length < window + 1) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= window; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  let avgGain = gain / window, avgLoss = loss / window;
  out[window] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = window + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (window - 1) + Math.max(0, d)) / window;
    avgLoss = (avgLoss * (window - 1) + Math.max(0, -d)) / window;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

function renderStats(data) {
  const s = data.summary;
  if (!s.last_close) {
    document.getElementById('ticker-stats').innerHTML = `<p class="muted">No price data for ${SYMBOL}. Run <code>python scripts/ingest_prices.py ${SYMBOL}</code>.</p>`;
    return;
  }
  const changeClass = s.pct_change >= 0 ? 'up' : 'down';
  const tiles = [
    { k: 'Last', v: `$${s.last_close}` },
    { k: `${currentDays}d change`, v: `${s.pct_change >= 0 ? '+' : ''}${s.pct_change}%`, cls: changeClass },
    { k: 'High', v: `$${s.high}` },
    { k: 'Low', v: `$${s.low}` },
    { k: 'Avg volume', v: fmtNum(s.avg_volume) },
    { k: 'Days', v: s.n_days },
    { k: 'Filings', v: data.filings.length },
    { k: 'News mentions', v: data.news.length },
  ];
  document.getElementById('ticker-stats').innerHTML = `
    <div class="ticker-tiles">
      ${tiles.map(t => `<div class="t-tile ${t.cls || ''}"><div class="k">${escapeHtml(t.k)}</div><div class="v">${escapeHtml(String(t.v))}</div></div>`).join('')}
    </div>
  `;
}

function renderPriceChart(series) {
  const svg = document.getElementById('price-chart');
  const W = 720, H = 320, pad = { l: 50, r: 16, t: 14, b: 28 };
  if (!series || series.length < 2) { svg.innerHTML = `<text x="${W/2}" y="${H/2}" text-anchor="middle" fill="#8b98ad">No data</text>`; return; }

  const yMin = Math.min(...series.map(d => d.low)) * 0.99;
  const yMax = Math.max(...series.map(d => d.high)) * 1.01;
  const xScale = (i) => pad.l + i / Math.max(1, series.length - 1) * (W - pad.l - pad.r);
  const yScale = (v) => pad.t + (1 - (v - yMin) / Math.max(0.01, yMax - yMin)) * (H - pad.t - pad.b);

  // Grid + y labels
  const grid = [];
  const ticks = 5;
  for (let i = 0; i <= ticks; i++) {
    const v = yMin + (yMax - yMin) * (i / ticks);
    const y = yScale(v);
    grid.push(`<line x1="${pad.l}" y1="${y.toFixed(1)}" x2="${W - pad.r}" y2="${y.toFixed(1)}" stroke="#233048" stroke-width="0.5"/>`);
    grid.push(`<text x="${pad.l - 6}" y="${(y + 3).toFixed(1)}" font-size="10" fill="#8b98ad" text-anchor="end">$${v.toFixed(2)}</text>`);
  }
  // X labels
  const xTicks = [];
  const stride = Math.max(1, Math.floor(series.length / 6));
  for (let i = 0; i < series.length; i += stride) {
    const x = xScale(i);
    xTicks.push(`<text x="${x.toFixed(1)}" y="${H - 8}" font-size="10" fill="#8b98ad" text-anchor="middle">${series[i].date.slice(5)}</text>`);
  }

  // Compute SMAs from the close series
  const closes = series.map(d => d.close);
  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);
  const sma200 = sma(closes, 200);
  const showBollinger = document.getElementById('bb-toggle')?.checked;
  let bbUpper = null, bbLower = null;
  if (showBollinger) {
    const std20 = rollingStd(closes, 20);
    bbUpper = sma20.map((m, i) => (m != null && std20[i] != null) ? m + 2 * std20[i] : null);
    bbLower = sma20.map((m, i) => (m != null && std20[i] != null) ? m - 2 * std20[i] : null);
  }

  function smaPath(arr, color, width = 1.2) {
    const segs = [];
    let started = false;
    for (let i = 0; i < arr.length; i++) {
      if (arr[i] == null) { started = false; continue; }
      const x = xScale(i), y = yScale(arr[i]);
      segs.push(`${started ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`);
      started = true;
    }
    return segs.length ? `<path d="${segs.join(' ')}" fill="none" stroke="${color}" stroke-width="${width}" opacity="0.85"/>` : '';
  }
  // Build the overlay layer: SMA lines (always on) + Bollinger band (toggle).
  let overlays = '';
  overlays += smaPath(sma20, '#7aa2f7', 1.2);
  overlays += smaPath(sma50, '#e0af68', 1.2);
  overlays += smaPath(sma200, '#bb9af7', 1.5);
  if (bbUpper && bbLower) {
    const upperPts = [], lowerPts = [];
    for (let i = 0; i < bbUpper.length; i++) {
      if (bbUpper[i] == null || bbLower[i] == null) continue;
      const x = xScale(i);
      upperPts.push(`${x.toFixed(1)},${yScale(bbUpper[i]).toFixed(1)}`);
      lowerPts.unshift(`${x.toFixed(1)},${yScale(bbLower[i]).toFixed(1)}`);
    }
    if (upperPts.length > 1) {
      const polyPoints = [...upperPts, ...lowerPts].join(' ');
      overlays += `<polygon points="${polyPoints}" fill="rgba(122,162,247,0.08)" stroke="none"/>`;
      overlays += smaPath(bbUpper, '#7aa2f7', 0.7);
      overlays += smaPath(bbLower, '#7aa2f7', 0.7);
    }
  }

  let body = '';
  if (chartType === 'candle') {
    // Compute candle width
    const cw = Math.max(2, (W - pad.l - pad.r) / series.length * 0.7);
    body = series.map((d, i) => {
      const x = xScale(i);
      const yo = yScale(d.open);
      const yc = yScale(d.close);
      const yh = yScale(d.high);
      const yl = yScale(d.low);
      const up = d.close >= d.open;
      const color = up ? '#9ece6a' : '#f7768e';
      const bodyTop = Math.min(yo, yc);
      const bodyHeight = Math.max(1, Math.abs(yc - yo));
      // Wick + body (sharper rendering, thicker wick)
      return `
        <line x1="${x.toFixed(1)}" y1="${yh.toFixed(1)}" x2="${x.toFixed(1)}" y2="${yl.toFixed(1)}" stroke="${color}" stroke-width="1.3" shape-rendering="crispEdges"/>
        <rect x="${(x - cw/2).toFixed(1)}" y="${bodyTop.toFixed(1)}" width="${cw.toFixed(1)}" height="${bodyHeight.toFixed(1)}" fill="${color}" stroke="${color}" stroke-width="0.5" opacity="${up ? 0.92 : 1}" shape-rendering="crispEdges">
          <title>${d.date} O:${d.open.toFixed(2)} H:${d.high.toFixed(2)} L:${d.low.toFixed(2)} C:${d.close.toFixed(2)}</title>
        </rect>
      `;
    }).join('');
  } else {
    // Line chart on close price
    const path = series.map((d, i) => {
      const x = xScale(i);
      const y = yScale(d.close);
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    const fillPath = `${path} L${xScale(series.length - 1).toFixed(1)},${(H - pad.b).toFixed(1)} L${xScale(0).toFixed(1)},${(H - pad.b).toFixed(1)} Z`;
    body = `
      <defs>
        <linearGradient id="lineFill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stop-color="#7aa2f7" stop-opacity="0.35"/>
          <stop offset="100%" stop-color="#7aa2f7" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <path d="${fillPath}" fill="url(#lineFill)"/>
      <path d="${path}" fill="none" stroke="#7aa2f7" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round" shape-rendering="geometricPrecision"/>
    `;
  }

  // SMA legend
  const smaLegend = `
    <g transform="translate(${pad.l + 6}, ${pad.t + 12})">
      <line x1="0" y1="0" x2="14" y2="0" stroke="#7aa2f7" stroke-width="1.2"/><text x="18" y="3" font-size="10" fill="#7aa2f7">SMA20</text>
      <line x1="64" y1="0" x2="78" y2="0" stroke="#e0af68" stroke-width="1.2"/><text x="82" y="3" font-size="10" fill="#e0af68">SMA50</text>
      <line x1="128" y1="0" x2="142" y2="0" stroke="#bb9af7" stroke-width="1.5"/><text x="146" y="3" font-size="10" fill="#bb9af7">SMA200</text>
    </g>`;
  svg.innerHTML = grid.join('') + body + overlays + smaLegend + xTicks.join('');
}

function renderMACDChart(series) {
  const svg = document.getElementById('macd-chart');
  if (!svg) return;
  const W = 720, H = 120, pad = { l: 50, r: 16, t: 8, b: 18 };
  if (!series || series.length < 27) { svg.innerHTML = ''; return; }
  const closes = series.map(d => d.close);
  const { macd, signal, hist } = computeMACD(closes);
  const valid = macd.map((m, i) => ({ m, s: signal[i], h: hist[i] })).filter(v => v.m != null);
  if (valid.length < 5) { svg.innerHTML = ''; return; }
  const allVals = valid.flatMap(v => [v.m || 0, v.s || 0, v.h || 0]);
  const yMax = Math.max(...allVals) * 1.1;
  const yMin = Math.min(...allVals) * 1.1;
  const range = Math.max(0.01, yMax - yMin);
  const xScale = i => pad.l + i / Math.max(1, series.length - 1) * (W - pad.l - pad.r);
  const yScale = v => pad.t + (1 - (v - yMin) / range) * (H - pad.t - pad.b);

  const y0 = yScale(0);
  const grid = `<line x1="${pad.l}" y1="${y0.toFixed(1)}" x2="${W - pad.r}" y2="${y0.toFixed(1)}" stroke="#8b98ad" stroke-width="0.5" stroke-dasharray="2,2"/>`;

  // Histogram bars
  const bw = Math.max(1, (W - pad.l - pad.r) / series.length * 0.7);
  const bars = hist.map((h, i) => {
    if (h == null) return '';
    const x = xScale(i);
    const y = yScale(h);
    const top = h >= 0 ? y : y0;
    const height = Math.abs(y - y0);
    const color = h >= 0 ? '#9ece6a' : '#f7768e';
    return `<rect x="${(x - bw/2).toFixed(1)}" y="${top.toFixed(1)}" width="${bw.toFixed(1)}" height="${height.toFixed(1)}" fill="${color}" opacity="0.4"/>`;
  }).join('');

  // MACD line + Signal line
  function pathFor(arr, color, width) {
    const segs = [];
    let started = false;
    for (let i = 0; i < arr.length; i++) {
      if (arr[i] == null) { started = false; continue; }
      const x = xScale(i), y = yScale(arr[i]);
      segs.push(`${started ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`);
      started = true;
    }
    return segs.length ? `<path d="${segs.join(' ')}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linejoin="round" stroke-linecap="round" shape-rendering="geometricPrecision"/>` : '';
  }
  const macdLine = pathFor(macd, '#7aa2f7', 1.8);
  const sigLine = pathFor(signal, '#e0af68', 1.6);

  // Last values
  const lastM = valid[valid.length - 1].m;
  const lastS = valid[valid.length - 1].s;
  const labels = `
    <text x="${pad.l + 6}" y="${pad.t + 12}" font-size="10" fill="#7aa2f7">MACD ${lastM.toFixed(2)}</text>
    <text x="${pad.l + 86}" y="${pad.t + 12}" font-size="10" fill="#e0af68">Signal ${lastS != null ? lastS.toFixed(2) : '—'}</text>
  `;

  svg.innerHTML = grid + bars + macdLine + sigLine + labels;
}

function renderRSIChart(series) {
  const svg = document.getElementById('rsi-chart');
  const W = 720, H = 100, pad = { l: 50, r: 16, t: 8, b: 18 };
  if (!series || series.length < 15) { svg.innerHTML = ''; return; }
  const closes = series.map(d => d.close);
  const rsi = computeRSI(closes, 14);
  const xScale = (i) => pad.l + i / Math.max(1, series.length - 1) * (W - pad.l - pad.r);
  const yScale = (v) => pad.t + (1 - v / 100) * (H - pad.t - pad.b);

  // Reference bands at 30 / 70
  const y30 = yScale(30), y70 = yScale(70);
  const overboughtBand = `<rect x="${pad.l}" y="${pad.t.toFixed(1)}" width="${(W - pad.l - pad.r).toFixed(1)}" height="${(y70 - pad.t).toFixed(1)}" fill="rgba(247,118,142,0.06)"/>`;
  const oversoldBand = `<rect x="${pad.l}" y="${y30.toFixed(1)}" width="${(W - pad.l - pad.r).toFixed(1)}" height="${(H - pad.b - y30).toFixed(1)}" fill="rgba(158,206,106,0.06)"/>`;
  const refLines = `
    <line x1="${pad.l}" y1="${y70}" x2="${W - pad.r}" y2="${y70}" stroke="#f7768e" stroke-dasharray="2,3" stroke-width="0.6" opacity="0.6"/>
    <line x1="${pad.l}" y1="${y30}" x2="${W - pad.r}" y2="${y30}" stroke="#9ece6a" stroke-dasharray="2,3" stroke-width="0.6" opacity="0.6"/>
    <text x="${pad.l - 6}" y="${(y70 + 3).toFixed(1)}" font-size="10" fill="#8b98ad" text-anchor="end">70</text>
    <text x="${pad.l - 6}" y="${(y30 + 3).toFixed(1)}" font-size="10" fill="#8b98ad" text-anchor="end">30</text>
    <text x="${pad.l - 6}" y="${(yScale(50) + 3).toFixed(1)}" font-size="10" fill="#8b98ad" text-anchor="end">50</text>
  `;

  const segs = [];
  let started = false;
  for (let i = 0; i < rsi.length; i++) {
    if (rsi[i] == null) { started = false; continue; }
    const x = xScale(i), y = yScale(rsi[i]);
    segs.push(`${started ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`);
    started = true;
  }
  const path = segs.length ? `<path d="${segs.join(' ')}" fill="none" stroke="#7aa2f7" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" shape-rendering="geometricPrecision"/>` : '';
  // Last value label
  const lastIdx = rsi.length - 1;
  const lastVal = rsi[lastIdx];
  const lastLabel = lastVal != null
    ? `<circle cx="${xScale(lastIdx).toFixed(1)}" cy="${yScale(lastVal).toFixed(1)}" r="3" fill="${lastVal > 70 ? '#f7768e' : lastVal < 30 ? '#9ece6a' : '#7aa2f7'}"/>
       <text x="${(xScale(lastIdx) + 6).toFixed(1)}" y="${(yScale(lastVal) + 3).toFixed(1)}" font-size="11" fill="${lastVal > 70 ? '#f7768e' : lastVal < 30 ? '#9ece6a' : '#7aa2f7'}" font-weight="600">${lastVal.toFixed(0)}</text>`
    : '';
  svg.innerHTML = overboughtBand + oversoldBand + refLines + path + lastLabel;
}

function renderAnalytics(a) {
  if (!a) return;
  document.getElementById('analytics-panel').hidden = false;
  const ddCls = (a.current_drawdown || 0) < -10 ? 'down' : '';
  const tiles = [
    { k: 'Sharpe', v: a.sharpe != null ? a.sharpe.toFixed(2) : '—' },
    { k: 'Ann. vol', v: a.annualized_volatility != null ? a.annualized_volatility.toFixed(0) + '%' : '—' },
    { k: 'Beta', v: a.beta_vs_watchlist != null ? a.beta_vs_watchlist.toFixed(2) : '—' },
    { k: 'RSI(14)', v: a.rsi14 != null ? a.rsi14.toFixed(0) : '—' },
    { k: '1m', v: a.returns_1m != null ? `${a.returns_1m >= 0 ? '+' : ''}${a.returns_1m.toFixed(1)}%` : '—', cls: (a.returns_1m || 0) >= 0 ? 'up' : 'down' },
    { k: '3m', v: a.returns_3m != null ? `${a.returns_3m >= 0 ? '+' : ''}${a.returns_3m.toFixed(1)}%` : '—', cls: (a.returns_3m || 0) >= 0 ? 'up' : 'down' },
    { k: '12m', v: a.returns_12m != null ? `${a.returns_12m >= 0 ? '+' : ''}${a.returns_12m.toFixed(1)}%` : '—', cls: (a.returns_12m || 0) >= 0 ? 'up' : 'down' },
    { k: 'Max DD', v: a.max_drawdown != null ? `${a.max_drawdown.toFixed(0)}%` : '—', cls: 'down' },
    { k: 'Curr DD', v: a.current_drawdown != null ? `${a.current_drawdown.toFixed(1)}%` : '—', cls: ddCls },
    { k: '52w high', v: a.high_52w != null ? `$${a.high_52w}` : '—' },
    { k: 'From 52w', v: a.distance_to_52w_high_pct != null ? `${a.distance_to_52w_high_pct.toFixed(1)}%` : '—', cls: 'down' },
  ];
  document.getElementById('analytics-tiles').innerHTML = tiles.map(t =>
    `<div class="t-tile ${t.cls || ''}"><div class="k">${escapeHtml(t.k)}</div><div class="v">${escapeHtml(String(t.v))}</div></div>`
  ).join('');
}

function renderVolumeChart(series) {
  const svg = document.getElementById('vol-chart');
  const W = 720, H = 120, pad = { l: 50, r: 16, t: 8, b: 18 };
  if (!series || series.length < 2) { svg.innerHTML = ''; return; }
  const max = Math.max(...series.map(d => d.volume)) || 1;
  const xScale = (i) => pad.l + i / Math.max(1, series.length - 1) * (W - pad.l - pad.r);
  const yScale = (v) => pad.t + (1 - v / max) * (H - pad.t - pad.b);
  const bw = Math.max(1.5, (W - pad.l - pad.r) / series.length * 0.7);
  const bars = series.map((d, i) => {
    const x = xScale(i);
    const y = yScale(d.volume);
    const h = (H - pad.b) - y;
    const up = d.close >= d.open;
    const color = up ? '#9ece6a' : '#f7768e';
    return `<rect x="${(x - bw/2).toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" fill="${color}" opacity="0.5">
      <title>${d.date} vol ${fmtNum(d.volume)}</title>
    </rect>`;
  }).join('');
  // Max label
  const labels = `
    <text x="${pad.l - 6}" y="${(yScale(max) + 3).toFixed(1)}" font-size="10" fill="#8b98ad" text-anchor="end">${fmtNum(max)}</text>
    <text x="${pad.l - 6}" y="${(yScale(0) + 3).toFixed(1)}" font-size="10" fill="#8b98ad" text-anchor="end">0</text>
  `;
  svg.innerHTML = bars + labels;
}

function renderFilings(filings) {
  const ul = document.getElementById('ticker-filings');
  if (!filings.length) { ul.innerHTML = '<li class="muted small">No filings indexed for this ticker.</li>'; return; }
  ul.innerHTML = filings.map(f => `
    <li>
      <span class="f-date">${escapeHtml(f.filing_date || '')}</span>
      <span class="f-form">${escapeHtml(f.form || '')}</span>
      <span class="f-items">${escapeHtml(f.items || '')}</span>
      ${f.url ? `<a href="${escapeHtml(f.url)}" target="_blank" rel="noopener" class="muted small">↗</a>` : ''}
    </li>`).join('');
}

function renderNews(news) {
  const ul = document.getElementById('ticker-news');
  if (!news.length) {
    ul.innerHTML = '<li class="muted small">No news mentions in the 72h window.</li>';
    return;
  }
  ul.innerHTML = news.map(n => `
    <li>
      <a href="${escapeHtml(n.url || '#')}" target="_blank" rel="noopener" class="news-title">${escapeHtml(n.title || '')}</a>
      <div class="muted small">${escapeHtml(n.feed || '')} · ${fmtAge(n.published || n.ingested_at)}</div>
    </li>`).join('');
}

function renderPredictions(preds) {
  const target = document.getElementById('ticker-predictions');
  if (!preds.length) {
    target.innerHTML = `<p class="muted small">No predictions logged on ${SYMBOL} yet. <a href="/project/markets">Log one →</a></p>`;
    return;
  }
  target.innerHTML = `<ul class="ticker-pred-list">${preds.map(p => `
    <li>
      <div class="p-head">
        <b>${escapeHtml(p.direction || '')}</b> · ${p.confidence}% · horizon ${escapeHtml(p.time_horizon || '')}
        <span class="muted small">${escapeHtml(p.id)}</span>
      </div>
      <p class="p-reason">${escapeHtml((p.reasoning || '').slice(0, 200))}${p.reasoning && p.reasoning.length > 200 ? '…' : ''}</p>
    </li>
  `).join('')}</ul>`;
}

document.getElementById('window-select').addEventListener('change', (e) => {
  currentDays = parseInt(e.target.value, 10);
  load();
});
document.querySelectorAll('.chart-type-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.chart-type-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    chartType = btn.dataset.type;
    load();
  });
});
// Re-render the price chart when Bollinger is toggled — no need to refetch.
document.getElementById('bb-toggle')?.addEventListener('change', () => {
  // We don't keep the last `series` in memory between renders, so the simplest
  // robust fix is to re-load. It's a single fetch and cached server-side.
  load();
});

load();
setInterval(load, 60000);
