// System panel on Insights: CPU, Memory, Energy, Disk and Network like
// Activity Monitor, live every 2 s while the panel is on screen (the server
// samples only while someone is watching). Numbers left, ten minutes of
// history in the middle, the apps using the most on the right.
(function () {
  const root = document.getElementById('perf');
  if (!root) return;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const WINDOW_S = 600;
  const TABS = ['cpu', 'memory', 'energy', 'disk', 'network'];
  let tab = 'cpu';
  try { tab = localStorage.getItem('perf-tab') || 'cpu'; } catch { /* private window */ }
  if (!TABS.includes(tab)) tab = 'cpu';
  let data = null;
  let timer = null;
  let onScreen = true;

  const GB = 2 ** 30;
  const gb = (b) => (b >= 10 * GB ? (b / GB).toFixed(1) : (b / GB).toFixed(2)) + ' GB';
  const size = (b) => (b >= GB ? gb(b) : b >= 2 ** 20 ? `${Math.round(b / 2 ** 20)} MB` : `${Math.round(b / 1024)} KB`);
  const disk = (b) => (b >= 1e12 ? `${(b / 1e12).toFixed(2)} TB` : `${Math.round(b / 1e9)} GB`); // decimal, as Finder counts
  const total = (b) => (b >= 1e12 ? `${(b / 1e12).toFixed(2)} TB` : b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${Math.round(b / 1e6)} MB` : `${Math.round(b / 1e3)} KB`);
  const rate = (bps) => (bps >= 1e9 ? `${(bps / 1e9).toFixed(1)} GB/s` : bps >= 1e6 ? `${(bps / 1e6).toFixed(bps >= 1e8 ? 0 : 1)} MB/s` : bps >= 1e3 ? `${Math.round(bps / 1e3)} KB/s` : `${Math.round(bps)} B/s`);
  const pct = (v) => `${v >= 10 ? Math.round(v) : v.toFixed(1)}%`;
  const watts = (w) => `${w >= 10 ? Math.round(w) : w.toFixed(1)} W`;
  const hours = (m) => (m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`);
  // amber at 20% and red at 10%, only while running on the battery
  const lowBattery = (e) => (e.percent == null || e.plugged ? '' : e.percent <= 10 ? 'bad' : e.percent <= 20 ? 'attn' : '');

  // ---------- tabs ----------
  function select(name, focus) {
    tab = name;
    try { localStorage.setItem('perf-tab', tab); } catch { /* ignore */ }
    render();
    reveal();
    if (focus) root.querySelector(`.perf-tabs [data-tab="${tab}"]`).focus();
    schedule(); // fetch now: the server starts the per-app network scan once asked
  }
  function reveal() { // where the strip scrolls sideways (phones), keep the open tab in view
    const strip = root.querySelector('.perf-tabs');
    const b = strip.querySelector(`[data-tab="${tab}"]`);
    if (b.offsetLeft < strip.scrollLeft || b.offsetLeft + b.offsetWidth > strip.scrollLeft + strip.clientWidth) {
      strip.scrollLeft = b.offsetLeft - (strip.clientWidth - b.offsetWidth) / 2;
    }
  }
  root.querySelectorAll('.perf-tabs [data-tab]').forEach((b) => b.addEventListener('click', () => select(b.dataset.tab)));
  root.querySelector('.perf-tabs').addEventListener('keydown', (e) => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    select(TABS[(TABS.indexOf(tab) + step + TABS.length) % TABS.length], true);
  });

  function tabValues(s) {
    const cpu = 100 - s.cpu.idle;
    const m = s.memory;
    const e = s.energy || {};
    const n = s.network || {};
    const set = (id, text, cls) => { const el = $(id); el.textContent = text; el.className = `t-val ${cls || ''}`; };
    set('pt-cpu', pct(cpu), cpu >= 90 ? 'attn' : '');
    set('pt-memory', gb(m.used), m.pressure === 'critical' ? 'bad' : m.pressure === 'warning' ? 'attn' : '');
    // the power draw, or the battery level once it runs low
    const low = lowBattery(e);
    set('pt-energy', low ? `${e.percent}%` : e.power_w != null ? watts(e.power_w) : e.percent != null ? `${e.percent}%` : '—', low);
    set('pt-disk', rate(s.disk.read_bps + s.disk.write_bps), '');
    set('pt-network', rate((n.in_bps || 0) + (n.out_bps || 0)), '');
  }

  // ---------- numbers ----------
  const row = (k, v, cls) => `<dt>${esc(k)}</dt><dd class="${cls || ''}">${esc(v)}</dd>`;
  const meter = (frac, cls) => `<div class="perf-meter"><span class="${cls || ''}" style="width:${Math.max(0, Math.min(100, frac * 100)).toFixed(1)}%"></span></div>`;

  function stats(s) {
    if (tab === 'cpu') {
      const used = 100 - s.cpu.idle;
      return `<div class="perf-big ${used >= 90 ? 'attn' : ''}">${pct(used)}</div>
        <div class="perf-big-sub">of ${s.cores} cores busy</div>
        <dl class="perf-rows">${row('User', pct(s.cpu.user))}${row('System', pct(s.cpu.system))}${row('Idle', pct(s.cpu.idle))}
        ${row('Load average', s.load.map((x) => x.toFixed(1)).join('  '))}${row('Processes', String(s.processes))}</dl>`;
    }
    if (tab === 'memory') {
      const m = s.memory;
      const swapFrac = m.swap_total ? m.swap_used / m.swap_total : 0;
      const swapCls = swapFrac >= 0.9 ? 'bad' : swapFrac >= 0.75 ? 'attn' : '';
      const pCls = m.pressure === 'critical' ? 'bad' : m.pressure === 'warning' ? 'attn' : '';
      return `<div class="perf-big ${pCls}">${gb(m.used)}</div>
        <div class="perf-big-sub">used of ${gb(m.total)}</div>
        <dl class="perf-rows">${row('Pressure', m.pressure.charAt(0).toUpperCase() + m.pressure.slice(1), pCls)}
        ${row('App memory', gb(m.app || 0))}${row('Wired', gb(m.wired || 0))}${row('Compressed', gb(m.compressed || 0))}${row('Cached files', gb(m.cached || 0))}
        ${row('Swap used', `${(m.swap_used / GB).toFixed(1)} of ${gb(m.swap_total)}`, swapCls)}${meter(swapFrac, swapCls)}</dl>`;
    }
    if (tab === 'energy') {
      const e = s.energy || {};
      const low = lowBattery(e);
      let rows = '';
      if (e.percent != null) {
        rows += row('Battery', `${e.percent}%`, low) + meter(e.percent / 100, low);
        rows += row('Power source', e.plugged ? `Adapter${e.adapter_w ? `, ${e.adapter_w} W` : ''}` : 'Battery');
        if (!e.plugged) rows += row('Time left', e.minutes_left != null ? hours(e.minutes_left) : 'Calculating…');
        else if (e.charging) rows += row('Full in', e.minutes_left != null ? hours(e.minutes_left) : 'Calculating…');
        else rows += row('Status', e.full ? 'Fully charged' : 'Not charging');
        if (e.health != null) rows += row('Max capacity', `${e.health}%`, e.health < 80 ? 'attn' : '');
        if (e.cycles != null) rows += row('Cycle count', String(e.cycles));
      }
      return `<div class="perf-big">${e.power_w != null ? watts(e.power_w) : '—'}</div>
        <div class="perf-big-sub">${e.power_w == null ? 'No power reading on this Mac.' : e.power_live ? 'the whole Mac is drawing now' : 'the whole Mac, as of the battery’s last reading'}</div>
        <dl class="perf-rows">${rows}</dl>${awake(e.keeping_awake)}`;
    }
    if (tab === 'network') {
      const n = s.network || {};
      return `<div class="perf-big">${rate((n.in_bps || 0) + (n.out_bps || 0))}</div>
        <div class="perf-big-sub">received and sent right now</div>
        <dl class="perf-rows">${row('Receiving', rate(n.in_bps || 0))}${row('Sending', rate(n.out_bps || 0))}
        ${row('Packets in', `${Math.round(n.packets_in_ps || 0)}/s`)}${row('Packets out', `${Math.round(n.packets_out_ps || 0)}/s`)}
        ${row('Received since boot', total(n.total_in || 0))}${row('Sent since boot', total(n.total_out || 0))}</dl>`;
    }
    const d = s.disk;
    const c = d.capacity;
    const freeFrac = c.total ? c.free / c.total : 1;
    const capCls = freeFrac <= 0.05 ? 'bad' : freeFrac <= 0.1 ? 'attn' : '';
    return `<div class="perf-big">${rate(d.read_bps + d.write_bps)}</div>
      <div class="perf-big-sub">read and written right now</div>
      <dl class="perf-rows">${row('Read', rate(d.read_bps))}${row('Written', rate(d.write_bps))}
      ${row('Reads', `${Math.round(d.reads_ps)}/s`)}${row('Writes', `${Math.round(d.writes_ps)}/s`)}
      ${row('Free', `${disk(c.free)} of ${disk(c.total)}`, capCls)}${meter(1 - freeFrac, capCls)}</dl>`;
  }

  // what is holding the Mac awake (pmset assertions), by app
  function awake(list) {
    if (!list) return '';
    const items = list.map((b) => `<li title="${esc(`${b.process}, pid ${b.pid}, holding it for ${b.held}`)}">
        <span class="app">${appName(b.app)}</span><span class="why">${esc(b.reason)}${b.kind === 'display' ? ', display on' : ''}</span></li>`).join('');
    return `<div class="perf-awake"><h3>Keeping the Mac awake</h3>${items ? `<ul>${items}</ul>` : '<p>Nothing right now.</p>'}</div>`;
  }

  // ---------- chart ----------
  function chart(hist, now, s) {
    const svg = $('perf-chart');
    const W = Math.max(200, svg.clientWidth || 600);
    const H = Math.max(120, svg.clientHeight || 160);
    const top = 16, bottom = 18;
    const plotH = H - top - bottom;
    const x = (t) => ((t - (now - WINDOW_S)) / WINDOW_S) * W;
    // energy and network history started later; points without a reading are gaps
    const has = { energy: (p) => p.power_w != null, network: (p) => p.in_bps != null }[tab] || (() => true);
    const pts = hist.filter((p) => p.t >= now - WINDOW_S && has(p));
    // break lines where sampling paused (nobody watching)
    const runs = [];
    for (const p of pts) {
      const last = runs.length ? runs[runs.length - 1] : null;
      if (!last || p.t - last[last.length - 1].t > 25) runs.push([p]); else last.push(p); // 2 s live, 10 s in the background
    }
    let body = '';
    let maxLabel = '';
    const area = (run, lo, hi, cls) => {
      if (run.length < 2) return '';
      const yLo = run.map((p) => top + plotH - lo(p) * plotH);
      const yHi = run.map((p) => top + plotH - hi(p) * plotH);
      const up = run.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${yHi[i].toFixed(1)}`).join('');
      const down = run.map((p, i) => `L${x(p.t).toFixed(1)},${yLo[i].toFixed(1)}`).reverse().join('');
      return `<path class="${cls}" d="${up}${down}Z"/>`;
    };
    const line = (run, f, cls) => run.length < 2 ? '' : `<path class="${cls}" d="${run.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${(top + plotH - f(p) * plotH).toFixed(1)}`).join('')}"/>`;
    // two lines on one auto scale: disk read/written, network received/sent
    const pair = (a, b, floor) => {
      const scale = niceMax(Math.max(floor, ...pts.map((p) => Math.max(p[a], p[b]))));
      maxLabel = rate(scale);
      for (const r of runs) {
        body += line(r, (p) => p[a] / scale, 'l-read');
        body += line(r, (p) => p[b] / scale, 'l-write');
      }
    };
    if (tab === 'cpu') {
      maxLabel = '100%';
      for (const r of runs) {
        body += area(r, (p) => p.system / 100, (p) => (p.system + p.user) / 100, 'a-user');
        body += area(r, () => 0, (p) => p.system / 100, 'a-system');
      }
      $('perf-legend').innerHTML = '<span><i class="usr"></i>User</span><span><i class="sys"></i>System</span>';
    } else if (tab === 'memory') {
      const total = s.memory.total || 1;
      maxLabel = gb(total);
      for (const r of runs) {
        // one area per stretch of the same pressure, so the graph turns amber or red where it did
        let seg = [r[0]];
        for (let i = 1; i <= r.length; i++) {
          const p = r[i];
          if (!p || p.pressure !== seg[0].pressure) {
            const withNext = p ? [...seg, p] : seg;
            body += area(withNext, () => 0, (q) => q.mem_used / total, `a-mem ${seg[0].pressure}`);
            seg = p ? [p] : [];
          } else seg.push(p);
        }
      }
      $('perf-legend').innerHTML = '<span><i class="usr"></i>Memory used</span><span>amber or red where memory pressure rose</span>';
    } else if (tab === 'energy') {
      const scale = niceMax(Math.max(10, ...pts.map((p) => p.power_w)));
      maxLabel = `${scale} W`;
      for (const r of runs) body += area(r, () => 0, (p) => p.power_w / scale, 'a-user');
      $('perf-legend').innerHTML = pts.length || s.energy?.power_w != null
        ? '<span><i class="usr"></i>Power drawn by the whole Mac</span>' : '<span>No power reading on this Mac</span>';
    } else if (tab === 'network') {
      pair('in_bps', 'out_bps', 1e5);
      $('perf-legend').innerHTML = '<span><i></i>Received</span><span><i class="dash"></i>Sent</span>';
    } else {
      pair('read_bps', 'write_bps', 1e6);
      $('perf-legend').innerHTML = '<span><i></i>Read</span><span><i class="dash"></i>Written</span>';
    }
    const grid = [0, 0.5, 1].map((f) => `<line class="grid" x1="0" x2="${W}" y1="${(top + plotH - f * plotH).toFixed(1)}" y2="${(top + plotH - f * plotH).toFixed(1)}"/>`).join('');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.innerHTML = `${grid}${body}<text x="0" y="11">${esc(maxLabel)}</text>
      <text x="0" y="${H - 3}">10 min ago</text><text x="${W}" y="${H - 3}" text-anchor="end">now</text>`;
  }
  function niceMax(v) {
    const p = 10 ** Math.floor(Math.log10(v));
    return [1, 2, 5, 10].map((m) => m * p).find((m) => m >= v) || v;
  }

  // ---------- top apps ----------
  // "next-server · portfolio": the project part follows private mode like every project name
  function appName(name) {
    const [runtime, project] = String(name).split(' · ');
    return project && window.Privacy ? `${esc(runtime)} · ${window.Privacy.pv(project, project)}` : esc(name);
  }
  function plainName(name) { // for tooltips, which private mode cannot blur
    const [runtime, project] = String(name).split(' · ');
    return project && window.Privacy ? `${runtime} · ${window.Privacy.label(project)}` : String(name);
  }
  const VIEWS = {
    cpu: { noun: 'CPU', value: (a) => a.cpu, label: (a) => pct(a.cpu), note: '100% is one full core.' },
    memory: { noun: 'memory', value: (a) => a.memory, label: (a) => size(a.memory), note: 'Physical footprint, as Activity Monitor counts it.' },
    energy: {
      noun: 'energy', value: (a) => a.energy, label: (a) => a.energy.toFixed(1),
      detail: (a) => `${pct(a.cpu)} CPU, ${a.wakeups} wakeups/s`,
      note: 'Relative impact from CPU time and wakeups, as Activity Monitor estimates it. The watts are measured.',
    },
    disk: {
      noun: 'disk', value: (a) => a.read_bps + a.write_bps, label: (a) => rate(a.read_bps + a.write_bps),
      detail: (a) => `reading ${rate(a.read_bps)}, writing ${rate(a.write_bps)}`,
      empty: 'No app is reading or writing right now.', note: 'System processes report no disk figure without root.',
    },
    network: {
      noun: 'network', value: (a) => a.in_bps + a.out_bps, label: (a) => rate(a.in_bps + a.out_bps),
      detail: (a) => `receiving ${rate(a.in_bps)}, sending ${rate(a.out_bps)}`,
      empty: 'No app sent or received anything in the last 2 s.',
      note: 'Per app from nettop, without localhost. Background traffic such as broadcasts belongs to no app.',
    },
  };
  function topApps(s) {
    const v = VIEWS[tab];
    const list = s.top[tab] || [];
    const max = Math.max(1e-9, ...list.map(v.value));
    $('perf-top-h').textContent = `Using the most ${v.noun}`;
    const shown = list.filter((a) => v.value(a) > 0);
    const measuring = tab === 'network' && !s.network?.apps_live;
    $('perf-top').innerHTML = measuring ? '<li class="note">Measuring each app’s traffic…</li>'
      : shown.map((a) => `<li>
        <span class="app" title="${esc([plainName(a.app), a.processes > 1 ? `${a.processes} processes` : '', v.detail ? v.detail(a) : '', a.system ? 'system process: CPU and memory from ps' : ''].filter(Boolean).join(', '))}">${appName(a.app)}${a.processes > 1 ? `<small>${a.processes}</small>` : ''}</span>
        <span class="bar"><span style="width:${(100 * v.value(a) / max).toFixed(1)}%"></span></span>
        <span class="val">${esc(v.label(a))}</span>
      </li>`).join('') || `<li class="note">${esc(v.empty || 'Nothing measurable right now.')}</li>`;
    $('perf-top-note').textContent = v.note;
  }

  function render() {
    root.querySelectorAll('.perf-tabs [data-tab]').forEach((b) => {
      const on = b.dataset.tab === tab;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1; // arrow keys move between tabs
    });
    if (!data || !data.sample) return;
    const s = data.sample;
    tabValues(s);
    $('perf-stats').innerHTML = stats(s);
    chart(data.history || [], s.t, s);
    topApps(s);
  }

  // ---------- polling: only while the panel is on screen ----------
  async function poll() {
    try {
      const r = await fetch(`/api/perf?tab=${encodeURIComponent(tab)}`);
      const d = await r.json();
      if (d.available === false) {
        $('perf-stats').innerHTML = `<p class="perf-empty">${esc(d.reason || 'Not available on this machine.')}</p>`;
        return;
      }
      data = d;
      render();
    } catch { /* server restarting; try again next tick */ }
  }
  function schedule() {
    const live = onScreen && !document.hidden;
    $('perf-live').textContent = live ? 'live, every 2 s' : 'paused while hidden';
    $('perf-live').className = `perf-live ${live ? '' : 'paused'}`;
    clearInterval(timer);
    timer = null;
    if (live) { poll(); timer = setInterval(poll, 2000); }
  }
  if ('IntersectionObserver' in window) {
    new IntersectionObserver((entries) => { onScreen = entries.some((e) => e.isIntersecting); schedule(); }).observe(root);
  }
  document.addEventListener('visibilitychange', schedule);
  window.addEventListener('resize', () => { if (data) render(); });
  window.addEventListener('privacy', () => { if (data) render(); });
  render();
  reveal();
  schedule();
})();
