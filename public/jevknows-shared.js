/* Shared helpers for the JevKnows platform pages (list, detail, config).
 * No framework, no build step. Import as ES module.
 *
 * Plain-language rule (founder correction, 2026-09-20): every technical number
 * must ship with a short, visible sentence saying what it means. A naive user
 * who has never heard of a Brier score must still understand the row. The
 * number stays (it's real, verifiable, not hidden) but it is never the only
 * thing on screen.
 */

export const $ = (s, root = document) => root.querySelector(s);
const ESC_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
export const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ESC_MAP[c]);

/* Brand rule: a number that cannot be computed yet is "missing", never 0.
 * null/undefined -> honest marker, not a silent zero. */
export const pc = (v, d = 1) => v == null ? na() : `${(v * 100).toFixed(d)}%`;
export const num = (v, d = 3) => v == null ? na() : v.toFixed(d);
export const usd = v => v == null ? na() : `${v < 0 ? "-" : ""}$${Math.abs(v).toFixed(2)}`;
export const na = () => `<span class="na">not available yet</span>`;

/* Plain-text (no markup) variants, for slotting into the small "raw" figure
 * under a headline sentence, pc()/num()/usd() return HTML and are for
 * standalone table cells, not for nesting inside another string. */
export const pcRaw = (v, d = 1) => v == null ? null : `${(v * 100).toFixed(d)}%`;
export const numRaw = (v, d = 3) => v == null ? null : v.toFixed(d);
export const usdRaw = v => v == null ? null : `${v < 0 ? "-" : ""}$${Math.abs(v).toFixed(2)}`;

export const ago = t => {
  if (!t) return `<span class="na">not started yet</span>`;
  const m = Math.round((Date.now() - new Date(t)) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  if (m < 1440) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
};

/** Fetch JSON, never pretend a failure succeeded. Callers show err in the UI. */
export async function api(url, opts) {
  let res;
  try {
    res = await fetch(url, opts);
  } catch (e) {
    throw new Error(`Network error reaching ${url}: ${e.message ?? e}`);
  }
  let body = null;
  try { body = await res.json(); } catch { /* no body */ }
  if (!res.ok) {
    throw new Error(body?.error ?? `${url} -> HTTP ${res.status}`);
  }
  return body;
}

export function errorBanner(msg) {
  return `<div class="banner err"><b>Something went wrong.</b> ${esc(msg)}</div>`;
}

/* ---------- plain-language phrases ----------
 * Each of these turns a technical measure into a short sentence a first-time
 * visitor can read without knowing the jargon. The number is kept, smaller,
 * next to the sentence, never removed, never the only thing shown. */

/** evidence_sufficient, self-reported by the model: how much it says it knows. */
export function evidencePhrase(v) {
  if (v == null) return { text: "has not said yet how informed it feels", cls: "" };
  if (v >= 0.7) return { text: "says it has enough information", cls: "good" };
  if (v >= 0.4) return { text: "says it is only partly informed", cls: "" };
  return { text: "says it does not have enough information", cls: "warn" };
}

/** abstention rate: how often the bot chose not to bet. */
export function abstentionPhrase(rate, seen) {
  if (rate == null) return { text: "has made too few predictions to tell", cls: "" };
  const pct = Math.round(rate * 100);
  if (pct === 0) return { text: "so far it has bet on every market it has seen", cls: "" };
  return { text: `chose not to bet on ${pct}% of the markets it looked at`, cls: "" };
}

/** Brier delta vs crowd: negative = Jev beats the crowd, lower Brier is better. */
export function brierPhrase(vc) {
  if (!vc) return { text: "no market has closed yet, so there is nothing to compare against", cls: "" };
  return vc.beats
    ? { text: "on closed markets it guessed better than the market", cls: "good" }
    : { text: "on closed markets it guessed worse than the market", cls: "warn" };
}

/** How much it's risking right now and when it will know the outcome. */
export function stakedPhrase(staked, nextClose, dueNow, wouldHaveBet = 0) {
  if (!staked) {
    // Common, non-obvious case: the bot made predictions but did not bet on
    // any of them. Say so, and say how many the free rule would have opened.
    const alt = wouldHaveBet
      ? ` With the free rule it would have opened ${wouldHaveBet}.`
      : "";
    return { text: `It has not bet anything: no virtual money at stake.${alt}`, cls: "" };
  }
  const amount = `<b>${Math.round(staked)} $</b> virtual at stake`;
  if (dueNow > 0) {
    const q = dueNow === 1 ? "one bet has already expired" : `${dueNow} bets have already expired`;
    return { text: `${amount}, and ${q}: the outcome will be known at the next check.`, cls: "warn" };
  }
  if (!nextClose) return { text: `${amount}.`, cls: "" };
  const days = Math.ceil((new Date(nextClose) - Date.now()) / 86400000);
  const when = days <= 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`;
  return { text: `${amount}. The first one closes ${when}.`, cls: "" };
}

/** The result in fake money, said the way a person would say it. */
export function pnlPhrase(pnl, settledN) {
  if (!settledN) return {
    text: "It has not won or lost anything yet: no market has closed.", cls: "" };
  if (pnl == null) return { text: "result not calculable yet", cls: "" };
  const v = Math.abs(pnl).toFixed(2);
  if (pnl > 0) return { text: `It has made <b>${v} $</b> fake on closed markets.`, cls: "good" };
  if (pnl < 0) return { text: `It has lost <b>${v} $</b> fake on closed markets.`, cls: "warn" };
  return { text: "It is breaking even on closed markets.", cls: "" };
}

/** maturity is already a plain sentence from metrics.js, use it as the primary text. */
export function maturityText(maturity) {
  return maturity ?? "not clear yet how much to trust these numbers";
}

export function maturityBadge(maturity, settledN) {
  const tier = settledN == null ? 0 : settledN === 0 ? 0 : settledN < 20 ? 1 : settledN < 50 ? 2 : 3;
  return `<span class="maturity n${tier}">${esc(maturityText(maturity))}</span>`;
}

export function statusBadge(status) {
  const label = { active: "active", paused: "paused", archived: "archived" }[status] ?? status;
  return `<span class="status ${esc(status)}">${esc(label)}</span>`;
}

/** Inline jargon gloss: term the naive user may not know, plus a short plain
 * translation right next to it. Never the term alone. */
export function gloss(term, plain) {
  return `<span class="gloss">${esc(term)} <span class="glosstip">(${esc(plain)})</span></span>`;
}

/* ---------- decision engine ----------
 * Three interchangeable engines (jev, laya, kev) plus a quorum mode that
 * weighs them together. Lives in config.context.engine, see
 * platform/runner.js DEFAULT_ENGINE. These functions translate both the
 * config (what is set) and the "model" field recorded on each prediction
 * (who actually answered that time, which can differ from the config if
 * an engine was down). */

const ENGINE_NAMES = { jev: "Jev", laya: "Laya", kev: "Kev" };

/** Reads config.context.engine and returns a short, plain-language sentence
 * about who decides for this bot. No "engine" field = platform default, the
 * weighted quorum of three. */
export function enginePhrase(engine) {
  if (!engine || typeof engine !== "object" || !engine.name || engine.name === "quorum") {
    return "the quorum of three decides (Jev, Laya, Kev)";
  }
  const n = ENGINE_NAMES[engine.name] ?? engine.name;
  return `only ${n} decides`;
}

/** Short readable name for the "model" field saved on a prediction, e.g.
 * "quorum(jev+laya+kev)" -> "quorum (3/3)", "jev-1.13.0" -> "Jev".
 * The full technical id should always be offered separately as a title/tooltip. */
export function modelShort(model) {
  if (!model) return na();
  const m = String(model).match(/^quorum\(([a-z+]+)\)/i);
  if (m) {
    const got = m[1].split("+").filter(Boolean);
    return `quorum (${got.length}/3)`;
  }
  const base = String(model).split(/[-@]/)[0].toLowerCase();
  return ENGINE_NAMES[base] ?? esc(model);
}

/** Extracts { jev, laya, kev } -> probability (noul) or null if that engine
 * did not answer, from engine_votes (JSON string, already an object, or null). */
export function engineVoteProbs(engineVotes) {
  let votes = engineVotes;
  if (typeof votes === "string") {
    try { votes = JSON.parse(votes); } catch { votes = null; }
  }
  const out = {};
  for (const name of ["jev", "laya", "kev"]) {
    const v = votes?.[name]?.answers?.verdict?.noul;
    out[name] = typeof v === "number" ? v : null;
  }
  return out;
}

/** true if at least two engines answered and the farthest apart differs by
 * more than 0.3: the founder-given threshold for "they disagree". */
export function enginesDisagree(probs) {
  const vals = Object.values(probs).filter(v => v != null);
  if (vals.length < 2) return false;
  return (Math.max(...vals) - Math.min(...vals)) > 0.3;
}
