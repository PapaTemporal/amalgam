/**
 * How far behind the code an index has fallen.
 *
 * The graph is a claim about a repository at a moment. The code moves; the
 * claim does not. Nothing here corrects for that — the correction is the
 * design rule everything else follows, that the graph decides *which* lines
 * matter and the working tree supplies *what they say*, so a symbol that moved
 * is still found and one that was deleted is reported missing rather than
 * quoted. That makes staleness cost precision instead of correctness: a stale
 * graph misses things that are new, it does not invent things that are gone.
 *
 * What it cannot do is find a symbol that did not exist when the graph was
 * built. So the number of code commits since matters, and it was being
 * computed only for a command nobody runs on a schedule. It belongs where
 * people look.
 *
 * Commits touching only prose are excluded: counting them would nag for a
 * rebuild that changes nothing, and a warning that is usually noise is a
 * warning nobody reads.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const GRAPH_REL = path.join("graphify-out", "graph.json");

const git = (repo, args) => {
  const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim() };
};

/**
 * null when there is no graph; otherwise how many code commits have landed
 * since it was built, and whether that is worth saying out loud.
 */
export function graphStaleness(repo) {
  const file = path.join(repo, GRAPH_REL);
  if (!fs.existsSync(file)) return null;

  let builtAt;
  try { builtAt = fs.statSync(file).mtime; } catch { return null; }

  // Without git there is no way to count what changed, which is different
  // from knowing nothing changed.
  if (!git(repo, ["rev-parse", "--git-dir"]).ok) {
    return { builtAt: builtAt.toISOString(), commits: 0, unknown: true, stale: false };
  }

  const out = git(repo, [
    "log", "--since", builtAt.toISOString(), "--oneline", "--",
    ".", ":(exclude)*.md", ":(exclude)*.txt", ":(exclude).gitignore",
    ":(exclude)docs/**", ":(exclude)LICENSE*",
  ]).out;
  const commits = out ? out.split("\n").filter(Boolean).length : 0;
  return { builtAt: builtAt.toISOString(), commits, unknown: false, stale: commits > 0 };
}

/**
 * The same question for a project, which is a workspace of repositories.
 *
 * Reported per service and rolled up, because "the project is stale" is not
 * actionable — rebuilding is done per repository and only some of them will
 * have moved.
 */
export function projectStaleness(root, services) {
  const per = services
    .map((s) => ({ service: s.name, ...(graphStaleness(s.path) ?? {}) }))
    .filter((s) => s.builtAt);
  const behind = per.filter((s) => s.stale);
  return {
    services: per,
    stale: behind.length > 0,
    commits: behind.reduce((n, s) => n + s.commits, 0),
    behind: behind.map((s) => s.service),
  };
}
