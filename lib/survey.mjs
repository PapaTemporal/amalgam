/**
 * Brownfield triage: where to start, and what not to touch yet.
 *
 * The planning layer already gathers what a codebase IS — project-context
 * writes it down, and the spec and build flows accept brownfield input. What
 * neither can tell you is which parts are dangerous, because that is not a
 * question about the code's meaning. It is a question about its history, its
 * shape and its test coverage, and all three are sitting on the machine.
 *
 * So this measures rather than reads:
 *
 *   churn      how often a file changes, from git — a proxy for where the
 *              work actually is, as opposed to where the architecture diagram
 *              says it should be;
 *   fan-in     how many other places depend on it, from the code graph — the
 *              blast radius of getting it wrong;
 *   coupling   which files keep changing in the same commit as each other,
 *              which finds the seams the directory layout hides;
 *   tests      whether anything under a test path reaches it at all.
 *
 * Risk is churn times fan-in: a file nobody depends on can churn freely, and a
 * file everything depends on is fine if it never changes. Danger is the
 * product, and the product with no tests under it is where a brownfield
 * project goes to die. That last set is the output that matters — it is the
 * list of characterization tests to write before touching anything.
 *
 * Nothing here needs a model, a network, or an opinion.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const TEST_PATH = /(^|[\\/])(tests?|spec|specs|__tests__|e2e)([\\/]|$)|\.(test|spec)\.[a-z]+$|(^|[\\/])[^\\/]*_test\.[a-z]+$/i;

export const isTestFile = (f) => TEST_PATH.test(f);

// Extensions worth triaging when there is no graph to say what "code" means.
// Documentation churns as hard as any source file and has no dependents and no
// tests, so left in it colonises the top of the ranking and teaches the reader
// to skim past it.
const CODE_EXT = /\.(m?[jt]sx?|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|scala|sh|ps1|sql|vue|svelte)$/i;

function git(repo, args) {
  const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: r.stdout ?? "" };
}

/**
 * History per file, and which files travel together.
 *
 * One `git log` pass rather than one per file: on a large repository the
 * difference is minutes. Merge commits are excluded — they record integration,
 * not authorship, and would credit every file in a big merge with a change
 * nobody made.
 */
export function history(repo, { days = 365, maxCommitFiles = 40 } = {}) {
  const since = `--since=${days}.days.ago`;
  const log = git(repo, ["log", since, "--no-merges", "--name-only", "--format=%x01%H%x02%at%x02%an"]);
  if (!log.ok) return null;

  const files = new Map();      // path -> { commits, authors:Set, last }
  const pairs = new Map();      // "a\x00b" -> count
  let commits = 0;

  for (const chunk of log.out.split("\x01").slice(1)) {
    const [header, ...rest] = chunk.split(/\r?\n/);
    const [, at, author] = header.split("\x02");
    const touched = rest.map((l) => l.trim()).filter(Boolean);
    if (!touched.length) continue;
    commits++;

    for (const f of touched) {
      const rec = files.get(f) ?? { commits: 0, authors: new Set(), last: 0 };
      rec.commits++;
      rec.authors.add(author);
      rec.last = Math.max(rec.last, Number(at) || 0);
      files.set(f, rec);
    }

    // A commit touching half the repository says nothing about coupling — it
    // is a rename, a reformat or a licence header, and counting its pairs
    // would couple everything to everything.
    if (touched.length > maxCommitFiles) continue;
    for (let i = 0; i < touched.length; i++) {
      for (let j = i + 1; j < touched.length; j++) {
        const key = [touched[i], touched[j]].sort().join("\x00");
        pairs.set(key, (pairs.get(key) ?? 0) + 1);
      }
    }
  }
  return { commits, files, pairs };
}

/** Fan-in per file from the graph: how many other files call into it. */
export function fanIn(graph) {
  const byFile = new Map();
  if (!graph) return byFile;
  for (const [target, edges] of graph.callers) {
    const to = graph.nodes.get(target);
    if (!to?.file) continue;
    const callers = new Set();
    for (const e of edges) {
      const from = graph.nodes.get(e.id);
      if (from?.file && from.file !== to.file) callers.add(from.file);
    }
    byFile.set(to.file, (byFile.get(to.file) ?? new Set()));
    for (const c of callers) byFile.get(to.file).add(c);
  }
  return byFile;
}

/** Which non-test files anything under a test path actually reaches. */
export function testedFiles(graph) {
  const covered = new Set();
  if (!graph) return covered;
  for (const [target, edges] of graph.callers) {
    const to = graph.nodes.get(target);
    if (!to?.file || isTestFile(to.file)) continue;
    for (const e of edges) {
      const from = graph.nodes.get(e.id);
      if (from?.file && isTestFile(from.file)) { covered.add(to.file); break; }
    }
  }
  return covered;
}

const norm = (v, max) => (max > 0 ? v / max : 0);

/**
 * Rank the files worth being careful about.
 *
 * The score is deliberately a product and deliberately crude. What earns its
 * place is not the number but the reasons attached to it: a ranking a reader
 * cannot argue with is a ranking they cannot use.
 */
export function rank(repo, { graph = null, days = 365, limit = 12, codeOnly = true } = {}) {
  const hist = history(repo, { days });
  if (!hist) return null;

  const inbound = fanIn(graph);
  const covered = testedFiles(graph);
  // What counts as code: whatever the indexer parsed, when there is an index.
  // It is a better answer than any extension list, because it is this
  // project's answer rather than a guess about projects in general.
  const known = graph ? new Set([...graph.nodes.values()].map((n) => n.file).filter(Boolean)) : null;
  const isCode = (f) => !codeOnly || (known?.size ? known.has(f) : CODE_EXT.test(f));

  // In a repository with one author, "one author" describes the repository
  // rather than the file, and saying it on every line is noise.
  const soloRepo = new Set([...hist.files.values()].flatMap((r) => [...r.authors])).size <= 1;
  const maxCommits = Math.max(...[...hist.files.values()].map((f) => f.commits), 1);
  const maxFan = Math.max(...[...inbound.values()].map((s) => s.size), 1);

  const rows = [];
  for (const [file, rec] of hist.files) {
    if (isTestFile(file) || !isCode(file)) continue;
    if (!fs.existsSync(path.join(repo, file))) continue;      // deleted since
    const fan = inbound.get(file)?.size ?? 0;
    const churn = norm(rec.commits, maxCommits);
    const reach = norm(fan, maxFan);
    // Either alone is survivable; together they are what "we cannot change
    // this" is made of. The floor keeps a file with no graph presence from
    // scoring zero purely because nothing calls it by name.
    const risk = (churn + 0.15) * (reach + 0.15);
    const tested = covered.has(file);

    const why = [];
    if (rec.commits >= Math.max(3, maxCommits * 0.5)) why.push(`${rec.commits} commits`);
    if (fan >= Math.max(2, maxFan * 0.5)) why.push(`${fan} dependent file(s)`);
    if (!tested) why.push("no test reaches it");
    if (rec.authors.size === 1 && !soloRepo) why.push(`one author (${[...rec.authors][0]})`);

    rows.push({ file, commits: rec.commits, authors: rec.authors.size, fan, tested, risk, why,
      lastDays: rec.last ? Math.floor((Date.now() / 1000 - rec.last) / 86400) : null });
  }

  rows.sort((a, b) => (b.risk - a.risk) || (b.commits - a.commits));
  return { commits: hist.commits, files: hist.files.size, rows: rows.slice(0, limit), all: rows, pairs: hist.pairs, isCode };
}

/** Files that keep changing together despite living apart. */
export function coupling(pairs, { min = 3, limit = 8, keep = null } = {}) {
  // `keep` is normally the survey's own idea of what counts as code. Without
  // it, documentation wins: a README changes alongside whatever it documents,
  // which is the system working exactly as intended and tells a reader
  // nothing about hidden seams.
  const wanted = (f) => (keep ? keep(f) : true);
  return [...pairs.entries()]
    .map(([k, n]) => { const [a, b] = k.split("\x00"); return { a, b, n }; })
    .filter((p) => p.n >= min && path.dirname(p.a) !== path.dirname(p.b) && wanted(p.a) && wanted(p.b))
    .sort((x, y) => y.n - x.n)
    .slice(0, limit);
}

export function render(survey, { repo, gate = null } = {}) {
  if (!survey) return `Not a git repository, or no history: ${repo}`;
  const lines = [`${path.basename(repo)} — ${survey.commits} commits, ${survey.files} files touched`];

  if (gate) {
    lines.push("");
    lines.push(gate.detected
      ? `Bootstrap: ${gate.passed ? "the project's own checks pass" : "the project's own checks FAIL — fix this before anything else"}`
      : "Bootstrap: no checks detected — there is no way to tell whether a change broke anything.");
  }

  const untested = survey.rows.filter((r) => !r.tested);
  lines.push("");
  lines.push("Riskiest files (churn × dependents):");
  for (const r of survey.rows) {
    lines.push(`  ${r.tested ? " " : "!"} ${r.file}`);
    lines.push(`      ${r.why.join(", ") || `${r.commits} commits, ${r.fan} dependents`}`
      + `${r.lastDays !== null ? `, last touched ${r.lastDays}d ago` : ""}`);
  }

  if (untested.length) {
    lines.push("");
    lines.push("Write characterization tests here first — high risk, nothing testing them:");
    for (const r of untested.slice(0, 5)) lines.push(`  ${r.file}`);
  }

  const couples = coupling(survey.pairs, { keep: survey.isCode });
  if (couples.length) {
    lines.push("");
    lines.push("Changes together but lives apart — a seam the layout hides:");
    for (const c of couples) lines.push(`  ${c.n}×  ${c.a}  +  ${c.b}`);
  }

  // The safest place to start: something real work touches, that tests already
  // cover, so a first change is verifiable before anybody trusts the agent.
  const safe = survey.all.filter((r) => r.tested && r.commits >= 2).slice(-5).reverse();
  if (safe.length) {
    lines.push("");
    lines.push("Safest place to make a first change (active, and already covered):");
    for (const r of safe.slice(0, 3)) lines.push(`  ${r.file}  (${r.commits} commits, tests reach it)`);
  }

  lines.push("");
  lines.push("Churn and dependents are measurements; the ranking between them is a heuristic. Read the reasons, not the order.");
  return lines.join("\n");
}
