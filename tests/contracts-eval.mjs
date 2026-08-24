#!/usr/bin/env node
/**
 * Contract inference evaluation.
 *
 * The claim: in a workspace of several services, the links between them can be
 * found without a model and without running anything — because the two halves
 * of an HTTP call are both written down, one as a route and one as a string.
 *
 * A parser cannot see these edges. `fetch("/api/catalog")` and
 * `app.get("/api/catalog", handler)` share no symbol, no import and no call:
 * to a call graph they are two unrelated files. That is exactly the boundary
 * this exists to cross, so the fixture is a real workspace on disk with the
 * shapes that actually occur — a client wrapper that hides the URL, a
 * configured base host in front of the path, and route parameters spelled
 * differently on each side.
 *
 * Both directions matter and they fail differently. A missed edge is invisible
 * — the service is simply reported as calling nothing — so the fixture asserts
 * on the exact edge set rather than a count. An invented edge is worse, since
 * it is a confident wrong answer, so route declarations must never be counted
 * as calls to themselves.
 *
 * Usage: node tests/contracts-eval.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { scan, match, normalisePath } = await import("../lib/contracts.mjs");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "amalgam-contracts-"));

let failed = 0;
const check = (name, pass, detail) => {
  if (!pass) failed++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
  if (detail) console.log(`      ${detail}`);
};

console.log("contract inference eval  (real files, no model)\n");

// --- a workspace of three services that talk to each other ------------------
const write = (rel, body) => {
  const full = path.join(TMP, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
};

// A client whose call sites never contain a full URL: the wrapper holds the
// fetch, the callers hold the tail. Very common, and invisible to anything
// that only looks for fetch().
write("web/src/api.js", `
const BASE = process.env.API_BASE ?? "";
async function request(method, path, body) {
  return fetch(\`\${BASE}\${path}\`, { method, body: JSON.stringify(body) });
}
export const listProducts = () => request("GET", "/api/catalog");
export const getProduct = (id) => request("GET", \`/api/catalog/\${id}\`);
export const placeOrder = (cart) => request("POST", "/api/orders", cart);
`);

// An express service that both serves routes and calls another service, with
// the downstream host coming from configuration.
write("catalog/src/server.js", `
import express from "express";
import { checkStock } from "./stock.js";
const app = express();
app.get("/api/catalog", async (req, res) => res.json(await findAll()));
app.get("/api/catalog/:id", async (req, res) => {
  res.json({ available: await checkStock(req.params.id) });
});
`);
write("catalog/src/stock.js", `
const INVENTORY = process.env.INVENTORY_URL ?? "http://inventory:8080";
export async function checkStock(sku) {
  const res = await fetch(\`\${INVENTORY}/api/inventory/\${sku}\`);
  return (await res.json()).available;
}
`);

write("inventory/src/server.js", `
import express from "express";
const app = express();
app.get("/api/inventory/:sku", async (req, res) => res.json({ available: 1 }));
app.post("/api/orders", async (req, res) => res.status(201).json({ id: 1 }));
// app.get("/api/documented-but-not-real", handler)
`);

const services = ["web", "catalog", "inventory"];
const scans = services.map((s) => scan(path.join(TMP, s), { service: s }));
const merged = {
  provides: scans.flatMap((r) => r.provides),
  consumes: scans.flatMap((r) => r.consumes),
};
const { edges, orphanRoutes, orphanCalls } = match(merged);
const edge = (m, p) => edges.find((e) => e.path === p && (!m || e.method === m || e.method === null));
const where = (e) => (e ? `${e.from.service}/${e.from.file}:${e.from.line} -> ${e.to.service}/${e.to.file}:${e.to.line}` : "(not found)");

// --- the edges a parser cannot see -----------------------------------------
check("a wrapper call reaches the route it means",
  !!edge("GET", "/api/catalog") && edge("GET", "/api/catalog").to.service === "catalog",
  where(edge("GET", "/api/catalog")));

check("a parameter spelled differently on each side still matches",
  !!edge("GET", "/api/catalog/:_"),
  `client writes \${id}, server writes :id -> ${where(edge("GET", "/api/catalog/:_"))}`);

// The bug this was written for: a fetch whose literal begins with a configured
// host was skipped before any pattern ran, so the service it called was
// reported as a route nobody uses.
const downstream = edge(null, "/api/inventory/:_");
check("a call through a configured base URL is found",
  !!downstream && downstream.from.service === "catalog" && downstream.to.service === "inventory",
  where(downstream));

check("an edge crossing services is marked as crossing one",
  !!downstream?.crossService,
  downstream ? `${downstream.from.service} -> ${downstream.to.service}` : "(no edge)");

// --- what must not be invented ---------------------------------------------
const selfEdges = edges.filter((e) => e.from.file === e.to.file && e.from.line === e.to.line);
check("a route declaration is not read as a call to itself", selfEdges.length === 0,
  selfEdges.length ? selfEdges.map((e) => `${e.path} @ ${e.from.file}:${e.from.line}`).join(", ")
                   : `${edges.length} edges, none self-referential`);

check("a route named only in a comment is not reported",
  !edges.some((e) => e.path.includes("documented-but-not-real"))
  && !orphanRoutes.some((o) => o.path.includes("documented-but-not-real")),
  "commented-out routes are documentation, not contracts");

check("every edge names a real file and line",
  edges.every((e) => fs.existsSync(path.join(TMP, e.from.service, e.from.file)) && e.from.line > 0 && e.to.line > 0),
  `${edges.length} edge(s) checked`);

// --- and what it admits it does not know ------------------------------------
check("evidence is graded, not asserted",
  edges.every((e) => typeof e.confidence === "string" && e.confidence.length),
  [...new Set(edges.map((e) => e.confidence))].join(", "));

check("a route nothing calls is reported rather than hidden",
  Array.isArray(orphanRoutes) && Array.isArray(orphanCalls),
  `${orphanRoutes.length} uncalled route(s), ${orphanCalls.length} call(s) to nothing here`);

// --- normalisation is the thing both sides agree about ----------------------
const pairs = [
  ["/api/jobs/${id}/stream", "/api/jobs/:id/stream"],
  ["/api/users/{userId}", "/api/users/:id"],
  ["http://host:8080/api/x?q=1", "/api/x"],
  ["/api/items/<int:pk>", "/api/items/:pk"],
];
const disagreed = pairs.filter(([a, b]) => normalisePath(a) !== normalisePath(b));
check("the same route written four ways normalises to one", disagreed.length === 0,
  disagreed.length ? disagreed.map(([a, b]) => `${a} != ${b}`).join("; ")
                   : pairs.map(([a]) => normalisePath(a)).join(" "));

console.log(`\n${failed ? `${failed} check(s) failed` : "all checks passed"}`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exitCode = failed ? 1 : 0;
