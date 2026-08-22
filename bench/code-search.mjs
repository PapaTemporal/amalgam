#!/usr/bin/env node
/**
 * Retrieval benchmark for code_context's symbol selection.
 *
 * Distinct from tests/: a test pins behaviour and must pass, a benchmark
 * measures quality against a real codebase and is expected to move. The
 * questions below are phrased the way somebody actually asks them — by intent,
 * not by identifier — and each names the symbol a competent reader would want
 * back. Nothing here is tuned against; when a number improves the change is
 * kept, when it does not it is reverted.
 *
 * Runs against whatever repo is passed (default: this one), using its live
 * index, so it measures the system as deployed rather than a fixture.
 *
 * Usage: node bench/code-search.mjs [repo]
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { searchSymbols, isIndexed } from "../lib/graphdb.mjs";
import { findSymbols } from "../lib/graph.mjs";
import { loadGraph } from "../lib/graph.mjs";
import { embed, similarity, fromBlob, embeddingsInstalled } from "../lib/embed.mjs";
import { rerankSymbols } from "../lib/llm.mjs";
import { modelInstalled } from "../lib/services.mjs";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = path.resolve(process.argv[2] ?? PKG);

// question -> the symbol that answers it
const CASES = [
  ["how do we decide a stored memory has gone out of date", "verifyFact"],
  ["what stops the mistake and its correction both coming back", "supersedeCandidates"],
  ["where do we stop believing what the code graph says", "verifyEdge"],
  ["how is a piece of work picked back up days later", "resume"],
  ["what keeps a rebuild from recomputing every vector", "importGraph"],
  ["how does a diff turn into the functions it touched", "symbolsInRanges"],
  ["where is the text of a function actually read from", "sliceSymbol"],
  ["how do we avoid quoting code that has since moved", "sliceSymbol"],
  ["what decides which lines get sent to the model", "selectSymbols"],
  ["how is the saving actually measured rather than guessed", "cmdStats"],
  ["where does a work item's history get written down", "addEvent"],
  ["what turns a plain question into database search terms", "ftsQuery"],
];

if (!isIndexed(REPO)) {
  console.error(`${REPO} is not indexed. Run: amalgam graph`);
  process.exit(1);
}
const g = loadGraph(REPO);
const withVectors = embeddingsInstalled();

const rankOf = (hits, want) => {
  const i = hits.findIndex((h) => h.name === want);
  return i < 0 ? Infinity : i + 1;
};

async function run(label, search) {
  const ranks = [];
  for (const [q, want] of CASES) ranks.push(rankOf(await search(q), want));
  const at = (n) => ranks.filter((r) => r <= n).length;
  const mrr = ranks.reduce((s, r) => s + (r === Infinity ? 0 : 1 / r), 0) / ranks.length;
  console.log(`${label.padEnd(26)} hit@1 ${at(1)}/${CASES.length}   hit@3 ${at(3)}/${CASES.length}   hit@5 ${at(5)}/${CASES.length}   MRR ${mrr.toFixed(3)}`);
  return ranks;
}

console.log(`repo ${REPO}\n${CASES.length} questions, each phrased as intent rather than by name\n`);

const nameOnly = await run("names only", async (q) => findSymbols(g, q, 5));

let semantic = null, expanded = null, reranked = null;
if (!withVectors) {
  console.log("semantic                   skipped — no embedding model installed");
} else {
  semantic = await run("meaning + names", async (q) => {
    const [qv] = (await embed(q, { query: true })) ?? [];
    return searchSymbols(REPO, q, { vec: qv, limit: 5, similarity, fromBlob, expand: false });
  });
  expanded = await run("+ graph neighbours", async (q) => {
    const [qv] = (await embed(q, { query: true })) ?? [];
    return searchSymbols(REPO, q, { vec: qv, limit: 5, similarity, fromBlob, expand: true });
  });
  if (!modelInstalled()) {
    console.log("+ local rerank             skipped — no local model installed");
  } else {
    const t0 = Date.now();
    reranked = await run("+ local rerank", async (q) => {
      const [qv] = (await embed(q, { query: true })) ?? [];
      const wide = searchSymbols(REPO, q, { vec: qv, limit: 20, similarity, fromBlob, expand: true });
      return (await rerankSymbols(q, wide)) ?? wide;
    });
    console.log(`${"".padEnd(26)} ${((Date.now() - t0) / CASES.length / 1000).toFixed(1)}s per question (local model)`);
  }
}

if (semantic) {
  console.log("\nper question (rank of the wanted symbol, - = not in top 5):");
  CASES.forEach(([q, want], i) => {
    const f = (r) => (r === Infinity ? "-" : String(r));
    console.log(`  names ${f(nameOnly[i]).padStart(2)}  meaning ${f(semantic[i]).padStart(2)}  +graph ${f(expanded[i]).padStart(2)}  +rerank ${f(reranked?.[i] ?? Infinity).padStart(2)}   ${want.padEnd(20)} ${q}`);
  });
}
