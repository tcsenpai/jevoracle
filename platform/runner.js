/* The multi-bot runner.
 *
 * Replicates the scan() cycle from engine/engine.js but writes to the platform's
 * store (bot_id, bot_config_version, run_id) instead of the legacy db. No real
 * order execution: it is paper only, same as engine/engine.js.
 */
import { fetchEvent, pickMarket, toJevRequest } from "../scripts/polymarket.js";
import { candidates, DEFAULTS as ENGINE_DEFAULTS } from "../engine/engine.js";
import { newsFor } from "../engine/news.js";
import { applyFields } from "../engine/config.js";
import { assertSafeRequest } from "./guards.js";
import { getBot, currentConfig, startRun, finishRun, insertPrediction } from "./store.js";
import { kelly } from "../engine/scoring.js";
import { askLaya, DEFAULT_LAYA_MODEL } from "./laya.js";
import { askKev } from "./kev.js";
import { askQuorum } from "./quorum.js";

const iso = () => new Date().toISOString();

/* ---------- choice of judgment engine ----------
 *
 * Per-bot config: cfg.context.engine = { name: "jev" | "laya" | "kev" | "quorum", ... }.
 * Lives inside "context" (not a new column in the schema: store.js serializes
 * context as-is, so this lever requires no migration). A bot without the
 * "engine" field (every bot that exists today) uses Jev alone, exactly as
 * before: this is the absolute default, non-negotiable.
 */
/* Default: a three-way quorum weighted 3.1 / 1 / 2 out of 6.1 total.
 *
 * The weights are not arbitrary, they come from a comparison measured on
 * 2026-09-21 on real markets: Jev is the closest to consensus and the most
 * stable across repeated runs, Kev sits in the middle, Laya swings wildly on
 * some inputs and not on others (input-dependent, hence unpredictable).
 *
 * The 3.1 instead of 3 is deliberate: with 3 buckets a Laya+Kev coalition
 * would tie Jev (3 against 3) and would need a separate tiebreak rule. With
 * 3.1, Jev wins by construction against any coalition, and the rule "Jev
 * wins on a tie" is already baked into the numbers instead of living in a
 * separate branch of code. Jev can still be outweighed by raising the other
 * weights in configuration.
 */
export const DEFAULT_ENGINE = {
  name: "quorum",
  engines: ["jev", "laya", "kev"],
  weights: { jev: 3.1, laya: 1, kev: 2 },
  model: "router", device: "auto",
};

/** The single engine, for when you want one answer with no quorum. */
export const JEV_ONLY = { name: "jev", model: "router", device: "auto" };

function resolveEngine(cfg) {
  const e = cfg.context?.engine;
  if (!e || typeof e !== "object" || !e.name) return DEFAULT_ENGINE;
  return { ...DEFAULT_ENGINE, ...e };
}

/** Common adapter: every engine returns { answers, ms, model }. */
async function askEngine(engineCfg, request, key) {
  const name = engineCfg?.name ?? DEFAULT_ENGINE.name;

  if (name === "jev") {
    const out = await askJev(request, key);
    return { answers: out.data.answers, ms: out.data._ms ?? out.ms, model: out.data.model ?? null };
  }

  if (name === "kev") {
    return askKev(request, { url: engineCfg?.url, timeoutMs: engineCfg?.timeoutMs });
  }

  if (name === "laya") {
    // Laya has no HTTP API: it runs via a persistent Python process
    // (platform/laya.js -> platform/laya_bridge.py). Same contract as the
    // other engines: { answers, ms, model }. The context budget check (Laya's
    // real constraint: 512/1024 tokens against real states that today reach
    // ~1050) happens inside the bridge, with an explicit error if the state
    // does not fit: never a silent truncation.
    return askLaya(request.state, request.questions, {
      model: engineCfg?.model ?? DEFAULT_LAYA_MODEL,
      device: engineCfg?.device ?? "auto",
      timeoutMs: engineCfg?.timeoutMs,
    });
  }

  if (name === "quorum") {
    const engines = {};
    const wanted = Array.isArray(engineCfg?.engines) && engineCfg.engines.length
      ? engineCfg.engines : ["jev", "laya", "kev"]; // default: all three, none excluded a priori
    for (const n of wanted) {
      if (n === "jev") engines.jev = req => askEngine({ name: "jev" }, req, key);
      // Kev starts on demand: the measured warm-up is around 50s, so the
      // timeout needs to be generous or the quorum discards it right while
      // it is starting up. From the second request onward it responds in a
      // couple of seconds.
      else if (n === "kev") engines.kev = req => askKev(req, {
        url: engineCfg?.kevUrl, timeoutMs: engineCfg?.kevTimeoutMs ?? 240_000,
      });
      else if (n === "laya") engines.laya = req => askLaya(req.state, req.questions, {
        model: engineCfg?.layaModel ?? DEFAULT_LAYA_MODEL, device: engineCfg?.layaDevice ?? "auto",
      });
      else throw new Error(`unknown engine in quorum: "${n}"`);
    }
    const q = await askQuorum(request, { engines, rule: engineCfg?.rule, weights: engineCfg?.weights });
    return {
      answers: q.answers, ms: q.ms,
      model: `quorum(${q.engines_used.join("+")})`,
      quorum: q, // carried downstream for traceability (engine_votes)
    };
  }

  throw new Error(`unknown judgment engine: "${name}". Valid values: jev, laya, kev, quorum.`);
}

// Every call to Jev has a cost: 10 markets is the prudent limit per run until
// there is an explicit reason to raise it (scheduler, user request, etc).
const DEFAULT_MAX_MARKETS = 10;

/* Default maximum horizon, in days. Founder's choice: "I want the money easy
 * and close." A market closing in 250 days ties up the bankroll for eight
 * months and produces no feedback in the meantime: without markets closing
 * there is no way to know if the bot is getting it right, and the whole
 * platform exists to find that out. Overridden per bot via
 * thresholds.maxHorizonDays (0 or null removes the limit). */
const DEFAULT_MAX_HORIZON_DAYS = 7;

/**
 * The Jev plan is free but rate-limited by call count: it is not a spending
 * constraint, it is a request-count constraint. The quorum, if it includes
 * Jev, burns through it faster (one Jev call per quorum question).
 * Distinguishing "quota exhausted" from "network error" or "service down"
 * helps whoever reads the log decide whether to wait, retry, or whether it is
 * a TypeSafe server problem.
 */
/* 503 and 529 are temporary overload on the service side, not a fault of
 * ours: actually observed, 2 times out of 7 predictions. Without a retry the
 * quorum loses exactly the engine that weighs the most and decides without
 * it, which is worse than waiting two seconds. A single retry: if the
 * service is really down, insisting does not help and the quorum degrades by
 * declaring it. */
async function askJev(request, key, attempt = 0) {
  const t0 = Date.now();
  let res;
  try {
    res = await fetch("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(60000),
    });
  } catch (err) {
    const e = new Error(`Jev unreachable (network error): ${err.message ?? err}`);
    e.jevReason = "network";
    throw e;
  }
  if (res.status === 429) {
    const e = new Error(
      "Jev rejected the request: call quota exhausted (429). " +
      "The plan is free but limited by number of requests, not spend: " +
      "wait for the quota to reset or reduce the number of calls (e.g. in a quorum, exclude Jev).");
    e.jevReason = "quota";
    throw e;
  }
  if ((res.status === 503 || res.status === 529) && attempt === 0) {
    await new Promise(r => setTimeout(r, 2000));
    return askJev(request, key, 1);
  }
  if (res.status >= 500) {
    const text = await res.text().catch(() => "");
    const e = new Error(`Jev unavailable (service down, ${res.status}): ${text.slice(0, 200)}`);
    e.jevReason = "down";
    throw e;
  }
  if (!res.ok) {
    const e = new Error(`TypeSafe ${res.status}: ${(await res.text()).slice(0, 200)}`);
    e.jevReason = "other";
    throw e;
  }
  return { data: await res.json(), ms: Date.now() - t0 };
}

/**
 * Runs one pass for a bot: scans candidate markets, asks Jev, records
 * predictions in the platform store.
 *
 * @param {number} botId
 * @param {"live"|"backrun"} mode
 * @param {object} opts  { maxMarkets, note, apiKey }
 */
export async function runBot(botId, mode = "live", opts = {}) {
  const { db, apiKey } = opts;
  if (!db) throw new Error("runBot requires the platform db (opts.db).");

  const bot = getBot(db, botId);
  if (!bot) throw new Error(`no bot with id ${botId}`);

  if (mode === "backrun") {
    throw new Error("backrun mode is not wired up yet: an honest error beats a fake run.");
  }
  if (mode !== "live") {
    throw new Error(`mode "${mode}" not supported: use "live".`);
  }

  if (bot.status !== "active") {
    throw new Error("the bot is paused: reactivate it before running it");
  }

  const cfg = currentConfig(db, botId);
  if (!cfg) throw new Error(`bot ${botId} has no configuration: create it again.`);

  const key = apiKey;
  if (!key) throw new Error("TYPESAFE_API_KEY is required to run a bot.");

  const t = { ...ENGINE_DEFAULTS, ...(cfg.thresholds ?? {}) };
  const maxMarkets = Number(opts.maxMarkets) > 0 ? Math.floor(Number(opts.maxMarkets)) : DEFAULT_MAX_MARKETS;
  // How many days out a market must close within to be worth it.
  // 0 or null disables the limit and reopens the whole horizon.
  const horizonRaw = t.maxHorizonDays ?? DEFAULT_MAX_HORIZON_DAYS;
  const maxHorizonDays = horizonRaw === null || Number(horizonRaw) <= 0
    ? null : Number(horizonRaw);

  const runId = startRun(db, {
    botId, configVersion: cfg.version, mode, note: opts.note ?? null,
  });

  let scanned = 0, asked = 0, recorded = 0;
  const results = [];
  let runError = null;

  try {
    /* With a short horizon the filter discards most candidates, so asking
     * for only `maxMarkets` means coming up empty: measured on the 60
     * most-traded events, only 13 close within 7 days. We fish a wider pool
     * and sort by nearest deadline, so the useful markets come first. The
     * cap on engine calls stays `maxMarkets`: we widen the search, not the
     * spend. */
    const pool = maxHorizonDays != null
      ? Math.max(maxMarkets * 5, 40)
      : Math.min(maxMarkets, t.scanLimit ?? maxMarkets);
    let evs = await candidates({
      limit: pool,
      minVolume: t.minVolume ?? ENGINE_DEFAULTS.minVolume,
    });
    if (maxHorizonDays != null) {
      const daysTo = e => {
        const d = e.endDate ?? e.end_date;
        return d ? (new Date(d) - Date.now()) / 86_400_000 : Infinity;
      };
      evs = evs
        .filter(e => daysTo(e) > 0 && daysTo(e) <= maxHorizonDays)
        .sort((a, b) => daysTo(a) - daysTo(b));
    }
    scanned = evs.length;

    const fields = cfg.context?.fields ?? {};
    const newsMax = cfg.context?.newsMax ?? ENGINE_DEFAULTS.newsMax;
    const newsWindow = cfg.context?.newsWindow ?? ENGINE_DEFAULTS.newsWindow;

    for (const raw of evs.slice(0, maxMarkets)) {
      let ev, market;
      try {
        ev = await fetchEvent(raw.slug, { comments: 25 });
        market = pickMarket(ev);
        if (!market) continue;
        // a price already at the edges leaves no room for meaningful disagreement
        if (market.yes <= 0.03 || market.yes >= 0.97) continue;
        // A market that has already expired but is not yet resolved is
        // stuck: the price no longer moves and the event has already
        // happened. Judging it measures nothing, and the bet would stay
        // open waiting for an outcome that depends only on when Polymarket
        // gets around to publishing it.
        const end = market.endDate ?? ev.endDate;
        if (end && new Date(end) <= new Date()) {
          results.push({ slug: raw.slug, market: market.label, skipped: "already expired" });
          continue;
        }
        // Maximum horizon. A market closing in two years ties up the
        // bankroll for two years and says nothing about how well the bot is
        // doing until it resolves: no feedback, no learning. Filtered here,
        // before querying the engines, so a call is not spent on a market
        // that would get discarded anyway.
        if (end && maxHorizonDays != null) {
          const days = Math.ceil((new Date(end) - Date.now()) / 86_400_000);
          if (days > maxHorizonDays) {
            results.push({ slug: raw.slug, market: market.label,
              skipped: `closes in ${days} days, past the ${maxHorizonDays}-day limit` });
            continue;
          }
        }
      } catch { continue; }

      let news = { items: [], count: 0, query: null };
      if (fields.recent_reporting !== false) {
        try { news = await newsFor(ev, market, { max: newsMax, timelimit: newsWindow }); }
        catch { /* ddgs rate-limits; degrade silently */ }
      }

      let answers, ms, request, modelId = null, engineVotes = null, engineWarning = null;
      try {
        ({ request } = toJevRequest(ev, { market, news: news.items }));
        // honor the config: drop the fields the user has turned off
        request = applyFields(request, fields);
        // invariant: the market price never enters the state, for ANY
        // engine, quorum included
        assertSafeRequest(request);
        const out = await askEngine(resolveEngine(cfg), request, key);
        answers = out.answers; ms = out.ms; modelId = out.model ?? null;
        if (out.quorum) {
          engineVotes = out.quorum.engine_votes;
          engineWarning = out.quorum.warning ?? null;
        }
        asked++;
      } catch (err) {
        results.push({ slug: raw.slug, error: String(err.message ?? err) });
        continue;
      }

      const p = answers.verdict.noul;
      const crowd = market.yes;
      const edge = p - crowd;
      const evidence = answers.evidence_sufficient?.noul ?? null;

      const minEdge = t.minEdge ?? ENGINE_DEFAULTS.minEdge;
      const minEvidence = t.minEvidence ?? ENGINE_DEFAULTS.minEvidence;
      const ungated = Math.abs(edge) >= minEdge;
      const gated = ungated && (evidence ?? 0) >= minEvidence;

      const f = kelly(p, crowd, {
        fraction: t.kellyFraction ?? ENGINE_DEFAULTS.kellyFraction,
        cap: t.maxStakeFraction ?? ENGINE_DEFAULTS.maxStakeFraction,
      });
      const side = f >= 0 ? "YES" : "NO";
      const stake = Math.abs(f) * (bot.bankroll ?? ENGINE_DEFAULTS.bankroll);

      const row = {
        run_id: runId, bot_id: botId, bot_config_version: cfg.version,
        event_slug: ev.slug, event_title: ev.title, market_label: market.label,
        condition_id: market.conditionId ?? null, token_id: market.tokenId ?? null,
        end_date: market.endDate ?? ev.endDate,
        crowd, jev: p, edge, evidence,
        rules_strict: answers.rules_are_strict?.score ?? null,
        ambiguity: answers.ambiguity?.choice ?? null,
        gated, ungated, side,
        stake_gated: gated ? stake : 0,
        stake_ungated: ungated ? stake : 0,
        model: modelId, state_snapshot: request, answers,
        latency_ms: ms, news_count: news.count,
        engine_votes: engineVotes, engine_warning: engineWarning,
      };
      insertPrediction(db, row); recorded++;
      results.push({
        slug: ev.slug, market: market.label, crowd, jev: p, edge, evidence,
        gated, ungated, side, stake,
      });
    }
  } catch (err) {
    runError = String(err.message ?? err);
    throw err;
  } finally {
    finishRun(db, runId, { scanned, asked, recorded, error: runError });
  }

  return { runId, scanned, asked, recorded, results };
}
