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
        acceptPending, rejectPending, supersede, proposeFacts, redact, pruneRaw, forgetRaw,
        captureEnabled } = await import("../lib/capture.mjs");
const { open, close } = await import("../lib/db.mjs");
const { embed, toBlob, fromBlob, similarity, embeddingsInstalled } = await import("../lib/embed.mjs");
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
const accepted = await acceptPending([pending[0].id], { verifyFact });
check("accepting writes one fact", accepted.length === 1 && accepted[0].state === "unknown",
  `L1:${accepted[0]?.fact} verify=${accepted[0]?.state}`);

// The second proposal names a path that does not exist, so it must arrive
// already flagged rather than quietly believed.
const accepted2 = await acceptPending([pending[1].id], { verifyFact });
check("a proposal naming a dead path arrives flagged", accepted2[0]?.state === "stale",
  `verify=${accepted2[0]?.state}`);

check("accepted proposals leave the queue", countPending() === 0, `${countPending()} pending`);

savePending([{ kind: "fact", content: "Something nobody wants to keep at all.", context: "eval" }], "session-2");
check("rejecting removes without saving",
  rejectPending(listPending().map((r) => r.id)) === 1 && countPending() === 0
  && open().prepare(`SELECT count(*) AS n FROM l1_facts`).get().n === 2,
  "still two facts stored, none from the rejected proposal");

// --- secrets do not get stored --------------------------------------------
// Capture turned this store from "things somebody chose to keep" into
// "everything that was said", which makes what it refuses to keep part of the
// design rather than a nicety.
const SECRETS = [
  ["openai-style key", "use sk-abc123def456ghi789jkl012 for the call"],
  ["github token", "token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"],
  ["aws key id", "AKIAIOSFODNN7EXAMPLE is the access key"],
  ["jwt", "auth eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk"],
  ["bearer header", "Authorization: Bearer abcdefghijklmnop1234567890"],
  ["named assignment", "DATABASE_PASSWORD=hunter2hunter2"],
  ["url credentials", "clone https://user:s3cr3tpw@example.com/repo.git"],
  ["private key block", "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKC\n-----END RSA PRIVATE KEY-----"],
];
let leaked = [];
for (const [name, text] of SECRETS) {
  const out = redact(text);
  const secret = /sk-abc|ghp_ABC|AKIAIOSFODNN|dBjftJeZ|abcdefghijklmnop|hunter2|s3cr3tpw|MIIEowIBAAKC/.test(out);
  if (secret) leaked.push(name);
}
check("known secret shapes are redacted", leaked.length === 0,
  leaked.length ? `leaked: ${leaked.join(", ")}` : `${SECRETS.length} shapes covered`);

check("ordinary text is left alone",
  redact("The build must stay offline; see lib/db.mjs line 30.") === "The build must stay offline; see lib/db.mjs line 30.",
  "no over-redaction of normal prose");
check("a URL path is not mistaken for a missing file",
  verifyFact("the map is deep-linkable at /api/state").state === "unknown",
  "an HTTP route reads exactly like a POSIX path; flagging it teaches people to ignore the warning");
check("but a path whose root exists is still checked",
  verifyFact(`the store is ${path.join(TMP, "definitely-not-here")}`).state === "stale",
  "genuine drift still caught");

check("a commit hash is not mistaken for a secret",
  redact("fixed in 0639110a1b2c3d4e5f60718293a4b5c6d7e8f900").includes("0639110a1b2c3d4e5f60718293a4b5c6d7e8f900"),
  "no blanket high-entropy rule");

logTurns([{ role: "user", text: "deploy with GITHUB_TOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789" }], "secret-session");
const stored = open().prepare(`SELECT content FROM l0_log WHERE session_id = 'secret-session'`).get().content;
check("redaction happens on the way into storage", !stored.includes("ghp_ABCDEF"), stored);

// --- the raw layer does not grow forever -----------------------------------
const many = Array.from({ length: 40 }, (_, i) => ({ role: "user", text: `turn number ${i} with enough text to store` }));
logTurns(many, "bulk");
const beforePrune = open().prepare(`SELECT count(*) AS n FROM l0_log`).get().n;
pruneRaw({ days: 0, maxRows: 10 });
const afterPrune = open().prepare(`SELECT count(*) AS n FROM l0_log`).get().n;
check("a row cap is enforced", afterPrune === 10, `${beforePrune} -> ${afterPrune} rows`);
check("the newest turns are the ones kept",
  open().prepare(`SELECT content FROM l0_log ORDER BY id DESC LIMIT 1`).get().content.includes("turn number 39"),
  "oldest dropped first");

const factsKept = open().prepare(`SELECT count(*) AS n FROM l1_facts`).get().n;
forgetRaw({});
check("forgetting raw turns leaves distilled facts alone",
  open().prepare(`SELECT count(*) AS n FROM l0_log`).get().n === 0
  && open().prepare(`SELECT count(*) AS n FROM l1_facts`).get().n === factsKept,
  `${factsKept} facts still stored`);

// --- and it can be turned off entirely -------------------------------------
process.env.AMALGAM_CAPTURE = "off";
check("capture can be disabled", !captureEnabled() && logTurns(many, "disabled") === 0,
  "AMALGAM_CAPTURE=off stores nothing");
delete process.env.AMALGAM_CAPTURE;

// --- accepting goes through the same door as any other write ---------------
// A proposal is likelier than most to restate something already stored, since
// it was distilled from a session that was probably discussing what is already
// known. Accepting one without the duplicate check is the fastest way to end
// up with four phrasings of one fact.
if (!embeddingsInstalled()) {
  skip("an accepted proposal is checked for duplicates", "no embedding model installed");
} else {
  const vectors = { embed, toBlob, similarity, fromBlob };
  savePending([{ kind: "fact", content: "Deployment runs from the pinned release branch and the checklist is followed in order.", context: "dupes" }], "s3");
  const first = await acceptPending(listPending().map((r) => r.id), { verifyFact, ...vectors });
  check("an accepted proposal gets a vector immediately",
    !!open().prepare(`SELECT embedding FROM l1_facts WHERE id = ?`).get(first[0].fact).embedding,
    "searchable without waiting for a backfill");

  savePending([{ kind: "fact", content: "Deployments run off the pinned release branch, following the checklist in order.", context: "dupes" }], "s4");
  const second = await acceptPending(listPending().map((r) => r.id), { verifyFact, ...vectors });
  check("a restatement of a stored fact is reported on accept",
    second[0].near.some((n) => n.id === first[0].fact),
    second[0].near.map((n) => `L1:${n.id} ${n.score.toFixed(2)}`).join(", ") || "(nothing close)");
  check("but nothing is superseded without being told",
    open().prepare(`SELECT superseded_by FROM l1_facts WHERE id = ?`).get(first[0].fact).superseded_by === null,
    "the store never decides on its own what replaces what");

  const n = supersede(second[0].fact, [first[0].fact]);
  check("supersede marks the older one", n === 1
    && open().prepare(`SELECT superseded_by FROM l1_facts WHERE id = ?`).get(first[0].fact).superseded_by === second[0].fact,
    `${n} fact(s) superseded`);
}

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
