// Market map — the whole market around the EV watchlist. Reads
// /api/markets/map and /api/markets/series (markets/scripts/market_map.py).
'use strict';

const STATE_COLORS = {
  'risk-on': '--viz-good', mixed: '--viz-warn', 'risk-off': '--viz-serious', stress: '--viz-bad',
};
const SHORT = {
  SPY: 'S&P 500', QQQ: 'Nasdaq', IWM: 'R2000', EEM: 'EM', TLT: 'Long Tsy', HYG: 'HY credit',
  'GC=F': 'Gold', 'CL=F': 'Oil', 'DX-Y.NYB': 'Dollar', 'BTC-USD': 'Bitcoin', '^VIX': 'VIX', 'EV basket': 'EV basket',
};

function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k === 'style') e.setAttribute('style', v);
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    e.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
  }
  return e;
}

const pctTxt = (v, d = 2) => (v == null || !isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(d)}%`);

function moveTxt(m, key) {
  const kind = m.kind || 'price';
  if (kind === 'price') return pctTxt(m[`r_${key}`]);
  const v = m[`chg_${key}`];
  if (v == null) return '—';
  return kind === 'yield' ? `${v > 0 ? '+' : ''}${v.toFixed(0)} bp` : `${v > 0 ? '+' : ''}${v.toFixed(1)}`;
}

function moveVal(m, key) {
  return (m.kind || 'price') === 'price' ? m[`r_${key}`] : m[`chg_${key}`];
}

function levelTxt(m) {
  const v = m.last;
  if (v == null) return '';
  if (m.kind === 'yield') return `${v.toFixed(2)}%`;
  if (m.kind === 'vol') return v.toFixed(1);
  return v >= 1000 ? v.toLocaleString(undefined, { maximumFractionDigits: 0 }) : v >= 1 ? v.toFixed(2) : v.toFixed(4);
}

function signCls(v) { return v > 0 ? 'num-good' : v < 0 ? 'num-bad' : ''; }

// ---------------------------------------------------------------- regime
function renderRegime(mm) {
  const rg = mm.regime || {};
  const root = document.getElementById('regime');
  const color = Viz.css(STATE_COLORS[rg.label] || '--muted');
  const wk = rg.week_ago;
  const hero = h('div', { class: 'regime-hero' },
    h('div', null,
      h('div', { class: 'big', style: `color:${color}`, text: rg.label || '—' }),
      h('div', { class: 'score', text: `score ${rg.score > 0 ? '+' : ''}${(rg.score || 0).toFixed(2)} · ${rg.positive}↑ ${rg.negative}↓ of ${rg.n} signals` })),
    h('div', { class: 'mm-note', style: 'max-width:520px' },
      wk ? `A week ago (${Viz.fmtDate(wk.date)}): ${wk.label} (${wk.score > 0 ? '+' : ''}${wk.score.toFixed(2)}). ` : '',
      `Session ${Viz.fmtDate(mm.session_date)}. Each signal is +1, 0 or −1 against the rule in its tooltip; the label is their mean.`));
  const list = h('ul', { class: 'signal-list' }, (rg.components || []).map(c => {
    const cls = c.signal > 0 ? 'up' : c.signal < 0 ? 'down' : 'flat';
    const icon = c.signal > 0 ? '↑' : c.signal < 0 ? '↓' : '·';
    const word = c.signal > 0 ? 'risk-on' : c.signal < 0 ? 'risk-off' : 'neutral';
    return h('li', { title: `Rule: ${c.rule}` },
      h('span', { class: `sig ${cls}`, 'aria-label': word, text: icon }),
      h('span', { class: 'sig-name', text: c.label }),
      h('span', { class: 'sig-text', text: c.text }));
  }));
  // History strip: one cell per session, state-colored, with a legend.
  const hist = rg.history || [];
  const strip = h('div', { class: 'regime-strip2', role: 'img', 'aria-label': 'regime by session, last six months' });
  for (const d of hist) {
    const cell = h('span', { tabindex: 0 });
    cell.style.background = Viz.css(STATE_COLORS[d.label] || '--muted');
    const show = (x, y) => Viz.showTip(x, y, Viz.fmtDate(d.date), [{ value: d.label, name: `score ${d.score > 0 ? '+' : ''}${d.score.toFixed(2)}` }]);
    cell.addEventListener('pointermove', ev => show(ev.clientX, ev.clientY));
    cell.addEventListener('pointerleave', Viz.hideTip);
    cell.addEventListener('focus', () => { const b = cell.getBoundingClientRect(); show(b.right, b.top); });
    cell.addEventListener('blur', Viz.hideTip);
    strip.appendChild(cell);
  }
  const legend = h('div', { class: 'viz-legend', style: 'margin-top:6px' },
    Object.entries(STATE_COLORS).map(([k, v]) => {
      const i = h('i', { class: 'box' });
      i.style.background = Viz.css(v);
      return h('span', null, i, k);
    }),
    h('span', { text: hist.length ? `${Viz.fmtDate(hist[0].date)} → ${Viz.fmtDate(hist[hist.length - 1].date)}` : '' }));
  root.replaceChildren(hero, list, strip, legend);
}

// ---------------------------------------------------------------- charts
function rebased(vals) {
  const first = vals.find(v => v != null && isFinite(v));
  return first ? vals.map(v => (v == null ? null : (v / first) * 100)) : vals;
}

function renderCharts(mm, ser) {
  const dates = ser.dates || [];
  const S = ser.series || {};
  const xFmt = d => Viz.fmtMonth(d);
  const tipHead = d => Viz.fmtDate(d);
  const evSeries = [
    ['EV basket', 'EV watchlist (equal-weight)', 'EV', '--viz-1'],
    ['SPY', 'S&P 500', 'S&P', '--viz-2'],
    ['QQQ', 'Nasdaq 100', 'Nasdaq', '--viz-3'],
    ['DRIV', 'Autonomous & EV ETF (DRIV)', 'DRIV', '--viz-4'],
  ].filter(([k]) => S[k]).map(([k, name, short, c]) => {
    const values = rebased(S[k]);
    const last = [...values].reverse().find(v => v != null);
    return { name, color: Viz.css(c), values, endLabel: last == null ? short : `${short} ${last.toFixed(0)}` };
  });
  Viz.lineChart(document.getElementById('ev-chart'), {
    title: 'EV watchlist vs market, indexed to 100', x: dates, series: evSeries, height: 250,
    yFmt: v => v.toFixed(0), xFmt, tipHead, zero: 100, empty: 'No series yet — run market_map.py.',
  });
  const b = ((mm.ev_vs_market || {}).basket) || {};
  const spy = (mm.symbols || {}).SPY || {};
  document.getElementById('ev-note').textContent = b.r_1y != null
    ? `Over the year the equal-weight watchlist moved ${pctTxt(b.r_1y, 1)} vs the S&P 500's ${pctTxt(spy.r_1y, 1)}, with β ${b.beta_spy} to the S&P (correlation ${b.corr_spy}). ${b.n} names, equal weight, daily rebalanced.`
    : '';

  Viz.lineChart(document.getElementById('rates-chart'), {
    title: 'Treasury yields', x: dates, height: 150,
    series: [
      S['^TNX'] && { name: '10-year Treasury', color: Viz.css('--viz-1'), values: S['^TNX'], endLabel: `10y ${(S['^TNX'].filter(v => v != null).slice(-1)[0] || 0).toFixed(2)}%` },
      S['^IRX'] && { name: '3-month T-bill', color: Viz.css('--viz-2'), values: S['^IRX'], endLabel: `3m ${(S['^IRX'].filter(v => v != null).slice(-1)[0] || 0).toFixed(2)}%` },
    ].filter(Boolean),
    yFmt: v => `${v.toFixed(2)}%`, xFmt, tipHead,
  });
  const vixBox = document.getElementById('vix-chart');
  Viz.lineChart(vixBox, {
    title: 'VIX', x: dates, height: 110, legend: false,
    series: S['^VIX'] ? [{ name: 'VIX', color: Viz.css('--viz-1'), values: S['^VIX'] }] : [],
    yFmt: v => v.toFixed(0), xFmt, tipHead,
  });
}

// ---------------------------------------------------------------- heat table
function renderHeat(mm) {
  const table = document.getElementById('heat');
  const syms = mm.symbols || {};
  const cols = [['1d', '1d'], ['1w', '1w'], ['1m', '1m'], ['3m', '3m'], ['ytd', 'YTD']];
  // One color scale per (kind, column): % moves, bp and vol points don't share a ruler.
  const scale = {};
  for (const m of Object.values(syms)) {
    for (const [k] of cols) {
      const v = moveVal(m, k);
      if (v == null) continue;
      const key = `${m.kind}:${k}`;
      (scale[key] = scale[key] || []).push(Math.abs(v));
    }
  }
  for (const key of Object.keys(scale)) {
    const xs = scale[key].sort((a, b) => a - b);
    scale[key] = xs[Math.floor(xs.length * 0.9)] || xs[xs.length - 1] || 1;
  }
  const head = h('thead', null, h('tr', null,
    h('th', { text: 'asset' }), h('th', { text: 'level' }), cols.map(([, l]) => h('th', { text: l })), h('th', { style: 'text-transform:none', text: 'σ today' })));
  const body = h('tbody');
  for (const g of mm.groups || []) {
    const members = g.symbols.filter(s => syms[s]);
    if (!members.length) continue;
    body.appendChild(h('tr', { class: 'grp' }, h('td', { colspan: cols.length + 3, text: g.label })));
    for (const s of members) {
      const m = syms[s];
      const row = h('tr', null,
        h('td', null, m.name, h('span', { class: 'sym', text: s })),
        h('td', { text: levelTxt(m) }));
      for (const [k] of cols) {
        const v = moveVal(m, k);
        const td = h('td', { class: 'cell', text: moveTxt(m, k) });
        td.style.background = Viz.divColor(v, scale[`${m.kind}:${k}`]);
        row.appendChild(td);
      }
      const z = m.z_1d;
      const zt = h('td', { text: z == null ? '' : `${z > 0 ? '+' : ''}${z.toFixed(1)}` });
      if (z != null && Math.abs(z) >= 2) zt.style.fontWeight = '700';
      row.appendChild(zt);
      body.appendChild(row);
    }
  }
  const ev = ((mm.ev_vs_market || {}).basket) || {};
  if (ev.r_1d != null) {
    body.appendChild(h('tr', { class: 'grp' }, h('td', { colspan: cols.length + 3, text: 'Your watchlist' })));
    const row = h('tr', null, h('td', null, 'EV watchlist (equal-weight)', h('span', { class: 'sym', text: `${ev.n} names` })), h('td', { text: '' }));
    for (const [k] of cols) {
      const v = ev[`r_${k}`];
      const td = h('td', { class: 'cell', text: pctTxt(v) });
      td.style.background = Viz.divColor(v, scale[`price:${k}`]);
      row.appendChild(td);
    }
    row.appendChild(h('td', { text: '' }));
    body.appendChild(row);
  }
  table.replaceChildren(head, body);
}

// ---------------------------------------------------------------- rotation
function renderRotation(mm) {
  const rot = mm.rotation || {};
  const pts = (rot.sectors || []).map(r => ({
    x: r.rs_3m, y: r.rs_1m, label: r.symbol, title: r.name,
    tip: [['1m vs S&P', pctTxt(r.rs_1m, 1).replace('%', ' pts')], ['3m vs S&P', pctTxt(r.rs_3m, 1).replace('%', ' pts')],
          ['today', pctTxt(r.r_1d)], ['quadrant', r.quadrant]],
  }));
  Viz.scatter(document.getElementById('rotation'), {
    title: 'Sector rotation', points: pts, height: 300,
    xLabel: '3-month return vs S&P 500 (pts) →',
    quadrants: { tr: 'leading', tl: 'improving', br: 'weakening', bl: 'lagging' },
  });
  const themes = (rot.themes || []).slice();
  document.getElementById('rotation-note').textContent = themes.length
    ? 'Vertical: 1-month return vs the S&P. Themes over 1m — ' + themes.map(t => `${t.name} ${pctTxt(t.rs_1m, 1).replace('%', '')} (${t.quadrant})`).join(' · ') + '.'
    : '';
}

// ---------------------------------------------------------------- movers
function divbar(v, max) {
  const wrap = h('div', { class: 'divbar', role: 'img', 'aria-label': `${v.toFixed(1)} sigma` });
  const w = Math.min(1, Math.abs(v) / max) * 50;
  const b = h('b');
  b.style.width = `${w}%`;
  b.style.left = v >= 0 ? '50%' : `${50 - w}%`;
  b.style.background = `rgba(${Viz.css(v >= 0 ? '--viz-up' : '--viz-down')}, 0.9)`;
  wrap.appendChild(b);
  return wrap;
}

function renderMovers(mm) {
  const mv = mm.movers || {};
  const list = document.getElementById('sigma');
  const rows = (mv.sigma || []).slice(0, 10);
  list.replaceChildren(...rows.map(x => h('li', null,
    h('span', null, x.name, h('span', { class: 'sym', text: ` ${x.symbol}` })),
    h('span', { class: `tnum ${signCls(x.move)}`, style: 'text-align:right',
      text: x.unit === '%' ? pctTxt(x.move) : x.unit === 'bp' ? `${x.move > 0 ? '+' : ''}${x.move.toFixed(0)} bp` : `${x.move > 0 ? '+' : ''}${x.move.toFixed(1)} pts` }),
    h('span', { style: 'display:grid;grid-template-columns:1fr 44px;gap:6px;align-items:center' },
      divbar(x.z, 4), h('span', { class: 'tnum', style: 'text-align:right', text: `${x.z > 0 ? '+' : ''}${x.z.toFixed(1)}σ` })))));
  const f = arr => (arr || []).map(x => `${x.name} ${pctTxt(x.r_1m, 1)}`).join(', ');
  document.getElementById('leaders').textContent = mv.leaders_1m
    ? `Over 1 month — leaders: ${f(mv.leaders_1m)}. Laggards: ${f(mv.laggards_1m)}.` : '';
}

// ---------------------------------------------------------------- watchlist
function renderWatchlist(mm) {
  const ev = mm.ev_vs_market || {};
  const rows = ev.tickers || [];
  const table = document.getElementById('wl');
  const maxRes = Math.max(2, ...rows.map(r => Math.abs(r.residual_1d || 0)));
  const head = h('thead', null, h('tr', null,
    ['Ticker', 'Group', 'Benchmark', 'Beta', 'Corr', '1d', 'Expected', 'Stock-specific', '1m', '1m vs S&P']
      .map((c, i) => h('th', { class: i >= 3 && i !== 7 ? 'num' : null, text: c }))));
  const body = h('tbody', null, rows.map(r => h('tr', null,
    h('td', null, h('a', { class: 'tk', href: `/ticker/${encodeURIComponent(r.ticker)}`, text: r.ticker })),
    h('td', { class: 'sb-sub', text: (r.group || '').replace(/_/g, ' ') }),
    h('td', { class: 'sb-sub', title: r.ref === 'SPY' ? '' : `tracks ${r.ref_name} better than the S&P 500 (corr ${r.corr_ref} vs ${r.corr_spy})`,
      text: r.ref === 'SPY' || !r.ref ? 'S&P 500' : `${r.ref_name} (${r.ref})` }),
    h('td', { class: 'num tnum', text: (r.beta_ref ?? r.beta_spy) == null ? '—' : (r.beta_ref ?? r.beta_spy).toFixed(2) }),
    h('td', { class: 'num tnum', text: (r.corr_ref ?? r.corr_spy) == null ? '—' : (r.corr_ref ?? r.corr_spy).toFixed(2) }),
    h('td', { class: `num tnum ${signCls(r.r_1d)}`, text: pctTxt(r.r_1d) }),
    h('td', { class: 'num tnum', text: pctTxt(r.expected_1d) }),
    h('td', null, r.residual_1d == null ? '—' : h('span', { style: 'display:grid;grid-template-columns:110px 60px;gap:8px;align-items:center' },
      divbar(r.residual_1d, maxRes), h('span', { class: `tnum ${signCls(r.residual_1d)}`, style: 'text-align:right', text: pctTxt(r.residual_1d, 1) }))),
    h('td', { class: `num tnum ${signCls(r.r_1m)}`, text: pctTxt(r.r_1m, 1) }),
    h('td', { class: `num tnum ${signCls(r.rel_1m_spy)}`, text: pctTxt(r.rel_1m_spy, 1).replace('%', ' pts') }),
  )));
  table.replaceChildren(head, body);
}

// ---------------------------------------------------------------- correlation
function renderCorr(mm) {
  const c = mm.correlations || {};
  const labels = (c.assets || []).filter(a => c.matrix && c.matrix[a]);
  Viz.heatmap(document.getElementById('corr'), {
    title: 'cross-asset correlation', labels: labels.map(a => SHORT[a] || a), cell: 30, labelWidth: 74,
    value: (i, j) => (c.matrix[labels[i]] || {})[labels[j]],
  });
  const sb = c.stock_bond;
  document.getElementById('stock-bond').textContent = sb
    ? `Stocks vs long Treasuries: ${sb.current > 0 ? '+' : ''}${sb.current.toFixed(2)} (1y range ${sb.min_1y.toFixed(2)} to ${sb.max_1y.toFixed(2)}) — ${sb.read}. Strong cells are labelled; hover any cell for its value.`
    : '';
}

function renderMethod(mm) {
  const rg = mm.regime || {};
  const ev = mm.ev_vs_market || {};
  document.getElementById('method').replaceChildren(
    h('p', null, h('strong', { text: 'Universe. ' }), `${mm.symbols_with_data} of ${mm.universe_size} benchmarks with data — indices, sectors, themes, factors, megacaps, yields, credit, FX, commodities, volatility, crypto and international (markets/config/market_universe.yml). Context, not a watchlist: predictions stay on the EV names.`),
    h('p', null, h('strong', { text: 'Regime. ' }), rg.method || ''),
    h('p', null, h('strong', { text: 'Watchlist vs market. ' }), ev.method || ''),
    h('p', null, h('strong', { text: 'Source. ' }), `${mm.source || ''}. Generated ${Viz.fmtTime(mm.generated_at, true)}; refreshed by the markets launchd job (01:30, 04:30, 18:45 ET).`),
    (mm.stale_quotes || []).length ? h('p', null, h('strong', { text: 'Stale quotes. ' }), mm.stale_quotes.join(', ')) : null,
  );
}

async function load() {
  const asof = document.getElementById('mm-asof');
  let mm, ser;
  try {
    [mm, ser] = await Promise.all([
      fetch('/api/markets/map').then(r => r.json()),
      fetch('/api/markets/series').then(r => r.json()),
    ]);
  } catch (e) {
    asof.textContent = `could not load (${e.message})`;
    return;
  }
  if (mm.missing) {
    asof.textContent = 'no market map yet';
    document.getElementById('mm-root').replaceChildren(h('section', { class: 'panel mm-missing' },
      h('p', { text: 'The market map hasn\'t been generated on this machine yet.' }),
      h('p', null, 'Run the markets project\'s ', h('code', { text: 'refresh-market-map' }),
        ' action (', h('code', { text: 'ingest_market.py' }), ' + ', h('code', { text: 'market_map.py' }),
        '), or wait for the next scheduled refresh.')));
    return;
  }
  asof.textContent = `session ${Viz.fmtDate(mm.session_date)} · ${mm.symbols_with_data} benchmarks`;
  renderRegime(mm);
  renderCharts(mm, ser || {});
  renderHeat(mm);
  renderRotation(mm);
  renderMovers(mm);
  renderWatchlist(mm);
  renderCorr(mm);
  renderMethod(mm);
}

load();
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(load, 250);
});
