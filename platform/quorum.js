/* Quorum mode: asks multiple judgment engines the same question and combines
 * the answers. An experiment, not one more engine: it exists to MEASURE the
 * disagreement between Jev, Laya and Kev, not to hide it behind a single
 * number.
 *
 * No engine is privileged: Jev does not weigh more than Laya or Kev "because
 * it's the default elsewhere". The weights are configurable, the default is
 * uniform.
 *
 * Cost: Jev costs per call (TypeSafe), Laya and Kev run locally and are
 * free. A quorum that includes Jev still calls it only once per engine (it
 * does not triple it on its own), but a three-way quorum triples the total
 * number of model calls compared to a single engine. See
 * platform/ENGINES.md.
 */

/** Default combination rule for each answer primitive. */
export const DEFAULT_RULE = { noul: "median", score: "median" };

const isFinite_ = v => typeof v === "number" && Number.isFinite(v);

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return null;
  const mid = Math.floor(n / 2);
  return n % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function mean(nums) {
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

/**
 * Combines the "noul" values (a probability, not a vote) from multiple
 * engines.
 *
 * Why median and not mean as the default: noul is continuous, not a label.
 * "Majority" makes no sense on a continuous number. The median is robust to
 * outliers (one engine firing off 0.95 while the others say 0.4 does not
 * drag the result along), the mean is available for whoever wants it
 * explicitly via rule.noul = "mean".
 */
/**
 * WEIGHTED median: each engine counts for its weight, as if it had voted
 * that number of times. With uniform weights it coincides with the plain
 * median. This exists because the weights must also apply to noul, not only
 * to choice: otherwise an engine given weight 3 would weigh exactly like one
 * at weight 1, and the configuration would be lying about what it is doing.
 */
function weightedMedian(pairs) {
  const xs = pairs.filter(p => isFinite_(p.value) && p.w > 0).sort((a, b) => a.value - b.value);
  if (!xs.length) return null;
  const total = xs.reduce((a, p) => a + p.w, 0);
  let acc = 0;
  for (const p of xs) {
    acc += p.w;
    if (acc >= total / 2) return p.value;
  }
  return xs[xs.length - 1].value;
}

function combineNoul(votes, rule, weights = {}) {
  const nums = votes.map(v => v.value).filter(isFinite_);
  if (!nums.length) return { value: null, agreement: null };
  const pairs = votes.map(v => ({ value: v.value, w: weights[v.engine] ?? 1 }));
  const value = rule === "mean" ? mean(nums) : weightedMedian(pairs);
  // disagreement = max-min spread: how far the engines drifted from each other
  const agreement = nums.length > 1 ? 1 - (Math.max(...nums) - Math.min(...nums)) : 1;
  return { value, agreement, spread: nums.length > 1 ? Math.max(...nums) - Math.min(...nums) : 0 };
}

/**
 * Combines the "score" values (a number, not necessarily in [0,1]): median
 * of the value, same reasoning as noul.
 */
function combineScore(votes) {
  const nums = votes.map(v => v.value).filter(isFinite_);
  if (!nums.length) return { value: null, agreement: null };
  const value = median(nums);
  const spread = nums.length > 1 ? Math.max(...nums) - Math.min(...nums) : 0;
  return { value, agreement: null, spread };
}

/**
 * Combines the "choice" values (a label): majority vote. On a tie, the label
 * with the highest average probability (noul, if available on the same
 * question) wins; if the tie remains unresolvable, no winner is invented, it
 * is declared.
 */
function combineChoice(votes, weights) {
  const valid = votes.filter(v => v.value != null);
  if (!valid.length) return { value: null, agreement: null, tie: false, tally: {} };

  const tally = {};
  for (const v of valid) {
    const w = weights[v.engine] ?? 1;
    tally[v.value] = (tally[v.value] ?? 0) + w;
  }
  const totalWeight = Object.values(tally).reduce((a, b) => a + b, 0);
  const maxWeight = Math.max(...Object.values(tally));
  const leaders = Object.entries(tally).filter(([, w]) => w === maxWeight).map(([label]) => label);

  let winner = leaders[0];
  let tie = leaders.length > 1;

  if (tie) {
    // on a tie, the winner is whoever among the tied has the highest average probability
    const withScore = leaders.map(label => {
      const scores = valid.filter(v => v.value === label && isFinite_(v.score)).map(v => v.score);
      return { label, avg: scores.length ? mean(scores) : null };
    });
    const scored = withScore.filter(x => x.avg != null);
    if (scored.length === leaders.length) {
      scored.sort((a, b) => b.avg - a.avg);
      if (scored[0].avg !== scored[1]?.avg) {
        winner = scored[0].label;
        tie = false;
      }
    }
    // if it remains unresolvable, tie stays true and winner is declared but flagged
  }

  const agreement = maxWeight / totalWeight; // fraction that voted for the winning label
  return { value: winner, agreement, tie, tally };
}

function combineAnswer(question, votes, rule, weights) {
  const kinds = new Set(votes.map(v => v.kind));
  const out = { votes: votes.map(v => ({ engine: v.engine, value: v.value, score: v.score })) };

  if (kinds.has("noul")) {
    // `engine` is also needed, otherwise the weights cannot be applied to anyone
    const nums = votes.filter(v => v.kind === "noul").map(v => ({ engine: v.engine, value: v.value }));
    const c = combineNoul(nums, rule.noul ?? DEFAULT_RULE.noul, weights);
    out.noul = c.value;
    out.noul_agreement = c.agreement;
    out.noul_spread = c.spread ?? null;
  }
  if (kinds.has("choice")) {
    const c = combineChoice(votes.filter(v => v.kind === "choice"), weights);
    out.choice = c.value;
    out.choice_agreement = c.agreement;
    out.choice_tie = c.tie;
    out.choice_tally = c.tally;
  }
  if (kinds.has("score")) {
    const nums = votes.filter(v => v.kind === "score").map(v => ({ value: v.value }));
    const c = combineScore(nums);
    out.score = c.value;
    out.score_spread = c.spread ?? null;
  }
  return out;
}

/**
 * Queries N engines in parallel and combines the answers.
 *
 * @param {object} request   the already-validated request (assertSafeRequest
 *                           must be called by the caller BEFORE invoking this
 *                           function, for every engine, quorum included).
 * @param {object} opts
 *   engines: { name: (request) => Promise<{answers, ms, model}> }  engines to query
 *   rule:    { noul: "median"|"mean" }   combination rule for noul
 *   weights: { name: number }            optional weights, default 1 for everyone
 * @returns {Promise<{ answers, engines_used, engines_failed, votes_by_model, ms, quorum_size, warning }>}
 */
export async function askQuorum(request, opts = {}) {
  const engines = opts.engines ?? {};
  const names = Object.keys(engines);
  if (!names.length) throw new Error("askQuorum requires at least one engine in opts.engines.");

  const rule = { ...DEFAULT_RULE, ...(opts.rule ?? {}) };
  const weights = opts.weights ?? Object.fromEntries(names.map(n => [n, 1])); // default uniform

  const t0 = Date.now();
  const settled = await Promise.allSettled(
    names.map(name => engines[name](request).then(r => ({ name, ...r }))));

  const ok = [];
  const failed = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") ok.push(r.value);
    else failed.push({ name: names[i], error: String(r.reason?.message ?? r.reason) });
  });

  if (!ok.length) {
    throw new Error(
      `All quorum engines failed: ${failed.map(f => `${f.name}: ${f.error}`).join(" | ")}`);
  }

  let warning = null;
  if (ok.length === 1) {
    warning = `A quorum of a single engine (${ok[0].name}) is not a quorum: no measurable disagreement. ` +
      `The others failed: ${failed.map(f => `${f.name}: ${f.error}`).join(" | ") || "none"}.`;
  } else if (failed.length) {
    warning = `The quorum proceeds with ${ok.length}/${names.length} engines. ` +
      `Failed: ${failed.map(f => `${f.name}: ${f.error}`).join(" | ")}.`;
  }

  // gather the set of questions answered by at least one engine
  const questionKeys = new Set();
  for (const r of ok) for (const k of Object.keys(r.answers ?? {})) questionKeys.add(k);

  const answers = {};
  for (const qKey of questionKeys) {
    const votes = [];
    for (const r of ok) {
      const a = r.answers?.[qKey];
      if (!a) continue;
      if (isFinite_(a.noul)) votes.push({ engine: r.name, kind: "noul", value: a.noul, score: a.noul });
      if (a.choice != null) votes.push({ engine: r.name, kind: "choice", value: a.choice, score: isFinite_(a.noul) ? a.noul : null });
      if (isFinite_(a.score)) votes.push({ engine: r.name, kind: "score", value: a.score, score: a.score });
    }
    if (votes.length) answers[qKey] = combineAnswer(qKey, votes, rule, weights);
  }

  // traceability: what EVERY engine answered, to persist in engine_votes
  const engine_votes = Object.fromEntries(ok.map(r => [r.name, {
    model: r.model, ms: r.ms, answers: r.answers,
  }]));

  return {
    answers,
    engine_votes,
    engines_used: ok.map(r => r.name),
    engines_failed: failed,
    quorum_size: ok.length,
    ms: Date.now() - t0,
    warning,
  };
}
