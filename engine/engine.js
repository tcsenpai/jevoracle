/* The paper-trading loop.
 *
 * scan()   pick live markets, ask Jev, freeze the crowd price, record a prediction
 * settle() find markets that resolved and score what we said about them
 *
 * No money moves. Execution lives in execute.js and is off unless you turn it on.
 */
import { fetchEvent, pickMarket, toJevRequest } from "../scripts/polymarket.js";
import { openStore, insertPrediction, openPredictions, allPredictions, settle } from "./store.js";
import { kelly, pnl, summarise } from "./scoring.js";

const GAMMA = "https://gamma-api.polymarket.com";

export const DEFAULTS = {
  bankroll: 1000,
  minEdge: 0.08,        // below ~8pt the gap is inside the noise of a single judgment
  minEvidence: 0.5,     // Jev's own "do I have enough to go on"
  minVolume: 50000,     // thin markets have meaningless prices
  kellyFraction: 0.25,
  maxStakeFraction: 0.05,
};

const iso = () => new Date().toISOString();

async function jev(request, key) {
  const t0 = Date.now();
  const res = await fetch("https://api.typesafe.ai/v1/systemone", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`TypeSafe ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return { data: await res.json(), ms: Date.now() - t0 };
}

/** Candidate markets: liquid, genuinely uncertain, and not about to close. */
export async function candidates({ limit = 20, minVolume = DEFAULTS.minVolume } = {}) {
  const res = await fetch(
    `${GAMMA}/events?limit=${limit * 4}&order=volume24hr&ascending=false&closed=false&active=true`,
    { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Polymarket ${res.status}`);
  const events = await res.json();
  return events
    .filter(e => Number(e.volume ?? 0) >= minVolume)
    .filter(e => (e.markets ?? []).length > 0)
    .slice(0, limit);
}

export async function scan(opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const db = opts.db ?? openStore(cfg.dbPath);
  const key = cfg.apiKey;
  if (!key) throw new Error("TYPESAFE_API_KEY is required to scan.");

  const run = db.prepare("INSERT INTO runs (started_at,note) VALUES (?,?)")
    .run(iso(), opts.note ?? null);
  const evs = await candidates(cfg);
  let asked = 0, recorded = 0;
  const results = [];

  for (const raw of evs) {
    let ev, market;
    try {
      ev = await fetchEvent(raw.slug, { comments: 25 });
      market = pickMarket(ev);
      if (!market) continue;
      // a price already at the rails has no room for a disagreement to mean anything
      if (market.yes <= 0.03 || market.yes >= 0.97) continue;
    } catch { continue; }

    let answers, ms, request;
    try {
      ({ request } = toJevRequest(ev, { market }));
      const out = await jev(request, key);
      answers = out.data.answers; ms = out.data._ms ?? out.ms; asked++;
    } catch (err) { results.push({ slug: raw.slug, error: String(err.message ?? err) }); continue; }

    const p = answers.verdict.noul;
    const crowd = market.yes;
    const edge = p - crowd;
    const evidence = answers.evidence_sufficient?.noul ?? null;

    // Two rules, recorded side by side, so the evidence gate can be judged later.
    const ungated = Math.abs(edge) >= cfg.minEdge;
    const gated = ungated && (evidence ?? 0) >= cfg.minEvidence;

    const f = kelly(p, crowd, { fraction: cfg.kellyFraction, cap: cfg.maxStakeFraction });
    const side = f >= 0 ? "YES" : "NO";
    const stake = Math.abs(f) * cfg.bankroll;

    const row = {
      created_at: iso(),
      event_slug: ev.slug, event_title: ev.title, market_label: market.label,
      condition_id: market.conditionId ?? null, token_id: market.tokenId ?? null,
      end_date: market.endDate ?? ev.endDate,
      crowd, jev: p, edge, evidence,
      rules_strict: answers.rules_are_strict?.score ?? null,
      ambiguity: answers.ambiguity?.choice ?? null,
      gated, ungated, side,
      stake_gated: gated ? stake : 0,
      stake_ungated: ungated ? stake : 0,
      request, answers, latency_ms: ms,
    };
    insertPrediction(db, row); recorded++;
    results.push({ slug: ev.slug, market: market.label, crowd, jev: p, edge, evidence, gated, ungated, side, stake });
  }

  db.prepare("UPDATE runs SET scanned=?, asked=?, recorded=? WHERE id=?")
    .run(evs.length, asked, recorded, run.lastInsertRowid);
  return { scanned: evs.length, asked, recorded, results };
}

/** Score every open prediction whose market has since resolved. */
export async function settleOpen(opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const db = opts.db ?? openStore(cfg.dbPath);
  const open = openPredictions(db);
  let done = 0;

  for (const row of open) {
    let ev;
    try { ev = await fetchEvent(row.event_slug, { comments: 0 }); } catch { continue; }
    const m = ev.markets.find(x => x.label === row.market_label);
    if (!m || !m.closed) continue;

    // a closed market prices at the rails; that is the outcome
    const outcome = m.yes >= 0.5 ? 1 : 0;
    const g = pnl(row.side, row.stake_gated, row.crowd, outcome);
    const u = pnl(row.side, row.stake_ungated, row.crowd, outcome);
    settle(db, row.id, outcome, g, u);
    done++;
  }
  return { checked: open.length, settled: done };
}

export function report(opts = {}) {
  const db = opts.db ?? openStore(opts.dbPath);
  return { ...summarise(allPredictions(db, 2000)), rows: allPredictions(db, 200) };
}
