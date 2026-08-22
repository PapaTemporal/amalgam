#!/usr/bin/env node
/**
 * Reclamation evaluation — the destructive path.
 *
 * Everything else in this project costs tokens when it is wrong. This costs
 * work: it removes worktrees, deletes branches and empties build directories.
 * It is therefore the one part that gets tested against real git repositories
 * rather than fixtures, and the assertions are mostly about what must NOT
 * happen — uncommitted work surviving, unmerged branches surviving, pinned
 * worktrees surviving.
 *
 * Each case builds a genuine repo with a genuine worktree in a temp directory,
 * runs the real plan, and then runs the real apply. Nothing is mocked, because
 * the failure this is guarding against is precisely a disagreement between
 * what the rules say and what git does.
 *
 * Usage: node tests/stream-eval.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "amalgam-streams-"));
process.env.AMALGAM_STREAMS = path.join(TMP, "streams.json");

const { git, plan, apply, inspectStream, classify, streamKey, writeStreams } =
  await import("../lib/streams.mjs");

let failed = 0;
const check = (name, pass, detail) => {
  if (!pass) failed++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
  if (detail) console.log(`      ${detail}`);
};

/** A repo with one commit on main, and a worktree on its own branch. */
function makeStream(name, { branch = `fix/${name}`, base = "main" } = {}) {
  const repo = path.join(TMP, name);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q", "-b", base]);
  git(repo, ["config", "user.email", "eval@local"]);
  git(repo, ["config", "user.name", "eval"]);
  fs.writeFileSync(path.join(repo, "app.js"), "export const version = 1;\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "base"]);

  const wt = path.join(TMP, `${name}-wt`);
  git(repo, ["worktree", "add", "-q", "-b", branch, wt]);
  return { name, repo, path: wt, branch, base };
}

const commitIn = (dir, file, text, msg) => {
  fs.writeFileSync(path.join(dir, file), text);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", msg]);
};

const register = (recs) => {
  const db = { streams: {} };
  for (const r of recs) db.streams[streamKey(r.repo, r.name)] = r;
  writeStreams(db);
  return db;
};

const buildOutput = (wt, bytes = 2048) => {
  fs.mkdirSync(path.join(wt, "build", "obj"), { recursive: true });
  fs.writeFileSync(path.join(wt, "build", "obj", "app.o"), "x".repeat(bytes));
};

console.log("stream reclamation eval  (real repos in a temp dir)\n");

// --- 1. uncommitted work is never removed, at any age ----------------------
{
  const s = makeStream("dirty");
  commitIn(s.path, "app.js", "export const version = 2;\n", "work");
  fs.writeFileSync(path.join(s.path, "app.js"), "half-finished edit\n");   // uncommitted
  const db = register([{ ...s, evaluated: true }]);                        // even marked done
  const [item] = plan(db, { maxAgeDays: 0 });                              // even past the age limit
  check("uncommitted work is kept even when marked done and stale",
    item.action === "keep" && /uncommitted/.test(item.why), `${item.action} — ${item.why}`);

  apply(db, plan(db, { maxAgeDays: 0 }));
  check("and the worktree really is still there", fs.existsSync(path.join(s.path, "app.js")));
}

// --- 2. build output is not "work" -----------------------------------------
{
  const s = makeStream("built");
  commitIn(s.path, "app.js", "export const version = 3;\n", "work");
  buildOutput(s.path);
  const st = inspectStream({ ...s });
  check("untracked build output does not count as dirty",
    st.dirty === false && st.builds.length === 1 && st.buildBytes > 0,
    `dirty=${st.dirty}, ${st.builds.length} build dir, ${st.buildBytes} bytes`);

  fs.writeFileSync(path.join(s.path, "notes.txt"), "an untracked file that is not build output\n");
  check("an untracked file outside a build dir does count",
    inspectStream({ ...s }).dirty === true);
}

// --- 3. merged: worktree and branch both go --------------------------------
{
  const s = makeStream("merged");
  commitIn(s.path, "app.js", "export const version = 4;\n", "work");
  git(s.repo, ["merge", "-q", "--no-ff", "-m", "merge", s.branch]);
  buildOutput(s.path);

  const db = register([s]);
  const [item] = plan(db);
  check("a merged stream is planned for removal",
    item.action === "remove" && /merged into main/.test(item.why), `${item.action} — ${item.why}`);

  const events = [];
  apply(db, plan(db), { onEvent: (e) => events.push(e) });
  check("its worktree is gone", !fs.existsSync(s.path));
  check("its branch is deleted, since the commits are safe on main",
    !git(s.repo, ["rev-parse", "--verify", s.branch]).ok && events[0]?.branch === "deleted",
    `branch ${events[0]?.branch}`);
  check("and it leaves the registry", Object.keys(db.streams).length === 0);
}

// --- 4. done but unmerged: worktree goes, COMMITS DO NOT --------------------
{
  const s = makeStream("done");
  commitIn(s.path, "app.js", "export const version = 5;\n", "unmerged work");
  const sha = git(s.path, ["rev-parse", "HEAD"]).out;

  const db = register([{ ...s, evaluated: true, evaluatedAt: new Date().toISOString() }]);
  const [item] = plan(db);
  check("a stream marked done is planned for removal",
    item.action === "remove" && /marked done/.test(item.why), `${item.action} — ${item.why}`);

  const events = [];
  apply(db, plan(db), { onEvent: (e) => events.push(e) });
  check("its worktree is gone", !fs.existsSync(s.path));
  check("but the branch survives, because the work never landed",
    git(s.repo, ["rev-parse", "--verify", s.branch]).ok && events[0]?.branch === "kept",
    `branch ${events[0]?.branch}`);
  check("and the commit is still reachable",
    git(s.repo, ["cat-file", "-e", sha]).ok, sha.slice(0, 8));
}

// --- 5. pinned survives everything -----------------------------------------
{
  const s = makeStream("pinned");
  commitIn(s.path, "app.js", "export const version = 6;\n", "work");
  git(s.repo, ["merge", "-q", "--no-ff", "-m", "merge", s.branch]);   // merged AND
  buildOutput(s.path);
  const db = register([{ ...s, pinned: true, evaluated: true }]);      // marked done
  const [item] = plan(db, { maxAgeDays: 0 });                          // AND stale
  check("a pinned stream is kept whatever else is true of it",
    item.action === "keep" && /pinned/.test(item.why), `${item.action} — ${item.why}`);
  apply(db, plan(db, { maxAgeDays: 0 }));
  check("its warm build directory is untouched",
    fs.existsSync(path.join(s.path, "build", "obj", "app.o")));
}

// --- 6. stale: reclaim the disk, keep the code -----------------------------
{
  const s = makeStream("stale");
  commitIn(s.path, "app.js", "export const version = 7;\n", "work");
  buildOutput(s.path, 4096);
  const db = register([s]);
  const [item] = plan(db, { maxAgeDays: 0 });   // every stream is "stale" at 0 days
  check("a stale stream frees build output only",
    item.action === "builds" && /unmerged commit/.test(item.why), `${item.action} — ${item.why}`);

  apply(db, plan(db, { maxAgeDays: 0 }));
  check("the build directory is gone", !fs.existsSync(path.join(s.path, "build")));
  check("the worktree and its commits are not",
    fs.existsSync(path.join(s.path, "app.js")) && git(s.repo, ["rev-parse", "--verify", s.branch]).ok);
  check("and it stays registered for next time", Object.keys(db.streams).length === 1);
}

// --- 7. a plan on its own changes nothing ----------------------------------
{
  const s = makeStream("dryrun");
  commitIn(s.path, "app.js", "export const version = 8;\n", "work");
  git(s.repo, ["merge", "-q", "--no-ff", "-m", "merge", s.branch]);
  buildOutput(s.path);
  const db = register([s]);
  const planned = plan(db);
  check("planning alone removes nothing",
    planned[0].action === "remove" && fs.existsSync(s.path)
    && git(s.repo, ["rev-parse", "--verify", s.branch]).ok,
    "the dry run is simply the plan, unapplied");
}

// --- 8. a vanished worktree is forgotten, not mourned ----------------------
{
  const s = makeStream("vanished");
  fs.rmSync(s.path, { recursive: true, force: true });
  const db = register([s]);
  const [item] = plan(db);
  check("a missing directory is planned as forget",
    item.action === "forget" && /gone/.test(item.why), `${item.action} — ${item.why}`);
  apply(db, plan(db));
  check("and the registration is dropped", Object.keys(db.streams).length === 0);
}

// --- 9. --builds-only never removes a worktree -----------------------------
{
  const s = makeStream("buildsonly");
  commitIn(s.path, "app.js", "export const version = 9;\n", "work");
  git(s.repo, ["merge", "-q", "--no-ff", "-m", "merge", s.branch]);
  buildOutput(s.path);
  const db = register([s]);
  const [item] = plan(db, { buildsOnly: true });
  check("--builds-only downgrades a removal to freeing disk", item.action === "builds",
    `${item.action} — ${item.why}`);
  apply(db, plan(db, { buildsOnly: true }));
  check("the merged worktree is still there", fs.existsSync(path.join(s.path, "app.js")));
  check("but its build output is not", !fs.existsSync(path.join(s.path, "build")));
}

console.log(`\n${failed ? `${failed} check(s) failed` : "all checks passed"}`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exitCode = failed ? 1 : 0;
