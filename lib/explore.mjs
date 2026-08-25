/**
 * Exploring a project's code graph.
 *
 * graphify already answers structural questions well — hubs, communities,
 * shortest paths, blast radius — but it answers them one repository at a time,
 * from the graph file, in a page it generates and you open separately. This is
 * the same set of questions asked of a whole project at once, from the same
 * merged graph the agent uses, with three differences that matter:
 *
 *   - a project is a workspace, so every answer spans its services and says
 *     which one each symbol came from;
 *   - the contract edges between services are part of the graph here, so a
 *     path from a button to a database write can cross an HTTP boundary that
 *     no parser can see;
 *   - nothing is quoted from the index. The graph selects which lines; the
 *     working tree supplies what they say, and an edge is checked against the
 *     source before it is reported.
 *
 * All of it is arithmetic over data already on disk. No model is involved, and
 * nothing here starts a service.
 */
import fs from "node:fs";
import path from "node:path";

import { graphFor, isWorkspace, services as workspaceServices } from "./workspace.mjs";
import { callersOf, calleesOf, sliceSymbol, isFileNode, symbolSpans } from "./graph.mjs";
import { loadContracts } from "./contracts.mjs";

/** Where a symbol's source actually lives, for a workspace-relative file. */
const resolveFile = (root, file) => path.join(root, String(file ?? "").split("/").join(path.sep));

/**
 * graphify's own clustering, if it ran.
 *
 * Communities, their cohesion, the most-connected nodes and the edges that
 * bridge otherwise separate clusters are all computed during extraction and
 * written beside the graph. Recomputing them here would be duplicated work and
 * a second opinion nobody asked for, so they are read.
 */
function analysisFor(serviceRoot) {
  const file = path.join(serviceRoot, "graphify-out", ".graphify_analysis.json");
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

/** The services of a project, or the project itself when it is a lone repo. */
function partsOf(root) {
  if (isWorkspace(root)) return workspaceServices(root).map((s) => ({ name: s.name, path: s.path }));
  return [{ name: path.basename(root), path: root, lone: true }];
}

/** Namespaced ids are `service::id` in a workspace and bare in a lone repo. */
const qualify = (part, id) => (part.lone ? id : `${part.name}::${id}`);

/**
 * Everything about a project's shape, in one read.
 *
 * Deliberately one call rather than five: these are the questions you ask on
 * arrival, together, and answering them separately means five round trips
 * before the page says anything.
 */
export async function overview(root) {
  const g = graphFor(root);
  if (!g) return null;

  const parts = partsOf(root);
  const communities = [];
  const hubs = [];
  const surprises = [];

  for (const part of parts) {
    const a = analysisFor(part.path);
    if (!a) continue;

    for (const [key, members] of Object.entries(a.communities ?? {})) {
      const ids = members.map((m) => qualify(part, m)).filter((id) => g.nodes.has(id));
      if (!ids.length) continue;
      communities.push({
        id: `${part.name}#${key}`,
        service: part.name,
        // A cluster is only worth a name if something names it; graphify's
        // labels come from a model, which amalgam does not require, so the
        // honest default is the files its members share.
        label: a.labels?.[key] ?? commonPlace(ids.map((id) => g.nodes.get(id).file)),
        cohesion: a.cohesion?.[key] ?? null,
        size: ids.length,
        members: ids,
      });
    }

    for (const god of a.gods ?? []) {
      const id = qualify(part, god.id);
      if (g.nodes.has(id)) hubs.push({ ...g.nodes.get(id), service: part.name, degree: god.degree });
    }

    for (const s of a.surprises ?? []) {
      surprises.push({ ...s, service: part.name });
    }
  }

  // Degree is the one thing worth computing here rather than reading: a
  // workspace hub is a symbol many services lean on, and no per-service
  // analysis can see that.
  //
  // Only callable symbols count. A file node collects an edge for every symbol
  // it contains, so files outrank functions on degree while meaning something
  // completely different — "this file is big" is not "a change here is felt
  // widely". Name-matching alone misses them, since a graph disambiguates
  // same-named files by prefixing the directory.
  const degrees = [];
  for (const [id, n] of g.nodes) {
    if (isFileNode(n) || n.callable === false) continue;
    const d = (g.callers.get(id)?.length ?? 0) + (g.callees.get(id)?.length ?? 0);
    if (d > 0) degrees.push({ ...n, degree: d, in: g.callers.get(id)?.length ?? 0, out: g.callees.get(id)?.length ?? 0 });
  }
  degrees.sort((a, b) => b.degree - a.degree);

  const contracts = await loadContracts(root).catch(() => null);

  return {
    root,
    workspace: !!g.workspace,
    services: parts.map((p) => p.name),
    counts: {
      symbols: g.nodes.size,
      edges: [...g.callees.values()].reduce((n, e) => n + e.length, 0),
      communities: communities.length,
      contracts: contracts?.edges?.length ?? 0,
    },
    // Ranked by size, because the biggest cluster is the one somebody has to
    // understand first.
    communities: communities.sort((a, b) => b.size - a.size).slice(0, 40),
    hubs: degrees.slice(0, 20),
    // graphify's own hub list, kept separate: it is per-service and computed
    // differently, and merging the two would blur which is which.
    serviceHubs: hubs.sort((a, b) => b.degree - a.degree).slice(0, 20),
    surprises: surprises.slice(0, 20),
  };
}

/**
 * The graph with the HTTP boundaries joined up.
 *
 * This is the whole reason a project-level explorer beats a per-repository
 * one. A parser stops at the edge of a service: `placeOrder()` in the browser
 * and the handler that answers `POST /api/orders` share no symbol, no import
 * and no call, so to a call graph they are unrelated files in unrelated
 * repositories. The contract scan already worked out that they are two halves
 * of one thing; joining them means a path can run from a button through a
 * fetch, across the wire, into a handler, and down into the code that writes
 * to storage.
 *
 * Inferred edges are kept distinguishable — `viaContract` on the edge, and a
 * confidence carried from the scan — because an inferred edge and a parsed one
 * are different kinds of claim and merging them would launder the weaker one.
 * The original graph is not mutated: callers who want only what a parser could
 * prove keep getting exactly that.
 */
export async function withContracts(g, root) {
  const saved = await loadContracts(root).catch(() => null);
  if (!saved?.edges?.length) return { graph: g, added: 0 };

  const spans = symbolSpans(g);
  const enclosing = (file, line) => {
    for (const s of spans.get(file) ?? []) if (line >= s.from && line <= s.to) return s.node.id;
    return null;
  };

  const callers = new Map(g.callers);
  const callees = new Map(g.callees);
  const push = (map, key, value) => map.set(key, [...(map.get(key) ?? []), value]);

  let added = 0;
  for (const e of saved.edges) {
    // Contract sites are workspace-relative already, which is the same frame
    // the merged graph uses.
    const from = enclosing(e.from.file, e.from.line);
    const to = enclosing(e.to.file, e.to.line);
    if (!from || !to || from === to) continue;
    const site = { file: e.from.file, line: e.from.line, viaContract: true, route: e.path, method: e.method, confidence: e.confidence };
    push(callees, from, { id: to, ...site });
    push(callers, to, { id: from, ...site });
    added++;
  }
  return { graph: { ...g, callers, callees }, added };
}

/** The directory most of these symbols live in — a cluster's address. */
function commonPlace(files) {
  const dirs = files.filter(Boolean).map((f) => f.split("/").slice(0, -1).join("/"));
  if (!dirs.length) return "unplaced";
  const counts = new Map();
  for (const d of dirs) counts.set(d, (counts.get(d) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0][0] || "/";
}

/**
 * One symbol, in full.
 *
 * Callers and callees are verified against the working tree, so what comes
 * back is what is true now rather than what was true when the graph was built.
 * The source is read from the file, never from the index.
 */
export function symbol(root, id, { source = true } = {}) {
  const g = graphFor(root);
  const node = g?.nodes.get(id);
  if (!node) return null;

  const cache = new Map();
  const callers = callersOf(g, id, root, cache);
  const callees = calleesOf(g, id, root, cache);

  // A graph carries a node per file as well as per symbol, and a file's edge
  // to the symbols inside it means containment. Listing `ledger.js` under
  // "called by" states something false about the code, so those are counted
  // separately and named for what they are.
  const isContainer = (n) => isFileNode(n);
  const realCallers = callers.filter((n) => !isContainer(n));
  const realCallees = callees.filter((n) => !isContainer(n));

  const shape = (n) => ({ id: n.id, name: n.name, label: n.label, file: n.file, line: n.line, service: n.service ?? null });

  // sliceSymbol reads the file itself, so a symbol that has moved is still
  // found and a symbol that is gone is reported gone. It returns a record
  // rather than a string, and the extra facts — that it moved, or that the
  // name is no longer in the file — are the interesting half.
  let code = null;
  if (source) {
    try {
      const slice = sliceSymbol(root, node, 40);
      code = {
        text: slice.text ?? "",
        line: slice.line ?? node.line,
        moved: !!slice.moved,
        missing: slice.missing ?? null,
        isFile: !!slice.isFile,
      };
    } catch { code = null; }
  }

  return {
    ...shape(node),
    exists: fs.existsSync(resolveFile(root, node.file)),
    callers: realCallers.map(shape),
    callees: realCallees.map(shape),
    // Where it lives, as opposed to what calls it. Only the file node that
    // matches this symbol's own path: the others are imports, and calling
    // those "defined in" would be a second wrong claim replacing the first.
    containedBy: callers.filter((n) => isContainer(n) && n.file === node.file).map(shape),
    dropped: { callers: callers.rejected ?? 0, callees: callees.rejected ?? 0 },
    source: code,
  };
}

/**
 * The neighbourhood around a symbol, as a graph to draw.
 *
 * Depth is capped low on purpose: two hops from a hub is most of the codebase,
 * and a picture of most of the codebase shows nothing. Whatever is cut is
 * counted and reported rather than silently dropped.
 */
export async function neighbourhood(root, id, { depth = 1, limit = 60, contracts = true } = {}) {
  const base = graphFor(root);
  if (!base?.nodes.has(id)) return null;
  const g = contracts ? (await withContracts(base, root)).graph : base;

  const nodes = new Map([[id, { ...g.nodes.get(id), distance: 0, root: true }]]);
  const links = [];
  let frontier = [id];
  let truncated = 0;

  for (let d = 1; d <= Math.min(depth, 3); d++) {
    const next = [];
    for (const from of frontier) {
      for (const [dir, list] of [["out", g.callees.get(from) ?? []], ["in", g.callers.get(from) ?? []]]) {
        for (const e of list) {
          const n = g.nodes.get(e.id);
          if (!n || isFileNode(n)) continue;
          if (nodes.size >= limit && !nodes.has(e.id)) { truncated++; continue; }
          if (!nodes.has(e.id)) {
            nodes.set(e.id, { ...n, distance: d });
            next.push(e.id);
          }
          const [source, target] = dir === "out" ? [from, e.id] : [e.id, from];
          if (!links.some((l) => l.source === source && l.target === target)) {
            links.push({
              source, target, file: e.file, line: e.line,
              // Drawn differently, because an inferred edge is a different
              // kind of claim from a parsed one.
              viaContract: !!e.viaContract, route: e.route ?? null,
              method: e.method ?? null, confidence: e.confidence ?? null,
            });
          }
        }
      }
    }
    frontier = next;
    if (!frontier.length) break;
  }

  return {
    root: id,
    nodes: [...nodes.values()].map((n) => ({
      id: n.id, name: n.name, file: n.file, line: n.line,
      service: n.service ?? null, distance: n.distance, isRoot: !!n.root,
    })),
    links,
    truncated,
  };
}

/**
 * The shortest way from one symbol to another.
 *
 * Directed first, because "does A eventually call B" is the question people
 * mean. If there is no directed route, the undirected one is returned and
 * labelled as such — "these are related but not through calls" is a real
 * answer, and much better than "no path found".
 */
export async function shortestPath(root, fromId, toId, { contracts = true } = {}) {
  const base = graphFor(root);
  if (!base?.nodes.has(fromId) || !base?.nodes.has(toId)) return null;
  const g = contracts ? (await withContracts(base, root)).graph : base;

  // How each hop was reached, so the path can say where it crossed the wire
  // rather than presenting an HTTP call as an ordinary function call.
  const via = new Map();

  const walk = (directed) => {
    const prev = new Map([[fromId, null]]);
    const queue = [fromId];
    while (queue.length) {
      const cur = queue.shift();
      if (cur === toId) break;
      const out = (g.callees.get(cur) ?? []).map((e) => ({ e, back: false }));
      const back = directed ? [] : (g.callers.get(cur) ?? []).map((e) => ({ e, back: true }));
      for (const hop of [...out, ...back]) {
        const e = hop.e;
        if (prev.has(e.id) || !g.nodes.has(e.id)) continue;
        prev.set(e.id, cur);
        via.set(e.id, {
          viaContract: !!e.viaContract, route: e.route ?? null,
          method: e.method ?? null, confidence: e.confidence ?? null,
          reversed: hop.back, file: e.file ?? null, line: e.line ?? null,
        });
        queue.push(e.id);
      }
    }
    if (!prev.has(toId)) return null;
    const out = [];
    for (let at = toId; at != null; at = prev.get(at)) out.unshift(at);
    return out;
  };

  const directed = walk(true);
  const ids = directed ?? walk(false);
  if (!ids) return { from: fromId, to: toId, found: false };

  const shape = (id) => {
    const n = g.nodes.get(id);
    return { id, name: n.name, file: n.file, line: n.line, service: n.service ?? null, via: via.get(id) ?? null };
  };
  const steps = ids.map(shape);
  return {
    from: fromId,
    to: toId,
    found: true,
    directed: !!directed,
    hops: ids.length - 1,
    // The interesting number when a project has several services: a path that
    // never leaves one is a different kind of answer from one that does.
    crossings: steps.filter((st) => st.via?.viaContract).length,
    steps,
  };
}

/**
 * What a change here could reach.
 *
 * Reverse traversal: everything that calls this, and everything that calls
 * those. The same question `graph_impact` answers for a diff, asked of one
 * symbol, for someone deciding whether to touch it at all.
 */
export async function impact(root, id, { depth = 3, limit = 200, contracts = true } = {}) {
  const base = graphFor(root);
  if (!base?.nodes.has(id)) return null;
  const g = contracts ? (await withContracts(base, root)).graph : base;

  const seen = new Map([[id, { distance: 0, viaContract: false }]]);
  let frontier = [id];
  for (let d = 1; d <= depth && frontier.length; d++) {
    const next = [];
    for (const cur of frontier) {
      for (const e of g.callers.get(cur) ?? []) {
        const n = g.nodes.get(e.id);
        if (!n || isFileNode(n) || seen.has(e.id)) continue;
        if (seen.size >= limit) break;
        // Reached across the wire, directly or through something that was:
        // once a path leaves the service, everything past it is only as
        // certain as the inference that got there.
        const inferred = !!e.viaContract || !!seen.get(cur)?.viaContract;
        seen.set(e.id, { distance: d, viaContract: inferred, route: e.route ?? null });
        next.push(e.id);
      }
    }
    frontier = next;
  }
  seen.delete(id);

  const byService = new Map();
  const files = new Set();
  const reached = [];
  for (const [nid, hit] of seen) {
    const n = g.nodes.get(nid);
    reached.push({
      id: nid, name: n.name, file: n.file, line: n.line, service: n.service ?? null,
      distance: hit.distance, viaContract: hit.viaContract, route: hit.route ?? null,
    });
    if (n.file) files.add(n.file);
    const key = n.service ?? "";
    byService.set(key, (byService.get(key) ?? 0) + 1);
  }
  reached.sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name));

  return {
    root: id,
    name: g.nodes.get(id).name,
    reached,
    files: [...files].sort(),
    services: [...byService].map(([service, count]) => ({ service, count })).sort((a, b) => b.count - a.count),
    capped: seen.size >= limit,
  };
}

/**
 * The project as a hierarchy: service, then directory, then file, then symbol.
 *
 * The view that answers "what is even in here", which a force-directed blob
 * never does. Counts are carried at every level so a collapsed branch still
 * says how much it is hiding.
 */
export function tree(root) {
  const g = graphFor(root);
  if (!g) return null;

  const rootNode = { name: path.basename(root), kind: "project", children: [], symbols: 0 };
  const dirIndex = new Map([["", rootNode]]);

  const ensure = (parts) => {
    const key = parts.join("/");
    if (dirIndex.has(key)) return dirIndex.get(key);
    const parent = ensure(parts.slice(0, -1));
    const node = { name: parts[parts.length - 1], kind: "dir", path: key, children: [], symbols: 0 };
    parent.children.push(node);
    dirIndex.set(key, node);
    return node;
  };

  for (const [id, n] of g.nodes) {
    if (!n.file || isFileNode(n)) continue;
    const parts = n.file.split("/").filter(Boolean);
    const fileKey = parts.join("/");
    let fileNode = dirIndex.get(fileKey);
    if (!fileNode) {
      const parent = ensure(parts.slice(0, -1));
      fileNode = { name: parts[parts.length - 1], kind: "file", path: fileKey, children: [], symbols: 0 };
      parent.children.push(fileNode);
      dirIndex.set(fileKey, fileNode);
    }
    fileNode.children.push({
      name: n.name, kind: "symbol", id, line: n.line,
      degree: (g.callers.get(id)?.length ?? 0) + (g.callees.get(id)?.length ?? 0),
    });
  }

  // Roll the counts up once, rather than recomputing them per expand.
  const count = (node) => {
    if (node.kind === "symbol") return 1;
    node.symbols = node.children.reduce((n, c) => n + count(c), 0);
    node.children.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1));
    return node.symbols;
  };
  count(rootNode);

  // A chain of single-child directories is noise: src/main/java/com/x reads
  // better as one row than four.
  const collapse = (node) => {
    while (node.kind === "dir" && node.children.length === 1 && node.children[0].kind === "dir") {
      const only = node.children[0];
      node.name = `${node.name}/${only.name}`;
      node.path = only.path;
      node.children = only.children;
    }
    node.children?.forEach(collapse);
    return node;
  };
  return collapse(rootNode);
}
