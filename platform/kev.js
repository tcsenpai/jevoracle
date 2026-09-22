/* Bridge to Kev (https://github.com/jaredpalmer/kev).
 *
 * Kev exposes THE SAME HTTP API as Jev/TypeSafe: POST /v1/systemone, same
 * body (state, model, questions), same response shape (answers.X.noul /
 * .choice / .score, usage, latency). No Python bridge is needed like with
 * Laya: it is spoken to over HTTP the same way we already do with Jev in
 * platform/runner.js.
 *
 * Local server, free, no API key. Startup (see platform/ENGINES.md):
 *   git clone https://github.com/jaredpalmer/kev.git && cd kev
 *   uv sync --extra serve
 *   KEV_DTYPE=bf16 uv run --extra serve python -m kev.serve \
 *     --run jaredpalmer/kev-4b --port 8009
 */

import { ensureKev, touchKev } from "./kev-process.js";

const DEFAULT_URL = "http://localhost:8009/v1/systemone";

/** The absolute default if the bot does not specify a Kev model. */
export const DEFAULT_KEV_MODEL = "jaredpalmer/kev-4b@qwen3";

/**
 * Asks Kev for a judgment over the same protocol as Jev.
 *
 * @param {object} request   { state, questions, ... } - identical to Jev
 * @param {object} opts      { url, timeoutMs }
 * @returns {Promise<{ answers, ms, model }>}
 */
export async function askKev(request, opts = {}) {
  const url = opts.url ?? DEFAULT_URL;
  const timeoutMs = opts.timeoutMs ?? 60000;

  // On demand: the server starts on the first request and shuts itself down
  // after a period of inactivity. A 4B model kept on 24/7 for a few runs a
  // day is memory taken away from the rest of the machine.
  // Whoever prefers to manage it by hand passes opts.autostart = false.
  // Only the default local server is autostarted: if someone points at a
  // remote Kev or a different port, that is their business and we do not
  // touch it.
  if (opts.autostart !== false && url === DEFAULT_URL) {
    await ensureKev();
  }

  const t0 = Date.now();
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // a raw ECONNREFUSED helps nobody: say how to start it.
    throw new Error(
      `Kev is not responding on ${url}. The server is not started or is on a different port. ` +
      `To start it: "cd kev && uv sync --extra serve && KEV_DTYPE=bf16 uv run --extra serve ` +
      `python -m kev.serve --run jaredpalmer/kev-4b --port 8009" (repo: github.com/jaredpalmer/kev). ` +
      `Original detail: ${err.message ?? err}`);
  }

  const ms = Date.now() - t0;
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Kev ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  if (!data?.answers) {
    throw new Error("Kev responded without the answers field: unexpected response, check the server version.");
  }

  // The versioned id must be propagated as-is: months from now we need to
  // know WHICH Kev decided (e.g. "kev-4b@qwen3"), not just that it was "kev".
  const model = data.model ?? opts.fallbackModel ?? DEFAULT_KEV_MODEL;

  touchKev();   // request succeeded: postpone the idle shutdown
  return { answers: data.answers, ms: data._ms ?? ms, model };
}
