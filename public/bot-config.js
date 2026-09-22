/* JevKnows, bot configuration. ?id=N edits an existing bot (new settings
 * version). No id = creation mode.
 *
 * Guiding rule (founder correction, 2026-09-20): creating a bot must work
 * with just the name. Everything else has a default already set and lives
 * inside collapsed <details> sections, a first-time user should not have to
 * choose minEdge or Kelly to create their first bot.
 *
 * Field shape mirrors engine/config.js (FIELDS, DEFAULT_CONFIG) and the real
 * response of GET /api/bots/:id, context.fields.*, context.sideAssistant
 * with hosts[] and outputs{}. */
import { $, esc, api, errorBanner } from "/jevknows-shared.js";

const id = new URLSearchParams(location.search).get("id");
const isEdit = !!id;

/* Mirrors engine/config.js FIELDS. The market price never appears here:
 * that's a BRAND rule, it never enters the state sent to Jev. */
const CONTEXT_FIELDS = [
  { key: "resolution_rules", label: "Resolution rules", help: "The full criteria. Usually the single most useful field on its own.", locked: true },
  { key: "window", label: "Dates", help: "Today's date and when the market closes." },
  { key: "subject_area", label: "Subject", help: "Up to three labels framing the topic." },
  { key: "resolution_source", label: "Resolution source", help: "Where the market says it will look to decide the outcome. Often missing." },
  { key: "recent_reporting", label: "Recent news", help: "Dated news, filtered for relevance. Slow and rate-limited." },
  { key: "trader_notes", label: "Trader notes", help: "Comments that look like they report a fact. Chatter about the price is stripped out." },
];

function renderContextFields(fields = {}) {
  $("#ctxFields").innerHTML = CONTEXT_FIELDS.map(f => `
    <label class="checkrow">
      <input type="checkbox" data-ctx="${f.key}" ${fields[f.key] !== false ? "checked" : ""} ${f.locked ? "disabled" : ""}>
      <span><b>${esc(f.label)}${f.locked ? ` <span class="maturity n2">always on</span>` : ""}</b>
        <small>${esc(f.help)}</small></span>
    </label>`).join("");
}
function readContextFields() {
  const out = {};
  CONTEXT_FIELDS.forEach(f => {
    const el = document.querySelector(`[data-ctx="${f.key}"]`);
    out[f.key] = el ? el.checked : true;
  });
  return out;
}

function fillThresholds(t = {}) {
  $("#tMaxHorizon").value = t.maxHorizonDays ?? 7;
  $("#tMinEdge").value = t.minEdge ?? 0.08;
  $("#tMinEvidence").value = t.minEvidence ?? 0.5;
  $("#tMinVolume").value = t.minVolume ?? 50000;
  $("#tKelly").value = t.kellyFraction ?? 0.25;
}
function readThresholds() {
  return {
    // 0 means "no horizon limit", not "zero days"
    maxHorizonDays: Number($("#tMaxHorizon").value) || null,
    minEdge: Number($("#tMinEdge").value),
    minEvidence: Number($("#tMinEvidence").value),
    minVolume: Number($("#tMinVolume").value),
    kellyFraction: Number($("#tKelly").value),
  };
}

/* Mirrors platform/runner.js DEFAULT_ENGINE: quorum of three, weights
 * 3.1/1/2. A bot with no "engine" in its config falls back to this default,
 * so the UI must preselect it the same way when the field is absent. */
const DEFAULT_WEIGHTS = { jev: 3.1, laya: 1, kev: 2 };

function fillEngine(engine) {
  const name = engine?.name && ["jev", "laya", "kev", "quorum"].includes(engine.name)
    ? engine.name : "quorum";
  const radio = document.querySelector(`input[name="fEngine"][value="${name}"]`);
  if (radio) radio.checked = true;
  const w = { ...DEFAULT_WEIGHTS, ...(engine?.weights ?? {}) };
  $("#eWJev").value = w.jev;
  $("#eWLaya").value = w.laya;
  $("#eWKev").value = w.kev;
  syncEngineUI();
}
function syncEngineUI() {
  const isQuorum = document.querySelector('input[name="fEngine"]:checked')?.value === "quorum";
  $("#quorumWeights").hidden = !isQuorum;
}
document.querySelectorAll('input[name="fEngine"]').forEach(r => r.onchange = syncEngineUI);

function readEngine() {
  const name = document.querySelector('input[name="fEngine"]:checked')?.value ?? "quorum";
  if (name === "quorum") {
    return {
      name: "quorum", engines: ["jev", "laya", "kev"],
      weights: {
        jev: Number($("#eWJev").value) || DEFAULT_WEIGHTS.jev,
        laya: Number($("#eWLaya").value) || DEFAULT_WEIGHTS.laya,
        kev: Number($("#eWKev").value) || DEFAULT_WEIGHTS.kev,
      },
    };
  }
  return { name };
}

function fillSideAssistant(sa = {}) {
  $("#saOn").checked = !!sa.enabled;
  $("#saHost").value = Array.isArray(sa.hosts) ? sa.hosts.join(", ") : (sa.host ?? "");
  $("#saModel").value = sa.model ?? "";
  $("#saMode").value = sa.mode ?? "pre";
  const out = sa.outputs ?? {};
  $("#saOutVerdict").checked = !!out.probability;
  $("#saOutRationale").checked = !!out.comment;
  $("#saOutFlag").checked = !!out.gaps;
  syncSideAssistantUI();
}
/** The "turn on the assistant" checkbox lives in the base section; its
 * details live in the collapsed advanced section. When it's turned on, we
 * open it automatically so the user immediately sees what can be tuned. */
function syncSideAssistantUI() {
  const on = $("#saOn").checked;
  $("#saFields").disabled = !on;
  if (on) $("#saDetails").open = true;
}
$("#saOn").onchange = syncSideAssistantUI;

function readSideAssistant() {
  return {
    enabled: $("#saOn").checked,
    hosts: $("#saHost").value.split(",").map(s => s.trim()).filter(Boolean),
    model: $("#saModel").value.trim(),
    mode: $("#saMode").value,
    outputs: {
      probability: $("#saOutVerdict").checked,
      comment: $("#saOutRationale").checked,
      gaps: $("#saOutFlag").checked,
    },
  };
}

async function load() {
  renderContextFields({});
  fillThresholds({});
  fillSideAssistant({});
  fillEngine(null);
  if (!isEdit) {
    $("#title").textContent = "New bot";
    $("#sub").textContent = "All you need is the name: advanced settings stay closed and use their starting values until you open them.";
    $("#btnSave").textContent = "Create bot";
    return;
  }
  try {
    const d = await api(`/api/bots/${id}`);
    $("#title").textContent = `Configure ${d.bot.name}`;
    $("#sub").textContent = `saving creates version v${(d.bot.config_version ?? d.config?.version ?? 1) + 1}`;
    $("#basicsHint").textContent = "Change whatever you like. Every save creates a new version, it does not delete the old one.";
    $("#backLink").href = `/bot.html?id=${id}`;
    $("#cancelLink").href = `/bot.html?id=${id}`;
    $("#fName").value = d.bot.name;
    $("#fBlurb").value = d.bot.blurb ?? "";
    $("#fBankroll").value = d.bot.bankroll;
    const ctx = d.config?.context ?? {};
    const thr = d.config?.thresholds ?? {};
    renderContextFields(ctx.fields ?? {});
    fillThresholds(thr);
    fillSideAssistant(ctx.sideAssistant ?? {});
    fillEngine(ctx.engine ?? null);
    if (Array.isArray(ctx.universe)) $("#fUniverse").value = ctx.universe.join("\n");
  } catch (e) {
    $("#err").innerHTML = errorBanner(e.message);
  }
}

$("#form").onsubmit = async e => {
  e.preventDefault();
  const name = $("#fName").value.trim();
  if (!name) return;
  const universe = $("#fUniverse").value.split("\n").map(s => s.trim()).filter(Boolean);
  const context = { fields: readContextFields(), universe, sideAssistant: readSideAssistant(), engine: readEngine() };
  const thresholds = readThresholds();
  const bankroll = Number($("#fBankroll").value) || 1000;
  const blurb = $("#fBlurb").value.trim();
  const note = $("#fNote").value.trim();

  const btn = $("#btnSave");
  btn.disabled = true;
  $("#saveMsg").textContent = "";
  try {
    if (isEdit) {
      await api(`/api/bots/${id}/config`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ context, thresholds, note }),
      });
      $("#saveMsg").textContent = "Saved as a new version.";
      setTimeout(() => { location.href = `/bot.html?id=${id}`; }, 600);
    } else {
      const created = await api("/api/bots", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, blurb, bankroll, context, thresholds }),
      });
      const newId = created.id ?? created.bot?.id;
      $("#saveMsg").textContent = "Bot created.";
      if (newId) setTimeout(() => { location.href = `/bot.html?id=${newId}`; }, 600);
    }
  } catch (err) {
    $("#saveMsg").innerHTML = errorBanner(err.message);
  } finally {
    btn.disabled = false;
  }
};

load();
