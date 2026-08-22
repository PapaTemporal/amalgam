#!/usr/bin/env node
/**
 * Code-evidence evaluation.
 *
 * The claim being tested is not "the graph is correct" — graphify owns that —
 * but the thing built on top of it: that an agent can be handed the few lines
 * that bear on a task instead of the files that contain them, and that a graph
 * which has fallen behind the working tree degrades honestly instead of
 * quoting text that is no longer there.
 *
 * Everything runs in a temporary git repo with a hand-written graph, so the
 * test needs no graphify, no model, and no network.
 *
 * Usage: node tests/graph-eval.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadGraph, findSymbols, sliceSymbol, callersOf, changedRanges, symbolsInRanges } from "../lib/graph.mjs";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "amalgam-graph-"));
const git = (repo, args) => {
  const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true });
  return { ok: r.status === 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

let failed = 0;
const check = (name, pass, detail) => {
  if (!pass) failed++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
  if (detail) console.log(`      ${detail}`);
};

// --- a small repo -----------------------------------------------------------
const SRC = `export function parseToken(raw) {
  return String(raw).trim();
}

export function validateSession(token) {
  const t = parseToken(token);
  return t.length > 8;
}

export function renderBanner() {
  return "hello";
}
`;
fs.writeFileSync(path.join(TMP, "session.js"), SRC);

// A real caller, importing the symbol from where it is defined.
fs.writeFileSync(path.join(TMP, "client.js"), `import { parseToken } from "./session.js";

export function handleRequest(req) {
  return parseToken(req.token);
}
`);

// A file that never touches session.js, but where the same NAME is bound
// locally — the case name-based extraction cannot see.
fs.writeFileSync(path.join(TMP, "worker.js"), `export function run(input) {
  return new Promise((parseToken) => parseToken(input));
}

export function label(v) {
  const renderBanner = () => "worker";
  return renderBanner() + v;
}
`);

fs.mkdirSync(path.join(TMP, "graphify-out"), { recursive: true });

git(TMP, ["init", "-q"]);
git(TMP, ["config", "user.email", "eval@local"]);
git(TMP, ["config", "user.name", "eval"]);
git(TMP, ["add", "-A"]);
git(TMP, ["commit", "-qm", "base"]);
const base = git(TMP, ["rev-parse", "HEAD"]).stdout.trim();

// A graph as graphify writes one — including one deliberately wrong line
// number (renderBanner is at 10, the graph claims 99) and one symbol that no
// longer exists in the file at all.
const GRAPH = {
  built_at_commit: base,
  nodes: [
    { id: "s_parse", label: "parseToken()", _callable: true, source_file: "session.js", source_location: "L1" },
    { id: "s_validate", label: "validateSession()", _callable: true, source_file: "session.js", source_location: "L5" },
    { id: "s_render", label: "renderBanner()", _callable: true, source_file: "session.js", source_location: "L99" },
    { id: "s_gone", label: "legacyLogin()", _callable: true, source_file: "session.js", source_location: "L40" },
    { id: "s_file", label: "session.js", source_file: "session.js", source_location: "L1" },
    { id: "c_handle", label: "handleRequest()", _callable: true, source_file: "client.js", source_location: "L3" },
    { id: "w_run", label: "run()", _callable: true, source_file: "worker.js", source_location: "L1" },
    { id: "w_label", label: "label()", _callable: true, source_file: "worker.js", source_location: "L5" },
  ],
  links: [
    { source: "s_validate", target: "s_parse", relation: "calls", source_file: "session.js", source_location: "L6" },
    { source: "s_file", target: "s_parse", relation: "calls", source_file: "session.js", source_location: "L1" },
    // genuine: client.js imports parseToken from session.js and calls it
    { source: "c_handle", target: "s_parse", relation: "calls", source_file: "client.js", source_location: "L4" },
    // false: parseToken here is a Promise callback parameter
    { source: "w_run", target: "s_parse", relation: "calls", source_file: "worker.js", source_location: "L2" },
    // false: renderBanner here is a local const in another file
    { source: "w_label", target: "s_render", relation: "calls", source_file: "worker.js", source_location: "L7" },
  ],
};
fs.writeFileSync(path.join(TMP, "graphify-out", "graph.json"), JSON.stringify(GRAPH));

const g = loadGraph(TMP);
check("graph loads", g && g.nodes.size === 8, `${g?.nodes.size} nodes`);

// --- selection --------------------------------------------------------------
const picked = findSymbols(g, "validate the session token", 2).map((n) => n.name);
check("task text selects the right symbols", picked.includes("validateSession"), `picked: ${picked.join(", ")}`);

check("callers come from the graph",
  callersOf(g, "s_parse").map((n) => n.name).includes("validateSession"),
  callersOf(g, "s_parse").map((n) => n.name).join(", "));

// --- edges are checked against the source, not taken on faith ---------------
// A call graph built by name cannot see scope: a Promise callback parameter
// and a local const both look like calls to a same-named export elsewhere.
const unchecked = callersOf(g, "s_parse").map((n) => n.name);
const checked = callersOf(g, "s_parse", TMP);
check("a real cross-file caller survives verification",
  checked.map((n) => n.name).includes("handleRequest"), checked.map((n) => n.name).join(", "));
check("a parameter of the same name is not a caller",
  !checked.map((n) => n.name).includes("run") && unchecked.includes("run"),
  `unverified: ${unchecked.join(", ")} -> verified: ${checked.map((n) => n.name).join(", ")}`);
check("a local const of the same name is not a caller",
  !callersOf(g, "s_render", TMP).map((n) => n.name).includes("label"),
  `dropped ${callersOf(g, "s_render", TMP).rejected} unconfirmed edge(s)`);

// --- the graph selects, the working tree supplies ---------------------------
const validate = sliceSymbol(TMP, g.nodes.get("s_validate"), 4);
check("source is quoted from disk, not the graph",
  validate.text.includes("const t = parseToken(token);"), validate.text.split("\n")[0]);

const moved = sliceSymbol(TMP, g.nodes.get("s_render"), 3);
check("a symbol whose line number drifted is still found",
  moved.text.includes("renderBanner") && moved.moved === true && moved.line === 10,
  `located at line ${moved.line}, graph said 99`);

const gone = sliceSymbol(TMP, g.nodes.get("s_gone"), 3);
check("a symbol that no longer exists is reported, never quoted",
  gone.missing === "symbol not found in file" && gone.text === "", gone.missing);

const fileNode = sliceSymbol(TMP, g.nodes.get("s_file"), 3);
check("a file node yields its opening lines", fileNode.isFile && fileNode.text.includes("parseToken"),
  fileNode.text.split("\n")[0]);

// --- impact is line-precise, not file-precise ------------------------------
const edited = SRC.replace('return String(raw).trim();', 'return String(raw).trim().toLowerCase();');
fs.writeFileSync(path.join(TMP, "session.js"), edited);

const ranges = changedRanges(TMP, "HEAD", git);
const touched = symbolsInRanges(g, ranges).map((n) => n.name);
check("an edit inside a function body maps to that function",
  touched.includes("parseToken"), `touched: ${touched.join(", ") || "(none)"}`);
check("untouched neighbours stay out of the blast radius",
  !touched.includes("validateSession") && !touched.includes("renderBanner"),
  `touched: ${touched.join(", ") || "(none)"}`);

console.log(`\n${failed ? `${failed} check(s) failed` : "all checks passed"}`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
