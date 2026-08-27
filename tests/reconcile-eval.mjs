#!/usr/bin/env node
/**
 * Session-start reconciliation.
 *
 * The claim: a session opens knowing what changed while nobody was looking.
 * Everything a session itself does is already handled — it writes down what it
 * learned and rebuilds what fell behind on the way out. What has never been
 * handled is the gap in between: a pull, a branch switch, another machine,
 * another window. That lands on the state an agent trusts most, and trusting a
 * stale index is not a slower answer, it is a confident wrong one.
 *
 * What is tested here is mostly the silence and the cost. A notice printed
 * every session stops being read by the third one, so "nothing changed" has to
 * produce nothing at all; and the check runs before somebody's first prompt,
 * so the common case must not pay for a walk of history it does not need.
 *
 * Usage: node tests/reconcile-eval.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "amalgam-reconcile-"));
process.env.AMALGAM_HOME = path.join(TMP, "home");
process.env.AMALGAM_DB = path.join(TMP, "memory.db");
fs.mkdirSync(process.env.AMALGAM_HOME, { recursive: true });

const { codeChanged, describe } = await import("../lib/reconcile.mjs");
const { headCommit, graphIsCurrent, commitsBehind } = await import("../lib/freshness.mjs");

let failed = 0;
const check = (name, pass, detail) => {
  if (!pass) failed++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
  if (detail) console.log(`      ${detail}`);
};

console.log("session-start reconciliation\n");

const git = (repo, ...args) =>
  spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true });

/** A repository with a graph that claims to have been built at HEAD. */
function repo(name) {
  const dir = path.join(TMP, name);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "eval@local");
  git(dir, "config", "user.name", "eval");
  fs.writeFileSync(path.join(dir, "src", "a.js"), "export const a = 1;\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "first");
  return dir;
}

const graphAt = (dir, sha) => {
  fs.mkdirSync(path.join(dir, "graphify-out"), { recursive: true });
  fs.writeFileSync(path.join(dir, "graphify-out", "graph.json"),
    JSON.stringify({ nodes: [], links: [], built_at_commit: sha }));
};

const commit = (dir, file, msg) => {
  fs.writeFileSync(path.join(dir, "src", file), `export const x = "${msg}";\n`);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", msg);
};

// --- HEAD without git --------------------------------------------------------
// The cheap path reads .git directly. If it is ever wrong the whole check is
// worse than useless: it would report a stale graph as current.
{
  const r = repo("head");
  const mine = headCommit(r);
  const real = git(r, "rev-parse", "HEAD").stdout.trim();
  check("HEAD read from disk matches git", mine === real, `${mine} vs ${real}`);

  git(r, "checkout", "-q", "-b", "other");
  commit(r, "b.js", "on a branch");
  check("and follows a branch switch",
    headCommit(r) === git(r, "rev-parse", "HEAD").stdout.trim());

  git(r, "checkout", "-q", "--detach");
  check("and a detached HEAD",
    headCommit(r) === git(r, "rev-parse", "HEAD").stdout.trim());
}

// A worktree keeps its own HEAD and shares its refs, which is the case most
// likely to be got wrong — and amalgam creates them itself, for work streams.
{
  const r = repo("worktree-parent");
  const wt = path.join(TMP, "worktree-child");
  git(r, "worktree", "add", "-q", "-b", "stream/x", wt);
  check("a worktree's HEAD is read correctly",
    headCommit(wt) === git(wt, "rev-parse", "HEAD").stdout.trim(),
    "a work stream is a worktree, so this is not an edge case here");
}

// --- silence is the common case ---------------------------------------------
{
  const r = repo("quiet");
  graphAt(r, git(r, "rev-parse", "HEAD").stdout.trim());

  check("a graph built at HEAD is current", graphIsCurrent(r) === true);
  check("and nothing is said about it",
    describe({ code: codeChanged(r) }).length === 0,
    "a notice printed every session stops being read");

  const t = Date.now();
  codeChanged(r);
  const ms = Date.now() - t;
  check("answering costs no walk of history", ms < 250, `${ms}ms`);
}

// --- a graph that has fallen behind names what it has not seen ---------------
{
  const r = repo("behind");
  graphAt(r, git(r, "rev-parse", "HEAD").stdout.trim());
  commit(r, "b.js", "later work");
  commit(r, "c.js", "more");

  check("a moved repository is not current", graphIsCurrent(r) === false);
  check("and it knows how far without listing anything", commitsBehind(r) === 2);

  const [found] = codeChanged(r);
  check("the files it has not seen are named",
    found?.files.includes("src/b.js") && found?.files.includes("src/c.js"),
    (found?.files ?? []).join(", "));

  const said = describe({ code: codeChanged(r) }).join(" ");
  check("and the advice is to read them directly",
    /read those directly/i.test(said), said.slice(0, 120));
}

// --- too far behind to work around file by file ------------------------------
// "Read these four hundred files directly" is not advice anybody can act on,
// and arriving at it should not cost a walk of every tree in between.
{
  const r = repo("far");
  graphAt(r, git(r, "rev-parse", "HEAD").stdout.trim());
  for (let i = 0; i < 45; i++) commit(r, `f${i}.js`, `change ${i}`);

  const [found] = codeChanged(r);
  check("a long way behind, files are not enumerated",
    found && found.total === 0 && found.commits === 45, JSON.stringify(found));

  const said = describe({ code: codeChanged(r) }).join(" ");
  check("and the advice becomes rebuild", /rebuild/i.test(said), said.slice(0, 120));
}

// --- no graph is not the same as a stale one --------------------------------
{
  const r = repo("ungraphed");
  commit(r, "b.js", "work");
  check("a repository with no graph says nothing",
    describe({ code: codeChanged(r) }).length === 0,
    "a graph that does not exist cannot be out of date");
}

// --- memory ------------------------------------------------------------------
{
  const said = describe({
    memory: { checked: 10, total: 2, stale: [{ id: 4 }, { id: 9 }] },
  }).join(" ");
  check("facts naming vanished paths are reported as suspect",
    /2 stored fact/.test(said) && /L1:4/.test(said), said.slice(0, 120));

  check("and a clean memory is silent",
    describe({ memory: { checked: 10, total: 0, stale: [] } }).length === 0);
}

console.log(`\n${failed ? `${failed} check(s) failed` : "all checks passed"}`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exitCode = failed ? 1 : 0;
