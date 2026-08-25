/**
 * Keeping a graph current without anybody asking it to.
 *
 * The moment is chosen rather than scheduled: when a session ends, the machine
 * is idle, nobody is waiting, and the session that benefits is the next one.
 * There is no daemon, no watcher and no git hook — amalgam already owns the
 * session-end hook and already spawns detached work there, so this is the same
 * pattern rather than new machinery.
 *
 * The policy exists because rebuilding is not cheap and is not equally cheap.
 * Measured on two real repositories: a small one refreshes completely in
 * seventeen seconds, and a large one takes four and a half minutes *with
 * nothing changed at all*, because its extractor re-reads nine hundred files
 * it never caches. Treating those two the same would either make the small
 * case pointless or make the large case eat the machine. So:
 *
 *   - Only what accuracy depends on. Extraction and indexing, never clustering
 *     or drawing. The diagram is cosmetic and its cost is most of the bill.
 *   - Only within a budget, learned from how long that repository actually
 *     took last time rather than guessed from its size.
 *   - Only once in a while, so finishing three sessions in an hour does not
 *     mean three rebuilds.
 *   - Only where it would change something.
 *
 * A repository over budget is not abandoned: it keeps the cheaper half of the
 * answer, which is knowing exactly which files the graph has not seen.
 */
import fs from "node:fs";
import path from "node:path";

import { HOME } from "./services.mjs";
import { readRegistry } from "./uiserver.mjs";
import { isWorkspace, services as servicesOf } from "./workspace.mjs";
import { graphStaleness } from "./freshness.mjs";

const RECORD = path.join(HOME, "refresh.json");

/** Longer than this and it is not something to start behind somebody's back. */
export const BUDGET_MS = Number(process.env.AMALGAM_REFRESH_BUDGET_MS ?? 90_000);

/** Nor more often than this, however many sessions end. */
export const COOLDOWN_MS = Number(process.env.AMALGAM_REFRESH_COOLDOWN_MS ?? 30 * 60_000);

/** Off entirely, for anyone who wants their machine to do nothing unbidden. */
export const autoRefreshEnabled = () =>
  (process.env.AMALGAM_AUTO_REFRESH ?? "on").toLowerCase() !== "off";

const load = () => {
  try { return JSON.parse(fs.readFileSync(RECORD, "utf8")); } catch { return {}; }
};

const save = (data) => {
  try {
    fs.mkdirSync(HOME, { recursive: true });
    fs.writeFileSync(RECORD, JSON.stringify(data, null, 2));
  } catch { /* the policy degrades to "never", which is safe */ }
};

/**
 * Remember how long a build took.
 *
 * The budget is learned rather than guessed: size is a poor predictor, because
 * what costs time is how much of the tree an extractor refuses to cache, and
 * only running it reveals that.
 */
export function recordBuild(repo, ms) {
  const data = load();
  data[path.resolve(repo)] = { ms, at: Date.now() };
  save(data);
}

/** What is known about a repository's last build here. */
export const buildRecord = (repo) => load()[path.resolve(repo)] ?? null;

/**
 * Whether to refresh this repository now, and why not when not.
 *
 * The reason is returned rather than swallowed so the decision can be shown to
 * somebody wondering why their graph is still behind.
 */
export function shouldRefresh(repo, { now = Date.now() } = {}) {
  const root = path.resolve(repo);
  const stale = graphStaleness(root);
  if (!stale) return { refresh: false, reason: "no graph here yet" };
  if (!stale.stale) return { refresh: false, reason: "already current" };

  const record = buildRecord(root);
  if (!record) {
    // Never built through amalgam, so there is no measurement to trust and no
    // way to know whether this is seventeen seconds or four minutes. Building
    // once by hand teaches it.
    return { refresh: false, reason: "never built here, so its cost is unknown", commits: stale.commits };
  }
  if (record.ms > BUDGET_MS) {
    return {
      refresh: false,
      reason: `last build took ${Math.round(record.ms / 1000)}s, over the ${Math.round(BUDGET_MS / 1000)}s budget`,
      commits: stale.commits,
      overBudget: true,
    };
  }
  if (now - record.at < COOLDOWN_MS) {
    return { refresh: false, reason: "refreshed recently", commits: stale.commits };
  }
  return { refresh: true, reason: `${stale.commits} code commit(s) since it was built`, commits: stale.commits };
}

/**
 * Every repository worth refreshing right now, across every registered
 * project. Services rather than projects, because a graph belongs to a
 * repository.
 */
export function dueForRefresh() {
  if (!autoRefreshEnabled()) return [];
  const out = [];
  for (const proj of readRegistry().projects) {
    const root = path.resolve(String(proj ?? ""));
    if (!root || !fs.existsSync(root)) continue;
    const parts = isWorkspace(root)
      ? servicesOf(root)
      : [{ name: path.basename(root), path: root }];
    for (const part of parts) {
      const verdict = shouldRefresh(part.path);
      if (verdict.refresh) out.push({ name: part.name, path: part.path, ...verdict });
    }
  }
  return out;
}

/** The same question answered for everything, for showing rather than doing. */
export function refreshPlan() {
  const out = [];
  for (const proj of readRegistry().projects) {
    const root = path.resolve(String(proj ?? ""));
    if (!root || !fs.existsSync(root)) continue;
    const parts = isWorkspace(root)
      ? servicesOf(root)
      : [{ name: path.basename(root), path: root }];
    for (const part of parts) {
      const record = buildRecord(part.path);
      out.push({
        name: part.name,
        path: part.path,
        lastBuildMs: record?.ms ?? null,
        ...shouldRefresh(part.path),
      });
    }
  }
  return out;
}
