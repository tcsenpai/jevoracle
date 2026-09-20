/* Scoring and staking.
 *
 * A single good call proves nothing. These functions exist to turn a pile of
 * predictions into the only things that actually mean something: a Brier score
 * against the market's own Brier, and a calibration curve.
 */

/** Mean squared error of a probability forecast. Lower is better. 0.25 = coin flip. */
export const brier = rows =>
  rows.length ? rows.reduce((a, r) => a + (r.p - r.outcome) ** 2, 0) / rows.length : null;

/**
 * Kelly fraction for a binary market priced at `price`, believed to be `p`.
 * Returns a signed fraction of bankroll: positive means back YES, negative NO.
 * Always scaled down, because full Kelly on a mispriced belief is how you go broke.
 */
export function kelly(p, price, { fraction = 0.25, cap = 0.05 } = {}) {
  if (price <= 0 || price >= 1) return 0;
  // backing YES costs `price` and pays 1; backing NO costs `1-price` and pays 1
  const yes = (p - price) / (1 - price);
  const no = ((1 - p) - (1 - price)) / price;
  const raw = yes > no ? yes : -no;
  if (!Number.isFinite(raw) || raw <= 0 && raw >= 0) return 0;
  const scaled = raw * fraction;
  return Math.max(-cap, Math.min(cap, scaled));
}

/** Profit on a $1-per-share binary at settlement. */
export function pnl(side, stake, price, outcome) {
  if (!stake) return 0;
  const cost = side === "YES" ? price : 1 - price;
  if (cost <= 0) return 0;
  const shares = stake / cost;
  const won = side === "YES" ? outcome === 1 : outcome === 0;
  return won ? shares - stake : -stake;
}

/** Reliability curve: bucket forecasts and compare predicted vs realised frequency. */
export function calibration(rows, buckets = 5) {
  const out = [];
  for (let i = 0; i < buckets; i++) {
    const lo = i / buckets, hi = (i + 1) / buckets;
    const inBucket = rows.filter(r => r.p >= lo && (i === buckets - 1 ? r.p <= hi : r.p < hi));
    if (!inBucket.length) { out.push({ lo, hi, n: 0, predicted: null, actual: null }); continue; }
    out.push({
      lo, hi, n: inBucket.length,
      predicted: inBucket.reduce((a, r) => a + r.p, 0) / inBucket.length,
      actual: inBucket.reduce((a, r) => a + r.outcome, 0) / inBucket.length,
    });
  }
  return out;
}

/** Everything the dashboard needs, computed from settled rows only. */
export function summarise(all) {
  const settled = all.filter(r => r.outcome !== null && r.outcome !== undefined);
  const jevRows = settled.map(r => ({ p: r.jev, outcome: r.outcome }));
  const crowdRows = settled.map(r => ({ p: r.crowd, outcome: r.outcome }));

  const sum = (rows, f) => rows.reduce((a, r) => a + (f(r) ?? 0), 0);
  return {
    total: all.length,
    open: all.length - settled.length,
    settled: settled.length,
    brierJev: brier(jevRows),
    brierCrowd: brier(crowdRows),
    calibration: calibration(jevRows),
    pnlGated: sum(settled, r => r.pnl_gated),
    pnlUngated: sum(settled, r => r.pnl_ungated),
    betsGated: all.filter(r => r.gated).length,
    betsUngated: all.filter(r => r.ungated).length,
    // did the evidence gate actually help? this is the experiment's real question
    brierGated: brier(settled.filter(r => r.gated).map(r => ({ p: r.jev, outcome: r.outcome }))),
    brierUngatedOnly: brier(settled.filter(r => r.ungated && !r.gated).map(r => ({ p: r.jev, outcome: r.outcome }))),
  };
}
