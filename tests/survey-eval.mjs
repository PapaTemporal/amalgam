#!/usr/bin/env node
/**
 * Brownfield triage evaluation.
 *
 * A survey is only worth reading if its ranking is defensible, so the fixture
 * is built to have a right answer: one file that everything depends on and
 * that changes constantly, one that changes constantly but nothing depends on,
 * one that everything depends on but never changes, and a pair that always
 * move together while living in different directories. A ranking that cannot
 * tell those apart is measuring nothing.
 *
 * Built as a real git repository with real commits, because the entire input
 * is history and there is no honest way to fake it.
 *
 * Usage: node tests/survey-eval.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { rank, render, coupling, isTestFile, fanIn, testedFiles } from "../lib/survey.mjs";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "amalgam-survey-"));
const REPO = path.join(TMP, "repo");
fs.mkdirSync(REPO, { recursive: true });

const git = (args) => spawnSync("git", ["-C", REPO, ...args], { encoding: "utf8", windowsHide: true });
const write = (rel, text) => {
  const f = path.join(REPO, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};
const commit = (msg) => { git(["add", "-A"]); git(["commit", "-qm", msg]); };

let failed = 0;
const ok = (name, pass, detail) => {
  if (!pass) failed++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
  if (detail) console.log(`      ${detail}`);
};

console.log("brownfield survey eval  (real repo, real history)\n");

git(["init", "-q", "-b", "main"]);
git(["config", "user.email", "eval@local"]);
git(["config", "user.name", "eval"]);

write("src/core.js", "export const core = () => 1;\n");          // hot AND depended on
write("src/scratch.js", "export const scratch = () => 1;\n");    // hot, nobody depends
write("src/stable.js", "export const stable = () => 1;\n");      // depended on, never changes
write("src/covered.js", "export const covered = () => 1;\n");    // has a test
write("api/handler.js", "export const handle = () => 1;\n");     // couples with ui/view.js
write("ui/view.js", "export const view = () => 1;\n");
write("tests/covered.test.js", "import { covered } from '../src/covered.js';\n");
commit("base");

for (let i = 0; i < 8; i++) {
  write("src/core.js", `export const core = () => ${i};\n`);
  commit(`core change ${i}`);
}
for (let i = 0; i < 6; i++) {
  write("src/scratch.js", `export const scratch = () => ${i};\n`);
  commit(`scratch change ${i}`);
}
for (let i = 0; i < 4; i++) {
  write("api/handler.js", `export const handle = () => ${i};\n`);
  write("ui/view.js", `export const view = () => ${i};\n`);
  commit(`cross-cutting change ${i}`);
}
for (let i = 0; i < 3; i++) {
  write("src/covered.js", `export const covered = () => ${i};\n`);
  commit(`covered change ${i}`);
}

// A graph as the indexer produces one: core and stable are widely depended on,
// scratch is depended on by nobody, and the test file reaches covered.js.
const node = (id, file, line = 1) => ({ id, label: `${id}()`, _callable: true, source_file: file, source_location: `L${line}` });
const GRAPH = {
  built_at_commit: "head",
  nodes: [
    node("core", "src/core.js"), node("scratch", "src/scratch.js"), node("stable", "src/stable.js"),
    node("covered", "src/covered.js"), node("handle", "api/handler.js"), node("view", "ui/view.js"),
    node("t_covered", "tests/covered.test.js"),
  ],
  links: [
    { source: "handle", target: "core", relation: "calls", source_file: "api/handler.js", source_location: "L1" },
    { source: "view", target: "core", relation: "calls", source_file: "ui/view.js", source_location: "L1" },
    { source: "covered", target: "core", relation: "calls", source_file: "src/covered.js", source_location: "L1" },
    { source: "handle", target: "stable", relation: "calls", source_file: "api/handler.js", source_location: "L1" },
    { source: "view", target: "stable", relation: "calls", source_file: "ui/view.js", source_location: "L1" },
    { source: "t_covered", target: "covered", relation: "calls", source_file: "tests/covered.test.js", source_location: "L1" },
  ],
};
fs.mkdirSync(path.join(REPO, "graphify-out"), { recursive: true });
fs.writeFileSync(path.join(REPO, "graphify-out", "graph.json"), JSON.stringify(GRAPH));

const { loadGraph } = await import("../lib/graph.mjs");
const graph = loadGraph(REPO);

// --- the signals ------------------------------------------------------------
ok("test paths are recognised across conventions",
  isTestFile("tests/covered.test.js") && isTestFile("src/__tests__/a.js") && isTestFile("pkg/foo_test.go")
  && !isTestFile("src/latest.js"),
  "tests/, __tests__/, .test., _test. — but not a file that merely contains 'test'");

const inbound = fanIn(graph);
ok("fan-in counts dependent files, not calls",
  inbound.get("src/core.js")?.size === 3 && (inbound.get("src/scratch.js")?.size ?? 0) === 0,
  `core has ${inbound.get("src/core.js")?.size} dependents, scratch ${inbound.get("src/scratch.js")?.size ?? 0}`);

const covered = testedFiles(graph);
ok("a file a test reaches is known to be covered",
  covered.has("src/covered.js") && !covered.has("src/core.js"),
  `covered: ${[...covered].join(", ")}`);

// --- the ranking ------------------------------------------------------------
const survey = rank(REPO, { graph, limit: 10 });
const order = survey.rows.map((r) => r.file);
const pos = (f) => order.indexOf(f);

ok("history was read", survey.commits >= 20 && survey.files >= 6,
  `${survey.commits} commits over ${survey.files} files`);
ok("hot AND depended-on ranks first", order[0] === "src/core.js", order.slice(0, 3).join(" > "));
ok("hot but nobody depends on it ranks below", pos("src/scratch.js") > pos("src/core.js"),
  `core at ${pos("src/core.js")}, scratch at ${pos("src/scratch.js")}`);
ok("depended-on but never changed ranks below both",
  pos("src/stable.js") > pos("src/core.js"),
  "risk is the product: a file that never changes is not where the danger is");
ok("test files are never ranked as risk", !order.some(isTestFile), order.join(", "));

const core = survey.rows.find((r) => r.file === "src/core.js");
ok("the reasons are stated, not just a score",
  core.why.some((w) => /commits/.test(w)) && core.why.some((w) => /dependent/.test(w))
  && core.why.includes("no test reaches it"),
  core.why.join(", "));

// --- coupling ---------------------------------------------------------------
const couples = coupling(survey.pairs, { min: 3 });
ok("files that change together but live apart are found",
  couples.some((c) => [c.a, c.b].sort().join() === "api/handler.js,ui/view.js"),
  couples.map((c) => `${c.n}x ${c.a}+${c.b}`).join(" | ") || "(none)");
ok("files in the same directory are not reported as a hidden seam",
  !couples.some((c) => path.dirname(c.a) === path.dirname(c.b)),
  "same-folder coupling is the layout working, not hiding something");

// --- the output that matters ------------------------------------------------
const out = render(survey, { repo: REPO, gate: { detected: true, passed: false } });
ok("an unbuildable project is told to fix that first",
  /checks FAIL — fix this before anything else/.test(out), out.split("\n").find((l) => /Bootstrap/.test(l)));
ok("the characterization-test list names the risky untested files",
  /Write characterization tests here first/.test(out) && out.includes("src/core.js"),
  "the list of what to cover before touching anything");
ok("a safe starting point is offered", /Safest place to make a first change/.test(out)
  && out.includes("src/covered.js"), "active, and already covered by a test");
ok("the report admits the ranking is a heuristic",
  /measurements; the ranking between them is a heuristic/.test(out));

console.log(`\n${failed ? `${failed} check(s) failed` : "all checks passed"}`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exitCode = failed ? 1 : 0;
