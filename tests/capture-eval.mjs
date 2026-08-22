#!/usr/bin/env node
/**
 * Session-capture evaluation.
 *
 * The claim: a session records what it learned without anyone remembering to,
 * and nothing it records is believed until someone says so. The second half
 * matters more than the first — automatic capture that wrote straight into
 * long-term memory would be a machine for manufacturing confident errors.
 *
 * The model-dependent step is exercised only when a model is installed, and
 * skipped loudly otherwise. Its output is checked for shape, never for
 * wording: a local model is allowed to phrase things how it likes.
 *
 * Usage: node tests/capture-eval.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "amalgam-cap-"));
process.env.AMALGAM_DB = path.join(TMP, "memory.db");

const { readTranscript, logTurns, savePending, listPending, countPending,
        acceptPending, rejectPending, proposeFacts } = await import("../lib/capture.mjs");
const { open, close } = await import("../lib/db.mjs");
const { verifyFact } = await import("../lib/verify.mjs");
const { modelInstalled } = await import("../lib/services.mjs");

let failed = 0, skipped = 0;
const check = (name, pass, detail) => {
  if (!pass) failed++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
  if (detail) console.log(`      ${detail}`);
};
const skip = (name, why) => { skipped++; console.log(`SKIP  ${name}\n      ${why}`); };

console.log("session capture eval  (temp db)\n");

// --- a transcript in the shape Claude Code writes ---------------------------
const TRANSCRIPT = path.join(TMP, "transcript.jsonl");
fs.writeFileSync(TRANSCRIPT, [
  JSON.stringify({ type: "user", message: { role: "user", content: "The build has to stay offline: no package downloads at run time." } }),
  JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Understood. I will vendor the dependency instead." }] } }),
  // Tool traffic: the bulkiest part of a session and the least durable.
  JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] } }),
  JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "a.js b.js" }] } }),
  JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Vendored under lib/vendor and pinned the version." }] } }),
  "not json at all",
  "",
].join("\n"));

const turns = readTranscript(TRANSCRIPT);
check("transcript parses into turns", turns.length === 3, `${turns.length} turns`);
check("tool traffic is left out",
  !turns.some((t) => /tool_use|tool_result|a\.js/.test(t.text)),
  turns.map((t) => `${t.role}:${t.text.slice(0, 24)}`).join(" | "));
check("malformed lines do not throw", true, "unparseable and empty lines skipped");

// --- the raw layer fills itself --------------------------------------------
const before = open().prepare(`SELECT count(*) AS n FROM l0_log`).get().n;
logTurns(turns, "session-1");
const after = open().prepare(`SELECT count(*) AS n FROM l0_log`).get().n;
check("turns land in the raw layer", after - before === 3, `${before} -> ${after} rows`);

// --- proposals are not memories --------------------------------------------
savePending([
  { kind: "constraint", content: "Build must stay offline: no package downloads at run time.", context: "eval" },
  { kind: "fact", content: `Dependency vendored under ${path.join(TMP, "definitely-not-here")}.`, context: "eval" },
], "session-1");

check("proposals wait to be reviewed", countPending() === 2, `${countPending()} pending`);
const factsBefore = open().prepare(`SELECT count(*) AS n FROM l1_facts`).get().n;
check("and are not in memory yet", factsBefore === 0, `${factsBefore} facts stored`);

const pending = listPending();
const accepted = acceptPending([pending[0].id], { verifyFact });
check("accepting writes one fact", accepted.length === 1 && accepted[0].state === "unknown",
  `L1:${accepted[0]?.fact} verify=${accepted[0]?.state}`);

// The second proposal names a path that does not exist, so it must arrive
// already flagged rather than quietly believed.
const accepted2 = acceptPending([pending[1].id], { verifyFact });
check("a proposal naming a dead path arrives flagged", accepted2[0]?.state === "stale",
  `verify=${accepted2[0]?.state}`);

check("accepted proposals leave the queue", countPending() === 0, `${countPending()} pending`);

savePending([{ kind: "fact", content: "Something nobody wants to keep at all.", context: "eval" }], "session-2");
check("rejecting removes without saving",
  rejectPending(listPending().map((r) => r.id)) === 1 && countPending() === 0
  && open().prepare(`SELECT count(*) AS n FROM l1_facts`).get().n === 2,
  "still two facts stored, none from the rejected proposal");

// --- distillation, when a model is present ---------------------------------
if (!modelInstalled()) {
  skip("a session distils into candidate facts", "no local model installed (amalgam install --with-model)");
} else {
  const proposals = await proposeFacts(turns, { context: "eval" });
  const kinds = ["fact", "decision", "constraint", "preference"];
  check("a session distils into candidate facts",
    Array.isArray(proposals) && proposals.every((p) => kinds.includes(p.kind) && p.content.length > 15),
    proposals.length ? proposals.map((p) => `${p.kind}: ${p.content.slice(0, 70)}`).join(" | ") : "(nothing durable found — allowed)");
}

console.log(`\n${failed ? `${failed} check(s) failed` : "all checks passed"}${skipped ? `, ${skipped} skipped` : ""}`);
close();
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exitCode = failed ? 1 : 0;
