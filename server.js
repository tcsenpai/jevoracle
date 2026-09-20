/* jevoracle
 *
 * The server does three things and nothing else:
 *   1. keeps the TypeSafe API key off the client
 *   2. proxies POST /api/ask to the TypeSafe System One endpoint
 *   3. optionally asks a local OpenAI-compatible model to propose sub-questions
 *
 * Everything else (building the request, rendering answers) happens in the browser.
 */

const envText = await Bun.file(".env").text().catch(() => "");
const env = (k, fallback) =>
  process.env[k] ?? envText.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim() ?? fallback;

const KEY = env("TYPESAFE_API_KEY");
if (!KEY) {
  console.error("TYPESAFE_API_KEY is not set. Copy .env.example to .env and add your key.");
  process.exit(1);
}

const PORT = Number(env("PORT", "3737"));
const UPSTREAM = env("TYPESAFE_URL", "https://api.typesafe.ai/v1/systemone");
const DEC_URLS = [env("DECOMPOSE_URL"), env("DECOMPOSE_URL_FALLBACK")].filter(Boolean);
const DEC_MODEL = env("DECOMPOSE_MODEL", "gemma4:e4b");

const MAX_BODY = 512 * 1024;        // a state large enough for real documents, small enough to bound
const DEC_TIMEOUT = 180_000;        // local models on cold start are slow

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });

/** Read a request body with a hard size cap, so a runaway client cannot exhaust memory. */
async function readCapped(req) {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_BODY) throw new Error(`Request body exceeds ${MAX_BODY} bytes.`);
  const text = await req.text();
  if (text.length > MAX_BODY) throw new Error(`Request body exceeds ${MAX_BODY} bytes.`);
  return text;
}

/** Reject malformed requests here rather than spending an upstream call on them. */
function validateAsk(body) {
  if (typeof body !== "object" || body === null) return "Body must be a JSON object.";
  if (body.state === undefined || body.state === "") return "`state` is required.";
  const q = body.questions;
  if (typeof q !== "object" || q === null) return "`questions` must be an object.";
  const ids = Object.keys(q);
  if (!ids.length) return "`questions` must contain at least one question.";
  if (ids.length > 64) return "Too many questions in one request (max 64).";
  for (const id of ids) {
    const item = q[id];
    if (typeof item !== "object" || item === null) return `Question "${id}" must be an object.`;
    if (!["noul", "choice", "score"].includes(item.type))
      return `Question "${id}" has an unsupported type: ${item.type}`;
    if (!item.instructions) return `Question "${id}" is missing instructions.`;
    if (item.type === "choice") {
      const n = Object.keys(item.criteria ?? {}).length;
      if (n < 2) return `Choice "${id}" needs at least 2 options.`;
      if (n > 255) return `Choice "${id}" exceeds 255 options.`;
    }
    if (item.type === "score") {
      const n = (item.criteria ?? []).length;
      if (n < 2 || n > 10) return `Score "${id}" needs between 2 and 10 levels.`;
    }
  }
  return null;
}

/* The local model proposes questions. It never judges them; Jev does that. */
const DECOMPOSE_SYSTEM = `You break a decision into the independent FACTORS it depends on.
Output ONLY JSON: {"factors":[{"id":"snake_case","label":"2-4 words","q":"statement"}]}. Exactly {N}.
RULES:
- Each q is a DECLARATIVE statement asserting that one factor FAVOURS the proposed outcome.
- It must be genuinely uncertain and arguable from the context - NEVER a fact already stated in the context.
- Bad: "The founders have 400k EUR." (restates a given fact)
- Good: "The available capital is sufficient for the outcome to succeed." (a judgment)
- Cover DIFFERENT dimensions (money, capability, timing, external conditions, risk).
- Do not restate the main question.`;

/** Local models sometimes truncate or wrap their JSON. Take the whole object when it
 *  parses; otherwise salvage every complete factor object that did arrive. */
function parseFactors(text) {
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed?.factors)) return parsed.factors.filter(f => f?.q);
  } catch {}
  const out = [];
  for (const m of text.matchAll(/\{[^{}]*"q"\s*:\s*"[^"]*"[^{}]*\}/g)) {
    try { const f = JSON.parse(m[0]); if (f?.q) out.push(f); } catch {}
  }
  return out;
}

async function decompose({ question, context, n = 5 }) {
  const payload = {
    model: DEC_MODEL,
    temperature: 0.4,
    max_tokens: 900,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: DECOMPOSE_SYSTEM.replace("{N}", String(n)) },
      { role: "user", content: `QUESTION: ${question}\n\nCONTEXT:\n${context}` },
    ],
  };
  let lastError;
  for (const base of DEC_URLS) {
    try {
      const res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(DEC_TIMEOUT),
      });
      if (!res.ok) { lastError = `${base} returned HTTP ${res.status}`; continue; }
      const data = await res.json();
      const factors = parseFactors(data.choices?.[0]?.message?.content ?? "").slice(0, n);
      if (!factors.length) { lastError = `${base} returned no usable factors`; continue; }
      return { factors, host: base, model: DEC_MODEL };
    } catch (err) {
      lastError = `${base}: ${err.message ?? err}`;
    }
  }
  throw new Error(lastError ?? "no decomposition hosts configured");
}

const server = Bun.serve({
  port: PORT,
  idleTimeout: 240,

  async fetch(req) {
    const { pathname } = new URL(req.url);

    if (pathname === "/api/ask") {
      if (req.method !== "POST") return json({ error: "Use POST." }, 405);
      let body;
      try { body = JSON.parse(await readCapped(req)); }
      catch (err) { return json({ error: err.message ?? "Invalid JSON." }, 400); }

      const problem = validateAsk(body);
      if (problem) return json({ error: problem }, 400);

      const started = Date.now();
      let res;
      try {
        res = await fetch(UPSTREAM, {
          method: "POST",
          headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ ...body, model: body.model ?? "jev-latest" }),
          signal: AbortSignal.timeout(60_000),
        });
      } catch (err) {
        return json({ error: `Could not reach TypeSafe: ${err.message ?? err}` }, 502);
      }

      const text = await res.text();
      if (!res.ok) {
        // Pass the upstream status through, but never the Authorization header or key.
        let detail = text.slice(0, 500);
        try { detail = JSON.parse(text)?.error?.message ?? detail; } catch {}
        return json({ error: detail || `TypeSafe returned HTTP ${res.status}` }, res.status);
      }
      try {
        return json({ ...JSON.parse(text), _ms: Date.now() - started });
      } catch {
        return json({ error: "TypeSafe returned a malformed response." }, 502);
      }
    }

    if (pathname === "/api/decompose") {
      if (req.method !== "POST") return json({ error: "Use POST." }, 405);
      if (!DEC_URLS.length) return json({ error: "No local model configured." }, 503);
      let body;
      try { body = JSON.parse(await readCapped(req)); }
      catch (err) { return json({ error: err.message ?? "Invalid JSON." }, 400); }
      if (!body.question) return json({ error: "`question` is required." }, 400);

      const started = Date.now();
      try {
        const result = await decompose({
          question: String(body.question),
          context: String(body.context ?? ""),
          n: Math.min(Math.max(Number(body.n) || 5, 2), 10),
        });
        return json({ ...result, _ms: Date.now() - started });
      } catch (err) {
        return json({ error: String(err.message ?? err) }, 503);
      }
    }

    if (pathname === "/api/config")
      return json({ decompose: DEC_URLS.length > 0, model: DEC_MODEL });

    if (pathname === "/healthz") return new Response("ok", { status: 200 });

    // Static files. Path is resolved against public/ and cannot escape it.
    const rel = pathname === "/" ? "/index.html" : pathname;
    if (rel.includes("..")) return new Response("Not found", { status: 404 });
    const file = Bun.file(`public${rel}`);
    if (!(await file.exists())) return new Response("Not found", { status: 404 });
    const immutable = rel !== "/index.html";
    return new Response(file, {
      headers: { "Cache-Control": immutable ? "public, max-age=3600" : "no-cache" },
    });
  },
});

console.log(`jevoracle listening on http://localhost:${server.port}`);
console.log(DEC_URLS.length
  ? `decomposition via ${DEC_URLS[0]} using ${DEC_MODEL}`
  : `decomposition disabled (set DECOMPOSE_URL to enable)`);
