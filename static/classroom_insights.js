// classroom_insights.js — renders a short-term session's insights: what the
// data is, which techniques are in play and which are working (judged after
// a one-tick cost against chance), and which bets paid — and why.
// Shared by the live page (/classroom/live) and past sessions
// (/classroom/live/sessions/{id}). Data: /api/classroom/live/insights or
// /api/classroom/live/session/{id}/insights (shortterm/scripts/session_analytics.py).
'use strict';

const Insights = (() => {
  const state = {
    sessionId: null,
    tab: 'winners',
    expanded: new Set(),
    showControls: true,
    paths: new Map(),     // bet_id -> {path, fetchedAt}
    data: null,
  };

  // ---------------------------------------------------------------- dom
  function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') e.className = v;
        else if (k === 'text') e.textContent = v;
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

  const VERDICT = {
    working: { cls: 'good', icon: '✓', label: 'working' },
    failing: { cls: 'bad', icon: '✕', label: 'failing' },
    unproven: { cls: 'warn', icon: '~', label: 'unproven' },
    early: { cls: 'muted', icon: '…', label: 'too early' },
    idle: { cls: 'muted', icon: '○', label: 'idle' },
  };

  function chip(verdict, title) {
    const v = VERDICT[verdict] || VERDICT.early;
    return h('span', { class: `vchip ${v.cls}`, title }, h('span', { 'aria-hidden': 'true', text: v.icon }), v.label);
  }

  function bps(v, digits = 1) {
    return v == null || !isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(digits)} bps`;
  }

  function pct(v, digits = 0) {
    return v == null || !isFinite(v) ? '—' : `${(v * 100).toFixed(digits)}%`;
  }

  function signCls(v) {
    return v > 0 ? 'num-good' : v < 0 ? 'num-bad' : '';
  }

  // How long before the session's latest bar a technique last fired.
  function relTime(ts, nowTs) {
    if (!ts) return 'never';
    const a = new Date(ts), b = nowTs ? new Date(nowTs) : new Date();
    if (isNaN(a) || isNaN(b)) return '';
    const s = Math.max(0, (b - a) / 1000);
    if (s < 90) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) { const n = Math.round(s / 3600); return `${n} hour${n === 1 ? '' : 's'} ago`; }
    const n = Math.round(s / 86400);
    return `${n} day${n === 1 ? '' : 's'} ago`;
  }

  // ---------------------------------------------------------------- banner
  function sourceKind(meta) {
    if (!meta) return 'idle';
    if (meta.is_synthetic) return 'synthetic';
    if ((meta.provider || '').startsWith('alpaca')) return 'live';
    if (meta.provider === 'yfinance') return 'replay';
    return meta.is_synthetic === false ? 'replay' : 'idle';
  }

  function renderBanner(root, d) {
    const meta = d.session || {};
    const kind = sourceKind(meta);
    const box = h('div', { class: `source-banner ${kind}` });
    const tags = { synthetic: 'Synthetic', replay: 'Replay', live: 'Live', idle: 'No session' };
    box.appendChild(h('div', { class: 'src-tag', text: tags[kind] }));
    const body = h('div', { style: 'flex:1;min-width:240px' });
    const syms = (meta.symbols || []).join(' · ');
    if (kind === 'synthetic') {
      body.appendChild(h('div', null,
        h('strong', { text: 'Synthetic price path' }),
        ` — ${meta.scenario || 'random walk'} scenario${meta.seed ? `, seed ${meta.seed}` : ''} · ${syms}. `,
        'These results test the engine, not the techniques: a random path has no edge to find. ',
        'Use a yfinance replay (real 1-minute bars) or Alpaca for evidence.'));
    } else if (kind === 'replay') {
      const from = meta.replay_start || meta.first_bar_ts, to = meta.replay_end || meta.last_bar_ts;
      body.appendChild(h('div', null,
        h('strong', { text: 'Replaying real 1-minute bars' }),
        ` · ${syms} · ${Viz.fmtTime(from, true)} → ${Viz.fmtTime(to, true)}`,
        meta.replay_speed ? ` at ${meta.replay_speed}× speed` : ' (as fast as it computes)',
        meta.slippage_bps ? ` · ${meta.slippage_bps} bps stop slippage` : ''));
    } else if (kind === 'live') {
      body.appendChild(h('div', null, h('strong', { text: 'Live market bars (Alpaca)' }), ` · ${syms}`));
    } else {
      body.appendChild(h('div', { text: 'No session yet — start one above, or open a past session below.' }));
    }
    const caveats = ((d.summary || {}).caveats || []).filter(c => !(kind === 'synthetic' && c.startsWith('Synthetic')));
    if (caveats.length) body.appendChild(h('ul', null, caveats.map(c => h('li', { text: c }))));
    box.appendChild(body);
    root.replaceChildren(box);
  }

  // ---------------------------------------------------------------- KPIs
  function kpi(label, value, sub, valueCls) {
    return h('div', { class: 'kpi' },
      h('div', { class: 'kpi-label', text: label }),
      h('div', { class: `kpi-value ${valueCls || ''}`, text: value }),
      sub ? h('div', { class: 'kpi-sub', text: sub }) : null);
  }

  function renderKpis(root, d) {
    const s = d.summary || {};
    const techs = d.techniques || [];
    const nonCtl = techs.filter(t => !t.is_control && t.bets > 0);
    const working = (s.working || []);
    const ctl = s.control_benchmark || {};
    const rw = ctl.random_walker;
    const clone = s.clone_factor ? ` = ${s.n_strategies} strategies × ~${s.clone_factor} clones` : '';
    root.replaceChildren(h('div', { class: 'kpi-row' },
      kpi('Distinct bets', `${(s.bets_resolved || 0).toLocaleString()} resolved`,
          `${(s.bets_open || 0).toLocaleString()} open · from ${(s.predictions || 0).toLocaleString()} student predictions (${s.n_students || '—'} students${clone})`),
      kpi('Hit rate', s.hit_rate == null ? '—' : pct(s.hit_rate), 'share of resolved bets that made money'),
      kpi('Per bet, after costs', bps(s.mean_net_bps, 2),
          `gross ${bps(s.mean_bps, 2)} · cost = a one-tick (1¢) round trip`, signCls(s.mean_net_bps)),
      kpi('Techniques working', `${working.length} of ${nonCtl.length}`,
          working.length ? working.join(', ') : 'none clears t ≥ 2 after costs yet'),
      kpi('Noise benchmark', rw && rw.mean_net_bps != null ? bps(rw.mean_net_bps, 2) : '—',
          rw ? `random_walker per bet after costs over ${rw.resolved.toLocaleString()} bets (gross ${bps(rw.mean_bps, 2)}) — what a coin flip earns here` : 'random control has no resolved bets yet',
          rw ? signCls(rw.mean_net_bps) : ''),
    ));
  }

  function renderEquity(root, d) {
    const eq = ((d.summary || {}).equity) || {};
    const a = eq.techniques || [], b = eq.controls || [];
    if (!a.length && !b.length) {
      root.replaceChildren(h('div', { class: 'bet-empty', text: 'Cumulative results appear once bets resolve.' }));
      return;
    }
    // Merge the two step curves onto one timeline (carry each forward).
    const times = Array.from(new Set([...a, ...b].map(p => p[0]))).sort();
    const step = Math.max(1, Math.ceil(times.length / 300));
    const xs = times.filter((_, i) => i % step === 0 || i === times.length - 1);
    const carry = pts => {
      const out = [];
      let k = 0, v = null;
      for (const t of xs) {
        while (k < pts.length && pts[k][0] <= t) { v = pts[k][1]; k++; }
        out.push(v);
      }
      return out;
    };
    Viz.lineChart(root, {
      title: 'Cumulative net basis points per distinct bet',
      x: xs,
      height: 190,
      zero: 0,
      yFmt: v => `${v > 0 ? '+' : ''}${Math.round(v).toLocaleString()}`,
      xFmt: t => Viz.fmtTime(t, sourceKind(d.session) !== 'synthetic'),
      tipHead: t => Viz.fmtTime(t, true),
      series: [
        { name: 'Techniques', color: Viz.css('--viz-1'), values: carry(a) },
        { name: 'Controls (random, always-long, scalper)', color: Viz.css('--viz-ghost'), values: carry(b), ghost: true,
          endLabel: 'Controls' },
      ],
    });
  }

  // ---------------------------------------------------------------- scoreboard
  function meter(t) {
    const hit = t.hit_rate;
    const wrap = h('span', { style: 'white-space:nowrap' });
    const m = h('span', { class: 'meter', role: 'img',
      'aria-label': `hit rate ${pct(hit)}${t.breakeven_reliable && t.breakeven != null ? `, break-even ${pct(t.breakeven)}` : ''}` });
    if (hit != null) {
      const b = h('b');
      b.style.width = `${Math.max(2, hit * 100)}%`;
      m.appendChild(b);
    }
    if (t.breakeven_reliable && t.breakeven != null) {
      const i = h('i');
      i.style.left = `calc(${t.breakeven * 100}% - 1px)`;
      m.appendChild(i);
    }
    wrap.appendChild(m);
    const txt = hit == null ? '—' : t.breakeven_reliable && t.breakeven != null
      ? `${pct(hit)} vs ${pct(t.breakeven)}` : pct(hit);
    wrap.appendChild(h('span', { class: 'meter-txt', text: txt }));
    return wrap;
  }

  function miniTable(rows, keyLabel) {
    if (!rows || !rows.length) return h('div', { class: 'sb-sub', text: 'No resolved bets yet.' });
    return h('table', { class: 'sb-mini' },
      h('thead', null, h('tr', null,
        h('th', { text: keyLabel }), h('th', { class: 'num', text: 'bets' }), h('th', { class: 'num', text: 'hit' }),
        h('th', { class: 'num', text: 'net / bet' }), h('th', { class: 'num', text: 'net total' }))),
      h('tbody', null, rows.slice(0, 8).map(r => h('tr', null,
        h('td', { text: String(r.key).replace(/_/g, ' ') }),
        h('td', { class: 'num', text: String(r.bets) }),
        h('td', { class: 'num', text: pct(r.hit_rate) }),
        h('td', { class: `num ${signCls(r.mean_net_bps)}`, text: bps(r.mean_net_bps) }),
        h('td', { class: `num ${signCls(r.net_bps)}`, text: bps(r.net_bps, 0) })))));
  }

  function detailRow(t, ncols) {
    const exits = t.exit_reasons || {};
    const exitTxt = Object.entries(exits).map(([k, v]) => `${v} ${k.replace('_', ' ')}`).join(' · ') || '—';
    const pf = t.no_losses ? 'no losing bets' : t.profit_factor == null ? '—' : t.profit_factor.toFixed(2);
    return h('tr', { class: 'sb-detail' }, h('td', { colspan: ncols },
      h('p', { class: 'sb-reason' }, h('strong', { text: 'Verdict: ' }), t.verdict_reason || ''),
      h('p', { class: 'sb-reason' }, h('strong', { text: 'The bet: ' }),
        t.thesis ? `${t.technique} bets that ${t.thesis}.` : '', t.description ? ` (${t.description})` : ''),
      h('div', { class: 'sb-detail-grid' },
        h('div', null, h('h4', { text: 'By symbol' }), miniTable(t.by_symbol, 'symbol')),
        h('div', null, h('h4', { text: 'By regime at entry' }), miniTable(t.by_regime, 'regime')),
        h('div', null, h('h4', { text: 'By parameter variant' }), miniTable(t.by_strategy, 'params')),
        h('div', null, h('h4', { text: 'Shape of the edge' }),
          h('table', { class: 'sb-mini' }, h('tbody', null,
            h('tr', null, h('th', { text: 'avg win' }), h('td', { class: 'num', text: bps(t.avg_win_bps) })),
            h('tr', null, h('th', { text: 'avg loss' }), h('td', { class: 'num', text: bps(t.avg_loss_bps) })),
            h('tr', null, h('th', { text: 'profit factor' }), h('td', { class: 'num', text: pf })),
            h('tr', null, h('th', { text: 'cost per bet' }), h('td', { class: 'num', text: bps(t.cost_bps, 2) })),
            h('tr', null, h('th', { text: 'gross verdict' }), h('td', { class: 'num', text: t.gross_verdict || '—' })),
            h('tr', null, h('th', { text: 'exits' }), h('td', { class: 'num', text: exitTxt })),
            h('tr', null, h('th', { text: 'students / variants' }), h('td', { class: 'num', text: `${t.students || '—'} / ${t.strategies || Object.keys(t.by_strategy || {}).length}` })),
          ))),
      )));
  }

  function renderScoreboard(root, d) {
    const meta = d.session || {};
    const techs = (d.techniques || []).filter(t => state.showControls || !t.is_control);
    const head = ['Technique', 'Verdict', 'Activity', 'Open', 'Resolved', 'Hit vs break-even', 'Net / bet', 'Net total', 'Net equity'];
    const ncols = head.length;
    const tbody = h('tbody');
    for (const t of techs) {
      const open = state.expanded.has(t.technique);
      const curve = (t.equity || []).map(p => p[2] != null ? p[2] : p[1]);
      const row = h('tr', {
        class: `sb-row${t.is_control ? ' sb-control' : ''}`, tabindex: 0, 'aria-expanded': open ? 'true' : 'false',
        onclick: () => toggle(t.technique), onkeydown: ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(t.technique); } },
      },
        h('td', null,
          h('div', null, h('span', { class: 'sb-name', text: t.technique.replace(/_/g, ' ') }),
            h('span', { class: 'sb-fam', text: t.is_control ? 'control' : t.family })),
          t.thesis ? h('div', { class: 'sb-thesis', text: t.thesis }) : null),
        h('td', null, chip(t.verdict, t.verdict_reason)),
        h('td', null, Viz.bars(t.activity || [], { title: `bets opened per time slice; last ${relTime(t.last_fired_ts, meta.last_bar_ts)}` }),
          h('div', { class: 'sb-sub', text: t.bets ? `last bet ${relTime(t.last_fired_ts, meta.last_bar_ts)}` : 'no trigger yet' })),
        h('td', { class: 'num tnum', text: String(t.open || 0) }),
        h('td', { class: 'num tnum', text: (t.resolved || 0).toLocaleString() }),
        h('td', null, meter(t)),
        h('td', { class: 'num tnum' },
          h('div', { class: signCls(t.mean_net_bps), text: bps(t.mean_net_bps) }),
          h('div', { class: 'sb-sub', text: t.mean_bps == null ? '' : `gross ${bps(t.mean_bps)}` })),
        h('td', { class: `num tnum ${signCls(t.total_net_bps)}`, text: t.resolved ? bps(t.total_net_bps, 0) : '—' }),
        h('td', null, curve.length > 1 ? Viz.sparkline(curve, { w: 110, h: 28, zero: true, title: 'cumulative net bps' }) : null),
      );
      tbody.appendChild(row);
      if (open) tbody.appendChild(detailRow(t, ncols));
    }
    const toolbar = h('div', { class: 'sb-sub', style: 'display:flex;gap:14px;align-items:center;margin-bottom:8px;flex-wrap:wrap' },
      h('label', { style: 'display:inline-flex;gap:6px;align-items:center;cursor:pointer' },
        h('input', { type: 'checkbox', checked: state.showControls, onchange: ev => { state.showControls = ev.target.checked; renderScoreboard(root, state.data); } }),
        'show controls'),
      'Verdicts use returns after a one-tick round trip and need t ≥ 2 over ≥ 10 distinct bets. Click a row for where and when it works.');
    root.replaceChildren(toolbar, h('div', { style: 'overflow-x:auto' },
      h('table', { class: 'sb-table' }, h('thead', null, h('tr', null, head.map((c, i) => h('th', { class: i >= 3 && i <= 7 && i !== 5 ? 'num' : null, text: c })))), tbody)));

    function toggle(name) {
      if (state.expanded.has(name)) state.expanded.delete(name); else state.expanded.add(name);
      renderScoreboard(root, state.data);
    }
  }

  // ---------------------------------------------------------------- bets
  function betReturn(b) {
    if (b.status !== 'resolved') return h('span', { class: 'bet-ret', text: 'open' });
    const v = b.net_bps != null ? b.net_bps : b.raw_bps;
    return h('span', { class: `bet-ret ${signCls(v)}`, title: `gross ${bps(b.raw_bps)} · one-tick cost ${bps(b.tick_bps)}` },
      h('span', { 'aria-hidden': 'true', text: v > 0 ? '▲ ' : v < 0 ? '▼ ' : '' }), `${bps(v)} net`);
  }

  function whyLine(k, v, cls) {
    if (!v) return null;
    return h('div', null, h('span', { class: 'why-k', text: k }), h('span', { class: cls || null, text: v }));
  }

  function betCard(b) {
    const why = b.why || {};
    const pathBox = h('div', { class: 'bet-path' });
    const card = h('article', {
      class: 'bet-card', tabindex: 0, role: 'button', 'aria-label': `${b.symbol} ${b.direction} bet by ${b.technique}, details`,
      onclick: () => openBet(b.bet_id), onkeydown: ev => { if (ev.key === 'Enter') openBet(b.bet_id); },
    },
      h('div', { class: 'bet-head' },
        h('span', { class: 'bet-sym', text: b.symbol }),
        h('span', { class: 'bet-dir', text: b.direction === 'up' ? '↑ bet up' : '↓ bet down' }),
        h('span', { class: 'bet-tech', text: b.technique.replace(/_/g, ' ') }),
        betReturn(b)),
      h('div', { class: 'bet-meta', text: [
        `entered ${Viz.fmtTime(b.entry_ts, true)}`,
        b.bars_held ? `held ${b.bars_held} bar${b.bars_held === 1 ? '' : 's'}` : null,
        b.copies > 1 ? `×${b.copies} students${b.merged > 1 ? ` · ${b.merged} variants` : ''}` : null,
        b.confidence ? `conf ${b.confidence}` : null,
      ].filter(Boolean).join(' · ') }),
      pathBox,
      h('div', { class: 'bet-why' },
        whyLine('Saw', why.setup ? `“${why.setup}”` : '', 'why-setup'),
        whyLine('Then', why.outcome),
        whyLine('Tape', why.context),
        whyLine('Cost', why.cost),
        whyLine('Record', why.reliability)),
    );
    loadPath(b, pathBox, 120);
    return card;
  }

  async function fetchBet(betId) {
    const q = state.sessionId ? `?session=${encodeURIComponent(state.sessionId)}` : '';
    const r = await fetch(`/api/classroom/live/bet/${encodeURIComponent(betId)}${q}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  async function loadPath(b, box, height) {
    const cached = state.paths.get(b.bet_id);
    const fresh = cached && (b.status === 'resolved' || Date.now() - cached.at < 10000);
    let detail = fresh ? cached.detail : null;
    if (!detail) {
      try {
        detail = await fetchBet(b.bet_id);
        state.paths.set(b.bet_id, { detail, at: Date.now() });
      } catch (e) {
        box.replaceChildren(h('div', { class: 'bet-empty', text: 'Price path unavailable.' }));
        return;
      }
    }
    const p = detail.path || {};
    const bet = detail.bet || b;
    requestAnimationFrame(() => Viz.pricePath(box, {
      bars: p.bars, entry_i: p.entry_i, exit_i: p.exit_i, entry: bet.entry, target: bet.target,
      stop: bet.stop, exit: bet.exit, correct: bet.correct, height, withDay: false,
    }));
  }

  function renderBets(root, d) {
    const groups = (d.bets || {});
    const tabs = [
      ['winners', 'Bets that paid'], ['losers', 'Bets that lost'], ['recent', 'Latest resolved'], ['open', 'Open now'],
    ];
    const bar = h('div', { class: 'tabs', role: 'tablist' }, tabs.map(([k, label]) => h('button', {
      class: state.tab === k ? 'on' : null, role: 'tab', 'aria-selected': state.tab === k ? 'true' : 'false',
      onclick: () => { state.tab = k; renderBets(root, state.data); },
    }, `${label} (${(groups[k] || []).length})`)));
    const list = groups[state.tab] || [];
    const grid = list.length
      ? h('div', { class: 'bet-grid' }, list.map(betCard))
      : h('div', { class: 'bet-empty', text: state.tab === 'open' ? 'No open bets right now.' : 'Nothing here yet — bets show up as they resolve.' });
    const note = h('div', { class: 'sb-sub', style: 'margin:8px 0 10px' },
      'Each card is one distinct bet (clones that took the identical trade are counted, not repeated). ',
      'The chart shows the bars around it: the wash is the holding period, dots mark entry and exit, ',
      'and the trade starts on the bar after the one it read.');
    root.replaceChildren(bar, note, grid);
  }

  // ---------------------------------------------------------------- modal
  function modalRoot() {
    let m = document.getElementById('bet-modal');
    if (!m) {
      m = h('div', { id: 'bet-modal', class: 'vmodal', hidden: true, onclick: ev => { if (ev.target === m) closeBet(); } });
      document.body.appendChild(m);
      document.addEventListener('keydown', ev => { if (ev.key === 'Escape') closeBet(); });
    }
    return m;
  }

  function closeBet() {
    const m = document.getElementById('bet-modal');
    if (m) m.hidden = true;
    Viz.hideTip();
  }

  async function openBet(betId) {
    const m = modalRoot();
    m.hidden = false;
    const card = h('div', { class: 'vmodal-card', role: 'dialog', 'aria-modal': 'true' }, h('div', { class: 'bet-empty', text: 'loading…' }));
    m.replaceChildren(card);
    let detail;
    try {
      detail = await fetchBet(betId);
    } catch (e) {
      card.replaceChildren(h('div', { class: 'bet-empty', text: `Could not load this bet (${e.message}).` }));
      return;
    }
    const b = detail.bet, why = b.why || {}, t = detail.technique || {};
    const path = h('div', { class: 'bet-path' });
    const fact = (k, v) => h('div', null, h('span', { text: k }), v);
    card.replaceChildren(
      h('div', { class: 'vmodal-head' },
        h('h3', { text: `${b.symbol} · ${b.direction === 'up' ? 'bet up' : 'bet down'} · ${b.technique.replace(/_/g, ' ')}` }),
        betReturn(b),
        h('button', { 'aria-label': 'close', onclick: closeBet, text: '×' })),
      path,
      h('div', { class: 'facts' },
        fact('entry', `${Viz.fmtPrice(b.entry)} · ${Viz.fmtTime(b.entry_ts, true)}`),
        fact('target / stop', `${Viz.fmtPrice(b.target)} / ${Viz.fmtPrice(b.stop)}`),
        fact('exit', b.status === 'resolved' ? `${Viz.fmtPrice(b.exit)} · ${(b.exit_reason || '').replace('_', ' ')}` : 'open'),
        fact('held', b.bars_held ? `${b.bars_held} bars` : '—'),
        fact('best / worst along the way', b.mfe_bps == null ? '—' : `+${b.mfe_bps.toFixed(0)} / −${(b.mae_bps || 0).toFixed(0)} bps`),
        fact('gross / net', `${bps(b.raw_bps)} / ${bps(b.net_bps)}`),
        fact('copies', `${b.copies} student${b.copies === 1 ? '' : 's'}`),
        fact('horizon · confidence', `${b.horizon} · ${b.confidence}`)),
      h('div', { class: 'bet-why' },
        whyLine('What it saw', why.setup ? `“${why.setup}”` : '', 'why-setup'),
        whyLine('The bet', why.thesis),
        whyLine('What happened', why.outcome),
        whyLine('The tape', why.context),
        whyLine('Geometry', why.geometry),
        whyLine('Cost', why.cost),
        whyLine('Track record', why.reliability),
        whyLine('Crowd', why.crowd),
        t && t.verdict ? h('div', { style: 'margin-top:6px' }, chip(t.verdict, t.verdict_reason), ' ',
          h('span', { class: 'sb-sub', text: t.verdict_reason || '' })) : null),
    );
    const p = detail.path || {};
    requestAnimationFrame(() => Viz.pricePath(path, {
      bars: p.bars, entry_i: p.entry_i, exit_i: p.exit_i, entry: b.entry, target: b.target,
      stop: b.stop, exit: b.exit, correct: b.correct, height: 240, withDay: true,
    }));
  }

  // ---------------------------------------------------------------- public
  function render(roots, data, opts = {}) {
    state.data = data;
    if (opts.sessionId !== undefined) state.sessionId = opts.sessionId;
    if (roots.banner) renderBanner(roots.banner, data);
    if (roots.kpis) renderKpis(roots.kpis, data);
    if (roots.equity) renderEquity(roots.equity, data);
    if (roots.scoreboard) renderScoreboard(roots.scoreboard, data);
    if (roots.bets) renderBets(roots.bets, data);
  }

  return { render, openBet, sourceKind };
})();
