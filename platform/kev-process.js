/* On-demand lifecycle of the Kev server.
 *
 * Why it exists: Kev is a 4B model that keeps its weights in memory. On a
 * 32GB machine also used for other things, leaving it on 24/7 for a few
 * runs a day is memory taken from everything else. A launchd that keeps it
 * always on solves the wrong problem.
 *
 * Here we do the opposite: the server starts on the first request and shuts
 * itself down after a period of inactivity. The warm-up cost (about 40
 * seconds, measured) is paid only when it is actually needed.
 *
 * The trade-off is explicit: the first request after a pause is slow. For a
 * platform doing a handful of runs a day, that is the right direction to be
 * wrong in. Whoever wants the server always warm starts it by hand and this
 * module detects and reuses it without touching it (see `adopted`).
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const KEV_HOME = process.env.KEV_HOME ?? join(homedir(), "coding/_jev/kev");
export const KEV_PORT = Number(process.env.KEV_PORT ?? 8009);
const BASE = `http://127.0.0.1:${KEV_PORT}`;

/** How long it stays on without requests before shutting down. */
export const IDLE_MS = Number(process.env.KEV_IDLE_MINUTES ?? 10) * 60_000;
/** How long we wait for it to become ready after starting. */
const BOOT_TIMEOUT_MS = Number(process.env.KEV_BOOT_TIMEOUT_MS ?? 180_000);

let proc = null;          // the process we started, or null
let adopted = false;      // true if the server was already up: not ours, do not shut it down
let idleTimer = null;
let booting = null;       // shared promise, so N concurrent requests start only ONE server

/** Is the server responding? An empty POST is enough: even a 4xx still means "alive". */
async function isUp(timeoutMs = 2000) {
  try {
    const res = await fetch(`${BASE}/v1/systemone`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.status > 0;
  } catch { return false; }
}

/** The local snapshot of the weights: the --run flag does not accept the `@revision` pin. */
function snapshotPath() {
  const hub = join(homedir(), ".cache/huggingface/hub/models--jaredpalmer--kev-4b/snapshots");
  if (!existsSync(hub)) return null;
  const dirs = readdirSync(hub);
  return dirs.length ? join(hub, dirs[0]) : null;
}

function armIdleTimer() {
  clearTimeout(idleTimer);
  if (adopted || !proc) return;          // an adopted server is not ours to shut down
  idleTimer = setTimeout(() => stopKev("idle"), IDLE_MS);
  if (typeof idleTimer.unref === "function") idleTimer.unref();
}

/**
 * Ensures the server is reachable. Starts it if needed.
 * Concurrent calls share the same startup.
 */
export async function ensureKev({ log = console.log } = {}) {
  if (await isUp()) {
    if (!proc) adopted = true;           // it was already up before us
    armIdleTimer();
    return { ready: true, adopted, started: false };
  }
  if (booting) return booting;

  booting = (async () => {
    const snap = snapshotPath();
    if (!snap) throw new Error(
      "Kev's weights are not in the HuggingFace cache. Start it once by hand " +
      `from ${KEV_HOME} to download them, then try again.`);
    const python = join(KEV_HOME, ".venv/bin/python3");
    if (!existsSync(python)) throw new Error(
      `Kev's Python environment was not found at ${python}. ` +
      "Check KEV_HOME, or run `uv sync --extra serve` in Kev's repo.");

    log(`[kev] starting on demand, warm-up in progress (up to ${Math.round(BOOT_TIMEOUT_MS / 1000)}s)`);
    proc = spawn(python, ["-m", "kev.serve", "--run", snap, "--port", String(KEV_PORT)], {
      cwd: KEV_HOME,
      // KEV_MERGE=0 skips the fp32 LoRA merge: on Apple Silicon it is extremely
      // slow and prints nothing, so it looks stuck while it is actually working.
      env: { ...process.env, KEV_DTYPE: "bf16", KEV_MERGE: "0" },
      stdio: "ignore",
      detached: false,
    });
    adopted = false;
    proc.on("exit", () => { proc = null; });

    const deadline = Date.now() + BOOT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!proc) throw new Error("The Kev server died during startup.");
      if (await isUp()) {
        log("[kev] ready");
        armIdleTimer();
        return { ready: true, adopted: false, started: true };
      }
      await new Promise(r => setTimeout(r, 2000));
    }
    stopKev("startup failed");
    throw new Error(
      `The Kev server did not become ready within ${Math.round(BOOT_TIMEOUT_MS / 1000)}s. ` +
      "Start it by hand to see the error: " +
      `cd ${KEV_HOME} && KEV_DTYPE=bf16 KEV_MERGE=0 .venv/bin/python3 -m kev.serve --run <snapshot> --port ${KEV_PORT}`);
  })().finally(() => { booting = null; });

  return booting;
}

/** Postpones the shutdown: call after every successful request. */
export function touchKev() { armIdleTimer(); }

export function stopKev(reason = "requested") {
  clearTimeout(idleTimer);
  if (proc && !adopted) {
    console.log(`[kev] shutting down the server (${reason}), freeing memory`);
    try { proc.kill(); } catch { /* already dead */ }
  }
  proc = null;
}

export function kevStatus() {
  return {
    running: Boolean(proc) || adopted,
    ours: Boolean(proc) && !adopted,
    adopted,
    idleMinutes: IDLE_MS / 60_000,
    port: KEV_PORT,
    home: KEV_HOME,
  };
}

// if the platform server dies, do not leave an orphaned 4B model in memory
for (const sig of ["exit", "SIGINT", "SIGTERM"]) {
  process.on(sig, () => stopKev("platform shutdown"));
}
