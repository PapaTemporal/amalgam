/**
 * Optional local model control.
 *
 * Memory needs no service at all — it is SQLite in a file (see db.mjs). The
 * only long-running process amalgam can start is llama-server, and it is
 * optional: it holds ~3.6 GB once its model loads, so it starts lazily on the
 * first tool that actually needs it, and stays absent entirely on machines
 * installed without `--with-model`.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const WIN = process.platform === "win32";
export const HOME = process.env.AMALGAM_HOME ?? path.join(os.homedir(), ".amalgam");
export const exe = (n) => (WIN ? `${n}.exe` : n);
export const LLAMA_PORT = process.env.AMALGAM_LLAMA_PORT ?? "8642";
export const LLAMA_URL = process.env.AMALGAM_LLAMA_URL ?? `http://127.0.0.1:${LLAMA_PORT}`;

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
export async function ensureLlama(timeoutMs = 180000) {
  if (await llamaHealthy()) return true;
  if (!modelInstalled()) return false;
  const child = spawn(
    llamaServerPath(),
    ["-m", modelPath(), "--host", "127.0.0.1", "--port", LLAMA_PORT, "-c", "8192",
      "--threads", String(Math.max(2, os.cpus().length - 2))],
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
