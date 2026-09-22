# Laya as an alternative engine to Jev

Per-bot lever that lets a bot run using Laya
(https://github.com/NandhaKishorM/laya, PyPI package `laya`) instead of Jev.
The absolute default remains Jev: a bot without `config.context.engine`
keeps running exactly as before, with no migrations needed.

Everything in this document is split into two categories: what has been
**verified by executing it** on this machine (Mac, Apple Silicon, no CUDA)
and what is **only stated/inferred** from Laya's source code without an
execution to confirm it.

## How to enable it

```json
POST /api/bots/:id/config
{
  "context": {
    "engine": { "name": "laya", "model": "multilingual", "device": "auto" }
  }
}
```

`engine` fields:
- `name`: `"jev"` (default) | `"laya"` | `"kev"` | `"quorum"`.
- `model` (Laya only): `"english"` | `"multilingual"` | `"typed-decisions"` | `"router"`.
  Default: `"multilingual"`. **Not** `"english"`: verified that real
  production states do not fit into the English checkpoint's 512-token
  context (see below), so it cannot be the default.
- `device` (Laya only): `"auto"` (default) | `"cpu"` | `"mps"` | `"cuda"`.
  `"auto"` picks cuda > mps > cpu, replicating `laya.Agent`'s logic.

An absent `engine`, `null`, or one with an unrecognized `name` falls back to
`{name: "jev"}` (see `normaliseEngine` in `platform/laya.js`): a bot never
breaks because of a malformed config.

## What was VERIFIED BY EXECUTING, with real numbers

- Installation: `uv pip install laya` installed **laya 0.3.4** successfully,
  but inside `~/.venv` (this machine's `uv` environment), NOT in the system
  `python3` (`import laya` fails there). `platform/laya.js` looks for the
  interpreter in this order: `$LAYA_PYTHON` (environment variable, if set)
  -> `~/.venv/bin/python3` -> `python3` from PATH. On another machine, if the
  installation goes elsewhere, set `LAYA_PYTHON`.
- `torch` 2.5.1, already present, supports **MPS** on this Mac
  (`torch.backends.mps.is_available()` -> `True`). Laya runs on top of it:
  the automatically resolved device was `mps`, confirmed by the bridge's log
  (`checkpoint 'multilingual' ready on mps`).
- Real checkpoint download from HuggingFace (`convaiinnovations/laya`,
  subfolder `multilingual`): succeeded, ~15s the first time, instant from the
  local cache on subsequent calls.
- **Real predict, end-to-end, three times**: (1) via a direct Python script,
  (2) via `platform/laya.js` from Bun with an isolated script, (3) via the
  real HTTP server (`bun run server.js` on :3737), bot id=1 ("geopolitics"),
  `POST /api/bots/1/run` with `engine.name = "laya"`. All three produced
  valid answers (`answers.verdict.noul`, `.score`, `.choice` consistent with
  the expected schema).
  - Internal model latency (forward pass only, 4 questions batched, MPS,
    checkpoint already loaded): **~4.4-4.9 seconds**. Noticeably slower than
    the 32.8ms stated for CUDA GPU in the README: expected, MPS is not CUDA
    and MPS Autocast disabled the required bf16 AMP
    (`UserWarning: In MPS autocast, but the target dtype is not supported`),
    so the forward pass runs in full float32.
  - In the real run via the server, 3 predictions were recorded with
    `model = "laya-multilingual@0.3.4"` in the `predictions` table (id 9, 10,
    11 in the verification db), confirming that traceability works at the
    platform level, not only in the isolated script.
- **Real size of a production state, measured with the multilingual
  checkpoint's REAL tokenizer** (not a characters/4 estimate): the largest
  state seen in the db (`state_snapshot` of an existing prediction, 4235
  characters) measures **572 tokens** with `agent.tok(...)`. The multilingual
  checkpoint accepts `max_len = 1024` total tokens, of which
  `head_max_len = 256` are reserved for the question header (instructions +
  options); the remaining space for the state in a typical JevKnows question
  is therefore around 950-1000 tokens. **572 < 950: the heaviest state seen
  so far fits**, with margin, in the multilingual checkpoint. It would not
  fit in the English checkpoint (`max_len = 512`): this is why the default is
  `multilingual`, never `english`.
  - This number (572 real tokens) is lower than the rough characters/4
    estimate that circulated initially (~1054 tokens estimated for the same
    type of state): the characters/4 estimate overestimates, the multilingual
    checkpoint's BPE tokenizer compresses better. The check implemented in
    `laya_bridge.py`, however, does not trust any estimate: it always
    measures with `agent.tok(...)`, the real tokenizer, before every call.

## The context risk and how it is handled (not a hypothesis, a normal case)

`laya.Agent.system_one` (in `laya/common.py:build_sequence`) silently
truncates the state if it exceeds the available space: `st = st[:room]`. No
exception, no warning: the judgment would change without anyone noticing.
Verified by reading the installed source
(`~/.venv/lib/python3.12/site-packages/laya/common.py`), not only inferred
from the README.

For this reason `platform/laya_bridge.py` performs a check **before** calling
`agent.system_one`: it measures the state with `agent.tok(...)` (the real
tokenizer of the loaded checkpoint, not an estimate) and compares it against
the space actually available (`max_len` minus the footprint of the heaviest
question in the batch, also computed with the same tokenizer). If it does not
fit, the request fails with an error that reports **three concrete numbers**:
how many tokens the state measures, how many the checkpoint accepts for the
state, and which field is worth disabling to fit
(`recent_reporting` or `trader_notes` via `config.context.fields`, already
disableable without touching anything else: they are the heaviest fields of
the JevKnows state). Example message:

```
The state does not fit in the context of Laya checkpoint 'multilingual': it measures 1180
real tokens (checkpoint tokenizer), but the checkpoint accepts at most 950 for the state
(max_len=1024 minus 74 reserved for the heaviest question). Try disabling
recent_reporting and trader_notes in config.context.fields (they are the heaviest
fields of the state) and rerun.
Not truncating silently: a truncation would change the judgment without
anyone knowing.
```

This is not a remote edge case: the coordinator measured other production
states (rough estimate, not with the real tokenizer) around 890-1050
estimated tokens, close to the limit. With the same type of state, a scenario
with denser-than-usual news and comments can easily cross the threshold: it
must be treated as the normal case, not the exception, which is why the check
is an explicit guard before every call, not a try-with-recovery downstream.

## What was NOT verified / known limitations

- The behavior with `model: "typed-decisions"` was not measured (fine-tuned
  on specific synthetic workflows, not intended to be a silent default
  according to Laya's own README) nor with `"router"` (`laya.Router`, which
  picks the checkpoint based on the detected language): the bridge accepts it
  as a valid value and passes it to `laya.load(...)`, but a real predict was
  not run with that mode in this round of verification.
- The behavior on `device: "cuda"` was not measured: this machine does not
  have an NVIDIA GPU, so Laya's CUDA->CPU fallback code (`Agent.__init__`)
  was not exercised here.
- Latency on pure CPU was not measured directly: the automatic fallback to
  CPU (if MPS were unavailable) is verified only by reading `laya.Agent`'s
  source, not by forced execution.
- The `uv pip install laya` command installed into `~/.venv`, a detail of
  THIS machine's/`uv` environment. On another machine the path may differ:
  use `LAYA_PYTHON` if automatic detection in `platform/laya.js` does not
  find the right interpreter.

## Bridge architecture

- `platform/laya.js`: exposes `askLaya(state, questions, opts)` -> Promise
  `{ answers, ms, model }`, the same shape with which `platform/runner.js`
  already treats Jev and Kev. Manages a **persistent** Python process
  (`platform/laya_bridge.py`), never a spawn per request: loading a
  checkpoint costs seconds (verified: ~15s on the first download, loading an
  already-downloaded model into memory is faster but not free).
  JSON-lines protocol over stdin/stdout. If the process dies (crash, OOM),
  it is recreated automatically on the next request.
- `platform/laya_bridge.py`: loads Laya via `laya.load(...)`, keeps a cache
  of already-loaded checkpoints by name (`_agents`), performs the context
  budget check described above before every `predict`, and returns the
  versioned model id (`laya-<checkpoint>@<package version>`, e.g.
  `laya-multilingual@0.3.4`) so that `predictions.model` stays specific
  months from now, never a generic `"laya"`.
- If `laya` is not installed in the Python environment used by the bridge,
  the error is explicit and includes the install command
  (`uv pip install laya`), not an obscure crash or a silent timeout.
- `assertSafeRequest` (existing guard, unchanged) remains the only point
  through which the market price passes: it is called in `runner.js` BEFORE
  querying any engine, Laya included. The Laya bridge never sees the price,
  does not add it, and does not "enrich" the state: it receives `state`
  exactly as built by `toJevRequest` + `applyFields`, exactly like Jev.
