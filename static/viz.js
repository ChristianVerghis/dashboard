// viz.js — small SVG chart primitives for the classroom insight views and the
// market map. No dependencies. Colors come from CSS custom properties in
// viz.css, so dark/light swap in one place. Every chart has a hover layer
// (crosshair or per-mark tooltip) and keyboard focus shows the same readout.
'use strict';

const Viz = (() => {
  const NS = 'http://www.w3.org/2000/svg';

  function css(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, v);
    if (parent) parent.appendChild(e);
    return e;
  }

  function text(parent, x, y, str, attrs) {
    const t = el('text', { x, y, ...(attrs || {}) }, parent);
    t.textContent = str;
    return t;
  }

  // ---------------------------------------------------------------- tooltip
  let tipEl = null;
  function tipNode() {
    if (!tipEl) {
      tipEl = document.createElement('div');
      tipEl.className = 'viz-tip';
      tipEl.setAttribute('role', 'status');
      document.body.appendChild(tipEl);
    }
    return tipEl;
  }

  // rows: [{value, name?, color?}] — the value leads, the name follows.
  function showTip(x, y, head, rows) {
    const t = tipNode();
    t.replaceChildren();
    if (head) {
      const h = document.createElement('div');
      h.className = 'tip-head';
      h.textContent = head;
      t.appendChild(h);
    }
    for (const r of rows || []) {
      const row = document.createElement('div');
      row.className = 'tip-row';
      if (r.color) {
        const k = document.createElement('span');
        k.className = 'tip-key';
        k.style.background = r.color;
        row.appendChild(k);
      }
      const v = document.createElement('span');
      v.className = 'tip-val';
      v.textContent = r.value;
      row.appendChild(v);
      if (r.name) {
        const n = document.createElement('span');
        n.className = 'tip-name';
        n.textContent = r.name;
        row.appendChild(n);
      }
      t.appendChild(row);
    }
    t.classList.add('on');
    const pad = 14;
    const w = t.offsetWidth, h = t.offsetHeight;
    let left = x + pad, top = y + pad;
    if (left + w > window.innerWidth - 8) left = x - w - pad;
    if (top + h > window.innerHeight - 8) top = y - h - pad;
    t.style.left = Math.max(8, left) + 'px';
    t.style.top = Math.max(8, top) + 'px';
  }

  function hideTip() {
    if (tipEl) tipEl.classList.remove('on');
  }

  // ---------------------------------------------------------------- helpers
  function extent(values) {
    let lo = Infinity, hi = -Infinity;
    for (const v of values) {
      if (v == null || !isFinite(v)) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (lo === Infinity) return [0, 1];
    if (lo === hi) return [lo - 1, hi + 1];
    return [lo, hi];
  }

  function niceTicks(lo, hi, count) {
    const span = hi - lo;
    if (!(span > 0)) return [lo];
    const raw = span / Math.max(1, count);
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
    const out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(+v.toFixed(10));
    return out;
  }

  // Bar times read in market time (US Eastern), where 9:30 is the open.
  function fmtTime(ts, withDay) {
    if (!ts) return '';
    const d = new Date(ts);
    if (isNaN(d)) return String(ts);
    const opts = withDay
      ? { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }
      : { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' };
    return `${d.toLocaleString([], opts)} ET`;
  }

  function parseDay(ts) {
    return new Date(String(ts).length === 10 ? ts + 'T12:00:00' : ts);
  }

  function fmtDate(ts) {
    if (!ts) return '';
    const d = parseDay(ts);
    if (isNaN(d)) return String(ts);
    return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
  }

  // Axis ticks on daily charts: "Oct 2025".
  function fmtMonth(ts) {
    if (!ts) return '';
    const d = parseDay(ts);
    if (isNaN(d)) return String(ts);
    return d.toLocaleDateString([], { month: 'short', year: 'numeric' });
  }

  function signed(v, digits, unit) {
    if (v == null || !isFinite(v)) return '—';
    const s = (v > 0 ? '+' : '') + v.toFixed(digits);
    return unit ? s + unit : s;
  }

  // Diverging wash: blue pole for positive, red for negative, transparent
  // (the panel) at zero. Alpha grows with |v| / max.
  function divColor(v, max) {
    if (v == null || !isFinite(v) || !max) return 'transparent';
    const a = Math.min(1, Math.abs(v) / max);
    const rgb = css(v >= 0 ? '--viz-up' : '--viz-down');
    return `rgba(${rgb}, ${(0.06 + a * 0.52).toFixed(3)})`;
  }

  // Resolve overlapping end labels: keep order, push apart to `gap` px.
  function spreadLabels(items, gap, lo, hi) {
    const sorted = items.slice().sort((a, b) => a.y - b.y);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].y - sorted[i - 1].y < gap) sorted[i].y = sorted[i - 1].y + gap;
    }
    const over = sorted.length ? sorted[sorted.length - 1].y - hi : 0;
    if (over > 0) for (const s of sorted) s.y -= over;
    for (let i = sorted.length - 2; i >= 0; i--) {
      if (sorted[i + 1].y - sorted[i].y < gap) sorted[i].y = sorted[i + 1].y - gap;
    }
    if (sorted.length && sorted[0].y < lo) {
      const d = lo - sorted[0].y;
      for (const s of sorted) s.y += d;
    }
    return items;
  }

  // ---------------------------------------------------------------- sparkline
  // Single series: no legend; the row/table it sits in names it.
  function sparkline(values, opts = {}) {
    const w = opts.w || 120, h = opts.h || 28;
    const vals = (values || []).map(v => (v == null ? null : +v));
    const svg = el('svg', { viewBox: `0 0 ${w} ${h}`, width: w, height: h, class: 'viz-svg', role: 'img' });
    if (opts.title) el('title', {}, svg).textContent = opts.title;
    const pts = vals.map((v, i) => [i, v]).filter(p => p[1] != null);
    if (pts.length < 2) return svg;
    let [lo, hi] = extent(vals);
    if (opts.zero) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
    const x = i => 3 + (i / (vals.length - 1)) * (w - 8);
    const y = v => h - 3 - ((v - lo) / (hi - lo || 1)) * (h - 6);
    if (opts.zero && lo < 0 && hi > 0) {
      el('line', { x1: 0, x2: w, y1: y(0), y2: y(0), stroke: css('--viz-axis'), 'stroke-width': 1 }, svg);
    }
    const color = opts.color || css('--viz-1');
    el('path', {
      d: pts.map((p, k) => `${k ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join(''),
      fill: 'none', stroke: color, 'stroke-width': 1.75, 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
    }, svg);
    const last = pts[pts.length - 1];
    el('circle', { cx: x(last[0]), cy: y(last[1]), r: 3, fill: color, stroke: css('--panel'), 'stroke-width': 1.5 }, svg);
    return svg;
  }

  // Column sparkline for counts (activity per time bucket).
  function bars(values, opts = {}) {
    const w = opts.w || 90, h = opts.h || 22;
    const svg = el('svg', { viewBox: `0 0 ${w} ${h}`, width: w, height: h, class: 'viz-svg', role: 'img' });
    if (opts.title) el('title', {}, svg).textContent = opts.title;
    const n = (values || []).length;
    if (!n) return svg;
    const max = Math.max(1, ...values);
    const bw = w / n;
    const color = opts.color || css('--viz-1');
    values.forEach((v, i) => {
      if (!v) return;
      const bh = Math.max(1.5, (v / max) * (h - 2));
      el('rect', { x: (i * bw + 0.5).toFixed(1), y: (h - bh).toFixed(1), width: Math.max(1, bw - 1).toFixed(1), height: bh.toFixed(1), rx: 1, fill: color }, svg);
    });
    return svg;
  }

  // ---------------------------------------------------------------- line chart
  // x: array of labels (dates or ISO times); series: [{name, color, values, ghost}]
  function lineChart(container, cfg) {
    const series = (cfg.series || []).filter(s => s.values && s.values.some(v => v != null));
    container.replaceChildren();
    if (!series.length) {
      const p = document.createElement('div');
      p.className = 'bet-empty';
      p.textContent = cfg.empty || 'No data yet.';
      container.appendChild(p);
      return;
    }
    if (series.length > 1 && cfg.legend !== false) {
      const lg = document.createElement('div');
      lg.className = 'viz-legend';
      for (const s of series) {
        const sp = document.createElement('span');
        const i = document.createElement('i');
        i.style.background = s.color;
        sp.appendChild(i);
        sp.appendChild(document.createTextNode(s.name));
        lg.appendChild(sp);
      }
      container.appendChild(lg);
    }
    const W = Math.max(260, container.clientWidth || 600);
    const H = cfg.height || 220;
    const m = { l: 46, r: cfg.endLabels === false ? 12 : 96, t: 10, b: 24 };
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'viz-svg', role: 'img', 'aria-label': cfg.title || 'line chart' }, container);
    const xs = cfg.x || [];
    const n = Math.max(...series.map(s => s.values.length));
    const all = series.flatMap(s => s.values);
    let [lo, hi] = extent(all);
    if (cfg.zero != null) { lo = Math.min(lo, cfg.zero); hi = Math.max(hi, cfg.zero); }
    const padY = (hi - lo) * 0.06;
    lo -= padY; hi += padY;
    const X = i => m.l + (n <= 1 ? 0 : (i / (n - 1)) * (W - m.l - m.r));
    const Y = v => m.t + (1 - (v - lo) / (hi - lo || 1)) * (H - m.t - m.b);
    const yFmt = cfg.yFmt || (v => v.toFixed(0));
    for (const tv of niceTicks(lo, hi, 4)) {
      el('line', { x1: m.l, x2: W - m.r, y1: Y(tv), y2: Y(tv), stroke: css('--viz-grid'), 'stroke-width': 1 }, svg);
      text(svg, m.l - 6, Y(tv) + 3.5, yFmt(tv), { 'text-anchor': 'end' });
    }
    if (cfg.zero != null && cfg.zero > lo && cfg.zero < hi) {
      el('line', { x1: m.l, x2: W - m.r, y1: Y(cfg.zero), y2: Y(cfg.zero), stroke: css('--viz-axis'), 'stroke-width': 1 }, svg);
    }
    const xFmt = cfg.xFmt || (v => String(v));
    const ticks = Math.min(5, n);
    for (let k = 0; k < ticks; k++) {
      const i = Math.round((k / Math.max(1, ticks - 1)) * (n - 1));
      if (xs[i] == null) continue;
      text(svg, X(i), H - 6, xFmt(xs[i]), { 'text-anchor': k === 0 ? 'start' : k === ticks - 1 ? 'end' : 'middle' });
    }
    const order = series.slice().sort((a, b) => (a.ghost ? 0 : 1) - (b.ghost ? 0 : 1));
    for (const s of order) {
      let d = '', pen = false;
      s.values.forEach((v, i) => {
        if (v == null || !isFinite(v)) { pen = false; return; }
        d += `${pen ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`;
        pen = true;
      });
      el('path', {
        d, fill: 'none', stroke: s.color, 'stroke-width': s.ghost ? 1.5 : 2,
        'stroke-linejoin': 'round', 'stroke-linecap': 'round', opacity: s.ghost ? 0.9 : 1,
      }, svg);
    }
    if (cfg.endLabels !== false) {
      const items = [];
      for (const s of series) {
        let li = s.values.length - 1;
        while (li >= 0 && (s.values[li] == null || !isFinite(s.values[li]))) li--;
        if (li < 0) continue;
        items.push({ s, i: li, y0: Y(s.values[li]), y: Y(s.values[li]) });
      }
      spreadLabels(items, 13, m.t + 4, H - m.b - 2);
      for (const it of items) {
        el('circle', { cx: X(it.i), cy: it.y0, r: 4, fill: it.s.color, stroke: css('--panel'), 'stroke-width': 2 }, svg);
        if (Math.abs(it.y - it.y0) > 2) {
          el('line', { x1: X(it.i) + 5, y1: it.y0, x2: X(it.i) + 11, y2: it.y, stroke: css('--viz-axis'), 'stroke-width': 1 }, svg);
        }
        const label = it.s.endLabel || `${it.s.name} ${yFmt(it.s.values[it.i])}`;
        text(svg, X(it.i) + 13, it.y + 3.5, label, { class: 'viz-label' });
      }
    }
    // Crosshair + one tooltip listing every series at the hovered X.
    const cross = el('line', { y1: m.t, y2: H - m.b, stroke: css('--muted'), 'stroke-width': 1, opacity: 0 }, svg);
    const dots = series.map(s => el('circle', { r: 4, fill: s.color, stroke: css('--panel'), 'stroke-width': 2, opacity: 0 }, svg));
    const hit = el('rect', { x: m.l, y: m.t, width: W - m.l - m.r, height: H - m.t - m.b, fill: 'transparent', tabindex: 0 }, svg);
    let cur = n - 1;
    function show(i, cx, cy) {
      cur = Math.max(0, Math.min(n - 1, i));
      cross.setAttribute('x1', X(cur));
      cross.setAttribute('x2', X(cur));
      cross.setAttribute('opacity', 0.6);
      series.forEach((s, k) => {
        const v = s.values[cur];
        if (v == null || !isFinite(v)) { dots[k].setAttribute('opacity', 0); return; }
        dots[k].setAttribute('cx', X(cur));
        dots[k].setAttribute('cy', Y(v));
        dots[k].setAttribute('opacity', 1);
      });
      const rows = series.map(s => ({ value: s.values[cur] == null ? '—' : yFmt(s.values[cur]), name: s.name, color: s.color }));
      showTip(cx, cy, cfg.tipHead ? cfg.tipHead(xs[cur]) : xFmt(xs[cur]), rows);
    }
    function hide() {
      cross.setAttribute('opacity', 0);
      dots.forEach(d => d.setAttribute('opacity', 0));
      hideTip();
    }
    hit.addEventListener('pointermove', ev => {
      const r = svg.getBoundingClientRect();
      const px = (ev.clientX - r.left) * (W / r.width);
      const i = Math.round(((px - m.l) / (W - m.l - m.r)) * (n - 1));
      show(i, ev.clientX, ev.clientY);
    });
    hit.addEventListener('pointerleave', hide);
    hit.addEventListener('blur', hide);
    hit.addEventListener('focus', () => {
      const r = svg.getBoundingClientRect();
      show(cur, r.left + r.width / 2, r.top + 10);
    });
    hit.addEventListener('keydown', ev => {
      if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
      ev.preventDefault();
      const r = svg.getBoundingClientRect();
      show(cur + (ev.key === 'ArrowRight' ? 1 : -1), r.left + (X(cur) / W) * r.width, r.top + 10);
    });
  }

  // ---------------------------------------------------------------- bet path
  // A bet's price path: each bar's high–low as a hairline, closes as a line,
  // the holding period washed, entry/target/stop as labelled levels, and the
  // entry + exit as dots. Shows plainly that the trade starts after its bar.
  function pricePath(container, cfg) {
    container.replaceChildren();
    const bars = cfg.bars || [];
    if (bars.length < 2) {
      const p = document.createElement('div');
      p.className = 'bet-empty';
      p.textContent = 'Price path unavailable for this bet.';
      container.appendChild(p);
      return;
    }
    const W = Math.max(240, container.clientWidth || 340);
    const H = container.clientHeight || cfg.height || 120;
    const m = { l: 6, r: 70, t: 8, b: 16 };
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'viz-svg', role: 'img', 'aria-label': 'price path around the bet' }, container);
    const levels = [cfg.entry, cfg.target, cfg.stop].filter(v => v != null);
    const [lo0, hi0] = extent(bars.flatMap(b => [b.l, b.h]).concat(levels));
    const pad = (hi0 - lo0) * 0.08 || 0.01;
    const lo = lo0 - pad, hi = hi0 + pad;
    const n = bars.length;
    const step = (W - m.l - m.r) / n;
    const X = i => m.l + (i + 0.5) * step;
    const Y = v => m.t + (1 - (v - lo) / (hi - lo)) * (H - m.t - m.b);
    if (cfg.entry_i != null) {
      const a = cfg.entry_i + 0.5, b = (cfg.exit_i != null ? cfg.exit_i : n - 1) + 0.5;
      el('rect', { x: m.l + a * step, y: m.t, width: Math.max(1, (b - a) * step), height: H - m.t - m.b, fill: css('--viz-wash') }, svg);
    }
    const ink = css('--muted');
    bars.forEach((b, i) => {
      el('line', { x1: X(i), x2: X(i), y1: Y(b.h), y2: Y(b.l), stroke: ink, 'stroke-width': 1, opacity: 0.55 }, svg);
    });
    el('path', {
      d: bars.map((b, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(b.c).toFixed(1)}`).join(''),
      fill: 'none', stroke: css('--text'), 'stroke-width': 1.5, 'stroke-linejoin': 'round', opacity: 0.85,
    }, svg);
    const lvl = [
      { v: cfg.target, name: 'target', color: css('--viz-good') },
      { v: cfg.stop, name: 'stop', color: css('--viz-bad') },
      { v: cfg.entry, name: 'entry', color: css('--muted') },
    ].filter(l => l.v != null);
    const labelItems = lvl.map(l => ({ l, y: Y(l.v), y0: Y(l.v) }));
    spreadLabels(labelItems, 12, m.t + 4, H - m.b - 2);
    for (const it of labelItems) {
      el('line', { x1: m.l, x2: W - m.r + 4, y1: it.y0, y2: it.y0, stroke: it.l.color, 'stroke-width': 1 }, svg);
      el('line', { x1: W - m.r + 6, x2: W - m.r + 14, y1: it.y, y2: it.y, stroke: it.l.color, 'stroke-width': 2 }, svg);
      text(svg, W - m.r + 17, it.y + 3.5, `${it.l.name} ${fmtPrice(it.l.v)}`);
    }
    if (cfg.entry_i != null && bars[cfg.entry_i]) {
      el('circle', { cx: X(cfg.entry_i), cy: Y(cfg.entry != null ? cfg.entry : bars[cfg.entry_i].c), r: 4, fill: css('--text'), stroke: css('--panel-2'), 'stroke-width': 2 }, svg);
    }
    if (cfg.exit_i != null && bars[cfg.exit_i] && cfg.exit != null) {
      const c = cfg.correct ? css('--viz-good') : css('--viz-bad');
      el('circle', { cx: X(cfg.exit_i), cy: Y(cfg.exit), r: 4.5, fill: c, stroke: css('--panel-2'), 'stroke-width': 2 }, svg);
    }
    if (bars[0].t) text(svg, m.l, H - 3, fmtTime(bars[0].t, cfg.withDay));
    if (bars[n - 1].t) text(svg, W - m.r, H - 3, fmtTime(bars[n - 1].t, cfg.withDay), { 'text-anchor': 'end' });
    // Per-bar hover: the bar band is the hit target.
    const hit = el('rect', { x: m.l, y: m.t, width: W - m.l - m.r, height: H - m.t - m.b, fill: 'transparent', tabindex: 0 }, svg);
    const cross = el('line', { y1: m.t, y2: H - m.b, stroke: css('--muted'), 'stroke-width': 1, opacity: 0 }, svg);
    let cur = cfg.entry_i != null ? cfg.entry_i : 0;
    function show(i, cx, cy) {
      cur = Math.max(0, Math.min(n - 1, i));
      cross.setAttribute('x1', X(cur));
      cross.setAttribute('x2', X(cur));
      cross.setAttribute('opacity', 0.5);
      const b = bars[cur];
      const tag = cur === cfg.entry_i ? ' · entry bar' : cur === cfg.exit_i ? ' · exit bar' : '';
      showTip(cx, cy, fmtTime(b.t, true) + tag, [
        { value: fmtPrice(b.c), name: 'close' },
        { value: `${fmtPrice(b.h)} / ${fmtPrice(b.l)}`, name: 'high / low' },
      ]);
    }
    function hide() { cross.setAttribute('opacity', 0); hideTip(); }
    hit.addEventListener('pointermove', ev => {
      const r = svg.getBoundingClientRect();
      const px = (ev.clientX - r.left) * (W / r.width);
      show(Math.floor((px - m.l) / step), ev.clientX, ev.clientY);
    });
    hit.addEventListener('pointerleave', hide);
    hit.addEventListener('blur', hide);
    hit.addEventListener('click', ev => ev.stopPropagation());
    hit.addEventListener('focus', () => {
      const r = svg.getBoundingClientRect();
      show(cur, r.left + (X(cur) / W) * r.width, r.top + 10);
    });
    hit.addEventListener('keydown', ev => {
      if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
      ev.preventDefault();
      ev.stopPropagation();
      const r = svg.getBoundingClientRect();
      show(cur + (ev.key === 'ArrowRight' ? 1 : -1), r.left + (X(cur) / W) * r.width, r.top + 10);
    });
  }

  function fmtPrice(v) {
    if (v == null || !isFinite(v)) return '—';
    return v >= 100 ? v.toFixed(2) : v >= 1 ? v.toFixed(3) : v.toFixed(4);
  }

  // ---------------------------------------------------------------- scatter
  // Labelled scatter with axes crossing at zero (relative-rotation style).
  // One color: identity is carried by the direct labels, not hue.
  function scatter(container, cfg) {
    container.replaceChildren();
    const pts = (cfg.points || []).filter(p => isFinite(p.x) && isFinite(p.y));
    if (!pts.length) return;
    const W = Math.max(280, container.clientWidth || 480);
    const H = cfg.height || 300;
    const m = { l: 40, r: 16, t: 14, b: 32 };
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'viz-svg', role: 'img', 'aria-label': cfg.title || 'scatter' }, container);
    const ax = Math.max(1, ...pts.map(p => Math.abs(p.x))) * 1.15;
    const ay = Math.max(1, ...pts.map(p => Math.abs(p.y))) * 1.15;
    const X = v => m.l + ((v + ax) / (2 * ax)) * (W - m.l - m.r);
    const Y = v => m.t + (1 - (v + ay) / (2 * ay)) * (H - m.t - m.b);
    for (const tv of niceTicks(-ax, ax, 4)) {
      el('line', { x1: X(tv), x2: X(tv), y1: m.t, y2: H - m.b, stroke: css('--viz-grid'), 'stroke-width': 1 }, svg);
      text(svg, X(tv), H - m.b + 13, signed(tv, 0), { 'text-anchor': 'middle' });
    }
    for (const tv of niceTicks(-ay, ay, 4)) {
      el('line', { x1: m.l, x2: W - m.r, y1: Y(tv), y2: Y(tv), stroke: css('--viz-grid'), 'stroke-width': 1 }, svg);
      text(svg, m.l - 6, Y(tv) + 3.5, signed(tv, 0), { 'text-anchor': 'end' });
    }
    el('line', { x1: X(0), x2: X(0), y1: m.t, y2: H - m.b, stroke: css('--viz-axis'), 'stroke-width': 1 }, svg);
    el('line', { x1: m.l, x2: W - m.r, y1: Y(0), y2: Y(0), stroke: css('--viz-axis'), 'stroke-width': 1 }, svg);
    const q = cfg.quadrants || {};
    if (q.tr) text(svg, W - m.r - 4, m.t + 11, q.tr, { 'text-anchor': 'end' });
    if (q.tl) text(svg, m.l + 4, m.t + 11, q.tl);
    if (q.br) text(svg, W - m.r - 4, H - m.b - 5, q.br, { 'text-anchor': 'end' });
    if (q.bl) text(svg, m.l + 4, H - m.b - 5, q.bl);
    if (cfg.xLabel) text(svg, (m.l + W - m.r) / 2, H - 2, cfg.xLabel, { 'text-anchor': 'middle' });
    const color = cfg.color || css('--viz-1');
    for (const p of pts) {
      const cx = X(p.x), cy = Y(p.y);
      el('circle', { cx, cy, r: 4.5, fill: p.color || color, stroke: css('--panel'), 'stroke-width': 2 }, svg);
      const lbl = text(svg, cx + 7, cy + 3.5, p.label, { class: 'viz-label' });
      if (cx > W - m.r - 40) { lbl.setAttribute('x', cx - 7); lbl.setAttribute('text-anchor', 'end'); }
      const hitc = el('circle', { cx, cy, r: 12, fill: 'transparent', tabindex: 0 }, svg);
      const tipRows = () => (p.tip || []).map(r => ({ value: r[1], name: r[0] }));
      hitc.addEventListener('pointerenter', ev => showTip(ev.clientX, ev.clientY, p.title || p.label, tipRows()));
      hitc.addEventListener('pointermove', ev => showTip(ev.clientX, ev.clientY, p.title || p.label, tipRows()));
      hitc.addEventListener('pointerleave', hideTip);
      hitc.addEventListener('focus', () => {
        const r = hitc.getBoundingClientRect();
        showTip(r.right, r.top, p.title || p.label, tipRows());
      });
      hitc.addEventListener('blur', hideTip);
    }
  }

  // ---------------------------------------------------------------- heatmap
  // Correlation-style matrix: diverging washes, values on hover/focus, and
  // only the strong cells labelled.
  function heatmap(container, cfg) {
    container.replaceChildren();
    const labels = cfg.labels || [];
    const k = labels.length;
    if (!k) return;
    const cell = cfg.cell || 30;
    const lw = cfg.labelWidth || 70;
    const W = lw + k * cell + 4, H = lw + k * cell + 4;
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'viz-svg', role: 'img', 'aria-label': cfg.title || 'heatmap', style: `max-width:${W}px` }, container);
    labels.forEach((lab, i) => {
      text(svg, lw - 6, lw + i * cell + cell / 2 + 3.5, lab, { 'text-anchor': 'end' });
      const t = text(svg, 0, 0, lab, { 'text-anchor': 'start' });
      t.setAttribute('transform', `translate(${lw + i * cell + cell / 2 + 3.5},${lw - 6}) rotate(-60)`);
    });
    for (let i = 0; i < k; i++) {
      for (let j = 0; j < k; j++) {
        const v = cfg.value(i, j);
        const x = lw + j * cell, y = lw + i * cell;
        const r = el('rect', { x: x + 1, y: y + 1, width: cell - 2, height: cell - 2, rx: 3, fill: i === j ? css('--viz-grid') : divColor(v, 1), tabindex: i === j ? null : 0 }, svg);
        if (i !== j && v != null && Math.abs(v) >= (cfg.labelAbove || 0.6)) {
          text(svg, x + cell / 2, y + cell / 2 + 3.5, v.toFixed(1).replace('0.', '.'), { 'text-anchor': 'middle', class: 'viz-label', style: 'font-size:9.5px;font-weight:500' });
        }
        if (i === j) continue;
        const head = `${labels[i]} × ${labels[j]}`;
        const rows = [{ value: v == null ? '—' : signed(v, 2), name: cfg.valueName || 'correlation' }];
        r.addEventListener('pointermove', ev => showTip(ev.clientX, ev.clientY, head, rows));
        r.addEventListener('pointerleave', hideTip);
        r.addEventListener('focus', () => {
          const b = r.getBoundingClientRect();
          showTip(b.right, b.top, head, rows);
        });
        r.addEventListener('blur', hideTip);
      }
    }
  }

  return {
    css, el, text, showTip, hideTip, extent, niceTicks, fmtTime, fmtDate, fmtMonth, fmtPrice,
    signed, divColor, sparkline, bars, lineChart, pricePath, scatter, heatmap,
  };
})();
