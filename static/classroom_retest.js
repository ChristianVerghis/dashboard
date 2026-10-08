// Track record — the short-term cohort's weekly re-test. Each completed week is
// replayed on the current engine (classroom/shortterm/scripts/weekly_retest.py);
// a technique only counts as working if it holds up week after week.
// Data: /api/classroom/retest.
'use strict';

const PERSIST = {
  'persistent edge': { cls: 'good', icon: '✓' },
  'persistent loser': { cls: 'bad', icon: '✕' },
  'no persistent edge': { cls: 'warn', icon: '~' },
  'need more weeks': { cls: 'muted', icon: '…' },
};
const WEEK_ICON = { working: '✓', failing: '✕', unproven: '~', early: '…', idle: '○' };
const MIN_BETS = 10;
let DATA = null;
let TAB = null;
let FOCUS = null;   // technique highlighted from the matrix

function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k === 'style') e.setAttribute('style', v);
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    e.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
  }
  return e;
}

const bps = (v, d = 2) => (v == null || !isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(d)}`);
const tTxt = v => (v == null || !isFinite(v) ? '—' : Math.abs(v) >= 20 ? (v > 0 ? '>20' : '<−20') : v.toFixed(1));

function chip(verdict, title) {
  const v = PERSIST[verdict] || PERSIST['need more weeks'];
  return h('span', { class: `vchip ${v.cls}`, title }, h('span', { 'aria-hidden': 'true', text: v.icon }), verdict);
}

function scaleOf(values) {
  const xs = values.filter(v => v != null && isFinite(v)).map(Math.abs).sort((a, b) => a - b);
  if (!xs.length) return 1;
  return Math.max(0.5, xs[Math.floor(xs.length * 0.85)] || xs[xs.length - 1]);
}

function weekLabel(w) {
  return w.replace(/^\d{4}-/, '');
}

function windowText(d, w) {
  const win = (d.windows || {})[w];
  if (!win) return w;
  const end = new Date(win[1] + 'T12:00:00');
  end.setDate(end.getDate() - 1);  // window end is exclusive (Saturday)
  return `${w}: ${Viz.fmtDate(win[0])} → ${Viz.fmtDate(end.toISOString().slice(0, 10))}`;
}

// ---------------------------------------------------------------- headline
function renderHeadline(d) {
  const root = document.getElementById('rt-headline');
  const edges = d.persistent_edges || [];
  const weeks = d.weeks || [];
  const big = edges.length
    ? h('div', { class: 'regime-hero' },
        h('div', { class: 'big', style: 'color:var(--viz-good)', text: `${edges.length} persistent edge${edges.length > 1 ? 's' : ''}` }))
    : h('div', { class: 'regime-hero' },
        h('div', { class: 'big', style: 'color:var(--muted)', text: 'No persistent edge yet' }));
  const lines = [];
  if (edges.length) {
    lines.push(h('p', null, edges.map(e => `${e.technique} in ${e.universe} (${bps(e.mean_net_bps)} bps/bet, t=${tTxt(e.t_weeks)})`).join(' · ')));
  }
  lines.push(h('p', { class: 'mm-note' },
    `${weeks.length} week${weeks.length === 1 ? '' : 's'} re-tested`,
    weeks.length ? ` (${windowText(d, weeks[0]).split(': ')[1].split(' → ')[0]} → ${windowText(d, weeks[weeks.length - 1]).split(' → ')[1]})` : '',
    `. ${d.tested_pairs} technique × universe pairs have three or more usable weeks; by chance alone about ${d.expected_false_positives} of them would clear the bar, so one edge on its own proves little.`));
  const gen = Object.entries(d.generalizing || {});
  if (gen.length) {
    lines.push(h('p', null, h('strong', { text: 'Holds in two or more universes: ' }),
      gen.map(([t, us]) => `${t} (${us.join(', ')})`).join('; ')));
  }
  const losers = d.persistent_losers || [];
  if (losers.length) {
    const byUni = {};
    for (const l of losers) (byUni[l.universe] = byUni[l.universe] || []).push(l);
    const judged = u => (d.pairs || []).filter(p => p.universe === u && !p.is_control && p.n_weeks >= 3).length;
    const parts = (d.universes || []).filter(u => byUni[u]).map(u => {
      const ls = byUni[u];
      const names = ls.length === judged(u) && ls.length > 2
        ? `every technique (${ls.length})`
        : ls.map(l => `${l.technique.replace(/_/g, ' ')} ${bps(l.mean_net_bps, 1)}`).join(', ');
      return h('li', null, h('strong', { text: `${u}: ` }), names);
    });
    lines.push(h('div', { class: 'mm-note' }, h('strong', { text: 'Reliably losing after costs (worth retiring):' }),
      h('ul', { style: 'margin:4px 0 0;padding-left:18px' }, parts)));
  }
  root.replaceChildren(big, ...lines);
}

// ---------------------------------------------------------------- matrix
// Rank techniques by their mean across universes, counting only pairs with
// enough weeks to judge — one thin week shouldn't put a technique on top.
function techniqueOrder(pairs) {
  const by = {};
  for (const p of pairs) {
    const r = (by[p.technique] = by[p.technique] || { technique: p.technique, control: p.is_control, means: [] });
    if (p.mean_net_bps != null && p.n_weeks >= 3) r.means.push(p.mean_net_bps);
  }
  return Object.values(by).sort((a, b) => {
    if (a.control !== b.control) return a.control ? 1 : -1;
    const ma = a.means.length ? a.means.reduce((x, y) => x + y, 0) / a.means.length : -99;
    const mb = b.means.length ? b.means.reduce((x, y) => x + y, 0) / b.means.length : -99;
    return mb - ma;
  });
}

function renderMatrix(d) {
  const table = document.getElementById('rt-matrix');
  const pairs = d.pairs || [];
  const unis = d.universes || [];
  const find = (t, u) => pairs.find(p => p.technique === t && p.universe === u);
  const scale = scaleOf(pairs.filter(p => p.n_weeks).map(p => p.mean_net_bps));
  const head = h('thead', null, h('tr', null, h('th', { text: 'technique' }), unis.map(u => h('th', { text: u }))));
  const body = h('tbody');
  for (const row of techniqueOrder(pairs)) {
    const tr = h('tr', null, h('td', null, row.technique.replace(/_/g, ' '),
      row.control ? h('span', { class: 'sym', text: 'control' }) : null));
    for (const u of unis) {
      const p = find(row.technique, u);
      if (!p) { tr.appendChild(h('td', { text: '·' })); continue; }
      const v = PERSIST[p.verdict] || PERSIST['need more weeks'];
      const td = h('td', {
        class: 'cell', tabindex: 0, role: 'button', style: 'cursor:pointer',
        title: `${p.verdict}: ${p.reason}`,
        onclick: () => { TAB = u; FOCUS = row.technique; renderWeeks(DATA); document.getElementById('rt-weeks').scrollIntoView({ behavior: 'smooth', block: 'start' }); },
        onkeydown: ev => { if (ev.key === 'Enter') ev.currentTarget.click(); },
      }, h('span', { 'aria-hidden': 'true', style: 'opacity:.75;margin-right:6px', text: v.icon }),
        p.n_weeks ? bps(p.mean_net_bps) : '—');
      if (p.n_weeks) td.style.background = Viz.divColor(p.mean_net_bps, scale);
      tr.appendChild(td);
    }
    body.appendChild(tr);
  }
  table.replaceChildren(head, body);
}

// ---------------------------------------------------------------- weeks
function renderWeeks(d) {
  const unis = d.universes || [];
  if (!TAB) TAB = unis[0];
  const tabs = document.getElementById('rt-tabs');
  tabs.replaceChildren(...unis.map(u => h('button', {
    class: TAB === u ? 'on' : null, role: 'tab', 'aria-selected': TAB === u ? 'true' : 'false',
    onclick: () => { TAB = u; FOCUS = null; renderWeeks(DATA); },
  }, u)));
  const weeks = d.weeks || [];
  const avail = new Set(d.sessions_available || []);
  const pairs = (d.pairs || []).filter(p => p.universe === TAB);
  const order = techniqueOrder(pairs).map(r => r.technique);
  pairs.sort((a, b) => order.indexOf(a.technique) - order.indexOf(b.technique));
  const scale = scaleOf(pairs.flatMap(p => p.weeks.map(w => w.resolved >= MIN_BETS ? w.mean_net_bps : null)));
  const head = h('thead', null, h('tr', null,
    h('th', { text: 'technique' }),
    weeks.map(w => h('th', { class: 'num', title: windowText(d, w), text: weekLabel(w) })),
    h('th', { class: 'num', text: 'weeks +' }), h('th', { class: 'num', text: 'mean' }),
    h('th', { class: 'num', title: 't across weeks', text: 't' }),
    h('th', { class: 'num', title: 't of the weekly excess over the coin-flip control', text: 't vs ctl' }),
    h('th', { class: 'num', title: 'one-sided 5% bar for this many weeks', text: 'needs' }),
    h('th', { text: 'verdict' })));
  const body = h('tbody');
  for (const p of pairs) {
    const byWeek = Object.fromEntries(p.weeks.map(w => [w.week, w]));
    const tr = h('tr', { class: FOCUS === p.technique ? 'sb-row' : null, style: FOCUS === p.technique ? 'outline:1px solid var(--accent);outline-offset:-1px' : null },
      h('td', null, h('span', { class: 'sb-name', text: p.technique.replace(/_/g, ' ') }),
        p.is_control ? h('span', { class: 'sb-fam', text: 'control' }) : null));
    for (const w of weeks) {
      const c = byWeek[w];
      if (!c) { tr.appendChild(h('td', { class: 'num', text: '·' })); continue; }
      const enough = c.resolved >= MIN_BETS && c.mean_net_bps != null;
      const link = avail.has(c.session_id);
      const title = `${windowText(d, w)} · ${c.resolved} resolved bets` +
        (enough ? ` · ${bps(c.mean_net_bps)} bps/bet net · hit ${c.hit_rate != null ? Math.round(c.hit_rate * 100) + '%' : '—'} · t=${tTxt(c.t_stat)} · ${c.verdict}` : ' (too few to count)') +
        (link ? ' · click for the session' : '');
      const td = h('td', { class: 'num tnum', title, style: link ? 'cursor:pointer' : null,
        onclick: link ? () => { location.href = `/classroom/live/sessions/${encodeURIComponent(c.session_id)}`; } : null },
        enough ? h('span', { 'aria-hidden': 'true', style: 'opacity:.6;margin-right:5px;font-size:10px', text: WEEK_ICON[c.verdict] || '' }) : null,
        enough ? bps(c.mean_net_bps, 1) : `(${c.resolved})`);
      if (enough) td.style.background = Viz.divColor(c.mean_net_bps, scale);
      tr.appendChild(td);
    }
    tr.appendChild(h('td', { class: 'num tnum', text: p.n_weeks ? `${p.weeks_positive}/${p.n_weeks}` : '—' }));
    tr.appendChild(h('td', { class: `num tnum ${p.mean_net_bps > 0 ? 'num-good' : p.mean_net_bps < 0 ? 'num-bad' : ''}`, text: bps(p.mean_net_bps) }));
    tr.appendChild(h('td', { class: 'num tnum', text: tTxt(p.t_weeks) }));
    tr.appendChild(h('td', { class: 'num tnum', text: p.is_control ? '—' : tTxt(p.t_vs_control) }));
    tr.appendChild(h('td', { class: 'num tnum', text: p.t_needed != null ? p.t_needed.toFixed(2) : '—' }));
    tr.appendChild(h('td', null, chip(p.verdict, p.reason)));
    body.appendChild(tr);
  }
  document.getElementById('rt-weeks').replaceChildren(head, body);
  document.getElementById('rt-weeks-note').textContent =
    'Cells: mean basis points per distinct bet after a one-tick round trip that week (blue up, red down); the small mark is that week\'s own verdict. ' +
    '"(n)" = fewer than 10 resolved bets, so the week doesn\'t count. Click a week to open its session (the newest week keeps its full data).';
}

function renderMethod(d) {
  document.getElementById('rt-method').replaceChildren(
    h('p', null, d.method || ''),
    h('p', null, 'Why weeks and not bets: bets overlap in time and share symbols, so a single week\'s bet-level t-stat is optimistic — the coin-flip control once scored t=3.7 on one week. Treating each week as one observation, and asking for the same result against that week\'s coin-flip control, is the honest test.'),
    h('p', null, `Runs every Saturday at 07:00 (launchd com.christianverghis.classroom.weekly-retest) on whatever engine is checked out; engine ${(d.engine || []).join(', ') || '?'}. Summary generated ${Viz.fmtTime(d.generated_at, true)}${d.last_log ? `; last log data/cron/${d.last_log}` : ''}.`),
  );
}

async function load() {
  const meta = document.getElementById('rt-meta');
  let d;
  try {
    d = await fetch('/api/classroom/retest').then(r => r.json());
  } catch (e) {
    meta.textContent = `could not load (${e.message})`;
    return;
  }
  if (d.missing) {
    meta.textContent = 'no re-test yet';
    document.getElementById('rt-root').replaceChildren(h('section', { class: 'panel mm-missing' },
      h('p', { text: 'The weekly re-test hasn\'t run on this machine yet.' }),
      h('p', null, 'Run ', h('code', { text: '.venv/bin/python shortterm/scripts/weekly_retest.py --weeks-back 4' }),
        ' in ~/dev/classroom (yfinance keeps about 30 days of 1-minute bars, so four weeks can be backfilled).')));
    return;
  }
  DATA = d;
  meta.textContent = `${(d.weeks || []).length} weeks · ${(d.universes || []).length} universes`;
  renderHeadline(d);
  renderMatrix(d);
  renderWeeks(d);
  renderMethod(d);
}

load();
