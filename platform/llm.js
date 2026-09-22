/* Client for a local OpenAI-compatible LLM (Ollama), with a guard on the format.
 *
 * Two things learned by measuring on gemma4:e4b, not deduced:
 *
 * 1. It is a reasoning model. It spends tokens in the `reasoning` field BEFORE
 *    producing `content`. With a tight budget it exhausts them all there and
 *    returns empty content with finish_reason "length" and NO HTTP error: the
 *    failure is silent and the parse fails downstream without explaining why.
 * 2. `reasoning_effort: "none"` turns it off. Measured on the real decompose
 *    prompt: 3.2s versus 24.6s, same quality, with a quarter of the tokens.
 *    The alternatives (`think:false`, `chat_template_kwargs.enable_thinking`)
 *    do nothing or make it worse.
 */

export const DEFAULT_MODEL = "gemma4:e4b";
export const MAX_ATTEMPTS = 4;          // then it fails loudly, no silent failures

export class LLMError extends Error {
  constructor(message, attempts) { super(message); this.name = "LLMError"; this.attempts = attempts; }
}

/** Why a response is unusable. Null if it is fine. */
function rejectReason(data, { validate }) {
  const choice = data?.choices?.[0];
  if (!choice) return "response has no choices";
  const content = choice.message?.content ?? "";
  // truncation from reasoning is not an HTTP error: it must be recognized here
  if (choice.finish_reason === "length" && !content.trim())
    return "budget exhausted in reasoning (finish_reason=length, empty content)";
  if (choice.finish_reason === "length") return "truncated response (finish_reason=length)";
  if (!content.trim()) return "empty content";

  let parsed;
  try { parsed = JSON.parse(content); }
  catch (e) { return `invalid JSON: ${e.message}`; }

  if (validate) {
    const problem = validate(parsed);
    if (problem) return `schema: ${problem}`;
  }
  return null;
}

/**
 * Asks a local LLM for JSON. Retries up to MAX_ATTEMPTS, then throws.
 *
 * Each attempt raises the token budget and lowers the temperature: if the
 * first response was truncated, insisting with the same parameters is useless.
 *
 * @param {object} opts
 * @param {string[]} opts.hosts    base urls in order of preference
 * @param {function} opts.validate (parsed) => string|null, null if valid
 */
export async function askJSON({
  hosts, model = DEFAULT_MODEL, system, user,
  maxTokens = 900, temperature = 0.4, timeoutMs = 30_000,
  validate = null, attempts = MAX_ATTEMPTS, noReasoning = true,
}) {
  if (!hosts?.length) throw new LLMError("no host configured", 0);
  const tried = [];

  for (let attempt = 1; attempt <= attempts; attempt++) {
    // more headroom each round, and less creativity: the typical failure is
    // truncation or format, not lack of imagination
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
      // hosts in configuration may already end with /v1: do not double it up
      const root = host.replace(/\/+$/, "");
      const endpoint = `${root}${/\/v1$/.test(root) ? "" : "/v1"}/chat/completions`;
      const res = await fetch(endpoint, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) { tried.push(`attempt ${attempt} on ${host}: HTTP ${res.status}`); continue; }

      const data = await res.json();
      const bad = rejectReason(data, { validate });
      if (bad) { tried.push(`attempt ${attempt} on ${host}: ${bad}`); continue; }

      return {
        data: JSON.parse(data.choices[0].message.content),
        host, model: data.model ?? model,
        attempt, ms: Date.now() - started,
        usage: data.usage ?? null,
      };
    } catch (err) {
      const why = err.name === "TimeoutError" ? `timeout after ${timeoutMs}ms` : (err.message ?? String(err));
      tried.push(`attempt ${attempt} on ${host}: ${why}`);
    }
  }

  throw new LLMError(
    `Local LLM failed after ${attempts} attempts. ${tried.join(" | ")}`, attempts);
}
