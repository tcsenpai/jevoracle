/* Route HTTP della piattaforma. Il contratto che la dashboard consuma.
 * Separato da server.js per tenere il routing della piattaforma distinto
 * dalla console, che ormai e' una pagina di svago. */
import {
  openDB, createBot, listBots, getBot, setBotStatus, setBankroll,
  currentConfig, putConfig, configHistory,
  listRuns, botPredictions, botOpinions,
} from "./store.js";
import { botSummary } from "./metrics.js";
import { normaliseAssistant, DEFAULT_ASSISTANT } from "./assistant.js";

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
});

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
  if (text.length > cap) throw new Error("corpo della richiesta troppo grande");
  return text ? JSON.parse(text) : {};
}

/**
 * @param deps.runBot  (botId, mode) => Promise, avvia una run. Iniettata cosi'
 *                     le route restano testabili senza toccare la rete.
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
      if (!name) return json({ error: "serve un nome" }, 400);
      if (listBots(db).some(x => x.name === name)) return json({ error: `esiste gia' un bot chiamato "${name}"` }, 409);
      try {
        const botId = createBot(db, {
          name, blurb: b.blurb ?? null, bankroll: Number(b.bankroll) || 1000,
          context: { ...DEFAULT_CONTEXT, ...(b.context ?? {}),
                     sideAssistant: normaliseAssistant(b.context?.sideAssistant) },
          thresholds: { ...DEFAULT_THRESHOLDS, ...(b.thresholds ?? {}) },
        });
        return json({ id: botId, bot: getBot(db, botId) }, 201);
      } catch (e) { return json({ error: String(e.message ?? e) }, 500); }
    }

    if (!Number.isInteger(id)) return json({ error: "id non valido" }, 400);
    const bot = getBot(db, id);
    if (!bot) return json({ error: `nessun bot con id ${id}` }, 404);

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

    /* POST /api/bots/:id/config  -> nuova versione, mai un overwrite */
    if (action === "config" && req.method === "POST") {
      let b;
      try { b = await body(req); } catch (e) { return json({ error: String(e.message) }, 400); }
      const prev = currentConfig(db, id);
      const context = { ...(prev?.context ?? DEFAULT_CONTEXT), ...(b.context ?? {}) };
      context.sideAssistant = normaliseAssistant(context.sideAssistant);
      // le regole di risoluzione non si possono spegnere: senza, non c'e' domanda
      context.fields = { ...(context.fields ?? {}), resolution_rules: true };
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
        return json({ error: "status deve essere active, paused o archived" }, 400);
      setBotStatus(db, id, b.status);
      return json({ bot: getBot(db, id) });
    }

    /* POST /api/bots/:id/run */
    if (action === "run" && req.method === "POST") {
      if (!deps.runBot) return json({ error: "esecuzione non disponibile su questo server" }, 503);
      let b = {};
      try { b = await body(req); } catch {}
      const mode = ["live", "backrun"].includes(b.mode) ? b.mode : "live";
      try { return json(await deps.runBot(id, mode, b)); }
      catch (e) { return json({ error: String(e.message ?? e) }, 500); }
    }

    return json({ error: `metodo o azione non supportati: ${req.method} ${pathname}` }, 405);
  };
}

export { openDB };
