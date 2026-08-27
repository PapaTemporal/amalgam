#!/usr/bin/env node
/**
 * Can words alone answer these questions at all?
 *
 * Before tuning a lexical scorer it is worth asking whether the target is
 * reachable by words in principle: if a question shares no vocabulary with the
 * symbol that answers it — not in its name, its path, its signature, its doc
 * comment or its module's — then no amount of stemming, splitting or field
 * weighting will find it, and a scorer that appears to is matching something
 * else by luck.
 */
import { open } from "../lib/db.mjs";
import { queryTerms, tokens } from "../lib/lexical.mjs";

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

const db = open();
const row = (name) => db.prepare(
  `SELECT name, label, file, signature, doc, context FROM symbols
   WHERE repo LIKE '%amalgam-pkg%' AND name = ? LIMIT 1`).get(name);

console.log("Do the question's words appear anywhere in the symbol that answers it?\n");
console.log("                       own text        + module text");
let reachableOwn = 0, reachableCtx = 0;

for (const [q, want] of CASES) {
  const r = row(want);
  if (!r) { console.log(`  ${want}: not in the index`); continue; }
  const terms = queryTerms(q);
  const own = new Set([...tokens(r.label || r.name), ...tokens(r.file),
                       ...tokens(r.signature ?? ""), ...tokens(r.doc ?? "")]);
  const ctx = new Set([...own, ...tokens(r.context ?? "")]);

  const hitOwn = terms.filter((t) => own.has(t));
  const hitCtx = terms.filter((t) => ctx.has(t));
  if (hitOwn.length) reachableOwn++;
  if (hitCtx.length) reachableCtx++;

  console.log(`  ${want.padEnd(20)} ${String(hitOwn.length + "/" + terms.length).padStart(5)}  ${(hitOwn.join(",") || "—").padEnd(22)} ${String(hitCtx.length + "/" + terms.length).padStart(5)}  ${hitCtx.join(",") || "—"}`);
}

console.log(`\n${reachableOwn}/${CASES.length} reachable from the symbol's own text`);
console.log(`${reachableCtx}/${CASES.length} reachable if the whole module's comment counts`);
console.log(`\nA symbol sharing no word with the question cannot be found by words.`);
console.log(`Where the only overlap is the module comment, every symbol in that file`);
console.log(`shares it, so it separates files but never symbols within one.`);
