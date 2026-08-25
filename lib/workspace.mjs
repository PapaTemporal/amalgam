/**
 * A project is a workspace; the repositories inside it are services.
 *
 * That is the shape this whole stack assumes and it is easy to get backwards.
 * BMAD installs at the workspace level — `_bmad/`, `_bmad-output/`, the skills
 * — and its documents describe the system across services rather than one
 * repository at a time. Sessions run from there. So "the project" is the
 * folder holding the repositories, not any one of them.
 *
 * The code graph was the part that had not caught up. `amalgam graph` at a
 * workspace already builds one graph per service, correctly: mixing several
 * codebases into a single index produces something too muddled to answer
 * anything. But nothing then presented those graphs *as the workspace's*, so
 * asking a workspace what it knew about its own code got nothing back, and a
 * dashboard reported "no graph" for a project whose services were fully
 * indexed.
 *
 * This joins them. Each service keeps its own index — the extraction boundary
 * is right — and the workspace view merges them into one graph whose file
 * paths are relative to the workspace, so everything downstream (slicing a
 * symbol, mapping a diff, verifying an edge) works from the project level
 * without knowing services exist.
 */
import fs from "node:fs";
import path from "node:path";

import { isIndexed, graphFromDb, indexStatus, searchSymbols } from "./graphdb.mjs";
import { loadGraph, hasGraph } from "./graph.mjs";
import { projectStaleness } from "./freshness.mjs";

const SKIP = new Set(["node_modules", "dist", "build", "out", "target", "graphify-out", ".git"]);

/** The repositories inside a folder. */
export function services(dir) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !SKIP.has(e.name))
    .filter((e) => fs.existsSync(path.join(dir, e.name, ".git")))
    .map((e) => ({ name: e.name, path: path.join(dir, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * A workspace is a folder that holds repositories and is not one itself.
 *
 * One service is still a workspace: a project does not stop being a project
 * because it currently has a single repository in it, and treating it as one
 * on Monday and not on Tuesday would be worse than either answer.
 */
export function isWorkspace(dir) {
  return !fs.existsSync(path.join(dir, ".git")) && services(dir).length > 0;
}

/** What each service contributes, whether or not it has been indexed. */
export function serviceGraphs(dir) {
  return services(dir).map((s) => {
    const status = indexStatus(s.path);
    return {
      ...s,
      indexed: !!status,
      hasGraphFile: hasGraph(s.path),
      symbols: status?.symbols ?? 0,
      edges: status?.edges ?? 0,
      importedAt: status?.imported_at ?? null,
    };
  });
}

/**
 * One graph for the whole project.
 *
 * Ids are namespaced by service because two repositories will happily contain
 * the same symbol name, and file paths are rewritten to be workspace-relative
 * so a caller can slice source, verify an edge or map a diff without being
 * told which service anything came from. Everything else about the shape is
 * identical to a single-repository graph, which is what lets the rest of the
 * system stay ignorant of the distinction.
 */
export function workspaceGraph(dir) {
  const parts = services(dir)
    .map((s) => ({ service: s, graph: isIndexed(s.path) ? graphFromDb(s.path) : loadGraph(s.path) }))
    .filter((p) => p.graph?.nodes?.size);

  if (!parts.length) return null;

  const nodes = new Map();
  const callers = new Map();
  const callees = new Map();

  for (const { service, graph } of parts) {
    const rename = (id) => `${service.name}::${id}`;
    const relocate = (f) => (f ? `${service.name}/${String(f).split("\\").join("/")}` : "");

    for (const [id, n] of graph.nodes) {
      nodes.set(rename(id), { ...n, id: rename(id), file: relocate(n.file), service: service.name });
    }
    for (const [target, edges] of graph.callers) {
      callers.set(rename(target), edges.map((e) => ({ ...e, id: rename(e.id), file: relocate(e.file) })));
    }
    for (const [source, edges] of graph.callees) {
      callees.set(rename(source), edges.map((e) => ({ ...e, id: rename(e.id), file: relocate(e.file) })));
    }
  }

  return {
    repo: dir,
    nodes,
    callers,
    callees,
    // A workspace has no single commit the graph was built at; staleness is a
    // per-service question and reporting one number would be a fiction.
    builtAt: null,
    // Indexed if ANY service is: the semantic path should be taken for the
    // services that can support it rather than abandoned because one service
    // has only a graph file.
    indexed: parts.some((p) => p.graph.indexed),
    workspace: true,
    services: parts.map((p) => p.service.name),
  };
}

/**
 * The graph for anything: a service, or a whole project.
 *
 * The single entry point callers should use, so nobody has to decide what kind
 * of directory they were handed.
 */
export function graphFor(dir) {
  const repo = path.resolve(dir);
  if (isWorkspace(repo)) return workspaceGraph(repo);
  if (isIndexed(repo)) {
    const g = graphFromDb(repo);
    if (g?.nodes.size) return g;
  }
  return loadGraph(repo);
}

/** Totals across a project, for a dashboard that should not lie by omission. */
export function graphSummary(dir) {
  const repo = path.resolve(dir);
  if (!isWorkspace(repo)) {
    const status = indexStatus(repo);
    return status
      ? {
          symbols: status.symbols, edges: status.edges, importedAt: status.imported_at,
          services: null,
          // How far behind the code it has fallen. Computed for a command
          // nobody runs on a schedule, and never shown where people look.
          freshness: projectStaleness(repo, [{ name: path.basename(repo), path: repo }]),
        }
      : null;
  }
  const parts = serviceGraphs(repo);
  const indexed = parts.filter((p) => p.indexed);
  if (!indexed.length && !parts.some((p) => p.hasGraphFile)) return null;
  return {
    symbols: indexed.reduce((n, p) => n + p.symbols, 0),
    edges: indexed.reduce((n, p) => n + p.edges, 0),
    importedAt: indexed.map((p) => p.importedAt).sort().pop() ?? null,
    freshness: projectStaleness(repo, parts),
    // A service can have a graph on disk that predates the index — it still
    // answers questions, but its symbols are not searchable by meaning and it
    // contributes nothing to the totals. Saying so beats quietly under-counting.
    services: parts.map(({ name, indexed: ok, hasGraphFile, symbols, edges }) => ({
      name, indexed: ok, symbols, edges,
      needsIndex: !ok && hasGraphFile,
      needsGraph: !ok && !hasGraphFile,
    })),
  };
}

/**
 * Search a whole project by meaning.
 *
 * Each service is searched in its own index — that is where the vectors live —
 * and the results are merged by score. Ids and paths are namespaced on the way
 * out exactly as workspaceGraph does, so a hit can be sliced, verified and
 * reported without the caller knowing which repository it came from.
 *
 * Services with no index contribute nothing here. They are still present in
 * the graph itself, so structural questions still reach them; only search by
 * meaning needs the vectors.
 */
export function searchWorkspace(dir, task, opts = {}) {
  const repo = path.resolve(dir);
  const limit = opts.limit ?? 6;
  const hits = [];

  for (const s of services(repo)) {
    if (!isIndexed(s.path)) continue;
    for (const hit of searchSymbols(s.path, task, { ...opts, limit })) {
      hits.push({
        ...hit,
        id: `${s.name}::${hit.id}`,
        file: hit.file ? `${s.name}/${String(hit.file).split("\\").join("/")}` : "",
        service: s.name,
      });
    }
  }

  // Scored hits first, best to worst; unscored lexical matches keep their
  // relative order behind them. NaN counts as unscored: a malformed vector
  // produces NaN for every symbol, and `!= null` would let those through to
  // sort arbitrarily and present themselves as ranked.
  const scored = hits.filter((h) => Number.isFinite(h.score)).sort((a, b) => b.score - a.score);
  const rest = hits.filter((h) => !Number.isFinite(h.score));
  return [...scored, ...rest].slice(0, limit);
}
