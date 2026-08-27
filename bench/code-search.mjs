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

// The other half of the question, and the one the no-model path can actually
// answer: somebody who knows roughly what the code calls things but not the
// exact identifier. Nobody types `symbolsInRanges`; they type "symbols in a
// range". These are not easier questions, they are a different KIND — the
// vocabulary is shared, so words are enough in principle, and what is being
// measured is whether the matching survives plurals, tenses and the fact that
// an identifier is several words with the spaces taken out.
const VOCAB = [
  ["importing graphs", "importGraph"],
  ["slicing a symbol", "sliceSymbol"],
  ["which symbols get selected", "selectSymbols"],
  ["fts queries", "ftsQuery"],
  ["symbols in ranges", "symbolsInRanges"],
  ["adding events", "addEvent"],
  ["verifying edges", "verifyEdge"],
  ["candidates for superseding", "supersedeCandidates"],
  ["files that are stale", "staleFiles"],
  ["planning a refresh", "refreshPlan"],
  ["verifying facts", "verifyFact"],
  ["resuming work", "resume"],
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

async function run(label, search, cases = CASES) {
  const ranks = [];
  for (const [q, want] of cases) ranks.push(rankOf(await search(q), want));
  const at = (n) => ranks.filter((r) => r <= n).length;
  const mrr = ranks.reduce((s, r) => s + (r === Infinity ? 0 : 1 / r), 0) / ranks.length;
  console.log(`${label.padEnd(32)} hit@1 ${at(1)}/${cases.length}   hit@3 ${at(3)}/${cases.length}   hit@5 ${at(5)}/${cases.length}   MRR ${mrr.toFixed(3)}`);
  return ranks;
}

console.log(`repo ${REPO}
${CASES.length} questions of each kind, against the same ${CASES.length} symbols
each tier is a configuration: no downloads, the embedding model alone, or both
`);

/** Every configuration this machine can offer, run over one set of questions. */
async function tiers(title, cases) {
  console.log(title);
  const out = {};
  out.names = await run("  no downloads", async (q) => findSymbols(g, q, 5), cases);

  if (!withVectors) {
    console.log("  embeddings                skipped — no embedding model installed");
    console.log("");
    return out;
  }

  out.semantic = await run("  + embeddings", async (q) => {
    const [qv] = (await embed(q, { query: true })) ?? [];
    return searchSymbols(REPO, q, { vec: qv, limit: 5, similarity, fromBlob, expand: false });
  }, cases);

  out.expanded = await run("  + graph neighbours", async (q) => {
    const [qv] = (await embed(q, { query: true })) ?? [];
    return searchSymbols(REPO, q, { vec: qv, limit: 5, similarity, fromBlob, expand: true });
  }, cases);

  if (!modelInstalled()) {
    console.log("  + local rerank            skipped — no local model installed");
  } else {
    out.reranked = await run("  + local rerank", async (q) => {
      const [qv] = (await embed(q, { query: true })) ?? [];
      const wide = searchSymbols(REPO, q, { vec: qv, limit: 20, similarity, fromBlob, expand: true });
      return (await rerankSymbols(q, wide)) ?? wide;
    }, cases);
  }
  console.log("");
  return out;
}

// Reported separately, never averaged. They are not harder and easier versions
// of one question — they are two different questions, and a number covering
// both describes neither.
const intent = await tiers("asked by intent, sharing no vocabulary with the answer:", CASES);
const vocab = await tiers("asked in the code's own vocabulary:", VOCAB);

const nameOnly = intent.names;
const semantic = intent.semantic, expanded = intent.expanded, reranked = intent.reranked;

if (semantic) {
  console.log("\nper question (rank of the wanted symbol, - = not in top 5):");
  CASES.forEach(([q, want], i) => {
    const f = (r) => (r === Infinity ? "-" : String(r));
    console.log(`  names ${f(nameOnly[i]).padStart(2)}  meaning ${f(semantic[i]).padStart(2)}  +graph ${f(expanded[i]).padStart(2)}  +rerank ${f(reranked?.[i] ?? Infinity).padStart(2)}   ${want.padEnd(20)} ${q}`);
  });
}
