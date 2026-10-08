// Private mode: personal text (project names, commit messages, goals, digests, logs) is blurred
// so the dashboard can be shown or recorded without hand redaction. Everything stays clickable;
// hover a blurred value to peek. Loaded synchronously in <head> so the class lands before paint.
//
// Render sites wrap personal text with Privacy.pv(text, projectName) / Privacy.px(text), or add the
// `pv` class (or `pv-block` for whole panels) to elements. Which projects count as public comes
// from /api/privacy (manifest `visibility: public` or data/privacy.json); it is applied as a small
// stylesheet, so a public name stays readable whenever the list arrives, no re-render needed.
(function () {
  const KEY = 'dashboard-private';
  const PUB = 'dashboard-public-projects';
  const html = document.documentElement;
  const isOn = () => localStorage.getItem(KEY) === 'on';
  const apply = () => html.classList.toggle('private', isOn());
  apply();

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let pub = new Set();
  try { pub = new Set(JSON.parse(localStorage.getItem(PUB) || '[]')); } catch { /* fresh browser */ }

  function publicStyle() {
    let el = document.getElementById('privacy-public');
    if (!el) { el = document.createElement('style'); el.id = 'privacy-public'; (document.head || html).appendChild(el); }
    el.textContent = [...pub].map((n) => `html.private .pv[data-proj="${CSS.escape(n)}"]{filter:none;user-select:auto}`).join('\n');
  }
  publicStyle();

  const P = window.Privacy = {
    get on() { return isOn(); },
    esc,
    /** true unless the project is on the public list (unknown names count as private) */
    isPrivate(name) { return !name || !pub.has(String(name)); },
    /** HTML for a value that belongs to a project: blurred in private mode unless that project is public */
    pv(text, name) { return `<span class="pv" data-proj="${esc(name || '')}">${esc(text)}</span>`; },
    /** HTML for text that is always personal (commit subjects, digests, log lines) */
    px(text) { return `<span class="pv">${esc(text)}</span>`; },
    /** add the class to an existing element */
    mark(el, name) { if (el) { el.classList.add('pv'); if (name) el.dataset.proj = String(name); } return el; },
    /** a display name that survives private mode: the real one for public projects, a neutral one otherwise */
    label(name) { return isOn() && P.isPrivate(name) ? 'project' : String(name ?? ''); },
    setPublic(list) { pub = new Set((list || []).map(String)); try { localStorage.setItem(PUB, JSON.stringify([...pub])); } catch { /* quota */ } publicStyle(); },
    toggle() {
      localStorage.setItem(KEY, isOn() ? 'off' : 'on');
      apply();
      P.renderButton();
      window.dispatchEvent(new CustomEvent('privacy', { detail: { on: isOn() } }));
    },
    renderButton() {
      const b = document.getElementById('privacy-toggle');
      if (!b) return;
      if (!b.dataset.shell) b.textContent = isOn() ? '🙈' : '👁'; // the shell's button draws its own eye
      b.title = (isOn() ? 'private mode on: personal text blurred, hover to peek' : 'private mode off') + ' (P)';
      b.setAttribute('aria-pressed', isOn() ? 'true' : 'false');
    },
  };

  fetch('/api/privacy').then((r) => (r.ok ? r.json() : null)).then((d) => {
    if (d && Array.isArray(d.public)) {
      P.setPublic(d.public);
      window.dispatchEvent(new CustomEvent('privacy', { detail: { on: isOn(), publicLoaded: true } }));
    }
  }).catch(() => { /* offline: keep the cached list */ });

  document.addEventListener('DOMContentLoaded', () => {
    // one toggle in every page's top bar, left of the theme button when there is one;
    // pages with the shell (static/shell.js) get it in the shell bar instead
    const meta = document.querySelector('.topbar .meta');
    if (meta && !window.Shell && !document.getElementById('privacy-toggle')) {
      const b = document.createElement('button');
      b.id = 'privacy-toggle'; b.className = 'theme-toggle'; b.type = 'button';
      b.addEventListener('click', P.toggle);
      const theme = document.getElementById('theme-toggle');
      if (theme) meta.insertBefore(b, theme); else meta.appendChild(b);
    }
    P.renderButton();
  });

  document.addEventListener('keydown', (e) => {
    if (window.Shell) return; // the shell binds `p` itself, so `g p` can mean something else
    if ((e.key !== 'p' && e.key !== 'P') || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    P.toggle();
  });
})();
