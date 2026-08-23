#!/usr/bin/env node
/**
 * Stream collision evaluation.
 *
 * The failure this exists to catch is the quiet one. A textual conflict is
 * loud and cheap; the expensive collision merges clean and is wrong, because
 * one stream changed what a function does while another wrote code that calls
 * it, and both suites were green in isolation.
 *
 * So the fixture is built around that case specifically: two streams changing
 * the same symbol, two streams where one calls what the other changed, and two
 * that genuinely have nothing to do with each other — because a detector that
 * cries collision on independent work is worse than none, and would be
 * ignored within a day.
 *
 * Real repository, real branches, real diffs.
 *
 * Usage: node tests/collide-eval.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { analyse, compare, mergeOrder, streamChanges, render } from "../lib/collide.mjs";
import { loadGraph } from "../lib/graph.mjs";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "amalgam-collide-"));
const REPO = path.join(TMP, "repo");
fs.mkdirSync(REPO, { recursive: true });

const git = (repo, args) => {
  const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true });
  return { ok: r.status === 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};
const write = (rel, text) => {
  const f = path.join(REPO, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};

let failed = 0;
const ok = (name, pass, detail) => {
  if (!pass) failed++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
  if (detail) console.log(`      ${detail}`);
};

console.log("stream collision eval  (real branches, real diffs)\n");

// --- a repo with three separable concerns ----------------------------------
write("src/auth.js", `export function validateToken(t) {
  return String(t).length > 8;
}
`);
write("src/api.js", `import { validateToken } from "./auth.js";

export function handleRequest(req) {
  return validateToken(req.token) ? 200 : 401;
}
`);
write("src/report.js", `export function renderReport(rows) {
  return rows.join("\\n");
}
`);

// Real projects ignore the derived graph; a fixture that commits it would
// have every branch "changing" it and every pair colliding on it.
write(".gitignore", "graphify-out/\n");

git(REPO, ["init", "-q", "-b", "main"]);
git(REPO, ["config", "user.email", "eval@local"]);
git(REPO, ["config", "user.name", "eval"]);
git(REPO, ["add", "-A"]);
git(REPO, ["commit", "-qm", "base"]);

// A graph of the base: api calls auth, report calls nobody.
const node = (id, name, file, line) => ({ id, label: `${name}()`, _callable: true, source_file: file, source_location: `L${line}` });
fs.mkdirSync(path.join(REPO, "graphify-out"), { recursive: true });
fs.writeFileSync(path.join(REPO, "graphify-out", "graph.json"), JSON.stringify({
  built_at_commit: git(REPO, ["rev-parse", "HEAD"]).stdout.trim(),
  nodes: [
    node("n_validate", "validateToken", "src/auth.js", 1),
    node("n_handle", "handleRequest", "src/api.js", 3),
    node("n_report", "renderReport", "src/report.js", 1),
  ],
  links: [
    { source: "n_handle", target: "n_validate", relation: "calls", source_file: "src/api.js", source_location: "L4" },
  ],
}));
const graph = loadGraph(REPO);

/** A branch that edits one file, as a stream would. */
const branchWith = (name, rel, text) => {
  git(REPO, ["checkout", "-q", "-b", name, "main"]);
  write(rel, text);
  git(REPO, ["add", "-A"]);
  git(REPO, ["commit", "-qm", `${name} work`]);
  git(REPO, ["checkout", "-q", "main"]);
  return { name: name.replace("fix/", ""), branch: name, base: "main", repo: REPO };
};

// 1. changes what validateToken DOES
const tighten = branchWith("fix/tighten-auth", "src/auth.js", `export function validateToken(t) {
  return typeof t === "string" && t.length > 16 && !t.includes(" ");
}
`);
// 2. writes new code that CALLS validateToken
const audit = branchWith("fix/audit-api", "src/api.js", `import { validateToken } from "./auth.js";

export function handleRequest(req) {
  const allowed = validateToken(req.token);
  return allowed ? 200 : 401;
}
`);
// 3. also changes validateToken — a direct fight
const cache = branchWith("fix/cache-auth", "src/auth.js", `const seen = new Map();

export function validateToken(t) {
  if (seen.has(t)) return seen.get(t);
  const okay = String(t).length > 8;
  seen.set(t, okay);
  return okay;
}
`);
// 4. entirely unrelated
const report = branchWith("fix/report-format", "src/report.js", `export function renderReport(rows) {
  return rows.map((r) => \`- \${r}\`).join("\\n");
}
`);

// --- what each stream changed ----------------------------------------------
const one = streamChanges(REPO, tighten, { graph, git });
ok("a stream's changes are read against its base",
  one.files.join() === "src/auth.js" && one.symbols.some((s) => s.name === "validateToken"),
  `${one.files.join(", ")} — ${one.symbols.map((s) => s.name).join(", ")}`);

// --- the loud case: same symbol --------------------------------------------
const both = compare([streamChanges(REPO, tighten, { graph, git }), streamChanges(REPO, cache, { graph, git })], graph);
ok("two streams changing the same symbol are a collision",
  both.length === 1 && both[0].sharedSymbols.some((s) => s.startsWith("validateToken")),
  both[0]?.sharedSymbols.join(", ") ?? "(nothing found)");

// --- the quiet case: one calls what the other changed ----------------------
const crossing = compare([streamChanges(REPO, tighten, { graph, git }), streamChanges(REPO, audit, { graph, git })], graph);
ok("a caller and a changed callee are found even in different files",
  crossing.length === 1 && (crossing[0].aNeedsB.length || crossing[0].bNeedsA.length),
  `${crossing[0]?.a} + ${crossing[0]?.b}: calls ${[...(crossing[0]?.aNeedsB ?? []), ...(crossing[0]?.bNeedsA ?? [])].join(", ")}`);
ok("and it is reported as an ordering, not a conflict",
  crossing[0].sharedSymbols.length === 0 && crossing[0].sharedFiles.length === 0,
  "no shared text — git would merge this silently");

// --- no false alarms --------------------------------------------------------
const apart = compare([streamChanges(REPO, tighten, { graph, git }), streamChanges(REPO, report, { graph, git })], graph);
ok("independent streams are not reported at all", apart.length === 0,
  "a detector that cries wolf on unrelated work gets ignored");

// --- ordering ---------------------------------------------------------------
const full = analyse(REPO, [audit, tighten, report], { graph, git });
const pos = (n) => full.order.indexOf(n);
ok("the changed callee is merged before its new caller",
  pos("tighten-auth") < pos("audit-api"),
  `order: ${full.order.join(" -> ")}`);
ok("an unrelated stream is still in the order", full.order.includes("report-format"), full.order.join(" -> "));
ok("nothing is entangled when the dependencies are acyclic", full.entangled.length === 0);

// --- entanglement -----------------------------------------------------------
// Both streams change a symbol the other calls: there is no order that works.
const mutual = mergeOrder(["a", "b", "c"], [
  { a: "a", b: "b", aNeedsB: ["x"], bNeedsA: ["y"], sharedSymbols: [], sharedFiles: [] },
]);
ok("a cycle is reported as entangled rather than ordered",
  mutual.entangled.sort().join() === "a,b" && mutual.order.join() === "c",
  `order ${mutual.order.join(",")} | entangled ${mutual.entangled.join(",")}`);

// --- the report -------------------------------------------------------------
const out = render(analyse(REPO, [tighten, cache, audit, report], { graph, git }));
ok("the report warns that a clean merge is the dangerous case",
  /A clean merge here is the dangerous case/.test(out),
  out.split("\n").find((l) => /COLLISION/.test(l)));
ok("the report gives a merge order", /Merge order:/.test(out),
  out.split("\n").find((l) => /Merge order/.test(l)));

console.log(`\n${failed ? `${failed} check(s) failed` : "all checks passed"}`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exitCode = failed ? 1 : 0;
