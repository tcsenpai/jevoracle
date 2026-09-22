/* The scheduler: checks on its own whether markets have resolved.
 *
 * Why it exists: a bet closes when Polymarket publishes the outcome, which
 * does not coincide with the market's expiry and can arrive days later.
 * Without an automatic check the results only show up when someone remembers
 * to press a button, and the P&L stays empty for weeks.
 *
 * What it does NOT do: it does not start bot runs. A run spends calls to
 * Jev, and launching them automatically on a timer is a spending decision
 * that belongs to the owner. It only spends against Polymarket here, which
 * is free.
 */
import { settleBots } from "./settle.js";

export const DEFAULT_INTERVAL_MS = 15 * 60_000;

/**
 * Starts the periodic outcome check.
 * @returns {{stop: () => void, status: () => object}}
 */
export function startScheduler(db, { intervalMs = DEFAULT_INTERVAL_MS, log = console.log } = {}) {
  let running = false;          // one pass at a time: two settle passes in parallel on the
                                 // same markets would step on each other for no gain
  let last = null;
  let timer = null;

  async function tick() {
    if (running) return;
    running = true;
    const started = Date.now();
    try {
      const r = await settleBots(db);
      last = { at: new Date().toISOString(), ok: true, ...r, ms: Date.now() - started };
      // log only when something actually happened: a log every 15 minutes saying
      // "nothing new" makes the thing that matters invisible
      if (r.settled) log(`[scheduler] ${r.settled} bets closed out of ${r.checked} checked`);
    } catch (err) {
      last = { at: new Date().toISOString(), ok: false, error: String(err.message ?? err),
               ms: Date.now() - started };
      log(`[scheduler] outcome check failed: ${last.error}`);
    } finally {
      running = false;
    }
  }

  timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === "function") timer.unref();  // do not keep the process alive
  tick();                                                 // do a first pass right away

  return {
    stop() { clearInterval(timer); timer = null; },
    status: () => ({ intervalMs, running, last }),
  };
}
