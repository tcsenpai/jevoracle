"""Persistent Python bridge to Laya (https://github.com/NandhaKishorM/laya).

Protocol: JSON-lines over stdin/stdout. One line in, one line out.
The process stays alive between requests: loading a checkpoint costs seconds
(the first download from HuggingFace even tens of seconds), and doing it
again on every question would be unusable. platform/laya.js starts it once
and talks to it for as long as it is needed.

Request (one line of JSON):
  {"cmd": "predict", "state": {...}, "questions": {...}, "model": "multilingual", "device": "auto"}
  {"cmd": "ping"}

Response (one line of JSON):
  {"ok": true, "answers": {...}, "model": "laya-multilingual@0.3.4", "ms": 123,
   "input_tokens": 610, "max_len": 1024}
  {"ok": false, "error": "..."}

The context budget check happens HERE, before calling the model: Laya itself
silently truncates the state if it exceeds max_len (see
laya/common.py:build_sequence, "st = st[:room]"). A silent truncation would
change the judgment without anyone noticing, so the state is measured with
the checkpoint's REAL tokenizer and, if it does not fit, the request fails
with an explicit error instead of proceeding truncated.
"""
import json
import sys
import traceback

_agents = {}  # checkpoint name -> already loaded laya.Agent, process-level cache

# Aliases accepted by the bridge, the same ones laya.Router recognizes.
_MODEL_SUBFOLDER = {
    "english": None,
    "router": None,          # routed later: here "router" is equivalent to english as a fallback
    "multilingual": "multilingual",
    "typed-decisions": "typed-decisions",
}


def _log(msg):
    # Never on stdout: that is the protocol channel. stderr is for logs.
    print(f"[laya_bridge] {msg}", file=sys.stderr, flush=True)


def _resolve_device(requested):
    import torch
    if requested and requested != "auto":
        return requested
    if torch.cuda.is_available():
        return "cuda"
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def _get_agent(model_name, device):
    """Loads (or reuses from cache) the requested Laya checkpoint."""
    key = model_name or "english"
    if key not in _MODEL_SUBFOLDER:
        raise ValueError(
            f"unknown Laya model: {key!r}. Valid values: "
            f"{sorted(_MODEL_SUBFOLDER)} (or 'router' for automatic selection)."
        )
    cache_key = f"{key}:{device}"
    if cache_key in _agents:
        return _agents[cache_key]

    try:
        import laya
    except ModuleNotFoundError as e:
        raise RuntimeError(
            "The Python package 'laya' is not installed in the environment used by this bridge. "
            "Install it with: uv pip install laya (repo: https://github.com/NandhaKishorM/laya). "
            f"Original detail: {e}"
        ) from e

    subfolder = _MODEL_SUBFOLDER[key]
    _log(f"loading Laya checkpoint '{key}' (subfolder={subfolder}) on device={device}, may take a few seconds...")
    agent = laya.load("convaiinnovations/laya", subfolder=subfolder, device=device)
    _agents[cache_key] = agent
    _log(f"checkpoint '{key}' ready on {agent.device}")
    return agent


def _check_context_budget(agent, model_name, state, questions):
    """Measures the state with the checkpoint's REAL tokenizer and raises if it does not fit.

    Replicates the same serialization as laya.common.serialize_state so the
    count matches exactly what Laya would see.
    The budget available for the state also depends on the header of the
    heaviest question (head_max_len reserved for options/instructions), so
    the comparison uses the worst case: the question with the longest instructions.
    """
    from laya.common import serialize_state

    max_len = agent.cfg.get("max_len", 512)
    head_max_len = agent.cfg.get("head_max_len", 192)

    raw_state = serialize_state(state)
    state_tokens = len(agent.tok(raw_state, add_special_tokens=False)["input_ids"])

    # Conservative estimate of the header's footprint (instructions + options +
    # [CLS]/[SEP] markers) for the heaviest question in the batch: this is what
    # reduces the space actually available for the state within max_len.
    worst_head_tokens = 8  # [CLS] + [SEP] + final [SEP], minimum structural cost
    for qid, q in (questions or {}).items():
        ins = str(q.get("instructions", ""))
        ins_tokens = len(agent.tok(f"{q.get('type','noul')} question: {ins}", add_special_tokens=False)["input_ids"])
        worst_head_tokens = max(worst_head_tokens, min(ins_tokens, head_max_len) + 8)

    room_for_state = max_len - worst_head_tokens
    if state_tokens > room_for_state:
        # The heaviest fields of the JevKnows state are news and trader comments
        # (recent_reporting, trader_notes): they can already be disabled from
        # config.context.fields, so the message suggests exactly those.
        heavy_fields = [k for k in ("recent_reporting", "trader_notes") if isinstance(state, dict) and k in state]
        suggestion = (
            f"Try disabling {' and '.join(heavy_fields)} in config.context.fields "
            "(they are the heaviest fields of the state) and rerun."
            if heavy_fields else
            "Reduce the state sent to the engine: there is no obvious field to turn off here."
        )
        raise RuntimeError(
            f"The state does not fit in the Laya checkpoint '{model_name}' context: "
            f"it measures {state_tokens} real tokens (checkpoint tokenizer), "
            f"but the checkpoint accepts at most {room_for_state} for the state "
            f"(max_len={max_len} minus {worst_head_tokens} reserved for the heaviest question). "
            f"{suggestion} "
            "Not truncating silently: a truncation would change the judgment without anyone knowing."
        )
    return {"state_tokens": state_tokens, "room_for_state": room_for_state, "max_len": max_len}


def _package_version():
    try:
        import laya
        return getattr(laya, "__version__", "?")
    except Exception:
        return "?"


def handle_predict(req):
    import time

    state = req.get("state")
    questions = req.get("questions")
    if state is None or not questions:
        raise ValueError("'predict' request without state or questions")

    model_name = req.get("model") or "multilingual"
    device = _resolve_device(req.get("device"))

    agent = _get_agent(model_name, device)
    budget = _check_context_budget(agent, model_name, state, questions)

    t0 = time.time()
    result = agent.system_one(state, questions)
    ms = int((time.time() - t0) * 1000)

    version = _package_version()
    resolved_key = model_name if model_name in _MODEL_SUBFOLDER else "english"
    model_id = f"laya-{resolved_key}@{version}"

    return {
        "ok": True,
        "answers": result["answers"],
        "model": model_id,
        "ms": ms,
        "input_tokens": budget["state_tokens"],
        "max_len": budget["max_len"],
        "device": str(agent.device),
    }


def handle_ping(req):
    return {"ok": True, "pong": True, "laya_version": _package_version()}


HANDLERS = {"predict": handle_predict, "ping": handle_ping}


def main():
    _log("bridge started, waiting for requests on stdin (JSON-lines)")
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            cmd = req.get("cmd")
            handler = HANDLERS.get(cmd)
            if handler is None:
                raise ValueError(f"unknown command: {cmd!r} (valid: {sorted(HANDLERS)})")
            resp = handler(req)
        except Exception as e:
            resp = {"ok": False, "error": str(e), "traceback": traceback.format_exc()}
        sys.stdout.write(json.dumps(resp) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
