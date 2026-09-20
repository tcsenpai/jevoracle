/* Build a Jev request from a Polymarket event.
 *
 * Polymarket publishes a free read-only API (no key), so this reads that rather
 * than scraping the page. The point of the exercise: Polymarket gives you a crowd
 * probability, Jev gives you a judgment over the same written evidence. Comparing
 * them is only meaningful if Jev sees the rules and the news, NOT the market price.
 */

const GAMMA = "https://gamma-api.polymarket.com";

const clean = s => String(s ?? "").replace(/\s+\n/g, "\n").trim();
const num = v => (v == null || v === "" ? null : Number(v));
const jparse = (v, fallback) => { try { return JSON.parse(v); } catch { return fallback; } };

export function slugFromUrl(input) {
  const s = String(input).trim();
  if (!/^https?:\/\//.test(s)) return s.replace(/^\/+|\/+$/g, "");
  const parts = new URL(s).pathname.split("/").filter(Boolean);
  const i = parts.indexOf("event");
  return i >= 0 && parts[i + 1] ? parts[i + 1] : parts[parts.length - 1];
}

async function get(path) {
  const res = await fetch(`${GAMMA}${path}`, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Polymarket returned HTTP ${res.status} for ${path}`);
  return res.json();
}

export async function fetchEvent(slugOrUrl, { comments = 25 } = {}) {
  const slug = slugFromUrl(slugOrUrl);
  const events = await get(`/events?slug=${encodeURIComponent(slug)}`);
  if (!events?.length) throw new Error(`No Polymarket event found for slug "${slug}"`);
  const e = events[0];

  const markets = (e.markets ?? []).map(m => {
    const outcomes = jparse(m.outcomes, []);
    const prices = jparse(m.outcomePrices, []).map(Number);
    const yesIdx = outcomes.findIndex(o => String(o).toLowerCase() === "yes");
    return {
      label: m.groupItemTitle || m.question || m.slug,
      question: clean(m.question),
      conditionId: m.conditionId ?? null,
      // CLOB token ids: [yes, no]. Needed only by the execution path.
      tokenId: (jparse(m.clobTokenIds, [])[yesIdx >= 0 ? yesIdx : 0]) ?? null,
      tokenIds: jparse(m.clobTokenIds, []),
      yes: yesIdx >= 0 ? prices[yesIdx] : prices[0] ?? null,
      volume: num(m.volumeNum) ?? num(m.volume),
      weekChange: num(m.oneWeekPriceChange),
      monthChange: num(m.oneMonthPriceChange),
      endDate: m.endDateIso ?? m.endDate,
      closed: !!m.closed,
    };
  }).filter(m => m.yes != null);

  let notes = [];
  if (comments > 0) {
    try {
      const raw = await get(
        `/comments?parent_entity_type=Event&parent_entity_id=${e.id}&limit=${comments}&order=createdAt&ascending=false`);
      notes = (raw ?? [])
        .map(c => clean(c.body))
        // one-word cheers and price chatter are noise, not evidence
        .filter(b => b.length >= 40 && b.length <= 600)
        .slice(0, 12);
    } catch { /* comments are optional */ }
  }

  return {
    slug, id: e.id,
    title: clean(e.title),
    rules: clean(e.description),
    resolutionSource: clean(e.resolutionSource) || null,
    tags: (e.tags ?? []).map(t => t.label).filter(Boolean),
    volume: num(e.volume),
    liquidity: num(e.liquidity),
    openInterest: num(e.openInterest),
    commentCount: num(e.commentCount),
    startDate: e.startDate, endDate: e.endDate,
    closed: !!e.closed,
    markets, notes,
  };
}

/**
 * Pick the market to judge.
 *
 * Volume alone is a bad guide on a crowded field: a 22-driver championship has
 * long shots with heavy churn and a 0.1% price, and judging those tells you
 * nothing. Prefer the live favourite, then fall back to volume.
 */
export function pickMarket(ev, labelHint) {
  const open = ev.markets.filter(m => !m.closed && m.yes > 0 && m.yes < 1);
  const pool = open.length ? open : ev.markets;
  if (!pool.length) return null;
  if (labelHint) {
    const hit = pool.find(m => m.label.toLowerCase().includes(String(labelHint).toLowerCase()));
    if (hit) return hit;
  }
  // a genuinely uncertain market (5%-95%) is more informative than a settled one
  const live = pool.filter(m => m.yes >= 0.05 && m.yes <= 0.95);
  if (live.length) return live.slice().sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0))[0];
  return pool.slice().sort((a, b) => b.yes - a.yes)[0];
}

/**
 * Assemble the Jev request.
 *
 * The market price is deliberately kept OUT of the state. If Jev could see that the
 * crowd says 28%, the comparison would be worthless: we would be measuring whether
 * Jev can read a number, not whether it can judge the evidence.
 */
export function toJevRequest(ev, { market, today = new Date().toISOString().slice(0, 10) } = {}) {
  const m = market ?? pickMarket(ev);
  if (!m) throw new Error("This event has no priceable market.");

  const state = {
    question_asked: m.question || ev.title,
    resolution_rules: ev.rules,
    window: `Judged as of ${today}. This market resolves on ${String(m.endDate ?? ev.endDate).slice(0, 10)}.`,
    subject_area: ev.tags.join(", ") || "unspecified",
  };
  if (ev.resolutionSource) state.resolution_source = ev.resolutionSource;
  if (ev.notes.length) state.public_discussion = ev.notes;

  const questions = {
    verdict: {
      type: "noul",
      instructions:
        `Under \`resolution_rules\`, the event described in \`question_asked\` will resolve YES ` +
        `before the date given in \`window\`.`,
      criteria: {
        true: "The described event occurs and satisfies every condition in the rules",
        false: "It does not occur, or occurs but fails a condition in the rules",
      },
    },
    rules_are_strict: {
      type: "score",
      instructions:
        "How much does the fine print in `resolution_rules` narrow what counts, compared with a plain reading of `question_asked`?",
      criteria: [
        "The rules match the plain reading; nothing surprising is excluded",
        "The rules exclude some plausible cases a casual reader would count",
        "The rules exclude most of what a casual reader would count as the event happening",
      ],
    },
    evidence_sufficient: {
      type: "noul",
      instructions:
        "The state contains enough concrete information to judge this responsibly, rather than requiring outside knowledge of current events.",
      criteria: {
        true: "The rules and discussion cover what the question turns on",
        false: "Judging this would mostly rely on facts not present in the state",
      },
    },
    ambiguity: {
      type: "choice",
      instructions:
        "If the described event happened in a borderline way, what would most likely cause a resolution dispute?",
      criteria: {
        definition_of_the_act: "Disagreement over whether what happened counts as the act described",
        attribution: "Disagreement over who did it, or on whose behalf",
        timing: "Disagreement over whether it fell inside the window",
        sourcing: "Disagreement over whether reporting is credible enough to resolve",
        little_ambiguity: "The rules are tight enough that a real event would resolve cleanly",
      },
    },
  };

  return { request: { state, model: "jev-latest", questions }, market: m, event: ev };
}
