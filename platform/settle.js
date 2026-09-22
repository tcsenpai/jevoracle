/* Settle for platform bots.
 *
 * Replicates the logic already proven in engine/engine.js:settleOpen(), but
 * reads and writes to the multi-bot store (platform/store.js) instead of the
 * legacy db. No real money moves: it is paper trading, same as everything
 * else here.
 */
import { fetchEvent } from "../scripts/polymarket.js";
import { openPredictions, settlePrediction } from "./store.js";
import { pnl } from "../engine/scoring.js";

/**
 * Scans the open predictions (outcome IS NULL) of all bots, or just one bot
 * if opts.botId is set. For each one it queries Polymarket: if the market
 * shows as closed with a price at the edges, it settles the outcome and
 * computes P&L separately for the gated rule and the ungated one. If
 * Polymarket does not yet have an outcome, or the answer is ambiguous, the
 * prediction stays open: no outcome is ever invented.
 *
 * @param db   the platform db (bun:sqlite Database)
 * @param opts { botId }
 * @returns { checked, settled, stillOpen, results }
 */
export async function settleBots(db, opts = {}) {
  const open = openPredictions(db, opts.botId ?? null);
  let settled = 0;
  const results = [];

  for (const row of open) {
    let ev;
    try {
      ev = await fetchEvent(row.event_slug, { comments: 0 });
    } catch (err) {
      // a network error on a single market must not stop the whole pass
      results.push({
        id: row.id, bot_id: row.bot_id, market_label: row.market_label,
        status: "error", error: String(err.message ?? err),
      });
      continue;
    }

    const m = ev.markets.find(x => x.label === row.market_label);
    if (!m || !m.closed) {
      // the market is not yet resolved according to Polymarket: not an error
      results.push({
        id: row.id, bot_id: row.bot_id, market_label: row.market_label,
        status: "open",
      });
      continue;
    }

    // a closed market prices at the edges (0 or 1); that is the outcome.
    // if the price is not clean, the answer is ambiguous: nothing is invented.
    if (!(m.yes <= 0.02 || m.yes >= 0.98)) {
      results.push({
        id: row.id, bot_id: row.bot_id, market_label: row.market_label,
        status: "ambiguous", yes: m.yes,
      });
      continue;
    }

    const outcome = m.yes >= 0.5 ? 1 : 0;
    const pnlGated = pnl(row.side, row.stake_gated, row.crowd, outcome);
    const pnlUngated = pnl(row.side, row.stake_ungated, row.crowd, outcome);
    settlePrediction(db, row.id, outcome, pnlGated, pnlUngated);
    settled++;
    results.push({
      id: row.id, bot_id: row.bot_id, market_label: row.market_label,
      status: "settled", outcome, pnl_gated: pnlGated, pnl_ungated: pnlUngated,
    });
  }

  const stillOpen = results.filter(r => r.status === "open").length;
  return { checked: open.length, settled, stillOpen, results };
}
