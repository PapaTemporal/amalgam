#!/usr/bin/env node
/**
 * Graph exploration evaluation.
 *
 * The claim this file exists to hold up: a project's graph can be walked
 * across the HTTP boundaries between its services, and the answers say which
 * hops were parsed and which were inferred.
 *
 * That distinction is the whole thing. A blast radius that stops at the edge
 * of a repository is wrong in the expensive direction — it tells you a change
 * is safe when four symbols in another service depend on it. A blast radius
 * that crosses the boundary silently is wrong in the other expensive
 * direction — it presents a guess from a route string with the same weight as
 * a call a parser proved. So every crossing must be found, and every crossing
 * must be labelled.
 *
 * The fixture is a workspace on disk with hand-written graph files, so the
 * test needs neither graphify nor uv nor a model, and runs in milliseconds.
 *
 * Usage: node tests/explore-eval.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "amalgam-explore-"));
process.env.AMALGAM_DB = path.join(TMP, "memory.db");

const { contracts, saveContracts } = await import("../lib/contracts.mjs");
const { overview, symbol, neighbourhood, shortestPath, impact, tree, withContracts } =
  await import("../lib/explore.mjs");
const { graphFor } = await import("../lib/workspace.mjs");
const { close } = await import("../lib/db.mjs");

let failed = 0;
const check = (name, pass, detail) => {
  if (!pass) failed++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
  if (detail) console.log(`      ${detail}`);
};

console.log("graph exploration eval  (real files, no model)\n");

// --- a two-service workspace, source and graph both ------------------------
const write = (rel, body) => {
  const full = path.join(TMP, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
};

write("web/src/api.js", `
export const placeOrder = (cart) => fetch("/api/orders", { method: "POST", body: cart });
export function checkout(cart) {
  return placeOrder(cart);
}
`);
write("api/src/server.js", `
import express from "express";
import { writeOrder } from "./store.js";
const app = express();
app.post("/api/orders", async (req, res) => res.json(await writeOrder(req.body)));
`);
write("api/src/store.js", `
export async function writeOrder(order) {
  return { id: 1, ...order };
}
`);

/** A graphify-shaped graph file, written by hand so no extractor is needed. */
const graph = (dir, nodes, links) => {
  const doc = {
    directed: true, multigraph: false, graph: {},
    nodes: nodes.map((n) => ({
      id: n.id, label: `${n.name}()`, _callable: true, _origin: "ast",
      community: n.community ?? 0, file_type: "code",
      source_file: n.file, source_location: `L${n.line}`,
    })),
    links: links.map((l) => ({
      source: l.from, target: l.to, relation: "calls", _origin: "ast",
      confidence: "EXTRACTED", context: "call",
      source_file: l.file, source_location: `L${l.line}`, weight: 1.0,
    })),
    hyperedges: [], built_at_commit: null,
  };
  write(path.join(dir, "graphify-out", "graph.json"), JSON.stringify(doc));
};

// Each service is a repository; a workspace is a folder of them.
for (const s of ["web", "api"]) fs.mkdirSync(path.join(TMP, s, ".git"), { recursive: true });

graph("web",
  [{ id: "api_placeorder", name: "placeOrder", file: "src/api.js", line: 2 },
   { id: "api_checkout", name: "checkout", file: "src/api.js", line: 3 }],
  [{ from: "api_checkout", to: "api_placeorder", file: "src/api.js", line: 4 }]);

graph("api",
  [{ id: "server_createserver", name: "createServer", file: "src/server.js", line: 4 },
   { id: "store_writeorder", name: "writeOrder", file: "src/store.js", line: 2, community: 1 }],
  [{ from: "server_createserver", to: "store_writeorder", file: "src/server.js", line: 5 }]);

// --- the graph is one graph, not two ---------------------------------------
const g = graphFor(TMP);
check("a workspace's services merge into one graph",
  !!g?.workspace && g.nodes.size === 4,
  `${g?.nodes.size ?? 0} symbols across ${g?.services?.join(", ") ?? "nothing"}`);

check("ids and paths say which service they came from",
  g.nodes.has("web::api_placeorder") && g.nodes.get("web::api_placeorder").file === "web/src/api.js",
  "web::api_placeorder at web/src/api.js");

// --- and the boundary between them is crossable ----------------------------
const found = contracts(TMP, ["web", "api"].map((n) => ({ name: n, path: path.join(TMP, n) })));
await saveContracts(TMP, found);
check("the two halves of the HTTP call are matched",
  found.edges.length === 1 && found.edges[0].path === "/api/orders",
  found.edges.map((e) => `${e.method ?? "ANY"} ${e.path} ${e.from.service}->${e.to.service}`).join(", ") || "(none)");

const joined = await withContracts(g, TMP);
check("the contract becomes an edge in the graph", joined.added === 1,
  `${joined.added} inferred edge(s) added`);

check("and the parsed graph is left alone",
  (g.callees.get("web::api_placeorder") ?? []).length === 0,
  "callers who want only what a parser proved still get exactly that");

// --- walking across the boundary -------------------------------------------
const p = await shortestPath(TMP, "web::api_checkout", "api::store_writeorder");
check("a path runs from one service into another", p.found && p.directed && p.hops === 3,
  p.found ? p.steps.map((s) => `${s.service}/${s.name}`).join(" -> ") : "(no path)");

const crossing = p.steps.find((s) => s.via?.viaContract);
check("the hop over the wire says so, and names the route",
  !!crossing && crossing.via.route === "/api/orders" && crossing.via.method === "POST",
  crossing ? `${crossing.via.method} ${crossing.via.route} into ${crossing.name}` : "(no crossing marked)");

const parsedOnly = await shortestPath(TMP, "web::api_checkout", "api::store_writeorder", { contracts: false });
check("without the contracts there is no route at all", parsedOnly.found === false,
  "a parser alone cannot connect these two repositories");

// --- blast radius ----------------------------------------------------------
const blast = await impact(TMP, "api::store_writeorder");
const reached = blast.reached.map((r) => `${r.service}/${r.name}${r.viaContract ? "*" : ""}`);
check("a change is felt in the other service too", blast.reached.length === 3,
  reached.join(", "));

check("everything past the wire is marked as inferred",
  blast.reached.filter((r) => r.service === "web").every((r) => r.viaContract)
  && blast.reached.filter((r) => r.service === "api").every((r) => !r.viaContract),
  "* marks a symbol reached only through a route string");

check("and it is reported per service",
  blast.services.length === 2 && blast.services.every((s) => s.count > 0),
  blast.services.map((s) => `${s.service}:${s.count}`).join(", "));

// --- what the working tree says, not what the index remembers --------------
const sym = symbol(TMP, "api::store_writeorder");
check("source comes from the file, not the index",
  sym.source?.text?.includes("export async function writeOrder"),
  (sym.source?.text ?? "").split("\n")[0]);

// A symbol that moves must still be found, and the move reported: this is the
// difference between a stale graph and a wrong one.
write("api/src/store.js", `// a line added at the top\n// and another\nexport async function writeOrder(order) {\n  return { id: 1, ...order };\n}\n`);
const moved = symbol(TMP, "api::store_writeorder");
check("a symbol that moved is found where it now is",
  moved.source?.moved === true && moved.source.line === 3,
  `graph said line 2, source says line ${moved.source?.line}`);

write("api/src/store.js", `// the function was deleted\n`);
const gone = symbol(TMP, "api::store_writeorder");
check("a symbol that is gone is reported gone, not quoted",
  !gone.source?.text && !!gone.source?.missing,
  gone.source?.missing ?? "(still quoted!)");

// --- the shapes a page needs ------------------------------------------------
// The tree arrives a branch at a time. A project with a hundred thousand
// symbols is eleven megabytes of tree if sent whole, which is not something
// anybody browses — so the contract is one level, with the totals carried on
// every row so a folded branch still says how much it is hiding.
const t = tree(TMP);
check("the top level is the services, with their totals",
  t.children.length === 2 && t.symbols === 4 && t.children.every((c) => c.symbols > 0),
  t.children.map((c) => `${c.name}:${c.symbols}`).join(" "));

check("branches below are counted but not sent",
  t.children.every((c) => c.children.length === 0 && c.childCount > 0 && c.hasMore),
  t.children.map((c) => `${c.name} holds ${c.childCount}, unsent`).join(" | "));

const branch = tree(TMP, { under: t.children[0].path });
check("and a named branch returns its own children",
  !!branch && branch.name === t.children[0].name && branch.children.length > 0,
  branch ? `${branch.name} -> ${branch.children.map((c) => c.name).join(", ")}` : "(not found)");

const deeper = tree(TMP, { under: t.children[0].path, depth: 3 });
const symbols = [];
(function walk(n) { if (n.kind === "symbol") symbols.push(n.name); (n.children ?? []).forEach(walk); })(deeper);
check("asking deeper reaches the symbols themselves",
  symbols.length > 0 && symbols.every((n) => typeof n === "string"),
  symbols.join(", ") || "(none)");

check("a branch that does not exist is not silently the whole tree",
  tree(TMP, { under: "no/such/place" }) === null,
  "returns null rather than falling back to the root");

const nb = await neighbourhood(TMP, "web::api_placeorder", { depth: 1 });
check("a neighbourhood carries the root and its edges",
  nb.nodes.some((n) => n.isRoot) && nb.links.some((l) => l.viaContract),
  `${nb.nodes.length} node(s), ${nb.links.length} link(s), ${nb.links.filter((l) => l.viaContract).length} inferred`);

const ov = await overview(TMP);
check("the overview ranks hubs by how connected they are",
  ov.hubs.length > 0 && ov.hubs[0].degree >= ov.hubs[ov.hubs.length - 1].degree,
  ov.hubs.map((h) => `${h.name}:${h.degree}`).join(", "));

check("and counts the contracts as part of the project's shape",
  ov.counts.contracts === 1 && ov.services.length === 2,
  JSON.stringify(ov.counts));

console.log(`\n${failed ? `${failed} check(s) failed` : "all checks passed"}`);
close();
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exitCode = failed ? 1 : 0;
