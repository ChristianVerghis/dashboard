"""Shareable progress card.

Renders a single self-contained HTML page from aggregates only: commit counts
per day, per project and per weekday, streaks, and goal completion ratios.
Nothing that describes the work itself leaves the machine: no commit subjects,
file paths, branch names, ports, service state, goal text or verdict reasons.
"""
from __future__ import annotations

import html
import json
from datetime import date, datetime, timezone


KIND_LABEL = {
    "app": "app", "web": "web app", "service": "service", "cli": "cli",
    "docs": "writing", "vault": "notes", "research": "research", "game": "game",
    "hardware": "hardware", "library": "library",
}


def _initials(name: str) -> str:
    parts = [p for p in name.replace("_", "-").split("-") if p]
    if len(parts) >= 2:
        return (parts[0][0] + parts[1][0]).upper()
    return name[:2].upper()


def _goals(p) -> tuple[int, int] | None:
    done = total = 0
    for c in (p.signals or {}).get("checklists", []) or []:
        done += c.get("done", 0) or 0
        total += c.get("total", 0) or 0
    if total:
        return done, total
    return None


def _external_label(ext: dict) -> str:
    kind = ext.get("kind") or "external"
    return "Day job" if kind == "work" else kind.capitalize()


def build_payload(hm: dict, projects: list, show_names: bool) -> dict:
    days = hm["days"]
    by_project: dict[str, list[int]] = {}
    totals: dict[str, int] = {}
    for i, d in enumerate(days):
        for name, n in d["by_project"].items():
            by_project.setdefault(name, [0] * len(days))[i] = n
            totals[name] = totals.get(name, 0) + n

    # Streaks over the whole window (today may still be in progress).
    counts = [d["count"] for d in days]
    cur = 0
    i = len(counts) - 1
    if i >= 0 and counts[i] == 0:
        i -= 1
    while i >= 0 and counts[i] > 0:
        cur += 1
        i -= 1
    longest = run = 0
    for c in counts:
        run = run + 1 if c > 0 else 0
        longest = max(longest, run)

    weekday = [0] * 7
    for d in days:
        weekday[d["weekday"]] += d["count"]

    label_for = (lambda n: n) if show_names else _initials
    proj_rows = []
    for p in projects:
        if not p.has_git or p.name not in totals:
            continue
        g = _goals(p)
        last_idx = max((i for i, v in enumerate(by_project[p.name]) if v), default=None)
        proj_rows.append({
            "label": label_for(p.name),
            "kind": KIND_LABEL.get((p.manifest or {}).get("kind", ""), (p.manifest or {}).get("kind") or ""),
            "series": by_project[p.name][-90:],
            "total": totals[p.name],
            "last_active_days": (len(days) - 1 - last_idx) if last_idx is not None else None,
            "goals": {"done": g[0], "total": g[1]} if g else None,
        })
    # External sources (work GitLab etc.) are not projects on disk but they are in
    # the day totals, so give them a row too, flagged approximate where they are.
    for ext in hm.get("external", []) or []:
        name = ext["name"]
        if name not in by_project:
            continue
        last_idx = max((i for i, v in enumerate(by_project[name]) if v), default=None)
        proj_rows.append({
            "label": name if show_names else _external_label(ext),
            "kind": ("work, approx." if ext.get("approximate") else "work") if ext.get("kind") == "work" else ext.get("kind", "external"),
            "series": by_project[name][-90:],
            "total": totals[name],
            "last_active_days": (len(days) - 1 - last_idx) if last_idx is not None else None,
            "goals": None,
            "external": True,
            "approximate": bool(ext.get("approximate")),
        })
    proj_rows.sort(key=lambda r: -r["total"])

    return {
        "generated": datetime.now(timezone.utc).astimezone().strftime("%B %-d, %Y"),
        "window_weeks": hm["weeks"],
        "days": [{"date": d["date"], "weekday": d["weekday"], "count": d["count"]} for d in days],
        "total": hm["total"],
        "max": hm["max"],
        "active_days": sum(1 for c in counts if c),
        "this_week": sum(counts[-7:]),
        "streak": cur,
        "longest_streak": longest,
        "weekday": weekday,
        "projects": proj_rows,
        "show_names": show_names,
        # with names hidden, an external source is described by its kind only:
        # its name (an employer's GitLab, say) is exactly what ?names=0 hides
        "external": [{"name": e["name"] if show_names else _external_label(e),
                      "kind": e.get("kind"), "approximate": bool(e.get("approximate")), "total": e.get("total", 0)}
                     for e in (hm.get("external", []) or [])],
    }


def render(hm: dict, projects: list, show_names: bool = True) -> str:
    data = build_payload(hm, projects, show_names)
    payload = json.dumps(data).replace("</", "<\\/")
    title = f"Side projects · {data['generated']}"
    ext = data.get("external") or []
    ext_note = ""
    if ext:
        parts = [f"{html.escape(e['name'])}{' (approximate)' if e.get('approximate') else ''}" for e in ext]
        ext_note = " Includes external activity from " + ", ".join(parts) + ": dates and counts only."
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{html.escape(title)}</title>
<style>
{CSS}
</style>
</head>
<body>
<main>
  <header class="top">
    <div>
      <h1>Side projects</h1>
      <p class="sub">What I have been building, in commits. <span id="range"></span></p>
    </div>
    <p class="stamp">{html.escape(data['generated'])}</p>
  </header>
  <section class="stats" id="stats"></section>
  <section class="panel">
    <div class="phead"><h2>Commits, last 12 months</h2><span class="muted" id="hm-summary"></span></div>
    <div class="hm-body">
      <div class="hm-wrap"><svg id="heatmap"></svg></div>
      <div class="hm-side" id="weekday"></div>
    </div>
  </section>
  <section class="panel">
    <div class="phead"><h2>Where the year went</h2><span class="muted" id="share-summary"></span></div>
    <div class="share-bar" id="share-bar"></div>
  </section>
  <section class="panel">
    <div class="phead"><h2>Projects</h2><span class="muted">last 90 days · goals done</span></div>
    <div class="grid" id="projects"></div>
  </section>
  <footer>Aggregates only. No commit messages, file names or notes are included.{ext_note}</footer>
</main>
<script id="data" type="application/json">{payload}</script>
<script>
{JS}
</script>
</body>
</html>"""


CSS = r"""
:root{--bg:#0b0f17;--panel:#121826;--panel-2:#182032;--border:#233048;--text:#e6edf3;--muted:#8b98ad;
--accent:#7aa2f7;--hm-0:#161d2d;--hm-1:#253a66;--hm-2:#3a5aa0;--hm-3:#5f88dd;--hm-4:#a9c6ff}
@media (prefers-color-scheme: light){:root{--bg:#f6f7f9;--panel:#fff;--panel-2:#f1f3f7;--border:#d8dde6;--text:#1a2236;--muted:#5b6577;
--accent:#2c5fda;--hm-0:#e9edf4;--hm-1:#c3d2f2;--hm-2:#8fabe6;--hm-3:#4f78d2;--hm-4:#1f44a8}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 -apple-system,BlinkMacSystemFont,"SF Pro Display","Inter",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:1120px;margin:0 auto;padding:32px 20px 40px;display:grid;gap:18px}
.top{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;flex-wrap:wrap;padding-bottom:6px}
h1{margin:0;font-size:26px;letter-spacing:-0.02em;font-weight:650}
.sub{margin:4px 0 0;color:var(--muted)}
.stamp{margin:0;color:var(--muted);font-size:13px}
.muted{color:var(--muted);font-size:12px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.stat{position:relative;overflow:hidden;background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:16px 16px 14px;min-height:96px;display:flex;flex-direction:column;justify-content:flex-end}
.stat-v{font-size:32px;font-weight:650;line-height:1;letter-spacing:-0.02em;font-variant-numeric:tabular-nums;position:relative}
.stat-k{font-size:13px;margin-top:6px;position:relative}
.stat-sub{font-size:11.5px;color:var(--muted);margin-top:2px;position:relative}
.stat-spark{position:absolute;right:0;bottom:0;width:62%;height:60%;pointer-events:none}
.stat-spark .a{fill:var(--accent);fill-opacity:.10}.stat-spark .l{fill:none;stroke:var(--accent);stroke-opacity:.45;stroke-width:1.5;vector-effect:non-scaling-stroke}
.panel{background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:16px 18px}
.phead{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:12px}
.phead h2{margin:0;font-size:12.5px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}
.hm-body{display:flex;gap:28px;flex-wrap:wrap;align-items:flex-start}
.hm-wrap{flex:0 1 auto;min-width:0;overflow-x:auto}
.hm-wrap svg{display:block}
.hm-side{flex:1 1 170px;min-width:170px;max-width:300px}
.hm-cell.l0{fill:var(--hm-0)}.hm-cell.l1{fill:var(--hm-1)}.hm-cell.l2{fill:var(--hm-2)}.hm-cell.l3{fill:var(--hm-3)}.hm-cell.l4{fill:var(--hm-4)}
.hm-cell.today{stroke:var(--text);stroke-width:1}
.hm-t{font-size:9.5px;fill:var(--muted)}
.hs-title{font-size:12px;color:var(--muted);margin-bottom:8px}
.hs-row{display:grid;grid-template-columns:30px minmax(0,1fr) 34px;gap:10px;align-items:center;font-size:12px;padding:2px 0}
.hs-k{color:var(--muted)}.hs-row.best .hs-k,.hs-row.best .hs-n{color:var(--text)}
.hs-bar{height:8px;background:var(--panel-2);border-radius:3px;overflow:hidden}.hs-bar i{display:block;height:100%;background:var(--hm-2);border-radius:3px}
.hs-row.best .hs-bar i{background:var(--hm-3)}
.hs-n{text-align:right;color:var(--muted);font-variant-numeric:tabular-nums}
.share-bar{display:flex;gap:2px;height:18px;border-radius:6px;overflow:hidden;background:var(--panel-2);margin-bottom:12px}
.share-bar i{display:block;flex:0 0 auto;min-width:3px;height:100%}
.share-legend{display:flex;flex-wrap:wrap;gap:6px 18px}
.share-item{display:inline-flex;align-items:center;gap:7px;font-size:13px}
.sw{width:9px;height:9px;border-radius:2px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:10px}
.tile{display:grid;grid-template-columns:32px minmax(0,1fr) 64px;gap:10px;align-items:center;background:var(--panel-2);border:1px solid var(--border);border-radius:10px;padding:10px 12px}
.ic{width:32px;height:32px;border-radius:7px;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:11px;border:1px solid}
.tn{font-weight:600;font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tb{min-width:0}
.tm{margin-top:3px;font-size:11px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tg{display:flex;gap:8px;align-items:center;margin-top:6px;font-size:11px;color:var(--muted)}
.goals{display:flex;gap:2px;flex:1 1 auto;height:4px;min-width:0;overflow:hidden}
.goals i{flex:1 1 0;min-width:0;background:var(--border);border-radius:1px}.goals i.on{background:var(--accent)}
.spark{width:64px;height:26px}.spark path{fill:none;stroke:var(--accent);stroke-width:1.4;stroke-linejoin:round;stroke-linecap:round;opacity:.85}.spark circle{fill:var(--accent)}
footer{color:var(--muted);font-size:11.5px;text-align:center;padding-top:6px}
"""


JS = r"""
const D = JSON.parse(document.getElementById('data').textContent);
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function color(name){let h=0;for(const ch of name)h=(h*31+ch.charCodeAt(0))>>>0;return `hsl(${h%360} 60% 62%)`;}
const first = D.days[0].date, last = D.days[D.days.length-1].date;
const fmt = iso => new Date(iso+'T00:00:00').toLocaleDateString(undefined,{month:'short',year:'numeric'});
document.getElementById('range').textContent = `${fmt(first)} to ${fmt(last)}.`;

// Stats
function sparkArea(counts,w,h){const max=Math.max(1,...counts);const step=w/(counts.length-1);
  const pts=counts.map((c,i)=>[i*step,h-(c/max)*(h-2)-1]);const line=pts.map(([x,y],i)=>`${i?'L':'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  return `<svg class="stat-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><path class="a" d="${line} L${w},${h} L0,${h} Z"/><path class="l" d="${line}"/></svg>`;}
const weeks=[];for(let i=0;i<D.days.length;i+=7)weeks.push(D.days.slice(i,i+7).reduce((a,d)=>a+d.count,0));
const stats=[
  {v:D.total,k:'commits',sub:'in the last 12 months',spark:weeks},
  {v:D.active_days,k:'active days',sub:`of ${D.days.length}`},
  {v:D.streak,k:'day streak',sub:`longest ${D.longest_streak}`},
  {v:D.projects.length,k:'projects touched',sub:`${D.this_week} commits this week`},
];
document.getElementById('stats').innerHTML=stats.map(t=>`<div class="stat">${t.spark?sparkArea(t.spark,160,48):''}<div class="stat-v">${t.v}</div><div class="stat-k">${esc(t.k)}</div><div class="stat-sub">${esc(t.sub)}</div></div>`).join('');

// Heatmap
(function(){const svg=document.getElementById('heatmap');const cell=11,gap=3,left=30,top=18,pitch=cell+gap;const cols=Math.ceil(D.days.length/7);
  const w=left+cols*pitch,h=top+7*pitch;svg.setAttribute('viewBox',`0 0 ${w} ${h}`);svg.setAttribute('width',w);svg.setAttribute('height',h);
  const nz=D.days.map(d=>d.count).filter(c=>c>0).sort((a,b)=>a-b);const q=f=>nz.length?nz[Math.min(nz.length-1,Math.floor(f*nz.length))]:1;
  const cuts=[q(.25),q(.5),q(.75)];const lvl=n=>n===0?0:n<=cuts[0]?1:n<=cuts[1]?2:n<=cuts[2]?3:4;
  const M=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];let lastM=-1;let out='';
  D.days.forEach((d,i)=>{const col=Math.floor(i/7),row=d.weekday,x=left+col*pitch,y=top+row*pitch;const m=new Date(d.date+'T00:00:00').getMonth();
    if(row===0&&m!==lastM&&i>0&&col<cols-1)out+=`<text class="hm-t" x="${x}" y="${top-7}">${M[m]}</text>`;if(row===0)lastM=m;
    out+=`<rect class="hm-cell l${lvl(d.count)} ${d.date===last?'today':''}" x="${x}" y="${y}" width="${cell}" height="${cell}" rx="2.5"><title>${d.date}: ${d.count} commit${d.count===1?'':'s'}</title></rect>`;});
  ['','Mon','','Wed','','Fri',''].forEach((l,r)=>{if(l)out+=`<text class="hm-t" x="0" y="${top+r*pitch+cell-2}">${l}</text>`;});
  svg.innerHTML=out;
  document.getElementById('hm-summary').textContent=`busiest day ${D.max} commits`;
  const names=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'],max=Math.max(1,...D.weekday),best=D.weekday.indexOf(max);
  document.getElementById('weekday').innerHTML='<div class="hs-title">By weekday</div>'+[1,2,3,4,5,6,0].map(i=>`<div class="hs-row ${i===best?'best':''}"><span class="hs-k">${names[i]}</span><span class="hs-bar"><i style="width:${(D.weekday[i]/max*100).toFixed(1)}%"></i></span><span class="hs-n">${D.weekday[i]}</span></div>`).join('');
})();

// Share of the year
(function(){const total=D.projects.reduce((a,p)=>a+p.total,0)||1;
  document.getElementById('share-bar').innerHTML=D.projects.map(p=>`<i style="flex-basis:${(p.total/total*100).toFixed(2)}%;background:${color(p.label)}" title="${esc(p.label)} · ${p.total}"></i>`).join('');
  const top=D.projects.slice(0,6),rest=D.projects.slice(6).reduce((a,p)=>a+p.total,0);
  document.getElementById('share-summary').textContent=`${D.total} commits across ${D.projects.length} projects`;
  document.getElementById('share-bar').insertAdjacentHTML('afterend',`<div class="share-legend">${top.map(p=>`<span class="share-item"><span class="sw" style="background:${color(p.label)}"></span>${esc(p.label)} <span class="muted">${p.total}</span></span>`).join('')}${rest?`<span class="share-item muted"><span class="sw" style="background:var(--border)"></span>${D.projects.length-6} more <span class="muted">${rest}</span></span>`:''}</div>`);
})();

// Project tiles
(function(){const shared=Math.max(1,...D.projects.flatMap(p=>p.series));
  const spark=s=>{const w=64,h=26,step=w/(s.length-1);const pts=s.map((c,i)=>[i*step,h-2-(c/shared)*(h-5)]);const d=pts.map(([x,y],i)=>`${i?'L':'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');const[lx,ly]=pts[pts.length-1];
    return `<svg class="spark" viewBox="0 0 ${w} ${h}"><path d="${d}"/><circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="2.2"/></svg>`;};
  const ini=n=>{const p=n.split(/[-_\s]+/).filter(Boolean);return p.length>=2?(p[0][0]+p[1][0]).toUpperCase():n.slice(0,2).toUpperCase();};
  const age=d=>d==null?'':d===0?'today':d<30?`${d}d ago`:`${Math.floor(d/30)}mo ago`;
  document.getElementById('projects').innerHTML=D.projects.map(p=>{const c=color(p.label);const g=p.goals;
    const goals=g?`<div class="tg"><span class="goals" title="${g.done} of ${g.total} goals done">${g.total<=20?Array.from({length:g.total},(_,i)=>`<i class="${i<g.done?'on':''}"></i>`).join(''):`<i class="on" style="flex:${g.done}"></i><i style="flex:${g.total-g.done}"></i>`}</span><span>${g.done}/${g.total}</span></div>`:'';
    const meta=[p.kind,`${p.total} commit${p.total===1?'':'s'}`,age(p.last_active_days)].filter(Boolean).join(' · ');
    return `<div class="tile"><span class="ic" style="background:${c}1a;color:${c};border-color:${c}40">${esc(ini(p.label))}</span><div class="tb"><div class="tn">${esc(p.label)}</div><div class="tm">${esc(meta)}</div>${goals}</div>${spark(p.series)}</div>`;}).join('');
})();
"""
