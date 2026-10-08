// Shell: the global bar, theme, ⌘K palette, g-chords, help, toasts and the
// preview sheet, shared by every page. Loaded synchronously in <head> right
// after privacy.js so the theme lands before first paint; the bar itself is
// built on DOMContentLoaded and goes above whatever header the page has.
(function () {
  const html = document.documentElement;
  const THEME_KEY = 'dashboard-theme';

  // ---------- theme ----------
  function storedTheme() {
    try { return localStorage.getItem(THEME_KEY) || 'dark'; } catch { return 'dark'; }
  }
  function resolve(t) {
    if (t === 'system') return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    return t === 'light' ? 'light' : 'dark';
  }
  function applyTheme(t) {
    const r = resolve(t);
    html.dataset.theme = r;
    html.classList.toggle('light', r === 'light'); // style.css still keys a few rules on it
  }
  applyTheme(storedTheme());
  try {
    matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
      if (storedTheme() === 'system') applyTheme('system');
    });
  } catch { /* old browser */ }
  function setTheme(t) {
    try { localStorage.setItem(THEME_KEY, t); } catch { /* private window */ }
    applyTheme(t);
  }
  function toggleTheme() { setTheme(html.dataset.theme === 'light' ? 'dark' : 'light'); }

  // ---------- small helpers ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pv = (text, proj) => (window.Privacy ? window.Privacy.pv(text, proj) : esc(text));
  const px = (text) => (window.Privacy ? window.Privacy.px(text) : esc(text));
  async function getJSON(url) {
    const r = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return r.json();
  }
  async function postJSON(url, body) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    let data = null;
    try { data = await r.json(); } catch { /* empty body */ }
    if (!r.ok) throw new Error((data && (data.detail || data.error)) || `${r.status} ${r.statusText}`);
    return data;
  }
  function isTyping(e) {
    const t = (e && e.target) || document.activeElement;
    return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  }
  function ago(iso) {
    if (!iso) return '';
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'now';
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    if (s < 86400 * 60) return `${Math.floor(s / 86400)}d`;
    return `${Math.floor(s / (86400 * 30))}mo`;
  }

  // status marks: shape + color, never color alone
  const MARKS = {
    broken: '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    needs: '<svg viewBox="0 0 10 10" aria-hidden="true"><circle cx="5" cy="5" r="3.6" fill="currentColor"/></svg>',
    drift: '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M5 1.6L8.8 8.4H1.2z" fill="currentColor"/></svg>',
    working: '<svg viewBox="0 0 10 10" aria-hidden="true"><circle cx="5" cy="5" r="3.6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M5 1.4a3.6 3.6 0 0 1 0 7.2z" fill="currentColor"/></svg>',
    idle: '<svg viewBox="0 0 10 10" aria-hidden="true"><circle cx="5" cy="5" r="3.4" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
    done: '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2 5.4l2 2 4-4.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    none: '',
  };
  const LABELS = { broken: 'broken', needs: 'needs you', drift: 'drifting', working: 'working', idle: 'idle', done: 'done' };
  function mark(kind, extraClass) {
    return `<span class="mark ${kind} ${extraClass || ''}" role="img" aria-label="${LABELS[kind] || kind}">${MARKS[kind] || ''}</span>`;
  }

  const ICONS = {
    search: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14" stroke-linecap="round"/></svg>',
    eye: '<svg class="eye-open" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/></svg>' +
         '<svg class="eye-closed" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M2 5.5C3.5 8 5.6 9.5 8 9.5s4.5-1.5 6-4M4.2 8.3L3 10.2M8 9.5V12M11.8 8.3l1.2 1.9" stroke-linecap="round"/></svg>',
    theme: '<svg class="theme-moon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5z" stroke-linejoin="round"/></svg>' +
           '<svg class="theme-sun" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><circle cx="8" cy="8" r="3"/><path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1" stroke-linecap="round"/></svg>',
    help: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><circle cx="8" cy="8" r="6"/><path d="M6.3 6.2a1.8 1.8 0 1 1 2.6 1.6c-.6.3-.9.7-.9 1.3v.3" stroke-linecap="round"/><circle cx="8" cy="11.4" r=".5" fill="currentColor"/></svg>',
    close: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke-linecap="round"/></svg>',
  };

  // ---------- navigation ----------
  // Insights is home; mission control carries the count of what needs you
  const NAV = [
    { href: '/', label: 'Insights', key: 'h', alias: 'i' },
    { href: '/control', label: 'Mission control', key: 'c', count: true },
    { href: '/digest', label: 'Digest', key: 'd' },
    { href: '/journal', label: 'Journal', key: 'j' },
    { href: '/routines', label: 'Routines', key: 'r' },
  ];
  // pages other projects keep here; they are not part of the cockpit itself
  const APPS = [
    { href: '/markets', label: 'Markets', note: 'markets' },
    { href: '/predictions', label: 'Predictions', note: 'oracle' },
    { href: '/classroom', label: 'Classroom', note: 'classroom' },
    { href: '/classroom/retest', label: 'Track record', note: 'weekly re-test' },
    { href: '/stack', label: 'Stack', note: 'all capabilities' },
    { href: '/share.html', label: 'Share card', note: 'for friends' },
    { href: '/snapshot.html', label: 'Snapshot', note: 'download', download: 'dashboard-snapshot.html' },
  ];
  function go(href) { window.location.href = href; }
  function currentNav() {
    const path = location.pathname;
    return NAV.find((n) => n.href === path) || (path.startsWith('/project/') ? null : NAV.find((n) => n.href !== '/' && path.startsWith(n.href)));
  }

  function buildBar() {
    if (document.querySelector('nav.shell')) return;
    html.classList.add('shell-on');
    const cur = currentNav();
    const bar = document.createElement('nav');
    bar.className = 'shell';
    bar.setAttribute('aria-label', 'Main');
    bar.innerHTML = `
      <a class="shell-mark" href="/" title="Insights (g h)"><span class="mark" id="shell-status"></span><span>dev</span></a>
      <div class="shell-links">
        ${NAV.map((n) => `<a href="${n.href}"${cur && cur.href === n.href ? ' aria-current="page"' : ''} title="${n.label} (g ${n.key})">${n.label}${n.count ? '<span class="nav-count" id="shell-count" hidden></span>' : ''}</a>`).join('')}
        <div class="shell-apps">
          <button type="button" aria-haspopup="menu" aria-expanded="false">Apps</button>
          <div class="shell-menu" role="menu" hidden>
            ${APPS.map((a) => `<a role="menuitem" href="${a.href}"${a.download ? ` download="${a.download}"` : ''}><span>${a.label}</span><span class="menu-note">${a.note}</span></a>`).join('')}
          </div>
        </div>
      </div>
      <div class="shell-tools">
        <button type="button" class="shell-search" title="Search, jump or run (⌘K)">${ICONS.search}<span>Search or run…</span><kbd>⌘K</kbd></button>
        <button type="button" class="icon-btn" id="privacy-toggle" data-shell="1">${ICONS.eye}</button>
        <button type="button" class="icon-btn shell-theme" title="Light or dark (t)">${ICONS.theme}</button>
        <button type="button" class="icon-btn shell-help" title="Keyboard shortcuts (?)">${ICONS.help}</button>
      </div>`;
    document.body.prepend(bar);
    bar.querySelector('.shell-search').addEventListener('click', () => openPalette());
    bar.querySelector('.shell-theme').addEventListener('click', toggleTheme);
    bar.querySelector('.shell-help').addEventListener('click', () => toggleHelp(true));
    bar.querySelector('#privacy-toggle').addEventListener('click', () => window.Privacy && window.Privacy.toggle());
    if (window.Privacy) window.Privacy.renderButton();
    const appsBtn = bar.querySelector('.shell-apps > button');
    const menu = bar.querySelector('.shell-menu');
    appsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = menu.hidden;
      menu.hidden = !open;
      appsBtn.setAttribute('aria-expanded', String(open));
      if (open) menu.querySelector('a').focus();
    });
    document.addEventListener('click', (e) => {
      if (!menu.hidden && !menu.contains(e.target)) { menu.hidden = true; appsBtn.setAttribute('aria-expanded', 'false'); }
    });
    const host = document.createElement('div');
    host.id = 'shell-layer';
    document.body.appendChild(host);
  }

  // ---------- global status: the mark next to "dev" and a count in the tab title ----------
  function setStatus(counts) {
    const el = document.getElementById('shell-status');
    const broken = (counts && counts.broken) || 0;
    const needs = (counts && counts.needs) || 0;
    const kind = broken ? 'broken' : needs ? 'needs' : 'none';
    if (el) {
      el.className = `mark ${kind}`;
      el.innerHTML = MARKS[kind] || '';
      el.setAttribute('aria-label', broken ? `${broken} broken` : needs ? `${needs} need you` : 'nothing needs you');
    }
    const n = broken + needs;
    const count = document.getElementById('shell-count');
    if (count) {
      count.hidden = !n;
      count.textContent = n ? String(n) : '';
      count.className = `nav-count ${broken ? 'broken' : 'needs'}`;
      count.title = broken ? `${broken} broken, ${needs} need you` : `${needs} need you`;
    }
    const base = document.title.replace(/^\(\d+\)\s/, ''); // pages retitle themselves; keep theirs
    document.title = n ? `(${n}) ${base}` : base;
  }
  async function pollStatus() {
    if (document.hidden) return;
    try { setStatus((await getJSON('/api/inbox')).counts); } catch { /* server restarting */ }
  }

  // ---------- toasts: results of your own actions, with undo where it exists ----------
  function toast(message, opts = {}) {
    let host = document.querySelector('.sh-toasts');
    if (!host) { host = document.createElement('div'); host.className = 'sh-toasts'; host.setAttribute('role', 'status'); document.body.appendChild(host); }
    const t = document.createElement('div');
    t.className = `sh-toast ${opts.kind || ''}`;
    t.innerHTML = `<span>${esc(message)}</span>${opts.action ? `<button type="button" class="link-btn">${esc(opts.action)}</button>` : ''}`;
    host.appendChild(t);
    const remove = () => t.remove();
    if (opts.action) t.querySelector('button').addEventListener('click', () => { remove(); opts.onAction && opts.onAction(); });
    setTimeout(remove, opts.timeout || (opts.action ? 6000 : 3500));
  }

  // ---------- preview sheet ----------
  let sheetEl = null;
  let sheetOnClose = null;
  function ensureSheet() {
    if (sheetEl) return sheetEl;
    sheetEl = document.createElement('aside');
    sheetEl.className = 'sheet';
    sheetEl.dataset.state = 'closed';
    sheetEl.setAttribute('aria-label', 'Preview');
    sheetEl.innerHTML = `<div class="sheet-head"><h3></h3><button type="button" class="icon-btn" title="Close (esc)">${ICONS.close}</button></div><div class="sheet-body"></div>`;
    sheetEl.querySelector('.icon-btn').addEventListener('click', () => closeSheet());
    document.body.appendChild(sheetEl);
    return sheetEl;
  }
  function openSheet({ title, sub, body, onClose }) {
    const s = ensureSheet();
    s.querySelector('h3').innerHTML = `${title || ''}${sub ? `<span class="sub">${sub}</span>` : ''}`;
    const b = s.querySelector('.sheet-body');
    b.innerHTML = body || '';
    b.scrollTop = 0;
    sheetOnClose = onClose || null;
    s.dataset.state = 'open';
    return b;
  }
  function closeSheet() {
    if (!sheetEl || sheetEl.dataset.state === 'closed') return false;
    sheetEl.dataset.state = 'closed';
    const cb = sheetOnClose; sheetOnClose = null;
    if (cb) cb();
    return true;
  }
  const sheetOpen = () => !!sheetEl && sheetEl.dataset.state === 'open';

  // ---------- help ----------
  const pageKeys = [];
  function registerKeys(group, list) { pageKeys.push({ group, list }); }
  let helpEl = null;
  let helpScrim = null;
  function toggleHelp(show) {
    if (helpEl) { helpScrim.remove(); helpEl.remove(); helpEl = helpScrim = null; return; }
    if (show === false) return;
    const scrim = helpScrim = document.createElement('div'); scrim.className = 'overlay';
    scrim.addEventListener('click', () => toggleHelp(false));
    helpEl = document.createElement('div'); helpEl.className = 'help'; helpEl.setAttribute('role', 'dialog'); helpEl.setAttribute('aria-label', 'Keyboard shortcuts');
    const global = [
      ['⌘K', 'Search, jump or run anything'], ['/', 'Same, from anywhere'],
      ...NAV.map((n) => [`g ${n.key}`, `Go to ${n.label}`]), ['g p', 'Pick a project'],
      ['t', 'Light or dark'], ['p', 'Private mode: blur personal text'], ['?', 'This list'], ['esc', 'Close whatever is open'],
    ];
    const dl = (rows) => `<dl>${rows.map(([k, v]) => `<dt>${k.split(' ').map((x) => `<kbd>${esc(x)}</kbd>`).join(' ')}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
    helpEl.innerHTML = `<h3>Keyboard</h3><div class="help-cols">
      <section><h4>Everywhere</h4>${dl(global)}</section>
      ${pageKeys.map((g) => `<section><h4>${esc(g.group)}</h4>${dl(g.list)}</section>`).join('')}
    </div>`;
    document.body.append(scrim, helpEl);
  }

  // ---------- palette ----------
  let paletteEl = null;
  let paletteScrim = null;
  let paletteMode = 'list'; // 'list' | 'answer'
  let items = [];
  let shown = [];
  let active = 0;
  let corpusCache = null;

  function score(hay, q) {
    if (!q) return 1;
    const h = hay.toLowerCase();
    const i = h.indexOf(q);
    if (i >= 0) return 1000 - i * 2 - (h.length - q.length) * 0.1 + (i === 0 || h[i - 1] === ' ' ? 200 : 0);
    let hi = 0, gaps = 0;
    for (const ch of q) {
      const j = h.indexOf(ch, hi);
      if (j < 0) return 0;
      gaps += j - hi;
      hi = j + 1;
    }
    return 300 - gaps;
  }

  async function corpus() {
    if (corpusCache && Date.now() - corpusCache.at < 60000) return corpusCache.items;
    const out = [];
    for (const n of NAV) out.push({ group: 'Go to', label: n.label, hint: `g ${n.key}`, run: () => go(n.href), always: true });
    for (const a of APPS) out.push({ group: 'Go to', label: a.label, detail: a.note, run: () => go(a.href) });
    out.push({ group: 'Actions', label: 'Switch light or dark', hint: 't', run: toggleTheme, always: true });
    out.push({ group: 'Actions', label: 'Follow the system theme', run: () => setTheme('system') });
    out.push({ group: 'Actions', label: 'Private mode on or off', hint: 'p', run: () => window.Privacy && window.Privacy.toggle(), always: true });
    try {
      const data = await getJSON('/api/palette');
      for (const p of data.projects) {
        out.push({ group: 'Projects', label: p.name, proj: p.name, detail: p.description || '', run: () => go(`/project/${encodeURIComponent(p.name)}`),
          alt: { label: 'Terminal', run: () => openTerminal(p.name, false) }, isProject: true });
        out.push({ group: 'Actions', label: `Open ${p.name} in Terminal`, proj: p.name, run: () => openTerminal(p.name, false) });
        out.push({ group: 'Actions', label: `Start Claude in ${p.name}`, proj: p.name, run: () => openTerminal(p.name, true) });
        out.push({ group: 'Actions', label: `Copy a brief for ${p.name}`, proj: p.name, run: () => copyBrief(p.name) });
        if (p.port && p.up === false && p.can_start) {
          out.push({ group: 'Actions', label: `Start ${p.name}`, proj: p.name, detail: `port ${p.port}`, run: () => startService(p.name), always: true });
        }
      }
      for (const c of data.commits) {
        out.push({ group: 'Recent commits', label: c.subject, personal: true, detail: `${c.project} ${c.sha}`, proj: c.project,
          run: () => (c.url ? window.open(c.url, '_blank', 'noopener') : go(`/journal`)) });
      }
    } catch { /* offline: pages and actions still work */ }
    corpusCache = { at: Date.now(), items: out };
    return out;
  }

  const nameOf = (project) => (window.Privacy ? window.Privacy.label(project) : project);
  async function openTerminal(project, claude) {
    try { await postJSON('/api/open_terminal', { project, claude }); toast(claude ? `Opened Claude in ${nameOf(project)}` : `Opened ${nameOf(project)} in Terminal`); }
    catch (e) { toast(`Could not open Terminal: ${e.message}`, { kind: 'broken' }); }
  }
  async function copyBrief(project) {
    try {
      const r = await fetch(`/api/projects/${encodeURIComponent(project)}/brief`);
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      await navigator.clipboard.writeText(await r.text());
      toast(`Copied the brief for ${nameOf(project)}`);
    } catch (e) { toast(`Could not copy the brief: ${e.message}`, { kind: 'broken' }); }
  }
  async function startService(name) {
    try { await postJSON(`/api/services/${encodeURIComponent(name)}/start`); toast(`Starting ${nameOf(name)}`); }
    catch (e) { toast(`Could not start ${nameOf(name)}: ${e.message}`, { kind: 'broken' }); }
  }

  function openPalette(prefill = '') {
    if (paletteEl) { paletteEl.querySelector('input').focus(); return; }
    toggleHelp(false);
    paletteScrim = document.createElement('div'); paletteScrim.className = 'overlay';
    paletteScrim.addEventListener('click', closePalette);
    paletteEl = document.createElement('div');
    paletteEl.className = 'cmdk';
    paletteEl.setAttribute('role', 'dialog');
    paletteEl.setAttribute('aria-label', 'Search or run');
    paletteEl.innerHTML = `
      <input class="cmdk-input" type="text" placeholder="Search projects, pages, actions, commits, or ask a question" autocomplete="off" spellcheck="false" role="combobox" aria-expanded="true" aria-controls="cmdk-list" />
      <ul class="cmdk-list" id="cmdk-list" role="listbox"></ul>
      <div class="cmdk-foot"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>↵</kbd> run</span><span><kbd>⌘↵</kbd> terminal</span><span><kbd>esc</kbd> close</span></div>`;
    document.body.append(paletteScrim, paletteEl);
    paletteMode = 'list';
    active = 0;
    const input = paletteEl.querySelector('input');
    input.value = prefill;
    input.addEventListener('input', () => { if (paletteMode === 'list') { active = 0; renderPalette(input.value); } });
    input.addEventListener('keydown', onPaletteKey);
    input.focus();
    corpus().then((c) => { items = c; renderPalette(input.value); });
    renderPalette(prefill);
  }
  function closePalette() {
    if (!paletteEl) return false;
    paletteEl.remove(); paletteScrim.remove();
    paletteEl = paletteScrim = null;
    return true;
  }

  function renderPalette(raw) {
    if (!paletteEl || paletteMode !== 'list') return;
    const list = paletteEl.querySelector('.cmdk-list');
    const q = raw.trim().toLowerCase();
    if (q.startsWith('project ') || q === 'project') {
      shown = items.filter((i) => i.isProject).map((i) => ({ i, s: score(i.label, q.replace(/^project\s*/, '')) }))
        .filter((x) => x.s > 0).sort((a, b) => b.s - a.s).map((x) => x.i);
    } else if (!q) {
      const projects = items.filter((i) => i.isProject).slice(0, 8);
      shown = [...items.filter((i) => i.always), ...projects];
    } else {
      let scored = items.map((i) => ({ i, s: Math.max(score(i.label, q), score(i.detail || '', q) * 0.6) })).filter((x) => x.s > 0);
      // scattered-letter matches only help when nothing contains the query outright
      if (scored.some((x) => x.s >= 600)) scored = scored.filter((x) => x.s >= 400);
      shown = scored.sort((a, b) => b.s - a.s).slice(0, 18).map((x) => x.i);
    }
    if (q.length >= 3) shown.push({ group: 'Ask', label: `Ask Claude: “${raw.trim()}”`, run: () => ask(raw.trim()), ask: true });
    active = Math.min(active, Math.max(0, shown.length - 1));
    if (!shown.length) { list.innerHTML = `<li class="cmdk-empty">Nothing matches. Keep typing to ask Claude instead.</li>`; return; }
    let lastGroup = null;
    list.innerHTML = shown.map((it, idx) => {
      const head = it.group !== lastGroup ? `<li class="cmdk-group" role="presentation">${esc(it.group)}</li>` : '';
      lastGroup = it.group;
      const label = it.personal ? px(it.label) : it.proj ? pv(it.label, it.proj) : esc(it.label);
      const detail = it.detail ? `<span class="pi-detail">${it.proj ? pv(it.detail, it.proj) : esc(it.detail)}</span>` : '';
      const hint = it.hint ? it.hint.split(' ').map((k) => `<kbd>${esc(k)}</kbd>`).join(' ') : '';
      return `${head}<li class="cmdk-item" role="option" id="pi-${idx}" data-idx="${idx}" aria-selected="${idx === active}">
        <span class="pi-label">${label}${detail}</span><span>${hint}</span></li>`;
    }).join('');
    list.querySelectorAll('.cmdk-item').forEach((li) => {
      li.addEventListener('mousemove', () => { if (active !== +li.dataset.idx) { active = +li.dataset.idx; markActive(); } });
      li.addEventListener('click', () => { active = +li.dataset.idx; runActive(false); });
    });
    markActive();
  }
  function markActive() {
    if (!paletteEl) return;
    paletteEl.querySelectorAll('.cmdk-item').forEach((li) => li.setAttribute('aria-selected', String(+li.dataset.idx === active)));
    const el = paletteEl.querySelector(`#pi-${active}`);
    if (el) { el.scrollIntoView({ block: 'nearest' }); paletteEl.querySelector('input').setAttribute('aria-activedescendant', el.id); }
  }
  function runActive(alt) {
    const it = shown[active];
    if (!it) return;
    if (it.ask) { it.run(); return; }
    closePalette();
    if (alt && it.alt) it.alt.run(); else it.run();
  }
  function onPaletteKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePalette(); return; }
    if (paletteMode === 'answer') {
      const next = e.target.value.trim();
      if (e.key === 'Enter' && next) { e.preventDefault(); e.target.value = ''; ask(next); }
      return;
    }
    if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) { e.preventDefault(); active = Math.max(0, Math.min(shown.length - 1, active + 1)); markActive(); }
    else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) { e.preventDefault(); active = Math.max(0, active - 1); markActive(); }
    else if (e.key === 'Enter') { e.preventDefault(); runActive(e.metaKey || e.ctrlKey); }
  }

  // Markdown from a model is untrusted HTML: rebuild it from an allowlist of
  // formatting tags. Every attribute is dropped except a link's href, kept
  // only when it resolves to http(s) or mailto; anything else becomes text.
  const SAFE_TAGS = new Set(['P', 'BR', 'STRONG', 'B', 'EM', 'I', 'CODE', 'PRE', 'UL', 'OL', 'LI', 'A', 'H1', 'H2', 'H3', 'H4',
    'H5', 'H6', 'BLOCKQUOTE', 'HR', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'DEL', 'SPAN']);
  function clean(htmlText) {
    const src = new DOMParser().parseFromString(htmlText, 'text/html').body;
    const out = document.createElement('div');
    const copy = (from, to) => {
      for (const node of from.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) { to.appendChild(document.createTextNode(node.nodeValue)); continue; }
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        if (!SAFE_TAGS.has(node.tagName)) { copy(node, to); continue; } // keep the text, drop the tag
        const el = document.createElement(node.tagName);
        if (node.tagName === 'A') {
          try {
            const u = new URL(node.getAttribute('href') || '', location.href);
            if (['http:', 'https:', 'mailto:'].includes(u.protocol)) { el.href = u.href; el.target = '_blank'; el.rel = 'noopener noreferrer'; }
          } catch { /* unparseable: plain text link */ }
        }
        copy(node, el);
        to.appendChild(el);
      }
    };
    copy(src, out);
    return out.innerHTML;
  }

  // A project's README or CAPABILITIES rendered on a dashboard page: its
  // relative images and links point into the project (served read-only by
  // /files/<project>/...), not at the dashboard's own root.
  function rebaseLinks(htmlText, project) {
    const doc = new DOMParser().parseFromString(`<div>${htmlText}</div>`, 'text/html');
    const base = `/files/${encodeURIComponent(project)}/`;
    const relative = (v) => v && !/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(v);
    doc.querySelectorAll('img[src], a[href]').forEach((el) => {
      const attr = el.tagName === 'IMG' ? 'src' : 'href';
      const v = el.getAttribute(attr);
      if (relative(v)) el.setAttribute(attr, base + v.replace(/^\.\//, ''));
    });
    return doc.body.firstChild.innerHTML;
  }

  // Ask Claude: streams /api/ask into the palette
  const askHistory = [];
  function loadMarked() {
    if (window.marked) return Promise.resolve();
    return new Promise((res) => { const s = document.createElement('script'); s.src = '/static/marked.min.js'; s.onload = res; s.onerror = res; document.head.appendChild(s); });
  }
  async function ask(q) {
    if (!paletteEl) return;
    paletteMode = 'answer';
    let pane = paletteEl.querySelector('.cmdk-answer');
    if (!pane) {
      pane = document.createElement('div');
      pane.className = 'cmdk-answer pv-block';
      paletteEl.querySelector('.cmdk-list').replaceWith(pane);
      paletteEl.querySelector('.cmdk-foot').innerHTML = '<span><kbd>↵</kbd> ask a follow-up</span><span><kbd>esc</kbd> close</span><span>Claude answers from a summary of your projects; check anything that matters.</span>';
    }
    pane.innerHTML = `<div class="q">${esc(q)}</div><div class="a">Thinking…</div>`;
    const input = paletteEl.querySelector('input');
    input.value = '';
    input.placeholder = 'Ask a follow-up';
    const out = pane.querySelector('.a');
    await loadMarked();
    const render = (md) => { try { return window.marked ? clean(window.marked.parse(md)) : esc(md).replace(/\n/g, '<br>'); } catch { return esc(md); } };
    let text = '';
    try {
      const r = await fetch('/api/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: q, history: askHistory }) });
      if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
          const line = frame.split('\n').find((l) => l.startsWith('data: '));
          if (!line) continue;
          let ev; try { ev = JSON.parse(line.slice(6)); } catch { continue; }
          if (ev.type === 'delta') { text += ev.text; out.innerHTML = render(text); }
          else if (ev.type === 'error') { out.textContent = ev.message || 'The assistant returned an error.'; }
        }
      }
      if (!text && out.textContent === 'Thinking…') out.textContent = 'No answer came back.';
    } catch (e) {
      out.textContent = `Could not reach the assistant (${e.message}).`;
    }
    if (text) { askHistory.push({ role: 'user', content: q }, { role: 'assistant', content: text }); while (askHistory.length > 12) askHistory.shift(); }
  }

  // ---------- keyboard ----------
  let chordUntil = 0;
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      if (!closePalette()) openPalette();
      return;
    }
    if (e.key === 'Escape') {
      if (closePalette() || (helpEl && (toggleHelp(false), true)) || closeSheet()) { e.preventDefault(); return; }
      if (isTyping(e)) document.activeElement.blur();
      return;
    }
    if (paletteEl || isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (Date.now() < chordUntil) {
      chordUntil = 0;
      e.preventDefault(); // whatever follows g belongs to the chord, never to the page
      const n = NAV.find((x) => x.key === e.key || x.alias === e.key);
      if (n) { go(n.href); return; }
      if (e.key === 'p') openPalette('project ');
      return;
    }
    if (e.key === 'g') { chordUntil = Date.now() + 1200; e.preventDefault(); return; }
    if (e.key === '/') { e.preventDefault(); openPalette(); return; }
    if (e.key === '?') { e.preventDefault(); toggleHelp(); return; }
    if (e.key === 't') { e.preventDefault(); toggleTheme(); return; }
    if (e.key === 'p' || e.key === 'P') { e.preventDefault(); if (window.Privacy) window.Privacy.toggle(); }
  });

  // ---------- public ----------
  window.Shell = {
    esc, pv, px, getJSON, postJSON, isTyping, ago, mark, ICONS, cleanHTML: clean, rebaseLinks,
    toast, openPalette, closePalette, toggleTheme, setTheme,
    sheet: { open: openSheet, close: closeSheet, get isOpen() { return sheetOpen(); } },
    keys: { register: registerKeys },
    status: setStatus,
    statusOwner: null, // a page that loads /api/inbox itself sets this and calls Shell.status()
    overlayOpen: () => !!paletteEl || !!helpEl,
  };

  document.addEventListener('DOMContentLoaded', () => {
    buildBar();
    if (!window.Shell.statusOwner) {
      pollStatus();
      setInterval(pollStatus, 30000);
      document.addEventListener('visibilitychange', () => { if (!document.hidden) pollStatus(); });
    }
  });
})();
