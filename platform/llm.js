/* Client per un LLM locale OpenAI-compatible (Ollama), con guardia sul formato.
 *
 * Due cose imparate misurando su gemma4:e4b, non dedotte:
 *
 * 1. E' un reasoning model. Spende token nel campo `reasoning` PRIMA di produrre
 *    `content`. Con budget stretto li esaurisce tutti la' e restituisce content
 *    vuoto con finish_reason "length" e NESSUN errore HTTP: il fallimento e'
 *    silenzioso e il parse fallisce a valle senza spiegare perche'.
 * 2. `reasoning_effort: "none"` lo spegne. Misurato sul prompt reale di decompose:
 *    3.2s contro 24.6s, stessa qualita', con un quarto dei token. Le alternative
 *    (`think:false`, `chat_template_kwargs.enable_thinking`) non fanno nulla o
 *    peggiorano.
 */

export const DEFAULT_MODEL = "gemma4:e4b";
export const MAX_ATTEMPTS = 4;          // poi si fallisce forte, niente silenzi

export class LLMError extends Error {
  constructor(message, attempts) { super(message); this.name = "LLMError"; this.attempts = attempts; }
}

/** Perche' una risposta e' inutilizzabile. Null se va bene. */
function rejectReason(data, { validate }) {
  const choice = data?.choices?.[0];
  if (!choice) return "risposta senza choices";
  const content = choice.message?.content ?? "";
  // il troncamento da reasoning non e' un errore HTTP: va riconosciuto qui
  if (choice.finish_reason === "length" && !content.trim())
    return "budget esaurito nel reasoning (finish_reason=length, content vuoto)";
  if (choice.finish_reason === "length") return "risposta troncata (finish_reason=length)";
  if (!content.trim()) return "content vuoto";

  let parsed;
  try { parsed = JSON.parse(content); }
  catch (e) { return `JSON non valido: ${e.message}`; }

  if (validate) {
    const problem = validate(parsed);
    if (problem) return `schema: ${problem}`;
  }
  return null;
}

/**
 * Chiede JSON a un LLM locale. Riprova fino a MAX_ATTEMPTS, poi solleva.
 *
 * Ogni tentativo alza il budget di token e abbassa la temperatura: se la prima
 * risposta e' troncata, insistere con gli stessi parametri e' inutile.
 *
 * @param {object} opts
 * @param {string[]} opts.hosts    base url in ordine di preferenza
 * @param {function} opts.validate (parsed) => string|null, null se valido
 */
export async function askJSON({
  hosts, model = DEFAULT_MODEL, system, user,
  maxTokens = 900, temperature = 0.4, timeoutMs = 30_000,
  validate = null, attempts = MAX_ATTEMPTS, noReasoning = true,
}) {
  if (!hosts?.length) throw new LLMError("nessun host configurato", 0);
  const tried = [];

  for (let attempt = 1; attempt <= attempts; attempt++) {
    // piu' margine a ogni giro, e meno creativita': il fallimento tipico e'
    // troncamento o formato, non mancanza di fantasia
    const budget = Math.round(maxTokens * (1 + 0.6 * (attempt - 1)));
    const temp = Math.max(0.05, temperature - 0.1 * (attempt - 1));
    const host = hosts[(attempt - 1) % hosts.length];

    const body = {
      model, temperature: temp, max_tokens: budget,
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      ...(noReasoning ? { reasoning_effort: "none" } : {}),
    };

    const started = Date.now();
    try {
      // gli host in configurazione possono gia' finire con /v1: non raddoppiarlo
      const root = host.replace(/\/+$/, "");
      const endpoint = `${root}${/\/v1$/.test(root) ? "" : "/v1"}/chat/completions`;
      const res = await fetch(endpoint, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) { tried.push(`tentativo ${attempt} su ${host}: HTTP ${res.status}`); continue; }

      const data = await res.json();
      const bad = rejectReason(data, { validate });
      if (bad) { tried.push(`tentativo ${attempt} su ${host}: ${bad}`); continue; }

      return {
        data: JSON.parse(data.choices[0].message.content),
        host, model: data.model ?? model,
        attempt, ms: Date.now() - started,
        usage: data.usage ?? null,
      };
    } catch (err) {
      const why = err.name === "TimeoutError" ? `timeout dopo ${timeoutMs}ms` : (err.message ?? String(err));
      tried.push(`tentativo ${attempt} su ${host}: ${why}`);
    }
  }

  throw new LLMError(
    `LLM locale fallito dopo ${attempts} tentativi. ${tried.join(" | ")}`, attempts);
}
