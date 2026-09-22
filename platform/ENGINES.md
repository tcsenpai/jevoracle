# The three judgment engines

JevKnows can ask for a judgment from three different engines, or query more
than one at the same time (quorum mode, see below). All three speak the same
typed protocol: `state` + `questions` in, answers `noul` (continuous
probability), `choice` (label) and `score` (number) out. None of them is a
generative LLM: they are typed decision models, legitimate substitutes for
each other. `platform/assistant.js` is not a judgment engine and does not
participate in any of these modes.

The absolute default remains **Jev alone**. A bot without `context.engine`
runs exactly as it does today, with no migration needed. Laya, Kev and the
quorum are opt-in via `context.engine = { name: ... }`.

## The real economic constraint: quota, not spend

The Jev plan (TypeSafe) is **free but has a call quota**. It is not a money
constraint, it is a constraint on the NUMBER of requests. Laya and Kev run
locally and are **unlimited**: no quota, no cost per call, just compute time
on the local machine.

Practical consequence: Laya and Kev are the way to run many experiments
without touching Jev's quota. A **Laya+Kev (without Jev)** quorum is a
legitimate, zero-quota configuration:

```js
context: { engine: { name: "quorum", engines: ["laya", "kev"] } }
```

A quorum that includes Jev consumes the quota **once per run in which it
runs**, not three times per normal run: it is still a single Jev call per
question, just like a single-engine run. But if you run many experiments with
Jev inside the quorum, the quota is consumed at the same rate as running them
with Jev alone: the quorum is not free just because it has two other engines
alongside it, it is only free in the part that is not Jev.

A 429 from Jev inside a quorum **does not fail the whole run**: it is treated
as an engine that did not answer, with a message that distinguishes "quota
exhausted" from "network error" or "service down" (see `platform/runner.js`,
`askJev`, field `err.jevReason` in { "quota", "network", "down", "other" }).

## Table of the three engines

| Engine | Protocol | Where it runs | Quota/constraint limit | Startup | Measured latency |
|---|---|---|---|---|---|
| **Jev** | HTTP, `POST https://api.typesafe.ai/v1/systemone` | Remote (TypeSafe) | Call quota (free plan, not paid) | None, only needs `TYPESAFE_API_KEY` | **VERIFIED-EXECUTED**: 2 real calls on bot id=1, run id=10, both succeeded (see below) |
| **Laya** | Persistent Python process (stdin/stdout JSON-lines), `platform/laya.js` + `platform/laya_bridge.py` | Local, on MPS | No quota. 1024-token context on the `multilingual` checkpoint: a real state measures **572 with the real tokenizer**, so it fits (the estimate at 4 characters per token said ~1050 and was wrong in the pessimistic direction) | Installed in `~/.venv` (laya 0.3.4), NOT in the system python3. The bridge starts it on its own on the first request | **VERIFIED-EXECUTED**: 1.9-7.4s on real states |
| **Kev** | HTTP, `POST http://localhost:8009/v1/systemone`, same shape as Jev | Local, on MPS | No quota | See "Where the Kev clone lives" below. **Needs `KEV_MERGE=0`** or startup looks hung for minutes | **VERIFIED-EXECUTED**: 5.8s for the first call (warm-up), then 306ms on short inputs, but **7-19s on real states** |

## The platform default is the weighted quorum

`DEFAULT_ENGINE` in `platform/runner.js`:

```js
{ name: "quorum", engines: ["jev", "laya", "kev"],
  weights: { jev: 3.1, laya: 1, kev: 2 } }
```

The 3.1 is not a typo. Out of 6.1 total points, with 3 flat the Laya+Kev
coalition would tie Jev and would need a separate tie-breaking rule written
on the side; with 3.1 Jev wins by construction against any coalition, and
"Jev wins on a tie" lives inside the numbers instead of in a branch of code.
The weights can be overridden by raising the others in configuration.

The weights also apply to `noul` (weighted median), not only to `choice`.
The behavior is locked in by `platform/quorum.test.js`: `bun platform/quorum.test.js`.

**The local engines manage themselves (on demand).** There is no need to
keep them running, nor a launchd: a resident 4B model running 24/7 for a few
runs a day is memory taken away from the rest of the machine.

- They start **on the first request** that concerns them (`platform/kev-process.js`
  for Kev, the bridge in `platform/laya.js` for Laya).
- They shut themselves down after **10 minutes of inactivity**
  (`KEV_IDLE_MINUTES`, `LAYA_IDLE_MINUTES`), and when the platform closes.
- If the Kev server was already running because you started it yourself, it is
  **adopted and not shut down**: it stays yours.
- `GET /api/engines` says whether they are up; `POST /api/engines` shuts them
  down immediately when you need the memory.

Measured cost of the saving: the **first** request after a pause pays for the
warm-up (Kev ~50s), later ones run at steady state (1.5s on short inputs). For
a platform that does a few runs a day this is the right way to err. Kev's
timeout inside the quorum is therefore wide (240s): otherwise it would get
discarded right while it is starting up.

Verified by running, from both engines cold: a real quorum got all three
answers, `jev 791ms / laya 7244ms / kev 18512ms`.

## Measured divergence across the three (2026-09-21, real markets)

| market | price | Jev | Laya | Kev | chosen |
|---|---|---|---|---|---|
| Gavin Newsom | 0.157 | 0.140 | 0.713 | did not answer | 0.140 |
| Kansas City Chiefs | 0.076 | 0.150 | 0.188 | 0.650 | 0.150 |
| Barcelona | 0.215 | 0.150 | 0.757 | 0.310 | 0.150 |

Jev is the closest to consensus and the most stable. Laya swings wildly on
some inputs and not on others: input-dependent, hence unpredictable. Kev sits
in the middle but on Kansas City it breaks away from everyone else. No engine
is systematically the outlier. This is why the individual answers must be
recorded (column `engine_votes`) instead of only the combined one.

## Where the Kev clone lives

The clone lives at **`~/coding/_jev/kev`** (`/Users/tcsenpai/coding/_jev/kev`),
NOT in `/tmp`: on macOS `/tmp` gets cleaned periodically and on reboot, and
the founder wants to be able to use these engines from other projects too,
not only from jevoracle. A first attempt at this verification started from
`/tmp/kev` and was interrupted halfway through for exactly this reason (the
process died when the clone disappeared out from under it): the lesson is
recorded here so the same mistake does not repeat months from now.

The venv in that location is already set up (`~/coding/_jev/kev/.venv`,
verified: `~/coding/_jev/kev/.venv/bin/python3 -c "import sys; sys.path.insert(0,'.'); import kev"`
works from inside the repo folder; it does NOT work from outside without
adding the folder to the path, because `kev` is a local package, not
installed in site-packages). Correct startup command:

```bash
cd ~/coding/_jev/kev
KEV_DTYPE=bf16 uv run --extra serve python -m kev.serve --run jaredpalmer/kev-4b --port 8009
```

### On Apple Silicon, prefer the Qwen3 generation if latency matters

The README says so explicitly: the Qwen3.5 models (current generation,
`kev-4b`) do not yet have fast kernels on Apple Silicon (measured by the
authors: 779ms). The previous Qwen3 generation (`kev-4b@qwen3`) is much
faster on the same hardware (174ms) and is the choice the README explicitly
recommends on Mac.

**Real defect found in the command as documented**: passing
`--run jaredpalmer/kev-4b@qwen3` directly on the CLI fails silently (see
detail further below). It is worked around by resolving the revision by hand
BEFORE starting the server, and passing the resolved local path instead of
the hub id with `@`:

```bash
cd ~/coding/_jev/kev
.venv/bin/python3 -c "
from kev.evaluate import resolve_run
print(resolve_run('jaredpalmer/kev-4b@qwen3'))
"
# downloads the @qwen3 adapter (~9MB, verified) and prints the local path in the
# HuggingFace cache, e.g. ~/.cache/huggingface/hub/models--jaredpalmer--kev-4b/snapshots/<hash>
KEV_DTYPE=bf16 .venv/bin/python3 -m kev.serve --run "<that path>" --port 8009
```
An existing local path bypasses `serve.py`'s `is_hub_id` check entirely
(it checks `os.path.exists` first), so the bug does not touch it.

## Per-bot configuration

```js
context: {
  engine: {
    name: "jev" | "laya" | "kev" | "quorum",

    // for "laya" (see platform/laya.js for valid values)
    model: "english" | "multilingual" | "typed-decisions" | "router",
    device: "auto" | "cpu" | "mps" | "cuda",

    // for "kev"
    url: "http://localhost:8009/v1/systemone",   // default, overridable
    timeoutMs: 60000,

    // for "quorum"
    engines: ["jev", "laya", "kev"],   // default: all three, none excluded a priori
    rule: { noul: "median" | "mean" }, // default: median (see platform/quorum.js)
    weights: { jev: 1, laya: 1, kev: 1 },  // default: uniform, no engine privileged
  }
}
```

The `engine` field lives inside `context` (it is not a new column in the
`bot_configs` schema): `store.js` serializes `context` as-is, so no migration
is needed for this part. API-side validation (`platform/api.js`, function
`normaliseKevOrQuorum`) completes `normaliseEngine` from `platform/laya.js`
for the Kev- and quorum-specific fields: malformed URLs, unknown engines in
the quorum list, or invalid combination rules return an explicit 400, never a
silent crash.

## Quorum mode

`platform/quorum.js`, function `askQuorum(request, { engines, rule, weights })`:

- queries all requested engines **in parallel** (`Promise.allSettled`), never
  sequentially: the latency of the local engines (especially Laya, on the
  first load of a checkpoint) is already high on its own.
- combines the answers for each question according to the primitive:
  - **noul** (continuous probability): **median** by default. A "majority"
    makes no sense on a continuous number; the median is robust to one engine
    firing off an outlier while the others agree. `mean` is available
    explicitly with `rule.noul = "mean"`.
  - **choice** (label): weighted majority (default: uniform weights). On a
    tie, the label with the highest average probability (`noul` on the same
    question) among the tied labels wins; if it remains unresolvable, the
    result declares it (`choice_tie: true`) instead of inventing a winner.
  - **score** (free number): median of the value.
- **disagreement is a datum**, not noise to hide: every combined answer
  reports `noul_spread` (max-min spread), `choice_agreement` (fraction that
  voted for the winning label), `choice_tally`. This is the value of the
  experiment: knowing WHEN the engines diverge, not just the final number.
- **partial failure**: if one engine out of three fails, the quorum proceeds
  with two and declares it in `warning`. If only one is left, it proceeds but
  flags it explicitly (a "quorum" of one is not a quorum, there is no
  measurable disagreement). If all fail, `askQuorum` throws an explicit error
  that lists the reason for each failure.
- **no engine is privileged**: the weights are configurable (`engine.weights`),
  the default is uniform (1 for all). Jev does not weigh more than Laya or Kev
  "because it's the default elsewhere": the point of the quorum is to
  compare, and a rigged comparison is worthless.

### Traceability

When `engine.name = "quorum"`, the row in `predictions` populates the
additive column `engine_votes` (JSON: `{ engineName: { model, ms, answers } }`)
and `engine_warning` (text, if the quorum is degraded). The `model` column
reports `quorum(jev+laya+kev)` (or the subset that actually answered): on its
own it is not enough to reconstruct who said what, `engine_votes` is. For
single-engine runs `engine_votes` and `engine_warning` stay `NULL`, including
all rows written before this work (additive migration, verified: the 14
pre-existing rows in `data/jevknows.db` have `engine_votes` and
`engine_warning` empty and no other column altered).

## Kev, what was actually verified

**VERIFIED-EXECUTED**, on this machine, today:

- `git clone https://github.com/jaredpalmer/kev.git`. The clone was first
  started in `/tmp/kev`, then moved by the founder to `~/coding/_jev/kev`
  (stable location, see above) because `/tmp` on macOS gets cleaned
  periodically: the first server startup attempt died halfway through for
  exactly this reason, when the folder disappeared out from under the
  running process.
- `uv sync --extra serve` completed successfully (in the original clone):
  it installs torch 2.8.0, transformers 5.17.0, all serving dependencies.
  The resulting venv is the one now at `~/coding/_jev/kev/.venv`, verified
  working after the move.
- The repo confirms the description in its own `pyproject.toml`: "Laptop-scale
  reconstruction of a Jev-style decision model with a TypeSafe-compatible
  /v1/systemone API", the compatibility with the Jev protocol is declared by
  the project itself, not only inferred from the README.
- **Real defect found in the startup command as documented by the README**:
  the exact command suggested by the brief,
  `--run jaredpalmer/kev-4b@qwen3`, fails silently. `kev/serve.py`
  (function `main()`) validates `--run` with the regex `[\w.-]+/[\w.-]+`
  BEFORE passing it to `resolve_run()`; that regex does not allow `@`, so an
  id with a pinned revision (`@qwen3`) is not recognized as a hub id and the
  server silently falls back to `runs/smoke`, which does not exist in a
  fresh clone (`FileNotFoundError: runs/smoke/head.pt`). The `resolve_run()`
  function further downstream, in `kev/evaluate.py`, handles `@` correctly
  (it does `run.partition("@")` and passes the revision to
  `snapshot_download`): the bug is in the preliminary check in
  `serve.py:main()`, not in the resolution logic. Worked around by resolving
  the revision by hand with `resolve_run("jaredpalmer/kev-4b@qwen3")` and
  passing the resolved local path to `--run` (see command above): a path
  that already exists on disk bypasses the buggy check.
- Downloaded the `jaredpalmer/kev-4b@qwen3` adapter (~9.4MB, confirmed: it is
  just the LoRA, not the base model).
- Downloaded the full associated Qwen3-4B-Base model (two safetensors shards,
  ~3.3GB and ~3.1GB, completed) and loaded the weights into memory (398/398,
  log confirms "Loading weights: 100%").
- At the moment this verification session was closed, the serve process was
  still alive and actively consuming CPU (CPU time growing continuously,
  1:40 -> 2:01 in a few minutes of observation: it is not stuck, it is doing
  the fp32 merge of the LoRA into the base model before the cast to bf16, as
  documented in `kev/evaluate.py:load()`), but it had NOT yet started
  answering on port 8009 (`curl` kept returning connection refused). The
  fp32 merge of a 4B-parameter model on CPU/MPS can take several minutes;
  it was not possible to wait for completion within this session's time.

**NOT verified with certainty within the time available in this session**:
a completed HTTP request with measured latency against the Kev server
listening on 8009. The serve process (PID 95011) was terminated (SIGTERM,
verified: background task closure notification with "exit code 143") while
it was still in the fp32 merge of the LoRA, before reaching the point of
listening on the port. This is not a code failure: it is the work session
ending before an intrinsically slow operation (fp32 merge of a 4B model on
CPU) finished. Port 8009 is free again.
`platform/kev.js` (`askKev`) is written and tested only for error
classification (no network): if the server responds, it works with no
further changes, because the protocol is literally the same as Jev's. If the
server does not respond, `askKev` throws an explicit error with startup
instructions, not a raw `ECONNREFUSED` (verified by reading the code, and
observed in practice: every `curl` made during the wait returned connection
refused until the merge finished). Whoever picks this work back up can
restart from:
```bash
cd ~/coding/_jev/kev
KEV_DTYPE=bf16 uv run --extra serve python -m kev.serve --run jaredpalmer/kev-4b --port 8009
# or, for the Qwen3 variant recommended on Mac (see above for the @qwen3 workaround)
```
and then verify with:
```bash
curl -s -X POST http://localhost:8009/v1/systemone \
  -H "Content-Type: application/json" \
  -d '{"state": {...}, "questions": {...}}'
```

## Non-regression: verified with a real run

Bot id=1 ("geopolitics"), which does not have the `context.engine` field, run
on the real server (port 3737, restarted to load the new code):

- run id=10, `maxMarkets: 6`: 2 markets requested from Jev, 2 recorded.
- Direct query on the db: `model = "jev-1.13.0"` on both rows (versioned id,
  not the `jev-latest` alias), `engine_votes` and `engine_warning` NULL (no
  quorum, single engine).
- Run kept to the bare minimum (`maxMarkets` small across several successive
  runs, 1 -> 3 -> 6) to avoid wasting the founder's quota: the first two
  attempts fell on expired or already-borderline markets, consuming no Jev
  call at all; only the third one actually queried Jev.

## Quorum testing without depending on local servers

`platform/quorum.js` was verified with fake engines (functions that return
known answers, no network): 21 checks, all passed. Covers: median and mean on
noul, majority and tie (resolved and unresolvable) on choice, median on
score, one engine out of three failing (the quorum proceeds with the other
two), a single surviving engine (flagged as "not a quorum"), all failing
(explicit error), full traceability in `engine_votes`. Also separately
verified the specific case of the quota fix: a 429 from Jev inside a quorum
does not block the other engines and the error message stays the classified
one ("call quota exhausted"), not a generic error.

## Market horizon: default 7 days

`thresholds.maxHorizonDays` (default `DEFAULT_MAX_HORIZON_DAYS = 7` in
`platform/runner.js`). A market closing beyond that limit is discarded
**before** querying the engines, so no call is spent on a prediction that
would be discarded anyway.

Why: a market at 250 days ties up the bankroll for eight months and produces
no feedback in the meantime. Without markets that close you cannot know
whether the bot is getting it right, and the platform exists to find that
out.

**Non-obvious consequence for candidate search.** With a short horizon the
filter discards the majority of candidates: measured on the 60 most-traded
Polymarket events, only **13 close within 7 days** (6 between 8 and 30 days,
29 beyond 30, 12 already expired). Asking `candidates()` for only
`maxMarkets` events means coming up empty-handed. So when the limit is
active, the search casts a wider net (`max(maxMarkets * 5, 40)`) and sorts by
nearest expiry: **the search widens, not the spend**, because the cap on
engine calls stays at `maxMarkets`.

Verified by running: before the filter the bot was opening positions at 190,
250 and 777 days; after, a real bet on a market that closed **the same day**.

`0` or `null` disables the limit.
