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

/* Goes through askJSON, which turns off reasoning and retries up to 4 times
 * if the format does not hold up. Measured on this same prompt: 3.2s versus 24.6s. */
async function decompose({ question, context, n = 5 }) {
  const need = Math.min(3, n);
  const usable = f => typeof f?.q === "string" && f.q.trim().length > 15;

  const out = await askJSON({
    hosts: DEC_URLS,
    model: DEC_MODEL,
    system: DECOMPOSE_SYSTEM.replace("{N}", String(n)),
    user: `QUESTION: ${question}\n\nCONTEXT:\n${context}`,
    maxTokens: 900,
    temperature: 0.4,
    timeoutMs: 45_000,
    validate: d => {
      if (!Array.isArray(d?.factors)) return "missing `factors` array";
      const good = d.factors.filter(usable).length;
      return good >= need ? null : `need at least ${need} factors with a real question, found ${good}`;
    },
  });

  return {
    factors: out.data.factors.filter(usable).slice(0, n),
    host: out.host, model: out.model, attempts: out.attempt,
  };
}

/* ---- paper trading engine (no money moves; see engine/execute.js) ---- */
import { scan, settleOpen, report, DEFAULTS } from "./engine/engine.js";
import { openStore } from "./engine/store.js";
import { liveStatus } from "./engine/execute.js";
import { getConfig, saveConfig, FIELDS, DEFAULT_CONFIG } from "./engine/config.js";
import { runExperiment, listExperiments, VARIANTS } from "./engine/experiment.js";
import { askJSON, LLMError } from "./platform/llm.js";
import { openDB as openPlatformDB, platformRoutes } from "./platform/api.js";
import { runBot as runBotWith } from "./platform/runner.js";
import { settleBots } from "./platform/settle.js";
import { startScheduler } from "./platform/scheduler.js";

const DB = openStore(env("ENGINE_DB", "data/engine.db"));
const PDB = openPlatformDB(env("JEVKNOWS_DB", "data/jevknows.db"));

// Automatic outcome check. Disabled with SCHEDULER=off, and
// the interval is changed with SCHEDULER_MINUTES.
const SCHED = env("SCHEDULER", "on") === "off" ? null
  : startScheduler(PDB, { intervalMs: Number(env("SCHEDULER_MINUTES", "15")) * 60_000 });
const platform = platformRoutes(PDB, {
  runBot: (id, mode, body) => runBotWith(id, mode, { ...body, db: PDB, apiKey: KEY }),
});
let scanning = false;   // one scan at a time; it spends API calls

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

    // JevKnows platform routes: /api/bots...
    const fromPlatform = await platform(req, pathname);
    if (fromPlatform) return fromPlatform;

    if (pathname === "/api/engine/report") {
      return json(report({ db: DB }));
    }

    if (pathname === "/api/engine/scan") {
      if (req.method !== "POST") return json({ error: "Use POST." }, 405);
      if (scanning) return json({ error: "A scan is already running." }, 409);
      let opts = {};
      try { opts = JSON.parse(await readCapped(req)); } catch {}
      scanning = true;
      try {
        const out = await scan({
          db: DB, apiKey: KEY,
          limit: Math.min(Number(opts.limit) || 8, 25),
          minEdge: Number(opts.minEdge) || DEFAULTS.minEdge,
          minEvidence: Number(opts.minEvidence) ?? DEFAULTS.minEvidence,
          bankroll: Number(opts.bankroll) || DEFAULTS.bankroll,
          note: opts.note,
        });
        return json(out);
      } catch (err) {
        return json({ error: String(err.message ?? err) }, 500);
      } finally { scanning = false; }
    }

    if (pathname === "/api/engine/settle") {
      if (req.method !== "POST") return json({ error: "Use POST." }, 405);
      try { return json(await settleOpen({ db: DB })); }
      catch (err) { return json({ error: String(err.message ?? err) }, 500); }
    }

    // settles the open predictions of ALL bots on the JevKnows platform
    if (pathname === "/api/settle") {
      if (req.method !== "POST") return json({ error: "Use POST." }, 405);
      try { return json(await settleBots(PDB)); }
      catch (err) { return json({ error: String(err.message ?? err) }, 500); }
    }

    if (pathname === "/api/engine/config") {
      if (req.method === "GET") return json({ config: getConfig(DB), fields: FIELDS, defaults: DEFAULT_CONFIG });
      if (req.method !== "POST") return json({ error: "Use GET or POST." }, 405);
      try {
        const patch = JSON.parse(await readCapped(req));
        return json({ config: saveConfig(DB, patch) });
      } catch (err) { return json({ error: String(err.message ?? err) }, 400); }
    }

    if (pathname === "/api/engine/preview") {
      if (req.method !== "POST") return json({ error: "Use POST." }, 405);
      let body = {};
      try { body = JSON.parse(await readCapped(req)); } catch {}
      if (!body.slug) return json({ error: "`slug` is required." }, 400);
      try {
        const { fetchEvent, pickMarket, toJevRequest } = await import("./scripts/polymarket.js");
        const { newsFor } = await import("./engine/news.js");
        const { applyFields, getConfig } = await import("./engine/config.js");
        const cfg = getConfig(DB);
        const fields = { ...cfg.fields, ...(body.fields ?? {}) };
        const ev = await fetchEvent(body.slug, { comments: 60 });
        const market = pickMarket(ev);
        if (!market) return json({ error: "No priceable market on that event." }, 400);
        let news = { items: [] };
        if (fields.recent_reporting !== false) {
          try { news = await newsFor(ev, market, { max: cfg.newsMax, timelimit: cfg.newsWindow }); } catch {}
        }
        const full = toJevRequest(ev, { market, news: news.items }).request;
        const kept = applyFields(full, fields);
        return json({
          market: market.label, crowd: market.yes,
          fields: Object.entries(kept.state).map(([key, v]) =>
            ({ key, chars: JSON.stringify(v).length })),
          dropped: Object.keys(full.state).filter(k => !(k in kept.state)),
        });
      } catch (err) { return json({ error: String(err.message ?? err) }, 500); }
    }

    if (pathname === "/api/engine/experiments") {
      return json({ runs: listExperiments(DB), variants: VARIANTS });
    }

    if (pathname === "/api/engine/experiment") {
      if (req.method !== "POST") return json({ error: "Use POST." }, 405);
      if (scanning) return json({ error: "A scan or experiment is already running." }, 409);
      let body = {};
      try { body = JSON.parse(await readCapped(req)); } catch {}
      const slugs = (body.slugs ?? []).map(String).map(s => s.trim()).filter(Boolean).slice(0, 6);
      if (!slugs.length) return json({ error: "Give at least one event slug or URL." }, 400);
      scanning = true;
      try {
        return json(await runExperiment({
          db: DB, apiKey: KEY, slugs,
          variants: (body.variants ?? Object.keys(VARIANTS)).filter(v => VARIANTS[v]),
          note: body.note,
        }));
      } catch (err) { return json({ error: String(err.message ?? err) }, 500); }
      finally { scanning = false; }
    }

    if (pathname === "/api/engine/live")
      return json(liveStatus());

    if (pathname === "/api/config")
      return json({ decompose: DEC_URLS.length > 0, model: DEC_MODEL });

    if (pathname === "/healthz") return new Response("ok", { status: 200 });
    /* Status of the local engines, and manual shutdown to free memory. */
    if (pathname === "/api/engines") {
      const { kevStatus, stopKev } = await import("./platform/kev-process.js");
      const { stopLaya } = await import("./platform/laya.js");
      if (req.method === "POST") {
        stopKev("requested from the dashboard"); stopLaya();
        return Response.json({ stopped: true, kev: kevStatus() });
      }
      return Response.json({ kev: kevStatus() });
    }

    if (pathname === "/api/scheduler")
      return Response.json(SCHED ? SCHED.status() : { disabled: true });

    // Static files. Path is resolved against public/ and cannot escape it.
    // The root is the platform: the console stays reachable at /console.
    const rel = pathname === "/" ? "/jevknows.html"
      : pathname === "/console" ? "/index.html"
      : pathname;
    if (rel.includes("..")) return new Response("Not found", { status: 404 });
    const file = Bun.file(`public${rel}`);
    if (!(await file.exists())) return new Response("Not found", { status: 404 });
    // html/css/js change on every edit: no cache, or the user sees the old
    // version and has to guess that a hard refresh is needed.
    const cacheable = /\.(svg|png|woff2?|ico)$/.test(rel);
    return new Response(file, {
      headers: { "Cache-Control": cacheable ? "public, max-age=3600" : "no-cache" },
    });
  },
});

console.log(`jevoracle listening on http://localhost:${server.port}`);
console.log(DEC_URLS.length
  ? `decomposition via ${DEC_URLS[0]} using ${DEC_MODEL}`
  : `decomposition disabled (set DECOMPOSE_URL to enable)`);
