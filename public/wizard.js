/* JevKnows, guided wizard for the first bot. No server write happens until
 * step 4: up to there it's only local navigation, you can abandon it at any
 * time without leaving anything half-done. */
import { $, esc, api, errorBanner } from "/jevknows-shared.js";

const STEP_LABELS = {
  1: "Step 1 of 4: what a bot is",
  2: "Step 2 of 4: give your bot a name",
  3: "Step 3 of 4: how cautious should it be",
  4: "Step 4 of 4: done",
};

const PRESETS = {
  prudente: { minEdge: 0.10, minEvidence: 0.6 },
  curioso:  { minEdge: 0.06, minEvidence: 0.4 },
};

let current = 1;

function showStep(n) {
  current = n;
  for (let i = 1; i <= 4; i++) {
    $(`#step${i}`).hidden = i !== n;
  }
  // progress bar: aria-current on the current step, "done" class on past ones
  $("#wizSteps").querySelectorAll("li").forEach(li => {
    const s = Number(li.dataset.step);
    li.classList.toggle("done", s < n);
    li.classList.toggle("current", s === n);
    if (s === n) li.setAttribute("aria-current", "step"); else li.removeAttribute("aria-current");
  });
  $("#wizStepsStatus").textContent = STEP_LABELS[n];
  // move focus to the step's heading, useful for keyboard and screen reader
  // users: without this the focus would stay on the button just pressed in
  // the previous step, now hidden
  const h2 = document.querySelector(`#step${n} h2`);
  if (h2) { h2.setAttribute("tabindex", "-1"); h2.focus(); }
}

$("#toStep2").onclick = () => showStep(2);
$("#toStep1").onclick = () => showStep(1);
$("#toStep2b").onclick = () => showStep(2);

/* ---------- step 2: name ---------- */
const nameInput = $("#wName");
function syncStep2() {
  const has = nameInput.value.trim().length > 0;
  const next = $("#toStep3");
  next.disabled = !has;
  // a disabled button doesn't say why on its own: the reason must be attached
  // to the button itself, not only under the field where it might go unnoticed
  next.title = has ? "" : "Type a name for the bot first.";
  next.setAttribute("aria-describedby", "wNameHelp");
  $("#wNameHelp").textContent = has
    ? "That's fine."
    : "Required: the bot cannot be created without a name.";
}
nameInput.addEventListener("input", syncStep2);
syncStep2();

$("#wUseExample").onclick = () => {
  nameInput.value = "geopolitics";
  $("#wBlurb").value = "geopolitical markets only";
  syncStep2();
};

$("#toStep3").onclick = () => { if (!nameInput.value.trim()) return; showStep(3); };

/* ---------- step 4: actually create the bot ---------- */
$("#toStep4").onclick = async () => {
  const btn = $("#toStep4");
  const errEl = $("#wizCreateErr");
  errEl.innerHTML = "";
  const name = nameInput.value.trim();
  if (!name) { showStep(2); return; }
  const blurb = $("#wBlurb").value.trim();
  const presetKey = document.querySelector('input[name="wPreset"]:checked')?.value ?? "prudente";
  const thresholds = PRESETS[presetKey];

  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = "Creating the bot…";
  try {
    const created = await api("/api/bots", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, blurb, context: {}, thresholds }),
    });
    const id = created.id ?? created.bot?.id;
    $("#doneHeading").textContent = `${name} is ready`;
    $("#doneIntro").textContent = presetKey === "prudente"
      ? "The bot is ready, with the cautious style: it will bet rarely, only when it is very confident."
      : "The bot is ready, with the curious style: it will bet more often, even with less certainty.";
    $("#goToBot").href = id ? `/bot.html?id=${id}` : "/";
    showStep(4);
  } catch (e) {
    // 409: name already used by another bot. Plain message, not the raw API error.
    const msg = /already exists/i.test(e.message)
      ? `There's already a bot called "${esc(name)}". Go back and choose a different name.`
      : e.message;
    errEl.innerHTML = errorBanner(msg);
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
};

showStep(1);
