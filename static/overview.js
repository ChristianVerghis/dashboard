// Overview panels for the index page: the "this week" band (headline numbers
// + where commits went), and the loose-ends lists (going stale / not pushed).
// Data comes from what app.js already fetches: the projects snapshot (SSE),
// /api/heatmap (per-day commits with a per-project breakdown, local dates) and
// /api/services. app.js calls renderOverview() whenever any of those refresh.

let _ovHeatmap = null;   // last /api/heatmap payload
let _ovServices = null;  // last /api/services payload
let _ovSpend = null;     // last /api/claude/spend payload

function overviewSetHeatmap(data) { _ovHeatmap = data; renderOverview(); }
function overviewSetServices(data) { _ovServices = data; renderOverview(); }

function renderOverview() {
  const list = Array.isArray(projects) ? projects : [];
  if (_ovHeatmap) {
    renderWeekBand(_ovHeatmap, list, _ovServices);
    renderRhythm(_ovHeatmap);
    renderReview(_ovHeatmap, list, _ovServices);
  }
  renderLooseEnds(list);
}

// ---- This week -----------------------------------------------------------

function weekStats(hm) {
  const days = hm.days || [];
  const last7 = days.slice(-7);
  const prev7 = days.slice(-14, -7);
  const byProject = {};
  let commits = 0;
  for (const d of last7) {
    commits += d.count;
    for (const [name, n] of Object.entries(d.by_project || {})) byProject[name] = (byProject[name] || 0) + n;
  }
  const prevCommits = prev7.reduce((a, d) => a + d.count, 0);
  // Streak: consecutive days with at least one commit, ending today or yesterday.
  let streak = 0;
  let i = days.length - 1;
  if (i >= 0 && days[i].count === 0) i -= 1; // today can still be in progress
  for (; i >= 0 && days[i].count > 0; i--) streak += 1;
  return {
    commits, prevCommits, byProject,
    touched: Object.keys(byProject).length,
    streak,
    spark14: days.slice(-14).map(d => d.count),
    activeDays7: last7.filter(d => d.count > 0).length,
  };
}

function sparkArea(counts, w, h) {
  if (!counts.length) return '';
  const max = Math.max(1, ...counts);
  const step = counts.length > 1 ? w / (counts.length - 1) : w;
  const pts = counts.map((c, i) => [i * step, h - (c / max) * (h - 2) - 1]);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${line} L${w},${h} L0,${h} Z`;
  return `<svg class="stat-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
    <path d="${area}" class="stat-spark-area"/><path d="${line}" class="stat-spark-line"/></svg>`;
}

function renderWeekBand(hm, list, services) {
  const band = document.getElementById('week-band');
  if (!band) return;
  const s = weekStats(hm);
  const svcs = services?.services || [];
  const live = svcs.filter(x => (x.status || 'active') === 'active'); // dormant / incubating services are not "down"
  const parkedSvcs = svcs.length - live.length;
  const up = live.filter(x => x.up).length;
  const delta = s.commits - s.prevCommits;
  const deltaText = s.prevCommits || s.commits
    ? (delta === 0 ? 'same as last week' : `${delta > 0 ? '+' : '−'}${Math.abs(delta)} vs last week`)
    : 'nothing yet';
  const stats = [
    { v: s.commits, k: 'commits this week', sub: deltaText, spark: s.spark14 },
    { v: s.touched, k: s.touched === 1 ? 'project touched' : 'projects touched', sub: `${s.activeDays7} of 7 days active` },
    { v: live.length ? `${up}/${live.length}` : '—', k: 'services up', sub: live.length ? (up === live.length ? 'all running' : `${live.length - up} down`) + (parkedSvcs ? `, ${parkedSvcs} parked` : '') : 'none declared', bad: live.length && up < live.length },
    { v: s.streak, k: s.streak === 1 ? 'day streak' : 'day streak', sub: s.streak ? 'consecutive days with a commit' : 'no commit yesterday or today' },
  ];
  document.getElementById('stat-row').innerHTML = stats.map(t => `
    <div class="stat ${t.bad ? 'is-bad' : ''}">
      ${t.spark ? sparkArea(t.spark, 160, 48) : ''}
      <div class="stat-v">${escapeHtml(String(t.v))}</div>
      <div class="stat-k">${escapeHtml(t.k)}</div>
      <div class="stat-sub">${escapeHtml(t.sub)}</div>
    </div>`).join('');

  // Allocation bar: one segment per project, ordered by share, 2px gaps.
  const entries = Object.entries(s.byProject).sort((a, b) => b[1] - a[1]);
  const bar = document.getElementById('alloc-bar');
  const legend = document.getElementById('alloc-legend');
  const summary = document.getElementById('alloc-summary');
  if (!entries.length) {
    bar.innerHTML = '<div class="alloc-empty">No commits in the last 7 days.</div>';
    legend.innerHTML = '';
    summary.textContent = '';
  } else {
    const total = entries.reduce((a, [, n]) => a + n, 0);
    bar.innerHTML = entries.map(([name, n]) => {
      const pct = (n / total) * 100;
      // native tooltip: the name is left out for private projects while private mode is on (counts stay)
      const tipName = Privacy.on && Privacy.isPrivate(name) ? '' : `${escapeHtml(name)} · `;
      return `<a class="alloc-seg" href="/project/${encodeURIComponent(name)}" style="flex-basis:${pct.toFixed(2)}%; background:${projectColor(name)}" title="${tipName}${n} commit${n === 1 ? '' : 's'} · ${Math.round(pct)}%"></a>`;
    }).join('');
    const top = entries.slice(0, 6);
    const rest = entries.slice(6).reduce((a, [, n]) => a + n, 0);
    const maxN = top[0][1];
    legend.innerHTML = top.map(([name, n]) => `
      <a class="alloc-item" href="/project/${encodeURIComponent(name)}">
        <span class="alloc-swatch" style="background:${projectColor(name)}"></span>
        <span class="alloc-name">${Privacy.pv(name, name)}</span>
        <span class="alloc-track"><i style="width:${(n / maxN * 100).toFixed(1)}%; background:${projectColor(name)}"></i></span>
        <span class="alloc-n">${n}</span>
      </a>`).join('') + (rest ? `<div class="alloc-item is-rest"><span class="alloc-swatch is-rest"></span><span class="alloc-name">${entries.length - 6} more</span><span class="alloc-track"><i style="width:${(rest / maxN * 100).toFixed(1)}%"></i></span><span class="alloc-n">${rest}</span></div>` : '');
    summary.textContent = `${total} commits across ${entries.length} project${entries.length === 1 ? '' : 's'}`;
  }
  renderFocusStrip(hm, list);
  band.classList.remove('skeleton');
  band.hidden = false;
}

// Focus: how many projects got commits each day, last 14 days. One or two is
// focus, three is a busy day, four or more is thrash. Plus a callout when
// commits went to projects whose manifest says they are parked.
function renderFocusStrip(hm, list) {
  const host = document.getElementById('focus-strip');
  if (!host) return;
  const days = (hm.days || []).slice(-14);
  const cells = days.map(d => {
    const n = Object.keys(d.by_project || {}).length;
    const cls = n === 0 ? 'f0' : n <= 2 ? 'f1' : n === 3 ? 'f2' : 'f3';
    const label = new Date(d.date + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    return `<span class="fc ${cls}" title="${label}: ${n} project${n === 1 ? '' : 's'}, ${d.count} commit${d.count === 1 ? '' : 's'}">${n || ''}</span>`;
  }).join('');
  const parked = new Set(['dormant', 'parked', 'archived', 'paused']);
  const status = Object.fromEntries(list.map(p => [p.name, p.manifest?.status]));
  const drift = {};
  for (const d of days.slice(-7)) {
    for (const [name, n] of Object.entries(d.by_project || {})) {
      if (parked.has(status[name])) drift[name] = (drift[name] || 0) + n;
    }
  }
  const driftNames = Object.entries(drift).sort((a, b) => b[1] - a[1]);
  const driftTotal = driftNames.reduce((a, [, n]) => a + n, 0);
  host.innerHTML = `
    <div class="focus-head"><span>Projects touched per day</span><span class="muted small">last 14 days</span></div>
    <div class="focus-cells">${cells}</div>
    ${driftTotal ? `<div class="focus-drift">${driftTotal} commit${driftTotal === 1 ? '' : 's'} this week went to parked projects: ${driftNames.map(([n]) => `<a href="/project/${encodeURIComponent(n)}">${Privacy.pv(n, n)}</a>`).join(', ')}</div>` : ''}`;
}

// ---- Loose ends -----------------------------------------------------------

function ageDays(p) {
  return p.last_commit ? p.last_commit.age_seconds / 86400 : Infinity;
}
function ageBucket(days) {
  if (days < 3) return 'fresh';
  if (days < 14) return 'warm';
  if (days < 45) return 'cold';
  return 'dead';
}
function fmtDays(days) {
  if (!isFinite(days)) return 'never';
  if (days < 1) return 'today';
  const d = Math.floor(days);
  if (d < 30) return `${d}d`;
  if (d < 365) return `${Math.floor(d / 30)}mo`;
  return `${(d / 365).toFixed(1)}y`;
}
function isComplete(p) {
  const st = p.manifest?.status;
  return p.signals?.verdict?.level === 'complete' || st === 'archived' || st === 'complete';
}

function renderLooseEnds(list) {
  const wrap = document.getElementById('loose-ends');
  if (!wrap) return;
  const stale = list
    .filter(p => p.has_git && !isComplete(p))
    .map(p => ({ p, days: ageDays(p) }))
    .filter(x => x.days >= 7)
    .sort((a, b) => b.days - a.days)
    .slice(0, 8);
  const unpushed = list
    .filter(p => p.has_git && ((p.git_state?.ahead || 0) > 0 || (p.git_state?.dirty_count || 0) > 0))
    .sort((a, b) => ((b.git_state.ahead || 0) + (b.git_state.dirty_count || 0)) - ((a.git_state.ahead || 0) + (a.git_state.dirty_count || 0)));

  const staleEl = document.getElementById('stale-list');
  staleEl.innerHTML = stale.length ? stale.map(({ p, days }) => `
    <li><a class="le-row" href="/project/${encodeURIComponent(p.name)}">
      <span class="pt-dot age-${ageBucket(days)}" aria-hidden="true"></span>
      <span class="le-name">${Privacy.pv(p.name, p.name)}</span>
      <span class="le-note">${p.last_commit ? Privacy.pv(p.last_commit.subject.slice(0, 60), p.name) : 'no commits'}</span>
      <span class="le-n">${fmtDays(days)}</span>
    </a></li>`).join('') : '<li class="le-empty">Nothing has gone quiet for more than a week.</li>';
  document.getElementById('stale-summary').textContent = stale.length ? `${stale.length} quiet for 7+ days` : '';

  const unEl = document.getElementById('unpushed-list');
  unEl.innerHTML = unpushed.length ? unpushed.map(p => {
    const gs = p.git_state;
    const bits = [];
    if (gs.ahead) bits.push(`${gs.ahead} unpushed`);
    if (gs.dirty_count) bits.push(`${gs.dirty_count} uncommitted`);
    if (!gs.has_remote) bits.push('no remote');
    return `<li><a class="le-row" href="/project/${encodeURIComponent(p.name)}">
      <span class="le-mark ${gs.ahead ? 'is-ahead' : ''}" aria-hidden="true"></span>
      <span class="le-name">${Privacy.pv(p.name, p.name)}</span>
      <span class="le-note">${Privacy.pv(p.branch || '', p.name)}</span>
      <span class="le-n">${escapeHtml(bits.join(' · '))}</span>
    </a></li>`;
  }).join('') : '<li class="le-empty">Everything is committed and pushed.</li>';
  const ahead = unpushed.reduce((a, p) => a + (p.git_state.ahead || 0), 0);
  const dirty = unpushed.reduce((a, p) => a + (p.git_state.dirty_count || 0), 0);
  document.getElementById('unpushed-summary').textContent = unpushed.length ? `${ahead} commits · ${dirty} files` : '';
  wrap.hidden = false;
}


// ---- Rhythm: maker blocks + code frequency + ships --------------------------

function fmtMin(m) {
  if (!m) return '0m';
  if (m < 60) return `${Math.round(m)}m`;
  const h = m / 60;
  return `${h >= 10 ? Math.round(h) : h.toFixed(1)}h`;
}

function renderRhythm(hm) {
  const wrap = document.getElementById('rhythm');
  if (!wrap || !hm.sessions) return;
  const s = hm.sessions;
  const max = Math.max(1, ...s.hist.map(b => b.n));
  const delta = s.median_30d - s.median_prev_30d;
  document.getElementById('blocks').innerHTML = `
    <div class="blocks-stats">
      <div><span class="bk-v">${s.count_30d}</span><span class="bk-k">sessions, 30 days</span></div>
      <div><span class="bk-v">${fmtMin(s.median_30d)}</span><span class="bk-k">median block${s.median_prev_30d ? ` · ${delta === 0 ? 'same as' : (delta > 0 ? '+' : '−') + fmtMin(Math.abs(delta)) + ' vs'} last month` : ''}</span></div>
      <div><span class="bk-v">${fmtMin(s.longest_30d)}</span><span class="bk-k">longest block</span></div>
    </div>
    <div class="blocks-hist">${s.hist.map(b => `
      <div class="bk-row"><span class="bk-label">${escapeHtml(b.label)}</span><span class="bk-bar"><i style="width:${(b.n / max * 100).toFixed(1)}%"></i></span><span class="bk-n">${b.n}</span></div>`).join('')}</div>
    <div class="hs-note">A block is a run of commits less than 45 minutes apart, across all repos. ${s.blocks_over_90m_30d} block${s.blocks_over_90m_30d === 1 ? '' : 's'} over 90 minutes this month.</div>`;
  document.getElementById('blocks-summary').textContent = 'last 30 days';

  // Code frequency: mirrored weekly bars, last 26 weeks.
  const cf = (hm.codefreq || []).slice(-26);
  const peak = Math.max(1, ...cf.flat());
  const w = 26 * 14, h = 96, mid = h / 2;
  const bars = cf.map(([a, d], i) => {
    const x = i * 14 + 2;
    const ah = Math.round((a / peak) * (mid - 4));
    const dh = Math.round((d / peak) * (mid - 4));
    return `<rect class="cf-add" x="${x}" y="${mid - ah}" width="10" height="${ah}" rx="1.5"><title>+${a.toLocaleString()} lines</title></rect>
            <rect class="cf-del" x="${x}" y="${mid}" width="10" height="${dh}" rx="1.5"><title>−${d.toLocaleString()} lines</title></rect>`;
  }).join('');
  const adds = cf.reduce((t, [a]) => t + a, 0), dels = cf.reduce((t, [, d]) => t + d, 0);
  document.getElementById('codefreq').innerHTML = `<svg viewBox="0 0 ${w} ${h}" class="cf" preserveAspectRatio="none"><line x1="0" x2="${w}" y1="${mid}" y2="${mid}" class="cf-axis"/>${bars}</svg>
    <div class="cf-legend"><span><i class="cf-add"></i>+${adds.toLocaleString()} added</span><span><i class="cf-del"></i>−${dels.toLocaleString()} removed</span><span class="muted">26 weeks, oldest left</span></div>`;
  const wk = cf[cf.length - 1] || [0, 0];
  document.getElementById('codefreq-summary').textContent = `this week +${wk[0].toLocaleString()} / −${wk[1].toLocaleString()}`;

  const tags = (hm.tags || []).slice(0, 6);
  document.getElementById('ships').innerHTML = tags.length
    ? `<div class="ships-title">Shipped (tags)</div>` + tags.map(t => `<a class="ship" href="/project/${encodeURIComponent(t.project)}"><span class="ship-proj">${Privacy.pv(t.project, t.project)}</span><span class="ship-tag">${Privacy.pv(t.tag, t.project)}</span><span class="ship-age muted">${t.age_days === 0 ? 'today' : t.age_days + 'd ago'}</span></a>`).join('')
    : `<div class="ships-title muted">No tags in the last 12 months. Commits are motion; tags are shipping.</div>`;
  wrap.hidden = false;
}

// ---- Weekly review ---------------------------------------------------------

function renderReview(hm, list, services) {
  const el = document.getElementById('review');
  if (!el) return;
  const s = weekStats(hm);
  const sess = hm.sessions || {};
  const wkTags = (hm.tags || []).filter(t => t.age_days <= 7);
  const parked = new Set(['dormant', 'parked', 'archived', 'paused']);
  const silent = list.filter(p => p.has_git && !isComplete(p) && !parked.has(p.manifest?.status) && ageDays(p) >= 28);
  const svcs = (services?.services || []).filter(x => (x.status || 'active') === 'active');
  const down = svcs.filter(x => !x.up);
  const items = [];
  items.push(`<b>${s.commits}</b> commits across <b>${s.touched}</b> project${s.touched === 1 ? '' : 's'}, ${s.prevCommits ? `${s.commits >= s.prevCommits ? 'up' : 'down'} from ${s.prevCommits} last week` : 'first active week in a while'}.`);
  items.push(`<b>${sess.blocks_over_90m_30d ?? 0}</b> focused block${sess.blocks_over_90m_30d === 1 ? '' : 's'} over 90 minutes this month; median session ${fmtMin(sess.median_30d || 0)}${sess.median_30d && sess.median_30d < 20 ? ', mostly single-commit sessions' : ''}.`);
  // Bullets keep their numbers readable; only the project / tag / service names they cite are pv-wrapped.
  items.push(wkTags.length ? `Shipped ${wkTags.map(t => `<b>${Privacy.pv(`${t.project} ${t.tag}`, t.project)}</b>`).join(', ')}.` : 'Nothing tagged this week.');
  if (silent.length) items.push(`<b>${silent.length}</b> active project${silent.length === 1 ? ' has' : 's have'} had no commit for 4+ weeks: ${silent.slice(0, 5).map(p => `<a href="/project/${encodeURIComponent(p.name)}">${Privacy.pv(p.name, p.name)}</a>`).join(', ')}${silent.length > 5 ? ` and ${silent.length - 5} more` : ''}. Park or kill?`);
  if (down.length) items.push(`${down.length} declared service${down.length === 1 ? ' is' : 's are'} down: ${down.map(x => Privacy.pv(x.name, x.name)).join(', ')}.`);
  const st = hm.steward?.days_with_digest_30d;
  if (st !== undefined) items.push(`Nightly steward left a digest on <b>${st}</b> of the last 30 nights.`);
  if (_ovSpend && _ovSpend.total) {
    const t = _ovSpend.total;
    const top = (_ovSpend.by_project || []).filter(r => r.project !== '(outside projects)').slice(0, 3);
    items.push(`<b>${t.sessions}</b> Claude session${t.sessions === 1 ? '' : 's'} this week, ${Math.round(t.minutes / 60 * 10) / 10}h active, ${t.output_tokens >= 1e6 ? (t.output_tokens / 1e6).toFixed(1) + 'M' : Math.round(t.output_tokens / 1e3) + 'k'} output tokens${top.length ? `, mostly in ${top.map(r => Privacy.pv(r.project, r.project)).join(', ')}` : ''}.`);
  }
  document.getElementById('review-body').innerHTML = items.map(i => `<li>${i}</li>`).join('');
  document.getElementById('review-line').textContent = `${s.commits} commits · ${s.touched} projects · ${sess.blocks_over_90m_30d ?? 0} deep blocks · ${wkTags.length} shipped`;
  el.hidden = false;
}


// Hydrate from the browser cache on load: app.js runs before this module, so
// its cached-heatmap call happens before overviewSetHeatmap exists. Pull the
// same cache here so the week band, rhythm and review paint in the first frame.
(function () {
  if (typeof cache === 'undefined') return;
  const hm = cache.get('heatmap');
  const sv = cache.get('services');
  if (hm) _ovHeatmap = hm;
  if (sv) _ovServices = sv;
  if (hm || sv) renderOverview();
})();


// Claude usage for the review line: cheap, cached server-side, refreshed every 5 min.
(async function loadSpend() {
  try {
    const r = await fetch('/api/claude/spend?days=7');
    if (r.ok) { _ovSpend = await r.json(); if (typeof cache !== 'undefined') cache.set('spend', _ovSpend); renderOverview(); }
  } catch { /* silent */ }
  setTimeout(loadSpend, 300000);
})();
