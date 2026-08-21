/**
 * Shared service control for the amalgam runtime.
 *
 * Lazy-start policy: PostgreSQL is cheap (~50 MB) and every memory call needs
 * it, so it is started on demand without asking. llama-server holds ~3.6 GB
 * once its model is loaded, so it starts only when a caveman_* tool is
 * actually used — idle sessions never pay for it.
 */
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const WIN = process.platform === "win32";
export const HOME = process.env.AMALGAM_HOME ?? path.join(os.homedir(), ".amalgam");
export const exe = (n) => (WIN ? `${n}.exe` : n);
export const PG_PORT = process.env.AMALGAM_PG_PORT ?? "5455";
export const LLAMA_PORT = process.env.AMALGAM_LLAMA_PORT ?? "8642";
export const LLAMA_URL = process.env.AMALGAM_LLAMA_URL ?? `http://127.0.0.1:${LLAMA_PORT}`;
export const pgBin = (n) => path.join(HOME, "runtime", "pgsql", "bin", exe(n));

const PG_DATA = path.join(HOME, "data", "pg");
const MODEL_FILE = "Qwen3-4B-Instruct-2507-Q4_K_M.gguf";
const MODEL_PART1 = "Qwen3-4B-Instruct-2507-Q4_K_M-00001-of-00002.gguf";

export function pgRunning() {
  if (!fs.existsSync(pgBin("pg_isready"))) return false;
  return spawnSync(pgBin("pg_isready"), ["-h", "127.0.0.1", "-p", PG_PORT], { stdio: "ignore" }).status === 0;
}

/** Start PostgreSQL if it is down. Returns true when it is accepting connections. */
export function ensurePg() {
  if (pgRunning()) return true;
  if (!fs.existsSync(pgBin("pg_ctl")) || !fs.existsSync(path.join(PG_DATA, "PG_VERSION"))) return false;
  spawnSync(
    pgBin("pg_ctl"),
    ["-D", PG_DATA, "-o", `-p ${PG_PORT} -c listen_addresses=127.0.0.1`, "-l", path.join(HOME, "data", "pg.log"), "-w", "start"],
    { stdio: ["ignore", "ignore", "ignore"] }
  );
  return pgRunning();
}

export async function llamaHealthy(timeoutMs = 2000) {
  try {
    const r = await fetch(`${LLAMA_URL}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok && (await r.text()).includes("ok");
  } catch {
    return false;
  }
}

/** Single-file model if present, else the split GGUF's first part. */
export function modelPath() {
  const single = path.join(HOME, "models", MODEL_FILE);
  const split = path.join(HOME, "models", MODEL_PART1);
  return fs.existsSync(single) ? single : fs.existsSync(split) ? split : null;
}

/** Start llama-server if down and wait for the model to load. */
export async function ensureLlama(timeoutMs = 180000) {
  if (await llamaHealthy()) return true;
  const model = modelPath();
  const server = path.join(HOME, "runtime", "llama", exe("llama-server"));
  if (!model || !fs.existsSync(server)) return false;
  const child = spawn(
    server,
    ["-m", model, "--host", "127.0.0.1", "--port", LLAMA_PORT, "-c", "8192", "--threads", String(Math.max(2, os.cpus().length - 2))],
    { detached: true, stdio: "ignore", windowsHide: true }
  );
  child.unref();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await llamaHealthy()) return true;
    await new Promise((r) => setTimeout(r, 3000));
  }
  return false;
}
