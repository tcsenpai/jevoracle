/* A bot's metrics.
 *
 * The problem these functions solve: P&L on a handful of predictions is
 * noise, and markets take weeks to resolve. We need readable numbers BEFORE
 * the results come in, without passing them off as proof.
 *
 * Rule that runs through the whole file: if a number is not yet computable,
 * return null, not zero. A fake zero on the dashboard is worse than an
 * honest "I don't know".
 */
import { brier, calibration, kelly, pnl } from "../engine/scoring.js";
export { brier, calibration, kelly, pnl };

const mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

/**
 * How often the bot abstained, and whether it did so when poorly informed.
 *
 * `rule` decides which of the two rules is being measured. Counting any row
 * with gated OR ungated as "bet" would make the gate's abstention invisible,
 * which is exactly the thing we want to measure.
 */
export function abstention(rows, rule = "gated") {
  if (!rows.length) return null;
  const took = r => rule === "ungated" ? !!r.ungated : !!r.gated;
  const bet = rows.filter(took);
  const passed = rows.filter(r => !took(r));
  return {
    rule,
    seen: rows.length,
    bet: bet.length,
    passed: passed.length,
    rate: passed.length / rows.length,
    // the point: when it abstained, was it really less informed?
    evidenceWhenBet: mean(bet.map(r => r.evidence).filter(x => x != null)),
    evidenceWhenPassed: mean(passed.map(r => r.evidence).filter(x => x != null)),
  };
}

/**
 * The independent signal the Skeptic asked for: does self-declared evidence
 * actually predict the error?
 *
 * Compares absolute error (|jev - outcome|) on high-evidence predictions
 * against low-evidence ones. If the difference is roughly zero, evidence is
 * noise and should not be used as a gate. Requires SETTLED predictions:
 * before that it returns null, because there is nothing to measure against.
 */
export function evidenceValidity(rows, split = 0.5) {
  const settled = rows.filter(r => r.outcome === 0 || r.outcome === 1);
  const withEv = settled.filter(r => r.evidence != null);
  if (withEv.length < 8) return { usable: false, n: withEv.length, need: 8 };

  const err = r => Math.abs(r.jev - r.outcome);
  const hi = withEv.filter(r => r.evidence >= split);
  const lo = withEv.filter(r => r.evidence < split);
  if (!hi.length || !lo.length) return { usable: false, n: withEv.length, reason: "all rows on one side of the split" };

  const errHi = mean(hi.map(err)), errLo = mean(lo.map(err));
  return {
    usable: true, n: withEv.length, split,
    hi: { n: hi.length, meanError: errHi },
    lo: { n: lo.length, meanError: errLo },
    // positive = high evidence errs less, i.e. the signal is worth something
    separation: errLo - errHi,
  };
}

/** Jev against the crowd on the same markets. The only question that really matters. */
export function versusCrowd(rows) {
  const settled = rows.filter(r => r.outcome === 0 || r.outcome === 1);
  if (!settled.length) return null;
  const bJev = brier(settled.map(r => ({ p: r.jev, outcome: r.outcome })));
  const bCrowd = brier(settled.map(r => ({ p: r.crowd, outcome: r.outcome })));
  return {
    n: settled.length, brierJev: bJev, brierCrowd: bCrowd,
    // negative = Jev beats the crowd
    delta: bJev - bCrowd,
    beats: bJev < bCrowd,
  };
}

/**
 * A bot's summary, split into two explicit blocks:
 *   leading  = readable right away, NOT evidence of performance
 *   settled  = requires resolved markets, is the only thing that proves anything
 */
/**
 * Status of still-open bets: how much is committed and when it will be known.
 * `nextClose` is the nearest upcoming deadline; `dueNow` counts the ones
 * already past due, which should close at the next outcome check.
 */
function openPositions(open) {
  // Only the prudent rule actually commits the bankroll. `stake_ungated` is
  // the simulation of the other rule, recorded so the two can be compared:
  // adding it in would make bets the bot never placed look like "money in play".
  const bet = open.filter(r => r.gated);
  const staked = bet.reduce((a, r) => a + (r.stake_gated ?? 0), 0);
  const dates = bet.map(r => r.end_date).filter(Boolean).sort();
  const today = new Date().toISOString().slice(0, 10);
  return {
    stakedOpen: bet.length ? staked : 0,
    openBets: bet.length,
    nextClose: dates[0] ?? null,
    dueNow: dates.filter(d => d.slice(0, 10) <= today).length,
    // how many the free rule would have opened: for comparison purposes only
    wouldHaveBet: open.filter(r => r.ungated && !r.gated).length,
  };
}

export function botSummary(rows) {
  const settled = rows.filter(r => r.outcome === 0 || r.outcome === 1);
  const sum = f => rows.reduce((a, r) => a + (f(r) ?? 0), 0);

  return {
    leading: {
      predictions: rows.length,
      open: rows.length - settled.length,
      meanEvidence: mean(rows.map(r => r.evidence).filter(x => x != null)),
      meanAbsEdge: mean(rows.map(r => Math.abs(r.edge))),
      abstention: abstention(rows, "gated"),
      abstentionUngated: abstention(rows, "ungated"),
      models: [...new Set(rows.map(r => r.model).filter(Boolean))],
      // Virtual money committed and when it frees up. Without these two
      // numbers the P&L stays invisible until something closes, and the user
      // does not even know how long they have to wait.
      ...openPositions(rows.filter(r => r.outcome !== 0 && r.outcome !== 1)),
    },
    settled: {
      n: settled.length,
      versusCrowd: versusCrowd(rows),
      calibration: settled.length ? calibration(settled.map(r => ({ p: r.jev, outcome: r.outcome }))) : null,
      evidenceValidity: evidenceValidity(rows),
      pnlGated: settled.length ? sum(r => r.pnl_gated) : null,
      pnlUngated: settled.length ? sum(r => r.pnl_ungated) : null,
    },
    // how reliable the numbers above are, stated explicitly
    maturity: settled.length === 0 ? "no markets resolved yet, leading indicators only"
            : settled.length < 20 ? "too few results to conclude anything"
            : settled.length < 50 ? "indicative, not conclusive"
            : "enough for a first reading",
  };
}
