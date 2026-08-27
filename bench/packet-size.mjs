#!/usr/bin/env node
/**
 * What a code_context packet costs, against what reading the files would.
 *
 * The counterfactual has to be a real one or the number is theatre: the
 * baseline here is the whole text of every file the selected symbols live in,
 * because that is what somebody without this actually reads to answer the
 * question. Not an estimate, not a sample — the bytes on disk.
 *
 * Usage: node bench/packet-size.mjs <repo> "<task>"
 */
import fs from "node:fs";
import path from "node:path";

import { loadGraph, sliceSymbol, callersOf, calleesOf } from "../lib/graph.mjs";
import { graphFromDb, isIndexed, searchSymbols } from "../lib/graphdb.mjs";
import { embed, similarity, fromBlob, embeddingsInstalled } from "../lib/embed.mjs";
import { rerankSymbols } from "../lib/llm.mjs";
import { modelInstalled } from "../lib/services.mjs";

const REPO = path.resolve(process.argv[2] ?? ".");
const TASK = process.argv[3] ?? "where does the score get written to a file";
const LIMIT = Number(process.argv[4] ?? 5);

const g = isIndexed(REPO) ? graphFromDb(REPO) : loadGraph(REPO);
if (!g) { console.error(`${REPO} has no graph. Run: amalgam graph`); process.exit(1); }

/** The same selection code_context uses, minus the MCP plumbing. */
async function select() {
  if (isIndexed(REPO) && embeddingsInstalled()) {
    const [qv] = (await embed(TASK, { query: true })) ?? [];
    if (qv) {
      const wide = searchSymbols(REPO, TASK, { vec: qv, limit: Math.max(LIMIT * 4, 20), similarity, fromBlob });
      const ordered = modelInstalled() ? (await rerankSymbols(TASK, wide)) ?? wide : wide;
      return ordered.slice(0, LIMIT).map((h) => g.nodes.get(h.id) ?? h);
    }
  }
  return searchSymbols(REPO, TASK, { limit: LIMIT }).map((h) => g.nodes.get(h.id) ?? h);
}

const hits = await select();

// The packet: one header line per symbol, then its current source.
let packet = "";
for (const n of hits) {
  const callers = (callersOf(g, n.id) ?? []).map((c) => g.nodes.get(c.id)?.name ?? c.id);
  const callees = (calleesOf(g, n.id) ?? []).map((c) => g.nodes.get(c.id)?.name ?? c.id);
  const sym = sliceSymbol(REPO, n, 14);
  packet += `--- ${n.file}:${n.line}  ${n.label}` +
            `${callers.length ? `  |  called by: ${callers.slice(0, 3).join(", ")}` : ""}` +
            `${callees.length ? `  |  calls: ${callees.slice(0, 3).join(", ")}` : ""}\n`;
  packet += (sym.missing ? `    [${sym.missing}]` : sym.text) + "\n";
}

// The counterfactual: every file those symbols live in, in full.
const files = [...new Set(hits.map((n) => n.file).filter(Boolean))];
let baseline = 0;
const sizes = [];
for (const f of files) {
  try {
    const bytes = fs.readFileSync(path.join(REPO, f), "utf8").length;
    baseline += bytes;
    sizes.push([f, bytes]);
  } catch { /* a symbol whose file has moved contributes nothing */ }
}

const pct = baseline ? (100 - (packet.length / baseline) * 100) : 0;

console.log(`repo   ${REPO}`);
console.log(`task   "${TASK}"\n`);
for (const [f, n] of sizes) console.log(`  ${String(n).padStart(9)}  ${f}`);
console.log(`\n  reading those ${files.length} file(s) : ${baseline.toLocaleString()} characters`);
console.log(`  the packet instead      : ${packet.length.toLocaleString()} characters`);
console.log(`  reduction               : ${pct.toFixed(1)}%\n`);
console.log(packet);
