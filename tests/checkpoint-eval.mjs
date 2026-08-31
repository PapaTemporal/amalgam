#!/usr/bin/env node
/**
 * What a fresh session would start with.
 *
 * Every other measurement here is about what a call ADDS to a conversation.
 * This one is about the only thing that ever subtracts, which is ending the
 * conversation — and the question nobody could answer before deciding to:
 * what does the next session actually get, and is it still true?
 *
 * The trap is that the answer looks fine when it is worthless. A restore point
 * costs a few hundred tokens whether it describes the project as it is or as
 * it was six days and fifty-seven commits ago, and the cheap one is the one
 * that makes starting over a net loss. So staleness is not a footnote in this
 * report, it is the finding; the tests below are mostly about it surviving.
 *
 * Usage: node tests/checkpoint-eval.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "amalgam-checkpoint-"));
process.env.AMALGAM_HOME = path.join(TMP, "home");
process.env.AMALGAM_DB = path.join(TMP, "memory.db");
fs.mkdirSync(process.env.AMALGAM_HOME, { recursive: true });

const { restorePoint, renderRestorePoint } = await import("../lib/checkpoint.mjs");
const { open } = await import("../lib/db.mjs");

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`); }
};

const git = (repo, ...args) =>
  spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true });

/** A repository whose name deliberately differs from its project's name. */
function repoNamed(dirName) {
  const repo = path.join(TMP, dirName);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  return repo;
}
function commit(repo, msg) {
  fs.writeFileSync(path.join(repo, "f.txt"), String(Math.random()));
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", msg);
}

console.log("\nWhat a fresh session would start with\n");

// --------------------------------------------------------------- empty state
{
  const repo = repoNamed("amalgam-pkg");
  commit(repo, "first");
  const r = await restorePoint(repo);
  ok("an empty database costs nothing", r.tokens === 0, `got ${r.tokens}`);
  ok("and claims no project state", r.scenarios.length === 0);
  ok("and has nothing stale to warn about", r.stalest === null);
  const text = renderRestorePoint(r);
  ok("which the report says out loud", text.includes("nothing has been written"));
}

// ------------------------------------------------- the name/directory divide
{
  const db = open();
  db.prepare(`INSERT INTO l2_scenarios (path, content, summary, version, updated_at)
              VALUES (?, ?, ?, 1, ?)`)
    .run("amalgam/stack", "x".repeat(1200), "s", "2020-01-01T00:00:00Z");
  db.prepare(`INSERT INTO l2_scenarios (path, content, summary, version, updated_at)
              VALUES (?, ?, ?, 1, ?)`)
    .run("catalog-api/state", "y".repeat(4000), "s", "2020-01-01T00:00:00Z");

  const repo = repoNamed("amalgam-pkg-2");
  commit(repo, "first");
  const r = await restorePoint(repo);

  // The bug this exists to prevent: the scenario is filed under the PROJECT's
  // name, the check runs in its DIRECTORY, and a clone called amalgam-pkg is
  // not string-equal to amalgam. Strict matching reported "nothing has been
  // written for this project" about a project with a scenario in the table.
  ok("a scenario is found when the directory is a longer name",
     r.scenarios.some((s) => s.path === "amalgam/stack"),
     `found ${JSON.stringify(r.scenarios.map((s) => s.path))}`);
  ok("another project's scenario is not charged to this one",
     !r.scenarios.some((s) => s.path.startsWith("catalog-api")));
  ok("so the cost is this project's alone", r.tokens > 200 && r.tokens < 500,
     `got ${r.tokens}`);
  ok("and the rest are counted, not listed", r.others === 1, `others=${r.others}`);
}

// ---------------------------------------------------------- staleness is the point
{
  const repo = repoNamed("amalgam");
  commit(repo, "first");
  for (let i = 0; i < 5; i++) commit(repo, `later ${i}`);

  const r = await restorePoint(repo);
  const mine = r.scenarios.find((s) => s.path === "amalgam/stack");
  ok("commits landed since the scenario are counted", (mine?.behind ?? 0) >= 5,
     `behind=${mine?.behind}`);
  ok("the worst one is singled out", r.stalest?.path === "amalgam/stack");

  const text = renderRestorePoint(r);
  ok("and the report leads with it, not the price",
     text.includes("commit(s) behind") && text.includes("costs more than it saves"));
}

// ------------------------------------------- a current restore point is quiet
{
  const db = open();
  db.prepare(`UPDATE l2_scenarios SET updated_at = ? WHERE path = ?`)
    .run(new Date(Date.now() + 60_000).toISOString(), "amalgam/stack");

  const repo = path.join(TMP, "amalgam");
  const r = await restorePoint(repo);
  ok("nothing behind means no warning", (r.stalest?.behind ?? 0) === 0,
     `behind=${r.stalest?.behind}`);
  const text = renderRestorePoint(r);
  ok("the report says so plainly", text.includes("current with the code"));
  ok("and never suggests starting over is a loss",
     !text.includes("costs more than it saves"));
}

// --------------------------------------------- it cannot see the conversation
{
  const repo = path.join(TMP, "amalgam");
  const text = renderRestorePoint(await restorePoint(repo));
  // The honest half. Nothing in this process can read a transcript, and a
  // report that let someone believe otherwise would be worse than no report.
  ok("the limit is stated, not implied",
     text.includes("does not measure your conversation"));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
// Windows will not unlink an open SQLite file or a git pack still mapped by the
// process, and a temp directory the OS reclaims later is not a failing test.
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);
