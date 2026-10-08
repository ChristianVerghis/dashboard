// Routines: local launchd jobs (next run on launchd's real clock, last run from
// each job's own log) and cloud routines (judged by what they commit).
(function () {
  const S = window.Shell;
  const { esc, pv, px, mark } = S;
  const $ = (id) => document.getElementById(id);

  const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  function when(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    const today = new Date();
    const tomorrow = new Date(); tomorrow.setDate(today.getDate() + 1);
    const day = d.toDateString() === today.toDateString() ? 'today'
      : d.toDateString() === tomorrow.toDateString() ? (d.getHours() < 6 ? 'tonight' : 'tomorrow')
        : d.toLocaleDateString([], { weekday: 'short' });
    return `${clock(iso)} <span class="dim">${day}</span>`;
  }
  const ago = (iso) => (iso ? `${S.ago(iso)} ago` : 'no log');
  const gap = (h) => (h == null ? '—' : h >= 18 && h <= 30 ? 'about a day' : h < 48 ? `about ${Math.round(h)} h` : `about ${Math.round(h / 24)} days`);

  async function run(label, btn) {
    btn.disabled = true;
    try { await S.postJSON(`/api/schedule/${encodeURIComponent(label)}/run`); S.toast('Started; it shows here once its log updates'); setTimeout(load, 4000); }
    catch (e) { S.toast(`Could not start it: ${e.message}`, { kind: 'broken' }); btn.disabled = false; }
  }

  function renderLocal(d) {
    const off = d.launchd_offset_min || 0;
    $('local').querySelector('th:nth-child(3)').textContent = off ? 'Schedule (as configured)' : 'Schedule';
    $('clock-note').innerHTML = off ? `<div class="note">${mark('needs')}<p>Jobs run ${Math.abs(off) / 60} h ${off > 0 ? 'earlier' : 'later'} than their configured times. launchd keeps the time zone it had when you logged in, and the logs show every job starting ${Math.abs(off) / 60} h ${off > 0 ? 'early' : 'late'}. Next runs below are when they will really start. Log out and back in to realign, or leave it while you travel.</p></div>` : '';
    const rows = d.jobs.map((j) => {
      const state = j.last_exit ? 'broken' : j.missed ? 'needs' : !j.evidence ? 'drift' : '';
      const why = j.last_exit ? `Last run exited with code ${j.last_exit}.` : j.missed ? `Its ${clock(j.prev_run)} run did not happen.` : !j.evidence ? 'No per-run log found, so a missed run would go unnoticed.' : '';
      return `<tr>
        <td class="lead">${state ? mark(state) : ''}</td>
        <td class="name">${j.project ? pv(j.name, j.project) : esc(j.name)}${why ? `<span class="sub">${esc(why)}</span>` : ''}</td>
        <td class="dim hide-sm">${esc(j.schedule)}</td>
        <td>${when(j.next_run)}</td>
        <td class="dim">${j.running ? 'running now' : esc(ago(j.last_run))}</td>
        <td class="act"><button type="button" class="btn" data-run="${esc(j.label)}">Run now</button></td>
      </tr>`;
    });
    $('local').querySelector('tbody').innerHTML = rows.join('') || '<tr><td></td><td colspan="5" class="dim">No scheduled jobs under ~/Library/LaunchAgents run anything in your projects.</td></tr>';
    $('local').querySelectorAll('[data-run]').forEach((b) => b.addEventListener('click', () => run(b.dataset.run, b)));
  }

  const STATE = { fail: ['broken', 'stopped'], warn: ['needs', 'overdue'], unknown: ['drift', 'unknown'], ok: ['', ''], off: ['', 'off'] };
  function renderCloud(d) {
    const captured = d.snapshot_captured_at ? new Date(d.snapshot_captured_at).toLocaleDateString([], { month: 'short', day: 'numeric' }) : null;
    $('cloud-aside').textContent = captured ? `routine names as of ${captured}; health from their commits` : 'health from their commits';
    const rows = d.cloud.map((c) => {
      const [m, word] = STATE[c.state] || ['', ''];
      const list = c.routines.length ? `<ul class="routine-list">${c.routines.map((r) => `<li class="${r.enabled ? '' : 'off'}"><span class="r-name">${pv(r.name, c.project)}</span><span>${esc(r.enabled ? (r.schedule || '') : (r.note || 'off'))}</span></li>`).join('')}</ul>` : '<span class="dim">not in the routine list</span>';
      return `<tr class="${c.state === 'off' ? 'off' : ''}">
        <td class="lead">${m ? mark(m) : ''}</td>
        <td class="name">${pv(c.project, c.project)}${word ? `<span class="sub">${esc(word)}</span>` : ''}</td>
        <td>${c.last ? `${S.ago(c.last)} ago<span class="sub">${px(c.subject || '')}</span>` : '<span class="dim">nothing in 60 days</span>'}</td>
        <td class="dim hide-sm nowrap">${esc(gap(c.gap_h))}</td>
        <td>${list}</td>
      </tr>`;
    });
    $('cloud').querySelector('tbody').innerHTML = rows.join('') || '<tr><td></td><td colspan="4" class="dim">No cloud routines found.</td></tr>';
  }

  async function load() {
    try {
      const d = await S.getJSON('/api/routines');
      renderLocal(d);
      renderCloud(d);
      $('checked').textContent = `Checked ${clock(d.checked_at)}.`;
    } catch (e) {
      $('checked').textContent = `Could not load: ${e.message}`;
    }
  }
  load();
  setInterval(() => { if (!document.hidden) load(); }, 60000);
  window.addEventListener('privacy', load);
})();
