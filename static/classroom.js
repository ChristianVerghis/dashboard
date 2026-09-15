/* Classroom dashboard front-end. */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const fmtPct = (v, digits = 1) => (v == null ? "—" : `${(v * 100).toFixed(digits)}%`);
const fmtBrier = (v) => (v == null ? "—" : Number(v).toFixed(3));
const fmtInt = (v) => (v == null ? "—" : String(v));
const fmtDate = (iso) => {
  if (!iso) return "—";
  try { return iso.slice(0, 19).replace("T", " "); } catch { return iso; }
};
const esc = (s) => {
  if (s == null) return "";
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
};

async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}

function dirClass(d) {
  if (d === "up") return "dir-up";
  if (d === "down") return "dir-down";
  if (d === "flat") return "dir-flat";
  return "";
}

// ---- Overview ----

async function loadOverview() {
  const o = await fetchJSON("/api/classroom/overview");
  $("#overview-hdr").textContent = `${o.n_students} students · ${o.n_open_predictions} open · ${o.n_resolved} resolved`;
  const cards = [
    { label: "Students", value: o.n_students, sub: "in the roster" },
    { label: "Predictions today", value: o.today_predictions, sub: o.today_date },
    { label: "Open predictions", value: o.n_open_predictions, sub: "awaiting horizon" },
    { label: "Resolved", value: o.n_resolved, sub: `${o.n_correct} correct` },
    { label: "Classroom hit rate", value: fmtPct(o.classroom_hit_rate), sub: "across all resolutions" },
    { label: "Overall Brier", value: fmtBrier(o.overall_brier), sub: "weighted by resolutions" },
  ];
  $("#overview-cards").innerHTML = cards.map((c) => `
    <div class="cls-card">
      <div class="label">${esc(c.label)}</div>
      <div class="value">${esc(c.value)}</div>
      <div class="sub">${esc(c.sub)}</div>
    </div>
  `).join("");
  $("#cls-last").textContent = o.recent_days.length
    ? `${o.recent_days.length} day(s) with predictions`
    : "no daily firings yet";
}

// ---- Leaderboard ----

let leaderboardCache = null;
let activeTab = "resolved";

let projectionByName = {};

function renderLeaderboard() {
  if (!leaderboardCache) return;
  const rows = activeTab === "resolved" ? leaderboardCache.students : leaderboardCache.unresolved;
  const headers = `
    <div class="cls-row leaderboard header">
      <div>#</div><div>Student</div><div>Technique</div>
      <div class="right">Resolved</div><div class="right">Hit rate</div>
      <div class="right">Brier-30</div><div class="right">Lifetime Brier</div>
      <div class="right">Projected</div><div class="right">Retired</div>
    </div>
  `;
  const body = rows.map((r, i) => {
    const proj = projectionByName[r.name] || {};
    const projected = proj.projected_brier;
    const retired = proj.n_setups_retired || 0;
    const trajCls = (proj.trajectory_delta != null && proj.trajectory_delta > 0.02)
      ? "dir-up" : (proj.trajectory_delta != null && proj.trajectory_delta < -0.02)
      ? "dir-down" : "";
    return `
    <div class="cls-row leaderboard">
      <div class="muted-small">${i + 1}</div>
      <div class="name"><a href="/classroom/student/${encodeURIComponent(r.name)}">${esc(r.name)}</a></div>
      <div><span class="technique-pill">${esc(r.technique || "—")}</span></div>
      <div class="right">${fmtInt(r.total_resolved)}</div>
      <div class="right">${fmtPct(r.hit_rate)}</div>
      <div class="right">${fmtBrier(r.rolling_brier_30)}</div>
      <div class="right">${fmtBrier(r.lifetime_brier)}</div>
      <div class="right ${trajCls}">${fmtBrier(projected)}</div>
      <div class="right">${retired > 0 ? `<span class="status-resolved-wrong">${retired}</span>` : "0"}</div>
    </div>
  `;}).join("");
  $("#leaderboard").innerHTML = rows.length ? headers + body : `<div class="muted small">No students in this bucket yet.</div>`;
  $("#leaderboard-summary").textContent = `${rows.length} student${rows.length === 1 ? "" : "s"}`;
}

async function loadLeaderboard() {
  leaderboardCache = await fetchJSON("/api/classroom/leaderboard?limit=150");
  renderLeaderboard();
}

$$(".cls-tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    $$(".cls-tab").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    activeTab = btn.dataset.tab;
    renderLeaderboard();
  });
});

// ---- By technique ----

async function loadTechniqueTable() {
  const { techniques } = await fetchJSON("/api/classroom/by_technique");
  const headers = `
    <div class="cls-row tech header">
      <div>#</div><div>Technique</div>
      <div class="right">Students</div><div class="right">Resolved</div>
      <div class="right">Hit rate</div><div class="right">Avg Brier</div>
      <div>Sample students</div>
    </div>
  `;
  const body = techniques.map((t, i) => `
    <div class="cls-row tech">
      <div class="muted-small">${i + 1}</div>
      <div class="name">${esc(t.technique)}</div>
      <div class="right">${fmtInt(t.n_students)}</div>
      <div class="right">${fmtInt(t.total_resolved)}</div>
      <div class="right">${fmtPct(t.hit_rate)}</div>
      <div class="right">${fmtBrier(t.avg_lifetime_brier)}</div>
      <div class="muted-small">${t.students.slice(0, 3).map((s) => esc(s)).join(", ")}${t.students.length > 3 ? ` +${t.students.length - 3}` : ""}</div>
    </div>
  `).join("");
  $("#technique-table").innerHTML = headers + body;
}

// ---- Hall of Fame / Wall of Shame ----

function renderHall(entries, kind) {
  if (!entries.length) {
    return `<div class="muted small">No ${kind} entries yet. They're written when a high-confidence (≥85%) prediction resolves.</div>`;
  }
  return entries.map((e) => {
    const first2lines = e.markdown.split("\n").slice(0, 2).join(" — ").replace(/^#\s+/, "");
    return `
      <div class="cls-hall-entry">
        <h3>${esc(first2lines)}</h3>
        <div class="small">${esc(e.slug)}</div>
      </div>
    `;
  }).join("");
}

async function loadHall() {
  const [hof, wos] = await Promise.all([
    fetchJSON("/api/classroom/hall_of_fame"),
    fetchJSON("/api/classroom/wall_of_shame"),
  ]);
  $("#hof-list").innerHTML = renderHall(hof.entries, "Hall of Fame");
  $("#wos-list").innerHTML = renderHall(wos.entries, "Wall of Shame");
}

// ---- Usage ----

async function loadUsage() {
  const u = await fetchJSON("/api/classroom/usage");
  if (!u.exists || u.total_calls === 0) {
    $("#usage-content").innerHTML = `<div class="muted small">No llm_persona calls logged yet. Once today's run fires, this panel will show day/persona breakdowns.</div>`;
    return;
  }
  const daysHeader = `
    <div class="cls-row usage-day header">
      <div>Date</div><div class="right">Calls</div><div class="right">Skipped</div>
      <div class="right">Errors</div><div class="right">Avg ms</div>
    </div>
  `;
  const days = u.by_day.map((d) => `
    <div class="cls-row usage-day">
      <div>${esc(d.date)}</div>
      <div class="right">${fmtInt(d.calls)}</div>
      <div class="right">${fmtInt(d.skipped)}</div>
      <div class="right">${d.errors > 0 ? `<span class="status-resolved-wrong">${esc(d.errors)}</span>` : "0"}</div>
      <div class="right">${fmtInt(d.avg_ms)}</div>
    </div>
  `).join("");

  const personasHeader = `
    <div class="cls-row usage-persona header">
      <div>Persona</div><div class="right">Calls</div><div class="right">Errors</div><div class="right">Avg ms</div>
    </div>
  `;
  const personas = u.by_persona.map((p) => `
    <div class="cls-row usage-persona">
      <div>${esc(p.persona)}</div>
      <div class="right">${fmtInt(p.calls)}</div>
      <div class="right">${p.errors > 0 ? `<span class="status-resolved-wrong">${esc(p.errors)}</span>` : "0"}</div>
      <div class="right">${fmtInt(p.avg_ms)}</div>
    </div>
  `).join("");

  $("#usage-content").innerHTML = `
    <div class="usage-section">
      <div>
        <h3>By day</h3>
        <div class="cls-table">${daysHeader}${days}</div>
      </div>
      <div>
        <h3>By persona</h3>
        <div class="cls-table">${personasHeader}${personas}</div>
      </div>
    </div>
  `;
}

// ---- Latest predictions ----

async function loadLatest() {
  const { predictions } = await fetchJSON("/api/classroom/latest_predictions?limit=80");
  $("#latest-count").textContent = `${predictions.length} most recent`;
  const headers = `
    <div class="cls-row log header">
      <div>When</div><div>Student</div><div>Ticker</div><div>Dir</div>
      <div class="right">H</div><div class="right">Conf</div><div>Setup</div><div>Reasoning</div>
    </div>
  `;
  const body = predictions.map((p) => `
    <div class="cls-row log">
      <div class="muted-small">${esc(fmtDate(p.created_at))}</div>
      <div><a href="/classroom/student/${encodeURIComponent(p.student)}">${esc(p.student)}</a></div>
      <div>${esc(p.ticker)}</div>
      <div class="${dirClass(p.direction)}">${esc(p.direction)}</div>
      <div class="right">${esc(p.time_horizon)}</div>
      <div class="right">${esc(p.confidence)}<span class="confidence-bar"><i style="width:${esc(p.confidence)}%"></i></span></div>
      <div class="muted-small">${esc(p.setup_type || "—")}</div>
      <div class="muted-small">${esc((p.reasoning || "").slice(0, 140))}${(p.reasoning || "").length > 140 ? "…" : ""}</div>
    </div>
  `).join("");
  $("#latest-list").innerHTML = headers + body;
}

function fmtDelta(v) {
  if (v == null) return "—";
  const sign = v > 0 ? "+" : "";
  return `${sign}${Number(v).toFixed(3)}`;
}

function renderMiniStudentList(rows, options = {}) {
  if (!rows || rows.length === 0) {
    return `<div class="muted small">No students in this bucket.</div>`;
  }
  const showField = options.showField || "trajectory_delta";
  const fieldLabel = options.fieldLabel || "Δ";
  const headers = `
    <div class="cls-row tech header">
      <div>#</div><div>Student</div>
      <div class="right">Brier</div><div class="right">Projected</div>
      <div class="right">${esc(fieldLabel)}</div><div class="right">Setups</div>
      <div>Tech</div>
    </div>
  `;
  const body = rows.map((r, i) => `
    <div class="cls-row tech">
      <div class="muted-small">${i + 1}</div>
      <div class="name"><a href="/classroom/student/${encodeURIComponent(r.name)}">${esc(r.name)}</a></div>
      <div class="right">${fmtBrier(r.observed_brier)}</div>
      <div class="right">${fmtBrier(r.projected_brier)}</div>
      <div class="right ${r[showField] > 0 ? "dir-up" : r[showField] < 0 ? "dir-down" : ""}">${fmtDelta(r[showField])}</div>
      <div class="right">${esc(r.n_setups_active_recent || 0)}/${esc(r.n_setups || 0)} <span class="muted-small">(${esc(r.n_setups_retired || 0)} retired)</span></div>
      <div class="muted-small">${esc(r.technique)}</div>
    </div>
  `).join("");
  return headers + body;
}

async function loadLearningLab() {
  let lab;
  try { lab = await fetchJSON("/api/classroom/learning_lab"); } catch { return; }
  if (!lab.exists) {
    $("#learning-lab").hidden = false;
    $("#learning-lab-overview").innerHTML = `<div class="muted small">No projection data yet. Run <code>python scripts/project_scores.py</code> to compute projections (also runs in the nightly cycle).</div>`;
    return;
  }
  $("#learning-lab").hidden = false;
  const c = lab.classroom || {};
  $("#learning-lab-stamp").textContent = lab.generated_at ? `as of ${lab.generated_at.slice(0, 19).replace("T", " ")}` : "";
  const cards = [
    { label: "Students with projection", value: c.n_active_recent, sub: `of ${c.n_students}` },
    { label: "Avg observed Brier", value: fmtBrier(c.avg_observed_brier), sub: "across all resolutions" },
    { label: "Avg projected Brier", value: fmtBrier(c.avg_projected_brier), sub: "going forward" },
    { label: "Avg learning gain", value: fmtDelta(c.avg_learning_gain), sub: "vs naive 70% baseline" },
    { label: "Retired setups", value: c.n_retired_setups, sub: "cumulative" },
  ];
  $("#learning-lab-overview").innerHTML = cards.map((cd) => `
    <div class="cls-card">
      <div class="label">${esc(cd.label)}</div>
      <div class="value">${esc(cd.value)}</div>
      <div class="sub">${esc(cd.sub)}</div>
    </div>
  `).join("");

  $("#lab-improving").innerHTML = renderMiniStudentList(lab.improving,
    { showField: "trajectory_delta", fieldLabel: "Δ obs→proj" });
  $("#lab-deteriorating").innerHTML = renderMiniStudentList(lab.deteriorating,
    { showField: "trajectory_delta", fieldLabel: "Δ obs→proj" });
  $("#lab-most-learned").innerHTML = renderMiniStudentList(lab.most_learned,
    { showField: "learning_gain", fieldLabel: "Δ naive→proj" });
  $("#lab-retirement").innerHTML = renderMiniStudentList(lab.retirement_candidates,
    { showField: "trajectory_delta", fieldLabel: "Δ obs→proj" });
}

async function loadProjections() {
  try {
    const data = await fetchJSON("/api/classroom/projections");
    if (data && data.students) {
      projectionByName = Object.fromEntries(data.students.map((s) => [s.name, s]));
    }
  } catch (e) { console.error(e); }
}

async function init() {
  try { await loadOverview(); } catch (e) { console.error(e); }
  try { await loadProjections(); } catch (e) { console.error(e); }
  try { await loadLearningLab(); } catch (e) { console.error(e); }
  try { await loadLeaderboard(); } catch (e) { console.error(e); }
  try { await loadTechniqueTable(); } catch (e) { console.error(e); }
  try { await loadHall(); } catch (e) { console.error(e); }
  try { await loadUsage(); } catch (e) { console.error(e); }
  try { await loadLatest(); } catch (e) { console.error(e); }
}

init();
