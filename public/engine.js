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
