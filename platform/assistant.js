/* Side assistant: un LLM locale opzionale accanto a Jev.
 *
 * Regola che non si discute (policies.md §8): l'LLM non decide mai. Prepara
 * l'argomento o da' un parere affiancato, ma la firma della funzione decisionale
 * resta di Jev. `probability` prodotta qui non entra MAI in kelly() ne' nel gating.
 *
 * Tre modalita', e la differenza non e' cosmetica:
 *   pre     l'LLM elabora il contesto PRIMA che Jev lo veda
 *   blind   stesso contesto di Jev, senza vedere il verdetto. Parere genuino.
 *   review  vede il verdetto e lo commenta. Contaminato per costruzione: tende a
 *           razionalizzare quello che Jev ha gia' detto, non a controllarlo.
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

/* L'arricchimento e' il punto dove l'LLM puo' contaminare Jev: se scrive una
 * conclusione invece di un fatto, Jev la legge come evidenza. Il prompt lo vieta
 * e `looksLikeJudgement` lo verifica a valle. */
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

/* Se l'arricchimento contiene un giudizio complessivo, non e' un arricchimento. */
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
 * Esegue il side assistant. Non solleva mai se onFailure e' "skip": restituisce
 * una riga con ok:false e il motivo, perche' un assistente opzionale che rompe
 * lo scan sarebbe peggio di un assistente assente.
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
        if (wantsPre) return Array.isArray(d?.facts) ? null : "manca l'array `facts`";
        if (cfg.outputs.probability && clamp01(d?.probability) == null)
          return "`probability` deve essere un numero fra 0 e 1";
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
