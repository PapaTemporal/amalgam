#!/usr/bin/env node
/**
 * Automatic refresh policy evaluation.
 *
 * Keeping a graph current is easy; keeping it current without eating the
 * machine is the part that needs deciding. Two real repositories set the
 * problem: one refreshes completely in seventeen seconds, and one takes four
 * and a half minutes with nothing changed at all, because its extractor
 * re-reads nine hundred files it never caches. A policy that treats those the
 * same is either pointless or hostile.
 *
 * So what is tested here is the refusing, not the refreshing. Every gate has a
 * failure that costs somebody something real: no budget and a session ends by
 * starting a four-minute build; no cooldown and three sessions in an hour mean
 * three of them; no measurement and the decision is a guess about size, which
 * is exactly the wrong predictor.
 *
 * Usage: node tests/refresh-eval.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Isolated before anything reads it: the policy keeps its record beside the
// rest of amalgam's state, and a test must not touch the real one.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "amalgam-refresh-"));
process.env.AMALGAM_HOME = path.join(TMP, "home");
process.env.AMALGAM_DB = path.join(TMP, "memory.db");
fs.mkdirSync(process.env.AMALGAM_HOME, { recursive: true });

const { shouldRefresh, recordBuild, buildRecord, autoRefreshEnabled,
        BUDGET_MS, COOLDOWN_MS } = await import("../lib/refresh.mjs");

let failed = 0;
const check = (name, pass, detail) => {
  if (!pass) failed++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
  if (detail) console.log(`      ${detail}`);
};

console.log("refresh policy eval  (real repositories, no builds)\n");

const git = (repo, ...args) =>
  spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true });

function repo(name, { withGraph = true } = {}) {
  const dir = path.join(TMP, name);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  fs.writeFileSync(path.join(dir, "src", "a.js"), "export const a = 1;\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "first");
  const head = git(dir, "rev-parse", "HEAD").stdout.trim();
  if (withGraph) {
    fs.mkdirSync(path.join(dir, "graphify-out"), { recursive: true });
    fs.writeFileSync(path.join(dir, "graphify-out", "graph.json"),
      JSON.stringify({ nodes: [], links: [], built_at_commit: head }));
  }
  return dir;
}

const change = (dir, n) => {
  fs.writeFileSync(path.join(dir, "src", `b${n}.js`), `export const b${n} = ${n};\n`);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", `change ${n}`);
};

// --- nothing to do is the common case ---------------------------------------
const quiet = repo("quiet");
recordBuild(quiet, 5_000);
check("a current graph is left alone",
  shouldRefresh(quiet).refresh === false,
  shouldRefresh(quiet).reason);

const bare = path.join(TMP, "bare");
fs.mkdirSync(bare, { recursive: true });
check("a folder with no graph is not a refresh candidate",
  shouldRefresh(bare).refresh === false,
  shouldRefresh(bare).reason);

// --- the measurement gate ----------------------------------------------------
// Size is a poor predictor of build cost — what costs time is how much of a
// tree the extractor refuses to cache — so a repository amalgam has never
// timed is never started behind somebody's back.
const untimed = repo("untimed");
change(untimed, 1);
const u = shouldRefresh(untimed);
check("a repository never built here is not refreshed on a guess",
  u.refresh === false && /never built/i.test(u.reason),
  u.reason);

check("but it is reported as behind, so it is not simply ignored",
  u.commits === 1, `${u.commits} commit(s)`);

// --- the budget gate ---------------------------------------------------------
const slow = repo("slow");
change(slow, 1);
recordBuild(slow, BUDGET_MS + 60_000);
const s = shouldRefresh(slow);
check("a repository that took too long last time is refused",
  s.refresh === false && s.overBudget === true,
  s.reason);

const quick = repo("quick");
change(quick, 1);
recordBuild(quick, 4_000);
// Backdate the record past the cooldown: the point here is the budget.
const past = Date.now() - COOLDOWN_MS - 1000;
const store = path.join(process.env.AMALGAM_HOME, "refresh.json");
const data = JSON.parse(fs.readFileSync(store, "utf8"));
data[path.resolve(quick)].at = past;
fs.writeFileSync(store, JSON.stringify(data));

const q = shouldRefresh(quick);
check("a cheap repository that has fallen behind is refreshed",
  q.refresh === true, q.reason);

// --- the cooldown gate -------------------------------------------------------
recordBuild(quick, 4_000);   // as if it had just been built
const cooled = shouldRefresh(quick);
check("and not again straight away",
  cooled.refresh === false && /recently/i.test(cooled.reason),
  "three sessions in an hour must not mean three rebuilds");

check("the cooldown is time, not a flag",
  shouldRefresh(quick, { now: Date.now() + COOLDOWN_MS + 1000 }).refresh === true,
  "once it has passed, the same repository is due again");

// --- what is remembered ------------------------------------------------------
check("a build's cost is recorded where the policy can read it",
  buildRecord(quick)?.ms === 4_000,
  `${buildRecord(quick)?.ms}ms`);

check("and a repository never built here has no record",
  buildRecord(path.join(TMP, "never")) === null);

// --- the off switch ----------------------------------------------------------
check("refresh is on unless it is turned off", autoRefreshEnabled() === true);
process.env.AMALGAM_AUTO_REFRESH = "off";
check("and off means off", autoRefreshEnabled() === false,
  "a machine should be able to do nothing unbidden");
delete process.env.AMALGAM_AUTO_REFRESH;

console.log(`\n${failed ? `${failed} check(s) failed` : "all checks passed"}`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exitCode = failed ? 1 : 0;
