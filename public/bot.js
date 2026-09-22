/* JevKnows, bot detail. Reads /api/bots/:id. Query string ?id=N.
 *
 * Guiding rule (founder correction, 2026-09-20): every technical number has a
 * plain-language sentence as its primary text. The number stays, but small
 * and secondary, never the only thing shown. */
import {
  $, esc, pc, usd, pcRaw, numRaw, usdRaw, ago, api, maturityText, statusBadge, errorBanner,
  evidencePhrase, abstentionPhrase, brierPhrase, stakedPhrase, pnlPhrase,
  modelShort, engineVoteProbs, enginesDisagree,
} from "/jevknows-shared.js";

const id = new URLSearchParams(location.search).get("id");
let BOT = null;

async function refresh() {
  const errEl = $("#err");
  errEl.innerHTML = "";
  if (!id) {
    errEl.innerHTML = errorBanner("The bot's id is missing from the address. Open this page as bot.html?id=N.");
    return;
  }
  try {
    const d = await api(`/api/bots/${id}`);
    BOT = d;
    renderHead(d.bot, d.config);
    renderLeading(d.metrics?.leading);
    renderSettled(d.metrics?.settled, d.metrics?.maturity);
    renderCalib(d.metrics?.settled);
    renderGate(d.metrics);
    renderPredictions(d.predictions ?? []);
    renderRuns(d.runs ?? []);
    renderConfigHistory(d.configHistory ?? []);
  } catch (e) {
    errEl.innerHTML = errorBanner(e.message);
    $("#botName").textContent = "Can't load this bot";
    document.querySelectorAll("tbody").forEach(tb =>
      tb.innerHTML = `<tr><td colspan="11" class="empty">Loading failed.</td></tr>`);
  }
}

function renderHead(bot, config) {
  document.title = `${bot.name}, JevKnows`;
  $("#botName").innerHTML = `${esc(bot.name)} ${statusBadge(bot.status)}`;
  $("#botSub").innerHTML = `${Number(bot.bankroll).toFixed(0)} $ virtual bankroll ·
    settings v${config?.version ?? bot.config_version ?? 1} · created ${ago(bot.created_at)}${bot.blurb ? " · " + esc(bot.blurb) : ""}`;
  const actions = $("#botActions");
  actions.hidden = false;
  $("#btnRun").onclick = () => runBot();
  $("#btnSettle").onclick = () => settleBot();
  $("#btnPause").textContent = bot.status === "active" ? "Pause" : "Resume";
  $("#btnPause").onclick = () => toggleStatus(bot.status);
  $("#btnConfig").href = `/bot-config.html?id=${bot.id}`;
}

async function runBot() {
  const btn = $("#btnRun");
  btn.disabled = true; const old = btn.textContent; btn.textContent = "Starting…";
  try {
    await api(`/api/bots/${id}/run`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "live" }),
    });
  } catch (e) { $("#err").innerHTML = errorBanner(e.message); }
  finally { btn.disabled = false; btn.textContent = old; await refresh(); }
}
/** Asks Polymarket whether the markets we bet on have resolved. */
async function settleBot() {
  const btn = $("#btnSettle");
  btn.disabled = true; const old = btn.textContent; btn.textContent = "Checking…";
  let notice = null;
  try {
    const r = await api(`/api/bots/${id}/settle`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    notice = r.settled
      ? `<div class="banner"><b>${r.settled}</b> bets have closed.</div>`
      : `<div class="banner">Checked <b>${r.checked ?? 0}</b> markets, none of them has
         closed on Polymarket yet. Outcomes arrive when the market is resolved, not at
         the deadline.</div>`;
  } catch (e) { notice = errorBanner(e.message); }
  finally {
    btn.disabled = false; btn.textContent = old;
    await refresh();                       // refresh clears #err: the message must come after
    if (notice) $("#err").innerHTML = notice;
  }
}

async function toggleStatus(current) {
  const btn = $("#btnPause");
  btn.disabled = true;
  try {
    await api(`/api/bots/${id}/status`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: current === "active" ? "paused" : "active" }),
    });
  } catch (e) { $("#err").innerHTML = errorBanner(e.message); }
  finally { btn.disabled = false; await refresh(); }
}

/** One KPI card = one plain-language sentence (headline), then the raw number below, small. */
function kpiCard(label, headline, raw, cls = "") {
  return `<div class="kpi"><span class="lbl">${esc(label)}</span>
    <div class="headline ${cls}">${headline}${raw != null ? `<span class="raw">${esc(raw)}</span>` : ""}</div>
  </div>`;
}

function renderLeading(l) {
  if (!l || !l.predictions) {
    $("#kpisLeading").innerHTML = kpiCard("predictions", "It has not made any predictions yet. Go up and press <b>Run it</b> to start.");
    return;
  }
  const ev = evidencePhrase(l.meanEvidence);
  const ab = abstentionPhrase(l.abstention?.rate, l.abstention?.seen);
  // Money and deadlines first: they're the two things people look for first.
  const st = stakedPhrase(l.stakedOpen, l.nextClose, l.dueNow ?? 0, l.wouldHaveBet ?? 0);
  const cards = [
    kpiCard("money at stake right now", st.text, null, st.cls),
    kpiCard("how many predictions", `It has made <b>${l.predictions}</b> predictions, <b>${l.open ?? 0}</b> of them on still-open markets.`),
    kpiCard("how much it says it knows", ev.text, pcRaw(l.meanEvidence, 0), ev.cls),
    kpiCard("when it holds back", ab.text),
    kpiCard("difference from the market",
      l.meanAbsEdge == null ? "not enough data yet" : `On average it diverges from the market price by <b>${(l.meanAbsEdge * 100).toFixed(1)} points</b>.`),
  ];
  $("#kpisLeading").innerHTML = cards.join("");
}

function renderSettled(s, maturity) {
  const mText = maturityText(maturity);
  $("#settledNote").innerHTML = `The only numbers here that prove anything. ${esc(mText)}`;
  if (!s || !s.n) {
    $("#kpisSettled").innerHTML = kpiCard("closed markets",
      "No market has closed yet. Results arrive once Polymarket resolves the markets, that can take anywhere from days to weeks. In the meantime, look at the leading indicators above.");
    return;
  }
  const vc = s.versusCrowd;
  const br = brierPhrase(vc);
  const ev = s.evidenceValidity;
  const cards = [
    kpiCard("closed markets", `<b>${s.n}</b> markets have closed so far.`),
    kpiCard("versus the market", br.text, vc ? `Brier ${numRaw(vc.brierJev, 4)} vs ${numRaw(vc.brierCrowd, 4)}` : null, br.cls),
    (() => { const pn = pnlPhrase(s.pnlGated, s.n); return kpiCard("virtual money", pn.text, null, pn.cls); })(),
    kpiCard("is evidence reliable?",
      ev?.usable
        ? (ev.separation > 0 ? "When it says it knows more, it actually gets things wrong less often." : "There is no clear difference yet: saying it knows more doesn't make it more accurate.")
        : `At least ${ev?.need ?? 8} closed markets with this data are needed to tell (it has ${ev?.n ?? 0} so far).`,
      null, ev?.usable && ev.separation > 0 ? "good" : ""),
  ];
  $("#kpisSettled").innerHTML = cards.join("");
}

function renderCalib(s) {
  const rows = s?.calibration ?? [];
  const any = rows.some(b => b.n > 0);
  if (!any) {
    $("#calib").innerHTML = `<div class="empty">No market has closed so far.<br>
      <span style="font-size:11.5px">Calibration can only be computed once markets actually resolve.</span></div>`;
    return;
  }
  $("#calib").innerHTML = rows.map(b => {
    if (!b.n) return `<div class="crow"><span class="lab">${(b.lo * 100) | 0}-${(b.hi * 100) | 0}%</span>
      <div class="track"></div><div class="track"></div><span class="n">0</span></div>`;
    return `<div class="crow"><span class="lab">${(b.lo * 100) | 0}-${(b.hi * 100) | 0}%</span>
      <div class="track"><i style="width:${b.predicted * 100}%;background:var(--acc)"></i></div>
      <div class="track"><i style="width:${b.actual * 100}%;background:var(--ok)"></i></div>
      <span class="n">n=${b.n}</span></div>`;
  }).join("") + `<div class="legend"><span><s style="background:var(--acc)"></s>what the bot declared</span>
    <span><s style="background:var(--ok)"></s>what actually happened</span>
    <span>the bars should look alike if the bot is well calibrated</span></div>`;
}

function renderGate(m) {
  const settledN = m?.settled?.n ?? 0;
  const abst = m?.leading?.abstention;
  if (!settledN || !abst) {
    $("#gatecmp").innerHTML = `<div class="empty">There isn't enough data yet to tell.<br>
      <span style="font-size:11.5px">This comparison fills in once markets start closing.</span></div>`;
    return;
  }
  const line = (lab, v) => `<div class="crow" style="grid-template-columns:150px 1fr 60px">
    <span class="lab">${lab}</span>
    <div class="track"><i style="width:${v == null ? 0 : Math.min(100, v * 100)}%;background:var(--acc)"></i></div>
    <span class="n">${v == null ? "n/a" : (v * 100).toFixed(0) + "%"}</span></div>`;
  $("#gatecmp").innerHTML =
    line("knew when it bet", abst.evidenceWhenBet) +
    line("knew when it held back", abst.evidenceWhenPassed) +
    `<div class="legend"><span>If the second bar is lower than the first, the bot holds
      back exactly when it knows less, which is the right behavior.</span></div>`;
}

/** An open prediction, with its deadline said in a readable way. */
function openLabel(endDate) {
  if (!endDate) return `<span class="muted">open, deadline unknown</span>`;
  const days = Math.ceil((new Date(endDate) - Date.now()) / 86400000);
  if (days <= 0) return `<span class="warn">expired, waiting for the outcome</span>`;
  const when = days === 1 ? "tomorrow" : days < 31 ? `in ${days} days`
    : `on ${new Date(endDate).toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" })}`;
  return `<span class="muted">open, closes ${when}</span>`;
}

/** ENGINE_LABEL: short name for each of the three engines, used in the
 * disagreement row. Kept here (not in jevknows-shared.js) because it's only
 * about presenting the table, not a rule shared across multiple pages. */
const ENGINE_LABEL = { jev: "Jev", laya: "Laya", kev: "Kev" };

/** "Who decided" cell: the engine/quorum short name as the main text (the
 * full technical id stays in the mouseover title), and if there are votes
 * from every engine, the three probabilities side by side with the winner
 * highlighted. If they diverge by more than 0.3, it's said in words: that's
 * the whole reason the quorum exists, it shouldn't stay hidden in the JSON. */
function decidedByCell(x) {
  const short = modelShort(x.model);
  const head = `<span class="modelname" title="${esc(x.model ?? "")}">${short}</span>`;
  const probs = engineVoteProbs(x.engine_votes);
  const answered = Object.entries(probs).filter(([, v]) => v != null);
  let votesRow = "";
  if (answered.length) {
    const winner = x.jev; // "jev" column = the prediction's final combined value
    const chips = ["jev", "laya", "kev"].map(name => {
      const v = probs[name];
      if (v == null) return `<span class="evchip miss" title="${ENGINE_LABEL[name]} did not answer">${ENGINE_LABEL[name]} —</span>`;
      const isWinner = winner != null && Math.abs(v - winner) < 0.0005;
      return `<span class="evchip${isWinner ? " win" : ""}" title="${ENGINE_LABEL[name]}: ${(v * 100).toFixed(1)}%">${ENGINE_LABEL[name]} ${(v * 100).toFixed(0)}%</span>`;
    }).join("");
    votesRow = `<div class="evrow">${chips}</div>`;
    if (enginesDisagree(probs)) {
      votesRow += `<div class="evdisagree">the models disagree</div>`;
    }
  }
  const warn = x.engine_warning ? `<div class="evwarning">${esc(x.engine_warning)}</div>` : "";
  return `<td class="decided">${head}${votesRow}${warn}</td>`;
}

function renderPredictions(rows) {
  $("#predinfo").textContent = rows.length ? `${rows.length} shown` : "";
  if (!rows.length) {
    $("#predtable tbody").innerHTML = `<tr><td colspan="11" class="empty">
      No predictions yet. Start a run to have the bot look at the markets.</td></tr>`;
    return;
  }
  $("#predtable tbody").innerHTML = rows.map(x => {
    // Only `gated` is a real bet. `ungated` is the alternative rule's
    // simulation: it should be shown as a hypothesis, not read as committed money.
    const rule = x.gated ? `<span class="badge g">bet</span>`
      : x.ungated ? `<span class="badge u">did not bet</span>`
      : `<span class="badge n">did not bet</span>`;
    const stake = x.gated
      ? usd(x.stake_gated)
      : x.ungated
        ? `<span class="muted">(would have put ${usd(x.stake_ungated)})</span>`
        : "";
    // "still open" on its own says nothing: you need to know WHEN it will be known.
    const res = x.outcome == null ? openLabel(x.end_date)
      : `${x.outcome ? "YES" : "NO"}${x.gated
          ? ` <span class="${(x.pnl_gated ?? 0) >= 0 ? "pos" : "neg"}">${usd(x.pnl_gated ?? 0)}</span>`
          : x.ungated
            ? ` <span class="muted">(would have made ${usd(x.pnl_ungated ?? 0)})</span>`
            : ""}`;
    return `<tr>
      <td class="muted">${ago(x.created_at)}</td>
      <td class="mkt">${esc(x.market_label)}<small>${esc(x.event_title)}</small></td>
      <td class="r">${pc(x.crowd, 1)}</td>
      <td class="r">${pc(x.jev, 1)}</td>
      <td class="r ${x.edge > 0 ? "pos" : "neg"}">${x.edge > 0 ? "+" : ""}${(x.edge * 100).toFixed(1)}pt</td>
      <td class="r">${pc(x.evidence, 0)}</td>
      ${decidedByCell(x)}
      <td>${rule}</td>
      <td>${x.gated ? esc(x.side ?? "") : ""}</td>
      <td class="r">${stake}</td>
      <td>${res}</td>
      <td class="r muted">v${x.bot_config_version}</td></tr>`;
  }).join("");
}

function renderRuns(runs) {
  $("#runinfo").textContent = runs.length ? `${runs.length} shown` : "";
  if (!runs.length) {
    $("#runtable tbody").innerHTML = `<tr><td colspan="6" class="empty">
      No runs yet. Press <b>Run it</b> above to start one.</td></tr>`;
    return;
  }
  $("#runtable tbody").innerHTML = runs.map(r => `<tr>
    <td class="muted">${ago(r.started_at)}</td>
    <td>${esc(r.mode)}</td>
    <td class="r">${r.scanned ?? 0}</td>
    <td class="r">${r.asked ?? 0}</td>
    <td class="r">${r.recorded ?? 0}</td>
    <td>${r.error ? `<span class="neg">${esc(r.error)}</span>`
      : r.finished_at ? `<span class="pos">completed</span>` : `<span class="muted">in progress</span>`}</td>
  </tr>`).join("");
}

function renderConfigHistory(history) {
  if (!history.length) {
    $("#cfghist").innerHTML = `<div class="empty">No settings history.</div>`;
    return;
  }
  $("#cfghist").innerHTML = history.map(c => `
    <div class="cfgv ${!c.valid_to ? "current" : ""}">
      <div class="head"><b>v${c.version}</b>
        ${!c.valid_to ? `<span class="now">current</span>` : ""}</div>
      <div class="meta">valid since ${ago(c.valid_from)}${c.valid_to ? ` until ${ago(c.valid_to)}` : ", still in use"}</div>
      ${c.note ? `<div class="note">${esc(c.note)}</div>` : ""}
    </div>`).join("");
}

refresh();
