/* Engine dashboard. Reads /api/engine/*, renders the paper-trading record. */
const $ = s => document.querySelector(s);
const esc = s => String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const pc = (v,d=1) => v==null ? "n/a" : `${(v*100).toFixed(d)}%`;
const usd = v => (v==null?"n/a":`${v<0?"-":""}$${Math.abs(v).toFixed(2)}`);
const ago = t => {
  const m = Math.round((Date.now()-new Date(t))/60000);
  if (m<60) return `${m}m ago`;
  if (m<1440) return `${Math.round(m/60)}h ago`;
  return `${Math.round(m/1440)}d ago`;
};

async function refresh(){
  const [rep, live] = await Promise.all([
    fetch("/api/engine/report").then(r=>r.json()),
    fetch("/api/engine/live").then(r=>r.json()).catch(()=>null),
  ]);
  renderLive(live); renderKpis(rep); renderCalib(rep); renderGate(rep); renderRows(rep);
}

function renderLive(l){
  const el = $("#live");
  if (!l || !l.ready){
    el.className = "banner safe";
    el.innerHTML = `<b>Paper mode.</b> No money moves. Real execution needs
      ${l ? l.blockers.length : 3} things set that are not set, and Polymarket has no
      testnet, so live trading would spend real USDC on Polygon.`;
  } else {
    el.className = "banner";
    el.innerHTML = `<b style="color:var(--bad)">LIVE TRADING ARMED.</b>
      Orders up to $${l.cap} can be signed. Unset LIVE_TRADING to disarm.`;
  }
}

function renderKpis(r){
  const beat = r.brierJev!=null && r.brierCrowd!=null ? r.brierJev < r.brierCrowd : null;
  const k = [
    ["predictions", r.total, `${r.open} open`, "plain"],
    ["settled", r.settled, r.settled ? "scored" : "nothing resolved yet", "plain"],
    ["jev brier", r.brierJev==null?"n/a":r.brierJev.toFixed(4),
      r.settled?"lower is better":"needs settled rows", beat===null?"plain":beat?"good":"bad"],
    ["crowd brier", r.brierCrowd==null?"n/a":r.brierCrowd.toFixed(4),
      "the benchmark to beat", "plain"],
    ["p&l gated", usd(r.pnlGated), `${r.betsGated} bets`, r.pnlGated>0?"good":r.pnlGated<0?"bad":"plain"],
    ["p&l ungated", usd(r.pnlUngated), `${r.betsUngated} bets`, r.pnlUngated>0?"good":r.pnlUngated<0?"bad":"plain"],
  ];
  $("#kpis").innerHTML = k.map(([lab,val,sub,cls])=>
    `<div class="kpi"><b class="${cls}">${esc(String(val))}</b><span>${lab}</span>
     <div class="sub">${esc(sub)}</div></div>`).join("");
}

function renderCalib(r){
  const rows = r.calibration ?? [];
  const any = rows.some(b=>b.n>0);
  if (!any) return void($("#calib").innerHTML =
    `<div class="empty">No settled predictions yet.<br>
     <span style="font-size:11.5px">Calibration needs markets to actually resolve. Run a scan, then
     come back after some close.</span></div>`);
  $("#calib").innerHTML = rows.map(b=>{
    if(!b.n) return `<div class="crow"><span class="lab">${(b.lo*100)|0}-${(b.hi*100)|0}%</span>
      <div class="track"></div><div class="track"></div><span class="n">0</span></div>`;
    return `<div class="crow"><span class="lab">${(b.lo*100)|0}-${(b.hi*100)|0}%</span>
      <div class="track"><i style="width:${b.predicted*100}%;background:var(--acc)"></i></div>
      <div class="track"><i style="width:${b.actual*100}%;background:var(--ok)"></i></div>
      <span class="n">n=${b.n}</span></div>`;
  }).join("") + `<div class="legend"><span><s style="background:var(--acc)"></s>predicted</span>
    <span><s style="background:var(--ok)"></s>actual</span>
    <span>bars should match if Jev is calibrated</span></div>`;
}

function renderGate(r){
  if (!r.settled) return void($("#gatecmp").innerHTML =
    `<div class="empty">Not enough settled rows to compare.<br>
     <span style="font-size:11.5px">Both rules are being recorded on every prediction, so this
     fills in once markets resolve.</span></div>`);
  const line = (lab,b,n) => `<div class="crow" style="grid-template-columns:120px 1fr 60px">
    <span class="lab">${lab}</span>
    <div class="track"><i style="width:${Math.min(100,(b??0)/0.5*100)}%;background:${
      b!=null&&b<0.25?"var(--ok)":"var(--warn)"}"></i></div>
    <span class="n">${b==null?"n/a":b.toFixed(3)}</span></div>`;
  $("#gatecmp").innerHTML =
    line("gated", r.brierGated, r.betsGated) +
    line("ungated only", r.brierUngatedOnly, r.betsUngated) +
    `<div class="legend"><span>Brier of the bets each rule took. Lower is better.</span></div>`;
}

function renderRows(r){
  const tb = $("#rows").querySelector("tbody");
  if (!r.rows?.length) return void(tb.innerHTML =
    `<tr><td colspan="10" class="empty">No predictions yet. Press <b>Run scan</b>.</td></tr>`);
  $("#rowinfo").textContent = `${r.rows.length} shown`;
  tb.innerHTML = r.rows.map(x=>{
    const rule = x.gated ? `<span class="badge g">gated</span>`
              : x.ungated ? `<span class="badge u">ungated</span>`
              : `<span class="badge n">no bet</span>`;
    const stake = x.gated ? x.stake_gated : x.ungated ? x.stake_ungated : 0;
    const res = x.outcome==null ? `<span class="muted">open</span>`
      : `${x.outcome ? "YES" : "NO"} <span class="${(x.pnl_gated??0)+(x.pnl_ungated??0)>=0?"pos":"neg"}">${
          usd((x.pnl_gated??0)||(x.pnl_ungated??0))}</span>`;
    return `<tr>
      <td class="muted">${ago(x.created_at)}</td>
      <td class="mkt">${esc(x.market_label)}<small>${esc(x.event_title)}</small></td>
      <td class="r">${pc(x.crowd,1)}</td>
      <td class="r">${pc(x.jev,1)}</td>
      <td class="r ${x.edge>0?"pos":"neg"}">${x.edge>0?"+":""}${(x.edge*100).toFixed(1)}pt</td>
      <td class="r ${(x.evidence??0)>=0.5?"":"neg"}">${pc(x.evidence,0)}</td>
      <td>${rule}</td>
      <td>${x.gated||x.ungated?esc(x.side??""):""}</td>
      <td class="r">${stake?usd(stake):""}</td>
      <td>${res}</td></tr>`;
  }).join("");
}

async function run(btn, url, label){
  const old = btn.textContent;
  btn.disabled = true; btn.textContent = label;
  try {
    const res = await fetch(url, {method:"POST",headers:{"Content-Type":"application/json"},
      body: JSON.stringify({limit:8})});
    const d = await res.json();
    if (d.error) alert(d.error);
  } catch(e){ alert(String(e.message??e)); }
  finally { btn.disabled=false; btn.textContent=old; await refresh(); }
}
$("#scan").onclick = e => run(e.target, "/api/engine/scan", "Scanning…");
$("#settle").onclick = e => run(e.target, "/api/engine/settle", "Settling…");
refresh();

/* ===================== tabs ===================== */
const PANELS = ["record","experiment","context"];
function showTab(name){
  PANELS.forEach(p => $(`#panel-${p}`).hidden = p !== name);
  document.querySelectorAll("#tabs button").forEach(b =>
    b.setAttribute("aria-selected", String(b.dataset.tab === name)));
  location.hash = name;
  if (name === "experiment") loadExperiments();
  if (name === "context") loadConfig();
}
$("#tabs").onclick = e => { const t = e.target.closest("[data-tab]"); if (t) showTab(t.dataset.tab); };

/* ===================== context tab ===================== */
let CFG = null, FIELDS = [], DEFAULTS = null;

async function loadConfig(){
  const d = await fetch("/api/engine/config").then(r=>r.json());
  CFG = d.config; FIELDS = d.fields; DEFAULTS = d.defaults;
  renderFields(); renderNums();
}
function renderFields(){
  $("#cfgFields").innerHTML = FIELDS.map(f=>`
    <label class="fld">
      <input type="checkbox" data-f="${f.key}" ${CFG.fields[f.key]!==false?"checked":""}
        ${f.locked?"disabled":""}>
      <span><b>${esc(f.label)}${f.locked?`<span class="lock">always on</span>`:""}</b>
      <small>${esc(f.help)}</small></span>
    </label>`).join("");
  $("#cfgFields").onchange = e => {
    const k = e.target.dataset.f; if (!k) return;
    CFG.fields[k] = e.target.checked;
  };
}
function renderNums(){
  const n = [
    ["newsMax","News items","How many headlines to pull per market.","number",1,20],
    ["newsWindow","News window","How far back to search.","select",null,null,
      [["d","last day"],["w","last week"],["m","last month"],["y","last year"]]],
    ["minEdge","Min edge","Gap from the crowd before a bet is recorded.","number",0.01,0.5,null,0.01],
    ["minEvidence","Min evidence","Jev's own sufficiency score for the gated rule.","number",0,1,null,0.05],
    ["minVolume","Min volume","Skip markets thinner than this, in dollars.","number",0,10000000,null,1000],
    ["bankroll","Bankroll","Virtual money. Nothing is at risk.","number",10,1000000,null,10],
  ];
  $("#cfgNums").innerHTML = n.map(([k,lab,help,type,min,max,opts,step])=>`
    <div class="num"><div><b>${lab}</b><small>${esc(help)}</small></div>
    ${type==="select"
      ? `<select data-n="${k}">${opts.map(([v,l])=>
          `<option value="${v}" ${CFG[k]===v?"selected":""}>${l}</option>`).join("")}</select>`
      : `<input type="number" data-n="${k}" value="${CFG[k]}" min="${min}" max="${max}"
           step="${step??1}">`}</div>`).join("");
  $("#cfgNums").onchange = e => {
    const k = e.target.dataset.n; if (!k) return;
    CFG[k] = e.target.type === "number" ? Number(e.target.value) : e.target.value;
  };
}
$("#cfgSave").onclick = async e => {
  e.target.disabled = true;
  try {
    const r = await fetch("/api/engine/config",{method:"POST",
      headers:{"Content-Type":"application/json"},body:JSON.stringify(CFG)}).then(r=>r.json());
    CFG = r.config; renderFields(); renderNums();
    $("#cfgMsg").innerHTML = `<span style="color:var(--ok)">Saved. The next scan uses these.</span>`;
  } catch(err){ $("#cfgMsg").innerHTML = `<span style="color:var(--bad)">${esc(String(err))}</span>`; }
  finally { e.target.disabled = false; }
};
$("#cfgReset").onclick = async () => {
  CFG = structuredClone(DEFAULTS); renderFields(); renderNums();
  $("#cfgMsg").textContent = "Defaults restored. Press Save to keep them.";
};
$("#cfgPreview").onclick = async e => {
  const slug = $("#cfgSlug").value.trim(); if (!slug) return;
  e.target.disabled = true; $("#cfgOut").textContent = "Building the state…";
  try {
    const d = await fetch("/api/engine/preview",{method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({slug, fields: CFG.fields})}).then(r=>r.json());
    if (d.error) throw new Error(d.error);
    const total = d.fields.reduce((a,f)=>a+f.chars,0);
    $("#cfgOut").innerHTML = `<div style="margin-top:var(--s2)">` + d.fields.map(f=>`
      <div class="vrow" style="grid-template-columns:150px 1fr 90px">
        <span class="lab">${esc(f.key)}</span>
        <div class="track"><i style="width:${Math.min(100,f.chars/Math.max(total,1)*100*2)}%"></i></div>
        <span class="val">${f.chars} ch</span></div>`).join("") +
      `<div class="hint">${d.fields.length} fields · ${total} characters · about ${Math.round(total/4)} tokens.
       ${d.dropped.length?`Switched off: <b>${d.dropped.map(esc).join(", ")}</b>.`:""}</div></div>`;
  } catch(err){ $("#cfgOut").innerHTML = `<span style="color:var(--bad)">${esc(String(err.message??err))}</span>`; }
  finally { e.target.disabled = false; }
};

/* ===================== experiment tab ===================== */
let VARIANTS = null;

async function loadExperiments(){
  const d = await fetch("/api/engine/experiments").then(r=>r.json());
  VARIANTS = d.variants;
  if (!$("#expVariants").children.length){
    $("#expVariants").innerHTML = Object.entries(VARIANTS).map(([k,v])=>
      `<label class="vchip"><input type="checkbox" value="${k}" checked>${esc(v.label)}</label>`).join("");
    $("#expVariants").onchange = updateCost;
    $("#expSlugs").oninput = updateCost;
    updateCost();
  }
  renderRuns(d.runs);
}
function updateCost(){
  const slugs = $("#expSlugs").value.split("\n").map(s=>s.trim()).filter(Boolean).length;
  const vs = [...$("#expVariants").querySelectorAll("input:checked")].length;
  $("#expCost").textContent = slugs && vs ? `${slugs*vs} Jev calls` : "";
}
$("#expRun").onclick = async e => {
  const slugs = $("#expSlugs").value.split("\n").map(s=>s.trim()).filter(Boolean);
  const variants = [...$("#expVariants").querySelectorAll("input:checked")].map(i=>i.value);
  if (!slugs.length) return void($("#expMsg").innerHTML = `<span style="color:var(--bad)">Add at least one slug.</span>`);
  if (!variants.length) return void($("#expMsg").innerHTML = `<span style="color:var(--bad)">Pick at least one variant.</span>`);
  e.target.disabled = true; e.target.textContent = "Running…";
  $("#expMsg").textContent = `Asking Jev ${slugs.length*variants.length} times. News lookups are slow.`;
  try {
    const d = await fetch("/api/engine/experiment",{method:"POST",
      headers:{"Content-Type":"application/json"},body:JSON.stringify({slugs,variants})}).then(r=>r.json());
    if (d.error) throw new Error(d.error);
    $("#expMsg").textContent = "";
    await loadExperiments();
  } catch(err){ $("#expMsg").innerHTML = `<span style="color:var(--bad)">${esc(String(err.message??err))}</span>`; }
  finally { e.target.disabled = false; e.target.textContent = "Run"; }
};

function renderRuns(runs){
  if (!runs?.length) return void($("#expOut").innerHTML =
    `<div class="empty">No experiments yet.<br><span style="font-size:11.5px">
     Paste a slug above and press Run. Four variants on one market is four Jev calls.</span></div>`);
  $("#expInfo").textContent = `${runs.length} run${runs.length===1?"":"s"}`;
  $("#expOut").innerHTML = runs.map(run=>{
    const best = run.summary?.length
      ? run.summary.reduce((a,b)=>(b.evidence??0)>(a.evidence??0)?b:a) : null;
    const sum = run.summary?.length ? `
      <div class="exp"><h3>Across ${run.markets.length} market${run.markets.length===1?"":"s"}</h3>
      <div class="meta">${ago(run.created_at)} · higher evidence is better, smaller gap is better</div>
      ${run.summary.map(s=>`
        <div class="vrow"><span class="lab ${s===best?"best":""}">${esc(s.label)}</span>
          <span class="tok">${Math.round(s.tokens)} tok</span>
          <div class="track"><i style="width:${(s.evidence*100).toFixed(0)}%;background:${
            s===best?"var(--ok)":"var(--acc)"}"></i></div>
          <span class="val">${pc(s.evidence,0)} · ${(s.absGap*100).toFixed(1)}pt</span></div>`).join("")}
      ${best ? `<div class="hint">Best evidence: <b style="color:var(--ink)">${esc(best.label)}</b>
        at ${pc(best.evidence,0)}. If that is not the richest variant, the extra context was noise.</div>` : ""}
      </div>` : "";
    const mkts = run.markets.map(m=>{
      if (m.error) return `<div class="exp"><h3>${esc(m.slug)}</h3>
        <div class="meta" style="color:var(--bad)">${esc(m.error)}</div></div>`;
      return `<div class="exp"><h3>${esc(m.title)}</h3>
        <div class="meta">${esc(m.market)} · crowd ${pc(m.crowd,0)} ·
          ${m.notesKept} notes kept of ${m.commentTotal} ·
          ${m.newsCount} news${m.newsDropped?` (${m.newsDropped} dropped as irrelevant)`:""}</div>
        ${m.runs.map(r=> r.error
          ? `<div class="vrow"><span class="lab">${esc(r.label)}</span>
             <span class="tok"></span><span style="color:var(--bad);font-size:11.5px">${esc(r.error)}</span><span></span></div>`
          : `<div class="vrow"><span class="lab">${esc(r.label)}</span>
             <span class="tok">${r.tokens ?? "?"} tok</span>
             <div class="track"><i style="width:${(r.evidence*100).toFixed(0)}%"></i></div>
             <span class="val">${pc(r.evidence,0)} · ${(r.gap*100>=0?"+":"")}${(r.gap*100).toFixed(1)}pt</span>
             </div>`).join("")}</div>`;
    }).join("");
    return sum + mkts;
  }).join("");
}

if (PANELS.includes(location.hash.slice(1))) showTab(location.hash.slice(1));
