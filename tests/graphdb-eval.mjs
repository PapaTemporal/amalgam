#!/usr/bin/env node
/**
 * Graph-index evaluation.
 *
 * Three claims to keep honest:
 *   - importing loses nothing: the shape served from the index is the shape
 *     the JSON document produced, so everything downstream is indifferent;
 *   - re-importing is cheap: symbols that did not change keep their vectors,
 *     because re-embedding an unchanged codebase is the slowest thing this
 *     index could do;
 *   - searching by meaning beats searching by name, which is the entire point
 *     of putting the graph next to memory rather than leaving it in a file.
 *
 * The semantic checks are skipped, loudly, when no embedding model is
 * installed — an absent model must never look like a passing test.
 *
 * Usage: node tests/graphdb-eval.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "amalgam-gdb-"));
process.env.AMALGAM_DB = path.join(TMP, "memory.db");

const { importGraph, graphFromDb, searchSymbols, isIndexed } = await import("../lib/graphdb.mjs");
const { loadGraph } = await import("../lib/graph.mjs");
const { embed, similarity, toBlob, fromBlob, embeddingsInstalled } = await import("../lib/embed.mjs");
const { close } = await import("../lib/db.mjs");

let failed = 0, skipped = 0;
const check = (name, pass, detail) => {
  if (!pass) failed++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
  if (detail) console.log(`      ${detail}`);
};
const skip = (name, why) => { skipped++; console.log(`SKIP  ${name}\n      ${why}`); };

// --- a small repo, with the kind of comments real code carries --------------
const REPO = path.join(TMP, "repo");
fs.mkdirSync(path.join(REPO, "graphify-out"), { recursive: true });
fs.writeFileSync(path.join(REPO, "session.js"), `/**
 * Reject blank or malformed credentials at the edge, before any handler runs,
 * so no route has to remember to check them.
 */
export function validateSession(token) {
  return String(token ?? "").trim().length > 8;
}

/** Format a number of bytes for humans: 1536 becomes "1.5 KB". */
export function humanSize(n) {
  return (n / 1024).toFixed(1) + " KB";
}
`);

const graph = (nodes, links) => {
  fs.writeFileSync(path.join(REPO, "graphify-out", "graph.json"),
    JSON.stringify({ built_at_commit: "abc123", nodes, links }));
};
const NODES = [
  { id: "n_validate", label: "validateSession()", _callable: true, source_file: "session.js", source_location: "L5" },
  { id: "n_human", label: "humanSize()", _callable: true, source_file: "session.js", source_location: "L10" },
  { id: "n_file", label: "session.js", source_file: "session.js", source_location: "L1" },
];
graph(NODES, [{ source: "n_file", target: "n_validate", relation: "calls", source_file: "session.js", source_location: "L1" }]);

const withVectors = embeddingsInstalled();
const embedder = withVectors ? async (texts) => (await embed(texts))?.map(toBlob) : null;

// --- import -----------------------------------------------------------------
const first = await importGraph(REPO, { embed: embedder });
check("import reports what it stored", first.ok && first.symbols === 3 && first.edges === 1,
  `${first.symbols} symbols, ${first.edges} edges, ${first.embedded} embedded`);
check("the repo is now indexed", isIndexed(REPO));

// --- the index serves the same shape as the document -----------------------
const fromJson = loadGraph(REPO);
const fromIndex = graphFromDb(REPO);
check("same symbols either way", fromIndex.nodes.size === fromJson.nodes.size,
  `index ${fromIndex.nodes.size} vs json ${fromJson.nodes.size}`);
const jn = fromJson.nodes.get("n_validate"), inx = fromIndex.nodes.get("n_validate");
check("same fields on a symbol",
  jn.name === inx.name && jn.file === inx.file && jn.line === inx.line && jn.label === inx.label,
  `${inx.label} at ${inx.file}:${inx.line}`);
check("edges carry their call site",
  (fromIndex.callers.get("n_validate") ?? []).some((e) => e.file === "session.js"),
  JSON.stringify(fromIndex.callers.get("n_validate")));

// --- re-import is cheap -----------------------------------------------------
const second = await importGraph(REPO, { embed: embedder });
check("an unchanged rebuild re-embeds nothing",
  second.embedded === 0 && second.reused === 3,
  `${second.embedded} embedded, ${second.reused} reused`);

// --- symbols that disappear are removed ------------------------------------
graph(NODES.filter((n) => n.id !== "n_human"), []);
const third = await importGraph(REPO, { embed: embedder });
check("a deleted symbol leaves the index", third.symbols === 2 && third.removed === 1,
  `${third.symbols} symbols, ${third.removed} removed`);
check("and is gone from the served graph", !graphFromDb(REPO).nodes.has("n_human"));

// --- search -----------------------------------------------------------------
check("a symbol is findable by name",
  searchSymbols(REPO, "validateSession", { limit: 3 }).some((n) => n.id === "n_validate"),
  "lexical path, no model needed");

if (!withVectors) {
  skip("meaning finds what names do not", "no embedding model installed (amalgam install --with-embeddings)");
} else {
  // Not one word of this query appears anywhere in the symbol — not in its
  // name, its signature, its path, or the sentence above it. That is the point:
  // it is the case words cannot reach however carefully they are matched.
  //
  // The query used to be "…before requests are routed", which shares "routed"
  // with the doc comment's "route". That went unnoticed while the lexical path
  // compared identifiers only; once it learned to read doc comments and to trim
  // word endings it found the symbol too, and the claim below stopped being
  // true. The claim was wrong, not the search — see lib/lexical.mjs.
  const q = "stop bad logins from getting through";
  const [qv] = (await embed(q, { query: true })) ?? [];
  const hits = searchSymbols(REPO, q, { vec: qv, limit: 2, similarity, fromBlob });
  check("meaning finds what names do not",
    hits.some((n) => n.id === "n_validate"),
    `"${q}" -> ${hits.map((n) => n.name).join(", ") || "(nothing)"}`);

  const lexical = searchSymbols(REPO, q, { limit: 2 });
  check("and the name-only path genuinely could not",
    !lexical.some((n) => n.id === "n_validate"),
    `lexical -> ${lexical.map((n) => n.name).join(", ") || "(nothing)"}`);
}

// --- nodes a graph carries that no file backs -------------------------------
//
// The bug this holds down: graphify emits nodes with no source_file — a type
// referred to but never defined here, a synthetic grouping node. Reading the
// source for one of those resolved to the repository directory itself, and
// reading a directory throws. The whole import aborted, so the graph file sat
// on disk looking built while the index stayed empty and every count read
// zero. Two of this machine's three repositories were in that state for days.
//
// One unbacked node must not cost the other symbols their index.
const ODD = path.join(TMP, "odd");
fs.mkdirSync(path.join(ODD, "graphify-out"), { recursive: true });
fs.writeFileSync(path.join(ODD, "app.js"), "export function realOne() {\n  return 1;\n}\n");
fs.writeFileSync(path.join(ODD, "graphify-out", "graph.json"), JSON.stringify({
  directed: true, multigraph: false, graph: {},
  nodes: [
    { id: "n_real", label: "realOne()", _callable: true, source_file: "app.js", source_location: "L1" },
    // No file at all: the shape that aborted the import.
    { id: "n_type", label: "SomeEnum", source_file: "", source_location: "" },
    // A path that exists but is a directory, and one that does not exist.
    { id: "n_dir", label: "graphify-out", source_file: "graphify-out", source_location: "L1" },
    { id: "n_ghost", label: "deleted()", _callable: true, source_file: "gone.js", source_location: "L3" },
  ],
  links: [{ source: "n_real", target: "n_type", relation: "calls", source_file: "app.js", source_location: "L1" }],
  hyperedges: [], built_at_commit: null,
}));

const odd = await importGraph(ODD, { embed: embedder });
check("a node with no source file does not abort the import",
  odd.ok === true && odd.symbols === 4,
  odd.ok ? `${odd.symbols} symbols, ${odd.edges} edges` : `import failed: ${odd.error}`);

check("and the repository really is indexed afterwards", isIndexed(ODD),
  "the failure mode was a graph file on disk with an empty index behind it");

check("the symbol that does have a file still carries its signature",
  (graphFromDb(ODD)?.nodes.get("n_real")?.name) === "realOne",
  "one unbacked node must not cost the others their index");

console.log(`\n${failed ? `${failed} check(s) failed` : "all checks passed"}${skipped ? `, ${skipped} skipped` : ""}`);
// process.exitCode rather than process.exit(): exiting hard while the
// embedding server's keep-alive socket is still open trips a libuv assertion
// during teardown on Windows. Letting the loop drain avoids it.
close();
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exitCode = failed ? 1 : 0;
