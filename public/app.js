import { mountJev } from "/jev3d.js";
/* Jev Oracle, the wire format is the product, not an implementation detail. */
const $ = s => document.querySelector(s);
const esc = s => String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const pct = n => (n*100).toFixed(0)+"%";
const uid = () => Math.random().toString(36).slice(2,7);
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;

let SRCS=[], QS=[], PREV=null, asked=false, LASTRES=null, tab="req";

/* ---------- hologram ---------- */
let JEV=null;
function jevState(m,...a){ if(JEV&&JEV[m]) JEV[m](...a);
  const L={idle:"standby",thinking:"computing",verdict:"resolved",error:"fault"};
  const el=$("#jevstate"); if(el&&L[m]) el.textContent=L[m]; }
addEventListener("load",()=>{
  const c=$("#jev3d");
  if(c&&window.THREE){ JEV=mountJev(c); jevState("idle"); }
});


/* ---------- worked examples: state + a real question mix ---------- */
const EXAMPLES={
 "Support ticket":{
  srcs:[["ticket","Hi, I've been trying to connect my Stripe account for 3 days and the integration keeps failing. I'm losing sales. Please help ASAP."]],
  qs:[{type:"choice",id:"department",primary:true,instructions:"Which team should handle this",
       criteria:[["billing","Payment or subscription issues"],["technical","Bugs or integration problems"],["sales","Pricing or account questions"]]},
      {type:"score",id:"frustration",instructions:"How frustrated the customer appears",
       criteria:[["","Calm, just stating facts"],["","Frustrated but civil"],["","Very angry, strong language"]]},
      {type:"noul",id:"is_urgent",instructions:"The message conveys urgency or time-sensitivity",criteria:[]}]},
 "World-news call":{
  srcs:[["supply_chain","Reuters, March: contract manufacturers in Shenzhen report lead times for consumer electronics assembly down to 9 weeks from 22 weeks a year ago; component pricing has stabilised after two years of volatility."],
        ["eu_regulation","The EU Cyber Resilience Act enters application in December 2027. Connected consumer devices placed on the EU market after that date require conformity assessment and a declared vulnerability-handling process."],
        ["my_situation","Two founders, one hardware engineer, 400k EUR raised, no existing manufacturing relationships, based in Italy."]],
  qs:[{type:"noul",id:"doable",primary:true,
       instructions:"Given this context, it is doable to launch a consumer hardware startup in the EU within the next 12 months",criteria:[]}]},
 "Deploy or hold":{
  srcs:[["change","Schema migration adds two columns and backfills 40M rows. Tested on a staging copy in 6 minutes. No rollback script written yet."],
        ["team","Two of four on-call engineers are on leave next week. The release freeze starts Monday."],
        ["history","The last three migrations ran clean. The one before that locked the table for 20 minutes during business hours."]],
  qs:[{type:"choice",id:"action",primary:true,instructions:"What should the team do with this migration",
       criteria:[["ship_friday","Run it Friday as planned"],["wait_monday","Wait until after the freeze"],["ship_with_rollback","Ship only once a rollback script exists"]]},
      {type:"score",id:"blast_radius",instructions:"How severe is the worst realistic outcome",
       criteria:[["","Recoverable in minutes, no user impact"],["","Hours of degradation, some users affected"],["","Data loss or an outage during business hours"]]}]}
};

/* ---------- question defaults ---------- */
const mk={
 noul:  ()=>({uid:uid(),on:true,type:"noul",  id:"noul_"+(QS.length+1),  instructions:"",criteria:[]}),
 choice:()=>({uid:uid(),on:true,type:"choice",id:"choice_"+(QS.length+1),instructions:"",criteria:[["option_a",""],["option_b",""]]}),
 score: ()=>({uid:uid(),on:true,type:"score", id:"score_"+(QS.length+1), instructions:"",criteria:[["","Low"],["","Medium"],["","High"]]}),
};
function addQ(t){
  const q=mk[t](); if(!QS.some(x=>x.primary)) q.primary=true;
  QS.push(q); enterConsole(); renderQs(); sync();

}

/* ---------- state sources ---------- */
function renderSrcs(){
  $("#srcs").innerHTML = SRCS.map((s,i)=>`<div class="src${s.on?"":" off"}">
    <input type="checkbox" class="tog" ${s.on?"checked":""} data-on="${i}"
      aria-label="Include source ${i+1}${s.label?": "+esc(s.label):""}">
    <div style="flex:1;min-width:0">
      <input type="text" value="${esc(s.label)}" data-l="${i}" placeholder="label (optional)"
        aria-label="Source label" style="margin-bottom:5px;font-size:12px;font-family:ui-monospace,Menlo,monospace">
      <textarea rows="${SRCS.length>1?3:6}" data-t="${i}" aria-label="Source text"
        placeholder="Paste what Jev should reason over…">${esc(s.text)}</textarea>
    </div>${SRCS.length>1?`<button class="ghost" data-d="${i}" aria-label="Remove source">✕</button>`:""}
  </div>`).join("");
  ctxInfo();
}
$("#srcs").addEventListener("input",e=>{const d=e.target.dataset;
  if(d.l!==undefined)SRCS[+d.l].label=e.target.value;
  else if(d.t!==undefined)SRCS[+d.t].text=e.target.value; ctxInfo(); sync();});
$("#srcs").addEventListener("change",e=>{const d=e.target.dataset;
  if(d.on!==undefined){SRCS[+d.on].on=e.target.checked; renderSrcs(); sync();}});
$("#srcs").addEventListener("click",e=>{const d=e.target.dataset;
  if(d.d!==undefined){SRCS.splice(+d.d,1); renderSrcs(); sync();}});
$("#addSrc").onclick=()=>{SRCS.push({label:"",text:"",on:true}); renderSrcs(); sync();};
function ctxInfo(){
  const on=SRCS.filter(s=>s.on&&s.text.trim()), off=SRCS.filter(s=>!s.on&&s.text.trim()).length;
  $("#ctxinfo").textContent=`${on.length} active${off?` · ${off} muted`:""}`;
}

/* ---------- question builder ---------- */
function renderQs(){
  const w=$("#qs"); w.innerHTML="";
  QS.forEach(q=>{
    const el=document.createElement("div");
    el.className="q"+(q.on?"":" off")+(q.primary?" pri":"");
    const isC=q.type==="choice", isS=q.type==="score", isN=q.type==="noul";
    const critLabel=isC?"Options, key → description (description optional)"
                   :isS?"Levels, lowest first (2–10)"
                   :"Criteria (optional), what yes and no mean";
    el.innerHTML=`
      <div class="qhead">
        <input type="checkbox" ${q.on?"checked":""} data-a="on" aria-label="Enable question">
        <span class="pill ${q.type}">${q.type}</span>
        <input type="text" value="${esc(q.id)}" data-a="id" spellcheck="false" aria-label="Question id">
        <button class="ghost sm" data-a="pri" title="Render this as the headline verdict"
          style="${q.primary?"color:var(--acc)":""}">${q.primary?"★":"☆"}</button>
        <button class="ghost sm" data-a="del" aria-label="Delete question">✕</button>
      </div>
      <div class="qbody">
        <div><label>Instructions</label>
          <textarea rows="2" data-a="instructions" placeholder="${esc(
            isN?"A statement that is true or false about the state":
            isC?"What is being decided":"What dimension is being rated")}">${esc(q.instructions)}</textarea></div>
        <div><label>${critLabel}</label><div data-crit></div>
          ${isN&&!q.criteria.length?`<button class="ghost sm" data-a="addcrit">+ define yes / no</button>`:""}
          ${isC?`<button class="ghost sm" data-a="addcrit">+ option</button>`:""}
          ${isS?`<button class="ghost sm" data-a="addcrit">+ level</button>`:""}
        </div>
      </div>`;
    const cw=el.querySelector("[data-crit]");
    q.criteria.forEach(([k,v],i)=>{
      const r=document.createElement("div"); r.className="crit";
      r.innerHTML =
        (isC?`<input type="text" class="key" value="${esc(k)}" data-ck="${i}" placeholder="key" aria-label="Option key">`
         :isN?`<span class="idx">${i===0?"true":"false"}</span>`
         :`<span class="idx">${i}</span>`)
        + `<input type="text" value="${esc(v)}" data-cv="${i}" placeholder="${isC?"description (optional)":"describe this level"}" aria-label="Criterion description">`
        + (isN?"":`<button class="ghost sm" data-cd="${i}" aria-label="Remove">✕</button>`);
      cw.appendChild(r);
    });
    el.addEventListener("input",e=>{const a=e.target.dataset;
      if(a.a==="on"){q.on=e.target.checked; el.classList.toggle("off",!q.on);}
      else if(a.a==="id")q.id=e.target.value;
      else if(a.a==="instructions")q.instructions=e.target.value;
      else if(a.ck!==undefined)q.criteria[+a.ck][0]=e.target.value;
      else if(a.cv!==undefined)q.criteria[+a.cv][1]=e.target.value;
      sync();});
    el.addEventListener("click",e=>{const a=e.target.dataset; if(!a) return;
      if(a.a==="del"){QS=QS.filter(x=>x!==q); if(!QS.some(x=>x.primary)&&QS[0])QS[0].primary=true; renderQs(); sync();}
      else if(a.a==="pri"){QS.forEach(x=>x.primary=false); q.primary=true; renderQs(); sync();}
      else if(a.a==="addcrit"){
        if(isN) q.criteria=[["true",""],["false",""]];
        else if(isS&&q.criteria.length>=10) return;
        else q.criteria.push(isC?["option_"+(q.criteria.length+1),""]:["",""]);
        renderQs(); sync();}
      else if(a.cd!==undefined){q.criteria.splice(+a.cd,1); renderQs(); sync();}});
    w.appendChild(el);
  });
}
document.body.addEventListener("click",e=>{const t=e.target.closest("[data-add]"); if(t) addQ(t.dataset.add);});

/* ---------- build the wire body ---------- */
function buildState(){
  const u=SRCS.filter(s=>s.on&&s.text.trim());
  if(!u.length) return null;
  if(u.length===1&&!u[0].label.trim()) return u[0].text.trim();
  const o={}; u.forEach((s,i)=>o[s.label.trim()||`source_${i+1}`]=s.text.trim()); return o;
}
function buildQuestions(){
  const out={};
  for(const q of QS){
    if(!q.on||!q.id.trim()||!String(q.instructions).trim()) continue;
    const b={type:q.type,instructions:q.instructions.trim()};
    if(q.type==="choice"){
      const c={}; for(const [k,v] of q.criteria) if(k.trim()) c[k.trim()]=v.trim()||null;
      if(Object.keys(c).length<2) continue;
      b.criteria=c;
    }else if(q.type==="score"){
      const c=q.criteria.map(([,v])=>v.trim()).filter(Boolean);
      if(c.length<2) continue;
      b.criteria=c;
    }else if(q.criteria.length===2&&q.criteria.some(([,v])=>v.trim())){
      b.criteria={true:q.criteria[0][1].trim(),false:q.criteria[1][1].trim()};
    }
    out[q.id.trim()]=b;
  }
  return out;
}
const primaryId = () => (QS.find(q=>q.primary&&q.on) ?? QS.find(q=>q.on))?.id?.trim();
function whyQuestions(){
  const p=QS.find(q=>q.primary)??QS[0]; const q=p?.instructions?.trim(); if(!q) return {};
  return {
    _support:{type:"score",instructions:`How strongly does the state SUPPORT a positive answer to: ${q}`,
      criteria:["The state offers nothing in favour","Some weak or indirect support","Clear, direct support"]},
    _obstacles:{type:"score",instructions:`How serious are the obstacles the state raises against: ${q}`,
      criteria:["No obstacles visible in the state","Real but surmountable obstacles","Blocking obstacles"]},
    _enough:{type:"noul",instructions:`The state contains enough information to answer this responsibly: ${q}`,
      criteria:{true:"The state covers what the question turns on",false:"Key facts the question depends on are missing"}},
  };
}
function buildBody(withExtras=true){
  const state=buildState();
  const questions={...buildQuestions(), ...(withExtras&&$("#optWhy").checked?whyQuestions():{})};
  return {state:state??"",model:"jev-latest",questions};
}

/* ---------- the wire panel ---------- */
function hl(json){
  return esc(json)
    .replace(/(&quot;[^&]*?&quot;)(\s*:)/g,'<span class="k">$1</span><span class="p">$2</span>')
    .replace(/:\s*(&quot;[\s\S]*?&quot;)/g,': <span class="s">$1</span>')
    .replace(/:\s*(-?\d+\.?\d*)/g,': <span class="n">$1</span>')
    .replace(/:\s*(true|false|null)/g,': <span class="b">$1</span>');
}
function sync(){
  const body=buildBody();
  const txt=JSON.stringify(body,null,2);
  $("#wireReq").innerHTML=hl(txt);
  if(tab!=="edit") $("#wireEdit").value=txt;
  const n=Object.keys(body.questions).length;
  $("#wirebadge").textContent=`${n} question${n===1?"":"s"} · ${new Blob([txt]).size} B`;
}
document.querySelectorAll('.tabs button').forEach(b=>b.onclick=()=>{
  tab=b.dataset.tab;
  document.querySelectorAll('.tabs button').forEach(x=>x.setAttribute("aria-selected",String(x===b)));
  $("#wireReq").hidden = tab!=="req";
  $("#wireRes").hidden = tab!=="res";
  $("#wireEdit").hidden= tab!=="edit";
  $("#wireActions").hidden = tab!=="edit";
  $("#wireHint").hidden = tab==="edit";
  $("#wireMsg").textContent="";
  if(tab==="edit") $("#wireEdit").value=JSON.stringify(buildBody(),null,2);
  if(tab==="res"&&!LASTRES) $("#wireRes").innerHTML=`<span class="p">// no response yet, press Send</span>`;
});
/* editing the JSON drives the controls: the two views are one model */
$("#applyJson").onclick=()=>{
  let body;
  try{ body=JSON.parse($("#wireEdit").value); }
  catch(e){ $("#wireMsg").innerHTML=`<span style="color:var(--bad)">Invalid JSON: ${esc(e.message)}</span>`; return; }
  try{ adoptBody(body); }
  catch(e){ $("#wireMsg").innerHTML=`<span style="color:var(--bad)">${esc(e.message)}</span>`; return; }
  $("#wireMsg").innerHTML=`<span style="color:var(--ok)">Applied, controls updated.</span>`;
  renderSrcs(); renderQs(); sync();
};
$("#revertJson").onclick=()=>{ $("#wireEdit").value=JSON.stringify(buildBody(),null,2); $("#wireMsg").textContent=""; };

function adoptBody(body){
  if(!body||typeof body!=="object") throw new Error("Body must be a JSON object.");
  if(body.state===undefined) throw new Error("Missing `state`.");
  if(!body.questions||typeof body.questions!=="object") throw new Error("Missing `questions` map.");
  // state -> sources
  if(typeof body.state==="string") SRCS=[{label:"",text:body.state,on:true}];
  else SRCS=Object.entries(body.state).map(([label,text])=>
    ({label,text:typeof text==="string"?text:JSON.stringify(text,null,2),on:true}));
  // questions -> builder rows (skip the generated _why ones; the checkbox owns those)
  const keep=[];
  for(const [id,q] of Object.entries(body.questions)){
    if(id.startsWith("_")||/^f\d+$/.test(id)) continue;
    if(!q||!["noul","choice","score"].includes(q.type)) throw new Error(`Question "${id}" has an unknown type.`);
    let criteria=[];
    if(q.type==="choice") criteria=Object.entries(q.criteria??{}).map(([k,v])=>[k,v??""]);
    else if(q.type==="score") criteria=(q.criteria??[]).map(v=>["",String(v)]);
    else if(q.criteria) criteria=[["true",q.criteria.true??""],["false",q.criteria.false??""]];
    keep.push({uid:uid(),on:true,type:q.type,id,
      instructions:typeof q.instructions==="string"?q.instructions:JSON.stringify(q.instructions),
      criteria,primary:false});
  }
  if(!keep.length) throw new Error("No usable questions found.");
  const wasPrimary=primaryId();
  (keep.find(q=>q.id===wasPrimary)??keep[0]).primary=true;
  QS=keep;
}

/* ---------- send ---------- */
async function callJev(body){
  const r=await fetch("/api/ask",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  const d=await r.json();
  if(!r.ok) throw new Error(d?.error?.message??d?.detail??`HTTP ${r.status}`);
  return d;
}
async function send(){
  if(tab==="edit"){ $("#applyJson").click(); if($("#wireMsg").textContent.includes("Invalid")) return; }
  const body=buildBody();
  if(!body.state) return show({hint:"Add at least one source of state, Jev only reasons over what you send."});
  if(!Object.keys(body.questions).length)
    return show({hint:"Add a question. A Choice needs ≥2 options; a Score needs ≥2 levels."});

  const btns=[$("#ask"),$("#again")]; btns.forEach(b=>b.disabled=true);
  $("#out").setAttribute("aria-busy","true");
  jevState("thinking");
  let factors=null,decMs=0,decErr=null;
  try{
    if($("#optDecomp").checked){
      $("#ask").textContent="Decomposing…"; show({waiting:true});
      const p=QS.find(q=>q.primary)??QS[0];
      try{
        const r=await fetch("/api/decompose",{method:"POST",headers:{"Content-Type":"application/json"},
          body:JSON.stringify({question:p?.instructions??"",
            context:typeof body.state==="string"?body.state:JSON.stringify(body.state,null,2),n:5}),
          ...(AbortSignal.timeout?{signal:AbortSignal.timeout(180000)}:{})});
        const d=await r.json();
        if(!r.ok) throw new Error(d.error??`HTTP ${r.status}`);
        factors=d.factors; decMs=d._ms;
      }catch(e){ decErr=(e.name==="TimeoutError"||e.name==="AbortError")
        ? "local model did not answer in 180s, is it loaded?" : String(e.message??e); }
    }
    $("#ask").textContent="Sending…";
    const full={...body,questions:{...body.questions}};
    if(factors) factors.forEach((f,i)=>full.questions[`f${i}`]={type:"noul",instructions:f.q});

    const runs=[await callJev(full)];
    if($("#optConsist").checked){
      const pid=primaryId();
      const only={...body,questions:{[pid]:body.questions[pid]}};
      const [a,b]=await Promise.all([callJev(only),callJev(only)]);
      runs.push(a,b);
    }
    LASTRES=runs[0];
    $("#wireRes").innerHTML=hl(JSON.stringify(runs[0],null,2));
    show({data:runs[0],meta:{runs,factors,decMs,decErr,sent:full,nQ:Object.keys(full.questions).length}});
    asked=true;
  }catch(e){ jevState("error"); show({err:String(e.message??e)}); }
  finally{ btns.forEach(b=>b.disabled=false);
    $("#ask").innerHTML=`Send <span class="mono" style="opacity:.55">⌘⏎</span>`;
    $("#out").setAttribute("aria-busy","false"); }
}

/* ---------- render answers ---------- */
const bar=(f,c)=>`<div class="bar"><i style="width:${(f*100).toFixed(1)}%${c?`;background:${c};color:${c}`:""}"></i></div>`;
const dist=(p,w)=>Object.entries(p).sort((a,b)=>b[1]-a[1]).map(([k,v])=>
  `<div class="dl ${k===String(w)?"win":""}"><span class="n" title="${esc(k)}">${esc(k)}</span>
   <div class="bar" style="margin:0"><i style="width:${(v*100).toFixed(1)}%"></i></div>
   <span class="v mono">${pct(v)}</span></div>`).join("");
const levelOf=a=>(a.legend??{})[Math.round(a.score)]??("level "+Math.round(a.score));
const scFrac=a=>{const n=Object.keys(a.legend??a.probabilities).length;return n>1?a.score/(n-1):0;};
const signal=v=>v.type==="noul"?v.noul:v.type==="choice"?v.probabilities[v.choice]:scFrac(v);

function show(o){
  const out=$("#out");
  if(o.hint) return void(out.innerHTML=`<div class="nudge">${esc(o.hint)}</div>`);
  if(o.err){ jevState("error"); return void(out.innerHTML=`<div class="holo err"><b>Error</b><div style="margin-top:6px">${esc(o.err)}</div></div>`); }
  if(o.waiting) return void(out.innerHTML=`<div class="wait"><div class="spin"></div>
    <div style="flex:1"><b>Local model is proposing factors</b>
    <div class="hint" style="margin-top:2px">Runs on your machine, roughly 15–30s. Jev then judges
    every proposed factor inside the same single call.</div><div class="track"><i></i></div></div></div>`);

  const {data,meta}=o, A=data.answers??{}, gate=+$("#gate").value/100;
  const pid=primaryId(), v=A[pid]??A[Object.keys(A)[0]];
  let html=`<div class="speed">
    <div><b class="mono">${data._ms??0}ms</b><span>jev</span></div>
    <div><b class="mono">${meta.nQ}</b><span>judgment${meta.nQ===1?"":"s"}</span></div>
    <div><b class="mono">1</b><span>api call</span></div>
    ${meta.decMs?`<div class="slow"><b class="mono">${(meta.decMs/1000).toFixed(1)}s</b><span>local llm</span></div>`:""}
  </div>`;

  /* headline verdict, projected */
  const tail = meta.runs.length>1?consistency(meta):"";
  if(v?.type==="noul"){
    const p=v.noul, col=p>=.66?"var(--ok)":p<=.33?"var(--bad)":"var(--warn)";
    const word=p>=.8?"Yes":p>=.6?"Probably yes":p>.4?"Too close to call":p>=.2?"Probably no":"No";
    html+=`<div class="holo live"><div class="row"><div class="big" style="color:${col}">${word}</div>
      <span class="spacer"></span>${deltaTag(p)}
      <span class="tag ${Math.abs(p-.5)>=.2?"act":"hold"}">${Math.abs(p-.5)>=.2?"decisive":"split"}</span></div>
      ${bar(p,col)}<div class="muted"><span class="mono" data-count="${p}">${pct(p)}</span> probability of yes
      ${Math.abs(p-.5)<.1?", genuinely undecided, not a middling yes":""}</div>
      <div class="hint mono">${esc(pid)} · noul</div>${tail}</div>`;
  }else if(v?.type==="choice"){
    html+=`<div class="holo live"><div class="row"><div class="big">${esc(v.choice)}</div>
      <span class="spacer"></span>${deltaTag(signal(v))}
      <span class="tag ${v.confidence>=gate?"act":"hold"}">${v.confidence>=gate?"act":"hold"}</span></div>
      <div class="muted">confidence <span class="mono">${pct(v.confidence)}</span></div>${bar(v.confidence)}
      <div style="margin-top:10px">${dist(v.probabilities,v.choice)}</div>
      <div class="hint mono">${esc(pid)} · choice</div>${tail}</div>`;
  }else if(v?.type==="score"){
    const n=Object.keys(v.legend??v.probabilities).length;
    html+=`<div class="holo live"><div class="row"><div class="big">${esc(levelOf(v))}</div>
      <span class="spacer"></span>${deltaTag(signal(v))}
      <span class="tag ${v.confidence>=gate?"act":"hold"}">${v.confidence>=gate?"act":"hold"}</span></div>
      <div class="muted"><span class="mono">${v.score.toFixed(2)}</span> of ${n-1} ·
        confidence <span class="mono">${pct(v.confidence)}</span></div>${bar(n>1?v.score/(n-1):0)}
      <div style="margin-top:10px">${dist(Object.fromEntries(Object.entries(v.probabilities)
        .map(([k,p])=>[(v.legend??{})[k]??("level "+k),p])),levelOf(v))}</div>
      <div class="hint mono">${esc(pid)} · score</div>${tail}</div>`;
  }

  /* every other answer, still typed */
  const others=Object.entries(A).filter(([k])=>k!==pid&&!k.startsWith("_")&&!/^f\d+$/.test(k));
  if(others.length) html+=`<div class="card" style="margin-bottom:var(--s2)"><h2>Other answers</h2>`+
    others.map(([k,a])=>`<div class="ansblk"><h3>${esc(k)} <span class="pill ${a.type}">${a.type}</span></h3>`+
      (a.type==="noul"?`<div class="row"><b class="mono" style="font-size:17px;color:${a.noul>=.6?"var(--ok)":a.noul<=.4?"var(--bad)":"var(--warn)"}">${pct(a.noul)}</b>
         <span class="muted">probability of yes</span></div>${bar(a.noul,a.noul>=.6?"var(--ok)":a.noul<=.4?"var(--bad)":"var(--warn)")}`
       :a.type==="choice"?`<div class="row"><b style="font-size:15px">${esc(a.choice)}</b>
         <span class="spacer"></span><span class="tag ${a.confidence>=gate?"act":"hold"}">${pct(a.confidence)}</span></div>
         <div style="margin-top:8px">${dist(a.probabilities,a.choice)}</div>`
       :`<div class="row"><b style="font-size:15px">${esc(levelOf(a))}</b>
         <span class="spacer"></span><span class="tag ${a.confidence>=gate?"act":"hold"}">${pct(a.confidence)}</span></div>
         ${bar(scFrac(a))}`)+`</div>`).join("")+`</div>`;

  /* factors */
  if(meta.factors?.length){
    const rows=meta.factors.map((f,i)=>{const a=A[`f${i}`]; if(!a) return "";
      const p=a.noul,col=p>=.6?"var(--ok)":p<=.4?"var(--bad)":"var(--warn)";
      return `<div class="fac"><div class="top"><span class="lbl">${esc(f.label??f.id)}</span>
        <span class="mono" style="font-size:11px;color:${col}">${pct(p)}</span></div>
        <div class="split"><i style="width:${(p*100).toFixed(1)}%;background:${col};color:${col}"></i></div>
        <div class="q">${esc(f.q)}</div></div>`;}).join("");
    const weak=meta.factors.map((f,i)=>({f,p:A[`f${i}`]?.noul??1})).sort((a,b)=>a.p-b.p)[0];
    html+=`<div class="card" style="margin-bottom:var(--s2)"><h2>Factors<span class="spacer"></span>
      <span class="muted" style="font-size:10px;text-transform:none;letter-spacing:0">proposed locally · judged by Jev</span></h2>
      ${rows}${weak&&weak.p<.5?`<div class="hint">Weakest link: <b style="color:var(--ink)">${esc(weak.f.label??weak.f.id)}</b> at ${pct(weak.p)}.</div>`:""}</div>`;
  }
  if(meta.decErr) html+=`<div class="card err" style="margin-bottom:var(--s2)"><b>Factors unavailable</b>
    <div class="hint" style="color:inherit">${esc(meta.decErr)}, the verdict above is unaffected.</div></div>`;

  /* why */
  if(A._support||A._obstacles||A._enough){
    const line=(l,t,f,c)=>`<div class="dl" style="grid-template-columns:minmax(80px,24%) 1fr auto"><span class="n">${l}</span>
      <div class="bar" style="margin:0"><i style="width:${(f*100).toFixed(1)}%${c?`;background:${c};color:${c}`:""}"></i></div>
      <span class="v" style="min-width:auto;color:var(--ink);font-size:12px">${esc(t)}</span></div>`;
    html+=`<div class="card" style="margin-bottom:var(--s2)"><h2>Why</h2>
      ${A._support?line("support",levelOf(A._support),scFrac(A._support),"var(--ok)"):""}
      ${A._obstacles?line("obstacles",levelOf(A._obstacles),scFrac(A._obstacles),"var(--bad)"):""}
      ${A._enough?line("evidence",A._enough.noul>=.6?"sufficient":A._enough.noul<=.4?"thin, answer is a guess":"borderline",
        A._enough.noul,A._enough.noul>=.6?"var(--ok)":"var(--warn)"):""}</div>`;
  }

  const muted=SRCS.filter(s=>!s.on&&s.text.trim());
  if(muted.length) html+=`<div class="hint" style="margin-bottom:var(--s2)">Answered without
    ${muted.map(s=>`<b style="color:var(--ink)">${esc(s.label||"an unlabelled source")}</b>`).join(", ")}.</div>`;
  else if(!asked) html+=`<div class="nudge">Now <b>untick a source</b> and send again, the verdict
    shows how much it depended on it.</div>`;

  out.innerHTML=html;
  $("#usage").textContent=`${data.model??""} · ${(data.usage??{}).input_tokens??"?"}→${(data.usage??{}).output_tokens??"?"} tok`;
  countUp(); PREV=signal(v);

  /* the droid takes the verdict's colour: yes leans in, no recoils, split hovers */
  if(v){
    const sg=signal(v);
    const kind = v.type==="noul"
      ? (v.noul>=.6?"yes":v.noul<=.4?"no":"split")
      : (v.confidence>=gate?"yes":"split");
    jevState("verdict", v.type==="noul"?v.noul:v.confidence, kind);
  }
}
function deltaTag(now){
  if(PREV==null||Math.abs(now-PREV)<.02) return "";
  const d=now-PREV;
  return `<span class="delta ${d>0?"up":"down"} mono">${d>0?"▲":"▼"} ${Math.abs(d*100).toFixed(0)}pt</span>`;
}
function consistency(meta){
  const pid=primaryId();
  const vals=meta.runs.map(r=>{const a=r.answers[pid]??r.answers[Object.keys(r.answers)[0]];return signal(a);});
  const spread=Math.max(...vals)-Math.min(...vals);
  return `<div style="margin-top:12px;border-top:1px solid var(--line);padding-top:10px">
    <div class="row"><span class="muted">consistency over ${vals.length} runs</span><span class="spacer"></span>
      <span class="delta mono ${spread<=.05?"up":spread>.15?"down":""}">±${(spread*50).toFixed(1)}pt</span></div>
    <div class="runs">${vals.map(x=>`<i style="height:${Math.max(4,x*100)}%" title="${pct(x)}"></i>`).join("")}</div>
    <div class="hint mono">${vals.map(pct).join(" · ")}${spread<=.05?", stable across repeats":""}</div></div>`;
}
function countUp(){
  const el=$("[data-count]"); if(!el||REDUCED) return;
  const target=+el.dataset.count,t0=performance.now();
  const step=now=>{const k=Math.min(1,(now-t0)/450);
    el.textContent=pct(target*(1-Math.pow(1-k,3)));
    if(k<1) requestAnimationFrame(step);};
  requestAnimationFrame(step);
}

/* ---------- wiring ---------- */
function enterConsole(){
  if(!SRCS.length) SRCS=[{label:"",text:"",on:true}];
  $("#intro").hidden=true; $("#console").hidden=false; renderSrcs();
}
$("#examples").innerHTML=Object.keys(EXAMPLES).map(k=>`<button class="sm" data-ex="${esc(k)}">${esc(k)}</button>`).join("");
$("#examples").onclick=e=>{
  const k=e.target.dataset.ex; if(!k) return;
  const ex=EXAMPLES[k];
  SRCS=ex.srcs.map(([label,text])=>({label,text,on:true}));
  QS=ex.qs.map(q=>({...q,uid:uid(),on:true,primary:!!q.primary,criteria:q.criteria.map(c=>[...c])}));
  if(!QS.some(q=>q.primary)) QS[0].primary=true;
  enterConsole(); renderQs(); sync(); send();
};
$("#help").onclick=()=>{ $("#intro").hidden=!$("#intro").hidden; };
$("#ask").onclick=send; $("#again").onclick=send;
$("#optWhy").onchange=sync;
$("#gate").oninput=e=>$("#gateV").textContent=(e.target.value/100).toFixed(2);
addEventListener("keydown",e=>{if((e.metaKey||e.ctrlKey)&&e.key==="Enter"){e.preventDefault(); $("#console").hidden?null:send();}});
fetch("/api/config").then(r=>r.json()).then(c=>{
  if(!c.decompose){$("#optDecomp").disabled=true;$("#decmodel").textContent="(no local model configured)";}
  else $("#decmodel").textContent=`· ${c.model}`;
}).catch(()=>{});
sync();
