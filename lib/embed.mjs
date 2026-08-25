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

// One start attempt at a time, shared by everyone waiting for it.
//
// embed() calls this before every batch, so a large import calls it thousands
// of times. While the server is coming up — or after it has died mid-import —
// every one of those calls used to try to spawn its own copy, and Windows
// answers a burst of spawns with `spawn UNKNOWN`. That error then travelled
// all the way out of importGraph and killed an index that would have been
// perfectly usable without vectors.
let starting = null;

/** Start the embedding server if it is down. Small model: loads in seconds. */
export async function ensureEmbedServer(timeoutMs = 90000) {
  if (await embedHealthy()) return true;
  if (!embeddingsInstalled()) return false;
  starting ??= startEmbedServer(timeoutMs).finally(() => { starting = null; });
  return starting;
}

async function startEmbedServer(timeoutMs) {
  try {
    const child = spawn(
      llamaServerPath(),
      ["-m", embedModelPath(), "--embeddings", "--host", "127.0.0.1", "--port", EMBED_PORT,
        // Context, logical batch and physical batch all at the model's limit.
        // Without the batch flags the server refuses any single input longer
        // than its default physical batch — "input (547 tokens) is too large
        // to process" — which killed the index of every repository whose
        // symbols carry long signatures.
        "-c", String(MAX_TOKENS), "-b", String(MAX_TOKENS), "-ub", String(MAX_TOKENS),
        "--threads", String(Math.max(2, Math.min(4, os.cpus().length - 2)))],
      { detached: true, stdio: "ignore", windowsHide: true }
    );
    // spawn reports failure on the child, not by throwing, so both paths need
    // handling or an unhandled 'error' event takes the process down.
    child.on("error", () => {});
    child.unref();
  } catch {
    return false;   // could not start it; the caller degrades rather than dies
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await embedHealthy()) return true;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

// bge-small-en-v1.5 encodes at most 512 tokens; anything longer is truncated
// by the model anyway, and is rejected outright by the server if it exceeds
// the physical batch. Both limits are the same number, so it is named once.
const MAX_TOKENS = 512;

// Characters per token, low enough to be safe across code, prose and CJK. The
// previous limit was in characters and had no relationship to the token limit
// it needed to respect, which is how a 2000-character symbol description
// became a 547-token request against a 512-token server.
//
// Two rather than a friendlier three: dense C++ signatures tokenise at close
// to one token per two characters, and being wrong here does not degrade a
// result, it rejects the whole batch. What is embedded — a name, a path, a
// signature line and a short doc — fits comfortably inside the budget this
// gives, so nothing useful is being cut.
const CHARS_PER_TOKEN = 2;

/** Room for the query instruction, so a query cannot overflow where a passage would not. */
const budget = (query) => Math.floor((MAX_TOKENS - 32) * CHARS_PER_TOKEN) - (query ? QUERY_PREFIX.length : 0);

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

  const raw = (Array.isArray(texts) ? texts : [texts]).map((t) => String(t));
  const prefix = query ? QUERY_PREFIX : "";

  // No character budget is safe for every script. Latin code tokenises at
  // roughly two characters per token; CJK is closer to one per character, so
  // the same 976 characters can be 400 tokens or 962. Rather than guessing
  // conservatively enough to cripple ordinary text, the request corrects
  // itself: if the server says the input is too large, cut harder and ask
  // again. Two retries reach a quarter of the budget, which is below the
  // limit for any script.
  let cap = budget(query);
  let j = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const input = raw.map((t) => prefix + t.slice(0, cap));
    const res = await fetch(`${EMBED_URL}/v1/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "bge-small", input }),
    });
    if (res.ok) { j = await res.json(); break; }

    const body = (await res.text()).slice(0, 300);
    const tooLong = res.status === 500 && /too large to process|exceeds|n_ubatch|context/i.test(body);
    if (tooLong && attempt < 2) { cap = Math.floor(cap / 2); continue; }
    throw new Error(`embedding server HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  if (!j) return null;
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
