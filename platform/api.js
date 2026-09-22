/* Platform HTTP routes. The contract the dashboard consumes.
 * Separated from server.js to keep the platform's routing distinct from the
 * console, which by now is a page for tinkering. */
import {
  openDB, createBot, listBots, getBot, setBotStatus, setBankroll,
  currentConfig, putConfig, configHistory,
  listRuns, botPredictions, botOpinions,
} from "./store.js";
import { botSummary } from "./metrics.js";
import { normaliseAssistant, DEFAULT_ASSISTANT } from "./assistant.js";
import { normaliseEngine } from "./laya.js";
import { settleBots } from "./settle.js";

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
});

const QUORUM_MEMBERS = ["jev", "laya", "kev"];

/**
 * Completes normaliseEngine() from laya.js for the engines it does not know
 * yet: "kev" (optional URL/timeout) and "quorum" (list of engines, rule,
 * weights). Does not duplicate the validation for jev/laya, already done
 * upstream. Throws on inconsistent input: an explicit 400 is better than a
 * quorum that silently ignores a malformed request.
 */
function normaliseKevOrQuorum(engine) {
  if (!engine || typeof engine !== "object") return engine;

  if (engine.name === "kev") {
    const out = { ...engine };
    if (out.url !== undefined && typeof out.url !== "string") {
      throw new Error("engine.url must be a string (the Kev server URL).");
    }
    if (out.timeoutMs !== undefined && !(Number(out.timeoutMs) > 0)) {
      throw new Error("engine.timeoutMs must be a positive number.");
    }
    return out;
  }

  if (engine.name === "quorum") {
    const out = { ...engine };
    if (out.engines !== undefined) {
      if (!Array.isArray(out.engines) || !out.engines.length) {
        throw new Error("engine.engines must be a non-empty array of engine names.");
      }
      for (const n of out.engines) {
        if (!QUORUM_MEMBERS.includes(n)) {
          throw new Error(`engine.engines contains an unknown engine: "${n}". Valid: ${QUORUM_MEMBERS.join(", ")}.`);
        }
      }
    }
    if (out.rule?.noul !== undefined && !["median", "mean"].includes(out.rule.noul)) {
      throw new Error(`engine.rule.noul must be "median" or "mean", not "${out.rule.noul}".`);
    }
    if (out.weights !== undefined) {
      if (typeof out.weights !== "object" || Array.isArray(out.weights)) {
        throw new Error("engine.weights must be an object { engineName: weight }.");
      }
      for (const [k, w] of Object.entries(out.weights)) {
        if (!(Number(w) > 0)) throw new Error(`engine.weights.${k} must be a positive number.`);
      }
    }
    return out;
  }

  return engine;
}

export const DEFAULT_THRESHOLDS = {
  minEdge: 0.08, minEvidence: 0.5, minVolume: 50_000,
  kellyFraction: 0.25, maxStakeFraction: 0.05, scanLimit: 8,
};
export const DEFAULT_CONTEXT = {
  fields: {
    resolution_rules: true, window: true, subject_area: true,
    resolution_source: true, recent_reporting: true, trader_notes: true,
  },
  newsMax: 6, newsWindow: "w",
  sideAssistant: DEFAULT_ASSISTANT,
};

async function body(req, cap = 256 * 1024) {
  const text = await req.text();
  if (text.length > cap) throw new Error("request body too large");
  return text ? JSON.parse(text) : {};
}

/**
 * @param deps.runBot  (botId, mode) => Promise, starts a run. Injected so
 *                     the routes stay testable without touching the network.
 */
export function platformRoutes(db, deps = {}) {
  return async function handle(req, pathname) {
    if (!pathname.startsWith("/api/bots")) return null;

    const rest = pathname.slice("/api/bots".length);      // "" | "/3" | "/3/config"
    const parts = rest.split("/").filter(Boolean);
    const id = parts[0] ? Number(parts[0]) : null;
    const action = parts[1] ?? null;

    /* GET /api/bots */
    if (!parts.length && req.method === "GET") {
      const bots = listBots(db).map(b => ({
        ...b,
        metrics: botSummary(botPredictions(db, b.id, 500)),
      }));
      return json({ bots, defaults: { context: DEFAULT_CONTEXT, thresholds: DEFAULT_THRESHOLDS } });
    }

    /* POST /api/bots */
    if (!parts.length && req.method === "POST") {
      let b;
      try { b = await body(req); } catch (e) { return json({ error: String(e.message) }, 400); }
      const name = String(b.name ?? "").trim();
      if (!name) return json({ error: "a name is required" }, 400);
      if (listBots(db).some(x => x.name === name)) return json({ error: `a bot named "${name}" already exists` }, 409);
      let engine;
      if (b.context?.engine !== undefined) {
        try { engine = normaliseKevOrQuorum(normaliseEngine(b.context.engine)); }
        catch (e) { return json({ error: String(e.message ?? e) }, 400); }
      }
      try {
        const botId = createBot(db, {
          name, blurb: b.blurb ?? null, bankroll: Number(b.bankroll) || 1000,
          context: { ...DEFAULT_CONTEXT, ...(b.context ?? {}),
                     sideAssistant: normaliseAssistant(b.context?.sideAssistant),
                     ...(engine !== undefined ? { engine } : {}) },
          thresholds: { ...DEFAULT_THRESHOLDS, ...(b.thresholds ?? {}) },
        });
        return json({ id: botId, bot: getBot(db, botId) }, 201);
      } catch (e) { return json({ error: String(e.message ?? e) }, 500); }
    }

    if (!Number.isInteger(id)) return json({ error: "invalid id" }, 400);
    const bot = getBot(db, id);
    if (!bot) return json({ error: `no bot with id ${id}` }, 404);

    /* GET /api/bots/:id */
    if (!action && req.method === "GET") {
      const predictions = botPredictions(db, id, 300);
      return json({
        bot,
        config: currentConfig(db, id),
        configHistory: configHistory(db, id),
        metrics: botSummary(predictions),
        predictions,
        runs: listRuns(db, id, 50),
        opinions: botOpinions(db, id, 100),
      });
    }

    /* POST /api/bots/:id/config  -> new version, never an overwrite */
    if (action === "config" && req.method === "POST") {
      let b;
      try { b = await body(req); } catch (e) { return json({ error: String(e.message) }, 400); }
      const prev = currentConfig(db, id);
      const context = { ...(prev?.context ?? DEFAULT_CONTEXT), ...(b.context ?? {}) };
      context.sideAssistant = normaliseAssistant(context.sideAssistant);
      // resolution rules cannot be turned off: without them there is no question
      context.fields = { ...(context.fields ?? {}), resolution_rules: true };
      // judgment engine lever: absent or malformed falls back to "jev", never a crash
      if (context.engine !== undefined) {
        context.engine = normaliseEngine(context.engine);
        try { context.engine = normaliseKevOrQuorum(context.engine); }
        catch (e) { return json({ error: String(e.message ?? e) }, 400); }
      }
      const thresholds = { ...(prev?.thresholds ?? DEFAULT_THRESHOLDS), ...(b.thresholds ?? {}) };
      if (b.name || b.bankroll != null) {
        if (b.bankroll != null) setBankroll(db, id, Number(b.bankroll));
      }
      const version = putConfig(db, id, { context, thresholds, note: b.note ?? null });
      return json({ version, config: currentConfig(db, id) });
    }

    /* POST /api/bots/:id/status */
    if (action === "status" && req.method === "POST") {
      let b;
      try { b = await body(req); } catch (e) { return json({ error: String(e.message) }, 400); }
      if (!["active", "paused", "archived"].includes(b.status))
        return json({ error: "status must be active, paused or archived" }, 400);
      setBotStatus(db, id, b.status);
      return json({ bot: getBot(db, id) });
    }

    /* POST /api/bots/:id/run */
    if (action === "run" && req.method === "POST") {
      if (!deps.runBot) return json({ error: "execution is not available on this server" }, 503);
      let b = {};
      try { b = await body(req); } catch {}
      const mode = ["live", "backrun"].includes(b.mode) ? b.mode : "live";
      try { return json(await deps.runBot(id, mode, b)); }
      catch (e) { return json({ error: String(e.message ?? e) }, 500); }
    }

    /* POST /api/bots/:id/settle -> settles this bot's open predictions */
    if (action === "settle" && req.method === "POST") {
      try { return json(await settleBots(db, { botId: id })); }
      catch (e) { return json({ error: String(e.message ?? e) }, 500); }
    }

    return json({ error: `unsupported method or action: ${req.method} ${pathname}` }, 405);
  };
}

export { openDB };
