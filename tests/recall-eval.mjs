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
 * The eval seeds its OWN throwaway database (AMALGAM_DB in a temp dir) and
 * asserts only against those fixtures, so it gives the same verdict on a fresh
 * install as on a machine with years of memories — and never reads, ranks
 * against, or writes to your real memory.
 *
 * Usage: node tests/recall-eval.mjs
 * Requires: embeddings installed (amalgam install --with-embeddings).
 * Prints a pass/fail table and exits non-zero on failure.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const HOME = process.env.AMALGAM_HOME ?? path.join(os.homedir(), ".amalgam");
const SERVER = path.join(HOME, "mcp", "server.mjs");

// A disposable database for this run only. The real one is never opened.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "amalgam-eval-"));
const TMP_DB = path.join(TMP, "memory.db");

// Fixtures: what the eval pretends to remember. Deliberately ordinary content —
// a preference, a tool behaviour, a build recipe, a layout rule — so the cases
// below test retrieval, not any particular project.
const FIXTURES = [
  { kind: "preference", context: "setup",
    content: "User wants all tooling local, portable, no installers, no admin, no cloud. Only network call = frontier model." },
  { kind: "fact", context: "amalgam",
    content: "Work streams = git worktrees + disk reclamation. gc policy: dirty=never remove, pinned=keep, merged=remove worktree+delete branch, stale=free build dirs only. Build output does not count as dirty, else compiled worktrees are never reclaimable." },
  { kind: "fact", context: "api-server",
    content: "api-server clone at /srv/api-server, main branch, CMake+Ninja build, binary in build-local/release." },
  { kind: "constraint", context: "bmad",
    content: "BMAD is WORKSPACE-level: installed at the directory holding the repos (_bmad/, _bmad-output/), never inside a service. Its documents describe all services from above them." },
];

// Each case: a query, and a substring that must appear in the top-N result.
const CASES = [
  { q: "offline setup preference, avoid internet services", want: "no cloud", topN: 1 },
  { q: "what happens to leftover build directories", want: "reclamation", topN: 1 },
  { q: "how do I compile the service", want: "Ninja", topN: 2 },
  { q: "where do planning documents for several codebases live", want: "WORKSPACE", topN: 3 },
];

const srv = spawn(process.execPath, [SERVER], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, AMALGAM_DB: TMP_DB },
});
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

const cleanup = () => { try { srv.kill(); } catch {} try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} };

await rpc("initialize", { protocolVersion: "2025-06-18" });
for (const f of FIXTURES) await rpc("tools/call", { name: "memory_save_fact", arguments: f });

let failed = 0;
console.log("recall eval  (seeded fixtures, temp db)\n");
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
cleanup();
process.exit(failed ? 1 : 0);
