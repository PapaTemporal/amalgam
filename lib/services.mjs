/**
 * Optional local model control.
 *
 * Memory needs no service at all — it is SQLite in a file (see db.mjs). The
 * only long-running process amalgam can start is llama-server, and it is
 * optional: it holds ~3.6 GB once its model loads, so it starts lazily on the
 * first tool that actually needs it, and stays absent entirely on machines
 * installed without `--with-model`.
 *
 * Lazy start was only half the bargain. A model that loads on demand and then
 * sits on 3.6 GB until the machine reboots is worse than one that never
 * started, because the cost is invisible: nothing in the session mentions it
 * and nobody thinks to run `amalgam stop`. So each use stamps a file and a
 * detached watchdog shuts the server down once it has been idle long enough.
 */
import * as childProcess from "node:child_process";
const { spawn } = childProcess;
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const WIN = process.platform === "win32";
export const HOME = process.env.AMALGAM_HOME ?? path.join(os.homedir(), ".amalgam");
export const exe = (n) => (WIN ? `${n}.exe` : n);
export const LLAMA_PORT = process.env.AMALGAM_LLAMA_PORT ?? "8642";
export const LLAMA_URL = process.env.AMALGAM_LLAMA_URL ?? `http://127.0.0.1:${LLAMA_PORT}`;

/** Minutes of disuse before the model is shut down. 0 disables the watchdog. */
export const IDLE_MINUTES = Number(process.env.AMALGAM_LLAMA_IDLE_MIN ?? 15);
export const LAST_USE_FILE = path.join(HOME, "llama.lastuse");

/** Record that the model was just used. Cheap enough to call on every request. */
export function touchLlamaUse() {
  try {
    fs.mkdirSync(HOME, { recursive: true });
    fs.writeFileSync(LAST_USE_FILE, String(Date.now()));
  } catch { /* a missing stamp only means the watchdog waits longer */ }
}

export function minutesIdle() {
  try {
    const at = Number(fs.readFileSync(LAST_USE_FILE, "utf8"));
    if (!Number.isFinite(at)) return null;
    return (Date.now() - at) / 60000;
  } catch { return null; }
}

/** Stop llama-server if it is running. Used by `amalgam stop` and the watchdog. */
export function stopLlama() {
  if (WIN) childProcess.spawnSync("taskkill", ["/IM", "llama-server.exe", "/F"], { stdio: "ignore" });
  else childProcess.spawnSync("pkill", ["-f", "llama-server"], { stdio: "ignore" });
}

export const MODEL_FILE = "Qwen3-4B-Instruct-2507-Q4_K_M.gguf";
export const MODEL_PART1 = "Qwen3-4B-Instruct-2507-Q4_K_M-00001-of-00002.gguf";

/** Single-file model if present, else the split GGUF's first part, else null. */
export function modelPath() {
  const single = path.join(HOME, "models", MODEL_FILE);
  const split = path.join(HOME, "models", MODEL_PART1);
  return fs.existsSync(single) ? single : fs.existsSync(split) ? split : null;
}

export function llamaServerPath() {
  return path.join(HOME, "runtime", "llama", exe("llama-server"));
}

/**
 * Flags that pin llama-server to the CPU.
 *
 * The target is a virtual machine — an ESXi Windows guest, a VDI session — with
 * no GPU to offload to. On Windows that is settled by packaging: the mirrored
 * build is `win-cpu-x64`, and there is nothing else in it. On macOS it cannot
 * be: llama.cpp publishes no CPU-only build for arm64, the one it does publish
 * carries Metal, and `--list-devices` on that binary reports a real device.
 * llama.cpp offloads to whatever it finds unless told not to.
 *
 * So the guarantee is made at launch rather than at packaging, where it holds
 * whatever the binary was compiled with — including on Windows, if a future
 * mirrored build ever quietly gains a backend.
 *
 * `--device none` empties the offload device list; `-ngl 0` keeps every layer
 * in system memory. Either alone would do; both are here because this is not a
 * requirement that should rest on one flag keeping its meaning across releases.
 */
export const CPU_ONLY = ["--device", "none", "-ngl", "0"];

/** Where the GPU opt-in is remembered. Under HOME, so it travels with the install. */
export const GPU_FILE = path.join(HOME, "gpu.json");

/**
 * Has someone deliberately turned the GPU on?
 *
 * The default is no, and the default is the product: this runs on machines with
 * no GPU, and a stack that quietly used one wherever it found one would be
 * untestable on the hardware it is actually deployed to.
 *
 * Note what this function does *not* do. It never asks the machine what it has.
 * Detection would make behaviour depend on hardware rather than on a decision,
 * so the same install would offload on the developer's laptop and not on the
 * VM it ships to, and the difference would surface as a performance mystery
 * rather than as a setting. Somebody says yes, or the answer is no.
 *
 * AMALGAM_GPU=1/0 overrides the file for a single run — useful for a
 * measurement, and for a machine where HOME is read-only.
 */
export function gpuEnabled() {
  if (process.env.AMALGAM_GPU === "1") return true;
  if (process.env.AMALGAM_GPU === "0") return false;
  try {
    return JSON.parse(fs.readFileSync(GPU_FILE, "utf8")).enabled === true;
  } catch {
    return false;   // absent, unreadable or malformed all mean "not asked for"
  }
}

/**
 * The device flags every llama-server launch gets. CPU_ONLY unless the opt-in
 * above says otherwise, in which case layers are offloaded — all of them by
 * default, or AMALGAM_GPU_LAYERS if a number was chosen.
 *
 * Both servers go through here, so the opt-in cannot be half-applied: there is
 * no configuration in which the generation model uses a GPU and the embedding
 * model does not, or the reverse.
 */
export function deviceArgs() {
  if (!gpuEnabled()) return CPU_ONLY;
  const layers = process.env.AMALGAM_GPU_LAYERS ?? "999";
  return ["-ngl", String(layers)];
}

export function modelInstalled() {
  return Boolean(modelPath()) && fs.existsSync(llamaServerPath());
}

export async function llamaHealthy(timeoutMs = 2000) {
  try {
    const r = await fetch(`${LLAMA_URL}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok && (await r.text()).includes("ok");
  } catch {
    return false;
  }
}

/** Start llama-server if down and wait for the model to load. */
// One start attempt at a time, for the same reason as the embedding server:
// concurrent callers racing to spawn produce `spawn UNKNOWN` on Windows.
let startingLlama = null;

export async function ensureLlama(timeoutMs = 180000) {
  if (await llamaHealthy()) return true;
  if (!modelInstalled()) return false;
  startingLlama ??= startLlama(timeoutMs).finally(() => { startingLlama = null; });
  return startingLlama;
}

async function startLlama(timeoutMs) {
  try {
    const child = spawn(
      llamaServerPath(),
      ["-m", modelPath(), "--host", "127.0.0.1", "--port", LLAMA_PORT, "-c", "8192",
        ...deviceArgs(),
        "--threads", String(Math.max(2, os.cpus().length - 2))],
      { detached: true, stdio: "ignore", windowsHide: true }
    );
    child.on("error", () => {});
    child.unref();
  } catch {
    return false;
  }
  startIdleWatchdog();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await llamaHealthy()) return true;
    await new Promise((r) => setTimeout(r, 3000));
  }
  return false;
}

/**
 * Start the watchdog that shuts an idle model down.
 *
 * Detached and outside whichever process asked for the model, because the
 * asker is usually an MCP server or a one-shot hook that exits long before the
 * model stops being useful. One watchdog is enough: it refuses to start a
 * second if a live one already holds the lock file.
 */
export function startIdleWatchdog() {
  if (!IDLE_MINUTES) return;
  touchLlamaUse();
  const lock = path.join(HOME, "llama.watchdog");
  try {
    // A stamp newer than two poll intervals means a watchdog is already awake.
    const at = Number(fs.readFileSync(lock, "utf8"));
    if (Number.isFinite(at) && Date.now() - at < 150000) return;
  } catch { /* no lock, no watchdog */ }
  try {
    // Deployed copy first, then this checkout — the same file either way.
    const deployed = path.join(HOME, "lib", "idle-watch.mjs");
    const local = fileURLToPath(new URL("./idle-watch.mjs", import.meta.url));
    const target = fs.existsSync(deployed) ? deployed : local;
    const child = spawn(process.execPath, [target], { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
  } catch { /* the model simply stays up, as it did before */ }
}
