/**
 * Semantic recall: a small embedding model as a specialized station.
 *
 * Keyword search misses meaning — a memory saying "user wants local tooling,
 * no cloud" shares no words with a later query about "offline setup
 * preference". bge-small-en-v1.5 (134 MB, 384 dims) closes that gap. It is a
 * separate process from the generation model: different job, different model,
 * and it is small enough to keep resident.
 *
 * Vectors are compared by brute force in JS. At the scale this store holds
 * (hundreds to low thousands of memories) that is microseconds, and it avoids
 * a vector-index dependency for a problem we do not have.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { HOME, exe, llamaServerPath } from "./services.mjs";

export const EMBED_PORT = process.env.AMALGAM_EMBED_PORT ?? "8643";
export const EMBED_URL = process.env.AMALGAM_EMBED_URL ?? `http://127.0.0.1:${EMBED_PORT}`;
export const EMBED_MODEL_FILE = "bge-small-en-v1.5-f32.gguf";
export const EMBED_DIMS = 384;

export function embedModelPath() {
  const p = path.join(HOME, "models", EMBED_MODEL_FILE);
  return fs.existsSync(p) ? p : null;
}

export function embeddingsInstalled() {
  return Boolean(embedModelPath()) && fs.existsSync(llamaServerPath());
}

async function embedHealthy(timeoutMs = 2000) {
  try {
    const r = await fetch(`${EMBED_URL}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok && (await r.text()).includes("ok");
  } catch {
    return false;
  }
}

/** Start the embedding server if it is down. Small model: loads in seconds. */
export async function ensureEmbedServer(timeoutMs = 90000) {
  if (await embedHealthy()) return true;
  if (!embeddingsInstalled()) return false;
  const child = spawn(
    llamaServerPath(),
    ["-m", embedModelPath(), "--embeddings", "--host", "127.0.0.1", "--port", EMBED_PORT,
      "-c", "512", "--threads", String(Math.max(2, Math.min(4, os.cpus().length - 2)))],
    { detached: true, stdio: "ignore", windowsHide: true }
  );
  child.unref();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await embedHealthy()) return true;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

// bge-*-en-v1.5 is trained asymmetrically: stored passages are embedded as-is,
// but a query must carry this instruction or retrieval quality drops sharply.
export const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";

/**
 * Embed one or more strings. Returns Float32Array[], or null if unavailable.
 * Pass `{ query: true }` when embedding a search query rather than a stored
 * passage, so the instruction prefix is applied.
 */
export async function embed(texts, { query = false } = {}) {
  if (!(await ensureEmbedServer())) return null;
  const input = (Array.isArray(texts) ? texts : [texts])
    .map((t) => (query ? QUERY_PREFIX : "") + String(t).slice(0, 2000));
  const res = await fetch(`${EMBED_URL}/v1/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "bge-small", input }),
  });
  if (!res.ok) throw new Error(`embedding server HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  return (j.data ?? []).map((d) => {
    const v = Float32Array.from(d.embedding);
    // Normalize once at write time so similarity is a plain dot product.
    let n = 0;
    for (const x of v) n += x * x;
    n = Math.sqrt(n) || 1;
    for (let i = 0; i < v.length; i++) v[i] /= n;
    return v;
  });
}

/** Both vectors are unit length, so the dot product is the cosine. */
export function similarity(a, b) {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

export const toBlob = (vec) => Buffer.from(new Float32Array(vec).buffer);
export const fromBlob = (buf) => new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
