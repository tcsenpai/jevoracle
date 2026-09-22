# Minutes, production meeting JevKnows

**Date:** 2026-09-20
**Participants:** Product/Strategy Lead, Architecture Lead, Senior Engineer (Builder), Senior Engineer (Skeptic), Moderator (synthesis and fact-checking), Project owner (intervened between Round 1 and Round 2).

**Subject:** Structuring JevKnows, a command-and-control platform for prediction-market bots based on Jev (TypeSafe System One), refactoring the jevoracle repo from a monolithic engine into a multi-bot platform. Single user (the owner), paper trading, no real execution, exchange-style UI, current console downgraded to a leisure page. Technical constraints: Bun plus SQLite plus vanilla JS, no build step, no npm dependencies.

---

## Decisions taken

Only points with explicit consensus or no residual objection by the end of Round 2.

1. **A single typed question schema for all bots in v1.** Product Lead and Architecture Lead converge for different reasons (product comparability for the former, schema survivability for the latter). Rationale: if two bots answer different questions, comparability collapses, and comparability is the only reason a multi-bot dashboard makes sense.

2. **The typed question schema lives in application code, not in the table.** `request_json` / `answers_json` stay free blobs and are the point of flexibility. A future bot-type with different questions is a new `schema_version` inside the same blob, not a new table.

3. **`bot_configs` is append-only, never UPDATE.** Every prediction fixes `bot_config_version`. Rationale: without this, changing a threshold retroactively rewrites the meaning of hundreds of already-recorded predictions, and the migration on day 90 is painful. The Builder confirmed feasibility (two hours of work, it's `config.js` with an added `bot_id` and `version`).

4. **`runs.mode` (`live` | `backrun` | `experiment`) in the same schema, not parallel tables.** Rationale: backrun isolation must be achievable with a `WHERE` everywhere, not with different JOINs per type.

5. **Predictions are immutable events.** No mutable field after insert. To react to a context change, a second prediction is created, linked via `supersedes_prediction_id`, never an in-place UPDATE. The exchange-style UI shows the sequence of judgments over time.

6. **Scheduling is reversed by fire-and-forget.** A direct consequence of the owner's intervention ("Jev is stateless and fire-and-forget, once a decision on a market has been made, that position never needs to call it again"), verified by the Architecture Lead against the TypeSafe docs. No cron is needed to re-poll markets with an open position: the scheduler only exists to discover NEW markets or re-evaluate markets NOT yet decided. Spend is per decision, not per bot-hour.

7. **A single global scheduler, not N parallel loops.** An extended `engine.js` loop that iterates bots in a cron-style queue, one bot at a time or in a limited batch, with priority by bankroll and thresholds. Rationale: N bots polling autonomously on the same Polymarket markets duplicate calls. Builder estimate: 1 day, near-total reuse of `engine.js`.

8. **The `model` column in `predictions` is mandatory before any experimental run.** It must contain the versioned ID returned in the response's `model` field, not the alias. Rationale (Skeptic, uncontested): `jev-latest` is a moving alias, so an experiment spanning a release change silently becomes an experiment on two different models mixed together, unseparable after the fact.

9. **`state_snapshot` mandatory on every prediction.** The exact JSON sent to Jev, otherwise auditing "what it knew when" is impossible.

10. **The canary set survives, but its nature changes.** It is no longer proof of generalization (proposal dropped, see below): it is a **model-drift control**. A fixed set of 20-30 already-resolved markets, any resolution date, replayed periodically. If answers change over time on identical questions, it's the alias moving, not noise.

11. **No existing code gets thrown away.** `engine.js`, `store.js`, `scoring.js`, `news.js`, the Polymarket adapter, and the dashboard (about 1300 working, tested lines) are untouched in their logic. The refactor adds a layer on top. The `experiments` table already exists (`experiment.js` writes to it) and is reused, not a new table.

12. **Overall estimate accepted: 4-5 days** for the multi-bot schema plus scheduler plus adapting the dashboard to a bot list (instead of a single 3-tab layout).

---

## Agreed data schema

Five tables. `experiments` already exists in the repo. The others are born from the refactor.

```sql
CREATE TABLE bots (
  id              INTEGER PRIMARY KEY,
  name            TEXT NOT NULL,
  bankroll        REAL NOT NULL,
  status          TEXT NOT NULL,          -- active | paused | archived
  schema_version  INTEGER NOT NULL,       -- versione del typed question schema applicativo
  created_at      TEXT NOT NULL
);

-- APPEND-ONLY. Mai UPDATE, mai DELETE. Un cambio di config = nuova riga.
CREATE TABLE bot_configs (
  bot_id          INTEGER NOT NULL REFERENCES bots(id),
  version         INTEGER NOT NULL,
  context_json    TEXT NOT NULL,          -- contesto personalizzato per bot
  thresholds_json TEXT NOT NULL,          -- soglie personalizzate per bot
  valid_from      TEXT NOT NULL,
  valid_to        TEXT,                   -- NULL = config corrente
  PRIMARY KEY (bot_id, version)
);

CREATE TABLE runs (
  id                  INTEGER PRIMARY KEY,
  bot_id              INTEGER NOT NULL REFERENCES bots(id),
  bot_config_version  INTEGER NOT NULL,
  started_at          TEXT NOT NULL,
  mode                TEXT NOT NULL       -- live | backrun | experiment
                      CHECK (mode IN ('live','backrun','experiment'))
  -- NOTE: model_cutoff_date does NOT exist. Proposal dropped, see "What the facts disproved".
);

-- EVENTO IMMUTABILE. Nessun campo mutabile dopo l'insert.
CREATE TABLE predictions (
  id                        INTEGER PRIMARY KEY,
  run_id                    INTEGER NOT NULL REFERENCES runs(id),
  bot_id                    INTEGER NOT NULL REFERENCES bots(id),
  bot_config_version        INTEGER NOT NULL,
  market_id                 TEXT NOT NULL,
  model                     TEXT NOT NULL,   -- versioned ID dal campo `model` della response
                                             -- MAI l'alias 'jev-latest'. Obbligatorio.
  state_snapshot            TEXT NOT NULL,   -- JSON esatto inviato a Jev (audit "cosa sapeva quando")
  request_json              TEXT NOT NULL,   -- blob libero, punto di flessibilita'
  answers_json              TEXT NOT NULL,   -- blob libero
  confidence                REAL,
  supersedes_prediction_id  INTEGER REFERENCES predictions(id),  -- NULL = first judgment on the market
  created_at                TEXT NOT NULL
);

CREATE TABLE experiments (   -- GIA' ESISTENTE, scritta da experiment.js
  id           INTEGER PRIMARY KEY,
  bot_id       INTEGER REFERENCES bots(id),
  description  TEXT,
  results_json TEXT
);
```

Operational constraints accompanying the schema:

- `bot_configs`: append-only enforced at the code level (`store.js`), no path emitting an UPDATE.
- `predictions.model`: populated by reading the `model` field of the TypeSafe response, not the requested alias.
- `supersedes_prediction_id`: see open disagreements, the trigger that authorizes a supersede has not been defined.
- Jev context budget: **64k for state plus all questions together**. The content of `state_snapshot` must be sized against this ceiling.

---

## Open disagreements

**1. `supersedes_prediction_id`: needs a constrained trigger, not yet defined.**
The Skeptic, verbatim: *"`supersedes_prediction_id` convinces me as an audit model, but it is also the exact mechanism for cheating: if there isn't an ironclad rule that a supersede fires ONLY on an objective, logged state event (not on 'I didn't like the result'), it becomes replay-until-you-win. We need an explicit, constrained trigger, not a discretionary one, to open a new prediction."*
The Architecture Lead had proposed the mechanism as a pure audit model (*"When the world's context changes with a position already open, we do NOT touch the prediction"*) without specifying what qualifies as "the context changes". The mechanism is approved, the **activation rule does not yet exist**. Open.

**2. `evidence_sufficient` as a leading indicator: self-report versus independent measure.**
The Product Lead wants it at the center of the dashboard: *"Build the dashboard around 'is this bot behaving consistently with its evidence', not around 'did it win or lose'"*, and cites as a gold signal the F1 case at 80pt wrong but with 12% evidence.
The Skeptic objects: *"evidence_sufficient self-declared by the model itself is a self-report, not an independent measure, a model can be confident and systematically wrong. We need a second, uncorrelated signal (e.g. historical evidence-vs-error calibration on a clean set) before treating it as a leading indicator."*
There was no rebuttal from the Product Lead in Round 2. **No convergence.** What the second uncorrelated signal is, and whether it's truly needed before v1, remains undecided.

**3. Whether engineering questions are blocking for scoping.**
Product Lead: *"(1), (4), (5) are engineering questions, not product questions, they get resolved while building, not before. Don't block my scoping on that."*
Architecture Lead: *"The Product Lead is right that (1)(4)(5) 'get resolved by building', false for (5) on the specific point of the immutable config."*
The substance (immutable config) was resolved in favor of the Architecture Lead, the **general principle of what blocks scoping was not reconciled**.

**4. What value a backrun actually has, now that cutoff-based control is impossible.**
The Skeptic withdrew the cutoff-based segmentation and fell back to the canary as a drift control, which by their own admission **is not proof of generalization**. Nobody at the table picked back up the underlying question: the Skeptic's opening position was *"a badly done backrun isn't 'less useful', it's actively misleading"* and *"it's worse than not testing"*. With the cutoff unavailable, it remains unanswered whether a backrun under `runs.mode='backrun'` produces a number a metric can be built on, or just an artifact to be viewed with suspicion. Open.

---

## What the facts disproved

Checks carried out by the moderator during the meeting, which caused proposals already on the table to fall.

1. **TypeSafe declares no knowledge cutoff.** `GET /v1/models` returns only a `release_date` (`jev-latest` = 2026-09-10). The docs mention a training cutoff nowhere. Two proposals fall:
   - segmenting the backrun by resolution date against the declared cutoff (Senior Engineer Skeptic), withdrawn by its author: *"noted, the declared cutoff doesn't exist, so segmenting by resolution date vs cutoff is dead, I withdraw the proposal as it stood"*;
   - the mandatory `runs.model_cutoff_date` field with `mode='backrun'` (Architecture Lead), **not applicable**: there is no real value to put there. It does not enter the schema.

2. **`jev-latest` is a moving alias.** Docs: *"An alias moves when a new release ships, so the answers behind it can change without a change on your side. The response's model field reports the versioned ID that answered, so you can log which model produced each result."* This turned the `model` column from nice-to-have into a blocking requirement (decision 8) and redefined the canary from proof of generalization to a drift control (decision 10).

3. **The current `predictions` table has no `model` column.** Verified with `PRAGMA table_info`. Today it is not possible to know which model version produced an existing prediction: the pre-refactor history remains unattributable.

4. **Polymarket is Polygon-only and has no testnet.** Verified. No on-chain test path exists, paper trading remains the only possible environment.

5. **The docs say nothing about freshness.** The Architecture Lead checked `system-one.md`, `state.md`, `how-to-build-with-system-one.md`, `confidence.md`: statelessness is confirmed only indirectly (*"Each request evaluates one state against one or more questions"*, no conversation-id, no session), and *"No line in the docs says 'call again when the state of the world changes', it's an absence, not a confirmation"*. The owner's intuition holds up, but the freshness policy is inferred by us, not documented. It is not a refutation, it is a weaker foundation than it looks, and should be recorded as such.

6. **Context budget: 64k for state plus all questions together.** Verified. A dimensional constraint on `state_snapshot` and on the per-bot custom context.

---

## Action items

| What | Owner (role) | Priority |
|---|---|---|
| Add the `model` column to `predictions`, populated from the response's versioned ID. Blocking for any experimental run | Senior Engineer (Builder) | P0, blocking |
| Implement `bot_configs` append-only starting from `config.js` (adding `bot_id` and `version`, removing every UPDATE path). Estimate 2 hours | Senior Engineer (Builder) | P0 |
| Multi-bot schema migration: `bots`, `bot_configs`, `runs` with `mode`, `predictions` with `state_snapshot` and `supersedes_prediction_id`. Reuse of `experiments` | Architecture Lead with Senior Engineer (Builder) | P0 |
| Single global scheduler on the `engine.js` loop, cron-style, bot queue with priority by bankroll and thresholds. Only discovery of new markets and markets not yet decided | Senior Engineer (Builder) | P1 |
| Define the ironclad activation rule for a supersede (objective, logged state event), before the mechanism is usable | Senior Engineer (Skeptic) with Architecture Lead | P1, blocks the use of `supersedes_prediction_id` |
| Build the canary set: 20-30 fixed resolved markets, replayed periodically as a model-drift control. Presupposes the `model` column | Senior Engineer (Skeptic) | P1 |
| Adapt the dashboard from a single 3-tab layout to a bot list, exchange-style, with a sequence of judgments over time instead of a mutable value | Senior Engineer (Builder) | P1 |
| Downgrade the existing console to a leisure page, without touching its logic | Senior Engineer (Builder) | P2 |
| Identify the second signal uncorrelated with `evidence_sufficient` (historical evidence-vs-error calibration on a clean set), or declare that we proceed without it | Product/Strategy Lead with Senior Engineer (Skeptic) | P2, see owner's decision |
| Verify that `state_snapshot` plus per-bot context plus questions stay within the 64k context budget | Architecture Lead | P2 |

---

## Requires owner decision

Points the agents did not resolve and cannot resolve on the owner's behalf.

1. **Whether the backrun stays in the plan or not.** With the cutoff unavailable, there is no way to demonstrate that a backrun measures predictive capability and not memory. The Skeptic argues a badly done backrun is *"worse than not testing"*. The drift canary does not fill this gap. The owner must decide whether to: (a) build the backrun while explicitly accepting that its numbers are not evidence of generalization and marking them as such in the UI, (b) postpone it, (c) abandon it. `runs.mode='backrun'` stays in the schema regardless, the cost of keeping it is zero.

2. **Whether `evidence_sufficient` can be the dashboard's primary metric in v1 without a second independent signal.** This is the only remaining open product disagreement, and the choice determines the entire shape of the dashboard. Product Lead in favor, Skeptic against. This needs an owner call, not another round of debate.

3. **Freshness policy: when the world changes, does a new prediction open or not.** The TypeSafe docs say nothing about this, it is our inference. The owner introduced the fire-and-forget principle and must set its limit: what qualifies as an "objective state event" that justifies a supersede. Without this rule the mechanism is unusable (see P1 action item). This is a domain decision about prediction markets, not an engineering one.

4. **Whether to pin a versioned ID instead of using `jev-latest`.** Using the alias means accepting that answers change underfoot without notice; pinning means managing updates by hand. The `model` column makes the problem visible and auditable but does not solve it. A management trade-off, not a technical one.

5. **Whether the pre-refactor prediction history (without a `model` column) should be kept, marked as unattributable, or discarded.** Nobody at the table proposed a line on this.

6. **Acceptable API spending budget per scheduling cycle.** The Builder solved call duplication (single scheduler) and fire-and-forget reduced spend to "per decision", but no numeric ceiling has been set. A number is needed from the owner to tune discovery frequency and batch size.
