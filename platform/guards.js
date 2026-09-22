/* Invariants on the state sent to Jev.
 *
 * Born from a defect found in a competing repo (marianimatteo-lexroom/poly-jev):
 * their build_state passes `market_yes_price` to Jev while the question
 * simultaneously says "Ignore the current market price". They ask the model
 * to ignore a piece of data they put right in front of it. If the model
 * looks at it, and there is no way to know, the number measures reading
 * ability, not judgment, and everything built on top of it is silently
 * invalidated.
 *
 * We do not pass it. But "we do not pass it" is a property of today's code,
 * not an invariant. This file turns it into an invariant: if a price enters
 * the state, the call fails before it starts.
 */

/** Field names whose name gives away a market price or probability. */
const PRICE_KEY = /(^|_)(price|yes_price|no_price|odds|implied|mid|bid|ask|spread|last_trade|market_prob)($|_)/i;

/** A number between 0 and 1 in a suspiciously named field is almost certainly the price. */
const looksLikeProbability = v => typeof v === "number" && v > 0 && v < 1;

/**
 * Recursively searches the state for a leaked market price.
 * Returns the list of offending paths, empty if clean.
 */
export function findLeakedPrice(state, path = "state") {
  const hits = [];
  if (state == null) return hits;

  if (Array.isArray(state)) {
    state.forEach((v, i) => hits.push(...findLeakedPrice(v, `${path}[${i}]`)));
    return hits;
  }
  if (typeof state !== "object") return hits;

  for (const [k, v] of Object.entries(state)) {
    const here = `${path}.${k}`;
    if (PRICE_KEY.test(k)) {
      // a suspicious name holding a probability-shaped number is a leak
      if (looksLikeProbability(v)) hits.push(here);
      else if (typeof v === "string" && /^0?\.\d+$|^\d{1,3}\s?%$/.test(v.trim())) hits.push(here);
      else hits.push(here);   // suspicious name: flagged regardless, decided upstream
    }
    if (v && typeof v === "object") hits.push(...findLeakedPrice(v, here));
  }
  return hits;
}

/**
 * Call before every request to Jev.
 * Throws if the state contains the market price.
 */
export function assertNoPriceLeak(state) {
  const hits = findLeakedPrice(state);
  if (hits.length) {
    throw new Error(
      `The market price cannot enter the state sent to Jev. ` +
      `Suspect fields: ${hits.join(", ")}. ` +
      `If Jev sees the price, the comparison measures whether it can read a number, not whether it can judge.`);
  }
  return true;
}

/** Jev's context budget, verified against the docs: 64k for state plus questions. */
export const CONTEXT_BUDGET = 64_000;

export function assertWithinBudget(request) {
  const size = JSON.stringify(request).length;
  // conservative estimate at 4 characters per token
  const tokens = Math.ceil(size / 4);
  if (tokens > CONTEXT_BUDGET) {
    throw new Error(`Request is about ${tokens} tokens, over the ${CONTEXT_BUDGET} budget.`);
  }
  return { chars: size, approxTokens: tokens };
}

/** Single check before sending. */
export function assertSafeRequest(request) {
  assertNoPriceLeak(request.state);
  return assertWithinBudget(request);
}
