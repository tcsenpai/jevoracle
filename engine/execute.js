/* Real-money execution. OFF by default, and deliberately awkward to turn on.
 *
 * There is no Polymarket testnet: pUSD is Polygon mainnet, backed by real USDC.
 * So this path spends real money the moment it is enabled. Four independent locks
 * have to be open before a single order is signed:
 *
 *   1. LIVE_TRADING=i-understand-this-spends-real-money   (exact string)
 *   2. POLYMARKET_PRIVATE_KEY set
 *   3. maxOrderUsd configured above zero
 *   4. the caller passes { confirm: true }
 *
 * Any one missing and this throws. Nothing here runs during a normal scan.
 */

export const LIVE_PHRASE = "i-understand-this-spends-real-money";

export function liveStatus(env = process.env) {
  const armed = env.LIVE_TRADING === LIVE_PHRASE;
  const hasKey = Boolean(env.POLYMARKET_PRIVATE_KEY);
  const cap = Number(env.MAX_ORDER_USD ?? 0);
  return {
    armed, hasKey, cap,
    ready: armed && hasKey && cap > 0,
    blockers: [
      !armed && `LIVE_TRADING must equal "${LIVE_PHRASE}"`,
      !hasKey && "POLYMARKET_PRIVATE_KEY is not set",
      !(cap > 0) && "MAX_ORDER_USD must be greater than 0",
    ].filter(Boolean),
  };
}

/**
 * Place an order. Throws unless every lock is open.
 *
 * Signing is intentionally NOT implemented here. Polymarket orders are EIP-712
 * signed structs submitted to the CLOB, and that code belongs in the official
 * SDK rather than hand-rolled in a public repo. Install @polymarket/clob-client
 * and complete the marked section if you decide to go live.
 */
export async function placeOrder(order, { confirm = false, env = process.env } = {}) {
  const status = liveStatus(env);
  if (!confirm) throw new Error("placeOrder requires { confirm: true }.");
  if (!status.ready) throw new Error(`Live trading is disabled: ${status.blockers.join("; ")}`);
  if (!(order.usd > 0)) throw new Error("Order size must be positive.");
  if (order.usd > status.cap) throw new Error(`Order $${order.usd} exceeds MAX_ORDER_USD ($${status.cap}).`);
  if (!order.tokenId) throw new Error("Order needs a CLOB tokenId.");

  throw new Error(
    "Execution is not wired up. Install @polymarket/clob-client, build and sign the " +
    "order in this function, and submit it to the CLOB. This repo ships the guard, " +
    "not the trigger."
  );
}
