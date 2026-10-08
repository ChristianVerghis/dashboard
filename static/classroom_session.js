// Past-session viewer: the same insight views as the live page, read from
// /api/classroom/live/session/{id}/insights (computed from the session's
// files on disk by shortterm/scripts/session_analytics.py).
'use strict';

const SESSION_ID = decodeURIComponent(window.location.pathname.replace(/^\/classroom\/live\/sessions\//, ''));
document.title = `${SESSION_ID} · session detail`;
document.getElementById('session-id-label').textContent = SESSION_ID;

async function load() {
  const meta = document.getElementById('summary-meta');
  let r;
  try {
    r = await fetch(`/api/classroom/live/session/${encodeURIComponent(SESSION_ID)}/insights`);
  } catch (e) {
    meta.textContent = `could not reach the dashboard (${e.message})`;
    return;
  }
  if (!r.ok) {
    meta.textContent = r.status === 404 ? 'session not found' : `HTTP ${r.status}`;
    return;
  }
  const d = await r.json();
  const s = d.summary || {};
  meta.textContent = `${(s.bets || 0).toLocaleString()} distinct bets from ${(s.predictions || 0).toLocaleString()} student predictions`;
  Insights.render({
    banner: document.getElementById('source-banner'),
    kpis: document.getElementById('kpis'),
    equity: document.getElementById('equity'),
    scoreboard: document.getElementById('scoreboard'),
    bets: document.getElementById('bets'),
  }, d, { sessionId: SESSION_ID });
  if (d.running) setTimeout(load, 5000);
}

load();
