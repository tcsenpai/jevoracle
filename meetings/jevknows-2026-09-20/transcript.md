# Production meeting: JevKnows

**Date:** 2026-09-20
**Topic:** Structuring JevKnows, a command-and-control platform for
prediction-market bots based on Jev (TypeSafe System One).

**Participants:** Product/Strategy Lead, Architecture Lead, Senior Engineer
(Builder), Senior Engineer (Skeptic). Moderator: final synthesis.

**Open questions brought to the table:**
1. How to schedule bot runs without blowing up Jev API spend
2. How deep per-bot personalization should go
3. What metrics say whether a bot is working, given weeks of lag
4. How to structure the backrun avoiding optimistic results from contamination
5. What data schema holds up for multiple bots without becoming unmanageable

---

## ROUND 1: Opening positions

### Product/Strategy Lead

Opening position, in three points.

**The questions that matter: (3) and (2). The others are premature or even wrongly framed.**

**(3) is the real product question.** If I can't tell in 20 seconds whether a bot
"is doing well" with weeks of lag on results, JevKnows is useless, it becomes a
log nobody reopens. The metric cannot be raw P&L. It must be leading
calibration: average evidence_sufficient, gap from the crowd, how many times the
bot correctly abstained (the F1 case at 80pt wrong but 12% evidence is
EXACTLY the signal that's worth gold, a bot that knows it doesn't know is a
trusted bot even before the market resolves). Build the dashboard around "is this
bot behaving consistently with its evidence", not around "did it win or
lose".

**(2) is the second real decision, and the answer is: NO to bots with different
questions, at least in v1.** A single typed question schema, per-bot
customizable context and thresholds. The moment two bots answer different
questions, you've lost the comparability that is the only reason a multi-bot dashboard
makes sense, otherwise they're N disconnected experiments with a shared skin. If in
the future a different question is needed, that's a new bot-type, not a parameter.

**(1), (4), (5) are engineering questions, not product questions, they get
resolved while building, not before.** Don't block my scoping on that.

### Architecture Lead

Let me answer the Product Lead first: I agree on (2) but for different reasons from
theirs, and it's not just a product question, it's the schema question that decides
whether the schema survives or not.

**On (2):** same typed question schema for all bots, but this should be written
as a database constraint, not a convention. The current `predictions` already has
`request_json`/`answers_json` as free blobs, this IS the flexibility point. The
typed question schema lives in application code (one for now), not in the table. If
a new bot-type with different questions is needed tomorrow, it's a new *schema_version*
inside the same blob, not a new table. This takes me straight to (5).

**On (5), today's real question:**

```
bots            (id, name, bankroll, status, schema_version, created_at)
bot_configs     (bot_id, version, context_json, thresholds_json, valid_from, valid_to)
runs            (id, bot_id, bot_config_version, started_at, mode: live|backrun|experiment)
predictions     (id, run_id, bot_id, bot_config_version, market_id, ...)
experiments     (id, bot_id, description, results_json)
```

Two non-negotiable decisions:

1. **`bot_configs` is append-only, never UPDATE.** The current `config` is a "single
JSON row", this is the project's original flaw, taken to N-bot scale it's a
disaster: you change one bot's threshold and retroactively you no longer know which
config an old prediction was made under. Every prediction fixes `bot_config_version`,
so you can reconstruct "under what rules did this decide" months later. It costs
one extra table, not a microservice.

2. **`runs.mode` distinguishes live/backrun/experiment in the same schema**, not
parallel tables, otherwise (4) becomes structurally impossible to isolate (you need
to be able to filter "live only" everywhere with a WHERE, not with different JOINs
per type).

The Product Lead is right that (1)(4)(5) "get resolved by building", false for (5)
on the specific point of the immutable config: that's the one decision that, if
wrong on day 1, produces a painful migration on day 90 when you'll already have
hundreds of predictions with an FK pointing to a config that has since changed
underfoot.

### Senior Engineer (Builder)

**Ok, so, what actually gets thrown away: nothing.** engine.js, store.js, scoring.js,
news.js, the Polymarket adapter, the dashboard: 1300 working, tested lines, not
touched in their logic. The refactor is *adding a layer on top*, not rewriting. Whoever
proposes to throw something away here is proposing a month of work to recreate what
already runs.

**On the Architecture Lead's schema: proportionate, I'm in, with one cut.** 5
tables are fine, but `experiments` already exists (experiment.js writes to
`experiments`), it's not a new table, it's reuse. And I'll write the append-only
`bot_configs` in two hours: it's literally `config.js` with one extra `bot_id` and
`version` instead of a single row. It's not over-engineering, it's the minimum that
saves you a mess at runtime. I'm backing the AL on this.

**On (1), scheduling, nobody's touched it and it can't be skipped.** 300ms per Jev
call with parallelism 10 isn't the bottleneck, it's the spend: if N bots poll
autonomously on the same Polymarket markets you waste duplicate calls.
Pragmatic solution, not an elegant one: **a single global scheduler (extended
engine.js loop) that iterates bots in a queue, not N parallel loops.** Cron-style, one
bot at a time or a limited batch, save for bankroll/threshold priority. Estimate: 1
day, near-total reuse of engine.js.

**Realistic overall estimate: 4-5 days** for multi-bot schema + scheduler +
adapting the dashboard to a bot list instead of a single 3-tab. Backrun (4) is the
newest part, we'll get to it later, but even there I just reuse `runs.mode`.

### Senior Engineer (Skeptic)

**On (4), a badly done backrun isn't "less useful", it's actively misleading, and
nobody's said that clearly yet.**

The last measured point says it by itself: "the knowledge cutoff of the model doing
the judging" might include past markets. If Jev was trained on data covering the
outcome of a $7M geopolitical market that's already resolved, the backrun doesn't
measure *predictive capability*, it measures *memory*. And the calibration metric
the PM wants to build, evidence_sufficient, gap from the crowd, on a contaminated
backrun becomes a false-confidence generator: the bot will look calibrated PRECISELY
on the cases where it actually cheated via data leakage. It's worse than not
testing, because the dashboard will say "look how well it's behaving" while
measuring the wrong thing.

**The specific check:** before trusting a single backrun, it needs to be segmented
by resolution date against the model's declared cutoff, and a canary set needs to be
added, markets resolved AFTER the cutoff, or synthetically altered (same schema,
outcome flipped relative to the real one) to verify the judgment isn't recovering
the outcome from memory instead of reasoning about the rules.

**On (3):** evidence_sufficient self-declared by the model itself is a self-report,
not an independent measure, a model can be confident and systematically wrong. We
need a second, uncorrelated signal (e.g. historical evidence-vs-error calibration
on a clean set) before treating it as a leading indicator.

---

## ROUND 2: Rebuttal

*Moderator's note, introduced by the project owner between the two rounds:*
**Jev is stateless and fire-and-forget.** Once a decision on a market has been made,
that position never needs to call it again. This has direct consequences both for
scheduling (spend is per decision, not per bot-hour) and for what makes sense to
pass as context. The Architecture Lead was tasked with checking the TypeSafe docs.

### Architecture Lead

**1. What the docs actually say**

I read `system-one.md`, `state.md`, `how-to-build-with-system-one.md`,
`confidence.md`. They confirm statelessness, but indirectly, not with an explicit
sentence about "when to re-evaluate": *"Each request evaluates one state against one
or more questions. All questions see the same state and are evaluated
independently"*, no mention of persistent state between calls, no conversation-id,
no session. `how-to-build-with-system-one.md` doubles down: *"Questions are
evaluated independently and in parallel. One primitive's result does not become
hidden context that changes another primitive's result."* Jev is purely functional:
state → answer.

No line in the docs says "call again when the state of the world changes", it's an
absence, not a confirmation. The nuancing thing: `confidence.md` talks about "route
on uncertainty", not temporal re-evaluation. The owner's intuition holds up against
the docs, but the docs tell us NOTHING about freshness: we have to infer it ourselves.

**2. Architectural consequences**

This flips scheduling (Q1): no cron is needed to re-poll markets with an open
position, the scheduler only exists to discover NEW markets or re-evaluate markets
NOT yet decided. A `prediction` becomes an immutable event, period:
`created_at`, `bot_config_version`, `state_snapshot` (the exact JSON sent to Jev,
otherwise we can never audit "what it knew when"), answer, `confidence`. No mutable
field after insert.

When the world's context changes with a position already open, we do NOT touch the
prediction: if we want to react, we create a second linked prediction
(`supersedes_prediction_id`) on the same market, never an in-place update. The
"exchange-style" UI must show the sequence of judgments over time, not a value that
mutates underfoot.

**3. On the contaminated backrun, replying to the Skeptic**

`runs.mode` isolates the execution but isn't enough on its own: without a
`model_cutoff_date` per row in `predictions` (or better, frozen per `run`), we can't
segment "resolved before/after cutoff" in queries. I'm adding
`runs.model_cutoff_date`, mandatory when `mode='backrun'`, null otherwise, so the
canary set is a query, not a hypothesis.

---

**Moderator's check, interposed here because it contradicts two proposals on the
table:**

1. **No knowledge cutoff is declared by TypeSafe.** `GET /v1/models` returns
   only a `release_date` (jev-latest = 2026-09-10). The docs mention a
   training cutoff nowhere. So both the Skeptic's "segment by date vs cutoff" and
   the Architecture Lead's `runs.model_cutoff_date` **are not
   applicable**: there is no real value to put there.
2. **`jev-latest` is a moving alias.** Docs: *"An alias moves when a new release
   ships, so the answers behind it can change without a change on your side. The
   response's model field reports the versioned ID that answered, so you can log which
   model produced each result."*
3. **Real gap in the code:** the `predictions` table has no `model` column
   (verified with PRAGMA). Today we don't know which version produced a
   given prediction.
4. Context budget: 64k for state + all questions together.

### Senior Engineer (Skeptic)

**Point 1:** noted, the declared cutoff doesn't exist, so segmenting by resolution
date vs cutoff is dead, I withdraw the proposal as it stood. But the canary set
doesn't depend on the cutoff, it only depends on having known-outcome markets and
open markets in the same batch: it remains valid, in fact it becomes the only
anchor we have. Workable version: fix a set of 20-30 already-resolved markets
(any date, no need to know their cutoff) and replay them periodically as a
**model-drift control**, not as proof of generalization. If answers change over
time on identical questions, it's the alias moving underneath us, not noise.

**Point 2:** here the Architecture Lead hands me the weapon I was missing. Moving
alias + `predictions` without a `model` column is worse than I thought: it's not just
"we don't know who answered", it's that an experiment spanning a release change
silently becomes an experiment on TWO different models, mixed together, with no way
to separate them after the fact. No canary holds up if we don't know which version
answered when. Not up for debate: the `model` column (the versioned ID from the
response, not the alias) must be added to `predictions` before any experimental
run, period, not a "nice to have" for next sprint.

**Point 3:** `supersedes_prediction_id` convinces me as an audit model, but it's also
the exact mechanism for cheating: if there isn't an ironclad rule that a supersede
fires ONLY on an objective, logged state event (not on "I didn't like the result"),
it becomes replay-until-you-win. We need an explicit, constrained trigger, not a
discretionary one, to open a new prediction.

---

*Convergence reached at the end of round 2 on the structural points: versioned
schema, prediction immutability, scheduling flipped by fire-and-forget, mandatory
model column, canary as a drift control. The moderator closes here and moves to
synthesis.*
