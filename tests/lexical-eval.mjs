#!/usr/bin/env node
/**
 * Matching words when there is no model to match meaning with.
 *
 * The claim being pinned: an identifier is several words with the spaces taken
 * out, and a question is the same words with different endings. Treating both
 * as opaque strings is what made the no-model path nearly useless — measured
 * on this repository, questions phrased in the code's own vocabulary went from
 * 1/12 found first to 9/12 by splitting and trimming alone.
 *
 * What is NOT claimed is that this bridges vocabulary. "Where is authentication
 * handled" will not reach validateSession, and bench/vocabulary-overlap.mjs
 * exists to show why: a question sharing no word with its answer cannot be
 * matched by words, however the matching is arranged. That gap is what the
 * embedding model is for, and the last check here guards against anyone
 * "fixing" it by loosening the matching until unrelated things collide.
 *
 * Usage: node tests/lexical-eval.mjs
 */
import { tokens, stem, queryTerms, lexicalScore } from "../lib/lexical.mjs";

let failed = 0;
const check = (name, pass, detail) => {
  if (!pass) failed++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
  if (detail) console.log(`      ${detail}`);
};

console.log("lexical matching\n");

// --- an identifier is several words -----------------------------------------
{
  const t = tokens("placeOrder");
  check("camelCase splits into its words", t.length === 2, t.join(","));

  // The spelling of a stem is not the point; arriving at the SAME one from
  // either side is. "placing orders" and `placeOrder` have to meet somewhere,
  // and it does not matter where.
  check("however it is asked for",
    ["place order", "placing orders", "place_order"].every(
      (q) => tokens(q).join(",") === t.join(",")),
    `${t.join(",")} <- ${tokens("placing orders").join(",")}`);

  check("so do snake_case and kebab-case",
    tokens("stale_files").join(",") === tokens("staleFiles").join(",") &&
    tokens("stale-files").join(",") === tokens("staleFiles").join(","),
    `${tokens("stale_files")} / ${tokens("stale-files")} / ${tokens("staleFiles")}`);

  check("an acronym followed by a word splits between them",
    tokens("FTSQuery").join(",") === "fts,query", tokens("FTSQuery").join(","));

  check("a path contributes its parts",
    tokens("lib/graphdb.mjs").includes("graphdb"), tokens("lib/graphdb.mjs").join(","));
}

// --- a question is the same words with different endings --------------------
{
  check("plurals reduce to the singular",
    stem("graphs") === "graph" && stem("events") === "event", `${stem("graphs")} ${stem("events")}`);

  check("-ing and -ed reduce to the stem",
    stem("importing") === "import" && stem("verified") === "verifi",
    `${stem("importing")} ${stem("verified")}`);

  check("-ies becomes -y, so memories meets memory",
    stem("memories") === "memory", stem("memories"));

  check("a double s is not a plural",
    stem("class") === "class" && stem("process") === "process",
    "otherwise 'class' becomes 'clas' and matches nothing");

  check("short words are left alone",
    stem("has") === "has" && stem("is") === "is");

  // Both of these were wrong once. "-es" is only a plural after a sibilant,
  // and a suffix is only worth removing if a word is left behind.
  check("-es is only stripped after a sibilant",
    stem("files") === "file" && stem("matches") === "match" && stem("boxes") === "box",
    `${stem("files")} ${stem("matches")} ${stem("boxes")}`);

  check("a suffix is not removed if nothing is left",
    stem("thing") === "thing" && stem("using") === "using",
    "'th' and 'us' would match half the codebase");

  check("the dropped e before -ing is trimmed from both sides",
    stem("slicing") === stem("slice"), `${stem("slicing")} vs ${stem("slice")}`);
}

// --- the two meet -----------------------------------------------------------
{
  const terms = queryTerms("importing graphs");
  check("a question and an identifier arrive at the same words",
    terms.every((t) => tokens("importGraph").includes(t)),
    `${terms.join(",")} vs ${tokens("importGraph").join(",")}`);

  check("function words are dropped",
    !queryTerms("how does the other one have that").length,
    queryTerms("how does the other one have that").join(",") || "(nothing left, correctly)");

  // The opposite mistake, and the more expensive one: words that only FEEL
  // generic are the content words of identifiers.
  check("but words that name things are kept",
    ["file", "value", "code", "line"].every((w) => queryTerms(`the ${w}`).length === 1),
    "dropping 'file' would mean 'stale files' could not find staleFiles");
}

// --- what counts as evidence ------------------------------------------------
{
  const terms = queryTerms("stale files");

  const byName = lexicalScore(terms, { name: "staleFiles", file: "lib/freshness.mjs" });
  const byDoc = lexicalScore(terms, { name: "helper", file: "lib/x.mjs", doc: "Which files are stale." });
  const byPath = lexicalScore(terms, { name: "helper", file: "lib/stale/files.mjs" });

  check("the identifier outweighs the doc comment", byName > byDoc, `${byName} vs ${byDoc}`);
  check("the doc comment outweighs the path", byDoc > byPath, `${byDoc} vs ${byPath}`);
  check("a symbol matching nothing scores nothing",
    lexicalScore(terms, { name: "unrelated", file: "lib/other.mjs" }) === 0);

  // Half the question answered is a real candidate; one word answered twice is
  // usually a coincidence.
  const both = lexicalScore(terms, { name: "staleFiles", file: "lib/x.mjs" });
  const oneTwice = lexicalScore(terms, { name: "files", file: "lib/files/files.mjs" });
  check("covering more of the question beats repeating one word of it",
    both > oneTwice, `${both} vs ${oneTwice}`);
}

// --- the limit, stated on purpose -------------------------------------------
{
  const terms = queryTerms("where is authentication handled");
  check("words cannot reach a symbol that shares none of them",
    lexicalScore(terms, { name: "validateSession", file: "lib/auth.mjs", doc: "Check a token." }) === 0,
    "this is what the embedding model is for; loosening the matching to fake it would only add noise");
}

console.log(`\n${failed ? `${failed} check(s) failed` : "all checks passed"}`);
process.exitCode = failed ? 1 : 0;
