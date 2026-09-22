/* Verification of the weighted quorum. Run with: bun platform/quorum.test.js
 *
 * Exists for a precise reason: the first version of the weighted median
 * dropped the `engine` field while building the votes, so the weights
 * reached the function but were not applicable to anyone. The result was the
 * OPPOSITE of what was configured (Jev lost against the coalition instead of
 * beating it) and no error flagged it: the numbers were plausible, just
 * wrong. Without a test that checks the VALUE, a defect like this is
 * invisible.
 */
import { askQuorum } from "./quorum.js";
import { DEFAULT_ENGINE } from "./runner.js";

const W = DEFAULT_ENGINE.weights;
let passed = 0, failed = 0;

function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}${ok ? "" : `  expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`}`);
  ok ? passed++ : failed++;
}

const noulEngine = (name, p) => async () => ({ answers: { v: { type: "noul", noul: p } }, ms: 1, model: name });
const choiceEngine = (name, c) => async () => ({ answers: { v: { type: "choice", choice: c } }, ms: 1, model: name });

async function quorum(engines, weights = W) {
  const r = await askQuorum(
    { state: {}, questions: { v: { type: "noul", instructions: "x" } } },
    { engines, weights });
  return r.answers.v;
}

const noul = vals => quorum(Object.fromEntries(
  Object.entries(vals).map(([k, v]) => [k, noulEngine(k, v)])));
const choice = vals => quorum(Object.fromEntries(
  Object.entries(vals).map(([k, v]) => [k, choiceEngine(k, v)])));

/* --- the weights must count, that is the whole point of the configuration --- */
check("jev beats the laya+kev coalition",
  (await noul({ jev: 0.10, laya: 0.90, kev: 0.90 })).noul, 0.10);
check("jev beats the coalition also with the sides swapped",
  (await noul({ jev: 0.90, laya: 0.10, kev: 0.10 })).noul, 0.90);
check("a lone outlier does not drag the result",
  (await noul({ jev: 0.20, laya: 0.80, kev: 0.20 })).noul, 0.20);
check("kev (weight 2) beats laya (weight 1) when jev is silent",
  (await noul({ laya: 0.80, kev: 0.20 })).noul, 0.20);

/* --- disagreement is the data that justifies the quorum --- */
const divergent = await noul({ jev: 0.14, laya: 0.71, kev: 0.19 });
check("the max-min spread is recorded", Math.round(divergent.noul_spread * 100) / 100, 0.57);
const agreeing = await noul({ jev: 0.20, laya: 0.22, kev: 0.21 });
check("agreeing engines give a small spread", agreeing.noul_spread < 0.05, true);

/* --- choice: here majority voting truly makes sense --- */
check("choice follows the weighted majority",
  (await choice({ jev: "NO", laya: "SI", kev: "SI" })).choice, "NO");
check("choice: laya+kev beat jev only when jev does not vote",
  (await choice({ laya: "SI", kev: "SI" })).choice, "SI");

/* --- one engine going down must not stop the others --- */
const broken = await quorum({
  jev: noulEngine("jev", 0.30),
  laya: async () => { throw new Error("laya not responding"); },
  kev: noulEngine("kev", 0.30),
});
check("a downed engine does not block the quorum", broken.noul, 0.30);

/* --- the platform default is the one declared --- */
check("the default is the three-way quorum", DEFAULT_ENGINE.name, "quorum");
check("jev weighs more than laya+kev combined", W.jev > W.laya + W.kev, true);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
