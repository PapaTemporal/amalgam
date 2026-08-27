/**
 * Work streams: git worktrees, and the judgement about when to reclaim them.
 *
 * This is the only code in the project that destroys anything a person made —
 * worktrees, branches, build directories. It lived inside the CLI, tangled
 * with its own console output, which meant the one thing here that most needed
 * testing was the one thing that could not be tested. It is a module now for
 * exactly that reason.
 *
 * The split is deliberate: `plan()` decides and touches nothing, `apply()`
 * carries out a plan it was handed. So the decision can be examined, asserted
 * against, and printed for a human to approve before anything is removed, and
 * a dry run is not a special mode but simply the plan on its own.
 *
 * The rules, in the order they are applied:
 *
 *   gone       the directory is not there    -> forget the registration
 *   dirty      uncommitted work              -> never touched, at any age
 *   pinned     deliberately persistent       -> never touched
 *   merged     landed on the base branch     -> worktree AND branch removed
 *   done       marked evaluated by the user  -> worktree removed, BRANCH KEPT
 *   stale      no commits for N days         -> build output freed, code kept
 *   otherwise  active                        -> left alone
 *
 * The order matters more than any single rule: dirty and pinned are checked
 * before anything that removes, so no later rule can reach a stream holding
 * work. And "done but unmerged" keeps its branch, because marking a stream
 * finished says the worktree is no longer needed, not that the commits are
 * expendable.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

export const HOME = process.env.AMALGAM_HOME ?? path.join(os.homedir(), ".amalgam");
export const STREAMS_DB = process.env.AMALGAM_STREAMS ?? path.join(HOME, "streams.json");

// Build output dirs to reclaim. Matched at the worktree root only.
export const BUILD_DIR_RE = /^(build|build[-.].*|.*\.build|cmake-build-.*|out|target|node_modules)$/i;

export function git(repo, args, opts = {}) {
  const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true, ...opts });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

export function readStreams() {
  try { return JSON.parse(fs.readFileSync(STREAMS_DB, "utf8")); } catch { return { streams: {} }; }
}

export function writeStreams(db) {
  fs.mkdirSync(path.dirname(STREAMS_DB), { recursive: true });
  fs.writeFileSync(STREAMS_DB, JSON.stringify(db, null, 2) + "\n");
}

export const streamKey = (repo, name) => `${path.basename(repo)}::${name}`;

/** A worktree name that is safe as a branch, a directory and a memory tag. */
export const validStreamName = (name) => /^[\w.-]+$/.test(String(name ?? "")) && !String(name).startsWith(".");

/**
 * Start a stream: a worktree, a branch, and a registration.
 *
 * Extracted from the CLI so the interface creates them the same way rather
 * than a second way. Errors come back as values — this is called from a
 * request handler as well as a terminal, and only one of those can afford to
 * exit the process.
 */
export function createStream({ repo, name, base = "main", purpose = "", pin = false }) {
  repo = path.resolve(repo);
  if (!git(repo, ["rev-parse", "--git-dir"]).ok) return { error: `not a git repository: ${repo}` };
  if (!validStreamName(name)) return { error: "a stream name may hold letters, numbers, dot, dash and underscore" };

  const db = readStreams();
  const key = streamKey(repo, name);
  if (db.streams[key]) return { error: `this repository already has a stream called '${name}'` };

  const branch = `stream/${name}`;
  // Beside the repository rather than inside it, so the worktree is never
  // something the repository's own tooling has to learn to ignore.
  const wt = path.resolve(repo, "..", `${path.basename(repo)}-${name}`);
  if (fs.existsSync(wt)) return { error: `path already exists: ${wt}` };

  const r = git(repo, ["worktree", "add", "-b", branch, wt, base]);
  if (!r.ok) return { error: r.err || "git worktree add failed" };

  const rec = {
    name, repo, path: wt, branch, base, purpose,
    // Where the branch started. Without it, a stream nobody has committed to
    // is indistinguishable from one whose work has all landed — both are
    // ancestors of the base branch — and they deserve different words.
    baseAt: git(repo, ["rev-parse", branch]).out || null,
    created: new Date().toISOString(),
    evaluated: false, evaluatedAt: null,
    pinned: !!pin,
  };
  db.streams[key] = rec;
  writeStreams(db);
  return { stream: rec };
}

export function dirSize(dir) {
  let total = 0;
  try {
    for (const e of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
      if (!e.isFile()) continue;
      try { total += fs.statSync(path.join(e.parentPath ?? e.path, e.name)).size; } catch {}
    }
  } catch {}
  return total;
}

export const human = (b) =>
  (b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b > 1e6 ? `${(b / 1e6).toFixed(0)} MB` : `${(b / 1e3).toFixed(0)} KB`);

export function buildDirs(worktree) {
  try {
    return fs.readdirSync(worktree, { withFileTypes: true })
      .filter((e) => e.isDirectory() && BUILD_DIR_RE.test(e.name))
      .map((e) => path.join(worktree, e.name));
  } catch { return []; }
}

/** Everything needed to judge whether a stream is still worth its disk. */
export function inspectStream(rec, { sizes = true } = {}) {
  const exists = fs.existsSync(rec.path);
  const st = { ...rec, exists, dirty: false, merged: false, untouched: false, ageDays: null, builds: [], buildBytes: 0, unmergedCommits: 0 };
  if (!exists) return st;
  // "Dirty" must mean work at risk, not build output. Untracked files inside
  // a build dir are expected in any compiled worktree; counting them would
  // make every built stream permanently unreclaimable.
  st.dirty = git(rec.path, ["status", "--porcelain"]).out
    .split("\n").filter(Boolean)
    .some((line) => {
      const p = line.slice(3).replace(/^"|"$/g, "");
      if (!line.startsWith("??")) return true;             // tracked change
      return !BUILD_DIR_RE.test(p.split("/")[0]);          // untracked non-build file
    });
  st.merged = git(rec.repo, ["merge-base", "--is-ancestor", rec.branch, rec.base]).ok;
  // Still sitting exactly where it was created: nothing has been committed to
  // it. Older registrations have no starting point recorded and simply do not
  // claim to know.
  st.untouched = !!rec.baseAt && git(rec.repo, ["rev-parse", rec.branch]).out === rec.baseAt;
  const last = git(rec.path, ["log", "-1", "--format=%ct"]).out;
  if (last) st.ageDays = Math.floor((Date.now() / 1000 - Number(last)) / 86400);
  const ahead = git(rec.repo, ["rev-list", "--count", `${rec.base}..${rec.branch}`]).out;
  st.unmergedCommits = Number(ahead || 0);
  st.builds = buildDirs(rec.path);
  if (sizes) st.buildBytes = st.builds.reduce((n, d) => n + dirSize(d), 0);
  return st;
}

export function classify(st, maxAgeDays) {
  if (!st.exists) return { action: "forget", why: "worktree directory is gone" };
  if (st.dirty) return { action: "keep", why: "uncommitted changes — never auto-removed" };
  // Pinned streams keep their (expensive) warm build dir across cycles —
  // e.g. a nightly worktree, where a cold rebuild costs far more than disk.
  if (st.pinned) return { action: "keep", why: "pinned (persistent worktree)" };
  if (st.merged && st.untouched) return { action: "remove", why: "nothing has been committed to it" };
  if (st.merged) return { action: "remove", why: `merged into ${st.base}` };
  if (st.evaluated) return { action: "remove", why: `marked done ${st.evaluatedAt?.slice(0, 10) ?? ""}`.trim() };
  if (st.ageDays !== null && st.ageDays >= maxAgeDays) {
    return st.buildBytes > 0
      ? { action: "builds", why: `no commits in ${st.ageDays}d, ${st.unmergedCommits} unmerged commit(s) kept` }
      : { action: "keep", why: `stale (${st.ageDays}d) but nothing to reclaim` };
  }
  return { action: "keep", why: "active" };
}

/**
 * Decide what to do with every registered stream, without touching anything.
 *
 * A plan is the whole decision: what would happen, to what, and why. Printing
 * it is what `amalgam stream gc` does without `--yes`, and asserting on it is
 * what the tests do — the same object either way, so what a person approves is
 * exactly what runs.
 */
export function plan(db, { maxAgeDays = 14, buildsOnly = false } = {}) {
  return Object.values(db.streams ?? {}).map((rec) => {
    const st = inspectStream(rec);
    let { action, why } = classify(st, maxAgeDays);
    // --builds-only downgrades removals to freeing build output, for when the
    // disk is the problem and the worktrees are not.
    if (buildsOnly && action === "remove") {
      action = st.buildBytes > 0 ? "builds" : "keep";
      if (action === "keep") why = "builds-only: nothing to reclaim";
    }
    return { key: streamKey(rec.repo, rec.name), state: st, action, why, bytes: st.buildBytes };
  });
}

/**
 * Carry out a plan.
 *
 * Every branch deletion here is `-d`, never `-D`, and only where git agrees
 * the work is merged; a stream that was merely marked done keeps its branch.
 * The one force in the whole function is `worktree remove --force`, and it is
 * reached only after the dirty check above has already refused anything with
 * real work in it — the files it forces past are build output this same plan
 * just deleted.
 */
export function apply(db, planned, { onEvent = () => {} } = {}) {
  let freed = 0, removed = 0, cleaned = 0, forgotten = 0;

  for (const item of planned) {
    const { state: st, action } = item;
    if (action === "keep") continue;

    if (action === "forget") {
      git(st.repo, ["worktree", "prune"]);
      delete db.streams[item.key];
      forgotten++;
      onEvent({ ...item, done: "forgotten" });
      continue;
    }

    if (action === "builds") {
      for (const dir of st.builds) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
      freed += st.buildBytes;
      cleaned++;
      onEvent({ ...item, done: "builds-freed" });
      continue;
    }

    // remove: worktree, and the branch only when git agrees it is merged.
    for (const dir of st.builds) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
    let r = git(st.repo, ["worktree", "remove", st.path]);
    if (!r.ok) r = git(st.repo, ["worktree", "remove", "--force", st.path]);
    if (!r.ok) {
      onEvent({ ...item, done: "failed", error: r.err.split("\n")[0] });
      continue;
    }
    let branch = "kept";
    if (st.merged) {
      // -d, never -D: if git disagrees that this is merged, the branch stays.
      branch = git(st.repo, ["branch", "-d", st.branch]).ok ? "deleted" : "kept (git refused)";
    }
    delete db.streams[item.key];
    freed += st.buildBytes;
    removed++;
    onEvent({ ...item, done: "removed", branch });
  }

  writeStreams(db);
  return { freed, removed, cleaned, forgotten };
}
