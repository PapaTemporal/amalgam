#!/usr/bin/env node
/**
 * Recall evaluation — paraphrase queries whose wording deliberately shares as
 * little as possible with the memory that should answer them.
 *
 * This exists so retrieval quality is a measurement rather than an impression.
 * Semantic ranking was tuned against these cases once; keep them honest by
 * adding a case whenever recall misses something in real use, and never by
 * loosening one that fails.
 *
 * Usage: node tests/recall-eval.mjs
 * Requires: embeddings installed (amalgam install --with-embeddings) and some
 * memories stored. Prints a pass/fail table and exits non-zero on failure.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";

const HOME = process.env.AMALGAM_HOME ?? path.join(os.homedir(), ".amalgam");
const SERVER = path.join(HOME, "mcp", "server.mjs");

// Each case: a query, and a substring that must appear in the top-N result.
const CASES = [
  { q: "offline setup preference, avoid internet services", want: "no cloud", topN: 1 },
  { q: "what happens to leftover build directories", want: "reclamation", topN: 1 },
  { q: "how do I compile the music notation app", want: "Ninja", topN: 2 },
  { q: "where do planning documents for several codebases live", want: "WORKSPACE", topN: 3 },
];

const srv = spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "inherit"] });
let buf = "";
const pending = new Map();
srv.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) { const m = JSON.parse(line); pending.get(m.id)?.(m); }
  }
});
let id = 0;
const rpc = (method, params) => new Promise((r) => {
  pending.set(++id, r);
  srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
});

await rpc("initialize", { protocolVersion: "2025-06-18" });

let failed = 0;
console.log("recall eval\n");
for (const c of CASES) {
  const res = await rpc("tools/call", { name: "memory_recall", arguments: { query: c.q, limit: 5 } });
  const lines = (res.result?.content?.[0]?.text ?? "").split("\n").filter(Boolean);
  const hitIndex = lines.findIndex((l) => l.includes(c.want));
  const pass = hitIndex >= 0 && hitIndex < c.topN;
  if (!pass) failed++;
  console.log(`${pass ? "PASS" : "FAIL"}  "${c.q}"`);
  console.log(`      want "${c.want}" in top ${c.topN} — ${hitIndex < 0 ? "not found" : `found at ${hitIndex + 1}`}`);
}
console.log(`\n${CASES.length - failed}/${CASES.length} passed`);
srv.kill();
process.exit(failed ? 1 : 0);
