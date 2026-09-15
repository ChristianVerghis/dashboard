/* Per-student detail page. */

const $ = (sel, root = document) => root.querySelector(sel);

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

function dirClass(d) {
  if (d === "up") return "dir-up";
  if (d === "down") return "dir-down";
  if (d === "flat") return "dir-flat";
  return "";
}

async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}

function getName() {
  const m = location.pathname.match(/\/classroom\/student\/(.+)$/);
  return m ? decodeURIComponent(m[1]) : null;
}

async function init() {
  const name = getName();
  if (!name) {
    document.body.innerHTML = "<p>Missing student name.</p>";
    return;
  }
  let data;
  try {
    data = await fetchJSON(`/api/classroom/students/${encodeURIComponent(name)}`);
  } catch (e) {
    document.body.innerHTML = `<p>Student not found: ${esc(name)}</p>`;
    return;
  }
  $("#student-name").textContent = name;
  const t = data.score.technique || "—";
  const params = data.score.technique_params || {};
  const paramStr = Object.entries(params).map(([k, v]) => `${k}=${v}`).join(" · ");
  $("#student-technique").textContent = paramStr ? `${t} · ${paramStr}` : t;
  $("#student-meta").textContent = `created ${data.score.created_at ? fmtDate(data.score.created_at) : "—"}`;

  const cards = [
    { label: "Total predictions", value: fmtInt(data.log.length) },
    { label: "Resolved", value: fmtInt(data.score.total_resolved) },
    { label: "Correct", value: fmtInt(data.score.total_correct) },
    { label: "Hit rate", value: fmtPct(data.score.hit_rate) },
    { label: "Rolling Brier (30)", value: fmtBrier(data.score.rolling_brier_30) },
    { label: "Lifetime Brier", value: fmtBrier(data.score.lifetime_brier) },
    { label: "Current / best streak", value: `${fmtInt(data.score.current_streak)} / ${fmtInt(data.score.best_streak)}` },
    { label: "Calibration shift", value: `${data.score.calibration_shift > 0 ? "+" : ""}${data.score.calibration_shift}` },
  ];
  $("#student-stats").innerHTML = cards.map((c) => `
    <div class="cls-card">
      <div class="label">${esc(c.label)}</div>
      <div class="value">${esc(c.value)}</div>
    </div>
  `).join("");

  $("#student-profile").textContent = data.profile_md || "(no profile)";

  // Setups (now with retirement state)
  const setups = data.score.setups || {};
  if (Object.keys(setups).length) {
    const header = `
      <div class="cls-row setup header">
        <div>Setup</div><div class="right">α</div><div class="right">β</div>
        <div class="right">n</div><div class="right">Posterior</div>
        <div>State</div>
      </div>
    `;
    const rows = Object.entries(setups)
      .sort((a, b) => (b[1].n || 0) - (a[1].n || 0))
      .map(([setup, rec]) => {
        const alpha = rec.alpha || 5;
        const beta = rec.beta || 5;
        const post = alpha / (alpha + beta);
        let state;
        if (rec.retired) {
          state = `<span class="status-resolved-wrong">retired ${rec.retired_at ? "at " + esc(rec.retired_at.slice(0,10)) : ""}</span>`;
        } else if (rec.n >= 10 && post < 0.50) {
          state = `<span class="muted-small">weak — confidence haircut applied</span>`;
        } else if (rec.n >= 20 && post > 0.60) {
          state = `<span class="status-resolved-correct">strong</span>`;
        } else if ((rec.n || 0) < 5) {
          state = `<span class="muted-small">prior-dominated (n=${rec.n || 0})</span>`;
        } else {
          state = `<span class="muted-small">active</span>`;
        }
        return `
          <div class="cls-row setup">
            <div>${esc(setup)}</div>
            <div class="right">${esc(alpha)}</div>
            <div class="right">${esc(beta)}</div>
            <div class="right">${esc(rec.n || 0)}</div>
            <div class="right">${(post * 100).toFixed(1)}%</div>
            <div>${state}</div>
          </div>
        `;
      }).join("");
    $("#student-setups").innerHTML = header + rows;
  } else {
    $("#student-setups").innerHTML = `<div class="muted small">No setups recorded yet (no resolved predictions).</div>`;
  }

  // Log
  const headers = `
    <div class="cls-row log header">
      <div>Created</div><div>Ticker</div><div>Dir</div><div class="right">H</div>
      <div class="right">Conf</div><div>Setup</div><div>Status</div><div>Reasoning</div>
    </div>
  `;
  const body = data.log.map((p) => {
    let status = p.status === "resolved"
      ? (p.correct ? `<span class="status-resolved-correct">correct</span>` : `<span class="status-resolved-wrong">wrong</span>`)
      : `<span class="status-open">open</span>`;
    return `
      <div class="cls-row log">
        <div class="muted-small">${esc(fmtDate(p.created_at))}</div>
        <div>${esc(p.ticker)}</div>
        <div class="${dirClass(p.direction)}">${esc(p.direction)}</div>
        <div class="right">${esc(p.time_horizon)}</div>
        <div class="right">${esc(p.confidence)}</div>
        <div class="muted-small">${esc(p.setup_type || "—")}</div>
        <div>${status}</div>
        <div class="muted-small">${esc((p.reasoning || "").slice(0, 180))}${(p.reasoning || "").length > 180 ? "…" : ""}</div>
      </div>
    `;
  }).join("");
  $("#student-log-count").textContent = `showing ${data.log.length} most recent`;
  $("#student-log").innerHTML = data.log.length ? headers + body : `<div class="muted small">No predictions yet.</div>`;
}

init();
