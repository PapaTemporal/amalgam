/**
 * What changed while nobody was looking.
 *
 * A session ends by writing down what it learned and, if a graph has fallen
 * behind, rebuilding it. That covers everything the session itself did. It
 * covers nothing that happens BETWEEN sessions — a pull, a branch switch, work
 * done on another machine, an editor open in another window — and those land
 * on exactly the state an agent trusts most: an index that answers confidently
 * and a memory that states facts flatly.
 *
 * So a session opens by reconciling rather than assuming. Two questions, both
 * asked of reality rather than of a cache:
 *
 *   the code    is each graph still at the commit it was built from?
 *   the memory  do the paths its facts name still exist?
 *
 * It reports; it does not repair. Rebuilding at session start would either
 * make somebody wait for their first prompt or change the index underneath a
 * session already using it, and neither is worth it when saying "the graph has
 * not seen these four files, read them directly" costs nothing and degrades
 * precisely: the graph selects which lines, the working tree supplies what
 * they say. Repair belongs at the end, where nobody is waiting — see
 * lib/refresh.mjs.
 *
 * Everything here is bounded by what it costs to be wrong about it. The
 * common case is that nothing changed, and the common case is answered by
 * comparing two commit ids — no git process, no walk of history. Only a
 * repository that has actually moved pays for the list of files, because only
 * then is there anything to say.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { graphIsCurrent, commitsBehind, staleFiles } from "./freshness.mjs";
import { isWorkspace, services as servicesOf } from "./workspace.mjs";

const HOME = process.env.AMALGAM_HOME ?? path.join(os.homedir(), ".amalgam");

/**
 * The registered project this directory belongs to, if any.
 *
 * Read straight from the file rather than through the UI's registry module:
 * this runs before every session's first prompt, and the whole point is to
 * pull in as little as possible.
 */
function projectFor(dir) {
  let projects = [];
  try {
    projects = JSON.parse(fs.readFileSync(path.join(HOME, "ui.json"), "utf8")).projects ?? [];
  } catch { /* nothing registered yet */ }

  const here = path.resolve(dir);
  let best = null;
  for (const p of projects) {
    if (typeof p !== "string") continue;
    const root = path.resolve(p);
    const rel = path.relative(root, here);
    const inside = rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
    // The most specific registration wins: a repository registered in its own
    // right as well as inside a workspace should be reported once, as itself.
    if (inside && (!best || root.length > best.length)) best = root;
  }
  return best;
}

/** The repositories a session in this directory is actually working on. */
function reposFor(dir) {
  const root = projectFor(dir) ?? path.resolve(dir);
  // A session opened inside one service of a workspace is working on that
  // service, and reporting its six siblings would be noise.
  const here = path.resolve(dir);
  if (isWorkspace(root)) {
    const all = servicesOf(root);
    const mine = all.find((s) => {
      const rel = path.relative(path.resolve(s.path), here);
      return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
    });
    return mine ? [mine] : all;
  }
  return [{ name: path.basename(root), path: root }];
}

/**
 * Which graphs have fallen behind, and which files they have not seen.
 *
 * `graphIsCurrent` is the cheap gate — two commit ids compared, no process
 * started. Only what fails it pays for the walk, and a repository with no
 * graph at all says nothing, because a graph that does not exist cannot be
 * out of date.
 */
/**
 * Past this, naming files stops being useful and starts being expensive.
 *
 * The advice a file list gives is "read these directly instead of trusting the
 * index". That works for a handful. At forty commits of drift the honest
 * advice is different — rebuild — and arriving at it should not cost a walk of
 * every tree in between.
 */
const NAMEABLE_COMMITS = 40;

export function codeChanged(cwd, { fileLimit = 5 } = {}) {
  const out = [];
  for (const repo of reposFor(cwd)) {
    if (graphIsCurrent(repo.path) === true) continue;

    const behind = commitsBehind(repo.path);
    if (behind === 0) continue;                    // committed nothing; see below
    if (behind !== null && behind > NAMEABLE_COMMITS) {
      out.push({ name: repo.name, commits: behind, files: [], total: 0 });
      continue;
    }

    // null means the graph predates recording its own build commit, so the
    // cheap answers are unavailable and the honest one has to be paid for.
    const stale = staleFiles(repo.path, { limit: fileLimit });
    if (!stale || !stale.total) continue;
    out.push({ name: repo.name, commits: behind, ...stale });
  }
  return out;
}

/**
 * Facts naming paths that no longer exist.
 *
 * Not "facts that are wrong" — nothing here can judge that. A vanished path
 * is simply the cheapest signal that a memory has drifted, and it is the kind
 * that gets stated with full confidence to a model that has no way to check.
 */
export async function memoryDrifted({ limit = 3 } = {}) {
  try {
    // Imported here rather than at the top: these pull in node:sqlite, and a
    // machine with no memory database yet must still be able to open a
    // session.
    const { open } = await import("./db.mjs");
    const { verifyFact } = await import("./verify.mjs");

    const db = open();
    const rows = db.prepare(
      `SELECT id, context, content FROM l1_facts WHERE superseded_by IS NULL`).all();

    const stale = [];
    for (const r of rows) {
      const v = verifyFact(r.content);
      if (v.state === "stale") stale.push({ id: r.id, context: r.context, note: v.note });
    }
    return { checked: rows.length, stale: stale.slice(0, limit), total: stale.length };
  } catch {
    return { checked: 0, stale: [], total: 0 };
  }
}

/**
 * The whole reconciliation as lines for a session's opening context.
 *
 * Empty when nothing changed, which is the usual answer and the one worth
 * being silent about: a reminder printed every session stops being read by
 * the third one.
 */
export function describe({ code = [], memory = null } = {}) {
  const lines = [];

  for (const repo of code) {
    if (!repo.total) {
      lines.push(
        `- ${repo.name}: the code graph is ${repo.commits} commit(s) behind — too far to work ` +
        `around file by file. Rebuild it (\`amalgam graph\`) before trusting what it says about ` +
        `where things are.`);
      continue;
    }
    const shown = repo.files.join(", ");
    const more = repo.truncated ? `, and ${repo.total - repo.files.length} more` : "";
    lines.push(
      `- ${repo.name}: the code graph has not seen ${repo.total} changed file(s) — ` +
      `${shown}${more}. Read those directly; the index is right about everything else.`);
  }

  if (memory?.total) {
    const first = memory.stale.map((s) => `L1:${s.id}`).join(", ");
    lines.push(
      `- ${memory.total} stored fact(s) name a path that no longer exists (${first}). ` +
      `Treat them as suspect and run \`amalgam memory verify\` to see which.`);
  }

  return lines;
}
