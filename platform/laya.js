/* Bridge to Laya (https://github.com/NandhaKishorM/laya), an alternative
 * judgment engine to Jev.
 *
 * Laya is not an LLM: it is a typed System 1 decision engine, not
 * autoregressive, that runs LOCALLY via Python + PyTorch. The primitives
 * (noul, choice, score) and the shape of the response are the same as Jev's,
 * but there is no HTTP API: it is a Python library. The bridge is therefore
 * a persistent Python process (platform/laya_bridge.py) spoken to in
 * JSON-lines over stdin/stdout, never one spawn per request: loading a
 * checkpoint costs seconds (the first download from HuggingFace even more),
 * and repeating that cost on every question would make the engine unusable.
 *
 * If the process dies (Python crash, OOM, etc), it is restarted on the next
 * request: there is no state shared with the rest of the platform besides
 * the checkpoints already loaded in the Python process's memory, which are
 * lost and reloaded.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BRIDGE_SCRIPT = join(__dirname, "laya_bridge.py");

/** Valid Laya models on the config side. "router" delegates the choice to
 *  Laya based on the language detected in the state; we prefer an explicit
 *  checkpoint to stay predictable and traceable (see requirement 3 of the
 *  brief), but the value is accepted for whoever wants it anyway. */
export const LAYA_MODELS = ["english", "multilingual", "typed-decisions", "router"];
export const DEFAULT_LAYA_MODEL = "multilingual";

const ENGINE_NAMES = ["jev", "laya", "kev", "quorum"];

/**
 * Validates and normalizes config.context.engine as it arrives from the API.
 * Validates only what concerns Laya (model, device): the other engines
 * (kev, quorum) have their own free-form fields, validated elsewhere if
 * needed. A missing or unrecognized value falls back to the platform's
 * default (DEFAULT_ENGINE in runner.js, today the three-way weighted
 * quorum): a malformed config must not break a bot, but must also not
 * silently switch its engine relative to what the platform declares as
 * default.
 */
/* Repeated here rather than imported from runner.js to avoid an import
 * cycle (runner.js imports this module). If it changes there, change it
 * here too. */
const DEFAULT_ENGINE = {
  name: "quorum", engines: ["jev", "laya", "kev"],
  weights: { jev: 3.1, laya: 1, kev: 2 },
};

export function normaliseEngine(cfg) {
  if (!cfg || typeof cfg !== "object" || !ENGINE_NAMES.includes(cfg.name)) {
    return { ...DEFAULT_ENGINE };
  }
  if (cfg.name !== "laya") return cfg;

  const model = LAYA_MODELS.includes(cfg.model) ? cfg.model : DEFAULT_LAYA_MODEL;
  const device = ["auto", "cpu", "mps", "cuda"].includes(cfg.device) ? cfg.device : "auto";
  return { ...cfg, name: "laya", model, device };
}

/** Candidate Python interpreters with laya installed, in order of
 *  preference. `uv pip install laya` in this environment installed the
 *  package inside ~/.venv, not in the system python3 (verified: import laya
 *  fails on the PATH's python3, works on ~/.venv/bin/python3). */
function candidatePythons() {
  const out = [];
  if (process.env.LAYA_PYTHON) out.push(process.env.LAYA_PYTHON);
  const home = process.env.HOME;
  if (home) out.push(join(home, ".venv", "bin", "python3"));
  out.push("python3");
  return out;
}

function resolvePython() {
  for (const p of candidatePythons()) {
    // an absolute path we verify, a bare name (e.g. "python3") we let
    // resolve against the child process's PATH
    if (p.includes("/") && !existsSync(p)) continue;
    return p;
  }
  return "python3";
}

let proc = null;       // persistent Python process, or null if not started yet/dead
let stdoutBuf = "";
let pending = [];      // queue of { resolve, reject } in send order (strictly sequential protocol)

function ensureProcess() {
  if (proc && !proc.killed) return proc;

  const python = resolvePython();
  proc = spawn(python, [BRIDGE_SCRIPT], {
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });

  stdoutBuf = "";

  proc.stdout.on("data", chunk => {
    stdoutBuf += chunk.toString("utf8");
    let idx;
    while ((idx = stdoutBuf.indexOf("\n")) >= 0) {
      const line = stdoutBuf.slice(0, idx).trim();
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (!line) continue;
      const waiter = pending.shift();
      if (!waiter) continue; // line with no request waiting: discarded, nowhere to deliver it
      try {
        const resp = JSON.parse(line);
        waiter.resolve(resp);
      } catch (e) {
        waiter.reject(new Error(`Laya bridge response is not valid JSON: ${line.slice(0, 200)}`));
      }
    }
  });

  proc.stderr.on("data", chunk => {
    // the bridge's logs go to stderr by design (see laya_bridge.py:_log):
    // we forward them here so they stay visible, without polluting stdout.
    process.stderr.write(`[laya] ${chunk.toString("utf8")}`);
  });

  const die = reason => {
    const err = new Error(
      `The Laya process has terminated (${reason}). It will be restarted on the next request. ` +
      `If the error persists, check that 'laya' is installed: uv pip install laya ` +
      `(repo: https://github.com/NandhaKishorM/laya).`);
    const waiting = pending;
    pending = [];
    proc = null;
    for (const w of waiting) w.reject(err);
  };
  proc.on("exit", (code, signal) => die(`exit code=${code} signal=${signal}`));
  proc.on("error", err => die(String(err.message ?? err)));

  return proc;
}

/** Sends a command to the bridge and waits for the matching response.
 *  The protocol is strictly sequential (one line in, one line out, in the
 *  same order): no correlation id is needed as long as nobody sends in
 *  parallel on the same process. */
function sendCommand(req, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const idx = pending.indexOf(waiter);
      if (idx >= 0) pending.splice(idx, 1);
      reject(new Error(`the Laya bridge did not respond within ${timeoutMs}ms (command ${req.cmd})`));
    }, timeoutMs);

    const waiter = {
      resolve: resp => { if (settled) return; settled = true; clearTimeout(timer); resolve(resp); },
      reject: err => { if (settled) return; settled = true; clearTimeout(timer); reject(err); },
    };

    let p;
    try {
      p = ensureProcess();
    } catch (err) {
      clearTimeout(timer);
      reject(new Error(
        `Could not start the Laya process: ${err.message ?? err}. ` +
        `Install the package with: uv pip install laya (repo: https://github.com/NandhaKishorM/laya).`));
      return;
    }

    pending.push(waiter);
    try {
      p.stdin.write(JSON.stringify(req) + "\n");
    } catch (err) {
      clearTimeout(timer);
      const idx = pending.indexOf(waiter);
      if (idx >= 0) pending.splice(idx, 1);
      reject(new Error(`write to the Laya process failed: ${err.message ?? err}`));
    }
  });
}

/**
 * Asks Laya for a judgment. Same return shape as the Jev engine:
 * { answers, ms, model }.
 *
 * @param {object} state       the state already passed through assertSafeRequest upstream
 * @param {object} questions   the same typed questions sent to Jev
 * @param {object} opts        { model: "english"|"multilingual"|"typed-decisions"|"router",
 *                                device: "auto"|"cpu"|"mps"|"cuda", timeoutMs }
 * @returns {Promise<{answers: object, ms: number, model: string}>}
 */
export async function askLaya(state, questions, opts = {}) {
  const model = LAYA_MODELS.includes(opts.model) ? opts.model : DEFAULT_LAYA_MODEL;
  const device = opts.device ?? "auto";
  // the first load of a checkpoint downloads weights from HuggingFace: minutes,
  // not seconds, if the network is slow. The default timeout is generous on purpose.
  const timeoutMs = opts.timeoutMs ?? 180_000;

  const resp = await sendCommand({ cmd: "predict", state, questions, model, device }, timeoutMs);

  if (!resp.ok) {
    throw new Error(`Laya: ${resp.error ?? "unknown error from the bridge"}`);
  }
  armIdleTimer();   // request served: postpone the idle shutdown
  return { answers: resp.answers, ms: resp.ms, model: resp.model };
}

/* Idle shutdown, same criterion as Kev: the checkpoint occupies memory even
 * while not answering anyone, and on a machine also used for other things
 * there is no reason to keep it resident between runs. The reload cost is
 * paid only after a real pause. */
export const LAYA_IDLE_MS = Number(process.env.LAYA_IDLE_MINUTES ?? 10) * 60_000;
let idleTimer = null;

function armIdleTimer() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (proc && !proc.killed) {
      console.log("[laya] shutting down the process (idle), freeing memory");
      stopLaya();
    }
  }, LAYA_IDLE_MS);
  if (typeof idleTimer.unref === "function") idleTimer.unref();
}

/** Closes the persistent Python process, if active. Useful in tests and for clean shutdown. */
export function stopLaya() {
  clearTimeout(idleTimer);
  if (proc && !proc.killed) proc.kill();
  proc = null;
}

// do not leave an orphaned checkpoint in memory if the platform shuts down
for (const sig of ["exit", "SIGINT", "SIGTERM"]) {
  process.on(sig, () => stopLaya());
}
