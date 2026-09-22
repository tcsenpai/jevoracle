/* JevKnows, bot list, the home of the platform. Styled like an exchange's bot page. */
import { $, esc, pc, ago, api, maturityBadge, statusBadge, errorBanner,
         evidencePhrase, abstentionPhrase, brierPhrase, stakedPhrase, pnlPhrase,
         enginePhrase } from "/jevknows-shared.js";

async function refresh() {
  const errEl = $("#listErr");
  errEl.innerHTML = "";
  try {
    const [d, live] = await Promise.all([
      api("/api/bots"),
      api("/api/engine/live").catch(() => null),
    ]);
    renderLive(live);
    await renderBots(d.bots ?? []);
  } catch (e) {
    errEl.innerHTML = errorBanner(e.message);
    $("#botlist").innerHTML = `<div class="empty">Can't load the bots.</div>`;
  }
}

/* GET /api/bots (the list) does not carry the current config context, only
 * GET /api/bots/:id does. One extra call per bot, in parallel, non-blocking:
 * if it fails the engine sentence is simply missing, the rest of the card
 * still shows. */
async function fetchEngines(bots) {
  const out = {};
  await Promise.all(bots.map(async b => {
    try { out[b.id] = (await api(`/api/bots/${b.id}`)).config?.context?.engine ?? null; }
    catch { out[b.id] = undefined; } // undefined = we don't know, different from null = default
  }));
  return out;
}

function renderLive(l) {
  const el = $("#live");
  if (!l || !l.ready) {
    el.className = "banner safe";
    el.innerHTML = `<b>No real money.</b> Here the bots bet with fake money on
      real markets. It's for seeing whether they get it right, not for making money.`;
  } else {
    el.className = "banner";
    el.innerHTML = `<b style="color:var(--bad)">WARNING: real money is active.</b>
      Orders can be signed up to ${esc(l.cap)} $. Unset LIVE_TRADING to turn it off.`;
  }
}

async function renderBots(bots) {
  $("#listinfo").textContent = bots.length === 1 ? "1 bot" : `${bots.length} bots`;
  if (!bots.length) {
    // an empty state that teaches, not one that just states a fact
    $("#botlist").innerHTML = `<div class="empty teach">
      <h3>There isn't a bot yet</h3>
      <p>A bot is a set of rules: which markets to watch, how much context to
      give Jev, and how much disagreement with the market is needed before it bets.</p>
      <p>Each bot keeps its own history, so you can run two with different
      rules side by side and see which one reasons better.</p>
      <p class="row" style="gap:var(--s2)">
        <a class="cta" href="/wizard.html">Walk me through it</a>
        <a class="navlink" href="/bot-config.html">or create one right away</a>
      </p>
    </div>`;
    return;
  }
  const engines = await fetchEngines(bots);
  /* One card per bot, not an eleven-column table row.
   * Whoever opens this page needs to understand "is it doing something
   * sensible?" without knowing what a Brier score is. The numbers stay, but
   * next to a sentence saying what they mean. */
  $("#botlist").innerHTML = bots.map(b => {
    const m = b.metrics ?? {};
    const leading = m.leading ?? {};
    const settled = m.settled ?? {};
    const ev = evidencePhrase(leading.meanEvidence);
    const ab = abstentionPhrase(leading.abstention?.rate, leading.abstention?.seen);
    const br = brierPhrase(settled.versusCrowd);
    const nPred = leading.predictions ?? b.n_predictions ?? 0;

    // Money comes first: it's the question people ask when they open the page.
    const st = stakedPhrase(leading.stakedOpen, leading.nextClose, leading.dueNow ?? 0, leading.wouldHaveBet ?? 0);
    const pn = pnlPhrase(settled.pnlGated, settled.n ?? 0);
    const engineLine = engines[b.id] !== undefined
      ? `<p class="line muted engine-line">${esc(enginePhrase(engines[b.id]))}</p>` : "";

    const facts = nPred === 0
      ? `<p class="line">It has not made any predictions yet. Press <b>Run it</b> to start.</p>`
      : `<p class="line money ${pn.cls}">${pn.text}</p>
         <p class="line ${st.cls}">${st.text}</p>
         <p class="line"><b>${nPred}</b> predictions, <b>${leading.open ?? 0}</b> of them on still-open markets.</p>
         <p class="line ${ev.cls}">${esc(ev.text)}
           ${leading.meanEvidence != null ? `<span class="fig">${pc(leading.meanEvidence, 0)}</span>` : ""}</p>
         <p class="line">${esc(ab.text)}</p>
         <p class="line ${br.cls}">${esc(br.text)}</p>`;

    return `<article class="botcard">
      <header>
        <h3><a href="/bot.html?id=${b.id}">${esc(b.name)}</a></h3>
        ${statusBadge(b.status)}
        <span class="spacer"></span>
        <span class="muted">${Number(b.bankroll).toFixed(0)} $ virtual</span>
      </header>
      ${b.blurb ? `<p class="blurb">${esc(b.blurb)}</p>` : ""}
      ${engineLine}
      <div class="facts">${facts}</div>
      <p class="maturity-line">${maturityBadge(m.maturity, settled.n)}</p>
      <footer>
        <button class="sm" data-act="run" data-id="${b.id}">Run it</button>
        <button class="sm ghost" data-act="settle" data-id="${b.id}">Check outcomes</button>
        <button class="sm ghost" data-act="pause" data-id="${b.id}">${b.status === "active" ? "Pause" : "Resume"}</button>
        <a class="navlink" href="/bot.html?id=${b.id}">See all</a>
        <span class="spacer"></span>
        <span class="muted">${b.last_run ? `last run ${ago(b.last_run)}` : "never started"}</span>
      </footer>
    </article>`;
  }).join("");
}

document.body.addEventListener("click", async e => {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const id = btn.dataset.id;
  const act = btn.dataset.act;
  let notice = null;
  btn.disabled = true;
  const old = btn.textContent;
  try {
    if (act === "run") {
      btn.textContent = "Running…";
      await api(`/api/bots/${id}/run`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "live" }),
      });
    } else if (act === "settle") {
      btn.textContent = "Checking…";
      const r = await api(`/api/bots/${id}/settle`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
      });
      // an honest outcome: if Polymarket has not resolved anything yet, say so.
      // The message must be shown AFTER the final refresh, which clears #listErr.
      notice = r.settled
        ? `<div class="banner"><b>${r.settled}</b> bets have closed. The results are below.</div>`
        : `<div class="banner">Checked <b>${r.checked ?? 0}</b> markets, none of them has
           closed on Polymarket yet. Outcomes arrive when the market is resolved, not at
           the deadline.</div>`;
    } else if (act === "pause") {
      // the button's text is the action to take, so "Resume" = we want to activate it
      const wantActive = old.trim().startsWith("Resume");
      await api(`/api/bots/${id}/status`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: wantActive ? "active" : "paused" }),
      });
    }
  } catch (err) {
    $("#listErr").innerHTML = errorBanner(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = old;
    await refresh();
    if (notice) $("#listErr").innerHTML = notice;
  }
});

/* ---------- new bot dialog ---------- */
const dlg = $("#newBotDialog");
$("#newBot").onclick = () => { $("#nbMsg").textContent = ""; dlg.showModal(); };
$("#nbCancel").onclick = () => dlg.close();
$("#newBotForm").onsubmit = async e => {
  e.preventDefault();
  const name = $("#nbName").value.trim();
  const blurb = $("#nbBlurb").value.trim();
  const bankroll = Number($("#nbBankroll").value) || 1000;
  if (!name) return;
  $("#nbSubmit").disabled = true;
  try {
    await api("/api/bots", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, blurb, bankroll, context: {}, thresholds: {} }),
    });
    dlg.close();
    $("#nbName").value = ""; $("#nbBlurb").value = ""; $("#nbBankroll").value = "1000";
    await refresh();
  } catch (err) {
    $("#nbMsg").innerHTML = errorBanner(err.message);
  } finally {
    $("#nbSubmit").disabled = false;
  }
};

refresh();
