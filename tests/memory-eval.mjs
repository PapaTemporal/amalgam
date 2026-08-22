#!/usr/bin/env node
/**
 * Memory-integrity evaluation.
 *
 * Recall quality is measured next door in recall-eval. This measures the other
 * half of the bargain: that what recall returns is not quietly wrong. A store
 * that answers fast and confidently with last month's truth costs more than
 * one that answers nothing, because the frontier model pays context for the
 * mistake and then pays again for the correction.
 *
 * Like recall-eval, this seeds its own throwaway database through AMALGAM_DB
 * and never touches real memory.
 *
 * Usage: node tests/memory-eval.mjs
 */
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Test the code in this checkout, not whatever is deployed to ~/.amalgam.
const SERVER = path.join(PKG, "mcp", "server.mjs");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "amalgam-mem-"));
const TMP_DB = path.join(TMP, "memory.db");
// A directory that exists for the duration of the run, and one that never did.
const REAL_DIR = TMP;
const DEAD_DIR = path.join(TMP, "runtime", "pgsql");

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
const call = async (name, args) => (await rpc("tools/call", { name, arguments: args })).result?.content?.[0]?.text ?? "";

let failed = 0;
const check = (name, pass, detail) => {
  if (!pass) failed++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
  if (detail) console.log(`      ${detail}`);
};

await rpc("initialize", { protocolVersion: "2025-06-18" });
console.log("memory integrity eval  (seeded fixtures, temp db)\n");

// --- 1. a fact naming a live path verifies clean, a dead one is flagged ------
const okSave = await call("memory_save_fact", {
  content: `Scratch workspace for this run lives at ${REAL_DIR} and is writable.`,
  context: "eval",
});
check("live path saves without warning", !okSave.includes("Careful:"), okSave.split("\n")[0]);

const deadSave = await call("memory_save_fact", {
  content: `Portable Postgres runtime at ${DEAD_DIR}, port 5455, started by the wire hook.`,
  context: "eval",
});
check("dead path is flagged at write time", deadSave.includes("Careful:"),
  deadSave.split("\n").find((l) => l.includes("Careful:")) ?? deadSave.split("\n")[0]);

// --- 2. recall marks the stale fact rather than hiding it -------------------
const staleRecall = await call("memory_recall", { query: "postgres runtime port", limit: 5 });
check("recall annotates the stale fact", /!stale:/.test(staleRecall),
  staleRecall.split("\n").find((l) => l.includes("!stale")) ?? staleRecall.slice(0, 120));

// --- 3. supersession removes the old answer from recall --------------------
const oldId = Number(/id=(\d+)/.exec(deadSave)?.[1]);
const newSave = await call("memory_save_fact", {
  content: "PostgreSQL was removed entirely: memory is node:sqlite in one file, no daemon, no port.",
  context: "eval",
});
const newId = Number(/id=(\d+)/.exec(newSave)?.[1]);
const sup = await call("memory_supersede", { new_id: newId, old_ids: [oldId] });
check("supersede reports the edge", /Superseded 1 fact/.test(sup), sup);

const after = await call("memory_recall", { query: "postgres runtime port", limit: 5 });
check("superseded fact leaves recall", !after.includes(`[L1:${oldId}]`),
  after.split("\n")[0]?.slice(0, 120));
check("its replacement is still found", after.includes(`[L1:${newId}]`),
  after.split("\n").find((l) => l.includes(`[L1:${newId}]`))?.slice(0, 120) ?? "(not returned)");

// --- 4. history is kept, not destroyed -------------------------------------
const history = await call("memory_recall", { query: "postgres runtime port", limit: 5, include_superseded: true });
check("history is still reachable on request", history.includes(`[L1:${oldId}]`),
  "include_superseded returns the replaced fact");

// --- 5. a near-duplicate is offered as a supersede candidate ---------------
// Only meaningful with embeddings installed; without them there is no vector
// to compare and the feature correctly stays silent.
const dup = await call("memory_save_fact", {
  content: "Postgres is gone from amalgam; storage is a single node:sqlite file with no daemon and no port.",
  context: "eval",
});
const hasEmbeddings = !dup.includes("keyword search only");
check("near-duplicate is surfaced for review",
  !hasEmbeddings || /memory_supersede/.test(dup),
  dup.split("\n").slice(1, 3).join(" | ") || "(no candidates offered)");

// --- 6. recall is a budget, not a count ------------------------------------
// A store written to for months accumulates memories that say nearly the same
// thing, and facts vary hugely in length — so neither redundancy nor cost is
// controlled by asking for "eight results".
// Distinct subjects, deliberately: identical ones would be collapsed by the
// redundancy rule before the budget ever came into play — which is the right
// order, and would test the wrong thing here.
const LONG_FACTS = [
  "Deployment runs from the pinned release branch; the checklist is followed in order and every step is signed off before the next begins.",
  "Database migrations are applied ahead of the deploy, in a transaction, and the rollback script is written before the forward one is run.",
  "Certificates are renewed every ninety days by the scheduled job; a failure pages whoever is on call rather than retrying silently.",
  "Feature flags default to off in production and are removed within two releases of reaching full rollout, so the branch never becomes permanent.",
  "Backups are verified by restoring into a scratch environment monthly; an unverified backup is treated as no backup at all.",
  "Incident notes are written the same day while details are fresh, and the timeline is reconstructed from logs rather than memory.",
];
for (const content of LONG_FACTS) await call("memory_save_fact", { content, context: "budget" });

const budgeted = await call("memory_recall", { query: "how do we run deployments and keep production safe", limit: 8, budget_chars: 700 });
const body = budgeted.split("\n\n(")[0];
check("a character budget is respected", body.length <= 700,
  `${body.length} characters returned against a 700 budget`);
check("and what was left out is stated", /past the 700-character budget/.test(budgeted),
  budgeted.split("\n\n").pop());

await call("memory_save_fact", { content: "Release runs from the pinned branch; follow the checklist in order.", context: "dupes" });
await call("memory_save_fact", { content: "Releases run off the pinned branch, following the checklist in order.", context: "dupes" });
const deduped = await call("memory_recall", { query: "how do releases run", limit: 6, budget_chars: 6000 });
check("near-duplicates are collapsed",
  !hasEmbeddings || /near-duplicate/.test(deduped),
  deduped.split("\n\n").pop());

console.log(`\n${failed ? `${failed} check(s) failed` : "all checks passed"}`);
try { srv.kill(); } catch {}
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exit(failed ? 1 : 0);
