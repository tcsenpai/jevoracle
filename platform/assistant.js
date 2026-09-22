/* Side assistant: an optional local LLM alongside Jev.
 *
 * A rule that is not up for debate (policies.md §8): the LLM never decides.
 * It prepares the argument or gives a side opinion, but the decision
 * function's signature remains Jev's. `probability` produced here NEVER
 * enters kelly() or the gating.
 *
 * Three modes, and the difference is not cosmetic:
 *   pre     the LLM processes the context BEFORE Jev sees it
 *   blind   same context as Jev, without seeing the verdict. Genuine opinion.
 *   review  sees the verdict and comments on it. Contaminated by construction:
 *           it tends to rationalize what Jev already said, not to check it.
 */
import { askJSON } from "./llm.js";

export const DEFAULT_ASSISTANT = {
  enabled: false,
  mode: "blind",
  hosts: ["http://192.168.1.20:11434", "http://192.168.1.6:11434"],
  model: "gemma4:e4b",
  outputs: { enrichContext: false, probability: true, comment: true, gaps: false },
  timeoutMs: 30_000,
  maxTokens: 900,
  temperature: 0.2,
  onFailure: "skip",      // "skip" = la predizione procede senza. "block" mai di default.
};

export function normaliseAssistant(cfg = {}) {
  const a = { ...DEFAULT_ASSISTANT, ...cfg, outputs: { ...DEFAULT_ASSISTANT.outputs, ...(cfg.outputs ?? {}) } };
  // arricchire il contesto ha senso solo prima che Jev lo veda
  if (a.mode !== "pre") a.outputs.enrichContext = false;
  if (!["pre", "blind", "review"].includes(a.mode)) a.mode = "blind";
  return a;
}

/* Enrichment is the point where the LLM can contaminate Jev: if it writes a
 * conclusion instead of a fact, Jev reads it as evidence. The prompt forbids
 * it and `looksLikeJudgement` checks for it downstream. */
const PRE_SYSTEM = `You prepare context for a separate decision system. You do NOT judge.
Output ONLY JSON: {"facts":["..."],"gaps":["..."]}.
RULES:
- Each fact restates or summarises information ALREADY PRESENT in the input. Never add your own conclusion.
- Bad: "Newsom looks like the favourite." (a judgement you invented)
- Good: "A September poll cited in the context puts Newsom at 22 percent." (a fact from the input)
- Never state whether the outcome is likely, probable, favoured or unlikely.
- gaps lists what a careful analyst would still need, phrased as a missing item.
- At most 8 facts and 5 gaps.`;

const OPINION_SYSTEM = `You give a second opinion on a prediction-market question.
Output ONLY JSON: {"probability":0.0,"comment":"...","gaps":["..."]}.
RULES:
- probability is your own estimate that the event resolves YES, a number between 0 and 1.
- Judge ONLY from the context given. You have no other information.
- comment is at most 3 sentences of plain prose explaining what the context supports.
- gaps lists what is missing from the context, at most 4 items.
- Never mention any market price, odds, or what traders think.`;

/* If the enrichment contains an overall judgment, it is not an enrichment. */
const JUDGEMENT = /\b(likely|unlikely|probable|improbable|favou?rite|favou?red|will (?:probably|likely)|i (?:think|believe|expect)|my estimate|seems certain|almost certain|no chance)\b/i;
export const looksLikeJudgement = t => JUDGEMENT.test(String(t ?? ""));

const clamp01 = v => { const n = Number(v); return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null; };

/** Contesto in testo piatto, senza mai includere il prezzo. */
function renderState(state) {
  if (typeof state === "string") return state;
  return Object.entries(state ?? {})
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join("\n  ") : v}`).join("\n\n");
}

/**
 * Runs the side assistant. Never throws if onFailure is "skip": it returns a
 * row with ok:false and the reason, because an optional assistant that
 * breaks the scan would be worse than no assistant at all.
 */
export async function runAssistant({ config, state, question, jevVerdict = null }) {
  const cfg = normaliseAssistant(config);
  if (!cfg.enabled) return null;

  const wantsPre = cfg.mode === "pre";
  const system = wantsPre ? PRE_SYSTEM : OPINION_SYSTEM;

  let user = `QUESTION: ${question}\n\nCONTEXT:\n${renderState(state)}`;
  if (cfg.mode === "review" && jevVerdict != null) {
    user += `\n\nA separate system judged the probability to be ${(jevVerdict * 100).toFixed(0)} percent. ` +
            `Comment on what in the context supports or undermines that reading.`;
  }

  const started = Date.now();
  try {
    const out = await askJSON({
      hosts: cfg.hosts, model: cfg.model, system, user,
      maxTokens: cfg.maxTokens, temperature: cfg.temperature, timeoutMs: cfg.timeoutMs,
      validate: d => {
        if (wantsPre) return Array.isArray(d?.facts) ? null : "missing `facts` array";
        if (cfg.outputs.probability && clamp01(d?.probability) == null)
          return "`probability` must be a number between 0 and 1";
        return null;
      },
    });

    const d = out.data;
    const row = {
      ok: true, mode: cfg.mode, host: out.host, model: out.model,
      latency_ms: Date.now() - started, attempts: out.attempt,
      probability: cfg.outputs.probability ? clamp01(d.probability) : null,
      comment: cfg.outputs.comment ? (d.comment ?? null) : null,
      gaps: cfg.outputs.gaps ? (d.gaps ?? []) : [],
      enriched: null,
    };

    if (wantsPre && cfg.outputs.enrichContext) {
      // scarta i "fatti" che sono in realta' giudizi: non devono arrivare a Jev
      const kept = (d.facts ?? []).filter(f => !looksLikeJudgement(f));
      row.enriched = kept;
      row.dropped = (d.facts ?? []).length - kept.length;
    }
    return row;
  } catch (err) {
    const row = { ok: false, mode: cfg.mode, error: String(err.message ?? err),
                  latency_ms: Date.now() - started, probability: null, comment: null, gaps: [] };
    if (cfg.onFailure === "block") throw err;
    return row;
  }
}
