#!/usr/bin/env node
/**
 * Staleness evaluation.
 *
 * A code graph is a claim about a repository at a moment, and the repository
 * does not stop. Nothing here refreshes it — the refresh is a decision with a
 * cost, and on a large repository that cost is minutes. What this holds up is
 * the cheaper half of the answer: knowing precisely what the graph has not
 * seen, so an agent can read those files directly and believe the index about
 * everything else.
 *
 * The distinction being tested is between a count and a list. "12 files
 * changed" tells you to distrust the index and gives you no way to act;
 * naming them turns the same fact into instructions. The list has to be
 * accurate in both directions: every changed source file present, and nothing
 * present that would waste a read.
 *
 * Usage: node tests/freshness-eval.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const { graphStaleness, staleFiles, projectStaleness, projectStaleFiles } =
  await import("../lib/freshness.mjs");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "amalgam-fresh-"));

let failed = 0;
const check = (name, pass, detail) => {
  if (!pass) failed++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
  if (detail) console.log(`      ${detail}`);
};

console.log("staleness eval  (real git repositories)\n");

const git = (repo, ...args) =>
  spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true });

/** A repository with a graph file, and a way to move it forward. */
function repo(name) {
  const dir = path.join(TMP, name);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  return dir;
}

const commit = (dir, file, body, message) => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), body);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", message);
  return git(dir, "rev-parse", "HEAD").stdout.trim();
};

/**
 * Standing in for graphify, including the part that matters most here.
 *
 * The extractor records the commit it built at, and that is what makes the
 * boundary exact. Leaving it out of the fixture made this test exercise the
 * fallback path and treat it as the main one — and the fallback is imprecise
 * by construction, because a file timestamp has second granularity and
 * catches whatever shares its second.
 */
const writeGraph = (dir, builtAtCommit = null) => {
  fs.mkdirSync(path.join(dir, "graphify-out"), { recursive: true });
  fs.writeFileSync(path.join(dir, "graphify-out", "graph.json"),
    JSON.stringify({ nodes: [], links: [], built_at_commit: builtAtCommit }));
};

// --- nothing to report before anything moves --------------------------------
const one = repo("one");
const built = commit(one, "src/a.js", "export const a = 1;\n", "first");
writeGraph(one, built);

check("a repository with no graph has no staleness to report",
  graphStaleness(path.join(TMP, "nograph")) === null,
  "null rather than a zero, because absent and current are different");

check("a freshly built graph is not stale",
  graphStaleness(one)?.stale === false,
  JSON.stringify(graphStaleness(one)));

check("and has no files to distrust", staleFiles(one) === null);

check("the boundary comes from the recorded commit, not the clock",
  // Building in the same second as a commit is what used to report a freshly
  // built graph as one commit behind.
  graphStaleness(one).commits === 0,
  "a timestamp has second granularity; a commit does not");

// --- code moving is news, prose moving is not -------------------------------
commit(one, "README.md", "# docs\n", "docs only");
check("a documentation commit does not make a graph stale",
  graphStaleness(one)?.commits === 0,
  "a warning that is usually noise is a warning nobody reads");

commit(one, "src/b.js", "export const b = 2;\n", "new code");
commit(one, "src/c.py", "def c():\n    return 3\n", "more code");

const st = graphStaleness(one);
check("code commits are counted", st.stale && st.commits === 2, `${st.commits} commit(s)`);

// --- and named, which is the part that can be acted on ----------------------
const files = staleFiles(one);
check("the changed files are named, not just counted",
  files && files.total === 2 && files.files.includes("src/b.js") && files.files.includes("src/c.py"),
  files ? files.files.join(", ") : "(nothing)");

check("the documentation change is not among them",
  !files.files.some((f) => f.endsWith(".md")),
  "reading a README does not tell an agent what the index is missing");

// --- what would waste a read --------------------------------------------------
// A committed build directory is the common case, and it would otherwise drown
// the handful of files that matter. It is also never in the graph, so calling
// it a gap in the graph is wrong twice.
commit(one, "dist/bundle.js", "// generated\n", "build output");
commit(one, "node_modules/dep/index.js", "// vendored\n", "a dependency");
const after = staleFiles(one);
check("generated and vendored code is left out",
  after.total === 2 && !after.files.some((f) => /dist|node_modules/.test(f)),
  after.files.join(", "));

// --- long lists are capped, and say so ----------------------------------------
for (let i = 0; i < 12; i++) commit(one, `src/gen${i}.js`, `export const g${i} = ${i};\n`, `gen ${i}`);
const many = staleFiles(one, { limit: 5 });
check("a long list is capped and admits it",
  many.files.length === 5 && many.total === 14 && many.truncated,
  `${many.files.length} shown of ${many.total}`);

// --- work that has not been committed at all ----------------------------------
// The file somebody has open is the one the graph is most certainly wrong
// about, and counting only commits reported "nothing unseen" while it sat
// there being edited.
const live = repo("live");
const liveBuilt = commit(live, "src/a.js", "export const a = 1;\n", "first");
writeGraph(live, liveBuilt);

check("a clean tree at the build commit has nothing unseen", staleFiles(live) === null);

fs.writeFileSync(path.join(live, "src", "a.js"), "export const a = 99;\n");
fs.writeFileSync(path.join(live, "src", "new.js"), "export const n = 1;\n");
const dirty = staleFiles(live);
check("an edited file and an untracked one are both unseen",
  dirty && dirty.total === 2 && dirty.uncommitted === 2
  && dirty.files.includes("src/a.js") && dirty.files.includes("src/new.js"),
  dirty ? `${dirty.total} file(s), ${dirty.uncommitted} uncommitted: ${dirty.files.join(", ")}` : "(nothing)");

check("but uncommitted work is not counted as commits behind",
  graphStaleness(live).commits === 0,
  "editing a file is not a commit, and saying otherwise would misreport the rebuild decision");

// --- a workspace answers per repository ---------------------------------------
// A merged graph has no single build commit, so asking the project as a whole
// returns nothing — which is why this used to be silent on exactly the
// projects that most need it.
const two = repo("two");
const twoBuilt = commit(two, "src/x.js", "export const x = 1;\n", "first");
writeGraph(two, twoBuilt);
commit(two, "src/y.js", "export const y = 2;\n", "changed");

const services = [{ name: "one", path: one }, { name: "two", path: two }];
const perService = projectStaleFiles(TMP, services);
check("a workspace reports staleness per repository",
  perService.length === 2 && perService.every((p) => p.service && p.total > 0),
  perService.map((p) => `${p.service}:${p.total}`).join(", "));

const rollup = projectStaleness(TMP, services);
check("and rolls up which of them are behind",
  rollup.stale && rollup.behind.length === 2,
  `${rollup.commits} commit(s) across ${rollup.behind.join(", ")}`);

// --- a repository that is not under version control ---------------------------
// A graph with no recorded commit falls back to the file's timestamp, which
// is all there is to fall back to. It still answers; it is simply not exact at
// the boundary, and nothing here pretends otherwise.
const noCommit = repo("nocommit");
commit(noCommit, "src/a.js", "export const a = 1;\n", "first");
writeGraph(noCommit);
commit(noCommit, "src/b.js", "export const b = 2;\n", "after");
check("a graph with no recorded commit still reports what changed",
  (staleFiles(noCommit)?.files ?? []).includes("src/b.js"),
  "a timestamp is a worse boundary than a commit, not a useless one");

const loose = path.join(TMP, "loose");
fs.mkdirSync(loose, { recursive: true });
writeGraph(loose);
const st2 = graphStaleness(loose);
check("without git, not knowing is reported as not knowing",
  st2 && st2.unknown === true && st2.stale === false,
  "no commits to count is not the same as nothing having changed");

check("and no files are claimed either", staleFiles(loose) === null);

console.log(`\n${failed ? `${failed} check(s) failed` : "all checks passed"}`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exitCode = failed ? 1 : 0;
